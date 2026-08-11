from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Body, Response
from starlette.requests import Request
from fastapi.responses import StreamingResponse
import asyncio
from sqlalchemy import func, or_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
import re
import os
import threading
import time
from datetime import datetime, timedelta
from copy import deepcopy
from contextlib import contextmanager
import logging
import secrets

from ..deps import require_role, get_db
from ..models import (
    Site, SiteAssignment, SiteWorker, SiteMessage, SiteEvent,
    SiteWeeklyAvailability, SiteWeekPlan, User, UserRole, DirectorAutoPlanningConfig,
)
from ..schemas import (
    SiteCreate, SiteOut, NextWeekSavedPlanStatus, SiteUpdate,
    WorkerCreate, WorkerUpdate, WorkerOut, AIPlanningRequest, AIPlanningResponse,
    UserOut, CreateWorkerUserRequest, WeeklyAvailabilityPayload, WeekPlanPayload,
    AutoPlanningConfigPayload, AutoPlanningConfigOut, SiteMessageCreate,
    SiteMessageUpdate, SiteMessageOut, SiteEventCreate, SiteEventUpdate,
    SiteEventOut, WorkerInviteLinkOut,
)
from ..ai_solver import solve_schedule, solve_schedule_stream
from ..auth import create_worker_invite_token, ensure_director_code

from .ownership import _director_site_or_404, _director_site_ownership_or_404
from .week_utils import (
    _WEEK_ISO_RE, _WEEK_DAY_KEYS, _WEEK_DAY_KEYS_FOR_PREFS,
    _validate_week_iso, _now_ms, _week_start_date, _next_week_iso,
    _site_worker_visible_for_week, _workers_counts_by_site_for_week,
    _schedule_run_time_for_current_week, _ms_to_datetime,
    _week_iso_dates, _date_iso_to_day_key, _week_date_set,
)
from .site_config import validate_site_config, normalize_site_config, _safe_site_config
from .generation_slots import (
    _new_generation_id, _generation_request_wait_timeout_seconds,
    _generation_busy_detail, _is_generation_busy_error,
    _acquire_generation_slot, _release_generation_slot,
    _preempt_director_generation_slots, _generation_slot_or_wait,
)

logger = logging.getLogger("ai_solver")

from .solver_bridge import (
    _norm_name_local, _norm_role_local, _hours_of, _hours_from_config,
    _parse_hours_range, _to_minutes, _from_minutes,
    _is_morning_shift_name, _is_noon_shift_name, _is_night_shift_name,
    _site_shift_names_ordered, _shift_order_index,
)

def _split_range_for_pulls(start: str, end: str, max_each_minutes: int = 4 * 60) -> tuple[dict, dict]:
    s = _to_minutes(start)
    e0 = _to_minutes(end)
    if s is None or e0 is None:
        return ({"start": "00:00", "end": "12:00"}, {"start": "12:00", "end": "00:00"})
    e = e0
    if e <= s:
        e += 24 * 60
    duration = e - s
    each = min(max_each_minutes, duration / 2)
    return (
        {"start": _from_minutes(s), "end": _from_minutes(int(s + each))},
        {"start": _from_minutes(int(e - each)), "end": _from_minutes(e)},
    )


_PULLS_PREFER_KINDS = ("morning", "noon", "night")
_PULLS_KIND_ORDER = {"morning": 0, "noon": 1, "night": 2}


def _shift_pull_kind(shift_name: str) -> str | None:
    if _is_morning_shift_name(shift_name):
        return "morning"
    if _is_noon_shift_name(shift_name):
        return "noon"
    if _is_night_shift_name(shift_name):
        return "night"
    return None


def _normalize_pulls_prefer(raw: object | None) -> tuple[str, ...] | None:
    """None = mix (aucune préférence de משיכות). 1–2 kinds = priorité ciblée."""
    if raw is None:
        return None
    values = [raw] if isinstance(raw, str) else list(raw) if isinstance(raw, (list, tuple, set)) else []
    out: list[str] = []
    aliases = {
        "morning": "morning",
        "noon": "noon",
        "night": "night",
        "בוקר": "morning",
        "צהריים": "noon",
        "צהרים": "noon",
        "לילה": "night",
    }
    for item in values:
        raw_s = str(item or "").strip()
        kind = aliases.get(raw_s.lower()) or aliases.get(raw_s)
        if kind in _PULLS_PREFER_KINDS and kind not in out:
            out.append(kind)
    if not out or len(out) >= 3:
        return None
    return tuple(out)


def _pull_target_shift_priority(
    shift_name: str,
    pulls_prefer: tuple[str, ...] | None = None,
) -> tuple[int, int, str]:
    kind = _shift_pull_kind(shift_name)
    kind_idx = _PULLS_KIND_ORDER.get(kind, 3) if kind else 3
    name = str(shift_name or "")
    if not pulls_prefer:
        # Mix : aucune priorité de kind (pas un ordre de gardes).
        return (0, 0, "")
    if kind and kind in pulls_prefer:
        return (0, kind_idx, name)
    return (1, kind_idx, name)


def _preferred_pulls_count(pulls: dict | None, pulls_prefer: object | None = None) -> int:
    prefer = _normalize_pulls_prefer(pulls_prefer)
    if not prefer:
        return 0
    total = 0
    for key in _sanitize_pulls_map(pulls):
        parts = str(key or "").split("|")
        if len(parts) < 2:
            continue
        kind = _shift_pull_kind(parts[1])
        if kind and kind in prefer:
            total += 1
    return total


def _noon_pulls_count(pulls: dict | None) -> int:
    """Nombre de משיכות dont la cellule cible est un shift צהריים."""
    return _preferred_pulls_count(pulls, ("noon",))


def _count_split_day_same_worker_patterns(site_config: dict | None, assignments: dict | None) -> int:
    """Count worker-days with morning+night around a noon staffed by someone else.

    This captures the fatigue pattern:
      worker A in the morning, worker B at noon, worker A at night.
    If noon also contains A (for example after a pull), the pattern is not counted.
    """
    from ..ai_solver import build_capacities_from_config

    if not isinstance(assignments, dict):
        return 0
    days, shifts, _stations = build_capacities_from_config(site_config or {})
    morning_shifts = [shift_name for shift_name in shifts if _is_morning_shift_name(shift_name)]
    noon_shifts = [shift_name for shift_name in shifts if _is_noon_shift_name(shift_name)]
    night_shifts = [shift_name for shift_name in shifts if _is_night_shift_name(shift_name)]
    if not morning_shifts or not noon_shifts or not night_shifts:
        return 0

    def _names_for(day_key: str, shift_name: str) -> set[str]:
        out: set[str] = set()
        per_shift = (assignments.get(day_key) or {}).get(shift_name) or []
        for raw_cell in per_shift:
            if not isinstance(raw_cell, list):
                continue
            for raw_name in raw_cell:
                name = _norm_name_local(raw_name)
                if name:
                    out.add(name)
        return out

    total = 0
    for day_key in days:
        morning_names: set[str] = set()
        noon_names: set[str] = set()
        night_names: set[str] = set()
        for shift_name in morning_shifts:
            morning_names.update(_names_for(day_key, shift_name))
        for shift_name in noon_shifts:
            noon_names.update(_names_for(day_key, shift_name))
        for shift_name in night_shifts:
            night_names.update(_names_for(day_key, shift_name))
        if not noon_names:
            continue
        for worker_name in morning_names.intersection(night_names):
            if worker_name in noon_names:
                continue
            if any(other_name != worker_name for other_name in noon_names):
                total += 1
    return total


def _apply_auto_pulls_to_payload(
    site: Site,
    rows: list[SiteWorker],
    payload: dict,
    pulls_limit: int | None = None,
    pulls_prefer: object | None = None,
) -> dict:
    from ..ai_solver import build_capacities_from_config

    assignments = payload.get("assignments")
    if not isinstance(assignments, dict):
        return payload

    site_cfg = site.config or {}
    station_cfgs = (site_cfg.get("stations") or []) if isinstance(site_cfg, dict) else []
    days, shifts, stations = build_capacities_from_config(site_cfg)
    name_to_roles = {
        _norm_name_local(r.name): {_norm_role_local(x) for x in (r.roles or [])}
        for r in rows
    }
    pulls: dict[str, dict] = {}
    normalized_pulls_limit = int(pulls_limit) if pulls_limit is not None else None
    prefer_kinds = _normalize_pulls_prefer(pulls_prefer)

    def worker_has_role(worker_name: str, role_name: str) -> bool:
        return _norm_role_local(role_name) in name_to_roles.get(_norm_name_local(worker_name), set())

    def get_cell_names(day_key: str, shift_name: str, station_idx: int) -> list[str]:
        per_shift = (assignments.get(day_key) or {}).get(shift_name) or []
        if not isinstance(per_shift, list) or station_idx >= len(per_shift):
            return []
        raw = per_shift[station_idx]
        if not isinstance(raw, list):
            return []
        return [nm for x in raw if (nm := _norm_name_local(x))]

    def set_cell_names(day_key: str, shift_name: str, station_idx: int, names: list[str]) -> None:
        assignments.setdefault(day_key, {})
        per_shift = assignments[day_key].setdefault(shift_name, [])
        while len(per_shift) <= station_idx:
            per_shift.append([])
        per_shift[station_idx] = names

    def pulled_names_for(day_key: str, shift_name: str) -> set[str]:
        out: set[str] = set()
        prefix = f"{day_key}|{shift_name}|"
        for key, entry in pulls.items():
            if not str(key).startswith(prefix):
                continue
            before_name = _norm_name_local(((entry or {}).get("before") or {}).get("name"))
            after_name = _norm_name_local(((entry or {}).get("after") or {}).get("name"))
            if before_name:
                out.add(before_name)
            if after_name:
                out.add(after_name)
        return out

    def prev_of(day_idx: int, shift_idx: int) -> tuple[int, int] | None:
        if day_idx == 0 and shift_idx == 0:
            return None
        if shift_idx == 0:
            return (day_idx - 1, len(shifts) - 1)
        return (day_idx, shift_idx - 1)

    def next_of(day_idx: int, shift_idx: int) -> tuple[int, int] | None:
        if day_idx == len(days) - 1 and shift_idx == len(shifts) - 1:
            return None
        if shift_idx == len(shifts) - 1:
            return (day_idx + 1, 0)
        return (day_idx, shift_idx + 1)

    def guard_occurrence_used_by_pull(day_idx: int, shift_idx: int, station_idx: int, worker_name: str) -> bool:
        worker_norm = _norm_name_local(worker_name)
        if not worker_norm:
            return False
        for pull_key, entry in pulls.items():
            parts = str(pull_key or "").split("|")
            if len(parts) < 4:
                continue
            pull_day_key = parts[0]
            pull_shift_name = parts[1]
            try:
                pull_station_idx = int(parts[2])
            except Exception:
                continue
            if pull_station_idx != station_idx:
                continue
            try:
                pull_day_idx = days.index(pull_day_key)
                pull_shift_idx = shifts.index(pull_shift_name)
            except ValueError:
                continue
            pull_prev = prev_of(pull_day_idx, pull_shift_idx)
            pull_next = next_of(pull_day_idx, pull_shift_idx)
            entry_map = entry if isinstance(entry, dict) else {}
            before_name = _norm_name_local(((entry_map.get("before") or {}) if isinstance(entry_map.get("before"), dict) else {}).get("name"))
            after_name = _norm_name_local(((entry_map.get("after") or {}) if isinstance(entry_map.get("after"), dict) else {}).get("name"))
            if before_name == worker_norm and pull_prev == (day_idx, shift_idx):
                return True
            if after_name == worker_norm and pull_next == (day_idx, shift_idx):
                return True
        return False

    def _has_same_worker_around_middle(day_idx: int, shift_idx: int, station_idx: int) -> bool:
        prev_coord = prev_of(day_idx, shift_idx)
        next_coord = next_of(day_idx, shift_idx)
        if not prev_coord or not next_coord:
            return False
        prev_names = set(get_cell_names(days[prev_coord[0]], shifts[prev_coord[1]], station_idx))
        next_names = set(get_cell_names(days[next_coord[0]], shifts[next_coord[1]], station_idx))
        return bool(prev_names.intersection(next_names))

    target_cells: list[tuple[int, tuple[int, int, str], int, int, str]] = []
    for station_idx, station in enumerate(stations):
        station_cfg = station_cfgs[station_idx] if station_idx < len(station_cfgs) and isinstance(station_cfgs[station_idx], dict) else {}
        cap_map = station.get("capacity") or {}
        for day_idx, day_key in enumerate(days):
            for shift_idx, shift_name in enumerate(shifts):
                required = int((cap_map.get(day_key, {}) or {}).get(shift_name, 0) or 0)
                prev_coord = prev_of(day_idx, shift_idx)
                next_coord = next_of(day_idx, shift_idx)
                if required <= 0 or not prev_coord or not next_coord:
                    continue
                pull_priority = _pull_target_shift_priority(shift_name, prefer_kinds)
                if _has_same_worker_around_middle(day_idx, shift_idx, station_idx):
                    pull_priority = (-1, *pull_priority[1:])
                crosses_day_boundary = int(prev_coord[0] != day_idx or next_coord[0] != day_idx)
                target_cells.append((crosses_day_boundary, pull_priority, station_idx, day_idx, shift_name))

    target_cells.sort(key=lambda item: (item[0], item[1], item[3], item[2]))

    for _, _, station_idx, day_idx, shift_name in target_cells:
        if normalized_pulls_limit is not None and len(pulls) >= normalized_pulls_limit:
            break
        station = stations[station_idx]
        station_cfg = station_cfgs[station_idx] if station_idx < len(station_cfgs) and isinstance(station_cfgs[station_idx], dict) else {}
        cap_map = station.get("capacity") or {}
        cap_roles = station.get("capacity_roles") or {}
        day_key = days[day_idx]
        shift_idx = shifts.index(shift_name)
        required = int((cap_map.get(day_key, {}) or {}).get(shift_name, 0) or 0)
        prev_coord = prev_of(day_idx, shift_idx)
        next_coord = next_of(day_idx, shift_idx)
        if required <= 0 or not prev_coord or not next_coord:
            continue

        while True:
            if normalized_pulls_limit is not None and len(pulls) >= normalized_pulls_limit:
                break
            cell_prefix = f"{day_key}|{shift_name}|{station_idx}|"
            existing_pull_keys = [k for k in pulls if str(k).startswith(cell_prefix)]
            current_names = get_cell_names(day_key, shift_name, station_idx)
            assigned_places = max(0, len(current_names) - len(existing_pull_keys))
            if required - assigned_places < 1:
                break

            prev_day, prev_shift = days[prev_coord[0]], shifts[prev_coord[1]]
            next_day, next_shift = days[next_coord[0]], shifts[next_coord[1]]
            prev_prev = prev_of(prev_coord[0], prev_coord[1])
            next_next = next_of(next_coord[0], next_coord[1])
            prev_names = [nm for nm in get_cell_names(prev_day, prev_shift, station_idx) if nm not in pulled_names_for(prev_day, prev_shift)]
            next_names = [nm for nm in get_cell_names(next_day, next_shift, station_idx) if nm not in pulled_names_for(next_day, next_shift)]
            used_in_cell = set(current_names)
            pulled_before_prev = pulled_names_for(days[prev_prev[0]], shifts[prev_prev[1]]) if prev_prev else set()
            pulled_after_next = pulled_names_for(days[next_next[0]], shifts[next_next[1]]) if next_next else set()

            before_candidates = [
                nm for nm in prev_names
                if nm not in used_in_cell
                and nm not in pulled_before_prev
                and not guard_occurrence_used_by_pull(prev_coord[0], prev_coord[1], station_idx, nm)
            ]
            after_candidates = [
                nm for nm in next_names
                if nm not in used_in_cell
                and nm not in pulled_after_next
                and not guard_occurrence_used_by_pull(next_coord[0], next_coord[1], station_idx, nm)
            ]
            both_sides = {nm for nm in before_candidates if nm in set(after_candidates)}
            before_candidates = [nm for nm in before_candidates if nm not in both_sides]
            after_candidates = [nm for nm in after_candidates if nm not in both_sides]
            if not before_candidates or not after_candidates:
                break

            req_roles = (cap_roles.get(day_key, {}) or {}).get(shift_name, {}) or {}
            role_name = None
            before_options = before_candidates
            after_options = after_candidates
            if req_roles:
                for rn in [str(x) for x in req_roles.keys() if str(x).strip()]:
                    b = [nm for nm in before_candidates if worker_has_role(nm, rn)]
                    a = [nm for nm in after_candidates if worker_has_role(nm, rn)]
                    if not b or not a:
                        continue
                    if len(b) == 1 and len(a) == 1 and b[0] == a[0]:
                        continue
                    role_name = rn
                    before_options = b
                    after_options = a
                    break
                if not role_name:
                    break
            elif len(before_options) == 1 and len(after_options) == 1 and before_options[0] == after_options[0]:
                break

            before_name = before_options[0] if before_options else ""
            after_name = next((nm for nm in after_options if nm != before_name), "")
            if not before_name or not after_name:
                break

            hours = _hours_from_config(station_cfg, shift_name, day_key) or _hours_of(shift_name) or "00:00-00:00"
            parsed = _parse_hours_range(hours)
            shift_start, shift_end = parsed if parsed else ("00:00", "00:00")
            before_range, after_range = _split_range_for_pulls(shift_start, shift_end)

            new_pull_count = len(existing_pull_keys) + 1
            next_names = list(current_names)
            if before_name not in next_names:
                next_names.append(before_name)
            if after_name not in next_names:
                next_names.append(after_name)
            if len(next_names) > required + new_pull_count:
                break

            slot_idx = required + len(existing_pull_keys)
            pulls[f"{day_key}|{shift_name}|{station_idx}|{slot_idx}"] = {
                "before": {"name": before_name, "start": before_range["start"], "end": before_range["end"]},
                "after": {"name": after_name, "start": after_range["start"], "end": after_range["end"]},
                "roleName": role_name,
            }
            set_cell_names(day_key, shift_name, station_idx, next_names)

    payload["assignments"] = assignments
    payload["pulls"] = _sanitize_pulls_map(pulls)
    return payload


def _enforce_role_requirements_on_assignments(
    site_config: dict | None,
    assignments_value: dict | None,
    workers_rows: list[SiteWorker],
) -> dict:
    """Retire les noms non compatibles avec les rôles requis d’un slot.

    Règle: si un slot a au moins un rôle requis (>0), chaque nom assigné doit porter au moins
    un de ces rôles. Sinon le nom est retiré du slot.
    """
    if not isinstance(assignments_value, dict):
        return {}
    from ..ai_solver import build_capacities_from_config

    days, shifts, stations = build_capacities_from_config(site_config or {})
    if not stations:
        return assignments_value

    worker_roles_by_name: dict[str, set[str]] = {}
    for row in workers_rows:
        nm = _norm_name_local(getattr(row, "name", None))
        if not nm:
            continue
        role_set = worker_roles_by_name.setdefault(nm, set())
        for role_name in (getattr(row, "roles", None) or []):
            norm_role = _norm_role_local(role_name)
            if norm_role:
                role_set.add(norm_role)

    out = deepcopy(assignments_value)
    for station_idx, st in enumerate(stations):
        cap_roles = (st.get("capacity_roles") or {}) if isinstance(st, dict) else {}
        for day_key in days:
            for shift_name in shifts:
                role_map_raw = ((cap_roles.get(day_key, {}) or {}).get(shift_name, {}) or {})
                required_roles = {
                    _norm_role_local(role_name)
                    for role_name, cnt in (role_map_raw.items() if isinstance(role_map_raw, dict) else [])
                    if int(cnt or 0) > 0 and _norm_role_local(role_name)
                }
                if not required_roles:
                    continue
                per_shift = (out.get(day_key) or {}).get(shift_name)
                if not isinstance(per_shift, list) or station_idx >= len(per_shift):
                    continue
                cell = per_shift[station_idx]
                if not isinstance(cell, list):
                    continue
                filtered_cell: list[str] = []
                for raw_name in cell:
                    norm_name = _norm_name_local(str(raw_name or ""))
                    if not norm_name:
                        continue
                    worker_roles = worker_roles_by_name.get(norm_name, set())
                    if worker_roles.intersection(required_roles):
                        filtered_cell.append(str(raw_name))
                per_shift[station_idx] = filtered_cell
    return out


def _payload_variant_assignments(payload: dict, variant_index: int) -> dict:
    if not isinstance(payload, dict):
        return {}
    if variant_index < 0:
        src = payload.get("assignments")
    else:
        alternatives = payload.get("alternatives")
        src = alternatives[variant_index] if isinstance(alternatives, list) and variant_index < len(alternatives) else None
    return deepcopy(src) if isinstance(src, dict) else {}


def _payload_has_variant(payload: dict, variant_index: int) -> bool:
    if not isinstance(payload, dict):
        return False
    if variant_index < 0:
        return isinstance(payload.get("assignments"), dict)
    alternatives = payload.get("alternatives")
    return bool(isinstance(alternatives, list) and variant_index < len(alternatives) and isinstance(alternatives[variant_index], dict))


def _set_payload_variant_assignments(payload: dict, variant_index: int, assignments: dict) -> None:
    if variant_index < 0:
        payload["assignments"] = assignments
        return
    alternatives = payload.get("alternatives")
    if not isinstance(alternatives, list) or variant_index >= len(alternatives):
        return
    alternatives[variant_index] = assignments


def _payload_variant_pulls(payload: dict, variant_index: int) -> dict:
    if not isinstance(payload, dict):
        return {}
    if variant_index < 0:
        src = payload.get("pulls")
    else:
        alternative_pulls = payload.get("alternative_pulls")
        src = alternative_pulls[variant_index] if isinstance(alternative_pulls, list) and variant_index < len(alternative_pulls) else None
    return src if isinstance(src, dict) else {}


def _pull_extra_names_by_cell(pulls: dict | None) -> dict[tuple[str, str, int], set[str]]:
    extras: dict[tuple[str, str, int], set[str]] = {}
    for key, entry in _sanitize_pulls_map(pulls).items():
        parts = str(key or "").split("|")
        if len(parts) < 3:
            continue
        day_key = str(parts[0] or "")
        shift_name = str(parts[1] or "")
        try:
            station_idx = int(parts[2])
        except Exception:
            continue
        names = extras.setdefault((day_key, shift_name, station_idx), set())
        entry_map = entry if isinstance(entry, dict) else {}
        before = entry_map.get("before") if isinstance(entry_map.get("before"), dict) else {}
        after = entry_map.get("after") if isinstance(entry_map.get("after"), dict) else {}
        before_name = _norm_name_local(before.get("name") if isinstance(before, dict) else None)
        after_name = _norm_name_local(after.get("name") if isinstance(after, dict) else None)
        if before_name:
            names.add(before_name)
        if after_name:
            names.add(after_name)
    return extras


def _group_workers_by_site(rows: list[SiteWorker]) -> dict[int, list[SiteWorker]]:
    rows_by_site: dict[int, list[SiteWorker]] = {}
    for row in rows:
        rows_by_site.setdefault(int(row.site_id), []).append(row)
    return rows_by_site


def _load_workers_by_site(db: Session, site_ids: list[int]) -> dict[int, list[SiteWorker]]:
    ids = [int(sid) for sid in site_ids if int(sid) > 0]
    if not ids:
        return {}
    return _group_workers_by_site(
        db.query(SiteWorker).filter(SiteWorker.site_id.in_(ids)).all(),
    )


def _apply_auto_pulls_to_site_plans(
    db: Session,
    sites_by_id: dict[int, Site],
    site_plans: dict[str, dict],
    pulls_limit: int | None = None,
    pulls_limits_by_site: dict[int, int | None] | None = None,
    pulls_prefer: object | None = None,
    workers_by_site: dict[int, list[SiteWorker]] | None = None,
) -> dict[str, dict]:
    if not site_plans:
        return site_plans
    site_ids = [int(site_id) for site_id in site_plans.keys()]
    rows_by_site = workers_by_site if workers_by_site is not None else _load_workers_by_site(db, site_ids)

    for site_id_str, site_plan in site_plans.items():
        site_id = int(site_id_str)
        site = sites_by_id.get(site_id)
        if not site:
            continue
        site_rows = rows_by_site.get(site_id, [])
        if pulls_limits_by_site is not None and site_id not in pulls_limits_by_site:
            site_plan["pulls"] = {}
            if site_plan.get("alternatives") is not None:
                site_plan["alternative_pulls"] = [{} for _ in (site_plan.get("alternatives") or [])]
            continue
        effective_site_limit = pulls_limits_by_site.get(site_id) if pulls_limits_by_site is not None else pulls_limit

        base_payload = _apply_auto_pulls_to_payload(
            site,
            site_rows,
            {"assignments": deepcopy(site_plan.get("assignments") or {}), "pulls": {}},
            pulls_limit=effective_site_limit,
            pulls_prefer=pulls_prefer,
        )
        site_plan["assignments"] = base_payload.get("assignments") or {}
        site_plan["pulls"] = base_payload.get("pulls") or {}
        site_plan["assigned_count"] = max(
            0,
            int(site_plan.get("assigned_count") or 0) - len(site_plan["pulls"]),
        )

        next_alternatives: list[dict] = []
        alternative_pulls: list[dict] = []
        for alt_assignments in (site_plan.get("alternatives") or []):
            alt_payload = _apply_auto_pulls_to_payload(
                site,
                site_rows,
                {"assignments": deepcopy(alt_assignments or {}), "pulls": {}},
                pulls_limit=effective_site_limit,
                pulls_prefer=pulls_prefer,
            )
            next_alternatives.append(alt_payload.get("assignments") or {})
            alternative_pulls.append(alt_payload.get("pulls") or {})
        if next_alternatives:
            site_plan["alternatives"] = next_alternatives
            site_plan["alternative_pulls"] = alternative_pulls
    return site_plans


def _enforce_role_requirements_on_site_plans(
    db: Session,
    sites_by_id: dict[int, Site],
    site_plans: dict[str, dict],
    workers_by_site: dict[int, list[SiteWorker]] | None = None,
) -> dict[str, dict]:
    if not site_plans:
        return site_plans
    site_ids = [int(site_id) for site_id in site_plans.keys()]
    rows_by_site = workers_by_site if workers_by_site is not None else _load_workers_by_site(db, site_ids)

    for site_id_str, site_plan in site_plans.items():
        site_id = int(site_id_str)
        site = sites_by_id.get(site_id)
        if not site:
            continue
        site_rows = rows_by_site.get(site_id, [])
        site_plan["assignments"] = _enforce_role_requirements_on_assignments(
            site.config or {},
            site_plan.get("assignments") if isinstance(site_plan.get("assignments"), dict) else {},
            site_rows,
        )
        if isinstance(site_plan.get("alternatives"), list):
            site_plan["alternatives"] = [
                _enforce_role_requirements_on_assignments(
                    site.config or {},
                    alt if isinstance(alt, dict) else {},
                    site_rows,
                )
                for alt in (site_plan.get("alternatives") or [])
            ]
    return site_plans


def _pulls_count(pulls: dict | None) -> int:
    return len(_sanitize_pulls_map(pulls))


def _pull_entry_is_self_pull(entry: dict | None) -> bool:
    if not isinstance(entry, dict):
        return False
    before = entry.get("before") if isinstance(entry.get("before"), dict) else {}
    after = entry.get("after") if isinstance(entry.get("after"), dict) else {}
    before_name = _norm_name_local(before.get("name") if isinstance(before, dict) else None)
    after_name = _norm_name_local(after.get("name") if isinstance(after, dict) else None)
    return bool(before_name and before_name == after_name)


def _sanitize_pulls_map(pulls: dict | None) -> dict:
    if not isinstance(pulls, dict):
        return {}
    return {
        str(key): entry
        for key, entry in pulls.items()
        if isinstance(entry, dict) and not _pull_entry_is_self_pull(entry)
    }


def _matches_pulls_limit(pulls: dict | None, pulls_limit: int | None, require_pull: bool = False) -> bool:
    """Accepte tant que count ≤ limite (0 inclus).

    משיכות = plafond « עד N », pas une obligation d’en avoir au moins une : un planning
    déjà complet sans trou ne doit pas être rejeté.
    """
    _ = require_pull  # compat API : anciennement exigé ≥1 pull
    count = _pulls_count(pulls)
    if pulls_limit is None:
        return True
    return count <= int(pulls_limit)


def _planning_limit_error_detail(pulls_limit: int) -> str:
    if int(pulls_limit) == 1:
        return "לא נמצא תכנון עם עד משיכה אחת"
    return f"לא נמצא תכנון עם עד {int(pulls_limit)} משיכות"


def _effective_auto_pulls_limit_for_site(
    site_id: int,
    global_limit: int | None,
    by_site: dict[int, int | None] | None,
) -> int | None:
    """Limite משיכות pour un site : entrée explicite dans by_site, sinon limite globale."""
    if by_site and site_id in by_site:
        return by_site.get(site_id)
    return global_limit


def _normalize_pulls_limits_by_site(raw_value: dict | None) -> dict[int, int | None]:
    normalized: dict[int, int | None] = {}
    if not isinstance(raw_value, dict):
        return normalized
    for site_key, raw_limit in raw_value.items():
        try:
            site_id = int(site_key)
        except Exception:
            continue
        if raw_limit is None:
            normalized[site_id] = None
            continue
        try:
            limit = int(raw_limit)
        except Exception:
            continue
        if limit >= 1:
            normalized[site_id] = limit
    return normalized


def _site_pulls_limit_matches(
    site_id: int,
    pulls: dict | None,
    default_pulls_limit: int | None = None,
    pulls_limits_by_site: dict[int, int | None] | None = None,
) -> bool:
    if pulls_limits_by_site is not None:
        if site_id not in pulls_limits_by_site:
            return _pulls_count(pulls) == 0
        return _matches_pulls_limit(pulls, pulls_limits_by_site.get(site_id))
    return _matches_pulls_limit(pulls, default_pulls_limit)


def _planning_limit_error_detail_for_request(
    pulls_limit: int | None = None,
    pulls_limits_by_site: dict[int, int | None] | None = None,
) -> str:
    if pulls_limits_by_site:
        enabled_limits = [limit for limit in pulls_limits_by_site.values() if limit is not None]
        if len(pulls_limits_by_site) == 1 and len(enabled_limits) == 1:
            return _planning_limit_error_detail(enabled_limits[0])
        return "לא נמצא תכנון עם מגבלות המשיכות שנבחרו באתרים המקושרים"
    if pulls_limit is not None:
        return _planning_limit_error_detail(pulls_limit)
    return "לא נמצא תכנון עם מגבלות המשיכות שנבחרו"



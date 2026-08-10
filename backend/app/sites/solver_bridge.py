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

def _count_assignments_per_worker(
    assignments: dict | None,
) -> dict[str, int]:
    counts: dict[str, int] = {}
    if not assignments or not isinstance(assignments, dict):
        return counts
    for day_map in assignments.values():
        if not isinstance(day_map, dict):
            continue
        for per_station in day_map.values():
            if not isinstance(per_station, list):
                continue
            for cell in per_station:
                if not isinstance(cell, list):
                    continue
                for nm in cell:
                    clean = str(nm or "").strip()
                    if not clean:
                        continue
                    counts[clean] = counts.get(clean, 0) + 1
    return counts


def _log_single_site_generation_worker_totals(
    *,
    generation_id: str,
    site_id: int,
    item_type: str,
    item_index: int | None,
    workers: list[dict],
    assignments: dict | None,
) -> None:
    counts = dict(sorted(_count_assignments_per_worker(assignments).items()))
    solver_max = {
        str(w.get("name") or "").strip(): int(w.get("max_shifts") or 5)
        for w in workers
        if str(w.get("name") or "").strip()
    }
    over = {
        nm: {"total": cnt, "max_shifts": solver_max.get(nm, 5)}
        for nm, cnt in counts.items()
        if cnt > solver_max.get(nm, 5)
    }
    logger.info(
        "[GEN_DIAG][single][%s] generation=%s site=%s index=%s totals=%s",
        item_type,
        generation_id,
        site_id,
        item_index,
        counts,
    )
    if over:
        logger.warning(
            "[GEN_DIAG][single][%s] generation=%s site=%s index=%s workers_over_max=%s",
            item_type,
            generation_id,
            site_id,
            item_index,
            over,
        )


def _log_linked_generation_worker_totals(
    *,
    generation_id: str,
    site_id: int,
    item_type: str,
    item_index: int | None,
    site_plans: dict[str, dict] | None,
    context: dict,
) -> None:
    display_name_to_max: dict[str, int] = {}
    display_name_by_solver_site = context.get("display_name_by_solver_site") or {}
    for w in (context.get("combined_workers") or []):
        solver_name = str(w.get("name") or "").strip()
        max_s = int(w.get("max_shifts") or 5)
        for (sn, _sid), dname in display_name_by_solver_site.items():
            if str(sn) != solver_name:
                continue
            clean = str(dname or "").strip()
            if not clean:
                continue
            display_name_to_max[clean] = min(display_name_to_max.get(clean, max_s), max_s)

    per_site_counts: dict[str, dict[str, int]] = {}
    global_counts: dict[str, int] = {}
    for sid, plan in (site_plans or {}).items():
        assignments = plan.get("assignments") if isinstance(plan, dict) else None
        counts = dict(sorted(_count_assignments_per_worker(assignments).items()))
        per_site_counts[str(sid)] = counts
        for nm, cnt in counts.items():
            global_counts[nm] = global_counts.get(nm, 0) + cnt
    global_counts = dict(sorted(global_counts.items()))
    over = {
        nm: {"total": cnt, "max_shifts": display_name_to_max.get(nm, 5)}
        for nm, cnt in global_counts.items()
        if cnt > display_name_to_max.get(nm, 5)
    }
    logger.info(
        "[GEN_DIAG][linked][%s] generation=%s root_site=%s index=%s per_site=%s global=%s",
        item_type,
        generation_id,
        site_id,
        item_index,
        per_site_counts,
        global_counts,
    )
    if over:
        logger.warning(
            "[GEN_DIAG][linked][%s] generation=%s root_site=%s index=%s workers_over_max=%s",
            item_type,
            generation_id,
            site_id,
            item_index,
            over,
        )


def _site_max_nights_per_worker(config: dict | None, fallback: int = 3) -> int:
    """Max nuits / employé / semaine depuis site.config (défaut 3, borné 0..7)."""
    raw = (config or {}).get("max_nights_per_worker")
    if raw is None:
        raw = (config or {}).get("maxNightsPerWorker")
    try:
        return max(0, min(7, int(raw if raw is not None else fallback)))
    except (TypeError, ValueError):
        return max(0, min(7, int(fallback)))


def _resolve_max_nights_per_worker(
    site_config: dict | None,
    *,
    payload_value: int | None = None,
    query_value: int | None = None,
) -> int:
    """Query > body explicite > config site > 3."""
    if query_value is not None:
        try:
            return max(0, min(7, int(query_value)))
        except (TypeError, ValueError):
            pass
    if payload_value is not None:
        try:
            return max(0, min(7, int(payload_value)))
        except (TypeError, ValueError):
            pass
    return _site_max_nights_per_worker(site_config)


def _normalize_shift_kind_prefs(raw: object | None) -> dict[str, int] | None:
    """Normalise {morning,noon,night} → ints 0..6. None si absent / invalide."""
    if not isinstance(raw, dict):
        return None
    out: dict[str, int] = {}
    for key in ("morning", "noon", "night"):
        if key not in raw:
            continue
        try:
            out[key] = max(0, min(6, int(raw.get(key) or 0)))
        except (TypeError, ValueError):
            out[key] = 0
    return out if out else None


def _normalize_shift_slot_prefs(raw: object | None) -> dict[str, list[str]] | None:
    """Normalise {day: [shiftName,...]} — créneaux préférés (soft). None si absent/vide."""
    if not isinstance(raw, dict):
        return None
    out: dict[str, list[str]] = {}
    for day_key, shifts_list in raw.items():
        day = str(day_key or "").strip().lower()
        if day not in _WEEK_DAY_KEYS_FOR_PREFS:
            continue
        if not isinstance(shifts_list, list):
            continue
        cleaned: list[str] = []
        seen: set[str] = set()
        for item in shifts_list:
            name = str(item or "").strip()
            if not name or name in seen:
                continue
            seen.add(name)
            cleaned.append(name)
        if cleaned:
            out[day] = cleaned
    return out if out else None


def _shift_kind_prefs_from_answers(row: SiteWorker, week_iso: str | None) -> dict[str, int] | None:
    """Préférences soft stockées dans answers[week]._shift_kind_prefs (soumission זמינות)."""
    if not week_iso:
        return None
    answers = row.answers if isinstance(row.answers, dict) else {}
    week_block = answers.get(week_iso)
    if not isinstance(week_block, dict):
        return None
    return _normalize_shift_kind_prefs(week_block.get("_shift_kind_prefs"))


def _shift_slot_prefs_from_answers(row: SiteWorker, week_iso: str | None) -> dict[str, list[str]] | None:
    """Préférences soft jour×משמרת dans answers[week]._shift_slot_prefs."""
    if not week_iso:
        return None
    answers = row.answers if isinstance(row.answers, dict) else {}
    week_block = answers.get(week_iso)
    if not isinstance(week_block, dict):
        return None
    return _normalize_shift_slot_prefs(week_block.get("_shift_slot_prefs"))


def _apply_shift_kind_prefs_to_answers(
    row: SiteWorker,
    week_iso: str,
    prefs: object | None,
) -> None:
    """Écrit / efface answers[week]._shift_kind_prefs (directeur ou employé)."""
    wk = (week_iso or "").strip()
    if not wk:
        return
    base = dict(row.answers) if isinstance(row.answers, dict) else {}
    week_block = dict(base.get(wk)) if isinstance(base.get(wk), dict) else {}
    normalized = _normalize_shift_kind_prefs(prefs if isinstance(prefs, dict) else (
        {
            "morning": getattr(prefs, "morning", 0),
            "noon": getattr(prefs, "noon", 0),
            "night": getattr(prefs, "night", 0),
        }
        if prefs is not None
        else None
    ))
    if normalized is None:
        week_block.pop("_shift_kind_prefs", None)
    else:
        week_block["_shift_kind_prefs"] = normalized
    base[wk] = week_block
    row.answers = base
    flag_modified(row, "answers")


def _apply_shift_slot_prefs_to_answers(
    row: SiteWorker,
    week_iso: str,
    prefs: object | None,
) -> None:
    """Écrit / efface answers[week]._shift_slot_prefs."""
    wk = (week_iso or "").strip()
    if not wk:
        return
    base = dict(row.answers) if isinstance(row.answers, dict) else {}
    week_block = dict(base.get(wk)) if isinstance(base.get(wk), dict) else {}
    normalized = _normalize_shift_slot_prefs(prefs if isinstance(prefs, dict) else None)
    if normalized is None:
        week_block.pop("_shift_slot_prefs", None)
    else:
        week_block["_shift_slot_prefs"] = normalized
    base[wk] = week_block
    row.answers = base
    flag_modified(row, "answers")


def _weekly_override_avail_and_stations(ovr: dict | None) -> tuple[dict[str, list[str]], list[int], bool]:
    """Extrait {jour: [משמרות]} et indices עמדה depuis l’override hebdo (_stations)."""
    if not isinstance(ovr, dict):
        return {}, [], False
    avail: dict[str, list[str]] = {}
    station_allow: list[int] = []
    has_station_override = "_stations" in ovr or "_station_indices" in ovr
    for day_key, shifts_list in ovr.items():
        sk = str(day_key or "")
        if sk in ("_stations", "_station_indices"):
            if isinstance(shifts_list, list):
                for x in shifts_list:
                    try:
                        station_allow.append(int(x))
                    except (TypeError, ValueError):
                        pass
            continue
        if sk.startswith("_"):
            continue
        if isinstance(shifts_list, list):
            # Une liste vide est significative: indisponible ce jour précis.
            avail[sk] = [s for s in shifts_list if s]
    return avail, station_allow, has_station_override


def _build_solver_workers(
    rows: list[SiteWorker],
    weekly_overrides: dict[str, dict[str, list[str]]] | None,
    week_iso: str | None = None,
) -> list[dict]:
    overrides = weekly_overrides or {}
    workers: list[dict] = []
    for r in rows:
        ovr = overrides.get(r.name)
        week_avail, week_station_allow, _ = _weekly_override_avail_and_stations(
            ovr if isinstance(ovr, dict) else None,
        )
        merged_availability: dict[str, list[str]] = {}
        for day_key in _WEEK_DAY_KEYS:
            if day_key in week_avail:
                merged_availability[day_key] = list(week_avail.get(day_key) or [])
            else:
                merged_availability[day_key] = []

        station_allow = week_station_allow
        wd: dict = {
            "id": r.id,
            "name": r.name,
            "max_shifts": r.max_shifts,
            "roles": r.roles or [],
            "availability": merged_availability,
        }
        if station_allow:
            wd["allowed_station_indices"] = sorted({i for i in station_allow if i >= 0})
        # Soft prefs: override hebdo éventuel, sinon answers[week]
        prefs = None
        if isinstance(ovr, dict):
            prefs = _normalize_shift_kind_prefs(ovr.get("_shift_kind_prefs"))
        if prefs is None:
            prefs = _shift_kind_prefs_from_answers(r, week_iso)
        if prefs is not None:
            wd["shift_kind_prefs"] = prefs
        slot_prefs = None
        if isinstance(ovr, dict):
            slot_prefs = _normalize_shift_slot_prefs(ovr.get("_shift_slot_prefs"))
        if slot_prefs is None:
            slot_prefs = _shift_slot_prefs_from_answers(r, week_iso)
        if slot_prefs is not None:
            wd["shift_slot_prefs"] = slot_prefs
        workers.append(wd)
    return workers


def _shift_order_index(shift_name: str) -> int:
    if _is_morning_shift_name(shift_name):
        return 0
    if _is_noon_shift_name(shift_name):
        return 1
    if _is_night_shift_name(shift_name):
        return 2
    return 3


def _site_shift_names_ordered(config: dict | None) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for st in ((config or {}).get("stations") or []):
        if not isinstance(st, dict):
            continue
        for sh in (st.get("shifts") or []):
            if not isinstance(sh, dict):
                continue
            nm = str(sh.get("name") or "").strip()
            if nm and nm not in seen:
                seen.add(nm)
                names.append(nm)
        for day_cfg in (st.get("dayOverrides") or {}).values():
            if not isinstance(day_cfg, dict):
                continue
            for sh in (day_cfg.get("shifts") or []):
                if not isinstance(sh, dict):
                    continue
                nm = str(sh.get("name") or "").strip()
                if nm and nm not in seen:
                    seen.add(nm)
                    names.append(nm)
    return sorted(names, key=_shift_order_index)


def _hm_to_minutes(value: str | None) -> int | None:
    raw = str(value or "").strip()
    m = re.match(r"^(\d{1,2}):(\d{2})$", raw)
    if not m:
        return None
    hh, mm = int(m.group(1)), int(m.group(2))
    if hh > 23 or mm > 59:
        return None
    return hh * 60 + mm


def _shift_start_minutes(config: dict | None, shift_name: str) -> int | None:
    for st in ((config or {}).get("stations") or []):
        if not isinstance(st, dict):
            continue
        hours = _hours_from_config(st, shift_name, "sun") or _hours_of(shift_name)
        parsed = _parse_hours_range(hours)
        if parsed:
            return _to_minutes(parsed[0])
    hours = _hours_of(shift_name)
    parsed = _parse_hours_range(hours)
    return _to_minutes(parsed[0]) if parsed else None


def _build_worker_snapshots(rows: list[SiteWorker]) -> list[dict]:
    snapshots: list[dict] = []
    for r in rows:
        snapshots.append({
            "id": r.id,
            "name": r.name,
            "max_shifts": r.max_shifts,
            "roles": r.roles or [],
            "availability": r.availability or { "sun": [], "mon": [], "tue": [], "wed": [], "thu": [], "fri": [], "sat": [] },
            "answers": r.answers or {},
        })
    return snapshots


def _norm_name_local(value: str | None) -> str:
    return str(value or "").strip().replace("\u200f", "").replace("\u200e", "").replace("\xa0", " ")


def _norm_role_local(value: str | None) -> str:
    return _norm_name_local(value).replace('"', "'")


def _hours_of(shift_name: str) -> str | None:
    s = str(shift_name or "")
    m = re.search(r"(\d{1,2})\s*[-:–]\s*(\d{1,2})", s)
    if m:
        return f"{m.group(1).zfill(2)}-{m.group(2).zfill(2)}"
    if re.search(r"בוקר", s, re.I):
        return "06-14"
    if re.search(r"צהר(יים|י)ם?", s, re.I):
        return "14-22"
    if re.search(r"לילה|night", s, re.I):
        return "22-06"
    return None


def _hours_from_config(station_cfg: dict | None, shift_name: str, day_key: str) -> str | None:
    station_cfg = station_cfg or {}

    def fmt(start: str | None, end: str | None) -> str | None:
        if not start or not end:
            return None
        return f"{start}-{end}"

    if station_cfg.get("perDayCustom") and isinstance(station_cfg.get("dayOverrides"), dict):
        day_cfg = (station_cfg.get("dayOverrides") or {}).get(day_key) or {}
        if day_cfg and day_cfg.get("active") is not False:
            shift_cfg = next((x for x in (day_cfg.get("shifts") or []) if isinstance(x, dict) and x.get("name") == shift_name), None)
            out = fmt(shift_cfg.get("start") if isinstance(shift_cfg, dict) else None, shift_cfg.get("end") if isinstance(shift_cfg, dict) else None)
            if out:
                return out

    shift_cfg = next((x for x in (station_cfg.get("shifts") or []) if isinstance(x, dict) and x.get("name") == shift_name), None)
    return fmt(shift_cfg.get("start") if isinstance(shift_cfg, dict) else None, shift_cfg.get("end") if isinstance(shift_cfg, dict) else None)


def _parse_hours_range(range_text: str | None) -> tuple[str, str] | None:
    text = str(range_text or "").strip()
    m = re.match(r"^\s*(\d{1,2}):?(\d{2})?\s*[-–]\s*(\d{1,2}):?(\d{2})?\s*$", text)
    if not m:
        return None
    return (f"{int(m.group(1)):02d}:{int(m.group(2) or '0'):02d}", f"{int(m.group(3)):02d}:{int(m.group(4) or '0'):02d}")


def _to_minutes(hhmm: str) -> int | None:
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(hhmm or "").strip())
    if not m:
        return None
    hh = int(m.group(1))
    mm = int(m.group(2))
    if hh < 0 or hh > 23 or mm < 0 or mm > 59:
        return None
    return hh * 60 + mm


def _from_minutes(value: int) -> str:
    value = int(value) % (24 * 60)
    return f"{value // 60:02d}:{value % 60:02d}"


def _is_morning_shift_name(shift_name: str) -> bool:
    s = str(shift_name or "").strip()
    low = s.lower()
    return ("בוקר" in s) or low.startswith("06") or ("06-14" in low)


def _is_noon_shift_name(shift_name: str) -> bool:
    s = str(shift_name or "").strip()
    low = s.lower()
    return ("צהר" in s) or low.startswith("14") or ("14-22" in low)


def _is_night_shift_name(shift_name: str) -> bool:
    s = str(shift_name or "").strip()
    low = s.lower()
    return ("לילה" in s) or ("night" in low) or low.startswith("22") or ("22-06" in low)



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
    _normalize_shift_kind_prefs, _normalize_shift_slot_prefs,
    _shift_kind_prefs_from_answers, _shift_slot_prefs_from_answers,
    _site_max_nights_per_worker, _norm_name_local, _build_solver_workers,
    _norm_role_local,
)
from .pulls import (
    _payload_has_variant, _payload_variant_assignments, _payload_variant_pulls,
    _pull_extra_names_by_cell, _set_payload_variant_assignments,
    _enforce_role_requirements_on_site_plans, _pulls_count,
    _apply_auto_pulls_to_site_plans, _sanitize_pulls_map,
    _load_workers_by_site,
)
from .events import (
    _compute_site_event_availability_locks,
    _count_site_event_assignments_by_worker_id,
    _apply_site_event_locks_to_solver_workers,
    _apply_site_event_shift_credits_to_solver_workers,
)
from .week_plans import _preferred_week_plan, _week_plan_rank, _save_site_week_plan

router = APIRouter()

def _worker_identity_key(row: SiteWorker) -> str:
    if getattr(row, "user_id", None):
        return f"user:{int(row.user_id)}"
    # Keep identity stable across sites even when phone/name formatting differs.
    phone_raw = str(getattr(row, "phone", "") or "")
    phone = "".join(ch for ch in phone_raw if ch.isdigit() or ch == "+").strip()
    if phone:
        return f"phone:{phone}"
    name_raw = _norm_name_local(getattr(row, "name", ""))
    name = re.sub(r"\s+", " ", str(name_raw or "").strip()).lower()
    return f"name:{name}"


def _active_director_site_ids(db: Session, director_id: int) -> set[int]:
    """Sites non supprimés : les liaisons multi-site ne portent que sur ces ids (historique sur site archivé exclu du graphe)."""
    return {
        int(s.id)
        for s in db.query(Site).filter(Site.director_id == director_id, Site.deleted_at.is_(None)).all()
    }


def _connected_site_ids_for_root(db: Session, director_id: int, root_site_id: int, graph_week_iso: str | None = None) -> list[int]:
    """Composantes connexes par travailleur identique. Exclut pending et retraits (removed_from) pour la semaine du graphe (None = effectif « maintenant »)."""
    site_ids_set = _active_director_site_ids(db, director_id)
    site_ids = sorted(site_ids_set)
    rows = (
        [
            row
            for row in db.query(SiteWorker).filter(SiteWorker.site_id.in_(site_ids)).all()
            if not bool(getattr(row, "pending_approval", False)) and _site_worker_visible_for_week(row, graph_week_iso)
        ]
        if site_ids
        else []
    )
    site_to_keys: dict[int, set[str]] = {}
    key_to_sites: dict[str, set[int]] = {}
    for row in rows:
        site_id = int(row.site_id)
        key = _worker_identity_key(row)
        if not key:
            continue
        site_to_keys.setdefault(site_id, set()).add(key)
        key_to_sites.setdefault(key, set()).add(site_id)

    visited: set[int] = set()
    queue: list[int] = [int(root_site_id)]
    while queue:
        site_id = queue.pop(0)
        if site_id in visited:
            continue
        visited.add(site_id)
        for key in site_to_keys.get(site_id, set()):
            for linked_site_id in key_to_sites.get(key, set()):
                if linked_site_id not in visited:
                    queue.append(linked_site_id)
    return sorted(visited)


def _linked_site_cluster_map_for_director(
    db: Session,
    director_id: int,
    graph_week_iso: str | None = None,
) -> dict[int, list[int]]:
    """Pour chaque site, liste triée des ids du même groupe multi-sites (≥2) ; [] si isolé."""
    site_ids_set = _active_director_site_ids(db, director_id)
    site_ids = sorted(site_ids_set)
    if not site_ids:
        return {}
    rows = db.query(SiteWorker).filter(SiteWorker.site_id.in_(site_ids)).all()
    rows = [
        row
        for row in rows
        if not bool(getattr(row, "pending_approval", False)) and _site_worker_visible_for_week(row, graph_week_iso)
    ]
    key_to_sites: dict[str, set[int]] = {}
    for row in rows:
        key = _worker_identity_key(row)
        if not key:
            continue
        key_to_sites.setdefault(key, set()).add(int(row.site_id))
    parent = {sid: sid for sid in site_ids}

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for site_set in key_to_sites.values():
        ids_sorted = sorted(site_set)
        if len(ids_sorted) < 2:
            continue
        first = ids_sorted[0]
        for sid in ids_sorted[1:]:
            union(first, sid)

    root_members: dict[int, list[int]] = {}
    for sid in site_ids:
        r = find(sid)
        root_members.setdefault(r, []).append(sid)
    out: dict[int, list[int]] = {}
    for _root, members in root_members.items():
        msorted = sorted(members)
        if len(msorted) < 2:
            for sid in msorted:
                out[sid] = []
        else:
            for sid in msorted:
                out[sid] = msorted
    return out


def _site_role_key(site_id: int, role_name: str | None) -> str:
    return f"site:{site_id}:{_norm_role_local(role_name)}"


def _linked_site_ids_for_worker(db: Session, director_id: int, row: SiteWorker) -> list[int]:
    director_site_ids = sorted(_active_director_site_ids(db, director_id))
    if not director_site_ids:
        return [int(row.site_id)]
    key = _worker_identity_key(row)
    linked_rows = db.query(SiteWorker).filter(SiteWorker.site_id.in_(director_site_ids)).all()
    linked_site_ids = sorted(
        {
            int(r.site_id)
            for r in linked_rows
            if _worker_identity_key(r) == key
            and not bool(getattr(r, "pending_approval", False))
            and _site_worker_visible_for_week(r, None)
        }
    )
    return linked_site_ids or [int(row.site_id)]


def _linked_site_ids_by_worker_key(
    rows: list[SiteWorker],
    graph_week_iso: str | None = None,
    active_site_ids: set[int] | None = None,
) -> dict[str, list[int]]:
    key_to_site_ids: dict[str, set[int]] = {}
    for row in rows:
        if bool(getattr(row, "pending_approval", False)) or not _site_worker_visible_for_week(row, graph_week_iso):
            continue
        key = _worker_identity_key(row)
        if not key:
            continue
        site_id = int(row.site_id)
        if active_site_ids is not None and site_id not in active_site_ids:
            continue
        key_to_site_ids.setdefault(key, set()).add(site_id)
    return {key: sorted(site_ids) for key, site_ids in key_to_site_ids.items()}


def _prefix_roles_for_combined_station(station_cfg: dict, site_id: int) -> dict:
    cloned = deepcopy(station_cfg)

    def prefix_roles(items: list[dict] | None) -> list[dict]:
        out: list[dict] = []
        for item in (items or []):
            if not isinstance(item, dict):
                continue
            cp = dict(item)
            cp["name"] = _site_role_key(site_id, item.get("name"))
            out.append(cp)
        return out

    cloned["roles"] = prefix_roles(cloned.get("roles"))
    cloned["shifts"] = [
        {**sh, "roles": prefix_roles((sh or {}).get("roles"))}
        for sh in (cloned.get("shifts") or [])
        if isinstance(sh, dict)
    ]
    if isinstance(cloned.get("dayOverrides"), dict):
        next_day_overrides = {}
        for day_key, ov in (cloned.get("dayOverrides") or {}).items():
            if not isinstance(ov, dict):
                next_day_overrides[day_key] = ov
                continue
            next_day_overrides[day_key] = {
                **ov,
                "shifts": [
                    {**sh, "roles": prefix_roles((sh or {}).get("roles"))}
                    for sh in (ov.get("shifts") or [])
                    if isinstance(sh, dict)
                ],
            }
        cloned["dayOverrides"] = next_day_overrides
    return cloned


def _build_multi_site_generation_context(
    db: Session,
    director_id: int,
    root_site_id: int,
    week_iso: str,
    weekly_availability: dict[str, dict[str, list[str]]] | None = None,
    exclude_days: list[str] | None = None,
    fixed_assignments: dict[str, dict[str, list[list[str]]]] | None = None,
) -> dict:
    connected_site_ids = _connected_site_ids_for_root(db, director_id, root_site_id, week_iso)
    sites = db.query(Site).filter(Site.id.in_(connected_site_ids)).all() if connected_site_ids else []
    sites_by_id = {int(s.id): s for s in sites}
    workers_by_site = _load_workers_by_site(db, connected_site_ids) if connected_site_ids else {}
    rows = [
        row
        for sid in connected_site_ids
        for row in (workers_by_site.get(int(sid)) or [])
        if not bool(getattr(row, "pending_approval", False)) and _site_worker_visible_for_week(row, week_iso)
    ]
    weekly_rows = (
        db.query(SiteWeeklyAvailability)
        .filter(SiteWeeklyAvailability.site_id.in_(connected_site_ids))
        .filter(SiteWeeklyAvailability.week_iso == week_iso)
        .all()
        if connected_site_ids else []
    )
    weekly_overrides_by_site: dict[int, dict[str, dict[str, list[str]]]] = {
        int(row.site_id): (row.availability or {})
        for row in weekly_rows
    }
    saved_plan_rows = (
        db.query(SiteWeekPlan)
        .filter(SiteWeekPlan.site_id.in_(connected_site_ids))
        .filter(SiteWeekPlan.week_iso == week_iso)
        .filter(SiteWeekPlan.scope.in_(["director", "shared"]))
        .all()
        if connected_site_ids else []
    )
    saved_plan_rows_by_site: dict[int, list[SiteWeekPlan]] = {}
    for row in saved_plan_rows:
        saved_plan_rows_by_site.setdefault(int(row.site_id), []).append(row)

    worker_groups: dict[str, dict] = {}
    current_site_overrides = weekly_availability or {}
    for row in rows:
        key = _worker_identity_key(row)
        group = worker_groups.setdefault(key, {
            "solver_name": f"worker::{key}",
            "site_ids": set(),
            "site_display_names": {},
            "roles": set(),
            "max_shifts": [],
            "availability": None,
            "shift_kind_prefs": None,
            "shift_slot_prefs": None,
        })
        site_id = int(row.site_id)
        group["site_ids"].add(site_id)
        group["site_display_names"][site_id] = row.name
        group["max_shifts"].append(int(row.max_shifts or 5))
        for role_name in (row.roles or []):
            group["roles"].add(_site_role_key(site_id, str(role_name)))
        # Soft prefs (ne touche pas multi-site / תפקידים) — première valeur non nulle
        if group.get("shift_kind_prefs") is None:
            prefs = _shift_kind_prefs_from_answers(row, week_iso)
            if prefs is None and site_id == int(root_site_id):
                root_ovr = current_site_overrides.get(row.name)
                if isinstance(root_ovr, dict):
                    prefs = _normalize_shift_kind_prefs(root_ovr.get("_shift_kind_prefs"))
            if prefs is not None:
                group["shift_kind_prefs"] = prefs
        if group.get("shift_slot_prefs") is None:
            slot_prefs = _shift_slot_prefs_from_answers(row, week_iso)
            if slot_prefs is None and site_id == int(root_site_id):
                root_ovr = current_site_overrides.get(row.name)
                if isinstance(root_ovr, dict):
                    slot_prefs = _normalize_shift_slot_prefs(root_ovr.get("_shift_slot_prefs"))
            if slot_prefs is not None:
                group["shift_slot_prefs"] = slot_prefs
        site_weekly_overrides = weekly_overrides_by_site.get(site_id, {})
        override = None
        if site_id == int(root_site_id):
            override = current_site_overrides.get(row.name)
        if not isinstance(override, dict):
            override = site_weekly_overrides.get(row.name)
        # Fusionner les disponibilités par union des jours/quarts entre les sites:
        # ne pas écraser la disponibilité déjà accumulée — prendre l'union pour que
        # le worker logique soit disponible sur un créneau dès qu'il l'est sur l'un de ses sites.
        if isinstance(override, dict):
            new_avail = {
                str(k): list(v)
                for k, v in override.items()
                if isinstance(v, list) and not str(k).startswith("_")
            }
        else:
            new_avail = {day_key: [] for day_key in _WEEK_DAY_KEYS}
        if new_avail is not None:
            if group["availability"] is None:
                group["availability"] = new_avail
            else:
                # Union : pour chaque jour, réunion des shifts disponibles
                merged = dict(group["availability"])
                for day_k, shifts_list in new_avail.items():
                    if day_k in merged:
                        existing = set(merged[day_k])
                        existing.update(shifts_list)
                        merged[day_k] = sorted(existing)
                    else:
                        merged[day_k] = list(shifts_list)
                group["availability"] = merged

    combined_stations: list[dict] = []
    station_map: list[dict] = []
    for site_id in connected_site_ids:
        site = sites_by_id.get(site_id)
        if not site:
            continue
        for idx, station_cfg in enumerate(((site.config or {}).get("stations") or [])):
            if not isinstance(station_cfg, dict):
                continue
            cloned = _prefix_roles_for_combined_station(station_cfg, site_id)
            cloned["name"] = f"{site.name} / {cloned.get('name') or f'עמדה {idx + 1}'}"
            cloned["siteId"] = site_id
            cloned["siteName"] = site.name
            cloned["siteStationIndex"] = idx
            cloned["allowedWorkers"] = [
                group["solver_name"]
                for group in worker_groups.values()
                if site_id in group["site_ids"]
            ]
            combined_stations.append(cloned)
            station_map.append({"site_id": site_id, "site_station_index": idx})

    combined_config = {"stations": combined_stations}

    # Pour chaque site, construire la liste des indices de stations dans combined_stations
    site_station_indices: dict[int, list[int]] = {}
    for combined_idx, meta in enumerate(station_map):
        sid = int(meta["site_id"])
        site_station_indices.setdefault(sid, []).append(combined_idx)

    combined_workers = []
    for idx, (key, group) in enumerate(worker_groups.items()):
        global_max = min(group["max_shifts"]) if group["max_shifts"] else 5
        # site_limits: contrainte max_shifts par site pour ce worker multi-site
        # Chaque entrée = (liste d'indices de stations du site, max_shifts pour ce site)
        site_limits = []
        for site_id in group["site_ids"]:
            st_indices = site_station_indices.get(int(site_id), [])
            # max_shifts du worker sur ce site spécifique
            # On prend le max_shifts de la première (et unique) occurrence du worker sur ce site
            site_row_max = 5
            for row in rows:
                if int(row.site_id) == int(site_id) and _worker_identity_key(row) == key:
                    site_row_max = int(row.max_shifts or 5)
                    break
            if st_indices:
                site_limits.append({"station_indices": st_indices, "max": site_row_max})
        cw: dict = {
            "id": idx + 1,
            "name": group["solver_name"],
            "max_shifts": global_max,
            "roles": sorted(group["roles"]),
            "availability": group["availability"] or {},
            "site_limits": site_limits,
        }
        if isinstance(group.get("shift_kind_prefs"), dict):
            cw["shift_kind_prefs"] = group["shift_kind_prefs"]
        if isinstance(group.get("shift_slot_prefs"), dict):
            cw["shift_slot_prefs"] = group["shift_slot_prefs"]
        combined_workers.append(cw)

    # אירועים : retirer les créneaux verrouillés (union multi-sites) de la זמינות du solveur
    # et réduire max_shifts (chaque אירוע = 1 garde / שיבוץ).
    identity_event_locks: dict[str, dict[str, set[str]]] = {}
    identity_event_counts: dict[str, int] = {}
    identity_event_counts_by_site: dict[str, dict[int, int]] = {}
    all_event_rows = (
        db.query(SiteEvent).filter(SiteEvent.site_id.in_(connected_site_ids)).all()
        if connected_site_ids
        else []
    )
    events_by_site: dict[int, list[SiteEvent]] = {}
    for ev in all_event_rows:
        events_by_site.setdefault(int(ev.site_id), []).append(ev)
    for sid in connected_site_ids:
        site_obj = sites_by_id.get(int(sid))
        event_rows = events_by_site.get(int(sid), [])
        site_locks = _compute_site_event_availability_locks(
            db,
            int(sid),
            week_iso,
            (site_obj.config if site_obj else None) or {},
            event_rows=event_rows,
        )
        site_counts = _count_site_event_assignments_by_worker_id(
            db, int(sid), week_iso, event_rows=event_rows,
        )
        for row in rows:
            if int(row.site_id) != int(sid):
                continue
            key = _worker_identity_key(row)
            wlocks = site_locks.get(int(row.id)) or {}
            if wlocks:
                bucket = identity_event_locks.setdefault(key, {})
                for day_key, shift_list in wlocks.items():
                    bucket.setdefault(str(day_key), set()).update(str(s) for s in (shift_list or []))
            n = int(site_counts.get(int(row.id)) or 0)
            if n > 0:
                identity_event_counts[key] = identity_event_counts.get(key, 0) + n
                by_site = identity_event_counts_by_site.setdefault(key, {})
                by_site[int(sid)] = by_site.get(int(sid), 0) + n
    if identity_event_locks:
        for cw in combined_workers:
            nm = str(cw.get("name") or "")
            key = nm[len("worker::") :] if nm.startswith("worker::") else nm
            locks = identity_event_locks.get(key) or {}
            if not locks:
                continue
            avail = dict(cw.get("availability") or {})
            for day_key, locked_shifts in locks.items():
                cur = list(avail.get(day_key) or [])
                avail[day_key] = [sn for sn in cur if sn not in locked_shifts]
            cw["availability"] = avail
    if identity_event_counts:
        # Rebuild site_id lookup from station_map indices already on each cw site_limits
        for cw in combined_workers:
            nm = str(cw.get("name") or "")
            key = nm[len("worker::") :] if nm.startswith("worker::") else nm
            total_events = int(identity_event_counts.get(key) or 0)
            if total_events <= 0:
                continue
            try:
                mx = int(cw.get("max_shifts") or 5)
            except Exception:
                mx = 5
            cw["max_shifts"] = max(0, mx - total_events)
            by_site = identity_event_counts_by_site.get(key) or {}
            limits = cw.get("site_limits")
            if isinstance(limits, list) and by_site:
                # site_limits entries don't carry site_id — rebuild from group site_ids via station indices
                for lim in limits:
                    if not isinstance(lim, dict):
                        continue
                    st_indices = lim.get("station_indices") or []
                    if not st_indices:
                        continue
                    # find site for first station index
                    first_idx = int(st_indices[0]) if st_indices else -1
                    sid_for_lim = None
                    if 0 <= first_idx < len(station_map):
                        sid_for_lim = int(station_map[first_idx].get("site_id"))
                    if sid_for_lim is None:
                        continue
                    n_site = int(by_site.get(sid_for_lim) or 0)
                    if n_site <= 0:
                        continue
                    try:
                        lim_max = int(lim.get("max") or 5)
                    except Exception:
                        lim_max = 5
                    lim["max"] = max(0, lim_max - n_site)

    fixed_assignments_by_site: dict[int, dict[str, dict[str, list[list[str]]]]] = {}
    for site_id in connected_site_ids:
        if int(site_id) == int(root_site_id):
            continue
        preferred_row = _preferred_week_plan(saved_plan_rows_by_site.get(int(site_id), []))
        preferred_data = preferred_row.data if preferred_row and isinstance(preferred_row.data, dict) else {}
        preferred_assignments = preferred_data.get("assignments")
        if isinstance(preferred_assignments, dict):
            fixed_assignments_by_site[int(site_id)] = preferred_assignments
    if fixed_assignments:
        fixed_assignments_by_site[int(root_site_id)] = fixed_assignments

    combined_fixed: dict[str, dict[str, list[list[str]]]] | None = None
    if fixed_assignments_by_site:
        root_site = sites_by_id.get(int(root_site_id))
        if root_site:
            from ..ai_solver import build_capacities_from_config
            root_days, root_shifts, _root_stations = build_capacities_from_config(root_site.config or {}, exclude_days)
            name_to_solver_by_site: dict[int, dict[str, str]] = {}
            for key, group in worker_groups.items():
                for site_id, site_name in group["site_display_names"].items():
                    name_to_solver_by_site.setdefault(int(site_id), {})[str(site_name)] = group["solver_name"]
            combined_fixed = {day: {sh: [[] for _ in combined_stations] for sh in root_shifts} for day in root_days}
            station_index_map_by_site: dict[int, dict[int, int]] = {}
            for idx, meta in enumerate(station_map):
                site_id = int(meta["site_id"])
                station_index_map_by_site.setdefault(site_id, {})[int(meta["site_station_index"])] = idx
            for site_id, site_fixed_assignments in fixed_assignments_by_site.items():
                station_index_map = station_index_map_by_site.get(int(site_id), {})
                name_to_solver = name_to_solver_by_site.get(int(site_id), {})
                for day_key, shifts_map in (site_fixed_assignments or {}).items():
                    if day_key not in combined_fixed or not isinstance(shifts_map, dict):
                        continue
                    for shift_name, per_station in shifts_map.items():
                        if shift_name not in combined_fixed[day_key] or not isinstance(per_station, list):
                            continue
                        for local_idx, cell in enumerate(per_station):
                            combined_idx = station_index_map.get(local_idx)
                            if combined_idx is None or not isinstance(cell, list):
                                continue
                            combined_fixed[day_key][shift_name][combined_idx] = [
                                name_to_solver.get(str(name), str(name))
                                for name in cell
                                if str(name or "").strip()
                            ]

    display_name_by_solver_site: dict[tuple[str, int], str] = {}
    for group in worker_groups.values():
        for site_id, display_name in group["site_display_names"].items():
            display_name_by_solver_site[(group["solver_name"], int(site_id))] = str(display_name)

    return {
        "connected_site_ids": connected_site_ids,
        "sites_by_id": sites_by_id,
        "workers_by_site": workers_by_site,
        "combined_config": combined_config,
        "combined_workers": combined_workers,
        "combined_fixed": combined_fixed,
        "station_map": station_map,
        "display_name_by_solver_site": display_name_by_solver_site,
        "exclude_days": exclude_days,
    }


def _split_multi_site_assignments(
    context: dict,
    combined_assignments_value: dict | None,
    status: str | None = None,
    objective: float | int | None = None,
) -> dict[str, dict]:
    connected_site_ids = context["connected_site_ids"]
    sites_by_id = context["sites_by_id"]
    station_map = context["station_map"]
    display_name_by_solver_site = context["display_name_by_solver_site"]
    exclude_days = context["exclude_days"]

    site_plans_local: dict[str, dict] = {}
    for site_id in connected_site_ids:
        site = sites_by_id.get(site_id)
        if not site:
            continue
        from ..ai_solver import build_capacities_from_config
        days, shifts, stations = build_capacities_from_config(site.config or {}, exclude_days)
        required_count = 0
        for st in stations:
            cap_map = (st.get("capacity") or {})
            for day_key in days:
                for shift_name in shifts:
                    required_count += int((cap_map.get(day_key, {}) or {}).get(shift_name, 0) or 0)
        site_plans_local[str(site_id)] = {
            "site_id": site_id,
            "site_name": site.name,
            "days": days,
            "shifts": shifts,
            "stations": [st.get("name") for st in stations],
            "assignments": {day: {shift: [[] for _ in stations] for shift in shifts} for day in days},
            "status": status,
            "objective": objective,
            "assigned_count": 0,
            "required_count": required_count,
            "alternatives": [],
        }

    combined_assignments = combined_assignments_value or {}
    for combined_idx, meta in enumerate(station_map):
        site_id = int(meta["site_id"])
        local_idx = int(meta["site_station_index"])
        site_plan = site_plans_local.get(str(site_id))
        if not site_plan:
            continue
        for day_key in site_plan["days"]:
            for shift_name in site_plan["shifts"]:
                per_station = (combined_assignments.get(day_key) or {}).get(shift_name) or []
                names = per_station[combined_idx] if combined_idx < len(per_station) else []
                if not isinstance(names, list):
                    names = []
                site_plan["assignments"][day_key][shift_name][local_idx] = [
                    display_name_by_solver_site.get((str(name), site_id), str(name))
                    for name in names
                    if str(name or "").strip()
                ]
    # Comptage final par worker sur la grille combinée (avant découpe) et par site après découpe
    _logger = logging.getLogger("sites")
    # Comptage dans le plan combiné brut
    combined_worker_counts: dict[str, int] = {}
    for day_map in combined_assignments.values():
        for per_station in day_map.values():
            for cell in per_station:
                for nm in (cell or []):
                    nm = str(nm or "").strip()
                    if nm:
                        combined_worker_counts[nm] = combined_worker_counts.get(nm, 0) + 1
    # Workers solver qui dépassent leur max_shifts dans le combiné
    context_workers = context.get("combined_workers") if context else None
    if context_workers:
        solver_max: dict[str, int] = {
            str(w.get("name") or "").strip(): int(w.get("max_shifts") or 5)
            for w in context_workers
        }
        over_combined = {
            nm: (cnt, solver_max.get(nm, 5))
            for nm, cnt in combined_worker_counts.items()
            if cnt > solver_max.get(nm, 5)
        }
        if over_combined:
            _logger.warning(
                "[SPLIT] workers over max_shifts in COMBINED plan (before split): %s",
                over_combined,
            )
        else:
            _logger.info(
                "[SPLIT] all workers within max_shifts in combined plan. counts=%s",
                dict(sorted(combined_worker_counts.items())),
            )

    # Construire la map display_name → max_shifts global (min des sites du groupe)
    # pour pouvoir appliquer le plafond global après la découpe.
    display_name_to_max: dict[str, int] = {}
    display_name_by_solver_site_local = context.get("display_name_by_solver_site") or {}
    context_workers_list = context.get("combined_workers") or []
    for w in context_workers_list:
        solver_name = str(w.get("name") or "").strip()
        max_s = int(w.get("max_shifts") or 5)
        # Récupérer tous les display_names associés à ce solver_name (toutes les (solver_name, site_id))
        for (sn, _sid), dname in display_name_by_solver_site_local.items():
            if str(sn) == solver_name:
                dname = str(dname or "").strip()
                if dname:
                    # Prendre le minimum en cas d'incohérence
                    display_name_to_max[dname] = min(display_name_to_max.get(dname, max_s), max_s)

    # Appliquer le plafond global cross-sites :
    # compter toutes les occurrences du display_name sur TOUS les sites, puis retirer les surplus.
    if display_name_to_max:
        global_counts: dict[str, int] = {}
        # Parcourir dans un ordre déterministe (sites triés) pour un comportement reproductible
        for site_id_str in sorted(site_plans_local.keys()):
            sp = site_plans_local[site_id_str]
            for day_key in sp["days"]:
                for shift_name in sp["shifts"]:
                    per_station = (sp["assignments"].get(day_key, {}) or {}).get(shift_name, [])
                    for cell in per_station:
                        if not isinstance(cell, list):
                            continue
                        kept = []
                        for nm in cell:
                            nm = str(nm or "").strip()
                            if not nm:
                                continue
                            max_g = display_name_to_max.get(nm)
                            if max_g is not None and global_counts.get(nm, 0) >= max_g:
                                _logger.warning(
                                    "[SPLIT][GLOBAL_CAP] removed extra assignment: worker=%r site=%s day=%s shift=%s (global_count=%d max=%d)",
                                    nm, site_id_str, day_key, shift_name,
                                    global_counts.get(nm, 0), max_g,
                                )
                                continue
                            global_counts[nm] = global_counts.get(nm, 0) + 1
                            kept.append(nm)
                        cell[:] = kept

    for site_plan in site_plans_local.values():
        assigned_count = 0
        site_worker_counts: dict[str, int] = {}
        for day_key in site_plan["days"]:
            for shift_name in site_plan["shifts"]:
                for cell in (site_plan["assignments"].get(day_key, {}) or {}).get(shift_name, []):
                    if isinstance(cell, list):
                        for nm in cell:
                            nm = str(nm or "").strip()
                            if nm:
                                assigned_count += 1
                                site_worker_counts[nm] = site_worker_counts.get(nm, 0) + 1
        site_plan["assigned_count"] = assigned_count
        _logger.info(
            "[SPLIT] site=%s assigned=%d worker_counts=%s",
            site_plan.get("site_id"),
            assigned_count,
            dict(sorted(site_worker_counts.items())),
        )
    return site_plans_local


def _enforce_linked_global_caps_on_site_payloads(
    db: Session,
    linked_site_ids: list[int],
    week_iso: str,
    payloads_by_site: dict[str, dict],
    workers_by_site: dict[int, list[SiteWorker]] | None = None,
) -> dict[str, dict]:
    if len(linked_site_ids) <= 1 or not payloads_by_site:
        return {str(site_id): deepcopy(payload) for site_id, payload in payloads_by_site.items()}

    loaded = workers_by_site if workers_by_site is not None else _load_workers_by_site(db, linked_site_ids)
    rows = [
        row
        for sid in linked_site_ids
        for row in (loaded.get(int(sid)) or [])
        if not bool(getattr(row, "pending_approval", False)) and _site_worker_visible_for_week(row, week_iso)
    ]
    if not rows:
        return {str(site_id): deepcopy(payload) for site_id, payload in payloads_by_site.items()}

    normalized_payloads: dict[str, dict] = {
        str(site_id): deepcopy(payload) if isinstance(payload, dict) else {}
        for site_id, payload in payloads_by_site.items()
    }
    name_to_key_by_site: dict[int, dict[str, str]] = {}
    max_by_worker_key: dict[str, int] = {}
    for row in rows:
        worker_key = _worker_identity_key(row)
        if not worker_key:
            continue
        site_id_int = int(row.site_id)
        display_name = _norm_name_local(getattr(row, "name", ""))
        if display_name:
            name_to_key_by_site.setdefault(site_id_int, {})[display_name] = worker_key
        max_shifts = int(getattr(row, "max_shifts", 5) or 5)
        max_by_worker_key[worker_key] = min(max_by_worker_key.get(worker_key, max_shifts), max_shifts)

    if not max_by_worker_key:
        return normalized_payloads

    max_alternative_count = max(
        (
            len(payload.get("alternatives") or [])
            if isinstance(payload.get("alternatives"), list) else 0
        )
        for payload in normalized_payloads.values()
    ) if normalized_payloads else 0

    for variant_index in [-1, *range(max_alternative_count)]:
        global_counts: dict[str, int] = {}
        variant_label = "base" if variant_index < 0 else f"alt:{variant_index + 1}"
        for site_id_str in sorted(normalized_payloads.keys(), key=lambda value: int(value)):
            payload = normalized_payloads[site_id_str]
            if not _payload_has_variant(payload, variant_index):
                continue
            site_id_int = int(site_id_str)
            assignments = _payload_variant_assignments(payload, variant_index)
            pull_extras_by_cell = _pull_extra_names_by_cell(_payload_variant_pulls(payload, variant_index))
            name_to_key = name_to_key_by_site.get(site_id_int, {})
            for day_key, shifts_map in assignments.items():
                if not isinstance(shifts_map, dict):
                    continue
                for shift_name, per_station in shifts_map.items():
                    if not isinstance(per_station, list):
                        continue
                    for station_idx, cell in enumerate(per_station):
                        if not isinstance(cell, list):
                            continue
                        pull_extra_names = pull_extras_by_cell.get((str(day_key), str(shift_name), station_idx), set())
                        kept: list[str] = []
                        for raw_name in cell:
                            normalized_name = _norm_name_local(raw_name)
                            if not normalized_name:
                                continue
                            if normalized_name in pull_extra_names:
                                kept.append(str(raw_name).strip())
                                continue
                            worker_key = name_to_key.get(normalized_name)
                            max_allowed = max_by_worker_key.get(worker_key) if worker_key else None
                            if worker_key and max_allowed is not None and global_counts.get(worker_key, 0) >= max_allowed:
                                logger.warning(
                                    "[PUT_WEEK_PLAN][GLOBAL_CAP] removed extra assignment worker=%r worker_key=%s site=%s variant=%s day=%s shift=%s global_count=%d max=%d",
                                    normalized_name,
                                    worker_key,
                                    site_id_str,
                                    variant_label,
                                    day_key,
                                    shift_name,
                                    global_counts.get(worker_key, 0),
                                    max_allowed,
                                )
                                continue
                            if worker_key and max_allowed is not None:
                                global_counts[worker_key] = global_counts.get(worker_key, 0) + 1
                            kept.append(str(raw_name).strip())
                        cell[:] = kept
            _set_payload_variant_assignments(payload, variant_index, assignments)

    return normalized_payloads


def _count_assignments_in_grid(assignments: dict | None) -> int:
    total = 0
    if not isinstance(assignments, dict):
        return 0
    for shifts_map in assignments.values():
        if not isinstance(shifts_map, dict):
            continue
        for per_station in shifts_map.values():
            if not isinstance(per_station, list):
                continue
            for cell in per_station:
                if not isinstance(cell, list):
                    continue
                for raw_name in cell:
                    if str(raw_name or "").strip():
                        total += 1
    return total


def _refresh_site_plan_assigned_count(site_plan: dict) -> None:
    if not isinstance(site_plan, dict):
        return
    base_total = _count_assignments_in_grid(site_plan.get("assignments"))
    pulls_total = _pulls_count(site_plan.get("pulls") if isinstance(site_plan.get("pulls"), dict) else {})
    site_plan["assigned_count"] = max(0, base_total - pulls_total)


def _enforce_linked_global_caps_on_site_plans(
    db: Session,
    linked_site_ids: list[int],
    week_iso: str,
    site_plans: dict[str, dict],
    workers_by_site: dict[int, list[SiteWorker]] | None = None,
) -> dict[str, dict]:
    normalized_site_plans = _enforce_linked_global_caps_on_site_payloads(
        db,
        linked_site_ids,
        week_iso,
        site_plans,
        workers_by_site=workers_by_site,
    )
    for site_plan in normalized_site_plans.values():
        _refresh_site_plan_assigned_count(site_plan)
    return normalized_site_plans


def _generate_multi_site_memory_plans(
    db: Session,
    director_id: int,
    root_site_id: int,
    week_iso: str,
    weekly_availability: dict[str, dict[str, list[str]]] | None = None,
    exclude_days: list[str] | None = None,
    fixed_assignments: dict[str, dict[str, list[list[str]]]] | None = None,
    time_limit_seconds: int | None = 20,
    num_alternatives: int | None = 20,
) -> dict:
    context = _build_multi_site_generation_context(
        db,
        director_id,
        root_site_id,
        week_iso,
        weekly_availability=weekly_availability,
        exclude_days=exclude_days,
        fixed_assignments=fixed_assignments,
    )

    root_site = (context.get("sites_by_id") or {}).get(int(root_site_id))
    root_config = (root_site.config if root_site else None) or {}
    result = solve_schedule(
        context["combined_config"],
        context["combined_workers"],
        time_limit_seconds=int(time_limit_seconds or 20),
        max_nights_per_worker=_site_max_nights_per_worker(root_config),
        num_alternatives=num_alternatives,
        fixed_assignments=context["combined_fixed"],
        exclude_days=exclude_days,
    )

    filled_base_site_plans = _split_multi_site_assignments(
        context,
        result.get("assignments") or {},
        status=result.get("status"),
        objective=result.get("objective"),
    )
    workers_by_site = context.get("workers_by_site")
    filled_base_site_plans = _enforce_role_requirements_on_site_plans(
        db,
        context["sites_by_id"],
        filled_base_site_plans,
        workers_by_site=workers_by_site,
    )
    for site_id, site_plan in filled_base_site_plans.items():
        site_plan["status"] = result.get("status")
        site_plan["objective"] = result.get("objective")
    for alt_assignments in (result.get("alternatives") or []):
        alt_site_plans = _split_multi_site_assignments(
            context,
            alt_assignments if isinstance(alt_assignments, dict) else {},
            status=result.get("status"),
            objective=result.get("objective"),
        )
        alt_site_plans = _enforce_role_requirements_on_site_plans(
            db,
            context["sites_by_id"],
            alt_site_plans,
            workers_by_site=workers_by_site,
        )
        for site_id, alt_site_plan in alt_site_plans.items():
            filled_base_site_plans[site_id].setdefault("alternatives", []).append(alt_site_plan["assignments"])

    linked_sites = [
        {"id": site_id, "name": context["sites_by_id"][site_id].name}
        for site_id in context["connected_site_ids"]
        if site_id in context["sites_by_id"]
    ]
    filled_base_site_plans = _enforce_linked_global_caps_on_site_plans(
        db,
        context["connected_site_ids"],
        week_iso,
        filled_base_site_plans,
        workers_by_site=workers_by_site,
    )
    return {
        "root_site_id": root_site_id,
        "linked_sites": linked_sites,
        "site_plans": filled_base_site_plans,
    }


@router.get("/{site_id}/linked-sites")
def get_linked_sites(
    site_id: int,
    week: str | None = Query(None),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    from .auto_planning import _summarize_auto_planning_result

    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    week_iso = _validate_week_iso(week) if week else None
    linked_site_ids = _connected_site_ids_for_root(db, user.id, site_id, week_iso)
    sites = db.query(Site).filter(Site.id.in_(linked_site_ids)).all() if linked_site_ids else []
    by_id = {int(s.id): s for s in sites}
    plan_rows_by_site: dict[int, list[SiteWeekPlan]] = {}
    if week_iso and linked_site_ids:
        rows = (
            db.query(SiteWeekPlan)
            .filter(SiteWeekPlan.site_id.in_(linked_site_ids))
            .filter(SiteWeekPlan.week_iso == week_iso)
            .filter(SiteWeekPlan.scope.in_(["auto", "director", "shared"]))
            .all()
        )
        for row in rows:
            plan_rows_by_site.setdefault(int(row.site_id), []).append(row)

    def _preferred_week_plan(site_rows: list[SiteWeekPlan]) -> SiteWeekPlan | None:
        best_row: SiteWeekPlan | None = None
        best_rank = -1
        for row in site_rows:
            rank = _week_plan_rank(row)
            if rank > best_rank:
                best_rank = rank
                best_row = row
        return best_row

    response: list[dict] = []
    for linked_site_id in linked_site_ids:
        linked_site_int = int(linked_site_id)
        linked_site = by_id.get(linked_site_int)
        if not linked_site:
            continue
        entry = {
            "id": linked_site_int,
            "name": linked_site.name,
            "site_deleted": bool(getattr(linked_site, "deleted_at", None)),
            "has_saved_plan": False,
        }
        if week_iso:
            site_rows = plan_rows_by_site.get(linked_site_int, [])
            preferred_row = _preferred_week_plan(site_rows)
            entry["has_saved_plan"] = any(
                str(getattr(r, "scope", "") or "").lower() in {"director", "shared"} for r in site_rows
            )
            data = preferred_row.data if preferred_row and isinstance(preferred_row.data, dict) else {}
            summary = _summarize_auto_planning_result(
                linked_site,
                data.get("assignments"),
                week_iso,
                "linked-sites",
                pulls=data.get("pulls") if isinstance(data.get("pulls"), dict) else None,
            )
            entry["assigned_count"] = int(summary.get("assigned_count") or 0)
            entry["required_count"] = int(summary.get("required_count") or 0)
        response.append(entry)
    # Actifs d’abord, puis sites archivés (soft-delete) ; à l’intérieur de chaque groupe par nom.
    response.sort(
        key=lambda e: (
            1 if e.get("site_deleted") else 0,
            str(e.get("name") or ""),
        )
    )
    return response



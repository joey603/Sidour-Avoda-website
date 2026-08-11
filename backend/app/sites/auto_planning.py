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
    _build_solver_workers, _build_worker_snapshots, _site_max_nights_per_worker,
    _resolve_max_nights_per_worker, _log_single_site_generation_worker_totals,
)
from .pulls import (
    _apply_auto_pulls_to_payload, _enforce_role_requirements_on_assignments,
    _normalize_pulls_limits_by_site, _apply_auto_pulls_to_site_plans,
    _effective_auto_pulls_limit_for_site, _count_split_day_same_worker_patterns,
    _pulls_count, _preferred_pulls_count, _normalize_pulls_prefer, _matches_pulls_limit, _sanitize_pulls_map,
)
from .linked_sites import (
    _enforce_linked_global_caps_on_site_plans, _generate_multi_site_memory_plans,
    _linked_site_cluster_map_for_director, _connected_site_ids_for_root,
    _active_director_site_ids, _build_multi_site_generation_context,
    _split_multi_site_assignments, _enforce_linked_global_caps_on_site_payloads,
)
from .events import _apply_site_event_locks_to_solver_workers
from .week_plans import _save_site_week_plan, _preferred_week_plan

router = APIRouter()

_AUTO_PLANNING_CONFIG_PULLS_MAX = 30


def _next_effective_run_time(now: datetime, config: DirectorAutoPlanningConfig) -> datetime:
    candidate = _schedule_run_time_for_current_week(now, config.day_of_week, config.hour, config.minute)
    updated_at = _ms_to_datetime(getattr(config, "updated_at", None))
    last_run_at = _ms_to_datetime(getattr(config, "last_run_at", None))

    # Si la config a été créée/modifiée après le créneau de cette semaine,
    # on attend la prochaine occurrence réelle du jour/heure choisis.
    # La saisie UI est à la minute: si on sauvegarde pendant cette même minute,
    # on considère encore que le créneau de cette semaine est valide.
    if updated_at and updated_at >= (candidate + timedelta(minutes=1)):
        candidate += timedelta(days=7)

    while last_run_at and candidate <= last_run_at:
        candidate += timedelta(days=7)

    return candidate


def _coerce_pulls_limits_for_storage(raw: dict[str, int | None] | None) -> dict[str, int] | None:
    if not raw:
        return None
    out: dict[str, int] = {}
    for k, v in raw.items():
        if v is None:
            continue
        try:
            lim = int(v)
        except (TypeError, ValueError):
            continue
        if lim >= 1:
            out[str(k)] = min(_AUTO_PLANNING_CONFIG_PULLS_MAX, lim)
    return out or None


def _pull_limits_from_config_row(row: DirectorAutoPlanningConfig | None) -> tuple[int | None, dict[int, int | None] | None]:
    if not row:
        return None, None
    raw_pl = getattr(row, "pulls_limit", None)
    gpl: int | None = None
    if raw_pl is not None:
        try:
            gpl = int(raw_pl)
        except (TypeError, ValueError):
            gpl = None
        if gpl is not None:
            if gpl < 1:
                gpl = None
            elif gpl > _AUTO_PLANNING_CONFIG_PULLS_MAX:
                gpl = _AUTO_PLANNING_CONFIG_PULLS_MAX
    raw_by = getattr(row, "pulls_limits_by_site", None)
    norm = _normalize_pulls_limits_by_site(raw_by if isinstance(raw_by, dict) else None)
    if norm:
        norm = {sid: (None if v is None else min(_AUTO_PLANNING_CONFIG_PULLS_MAX, max(1, int(v)))) for sid, v in norm.items()}
    return gpl, (norm if norm else None)


def _serialize_auto_planning_config(row: DirectorAutoPlanningConfig | None) -> AutoPlanningConfigOut:
    auto_save_mode = str(getattr(row, "auto_save_mode", "manual") or "manual")
    if auto_save_mode not in ("manual", "director", "shared"):
        auto_save_mode = "manual"
    next_run_at = None
    # Toujours renvoyer la semaine cible pour la barre UI (même תכנון אוטומטי כבוי).
    target_week_iso = _next_week_iso(datetime.now())
    if row and bool(getattr(row, "enabled", False)):
        next_run_dt = _next_effective_run_time(datetime.now(), row)
        next_run_at = int(next_run_dt.timestamp() * 1000)
        target_week_iso = _next_week_iso(next_run_dt)
    raw_plim = getattr(row, "pulls_limit", None) if row else None
    pulls_limit_out: int | None = None
    if raw_plim is not None:
        try:
            pulls_limit_out = int(raw_plim)
        except Exception:
            pulls_limit_out = None
        if pulls_limit_out is not None:
            if pulls_limit_out < 1:
                pulls_limit_out = None
            else:
                pulls_limit_out = min(_AUTO_PLANNING_CONFIG_PULLS_MAX, pulls_limit_out)
    raw_by_site = getattr(row, "pulls_limits_by_site", None) if row else None
    pulls_limits_by_site_out: dict[str, int] | None = None
    if isinstance(raw_by_site, dict) and raw_by_site:
        tmp: dict[str, int] = {}
        for k, v in raw_by_site.items():
            try:
                lim = int(v) if v is not None else None
            except Exception:
                continue
            if lim is not None and lim >= 1:
                tmp[str(int(k)) if str(k).lstrip("-").isdigit() else str(k)] = min(_AUTO_PLANNING_CONFIG_PULLS_MAX, lim)
        pulls_limits_by_site_out = tmp or None

    return AutoPlanningConfigOut(
        enabled=bool(getattr(row, "enabled", False)),
        day_of_week=int(getattr(row, "day_of_week", 0) or 0),
        hour=int(getattr(row, "hour", 9) or 0),
        minute=int(getattr(row, "minute", 0) or 0),
        auto_pulls_enabled=bool(getattr(row, "auto_pulls_enabled", False)),
        auto_save_mode=auto_save_mode,
        pulls_limit=pulls_limit_out,
        pulls_limits_by_site=pulls_limits_by_site_out,
        last_run_week_iso=getattr(row, "last_run_week_iso", None),
        last_run_at=getattr(row, "last_run_at", None),
        last_error=getattr(row, "last_error", None),
        next_run_at=next_run_at,
        target_week_iso=target_week_iso,
    )


def _single_site_candidate_sort_key(
    site: Site,
    assignments: dict | None,
    week_iso: str,
    pulls: dict | None = None,
    pulls_prefer: object | None = None,
) -> tuple[int, int, int, int, int]:
    summary = _summarize_auto_planning_result(
        site,
        assignments if isinstance(assignments, dict) else {},
        week_iso,
        "candidate-rank",
        pulls=pulls if isinstance(pulls, dict) else None,
    )
    assigned = int(summary.get("assigned_count") or 0)
    required = int(summary.get("required_count") or 0)
    holes = max(0, required - assigned)
    split_count = _count_split_day_same_worker_patterns(site.config or {}, assignments)
    pulls_map = pulls if isinstance(pulls, dict) else None
    # Moins de trous, puis plus de משיכות préférées, puis plus de משיכות.
    return (
        holes,
        -_preferred_pulls_count(pulls_map, pulls_prefer),
        -_pulls_count(pulls_map),
        -assigned,
        split_count,
    )


def _should_hold_plan_until_pull_target(
    site: Site,
    assignments: dict | None,
    week_iso: str,
    pulls: dict | None,
    pulls_limit: int | None,
    pulls_prefer: object | None = None,
) -> bool:
    """True = ne pas émettre encore comme base (trous restants et < N / sans משיכה préférée)."""
    summary = _summarize_auto_planning_result(
        site,
        assignments if isinstance(assignments, dict) else {},
        week_iso,
        "hold-base",
        pulls=pulls if isinstance(pulls, dict) else None,
    )
    holes = max(0, int(summary.get("required_count") or 0) - int(summary.get("assigned_count") or 0))
    if holes <= 0:
        return False
    pulls_map = pulls if isinstance(pulls, dict) else None
    if pulls_limit is not None and _pulls_count(pulls_map) < int(pulls_limit):
        return True
    if _normalize_pulls_prefer(pulls_prefer) and _preferred_pulls_count(pulls_map, pulls_prefer) <= 0:
        return True
    return False


def _boost_generation_budget_for_pulls(
    time_limit_seconds: int,
    num_alternatives: int,
) -> tuple[int, int]:
    # Les plannings avec משיכות ont plus de combinaisons valides à explorer.
    return max(int(time_limit_seconds), 20), max(int(num_alternatives), 80)


def _clamp_generation_budget(
    time_limit_seconds: int,
    num_alternatives: int,
    *,
    linked: bool,
) -> tuple[int, int]:
    """Temporary high caps while the app is single-user: keep searching so 500 alternatives survive UI filters."""
    if linked:
        return (
            max(10, min(int(time_limit_seconds), 120)),
            max(1, min(int(num_alternatives), 20000)),
        )
    return (
        max(6, min(int(time_limit_seconds), 120)),
        max(1, min(int(num_alternatives), 20000)),
    )


def _summarize_auto_planning_result(
    site: Site,
    assignments: dict | None,
    week_iso: str,
    source: str,
    error: str | None = None,
    pulls: dict | None = None,
) -> dict:
    from ..ai_solver import build_capacities_from_config

    days, shifts, stations = build_capacities_from_config(site.config or {})
    total_required = 0
    for t_idx, st in enumerate(stations):
        cap_map = (st.get("capacity") or {})
        for day_key in days:
            for shift_name in shifts:
                total_required += int((cap_map.get(day_key, {}) or {}).get(shift_name, 0) or 0)

    total_assigned = 0
    assignments_map = assignments or {}
    if isinstance(assignments_map, dict):
        for day_key in days:
            shifts_map = assignments_map.get(day_key) or {}
            if not isinstance(shifts_map, dict):
                continue
            for shift_name in shifts:
                per_station = shifts_map.get(shift_name) or []
                if not isinstance(per_station, list):
                    continue
                for t_idx in range(len(stations)):
                    cell = per_station[t_idx] if t_idx < len(per_station) else []
                    if isinstance(cell, list):
                        total_assigned += len([nm for nm in cell if str(nm or "").strip()])
    # Une משיכה ajoute ~2 noms pour 1 créneau : on retire len(pulls) pour obtenir
    # le remplissage effectif (שיבוצים pleins + créneaux couverts par משיכה).
    pulls_n = _pulls_count(pulls if isinstance(pulls, dict) else None)
    if pulls_n:
        total_assigned = max(0, total_assigned - pulls_n)

    complete = (error is None) and (total_assigned == total_required)
    return {
        "week_iso": week_iso,
        "ran_at": _now_ms(),
        "source": source,
        "complete": complete,
        "assigned_count": total_assigned,
        "required_count": total_required,
        "error": error,
    }


def _store_site_auto_planning_status(site: Site, summary: dict) -> None:
    cfg = dict(_safe_site_config(getattr(site, "config", None), site_id=getattr(site, "id", None)))
    cfg["autoPlanningLastRun"] = summary
    site.config = cfg
    flag_modified(site, "config")


def _mark_auto_planning_week_handled_if_due(
    db: Session,
    director_id: int,
    week_iso: str,
    source: str,
) -> None:
    """Empêche un tick hebdo en retard d'écraser une génération plus récente.

    Si le créneau hebdomadaire prévu pour cette même semaine est déjà passé,
    une génération manuelle/page planning devient le dernier résultat à garder.
    Si le créneau est encore futur, on ne bloque pas le tick: il pourra gagner
    plus tard puisqu'il sera réellement le dernier.
    """
    row = (
        db.query(DirectorAutoPlanningConfig)
        .filter(DirectorAutoPlanningConfig.director_id == director_id)
        .first()
    )
    if not row or not bool(getattr(row, "enabled", False)):
        return
    now = datetime.now()
    next_run_at = _next_effective_run_time(now, row)
    target_week_iso = _next_week_iso(next_run_at)
    if target_week_iso != week_iso or now < next_run_at:
        return
    row.last_run_week_iso = week_iso
    row.last_run_at = _now_ms()
    logger.info(
        "[AUTO-PLANNING] marked week handled by newer manual planning director_id=%s week_iso=%s source=%s next_run_at=%s",
        director_id,
        week_iso,
        source,
        next_run_at.isoformat(),
    )


def _clear_auto_planning_cache_for_director(
    db: Session,
    director_id: int,
    target_week_iso: str,
) -> None:
    """Désactivation du תכנון אוטומטי: purge cache auto hebdo (semaine cible suivante)."""
    sites = db.query(Site).filter(Site.director_id == director_id).all()
    if not sites:
        return
    site_ids = [int(s.id) for s in sites if getattr(s, "id", None)]
    if site_ids:
        auto_rows = (
            db.query(SiteWeekPlan)
            .filter(SiteWeekPlan.site_id.in_(site_ids))
            .filter(SiteWeekPlan.week_iso == target_week_iso)
            .filter(SiteWeekPlan.scope == "auto")
            .all()
        )
        for row in auto_rows:
            db.delete(row)
    for site in sites:
        cfg = dict(site.config or {})
        if "autoPlanningLastRun" not in cfg:
            continue
        cfg.pop("autoPlanningLastRun", None)
        site.config = cfg
        flag_modified(site, "config")


def _generate_director_week_plan_payload(
    db: Session,
    site: Site,
    week_iso: str,
    auto_pulls_enabled: bool = False,
    pulls_limit: int | None = None,
) -> dict:
    rows = [
        row
        for row in db.query(SiteWorker).filter(SiteWorker.site_id == site.id).all()
        if not bool(getattr(row, "pending_approval", False)) and _site_worker_visible_for_week(row, week_iso)
    ]
    weekly_row = (
        db.query(SiteWeeklyAvailability)
        .filter(SiteWeeklyAvailability.site_id == site.id)
        .filter(SiteWeeklyAvailability.week_iso == week_iso)
        .first()
    )
    weekly_overrides = (weekly_row.availability or {}) if weekly_row else {}
    workers = _build_solver_workers(rows, weekly_overrides, week_iso=week_iso)
    workers = _apply_site_event_locks_to_solver_workers(
        db, int(site.id), week_iso, site.config or {}, workers
    )
    start_dt = datetime.fromisoformat(week_iso)
    end_dt = start_dt + timedelta(days=6)

    def _count_assignments(assignments_value: dict | None) -> int:
        total = 0
        if not isinstance(assignments_value, dict):
            return total
        for shifts_map in assignments_value.values():
            if not isinstance(shifts_map, dict):
                continue
            for per_station in shifts_map.values():
                if not isinstance(per_station, list):
                    continue
                for cell in per_station:
                    if isinstance(cell, list):
                        total += len([nm for nm in cell if str(nm or "").strip()])
        return total

    def make_payload(assignments_value: dict) -> dict:
        return {
            "siteId": int(site.id),
            "week": {
                "startISO": week_iso,
                "endISO": end_dt.date().isoformat(),
                "label": f"{week_iso} — {end_dt.date().isoformat()}",
            },
            "isManual": False,
            "assignments": assignments_value,
            "pulls": {},
            "workers": _build_worker_snapshots(rows),
        }

    from ..ai_solver import build_capacities_from_config

    days, shifts, stations = build_capacities_from_config(site.config or {})
    required_total = sum(
        int(((st.get("capacity") or {}).get(day_key, {}) or {}).get(shift_name, 0) or 0)
        for st in stations
        for day_key in days
        for shift_name in shifts
    )
    available_pairs = sum(
        len(shifts_list or [])
        for worker in workers
        for shifts_list in ((worker.get("availability") or {}).values())
        if isinstance(shifts_list, list)
    )
    workers_with_availability = sum(
        1
        for worker in workers
        if any(isinstance(v, list) and len(v) > 0 for v in (worker.get("availability") or {}).values())
    )
    logger.info(
        "[AUTO-PLANNING] build solver input site_id=%s site_name=%s week=%s visible_workers=%s solver_workers=%s weekly_override_workers=%s workers_with_availability=%s available_pairs=%s required=%s days=%s shifts=%s stations=%s",
        site.id,
        site.name,
        week_iso,
        len(rows),
        len(workers),
        len(weekly_overrides) if isinstance(weekly_overrides, dict) else 0,
        workers_with_availability,
        available_pairs,
        required_total,
        len(days),
        len(shifts),
        len(stations),
    )

    if not workers:
        assignments = {day: {sh: [[] for _ in stations] for sh in shifts} for day in days}
        payload = make_payload(assignments)
        if auto_pulls_enabled:
            payload = _apply_auto_pulls_to_payload(site, rows, payload, pulls_limit=pulls_limit)
        return payload

    auto_pulls_time_limit, auto_pulls_num_alts = _boost_generation_budget_for_pulls(25, 20)

    result = solve_schedule(
        site.config or {},
        workers,
        time_limit_seconds=auto_pulls_time_limit if auto_pulls_enabled else 25,
        max_nights_per_worker=_site_max_nights_per_worker(site.config),
        num_alternatives=auto_pulls_num_alts if auto_pulls_enabled else 1,
        fixed_assignments=None,
        exclude_days=None,
    )
    raw_assignments = result.get("assignments") if isinstance(result.get("assignments"), dict) else {}
    logger.info(
        "[AUTO-PLANNING] solver result site_id=%s site_name=%s week=%s status=%s raw_assigned=%s required=%s alternatives=%s",
        site.id,
        site.name,
        week_iso,
        result.get("status"),
        _count_assignments(raw_assignments),
        required_total,
        len(result.get("alternatives") or []),
    )

    if not auto_pulls_enabled:
        cleaned_base_assignments = _enforce_role_requirements_on_assignments(
            site.config or {},
            raw_assignments,
            rows,
        )
        logger.info(
            "[AUTO-PLANNING] cleaned solver result site_id=%s site_name=%s week=%s cleaned_assigned=%s required=%s",
            site.id,
            site.name,
            week_iso,
            _count_assignments(cleaned_base_assignments),
            required_total,
        )
        return make_payload(cleaned_base_assignments)

    candidate_assignments: list[dict] = [
        _enforce_role_requirements_on_assignments(
            site.config or {},
            raw_assignments,
            rows,
        )
    ]
    for alt in (result.get("alternatives") or []):
        if isinstance(alt, dict):
            candidate_assignments.append(
                _enforce_role_requirements_on_assignments(site.config or {}, alt, rows),
            )

    best_payload: dict | None = None
    best_key: tuple[int, ...] | None = None
    best_idx = 0

    for idx, candidate in enumerate(candidate_assignments):
        candidate_payload = make_payload(candidate)
        candidate_payload = _apply_auto_pulls_to_payload(site, rows, candidate_payload, pulls_limit=pulls_limit)
        candidate_key = _single_site_candidate_sort_key(
            site,
            candidate_payload.get("assignments") if isinstance(candidate_payload.get("assignments"), dict) else {},
            week_iso,
            candidate_payload.get("pulls") if isinstance(candidate_payload.get("pulls"), dict) else {},
        )
        if best_key is None or candidate_key < best_key:
            best_key = candidate_key
            best_payload = candidate_payload
            best_idx = idx

    if best_payload is not None:
        logger.info(
            "[AUTO-PLANNING] selected best alternative with pulls site_id=%s site_name=%s candidate_idx=%s holes=%s assigned=%s pulls=%s candidates=%s",
            site.id,
            site.name,
            best_idx,
            best_key[0] if best_key else None,
            -best_key[1] if best_key else None,
            best_key[2] if best_key else None,
            len(candidate_assignments),
        )
        return best_payload

    assignments = result["assignments"]
    payload = make_payload(assignments)
    if auto_pulls_enabled:
        payload = _apply_auto_pulls_to_payload(site, rows, payload, pulls_limit=pulls_limit)
    return payload


def _run_auto_planning_for_director(
    db: Session,
    director_id: int,
    target_week_iso: str,
    source: str = "auto",
    auto_pulls_enabled: bool = False,
    auto_save_mode: str = "manual",
    pulls_limit: int | None = None,
    pulls_limits_by_site: dict[int, int | None] | None = None,
) -> tuple[int, list[str]]:
    slot_token = _acquire_generation_slot(
        kind="auto-planning",
        director_id=int(director_id),
        site_id=None,
        linked=False,
        generation_id=None,
        wait_timeout_seconds=float(os.getenv("PLANNING_AUTO_WAIT_TIMEOUT_SECONDS", "300") or "300"),
    )
    if slot_token is None:
        detail = _generation_busy_detail(int(director_id))
        logger.warning("[AUTO-PLANNING] skipped director_id=%s reason=busy detail=%s", director_id, detail)
        return 0, [detail]

    sites = db.query(Site).filter(Site.director_id == director_id).all()
    errors: list[str] = []
    success_count = 0
    sites_by_id: dict[int, Site] = {int(site.id): site for site in sites}
    cluster_map = _linked_site_cluster_map_for_director(db, director_id)
    processed_site_ids: set[int] = set()
    logger.info(
        "[AUTO-PLANNING] run start director_id=%s source=%s target_week=%s sites=%s",
        director_id,
        source,
        target_week_iso,
        len(sites),
    )

    def _persist_generated_payload(site: Site, payload: dict) -> None:
        nonlocal success_count
        summary = _summarize_auto_planning_result(
            site,
            payload.get("assignments"),
            target_week_iso,
            source,
            pulls=payload.get("pulls") if isinstance(payload.get("pulls"), dict) else None,
        )
        assigned_count = int(summary.get("assigned_count") or 0)
        required_count = int(summary.get("required_count") or 0)
        if required_count > 0 and assigned_count <= 0:
            detail = f"auto planning produced empty plan for site {site.name} ({assigned_count}/{required_count})"
            logger.warning(
                "[AUTO-PLANNING] refusing empty generated plan director_id=%s site_id=%s site_name=%s target_week=%s source=%s required=%s assigned=%s",
                director_id,
                site.id,
                site.name,
                target_week_iso,
                source,
                required_count,
                assigned_count,
            )
            stale_auto_rows = (
                db.query(SiteWeekPlan)
                .filter(SiteWeekPlan.site_id == int(site.id))
                .filter(SiteWeekPlan.week_iso == target_week_iso)
                .filter(SiteWeekPlan.scope == "auto")
                .all()
            )
            for stale_row in stale_auto_rows:
                db.delete(stale_row)
            _store_site_auto_planning_status(
                site,
                _summarize_auto_planning_result(
                    site,
                    None,
                    target_week_iso,
                    source,
                    detail,
                    pulls=payload.get("pulls") if isinstance(payload.get("pulls"), dict) else None,
                ),
            )
            errors.append(f"{site.name}: {detail}")
            return
        logger.info(
            "[AUTO-PLANNING] persist generated plan director_id=%s site_id=%s site_name=%s target_week=%s source=%s assigned=%s required=%s pulls=%s complete=%s",
            director_id,
            site.id,
            site.name,
            target_week_iso,
            source,
            assigned_count,
            required_count,
            len(payload.get("pulls") or {}) if isinstance(payload.get("pulls"), dict) else 0,
            bool(summary.get("complete")),
        )
        # ידני : toujours טיוטת `auto` (visible dans le planning) — pas de promotion director/shared sans choix explicite.
        save_mode = str(auto_save_mode or "manual").strip()
        target_scope = "auto"
        if bool(summary.get("complete")) and save_mode in ("director", "shared"):
            target_scope = save_mode
        _save_site_week_plan(db, int(site.id), target_week_iso, target_scope, payload)
        _store_site_auto_planning_status(site, summary)
        success_count += 1

    try:
        for site in sites:
            site_id_int = int(site.id)
            if site_id_int in processed_site_ids:
                continue
            linked_ids = [int(x) for x in (cluster_map.get(site_id_int) or []) if int(x) in sites_by_id]
            # Multi-sites: une seule ריצה solver par groupe lié, puis split des plans par site.
            if len(linked_ids) > 1:
                root_site_id = min(linked_ids)
                try:
                    logger.info(
                        "[AUTO-PLANNING] multi-site group start director_id=%s root_site_id=%s group_size=%s target_week=%s source=%s",
                        director_id,
                        root_site_id,
                        len(linked_ids),
                        target_week_iso,
                        source,
                    )
                    generated = _generate_multi_site_memory_plans(
                        db,
                        director_id,
                        root_site_id,
                        target_week_iso,
                        num_alternatives=20 if auto_pulls_enabled else 1,
                    )
                    site_plans = generated.get("site_plans") if isinstance(generated, dict) else {}
                    if not isinstance(site_plans, dict):
                        site_plans = {}
                    site_plans = _enforce_linked_global_caps_on_site_plans(
                        db,
                        linked_ids,
                        target_week_iso,
                        site_plans,
                    )
                    if auto_pulls_enabled:
                        site_plans = _apply_auto_pulls_to_site_plans(
                            db,
                            {sid: s for sid, s in sites_by_id.items() if sid in linked_ids},
                            site_plans,
                            pulls_limit=pulls_limit,
                            pulls_limits_by_site=pulls_limits_by_site,
                        )
                        site_plans = _enforce_linked_global_caps_on_site_plans(
                            db,
                            linked_ids,
                            target_week_iso,
                            site_plans,
                        )
                    for linked_sid in linked_ids:
                        linked_site = sites_by_id.get(linked_sid)
                        if not linked_site:
                            continue
                        site_payload = site_plans.get(str(linked_sid)) or site_plans.get(linked_sid)
                        if not isinstance(site_payload, dict):
                            raise RuntimeError(f"missing generated plan for linked site {linked_sid}")
                        _persist_generated_payload(linked_site, site_payload)
                        processed_site_ids.add(linked_sid)
                    db.commit()
                    logger.info(
                        "[AUTO-PLANNING] multi-site group success director_id=%s root_site_id=%s group_size=%s target_week=%s source=%s",
                        director_id,
                        root_site_id,
                        len(linked_ids),
                        target_week_iso,
                        source,
                    )
                except Exception as exc:
                    logger.exception(
                        "[AUTO-PLANNING] multi-site group failed director_id=%s root_site_id=%s",
                        director_id,
                        root_site_id,
                    )
                    for linked_sid in linked_ids:
                        linked_site = sites_by_id.get(linked_sid)
                        if not linked_site:
                            continue
                        _store_site_auto_planning_status(
                            linked_site,
                            _summarize_auto_planning_result(linked_site, None, target_week_iso, source, str(exc)),
                        )
                        processed_site_ids.add(linked_sid)
                    db.commit()
                    errors.append(f"multi-site group {root_site_id}: {exc}")
                continue

            try:
                logger.info(
                    "[AUTO-PLANNING] site start director_id=%s site_id=%s site_name=%s target_week=%s source=%s",
                    director_id,
                    site.id,
                    site.name,
                    target_week_iso,
                    source,
                )
                site_pulls_limit = _effective_auto_pulls_limit_for_site(int(site.id), pulls_limit, pulls_limits_by_site)
                payload = _generate_director_week_plan_payload(
                    db,
                    site,
                    target_week_iso,
                    auto_pulls_enabled=auto_pulls_enabled,
                    pulls_limit=site_pulls_limit,
                )
                _persist_generated_payload(site, payload)
                db.commit()
                logger.info(
                    "[AUTO-PLANNING] site success director_id=%s site_id=%s site_name=%s target_week=%s source=%s",
                    director_id,
                    site.id,
                    site.name,
                    target_week_iso,
                    source,
                )
                processed_site_ids.add(site_id_int)
            except Exception as exc:
                logger.exception("[AUTO-PLANNING] Failed for director=%s site=%s", director_id, site.id)
                _store_site_auto_planning_status(
                    site,
                    _summarize_auto_planning_result(site, None, target_week_iso, source, str(exc)),
                )
                processed_site_ids.add(site_id_int)
                db.commit()
                errors.append(f"{site.name}: {exc}")
        logger.info(
            "[AUTO-PLANNING] run end director_id=%s source=%s target_week=%s success_sites=%s errors=%s",
            director_id,
            source,
            target_week_iso,
            success_count,
            len(errors),
        )
        return success_count, errors
    finally:
        _release_generation_slot(slot_token)


def compute_auto_planning_scheduler_sleep_seconds(
    db: Session,
    *,
    idle_recheck_seconds: int,
    now: datetime | None = None,
) -> int:
    """Délai avant le prochain réveil du scheduler (0 = exécuter le tick maintenant)."""
    idle = max(60, int(idle_recheck_seconds or 3600))
    now = now or datetime.now()
    configs = (
        db.query(DirectorAutoPlanningConfig)
        .filter(DirectorAutoPlanningConfig.enabled == True)
        .all()
    )
    if not configs:
        return idle

    earliest_wake: float | None = None
    for config in configs:
        next_run_at = _next_effective_run_time(now, config)
        if now >= next_run_at:
            target_week_iso = _next_week_iso(next_run_at)
            if (config.last_run_week_iso or "").strip() != target_week_iso:
                return 0
            continue
        delta = (next_run_at - now).total_seconds()
        if earliest_wake is None or delta < earliest_wake:
            earliest_wake = delta

    if earliest_wake is None:
        return idle
    if earliest_wake <= 60:
        return 0
    return min(int(earliest_wake), idle)


def process_auto_planning_tick(db: Session) -> None:
    now = datetime.now()
    configs = db.query(DirectorAutoPlanningConfig).filter(DirectorAutoPlanningConfig.enabled == True).all()
    logger.info("[AUTO-PLANNING] tick start now=%s enabled_configs=%s", now.isoformat(), len(configs))
    for config in configs:
        next_run_at = _next_effective_run_time(now, config)
        logger.info(
            "[AUTO-PLANNING] tick inspect director_id=%s enabled=%s scheduled_day=%s scheduled_time=%02d:%02d next_run_at=%s last_run_week=%s last_run_at=%s",
            config.director_id,
            config.enabled,
            config.day_of_week,
            config.hour,
            config.minute,
            next_run_at.isoformat(),
            config.last_run_week_iso,
            config.last_run_at,
        )
        if now < next_run_at:
            logger.info(
                "[AUTO-PLANNING] tick skip director_id=%s reason=before_next_run now=%s next_run_at=%s",
                config.director_id,
                now.isoformat(),
                next_run_at.isoformat(),
            )
            continue
        target_week_iso = _next_week_iso(next_run_at)
        if (config.last_run_week_iso or "").strip() == target_week_iso:
            logger.info(
                "[AUTO-PLANNING] tick skip director_id=%s reason=already_ran target_week=%s",
                config.director_id,
                target_week_iso,
            )
            continue

        logger.info(
            "[AUTO-PLANNING] tick trigger director_id=%s target_week=%s now=%s next_run_at=%s",
            config.director_id,
            target_week_iso,
            now.isoformat(),
            next_run_at.isoformat(),
        )
        gpl, by_site = _pull_limits_from_config_row(config)
        _, errors = _run_auto_planning_for_director(
            db,
            config.director_id,
            target_week_iso,
            "scheduled",
            auto_pulls_enabled=bool(getattr(config, "auto_pulls_enabled", False)),
            auto_save_mode=str(getattr(config, "auto_save_mode", "manual") or "manual"),
            pulls_limit=gpl,
            pulls_limits_by_site=by_site,
        )
        if _is_generation_busy_error(errors):
            logger.warning(
                "[AUTO-PLANNING] tick postpone director_id=%s target_week=%s reason=busy",
                config.director_id,
                target_week_iso,
            )
            config.last_error = "\n".join(errors)[:1000] if errors else None
            db.commit()
            continue
        config.last_run_week_iso = target_week_iso
        config.last_run_at = _now_ms()
        config.last_error = "\n".join(errors)[:1000] if errors else None
        db.commit()
        logger.info(
            "[AUTO-PLANNING] tick commit director_id=%s target_week=%s last_error=%s",
            config.director_id,
            target_week_iso,
            config.last_error,
        )
    logger.info("[AUTO-PLANNING] tick end now=%s", now.isoformat())


@router.get("/settings/auto-planning", response_model=AutoPlanningConfigOut)
def get_auto_planning_config(
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    row = (
        db.query(DirectorAutoPlanningConfig)
        .filter(DirectorAutoPlanningConfig.director_id == user.id)
        .first()
    )
    return _serialize_auto_planning_config(row)


@router.put("/settings/auto-planning", response_model=AutoPlanningConfigOut)
def put_auto_planning_config(
    payload: AutoPlanningConfigPayload,
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    previous_enabled: bool | None = None
    row = (
        db.query(DirectorAutoPlanningConfig)
        .filter(DirectorAutoPlanningConfig.director_id == user.id)
        .first()
    )
    now = _now_ms()
    if not row:
        row = DirectorAutoPlanningConfig(
            director_id=user.id,
            enabled=payload.enabled,
            day_of_week=payload.day_of_week,
            hour=payload.hour,
            minute=payload.minute,
            auto_pulls_enabled=payload.auto_pulls_enabled,
            auto_save_mode=payload.auto_save_mode,
            pulls_limit=payload.pulls_limit,
            pulls_limits_by_site=_coerce_pulls_limits_for_storage(payload.pulls_limits_by_site),
            updated_at=now,
        )
        db.add(row)
    else:
        previous_enabled = bool(getattr(row, "enabled", False))
        row.enabled = payload.enabled
        row.day_of_week = payload.day_of_week
        row.hour = payload.hour
        row.minute = payload.minute
        row.auto_pulls_enabled = payload.auto_pulls_enabled
        row.auto_save_mode = payload.auto_save_mode
        row.pulls_limit = payload.pulls_limit
        row.pulls_limits_by_site = _coerce_pulls_limits_for_storage(payload.pulls_limits_by_site)
        row.updated_at = now
    # Toute modification de créneau redéfinit le prochain déclenchement planifié.
    row.last_run_week_iso = None
    row.last_run_at = None
    if (previous_enabled is True) and (payload.enabled is False):
        target_week_iso = _next_week_iso(datetime.now())
        _clear_auto_planning_cache_for_director(db, int(user.id), target_week_iso)
    db.commit()
    db.refresh(row)
    return _serialize_auto_planning_config(row)


@router.post("/settings/auto-planning/test-now")
def test_auto_planning_now(
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    row = (
        db.query(DirectorAutoPlanningConfig)
        .filter(DirectorAutoPlanningConfig.director_id == user.id)
        .first()
    )
    target_week_iso = _next_week_iso(datetime.now())
    logger.info(
        "[AUTO-PLANNING] manual test trigger director_id=%s target_week=%s",
        user.id,
        target_week_iso,
    )
    if not row:
        row = DirectorAutoPlanningConfig(
            director_id=user.id,
            enabled=False,
            day_of_week=0,
            hour=9,
            minute=0,
            auto_pulls_enabled=False,
            auto_save_mode="manual",
            updated_at=_now_ms(),
        )
        db.add(row)
    gpl, by_site = _pull_limits_from_config_row(row)
    success_count, errors = _run_auto_planning_for_director(
        db,
        user.id,
        target_week_iso,
        "manual-test",
        auto_pulls_enabled=bool(getattr(row, "auto_pulls_enabled", False)),
        auto_save_mode=str(getattr(row, "auto_save_mode", "manual") or "manual"),
        pulls_limit=gpl,
        pulls_limits_by_site=by_site,
    )
    # Si le créneau hebdo est déjà passé pour cette semaine, la ריצה ידני devient
    # le dernier résultat à garder et ne doit pas être écrasée par un tick en retard.
    _mark_auto_planning_week_handled_if_due(db, int(user.id), target_week_iso, "manual-test")
    row.last_error = "\n".join(errors)[:1000] if errors else None
    db.commit()
    db.refresh(row)
    return {
        "ok": len(errors) == 0,
        "target_week_iso": target_week_iso,
        "generated_sites": success_count,
        "errors": errors,
        "config": _serialize_auto_planning_config(row).model_dump(),
    }



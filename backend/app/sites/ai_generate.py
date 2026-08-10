from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Body, Response
from starlette.requests import Request
from fastapi.responses import StreamingResponse
import asyncio
from sqlalchemy import func, or_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
import json
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
from ..ai_solver import solve_schedule
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
    _acquire_generation_slot,
    _preempt_director_generation_slots, _generation_slot_or_wait,
)

logger = logging.getLogger("ai_solver")

from .solver_bridge import (
    _build_solver_workers, _resolve_max_nights_per_worker,
    _site_max_nights_per_worker,
)
from .pulls import (
    _apply_auto_pulls_to_payload, _enforce_role_requirements_on_assignments,
    _apply_auto_pulls_to_site_plans, _enforce_role_requirements_on_site_plans,
    _normalize_pulls_limits_by_site, _planning_limit_error_detail_for_request,
    _site_pulls_limit_matches, _matches_pulls_limit, _pulls_count,
    _sanitize_pulls_map, _planning_limit_error_detail,
)
from .linked_sites import (
    _build_multi_site_generation_context, _enforce_linked_global_caps_on_site_plans,
    _generate_multi_site_memory_plans,
    _connected_site_ids_for_root, _linked_site_cluster_map_for_director,
)
from .auto_planning import (
    _boost_generation_budget_for_pulls, _clamp_generation_budget,
    _single_site_candidate_sort_key, _summarize_auto_planning_result,
)
from .events import _apply_site_event_locks_to_solver_workers
from .week_plans import _save_site_week_plan
from .ai_generate_sse import (
    AI_GENERATE_SSE_HEADERS,
    LinkedGenerationStreamParams,
    SingleGenerationStreamParams,
    apply_linked_stream_body_overrides,
    linked_generation_sse_stream,
    parse_single_stream_payload,
    single_generation_sse_stream,
)

router = APIRouter()

@router.post("/{site_id}/ai-generate-linked")
def ai_generate_linked_planning(
    site_id: int,
    payload: AIPlanningRequest = Body(default=AIPlanningRequest()),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    week_iso = _validate_week_iso(payload.week_iso) if payload and payload.week_iso else _next_week_iso(datetime.now())
    eff_time, eff_num_alts = _clamp_generation_budget(
        int(payload.time_limit_seconds or 20),
        int(payload.num_alternatives or 40),
        linked=True,
    )
    if payload and payload.auto_pulls_enabled:
        eff_time, eff_num_alts = _boost_generation_budget_for_pulls(eff_time, eff_num_alts)
        eff_time, eff_num_alts = _clamp_generation_budget(eff_time, eff_num_alts, linked=True)
    with _generation_slot_or_wait(
        kind="linked-sync",
        director_id=int(user.id),
        site_id=int(site_id),
        linked=True,
        wait_timeout_seconds=_generation_request_wait_timeout_seconds(),
    ):
        result = _generate_multi_site_memory_plans(
            db,
            user.id,
            site_id,
            week_iso,
            weekly_availability=(payload.weekly_availability or {}) if payload else None,
            exclude_days=payload.exclude_days if payload else None,
            fixed_assignments=payload.fixed_assignments if payload else None,
            time_limit_seconds=eff_time,
            num_alternatives=eff_num_alts,
        )
    pulls_limits_by_site = _normalize_pulls_limits_by_site(payload.pulls_limits_by_site if payload else None)
    if payload and payload.auto_pulls_enabled:
        context = _build_multi_site_generation_context(
            db,
            user.id,
            site_id,
            week_iso,
            weekly_availability=(payload.weekly_availability or {}) if payload else None,
            exclude_days=payload.exclude_days if payload else None,
            fixed_assignments=payload.fixed_assignments if payload else None,
        )
        result["site_plans"] = _enforce_linked_global_caps_on_site_plans(
            db,
            context["connected_site_ids"],
            week_iso,
            result.get("site_plans") or {},
        )
        result["site_plans"] = _apply_auto_pulls_to_site_plans(
            db,
            context["sites_by_id"],
            result.get("site_plans") or {},
            pulls_limit=payload.pulls_limit if payload else None,
            pulls_limits_by_site=pulls_limits_by_site or None,
        )
        result["site_plans"] = _enforce_linked_global_caps_on_site_plans(
            db,
            context["connected_site_ids"],
            week_iso,
            result.get("site_plans") or {},
        )
        pulls_limit = int(payload.pulls_limit) if payload and payload.pulls_limit is not None else None
        if payload.auto_pulls_enabled:
            site_plans = result.get("site_plans") or {}
            candidate_count = 1 + max((len(site_plan.get("alternatives") or []) for site_plan in site_plans.values()), default=0)
            accepted_indices: list[int] = []
            for candidate_idx in range(candidate_count):
                matches_all_sites = True
                for site_key, site_plan in site_plans.items():
                    current_site_id = int(site_key)
                    if candidate_idx == 0:
                        candidate_pulls = site_plan.get("pulls") if isinstance(site_plan.get("pulls"), dict) else {}
                    else:
                        alt_pulls_list = site_plan.get("alternative_pulls") or []
                        candidate_pulls = (alt_pulls_list[candidate_idx - 1] or {}) if candidate_idx - 1 < len(alt_pulls_list) else None
                    if not _site_pulls_limit_matches(
                        current_site_id,
                        candidate_pulls if isinstance(candidate_pulls, dict) else {},
                        default_pulls_limit=pulls_limit,
                        pulls_limits_by_site=pulls_limits_by_site or None,
                    ):
                        matches_all_sites = False
                        break
                if matches_all_sites:
                    accepted_indices.append(candidate_idx)
            if not accepted_indices:
                raise HTTPException(
                    status_code=422,
                    detail=_planning_limit_error_detail_for_request(
                        pulls_limit=pulls_limit,
                        pulls_limits_by_site=pulls_limits_by_site or None,
                    ),
                )
            filtered_site_plans: dict[str, dict] = {}
            for site_key, site_plan in site_plans.items():
                next_site_plan = dict(site_plan)
                first_idx = accepted_indices[0]
                if first_idx == 0:
                    next_site_plan["assignments"] = site_plan.get("assignments") or {}
                    next_site_plan["pulls"] = site_plan.get("pulls") if isinstance(site_plan.get("pulls"), dict) else {}
                else:
                    alternatives = site_plan.get("alternatives") or []
                    alternative_pulls = site_plan.get("alternative_pulls") or []
                    next_site_plan["assignments"] = (alternatives[first_idx - 1] or {}) if first_idx - 1 < len(alternatives) else {}
                    next_site_plan["pulls"] = (alternative_pulls[first_idx - 1] or {}) if first_idx - 1 < len(alternative_pulls) else {}
                next_site_plan["alternatives"] = []
                next_site_plan["alternative_pulls"] = []
                for candidate_idx in accepted_indices[1:]:
                    if candidate_idx == 0:
                        next_site_plan["alternatives"].append(site_plan.get("assignments") or {})
                        next_site_plan["alternative_pulls"].append(site_plan.get("pulls") if isinstance(site_plan.get("pulls"), dict) else {})
                    else:
                        alternatives = site_plan.get("alternatives") or []
                        alternative_pulls = site_plan.get("alternative_pulls") or []
                        if candidate_idx - 1 < len(alternatives):
                            next_site_plan["alternatives"].append(alternatives[candidate_idx - 1] or {})
                            next_site_plan["alternative_pulls"].append((alternative_pulls[candidate_idx - 1] or {}) if candidate_idx - 1 < len(alternative_pulls) else {})
                filtered_site_plans[site_key] = next_site_plan
            result["site_plans"] = filtered_site_plans
    return result


@router.api_route("/{site_id}/ai-generate-linked/stream", methods=["GET", "POST"])
async def ai_generate_linked_planning_stream(
    site_id: int,
    request: Request,
    payload: AIPlanningRequest = Body(default=AIPlanningRequest()),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    if request.method == "GET":
        q_num_alternatives = request.query_params.get("num_alternatives")
        q_time_limit_seconds = request.query_params.get("time_limit_seconds")
        q_max_nights_per_worker = request.query_params.get("max_nights_per_worker")
    else:
        q_num_alternatives, q_time_limit_seconds, q_max_nights_per_worker = await apply_linked_stream_body_overrides(
            request, payload
        )

    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")

    eff_time = int(q_time_limit_seconds if q_time_limit_seconds is not None else (payload.time_limit_seconds or 20))
    try:
        q_nights_parsed = int(q_max_nights_per_worker) if q_max_nights_per_worker is not None else None
    except (TypeError, ValueError):
        q_nights_parsed = None
    eff_max_nights = _resolve_max_nights_per_worker(
        site.config,
        payload_value=payload.max_nights_per_worker if payload else None,
        query_value=q_nights_parsed,
    )
    eff_num_alts = int(q_num_alternatives if q_num_alternatives is not None else (payload.num_alternatives or 40))
    if payload and payload.auto_pulls_enabled:
        eff_time, eff_num_alts = _boost_generation_budget_for_pulls(eff_time, eff_num_alts)
    eff_time, eff_num_alts = _clamp_generation_budget(eff_time, eff_num_alts, linked=True)
    eff_pulls_limit = int(payload.pulls_limit) if payload and payload.pulls_limit is not None else None
    eff_pulls_limits_by_site = _normalize_pulls_limits_by_site(payload.pulls_limits_by_site if payload else None)
    week_iso = _validate_week_iso(payload.week_iso) if payload and payload.week_iso else _next_week_iso(datetime.now())
    logger.warning(
        "[PULLS][LINKED_STREAM][REQUEST] site_id=%s week=%s auto_pulls=%s pulls_limit=%s pulls_limits_by_site=%s "
        "num_alternatives=%s time_limit=%s fixed=%s exclude_days=%s weekly_availability_workers=%s",
        site_id,
        week_iso,
        bool(payload.auto_pulls_enabled if payload else False),
        eff_pulls_limit,
        eff_pulls_limits_by_site or None,
        eff_num_alts,
        eff_time,
        bool(payload.fixed_assignments if payload else None),
        payload.exclude_days if payload else None,
        len(payload.weekly_availability or {}) if payload else 0,
    )

    context = _build_multi_site_generation_context(
        db,
        user.id,
        site_id,
        week_iso,
        weekly_availability=(payload.weekly_availability or {}) if payload else None,
        exclude_days=payload.exclude_days if payload else None,
        fixed_assignments=payload.fixed_assignments if payload else None,
    )

    linked_sites = [
        {"id": linked_site_id, "name": context["sites_by_id"][linked_site_id].name}
        for linked_site_id in context["connected_site_ids"]
        if linked_site_id in context["sites_by_id"]
    ]
    generation_id = _new_generation_id()
    logger.warning(
        "[PULLS][LINKED_STREAM][CONTEXT] generation=%s site_id=%s linked_site_ids=%s combined_workers=%s combined_stations=%s",
        generation_id,
        site_id,
        context["connected_site_ids"],
        len(context.get("combined_workers") or []),
        len((context.get("combined_config") or {}).get("stations") or []),
    )

    slot_token = await asyncio.to_thread(
        lambda: (
            _preempt_director_generation_slots(int(user.id), reason="linked-stream-replace"),
            _acquire_generation_slot(
                kind="linked-stream",
                director_id=int(user.id),
                site_id=int(site_id),
                linked=True,
                generation_id=generation_id,
                wait_timeout_seconds=_generation_request_wait_timeout_seconds(),
            ),
        )[1]
    )
    if slot_token is None:
        raise HTTPException(status_code=429, detail=_generation_busy_detail(int(user.id)))

    stream_params = LinkedGenerationStreamParams(
        db=db,
        site_id=int(site_id),
        generation_id=generation_id,
        slot_token=slot_token,
        eff_time=eff_time,
        eff_num_alts=eff_num_alts,
        eff_max_nights=eff_max_nights,
        eff_pulls_limit=eff_pulls_limit,
        eff_pulls_limits_by_site=eff_pulls_limits_by_site,
        payload=payload,
        context=context,
        linked_sites=linked_sites,
        week_iso=week_iso,
    )
    return StreamingResponse(
        linked_generation_sse_stream(stream_params),
        media_type="text/event-stream; charset=utf-8",
        headers=AI_GENERATE_SSE_HEADERS,
    )


@router.post("/{site_id}/ai-generate", response_model=AIPlanningResponse)
def ai_generate_planning(
    site_id: int,
    payload: AIPlanningRequest = Body(default=AIPlanningRequest()),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    week_for_rows = _week_start_date(datetime.now()).date().isoformat()
    if payload and getattr(payload, "week_iso", None):
        try:
            week_for_rows = _validate_week_iso(payload.week_iso)
        except HTTPException:
            pass
    rows = [
        row
        for row in db.query(SiteWorker).filter(SiteWorker.site_id == site_id).all()
        if not bool(getattr(row, "pending_approval", False)) and _site_worker_visible_for_week(row, week_for_rows)
    ]
    overrides = (payload.weekly_availability or {}) if payload else {}
    logger.info(f"[AI-GEN] Weekly availability overrides: {list(overrides.keys())}")
    workers = _build_solver_workers(rows, overrides, week_iso=week_for_rows)
    workers = _apply_site_event_locks_to_solver_workers(
        db, site_id, week_for_rows, site.config or {}, workers
    )
    logger.info(f"[AI-GEN] Loaded {len(workers)} workers: {[w['name'] for w in workers]}")
    for w in workers:
        avail_count = sum(len(shifts) for shifts in w['availability'].values())
        logger.info(f"[AI-GEN] Worker {w['name']}: availability keys={len(w['availability'])}, total shifts={avail_count}, max_shifts={w['max_shifts']}, roles={w['roles']}, shift_kind_prefs={w.get('shift_kind_prefs')}")
    if not workers:
        # Return empty structure with days/shifts from config mapping
        from ..ai_solver import build_capacities_from_config

        days, shifts, stations = build_capacities_from_config(site.config or {})
        return AIPlanningResponse(
            days=days,
            shifts=shifts,
            stations=[st.get("name") for st in stations],
            assignments={day: {sh: [[] for _ in stations] for sh in shifts} for day in days},
            status="NO_WORKERS",
            objective=0.0,
        )
    with _generation_slot_or_wait(
        kind="single-sync",
        director_id=int(user.id),
        site_id=int(site_id),
        linked=False,
        wait_timeout_seconds=_generation_request_wait_timeout_seconds(),
    ):
        result = solve_schedule(
            site.config or {},
            workers,
            time_limit_seconds=_clamp_generation_budget(int(payload.time_limit_seconds or 12), int(payload.num_alternatives or 20), linked=False)[0],
            max_nights_per_worker=_resolve_max_nights_per_worker(
                site.config,
                payload_value=payload.max_nights_per_worker,
            ),
            num_alternatives=_clamp_generation_budget(int(payload.time_limit_seconds or 12), int(payload.num_alternatives or 20), linked=False)[1],
            fixed_assignments=payload.fixed_assignments or None,
            exclude_days=(payload.exclude_days or None),
        )
    base_pulls: dict = {}
    alt_pulls: list[dict] = []
    assignments_out = _enforce_role_requirements_on_assignments(
        site.config or {},
        result.get("assignments") if isinstance(result.get("assignments"), dict) else {},
        rows,
    )
    alternatives_out = [
        _enforce_role_requirements_on_assignments(site.config or {}, alt, rows)
        for alt in (result.get("alternatives") or [])
        if isinstance(alt, dict)
    ]
    if payload.auto_pulls_enabled:
        base_candidate_assignments = _enforce_role_requirements_on_assignments(
            site.config or {},
            result.get("assignments") if isinstance(result.get("assignments"), dict) else {},
            rows,
        )
        base_payload = _apply_auto_pulls_to_payload(
            site,
            rows,
            {"assignments": deepcopy(base_candidate_assignments), "pulls": {}},
            pulls_limit=payload.pulls_limit,
        )
        candidate_pairs: list[tuple[dict, dict]] = []
        base_assignments = base_payload.get("assignments") or {}
        base_pulls = base_payload.get("pulls") or {}
        if _matches_pulls_limit(base_pulls, payload.pulls_limit):
            candidate_pairs.append((base_assignments, base_pulls))
        for alt in (result.get("alternatives") or []):
            if not isinstance(alt, dict):
                continue
            alt_cleaned = _enforce_role_requirements_on_assignments(site.config or {}, alt, rows)
            alt_payload = _apply_auto_pulls_to_payload(
                site,
                rows,
                {"assignments": deepcopy(alt_cleaned), "pulls": {}},
                pulls_limit=payload.pulls_limit,
            )
            current_alt_assignments = alt_payload.get("assignments") or {}
            current_alt_pulls = alt_payload.get("pulls") or {}
            if _matches_pulls_limit(current_alt_pulls, payload.pulls_limit):
                candidate_pairs.append((current_alt_assignments, current_alt_pulls))
        if not candidate_pairs:
            raise HTTPException(status_code=422, detail=_planning_limit_error_detail_for_request(pulls_limit=payload.pulls_limit))
        if candidate_pairs:
            candidate_pairs.sort(
                key=lambda pair: _single_site_candidate_sort_key(site, pair[0], week_for_rows, pair[1]),
            )
            assignments_out = candidate_pairs[0][0]
            base_pulls = candidate_pairs[0][1]
            alternatives_out = [assignments for assignments, _ in candidate_pairs[1:]]
            alt_pulls = [pulls for _, pulls in candidate_pairs[1:]]
    else:
        ordered_candidates = [(assignments_out, {})] + [(alt, {}) for alt in alternatives_out]
        ordered_candidates.sort(
            key=lambda pair: _single_site_candidate_sort_key(site, pair[0], week_for_rows, pair[1]),
        )
        assignments_out = ordered_candidates[0][0]
        alternatives_out = [assignments for assignments, _ in ordered_candidates[1:]]
    return AIPlanningResponse(
        days=result["days"],
        shifts=result["shifts"],
        stations=result["stations"],
        assignments=assignments_out,
        alternatives=alternatives_out,
        pulls=base_pulls,
        alternative_pulls=alt_pulls,
        status=result["status"],
        objective=float(result.get("objective", 0.0)),
    )


@router.api_route("/{site_id}/ai-generate/stream", methods=["GET", "POST"])
async def ai_generate_stream(
    site_id: int,
    request: Request,
    # Allow overriding via query string as EventSource uses GET without body
    q_time_limit_seconds: int | None = Query(default=None, alias="time_limit_seconds"),
    q_max_nights_per_worker: int | None = Query(default=None, alias="max_nights_per_worker"),
    q_num_alternatives: int | None = Query(default=None, alias="num_alternatives"),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    payload = await parse_single_stream_payload(request, AIPlanningRequest())
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    week_for_rows = _week_start_date(datetime.now()).date().isoformat()
    if payload and getattr(payload, "week_iso", None):
        try:
            week_for_rows = _validate_week_iso(payload.week_iso)
        except HTTPException:
            pass
    rows = [
        row
        for row in db.query(SiteWorker).filter(SiteWorker.site_id == site_id).all()
        if not bool(getattr(row, "pending_approval", False)) and _site_worker_visible_for_week(row, week_for_rows)
    ]
    overrides = (payload.weekly_availability or {}) if payload else {}
    logger.info(f"[SSE] Weekly availability overrides: {list(overrides.keys())}")
    workers = _build_solver_workers(rows, overrides, week_iso=week_for_rows)
    workers = _apply_site_event_locks_to_solver_workers(
        db, site_id, week_for_rows, site.config or {}, workers
    )
    logger.info("[SSE] loaded workers=%d for site=%s", len(workers), site_id)
    workers_without_availability = [
        str(w.get("name") or "")
        for w in workers
        if sum(len(shifts) for shifts in (w.get("availability") or {}).values()) == 0
    ]
    if workers_without_availability:
        logger.warning("[SSE] workers without availability site=%s count=%d names=%s", site_id, len(workers_without_availability), workers_without_availability)

    # Choose effective parameters (query > body > config site)
    eff_time = int(q_time_limit_seconds if q_time_limit_seconds is not None else (payload.time_limit_seconds or 10))
    try:
        q_nights_parsed = int(q_max_nights_per_worker) if q_max_nights_per_worker is not None else None
    except (TypeError, ValueError):
        q_nights_parsed = None
    eff_max_nights = _resolve_max_nights_per_worker(
        site.config,
        payload_value=payload.max_nights_per_worker,
        query_value=q_nights_parsed,
    )
    eff_num_alts = int(q_num_alternatives if q_num_alternatives is not None else (payload.num_alternatives or 20))
    if payload.auto_pulls_enabled:
        eff_time, eff_num_alts = _boost_generation_budget_for_pulls(eff_time, eff_num_alts)
    eff_time, eff_num_alts = _clamp_generation_budget(eff_time, eff_num_alts, linked=False)
    eff_pulls_limit = int(payload.pulls_limit) if payload.pulls_limit is not None else None
    generation_id = _new_generation_id()
    logger.info("[SSE] start generation=%s site=%s time_limit=%s max_nights=%s num_alternatives=%s workers=%d", generation_id, site_id, eff_time, eff_max_nights, eff_num_alts, len(workers))

    slot_token = await asyncio.to_thread(
        lambda: (
            _preempt_director_generation_slots(int(user.id), reason="single-stream-replace"),
            _acquire_generation_slot(
                kind="single-stream",
                director_id=int(user.id),
                site_id=int(site_id),
                linked=False,
                generation_id=generation_id,
                wait_timeout_seconds=_generation_request_wait_timeout_seconds(),
            ),
        )[1]
    )
    if slot_token is None:
        raise HTTPException(status_code=429, detail=_generation_busy_detail(int(user.id)))

    stream_params = SingleGenerationStreamParams(
        site=site,
        site_id=int(site_id),
        generation_id=generation_id,
        slot_token=slot_token,
        eff_time=eff_time,
        eff_num_alts=eff_num_alts,
        eff_max_nights=eff_max_nights,
        eff_pulls_limit=eff_pulls_limit,
        payload=payload,
        workers=workers,
        rows=rows,
    )
    return StreamingResponse(
        single_generation_sse_stream(stream_params),
        media_type="text/event-stream; charset=utf-8",
        headers=AI_GENERATE_SSE_HEADERS,
    )



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
    _build_solver_workers, _resolve_max_nights_per_worker,
    _log_single_site_generation_worker_totals, _log_linked_generation_worker_totals,
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
    _generate_multi_site_memory_plans, _split_multi_site_assignments,
    _connected_site_ids_for_root, _linked_site_cluster_map_for_director,
)
from .auto_planning import (
    _boost_generation_budget_for_pulls, _clamp_generation_budget,
    _single_site_candidate_sort_key, _summarize_auto_planning_result,
)
from .events import _apply_site_event_locks_to_solver_workers
from .week_plans import _save_site_week_plan

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
        q_num_alternatives = None
        q_time_limit_seconds = None
        q_max_nights_per_worker = None
        try:
            body = await request.json()
            if isinstance(body, dict):
                q_num_alternatives = body.get("num_alternatives")
                q_time_limit_seconds = body.get("time_limit_seconds")
                q_max_nights_per_worker = body.get("max_nights_per_worker")
                payload.pulls_limits_by_site = body.get("pulls_limits_by_site") if isinstance(body.get("pulls_limits_by_site"), dict) else None
                if body and "weekly_availability" in body:
                    cleaned_wa = {}
                    for worker_name, worker_avail in (body.get("weekly_availability") or {}).items():
                        if isinstance(worker_avail, dict):
                            if "availability" in worker_avail and not any(k in worker_avail for k in ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]):
                                cleaned_wa[worker_name] = worker_avail["availability"]
                            else:
                                cleaned_wa[worker_name] = worker_avail
                    payload.weekly_availability = cleaned_wa if cleaned_wa else None
        except Exception:
            pass

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

    async def event_stream():
        import threading, queue, json, asyncio as _asyncio, time as _time
        # Plus large qu’en mono-site : chaque event multi porte tous les site_plans.
        q: "queue.Queue[dict | None]" = queue.Queue(maxsize=1024)
        released = False
        stop_event = threading.Event()

        def _release_slot_once() -> None:
            nonlocal released
            if released:
                return
            released = True
            _release_generation_slot(slot_token)

        def _producer():
            matched_candidates = 0
            dropped_alternatives = 0
            rejected_candidates = 0
            kept_alternative_signatures: set[str] = set()
            target_kept_alternatives = max(1, int(eff_num_alts))
            kept_alternatives_count = 0
            search_num_alts = _clamp_generation_budget(
                eff_time,
                max(target_kept_alternatives, target_kept_alternatives * 2),
                linked=True,
            )[1]

            def _enqueue(item: dict | None, *, drop_if_full: bool = False) -> None:
                nonlocal dropped_alternatives
                if item is None:
                    q.put(None)
                    return
                payload = dict(item)
                payload.setdefault("generation_id", generation_id)
                payload.setdefault("generated_at_ms", _now_ms())
                if drop_if_full:
                    try:
                        q.put(payload, timeout=0.05)
                    except queue.Full:
                        dropped_alternatives += 1
                    return
                q.put(payload)

            def _pulls_debug_summary(site_plans_value: dict[str, dict] | None) -> dict[str, dict]:
                summary: dict[str, dict] = {}
                for site_key, site_plan in (site_plans_value or {}).items():
                    try:
                        current_site_id = int(site_key)
                    except Exception:
                        current_site_id = 0
                    pulls_value = site_plan.get("pulls") if isinstance(site_plan, dict) else {}
                    summary[str(site_key)] = {
                        "pulls": _pulls_count(pulls_value if isinstance(pulls_value, dict) else {}),
                        "matches": _site_pulls_limit_matches(
                            current_site_id,
                            pulls_value if isinstance(pulls_value, dict) else {},
                            default_pulls_limit=eff_pulls_limit,
                            pulls_limits_by_site=eff_pulls_limits_by_site or None,
                        ),
                    }
                return summary

            try:
                deadline_monotonic = _time.monotonic() + max(1, int(eff_time))
                attempts = 0
                base_sent = False
                logger.warning(
                    "[PULLS][LINKED_STREAM][PRODUCER_START] generation=%s target_alternatives=%s search_num_alts=%s",
                    generation_id,
                    target_kept_alternatives,
                    search_num_alts,
                )

                while kept_alternatives_count < target_kept_alternatives:
                    if stop_event.is_set():
                        logger.warning("[PULLS][LINKED_STREAM][CLIENT_STOP] generation=%s attempt=%s", generation_id, attempts)
                        break
                    remaining_seconds = deadline_monotonic - _time.monotonic()
                    if remaining_seconds <= 0:
                        break
                    attempts += 1
                    attempt_time = max(1, int(remaining_seconds + 0.999))
                    # Diversifie les relances multi-site pour ne pas retomber
                    # systématiquement sur le même sous-ensemble d'alternatives.
                    attempt_random_seed = max(1, int(site_id) * 1000 + attempts * 7919)
                    attempt_search_num_alts = _clamp_generation_budget(
                        attempt_time,
                        max(search_num_alts, target_kept_alternatives * 2),
                        linked=True,
                    )[1]

                    gen = solve_schedule_stream(
                        context["combined_config"],
                        context["combined_workers"],
                        time_limit_seconds=attempt_time,
                        max_nights_per_worker=eff_max_nights,
                        num_alternatives=attempt_search_num_alts,
                        fixed_assignments=context["combined_fixed"],
                        exclude_days=(payload.exclude_days or None),
                        random_seed=attempt_random_seed,
                    )
                    for item in gen:
                        if stop_event.is_set():
                            logger.warning("[PULLS][LINKED_STREAM][CLIENT_STOP] generation=%s attempt=%s", generation_id, attempts)
                            break
                        item_type = item.get("type")
                        if item_type in {"base", "alternative"}:
                            split_site_plans = _split_multi_site_assignments(
                                context,
                                item.get("assignments") if isinstance(item.get("assignments"), dict) else {},
                                status="STREAMING" if item_type == "base" else None,
                                objective=0,
                            )
                            split_site_plans = _enforce_role_requirements_on_site_plans(
                                db,
                                context["sites_by_id"],
                                split_site_plans,
                            )
                            split_site_plans = _enforce_linked_global_caps_on_site_plans(
                                db,
                                context["connected_site_ids"],
                                week_iso,
                                split_site_plans,
                            )
                            if payload and payload.auto_pulls_enabled:
                                split_site_plans = _apply_auto_pulls_to_site_plans(
                                    db,
                                    context["sites_by_id"],
                                    split_site_plans,
                                    pulls_limit=eff_pulls_limit,
                                    pulls_limits_by_site=eff_pulls_limits_by_site or None,
                                )
                                split_site_plans = _enforce_linked_global_caps_on_site_plans(
                                    db,
                                    context["connected_site_ids"],
                                    week_iso,
                                    split_site_plans,
                                )
                            pulls_summary = _pulls_debug_summary(split_site_plans)
                            if payload and payload.auto_pulls_enabled:
                                if not split_site_plans:
                                    rejected_candidates += 1
                                    _enqueue({
                                        "type": "pulls_debug",
                                        "item_type": item_type,
                                        "item_index": item.get("index"),
                                        "accepted": False,
                                        "reason": "empty_site_plans",
                                        "linked": True,
                                        "requested_pulls": eff_pulls_limit,
                                        "pulls_limits_by_site": eff_pulls_limits_by_site or None,
                                        "pulls_summary": {},
                                    }, drop_if_full=True)
                                    logger.warning(
                                        "[PULLS][LINKED_STREAM][REJECT_EMPTY] generation=%s attempt=%s type=%s item_index=%s",
                                        generation_id,
                                        attempts,
                                        item_type,
                                        item.get("index"),
                                    )
                                    continue
                                plans = list(split_site_plans.items())
                                pulls_limit_matches = bool(plans) and all(
                                    _site_pulls_limit_matches(
                                        int(site_key),
                                        site_plan.get("pulls") if isinstance(site_plan.get("pulls"), dict) else {},
                                        default_pulls_limit=eff_pulls_limit,
                                        pulls_limits_by_site=eff_pulls_limits_by_site or None,
                                    )
                                    for site_key, site_plan in plans
                                )
                                if not pulls_limit_matches:
                                    rejected_candidates += 1
                                    _enqueue({
                                        "type": "pulls_debug",
                                        "item_type": item_type,
                                        "item_index": item.get("index"),
                                        "accepted": False,
                                        "reason": "pulls_count_mismatch",
                                        "linked": True,
                                        "requested_pulls": eff_pulls_limit,
                                        "pulls_limits_by_site": eff_pulls_limits_by_site or None,
                                        "pulls_summary": pulls_summary,
                                    }, drop_if_full=True)
                                    logger.warning(
                                        "[PULLS][LINKED_STREAM][REJECT_PULL_COUNT] generation=%s attempt=%s type=%s item_index=%s "
                                        "requested=%s by_site=%s summary=%s",
                                        generation_id,
                                        attempts,
                                        item_type,
                                        item.get("index"),
                                        eff_pulls_limit,
                                        eff_pulls_limits_by_site or None,
                                        pulls_summary,
                                    )
                                    continue
                                matched_candidates += 1
                                logger.warning(
                                    "[PULLS][LINKED_STREAM][ACCEPT_PULL_COUNT] generation=%s attempt=%s type=%s item_index=%s "
                                    "matched=%s kept=%s summary=%s",
                                    generation_id,
                                    attempts,
                                    item_type,
                                    item.get("index"),
                                    matched_candidates,
                                    kept_alternatives_count,
                                    pulls_summary,
                                )
                            elif payload and payload.auto_pulls_enabled:
                                logger.warning(
                                    "[PULLS][LINKED_STREAM][CANDIDATE_UNLIMITED] generation=%s attempt=%s type=%s item_index=%s summary=%s",
                                    generation_id,
                                    attempts,
                                    item_type,
                                    item.get("index"),
                                    pulls_summary,
                                )

                            if item_type == "base":
                                _log_linked_generation_worker_totals(
                                    generation_id=generation_id,
                                    site_id=int(site_id),
                                    item_type="base",
                                    item_index=None,
                                    site_plans=split_site_plans,
                                    context=context,
                                )
                                if not base_sent:
                                    _enqueue({
                                        "type": "base",
                                        "source": item.get("source"),
                                        "linked_sites": linked_sites,
                                        "site_plans": split_site_plans,
                                    })
                                    base_sent = True
                                continue

                            try:
                                sig = json.dumps(split_site_plans, ensure_ascii=False, sort_keys=True)
                            except Exception:
                                sig = ""
                            if sig and sig in kept_alternative_signatures:
                                continue
                            if sig:
                                kept_alternative_signatures.add(sig)
                            kept_alternatives_count += 1
                            _log_linked_generation_worker_totals(
                                generation_id=generation_id,
                                site_id=int(site_id),
                                item_type="alternative",
                                item_index=kept_alternatives_count,
                                site_plans=split_site_plans,
                                context=context,
                            )
                            _enqueue({
                                "type": "alternative",
                                "index": kept_alternatives_count,
                                "source": item.get("source"),
                                "linked_sites": linked_sites,
                                "site_plans": split_site_plans,
                            }, drop_if_full=False)
                            if kept_alternatives_count >= target_kept_alternatives:
                                break
                            continue

                        if item_type == "done":
                            continue

                        enriched = dict(item)
                        enriched["linked_sites"] = linked_sites
                        _enqueue(enriched, drop_if_full=False)

                    if stop_event.is_set():
                        break
                    if kept_alternatives_count >= target_kept_alternatives:
                        break

                if not stop_event.is_set() and payload and payload.auto_pulls_enabled and matched_candidates == 0:
                    logger.warning(
                        "[PULLS][LINKED_STREAM][NO_MATCH] generation=%s rejected=%s kept=%s requested=%s by_site=%s",
                        generation_id,
                        rejected_candidates,
                        kept_alternatives_count,
                        eff_pulls_limit,
                        eff_pulls_limits_by_site or None,
                    )
                    _enqueue({
                        "type": "status",
                        "status": "ERROR",
                        "detail": _planning_limit_error_detail_for_request(
                            pulls_limit=eff_pulls_limit,
                            pulls_limits_by_site=eff_pulls_limits_by_site or None,
                        ),
                        "linked_sites": linked_sites,
                    })
                if not stop_event.is_set():
                    _enqueue({"type": "done", "linked_sites": linked_sites})
            except Exception as e:
                logger.exception("[PULLS][LINKED_STREAM][ERROR] generation=%s error=%s", generation_id, e)
                _enqueue({"type": "status", "status": "ERROR", "detail": str(e), "linked_sites": linked_sites})
            finally:
                logger.warning(
                    "[PULLS][LINKED_STREAM][DONE] generation=%s matched=%s rejected=%s kept=%s dropped_queue=%s",
                    generation_id,
                    matched_candidates,
                    rejected_candidates,
                    kept_alternatives_count,
                    dropped_alternatives,
                )
                if dropped_alternatives > 0:
                    _enqueue({
                        "type": "status",
                        "status": "INFO",
                        "detail": f"{dropped_alternatives} alternatives SSE skipped because the client was too slow.",
                        "linked_sites": linked_sites,
                    })
                _enqueue(None)
                _release_slot_once()

        threading.Thread(target=_producer, daemon=True).start()

        try:
            while True:
                item = await _asyncio.to_thread(q.get)
                if item is None:
                    break
                try:
                    chunk = f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
                    yield chunk
                finally:
                    await asyncio.sleep(0)
        finally:
            stop_event.set()
            _release_slot_once()

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_stream(), media_type="text/event-stream; charset=utf-8", headers=headers)


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
    # Parser le body manuellement pour éviter les erreurs 422
    payload = AIPlanningRequest()
    if request.method == "POST":
        try:
            body = await request.json()
            if body:
                # Nettoyer weekly_availability si la structure est incorrecte
                if "weekly_availability" in body and isinstance(body["weekly_availability"], dict):
                    cleaned_wa = {}
                    for worker_name, worker_avail in body["weekly_availability"].items():
                        if isinstance(worker_avail, dict):
                            # Si la structure est {availability: {...}}, extraire directement
                            if "availability" in worker_avail and not any(k in worker_avail for k in ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]):
                                cleaned_wa[worker_name] = worker_avail["availability"]
                            else:
                                cleaned_wa[worker_name] = worker_avail
                    if cleaned_wa:
                        body["weekly_availability"] = cleaned_wa
                payload = AIPlanningRequest(**body)
        except Exception as e:
            # Si le body est vide ou invalide, utiliser les valeurs par défaut
            logger.warning(f"Erreur lors du parsing du body: {e}")
            # Essayer de parser juste weekly_availability manuellement depuis le body déjà lu
            try:
                if body and "weekly_availability" in body:
                    # Nettoyer et reconstruire
                    cleaned_wa = {}
                    for worker_name, worker_avail in (body.get("weekly_availability") or {}).items():
                        if isinstance(worker_avail, dict):
                            if "availability" in worker_avail and not any(k in worker_avail for k in ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]):
                                cleaned_wa[worker_name] = worker_avail["availability"]
                            else:
                                cleaned_wa[worker_name] = worker_avail
                    payload.weekly_availability = cleaned_wa if cleaned_wa else None
            except:
                pass
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

    async def event_stream():
        """Non-bloquant: exécute le solveur dans un thread et stream via une queue."""
        import threading, queue, json, asyncio as _asyncio, time as _time
        q: "queue.Queue[dict | None]" = queue.Queue(maxsize=256)
        released = False

        def _release_slot_once() -> None:
            nonlocal released
            if released:
                return
            released = True
            _release_generation_slot(slot_token)

        def _producer():
            matched_candidates = 0
            dropped_alternatives = 0
            rejected_candidates = 0
            kept_alternative_signatures: set[str] = set()
            target_kept_alternatives = max(1, int(eff_num_alts))
            kept_alternatives_count = 0
            search_num_alts = _clamp_generation_budget(
                eff_time,
                max(target_kept_alternatives, target_kept_alternatives * 2),
                linked=False,
            )[1]

            def _enqueue(item: dict | None, *, drop_if_full: bool = False) -> None:
                nonlocal dropped_alternatives
                if item is None:
                    q.put(None)
                    return
                payload = dict(item)
                payload.setdefault("generation_id", generation_id)
                payload.setdefault("generated_at_ms", _now_ms())
                if drop_if_full:
                    try:
                        q.put(payload, timeout=0.05)
                    except queue.Full:
                        dropped_alternatives += 1
                    return
                q.put(payload)

            try:
                deadline_monotonic = _time.monotonic() + max(1, int(eff_time))
                attempts = 0
                base_sent = False
                logger.warning(
                    "[PULLS][SINGLE_STREAM][PRODUCER_START] generation=%s site=%s target_alternatives=%s "
                    "search_num_alts=%s requested=%s auto_pulls=%s",
                    generation_id,
                    site_id,
                    target_kept_alternatives,
                    search_num_alts,
                    eff_pulls_limit,
                    bool(payload.auto_pulls_enabled),
                )

                while kept_alternatives_count < target_kept_alternatives:
                    remaining_seconds = deadline_monotonic - _time.monotonic()
                    if remaining_seconds <= 0:
                        break
                    attempts += 1
                    attempt_time = max(1, int(remaining_seconds + 0.999))
                    # Diversifie les relances d'une même génération simple pour éviter
                    # de retomber systématiquement sur les 1-2 premières solutions.
                    attempt_random_seed = max(1, int(site_id) * 1000 + attempts * 7919)
                    attempt_search_num_alts = _clamp_generation_budget(
                        attempt_time,
                        max(search_num_alts, target_kept_alternatives * 2),
                        linked=False,
                    )[1]
                    gen = solve_schedule_stream(
                        site.config or {},
                        workers,
                        time_limit_seconds=attempt_time,
                        max_nights_per_worker=eff_max_nights,
                        num_alternatives=attempt_search_num_alts,
                        fixed_assignments=payload.fixed_assignments or None,
                        exclude_days=(payload.exclude_days or None),
                        random_seed=attempt_random_seed,
                    )
                    for item in gen:
                        if item.get("type") in {"base", "alternative"} and payload.auto_pulls_enabled:
                            cleaned_assignments = _enforce_role_requirements_on_assignments(
                                site.config or {},
                                item.get("assignments") if isinstance(item.get("assignments"), dict) else {},
                                rows,
                            )
                            transformed = _apply_auto_pulls_to_payload(
                                site,
                                rows,
                                {"assignments": deepcopy(cleaned_assignments), "pulls": {}},
                                pulls_limit=eff_pulls_limit,
                            )
                            transformed_pulls = transformed.get("pulls") if isinstance(transformed.get("pulls"), dict) else {}
                            transformed_pulls_count = _pulls_count(transformed_pulls)
                            if not _matches_pulls_limit(
                                transformed_pulls,
                                eff_pulls_limit,
                            ):
                                rejected_candidates += 1
                                _enqueue({
                                    "type": "pulls_debug",
                                    "item_type": item.get("type"),
                                    "item_index": item.get("index"),
                                    "accepted": False,
                                    "reason": "pulls_count_mismatch",
                                    "linked": False,
                                    "site_id": site_id,
                                    "requested_pulls": eff_pulls_limit,
                                    "received_pulls": transformed_pulls_count,
                                }, drop_if_full=True)
                                logger.warning(
                                    "[PULLS][SINGLE_STREAM][REJECT_PULL_COUNT] generation=%s site=%s attempt=%s "
                                    "type=%s item_index=%s requested=%s received=%s rejected=%s kept=%s",
                                    generation_id,
                                    site_id,
                                    attempts,
                                    item.get("type"),
                                    item.get("index"),
                                    eff_pulls_limit,
                                    transformed_pulls_count,
                                    rejected_candidates,
                                    kept_alternatives_count,
                                )
                                continue
                            enriched = dict(item)
                            enriched["assignments"] = transformed.get("assignments") or {}
                            enriched["pulls"] = transformed_pulls
                            matched_candidates += 1
                            logger.warning(
                                "[PULLS][SINGLE_STREAM][ACCEPT_PULL_COUNT] generation=%s site=%s attempt=%s "
                                "type=%s item_index=%s requested=%s received=%s matched=%s kept=%s",
                                generation_id,
                                site_id,
                                attempts,
                                item.get("type"),
                                item.get("index"),
                                eff_pulls_limit,
                                transformed_pulls_count,
                                matched_candidates,
                                kept_alternatives_count,
                            )
                            _log_single_site_generation_worker_totals(
                                generation_id=generation_id,
                                site_id=int(site_id),
                                item_type=str(item.get("type") or ""),
                                item_index=(
                                    int(item.get("index"))
                                    if item.get("type") == "alternative" and str(item.get("index") or "").strip()
                                    else None
                                ),
                                workers=workers,
                                assignments=enriched.get("assignments") if isinstance(enriched.get("assignments"), dict) else {},
                            )
                        elif item.get("type") in {"base", "alternative"}:
                            enriched = dict(item)
                            enriched["assignments"] = _enforce_role_requirements_on_assignments(
                                site.config or {},
                                item.get("assignments") if isinstance(item.get("assignments"), dict) else {},
                                rows,
                            )
                            _log_single_site_generation_worker_totals(
                                generation_id=generation_id,
                                site_id=int(site_id),
                                item_type=str(item.get("type") or ""),
                                item_index=(
                                    int(item.get("index"))
                                    if item.get("type") == "alternative" and str(item.get("index") or "").strip()
                                    else None
                                ),
                                workers=workers,
                                assignments=enriched.get("assignments") if isinstance(enriched.get("assignments"), dict) else {},
                            )
                        else:
                            enriched = dict(item)

                        item_type = enriched.get("type")
                        if item_type == "base":
                            if not base_sent:
                                _enqueue(enriched)
                                base_sent = True
                            continue
                        if item_type == "alternative":
                            try:
                                sig = json.dumps(
                                    {
                                        "assignments": enriched.get("assignments") or {},
                                        "pulls": enriched.get("pulls") or {},
                                    },
                                    ensure_ascii=False,
                                    sort_keys=True,
                                )
                            except Exception:
                                sig = ""
                            if sig and sig in kept_alternative_signatures:
                                continue
                            if sig:
                                kept_alternative_signatures.add(sig)
                            kept_alternatives_count += 1
                            next_alternative = dict(enriched)
                            next_alternative["index"] = kept_alternatives_count
                            _enqueue(next_alternative, drop_if_full=False)
                            continue
                        if item_type == "done":
                            if payload.auto_pulls_enabled and matched_candidates == 0:
                                _enqueue(
                                    {"type": "status", "status": "ERROR", "detail": _planning_limit_error_detail_for_request(pulls_limit=eff_pulls_limit)}
                                )
                            continue
                        _enqueue(enriched, drop_if_full=False)

                    if kept_alternatives_count >= target_kept_alternatives:
                        break

                kept_final_count = min(kept_alternatives_count, target_kept_alternatives)
                timeout_reached = kept_final_count < target_kept_alternatives
                _enqueue({"type": "done"})
            except Exception as e:  # met l'erreur dans le flux
                _enqueue({"type": "status", "status": "ERROR", "detail": str(e)})
            finally:
                if dropped_alternatives > 0:
                    _enqueue({
                        "type": "status",
                        "status": "INFO",
                        "detail": f"{dropped_alternatives} alternatives SSE skipped because the client was too slow.",
                    })
                _enqueue(None)
                _release_slot_once()

        threading.Thread(target=_producer, daemon=True).start()

        try:
            while True:
                item = await _asyncio.to_thread(q.get)
                if item is None:
                    break
                try:
                    if item.get("type") == "alternative":
                        logger.debug("[SSE] push alternative index=%s", item.get("index"))
                    elif item.get("type") == "base":
                        logger.info("[SSE] push base plan generation=%s", item.get("generation_id"))
                    elif item.get("type") == "done":
                        logger.info("[SSE] push done generation=%s", item.get("generation_id"))
                    elif item.get("type") == "status":
                        logger.warning(
                            "[SSE] generation=%s status=%s detail=%s",
                            item.get("generation_id"),
                            item.get("status"),
                            item.get("detail"),
                        )
                    chunk = f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
                    yield chunk
                finally:
                    await asyncio.sleep(0)
        finally:
            _release_slot_once()

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_stream(), media_type="text/event-stream; charset=utf-8", headers=headers)



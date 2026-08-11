"""SSE streaming for AI planning generation (linked + single-site)."""

from __future__ import annotations

import asyncio
import json
import logging
import queue
import threading
import time
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable

from sqlalchemy.orm import Session

from ..ai_solver import solve_schedule_stream
from ..models import Site
from ..schemas import AIPlanningRequest
from .week_utils import _now_ms
from .generation_slots import _release_generation_slot
from .solver_bridge import (
    _log_single_site_generation_worker_totals,
    _log_linked_generation_worker_totals,
)
from .pulls import (
    _apply_auto_pulls_to_payload,
    _enforce_role_requirements_on_assignments,
    _apply_auto_pulls_to_site_plans,
    _enforce_role_requirements_on_site_plans,
    _planning_limit_error_detail_for_request,
    _site_pulls_limit_matches,
    _matches_pulls_limit,
    _pulls_count,
)
from .linked_sites import (
    _enforce_linked_global_caps_on_site_plans,
    _split_multi_site_assignments,
)
from .auto_planning import (
    _clamp_generation_budget,
    _single_site_candidate_sort_key,
    _should_hold_plan_until_pull_target,
)

logger = logging.getLogger("ai_solver")

AI_GENERATE_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}

_SSE_WEEK_DAY_KEYS = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")


def clean_weekly_availability_from_body(raw: dict | None) -> dict | None:
    if not raw or not isinstance(raw, dict):
        return None
    cleaned_wa: dict = {}
    for worker_name, worker_avail in raw.items():
        if isinstance(worker_avail, dict):
            if "availability" in worker_avail and not any(k in worker_avail for k in _SSE_WEEK_DAY_KEYS):
                cleaned_wa[worker_name] = worker_avail["availability"]
            else:
                cleaned_wa[worker_name] = worker_avail
    return cleaned_wa if cleaned_wa else None


async def apply_linked_stream_body_overrides(request, payload: AIPlanningRequest) -> tuple[int | None, int | None, int | None]:
    """Parse POST body overrides for linked stream (GET uses query params elsewhere)."""
    q_num_alternatives = None
    q_time_limit_seconds = None
    q_max_nights_per_worker = None
    if request.method != "GET":
        try:
            body = await request.json()
            if isinstance(body, dict):
                q_num_alternatives = body.get("num_alternatives")
                q_time_limit_seconds = body.get("time_limit_seconds")
                q_max_nights_per_worker = body.get("max_nights_per_worker")
                payload.pulls_limits_by_site = (
                    body.get("pulls_limits_by_site") if isinstance(body.get("pulls_limits_by_site"), dict) else None
                )
                if "pulls_prefer" in body:
                    raw_prefer = body.get("pulls_prefer")
                    payload.pulls_prefer = raw_prefer if isinstance(raw_prefer, list) and raw_prefer else None
                if "weekly_availability" in body:
                    payload.weekly_availability = clean_weekly_availability_from_body(body.get("weekly_availability"))
        except Exception:
            pass
    return q_num_alternatives, q_time_limit_seconds, q_max_nights_per_worker


async def parse_single_stream_payload(
    request,
    payload_default: AIPlanningRequest,
) -> AIPlanningRequest:
    payload = payload_default
    body = None
    if request.method == "POST":
        try:
            body = await request.json()
            if body:
                if "weekly_availability" in body and isinstance(body["weekly_availability"], dict):
                    cleaned = clean_weekly_availability_from_body(body["weekly_availability"])
                    if cleaned:
                        body["weekly_availability"] = cleaned
                payload = AIPlanningRequest(**body)
        except Exception as e:
            logger.warning("Erreur lors du parsing du body: %s", e)
            try:
                if body and "weekly_availability" in body:
                    payload.weekly_availability = clean_weekly_availability_from_body(body.get("weekly_availability"))
            except Exception:
                pass
    return payload


@dataclass
class LinkedGenerationStreamParams:
    db: Session
    site_id: int
    generation_id: str
    slot_token: Any
    eff_time: int
    eff_num_alts: int
    eff_max_nights: int | None
    eff_pulls_limit: int | None
    eff_pulls_limits_by_site: dict | None
    payload: AIPlanningRequest
    context: dict
    linked_sites: list
    week_iso: str


@dataclass
class SingleGenerationStreamParams:
    site: Site
    site_id: int
    generation_id: str
    slot_token: Any
    eff_time: int
    eff_num_alts: int
    eff_max_nights: int | None
    eff_pulls_limit: int | None
    payload: AIPlanningRequest
    workers: list
    rows: list


def _make_release_slot(slot_token) -> tuple[Callable[[], None], Callable[[], bool]]:
    released = {"value": False}

    def _release_slot_once() -> None:
        if released["value"]:
            return
        released["value"] = True
        _release_generation_slot(slot_token)

    def _is_released() -> bool:
        return released["value"]

    return _release_slot_once, _is_released


async def _iter_sse_from_queue(
    q: "queue.Queue[dict | None]",
    *,
    stop_event: threading.Event | None = None,
    release_slot: Callable[[], None] | None = None,
    on_item: Callable[[dict], None] | None = None,
) -> AsyncIterator[str]:
    try:
        while True:
            item = await asyncio.to_thread(q.get)
            if item is None:
                break
            try:
                if on_item is not None:
                    on_item(item)
                chunk = f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
                yield chunk
            finally:
                await asyncio.sleep(0)
    finally:
        if stop_event is not None:
            stop_event.set()
        if release_slot is not None:
            release_slot()



def _run_linked_stream_producer(params: LinkedGenerationStreamParams, q: "queue.Queue[dict | None]", stop_event: threading.Event, release_slot: Callable[[], None]) -> None:
    db = params.db
    site_id = params.site_id
    generation_id = params.generation_id
    eff_time = params.eff_time
    eff_num_alts = params.eff_num_alts
    eff_max_nights = params.eff_max_nights
    eff_pulls_limit = params.eff_pulls_limit
    eff_pulls_limits_by_site = params.eff_pulls_limits_by_site
    payload = params.payload
    context = params.context
    linked_sites = params.linked_sites
    week_iso = params.week_iso

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
        deadline_monotonic = time.monotonic() + max(1, int(eff_time))
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
            remaining_seconds = deadline_monotonic - time.monotonic()
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
                            pulls_prefer=payload.pulls_prefer if payload else None,
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
                        item_type = "alternative"

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
        release_slot()

def _run_single_stream_producer(params: SingleGenerationStreamParams, q: "queue.Queue[dict | None]", release_slot: Callable[[], None]) -> None:
    site = params.site
    site_id = params.site_id
    generation_id = params.generation_id
    eff_time = params.eff_time
    eff_num_alts = params.eff_num_alts
    eff_max_nights = params.eff_max_nights
    eff_pulls_limit = params.eff_pulls_limit
    payload = params.payload
    workers = params.workers
    rows = params.rows

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
        deadline_monotonic = time.monotonic() + max(1, int(eff_time))
        attempts = 0
        base_sent = False
        week_iso = str(getattr(payload, "week_iso", None) or "").strip() or "1970-01-01"
        held_base_candidates: list[tuple[tuple, dict]] = []

        def _held_item_key(item: dict) -> tuple:
            asg = item.get("assignments") if isinstance(item.get("assignments"), dict) else {}
            pulls_map = item.get("pulls") if isinstance(item.get("pulls"), dict) else {}
            return _single_site_candidate_sort_key(site, asg, week_iso, pulls_map, payload.pulls_prefer)

        def _item_should_hold(item: dict) -> bool:
            if not payload.auto_pulls_enabled:
                return False
            asg = item.get("assignments") if isinstance(item.get("assignments"), dict) else {}
            pulls_map = item.get("pulls") if isinstance(item.get("pulls"), dict) else {}
            return _should_hold_plan_until_pull_target(
                site, asg, week_iso, pulls_map, eff_pulls_limit, payload.pulls_prefer,
            )

        def _enqueue_alternative(item: dict) -> None:
            nonlocal kept_alternatives_count
            try:
                sig = json.dumps(
                    {
                        "assignments": item.get("assignments") or {},
                        "pulls": item.get("pulls") or {},
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                )
            except Exception:
                sig = ""
            if sig and sig in kept_alternative_signatures:
                return
            if sig:
                kept_alternative_signatures.add(sig)
            kept_alternatives_count += 1
            next_alternative = dict(item)
            next_alternative["type"] = "alternative"
            next_alternative["index"] = kept_alternatives_count
            _enqueue(next_alternative, drop_if_full=False)

        def _flush_held_base(*, force: bool = False) -> None:
            nonlocal base_sent, held_base_candidates
            if base_sent or not held_base_candidates:
                return
            held_base_candidates.sort(key=lambda pair: pair[0])
            best_item = held_base_candidates[0][1]
            if not force and _item_should_hold(best_item):
                # Un plan à N משיכות (ou 0 trou) existe déjà : le meilleur a moins
                # de trous avec 0/1 משיכה — on peut afficher.
                has_ready = any(not _item_should_hold(item) for _, item in held_base_candidates)
                if not has_ready:
                    return
            base_event = dict(best_item)
            base_event["type"] = "base"
            _enqueue(base_event)
            base_sent = True
            for _, item in held_base_candidates[1:]:
                _enqueue_alternative(item)
            held_base_candidates = []

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
            remaining_seconds = deadline_monotonic - time.monotonic()
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
                        pulls_prefer=payload.pulls_prefer,
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
                if item_type in {"base", "alternative"} and payload.auto_pulls_enabled and (
                    eff_pulls_limit is not None or bool(payload.pulls_prefer)
                ):
                    if not base_sent:
                        held_base_candidates.append((_held_item_key(enriched), dict(enriched)))
                        if len(held_base_candidates) > 40:
                            held_base_candidates.sort(key=lambda pair: pair[0])
                            held_base_candidates = held_base_candidates[:40]
                        _flush_held_base()
                        continue
                    _enqueue_alternative(enriched)
                    continue
                if item_type == "base":
                    if not base_sent:
                        _enqueue(enriched)
                        base_sent = True
                        continue
                    # Relances suivantes : ne pas jeter le « base », le traiter comme חלופה.
                    enriched = dict(enriched)
                    enriched["type"] = "alternative"
                    item_type = "alternative"
                if item_type == "alternative":
                    _enqueue_alternative(enriched)
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

        _flush_held_base(force=True)
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
        release_slot()


async def linked_generation_sse_stream(params: LinkedGenerationStreamParams) -> AsyncIterator[str]:
    q: "queue.Queue[dict | None]" = queue.Queue(maxsize=1024)
    stop_event = threading.Event()
    release_slot, _ = _make_release_slot(params.slot_token)

    threading.Thread(
        target=_run_linked_stream_producer,
        args=(params, q, stop_event, release_slot),
        daemon=True,
    ).start()

    async for chunk in _iter_sse_from_queue(q, stop_event=stop_event, release_slot=release_slot):
        yield chunk


def _log_single_sse_item(item: dict) -> None:
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


async def single_generation_sse_stream(params: SingleGenerationStreamParams) -> AsyncIterator[str]:
    q: "queue.Queue[dict | None]" = queue.Queue(maxsize=256)
    release_slot, _ = _make_release_slot(params.slot_token)

    threading.Thread(
        target=_run_single_stream_producer,
        args=(params, q, release_slot),
        daemon=True,
    ).start()

    async for chunk in _iter_sse_from_queue(q, release_slot=release_slot, on_item=_log_single_sse_item):
        yield chunk

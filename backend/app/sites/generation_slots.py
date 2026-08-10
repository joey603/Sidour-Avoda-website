"""Concurrency slots for AI planning generation."""

from __future__ import annotations

import logging
import os
import secrets
import threading
import time
from contextlib import contextmanager

from fastapi import HTTPException

from .week_utils import _now_ms

logger = logging.getLogger("ai_solver")

_GENERATION_CONCURRENCY_LIMIT = max(1, min(int(os.getenv("PLANNING_MAX_CONCURRENT_GENERATIONS", "5") or "5"), 8))
_DIRECTOR_GENERATION_CONCURRENCY_LIMIT = max(
    1,
    min(int(os.getenv("PLANNING_MAX_CONCURRENT_GENERATIONS_PER_DIRECTOR", "1") or "1"), 4),
)
_GENERATION_SEMAPHORE = threading.BoundedSemaphore(_GENERATION_CONCURRENCY_LIMIT)
_GENERATION_STATE_LOCK = threading.Lock()
_ACTIVE_GENERATIONS: dict[str, dict[str, object]] = {}
_ACTIVE_GENERATIONS_BY_DIRECTOR: dict[int, int] = {}


def _new_generation_id() -> str:
    return secrets.token_hex(8)


def _generation_request_wait_timeout_seconds() -> float:
    try:
        return max(0.0, float(os.getenv("PLANNING_REQUEST_WAIT_TIMEOUT_SECONDS", "3") or "3"))
    except Exception:
        return 3.0


def _generation_busy_detail(director_id: int | None = None) -> str:
    with _GENERATION_STATE_LOCK:
        active = list(_ACTIVE_GENERATIONS.values())
        director_busy = (
            director_id is not None
            and _ACTIVE_GENERATIONS_BY_DIRECTOR.get(int(director_id), 0) >= _DIRECTOR_GENERATION_CONCURRENCY_LIMIT
        )
        active_count = len(_ACTIVE_GENERATIONS)
    if director_busy:
        return "Une génération de planning est déjà en cours pour ce directeur. Réessaie dans quelques instants."
    if active_count >= _GENERATION_CONCURRENCY_LIMIT:
        return "Le serveur a déjà atteint le nombre maximum de générations simultanées. Réessaie dans quelques instants."
    if not active:
        return "Une autre génération de planning est déjà en cours. Réessaie dans quelques instants."
    summary = ", ".join(
        f"{str(item.get('kind') or 'unknown')}@site:{item.get('site_id')}@director:{item.get('director_id')}"
        for item in active[:3]
    )
    return f"Une autre génération de planning est déjà en cours ({summary}). Réessaie dans quelques instants."


def _is_generation_busy_error(errors: list[str] | None) -> bool:
    return any("déjà en cours" in str(err or "") for err in (errors or []))


def _acquire_generation_slot(
    *,
    kind: str,
    director_id: int | None,
    site_id: int | None,
    linked: bool,
    generation_id: str | None = None,
    wait_timeout_seconds: float | None = 0.0,
) -> str | None:
    deadline = None if wait_timeout_seconds is None else (
        time.monotonic() + float(wait_timeout_seconds) if wait_timeout_seconds > 0 else 0.0
    )
    while True:
        if deadline is None:
            _GENERATION_SEMAPHORE.acquire()
            acquired = True
        elif deadline > 0:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            acquired = _GENERATION_SEMAPHORE.acquire(timeout=min(0.25, remaining))
        else:
            acquired = _GENERATION_SEMAPHORE.acquire(blocking=False)
        if not acquired:
            return None

        director_busy = False
        token = _new_generation_id()
        payload = {
            "token": token,
            "kind": kind,
            "director_id": director_id,
            "site_id": site_id,
            "linked": linked,
            "generation_id": generation_id,
            "started_at_ms": _now_ms(),
        }
        with _GENERATION_STATE_LOCK:
            if director_id is not None and _ACTIVE_GENERATIONS_BY_DIRECTOR.get(int(director_id), 0) >= _DIRECTOR_GENERATION_CONCURRENCY_LIMIT:
                director_busy = True
            else:
                _ACTIVE_GENERATIONS[token] = payload
                if director_id is not None:
                    _ACTIVE_GENERATIONS_BY_DIRECTOR[int(director_id)] = _ACTIVE_GENERATIONS_BY_DIRECTOR.get(int(director_id), 0) + 1
                active_count = len(_ACTIVE_GENERATIONS)
        if not director_busy:
            logger.info(
                "[GENERATION][LOCK] acquired token=%s kind=%s director=%s site=%s linked=%s active=%s limit=%s per_director_limit=%s",
                token,
                kind,
                director_id,
                site_id,
                linked,
                active_count,
                _GENERATION_CONCURRENCY_LIMIT,
                _DIRECTOR_GENERATION_CONCURRENCY_LIMIT,
            )
            return token

        _GENERATION_SEMAPHORE.release()
        if deadline == 0.0:
            return None
        if deadline is None:
            time.sleep(0.1)
            continue
        time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))


def _release_generation_slot(token: str | None) -> None:
    if not token:
        return
    with _GENERATION_STATE_LOCK:
        existed = _ACTIVE_GENERATIONS.pop(token, None)
        director_id = int(existed.get("director_id")) if existed and existed.get("director_id") is not None else None
        if director_id is not None:
            current = _ACTIVE_GENERATIONS_BY_DIRECTOR.get(director_id, 0)
            if current <= 1:
                _ACTIVE_GENERATIONS_BY_DIRECTOR.pop(director_id, None)
            else:
                _ACTIVE_GENERATIONS_BY_DIRECTOR[director_id] = current - 1
        active_count = len(_ACTIVE_GENERATIONS)
    if existed is not None:
        _GENERATION_SEMAPHORE.release()
        logger.info(
            "[GENERATION][LOCK] released token=%s kind=%s director=%s site=%s active=%s",
            token,
            existed.get("kind"),
            existed.get("director_id"),
            existed.get("site_id"),
            active_count,
        )


def _preempt_director_generation_slots(director_id: int | None, *, reason: str = "new-request") -> int:
    """Libère les slots déjà tenus par ce directeur pour qu’une nouvelle génération puisse démarrer.

    Cas typique : abort client / HMR / double-clic — le front relance alors que le slot
    serveur est encore pris → 429 en boucle. La nouvelle requête remplace l’ancienne.
    """
    if director_id is None:
        return 0
    did = int(director_id)
    with _GENERATION_STATE_LOCK:
        tokens = [
            token
            for token, payload in _ACTIVE_GENERATIONS.items()
            if payload.get("director_id") is not None and int(payload["director_id"]) == did
        ]
    released = 0
    for token in tokens:
        before = None
        with _GENERATION_STATE_LOCK:
            before = _ACTIVE_GENERATIONS.get(token)
        _release_generation_slot(token)
        if before is not None:
            released += 1
            logger.warning(
                "[GENERATION][LOCK] preempted token=%s kind=%s director=%s site=%s reason=%s",
                token,
                before.get("kind"),
                before.get("director_id"),
                before.get("site_id"),
                reason,
            )
    return released


@contextmanager
def _generation_slot_or_wait(
    *,
    kind: str,
    director_id: int | None,
    site_id: int | None,
    linked: bool,
    generation_id: str | None = None,
    wait_timeout_seconds: float | None = None,
):
    token = _acquire_generation_slot(
        kind=kind,
        director_id=director_id,
        site_id=site_id,
        linked=linked,
        generation_id=generation_id,
        wait_timeout_seconds=wait_timeout_seconds,
    )
    if token is None:
        raise HTTPException(status_code=429, detail=_generation_busy_detail(director_id))
    try:
        yield token
    finally:
        _release_generation_slot(token)



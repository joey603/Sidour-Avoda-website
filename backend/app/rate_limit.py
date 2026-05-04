from __future__ import annotations

import threading
import time
from collections import deque

from fastapi import HTTPException, Request


_LOCK = threading.Lock()
_BUCKETS: dict[str, deque[float]] = {}


def reset_rate_limits() -> None:
    with _LOCK:
        _BUCKETS.clear()


def _client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        first = str(forwarded_for).split(",")[0].strip()
        if first:
            return first
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return str(real_ip).strip()
    client = getattr(request, "client", None)
    host = getattr(client, "host", None)
    return str(host or "unknown")


def enforce_rate_limit(
    request: Request,
    *,
    scope: str,
    limit: int,
    window_seconds: int,
    subject: str | None = None,
    detail: str = "Trop de tentatives. Réessaie plus tard.",
) -> None:
    now = time.monotonic()
    key = f"{scope}:{_client_ip(request)}:{str(subject or '').strip().lower()}"
    with _LOCK:
        bucket = _BUCKETS.setdefault(key, deque())
        cutoff = now - float(window_seconds)
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= int(limit):
            raise HTTPException(status_code=429, detail=detail)
        bucket.append(now)

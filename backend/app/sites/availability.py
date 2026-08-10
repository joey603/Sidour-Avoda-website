from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Body, Response
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from datetime import datetime
import re
import logging

from ..deps import require_role, get_db
from ..models import (
    Site, SiteWorker, SiteMessage, SiteEvent, SiteWeeklyAvailability,
    SiteWeekPlan, User, UserRole,
)
from ..schemas import (
    SiteCreate, SiteOut, SiteUpdate, WorkerCreate, WorkerUpdate, WorkerOut,
    UserOut, CreateWorkerUserRequest, WeeklyAvailabilityPayload, WeekPlanPayload,
    SiteMessageCreate, SiteMessageUpdate, SiteMessageOut, SiteEventCreate,
    SiteEventUpdate, SiteEventOut, WorkerInviteLinkOut, NextWeekSavedPlanStatus,
)
from ..auth import create_worker_invite_token, ensure_director_code
from passlib.context import CryptContext

from .ownership import _director_site_or_404, _director_site_ownership_or_404
from .week_utils import (
    _validate_week_iso, _now_ms, _next_week_iso, _week_start_date,
    _site_worker_visible_for_week, _workers_counts_by_site_for_week, _week_date_set,
)
from .site_config import validate_site_config, normalize_site_config, _safe_site_config

logger = logging.getLogger("ai_solver")
router = APIRouter()

def _worker_submitted_week_availability(worker_row: SiteWorker, week_iso: str) -> dict[str, list[str]] | None:
    """זמינות soumise par l'employé pour une semaine précise (stockée dans answers[week])."""
    raw_answers = worker_row.answers if isinstance(worker_row.answers, dict) else {}
    week_block = raw_answers.get(week_iso) if isinstance(raw_answers, dict) else None
    if not isinstance(week_block, dict) or not bool(week_block.get("_availability_submitted")):
        return None
    avail = week_block.get("availability")
    if not isinstance(avail, dict):
        return None
    cleaned: dict[str, list[str]] = {}
    for day_key in _WEEK_DAY_KEYS:
        shifts = avail.get(day_key)
        if isinstance(shifts, list):
            cleaned[day_key] = [str(s) for s in shifts if str(s or "").strip()]
        else:
            cleaned[day_key] = []
    for meta_key in ("_stations", "_station_indices"):
        meta = avail.get(meta_key)
        if isinstance(meta, list):
            cleaned[meta_key] = [str(x) for x in meta]
    return cleaned


@router.get("/{site_id}/weekly-availability", response_model=dict[str, dict[str, list[str]]])
def get_weekly_availability(
    site_id: int,
    week: str = Query(..., description="YYYY-MM-DD (week start)"),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    """
    Persistance DB (Neon) des overrides hebdo de disponibilité utilisés par le directeur.
    Remplace le localStorage comme source de vérité entre appareils.
    """
    _director_site_ownership_or_404(db, site_id, user.id)
    wk = _validate_week_iso(week)
    row = (
        db.query(SiteWeeklyAvailability)
        .filter(SiteWeeklyAvailability.site_id == site_id)
        .filter(SiteWeeklyAvailability.week_iso == wk)
        .first()
    )
    result: dict[str, dict[str, list[str]]] = dict(row.availability or {}) if row else {}
    worker_rows = [
        w
        for w in db.query(SiteWorker).filter(SiteWorker.site_id == site_id).all()
        if _site_worker_visible_for_week(w, wk)
    ]
    for worker_row in worker_rows:
        name = str(worker_row.name or "").strip()
        if not name or name in result:
            continue
        submitted = _worker_submitted_week_availability(worker_row, wk)
        if submitted is not None:
            result[name] = submitted
    return result


@router.put("/{site_id}/weekly-availability", response_model=dict[str, dict[str, list[str]]])
def put_weekly_availability(
    site_id: int,
    payload: WeeklyAvailabilityPayload,
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_or_404(db, site_id, user.id)
    wk = _validate_week_iso(payload.week_iso)
    now = _now_ms()
    row = (
        db.query(SiteWeeklyAvailability)
        .filter(SiteWeeklyAvailability.site_id == site_id)
        .filter(SiteWeeklyAvailability.week_iso == wk)
        .first()
    )
    data = payload.availability or {}
    if row:
        row.availability = data
        row.updated_at = now
    else:
        row = SiteWeeklyAvailability(site_id=site_id, week_iso=wk, availability=data, updated_at=now)
        db.add(row)
    db.commit()
    db.refresh(row)
    return row.availability or {}

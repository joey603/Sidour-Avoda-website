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

@router.get("/{site_id}/messages", response_model=list[SiteMessageOut])
def list_site_messages(
    site_id: int,
    week: str = Query(..., description="YYYY-MM-DD (week start)"),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_ownership_or_404(db, site_id, user.id)
    wk = _validate_week_iso(week)
    rows = (
        db.query(SiteMessage)
        .filter(SiteMessage.site_id == site_id)
        .filter(
            (SiteMessage.scope == "week") & (SiteMessage.created_week_iso == wk)
            | (
                (SiteMessage.scope == "global")
                & (SiteMessage.created_week_iso <= wk)
                & ((SiteMessage.stopped_week_iso.is_(None)) | (wk < SiteMessage.stopped_week_iso))
            )
        )
        .order_by(SiteMessage.created_at.asc(), SiteMessage.id.asc())
        .all()
    )
    return rows


@router.post("/{site_id}/messages", response_model=SiteMessageOut, status_code=201)
def create_site_message(
    site_id: int,
    payload: SiteMessageCreate,
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_or_404(db, site_id, user.id)
    wk = _validate_week_iso(payload.week_iso)
    now = _now_ms()
    msg = SiteMessage(
        site_id=site_id,
        scope=payload.scope,
        text=(payload.text or "").strip(),
        created_week_iso=wk,
        stopped_week_iso=None,
        origin_id=None,
        created_at=now,
        updated_at=now,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return msg


@router.patch("/{site_id}/messages/{message_id}", response_model=list[SiteMessageOut])
def update_site_message(
    site_id: int,
    message_id: int,
    payload: SiteMessageUpdate,
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_or_404(db, site_id, user.id)
    wk = _validate_week_iso(payload.week_iso)
    now = _now_ms()
    msg = db.get(SiteMessage, message_id)
    if not msg or msg.site_id != site_id:
        raise HTTPException(status_code=404, detail="Message introuvable")

    new_text = (payload.text.strip() if isinstance(payload.text, str) else None)
    new_scope = payload.scope

    # Week message updates: only this week.
    if msg.scope == "week":
        if new_scope is None or new_scope == "week":
            if new_text is not None:
                msg.text = new_text
                msg.updated_at = now
            db.commit()
        else:
            # week -> global: start global from this week, remove week msg to avoid duplicates
            text_for_global = new_text if new_text is not None else msg.text
            db.delete(msg)
            db.add(
                SiteMessage(
                    site_id=site_id,
                    scope="global",
                    text=text_for_global,
                    created_week_iso=wk,
                    stopped_week_iso=None,
                    origin_id=None,
                    created_at=now,
                    updated_at=now,
                )
            )
            db.commit()

        return list_site_messages(site_id=site_id, week=wk, user=user, db=db)  # type: ignore[arg-type]

    # Global message updates: non retroactive.
    if msg.scope == "global":
        target_scope = new_scope or "global"

        if target_scope == "week":
            # Stop global at this week (exclusive), and create/update a week clone for this week
            cur_stop = (msg.stopped_week_iso or "").strip()
            msg.stopped_week_iso = (cur_stop if (cur_stop and cur_stop < wk) else wk) if cur_stop else wk
            msg.updated_at = now

            # Upsert week clone (origin_id=global id, created_week_iso=wk)
            clone = (
                db.query(SiteMessage)
                .filter(SiteMessage.site_id == site_id)
                .filter(SiteMessage.scope == "week")
                .filter(SiteMessage.created_week_iso == wk)
                .filter(SiteMessage.origin_id == msg.id)
                .first()
            )
            clone_text = new_text if new_text is not None else msg.text
            if clone:
                clone.text = clone_text
                clone.updated_at = now
            else:
                db.add(
                    SiteMessage(
                        site_id=site_id,
                        scope="week",
                        text=clone_text,
                        created_week_iso=wk,
                        stopped_week_iso=None,
                        origin_id=msg.id,
                        created_at=now,
                        updated_at=now,
                    )
                )
            db.commit()
            return list_site_messages(site_id=site_id, week=wk, user=user, db=db)  # type: ignore[arg-type]

        # target_scope == global
        if new_text is None:
            return list_site_messages(site_id=site_id, week=wk, user=user, db=db)  # type: ignore[arg-type]

        # If editing a future week relative to creation, create a new version from this week.
        if (msg.created_week_iso or "") < wk:
            cur_stop = (msg.stopped_week_iso or "").strip()
            msg.stopped_week_iso = (cur_stop if (cur_stop and cur_stop < wk) else wk) if cur_stop else wk
            msg.updated_at = now
            db.add(
                SiteMessage(
                    site_id=site_id,
                    scope="global",
                    text=new_text,
                    created_week_iso=wk,
                    stopped_week_iso=None,
                    origin_id=None,
                    created_at=now,
                    updated_at=now,
                )
            )
            db.commit()
            return list_site_messages(site_id=site_id, week=wk, user=user, db=db)  # type: ignore[arg-type]

        # Same week creation -> update in place
        msg.text = new_text
        msg.updated_at = now
        db.commit()
        return list_site_messages(site_id=site_id, week=wk, user=user, db=db)  # type: ignore[arg-type]

    return list_site_messages(site_id=site_id, week=wk, user=user, db=db)  # type: ignore[arg-type]


@router.delete("/{site_id}/messages/{message_id}", status_code=204)
def delete_site_message(
    site_id: int,
    message_id: int,
    week: str = Query(..., description="YYYY-MM-DD (week start)"),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_or_404(db, site_id, user.id)
    _validate_week_iso(week)
    msg = db.get(SiteMessage, message_id)
    if not msg or msg.site_id != site_id:
        raise HTTPException(status_code=404, detail="Message introuvable")
    db.delete(msg)
    db.commit()
    return Response(status_code=204)

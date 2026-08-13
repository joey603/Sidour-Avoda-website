from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Body, Response
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, load_only
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
from .site_config import (
    validate_site_config,
    normalize_site_config,
    _safe_site_config,
    _list_site_public_config,
)
from .week_plans import (
    _preferred_week_plan,
    _week_plan_debug_meta,
    _build_next_week_saved_plan_status,
    _is_empty_auto_week_plan,
    _load_week_plan_lites,
)
from .linked_sites import _linked_site_cluster_map_for_director, _worker_identity_key

logger = logging.getLogger("ai_solver")
router = APIRouter()

@router.get("/", response_model=list[SiteOut])
def list_sites(user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    # En Postgres, le type JSON n'a pas d'opérateur d'égalité → impossible de GROUP BY sur sites.config.
    # On fait donc 2 requêtes simples et on assemble côté Python.
    sites = db.query(Site).filter(Site.director_id == user.id, Site.deleted_at.is_(None)).all()
    next_week_iso = _next_week_iso(datetime.now())
    counts, pending_counts = _workers_counts_by_site_for_week(db, user.id, next_week_iso)
    site_ids = [int(s.id) for s in sites]
    plan_rows = _load_week_plan_lites(db, site_ids, next_week_iso)
    preferred_plan_by_site: dict[int, object] = {}
    sites_by_id_for_plans = {int(s.id): s for s in sites}
    for row in plan_rows:
        row_site = sites_by_id_for_plans.get(int(row.site_id))
        if row_site is not None and _is_empty_auto_week_plan(row_site, row, next_week_iso):
            logger.warning(
                "[AUTO-PLANNING][LIST] ignoring empty auto week plan director_id=%s site_id=%s week_iso=%s",
                user.id,
                row.site_id,
                next_week_iso,
            )
            continue
        existing = preferred_plan_by_site.get(row.site_id)
        if existing is None or _preferred_week_plan([existing, row]) is row:
            preferred_plan_by_site[row.site_id] = row
    if plan_rows:
        candidates_by_site: dict[int, list[dict]] = {}
        for row in plan_rows:
            candidates_by_site.setdefault(int(row.site_id), []).append(_week_plan_debug_meta(row) or {})
        selected_by_site = {
            int(site_id): _week_plan_debug_meta(row)
            for site_id, row in preferred_plan_by_site.items()
        }
        logger.info(
            "[AUTO-PLANNING][LIST] preferred next-week plans director_id=%s week_iso=%s candidates=%s selected=%s",
            user.id,
            next_week_iso,
            candidates_by_site,
            selected_by_site,
        )
    linked_by_site = _linked_site_cluster_map_for_director(db, user.id, next_week_iso)
    return [
        SiteOut(
            id=s.id,
            name=s.name,
            workers_count=counts.get(s.id, 0),
            pending_workers_count=pending_counts.get(s.id, 0),
            config=_list_site_public_config(s.config, site_id=s.id),
            next_week_saved_plan_status=_build_next_week_saved_plan_status(
                s,
                preferred_plan_by_site.get(s.id),
                next_week_iso,
            ),
            linked_site_ids=linked_by_site.get(int(s.id), []),
        )
        for s in sites
    ]


@router.post("/", response_model=SiteOut, status_code=201)
def create_site(payload: SiteCreate, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    site = Site(name=payload.name, director_id=user.id, config=payload.config or None)
    db.add(site)
    db.commit()
    db.refresh(site)
    return SiteOut(
        id=site.id,
        name=site.name,
        workers_count=0,
        pending_workers_count=0,
        config=_safe_site_config(site.config, site_id=site.id),
        next_week_saved_plan_status=NextWeekSavedPlanStatus(
            exists=False,
            week_iso=_next_week_iso(datetime.now()),
            complete=None,
            assigned_count=0,
            required_count=0,
            pulls_count=0,
        ),
        linked_site_ids=[],
    )


def _norm_person_name(value: str | None) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).lower()


def _director_sites_by_id(db: Session, director_id: int) -> dict[int, Site]:
    sites = (
        db.query(Site)
        .options(load_only(Site.id, Site.name, Site.deleted_at, Site.director_id))
        .filter(Site.director_id == director_id)
        .all()
    )
    return {int(s.id): s for s in sites}


def _worker_outs_for_director_rows(
    db: Session,
    rows: list[SiteWorker],
    site_by_id: dict[int, Site],
) -> list[WorkerOut]:
    if not rows:
        return []
    current_week_iso = _week_start_date(datetime.now()).date().isoformat()
    candidate_user_ids = {int(r.user_id) for r in rows if getattr(r, "user_id", None)}
    candidate_phones = {str(r.phone).strip() for r in rows if str(getattr(r, "phone", "") or "").strip()}
    candidate_names = {_norm_person_name(getattr(r, "name", None)) for r in rows if _norm_person_name(getattr(r, "name", None))}

    user_filters = []
    if candidate_user_ids:
        user_filters.append(User.id.in_(candidate_user_ids))
    if candidate_phones:
        user_filters.append(User.phone.in_(candidate_phones))
    if candidate_names:
        user_filters.append(func.lower(User.full_name).in_(list(candidate_names)))

    candidate_users = (
        db.query(User)
        .filter(User.role == UserRole.worker)
        .filter(or_(*user_filters))
        .all()
        if user_filters
        else []
    )
    users_by_id = {int(u.id): u for u in candidate_users}
    users_by_phone = {str(u.phone).strip(): u for u in candidate_users if str(getattr(u, "phone", "") or "").strip()}
    users_by_name: dict[str, list[User]] = {}
    for u in candidate_users:
        users_by_name.setdefault(_norm_person_name(getattr(u, "full_name", None)), []).append(u)

    result: list[WorkerOut] = []
    for r in rows:
        user_worker = None
        phone = None
        worker_name = _norm_person_name(getattr(r, "name", None))

        if r.user_id:
            linked_user = users_by_id.get(int(r.user_id))
            if linked_user and _norm_person_name(getattr(linked_user, "full_name", None)) == worker_name:
                user_worker = linked_user
                phone = linked_user.phone

        if not user_worker and str(getattr(r, "phone", "") or "").strip():
            phone_user = users_by_phone.get(str(r.phone).strip())
            if phone_user and _norm_person_name(getattr(phone_user, "full_name", None)) == worker_name:
                user_worker = phone_user
                phone = phone_user.phone

        if not user_worker and worker_name:
            exact_matches = users_by_name.get(worker_name) or []
            if exact_matches:
                user_worker = exact_matches[0]
                phone = user_worker.phone

        if not phone:
            phone = r.phone
        sn = site_by_id.get(int(r.site_id))
        removed_from_week_iso = str(getattr(r, "removed_from_week_iso", "") or "").strip() or None
        removed_by_planning = bool(removed_from_week_iso and current_week_iso >= removed_from_week_iso)
        result.append(
            WorkerOut(
                id=r.id,
                site_id=r.site_id,
                created_at=getattr(r, "created_at", None),
                name=r.name,
                max_shifts=r.max_shifts,
                roles=r.roles or [],
                availability=r.availability or {},
                answers={},
                phone=phone,
                site_name=(sn.name if sn else None),
                site_deleted=bool(getattr(sn, "deleted_at", None)) if sn else False,
                removed_from_week_iso=removed_from_week_iso,
                removed_by_planning=removed_by_planning,
            )
        )
    return result


@router.get("/all-workers", response_model=list[WorkerOut])
def list_all_workers(user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    """Retourne tous les travailleurs de tous les sites du directeur (sites actifs ou archivés)."""
    site_by_id = _director_sites_by_id(db, user.id)
    site_ids = list(site_by_id.keys())
    if not site_ids:
        return []

    rows = list(
        db.query(SiteWorker)
        .options(
            load_only(
                SiteWorker.id,
                SiteWorker.site_id,
                SiteWorker.user_id,
                SiteWorker.name,
                SiteWorker.phone,
                SiteWorker.max_shifts,
                SiteWorker.roles,
                SiteWorker.availability,
                SiteWorker.created_at,
                SiteWorker.removed_from_week_iso,
            )
        )
        .filter(SiteWorker.site_id.in_(site_ids))
        .all()
    )
    if not rows:
        return []
    result = _worker_outs_for_director_rows(db, rows, site_by_id)
    logger.info("[all-workers] director=%s sites=%d workers=%d", user.id, len(site_ids), len(result))
    return result


@router.get("/all-workers/{worker_id}", response_model=list[WorkerOut])
def get_all_worker_cluster(
    worker_id: int,
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    """Fiche עובד : le worker demandé + ses occurrences sur les autres sites du directeur."""
    target = db.get(SiteWorker, worker_id)
    if not target:
        raise HTTPException(status_code=404, detail="Worker introuvable")
    site_by_id = _director_sites_by_id(db, user.id)
    if int(target.site_id) not in site_by_id:
        raise HTTPException(status_code=404, detail="Worker introuvable")

    site_ids = list(site_by_id.keys())
    rows = list(
        db.query(SiteWorker)
        .options(
            load_only(
                SiteWorker.id,
                SiteWorker.site_id,
                SiteWorker.user_id,
                SiteWorker.name,
                SiteWorker.phone,
                SiteWorker.max_shifts,
                SiteWorker.roles,
                SiteWorker.availability,
                SiteWorker.created_at,
                SiteWorker.removed_from_week_iso,
            )
        )
        .filter(SiteWorker.site_id.in_(site_ids))
        .all()
    )
    key = _worker_identity_key(target)
    cluster = [row for row in rows if _worker_identity_key(row) == key]
    if not any(int(row.id) == int(worker_id) for row in cluster):
        cluster = [target] + cluster
    return _worker_outs_for_director_rows(db, cluster, site_by_id)


@router.get("/{site_id}", response_model=SiteOut)
def get_site(site_id: int, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    next_week_iso = _next_week_iso(datetime.now())
    counts, pending_counts = _workers_counts_by_site_for_week(
        db, user.id, next_week_iso, site_ids=[int(site.id)],
    )
    workers_count = counts.get(int(site.id), 0)
    pending_workers_count = pending_counts.get(int(site.id), 0)
    plan_rows = (
        db.query(SiteWeekPlan)
        .filter(SiteWeekPlan.site_id == site.id)
        .filter(SiteWeekPlan.week_iso == next_week_iso)
        .filter(SiteWeekPlan.scope.in_(["auto", "director", "shared"]))
        .all()
    )
    plan_rows = [row for row in plan_rows if not _is_empty_auto_week_plan(site, row, next_week_iso)]
    preferred_row = _preferred_week_plan(plan_rows)
    linked_by_site = _linked_site_cluster_map_for_director(db, user.id)
    return SiteOut(
        id=site.id,
        name=site.name,
        workers_count=workers_count,
        pending_workers_count=pending_workers_count,
        config=_safe_site_config(site.config, site_id=site.id),
        next_week_saved_plan_status=_build_next_week_saved_plan_status(site, preferred_row, next_week_iso),
        linked_site_ids=linked_by_site.get(int(site.id), []),
        deleted_at=getattr(site, "deleted_at", None),
    )


@router.get("/{site_id}/worker-invite", response_model=WorkerInviteLinkOut)
def get_worker_invite_link(site_id: int, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    if getattr(site, "deleted_at", None):
        raise HTTPException(status_code=404, detail="Site introuvable")
    ensure_director_code(user, db)
    token = create_worker_invite_token(site_id=int(site.id), director_id=int(user.id), db=db)
    db.commit()
    db.refresh(user)
    return WorkerInviteLinkOut(token=token, invite_path=f"/invite/worker/{token}")


@router.delete("/{site_id}", status_code=204)
def delete_site(site_id: int, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    site: Site | None = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    if getattr(site, "deleted_at", None):
        raise HTTPException(status_code=404, detail="Site introuvable")
    # Soft-delete : conserve site_workers, site_week_plans, etc. — plus d’accès actif via _director_site_or_404
    site.deleted_at = _now_ms()
    db.commit()
    return None


@router.put("/{site_id}", response_model=SiteOut)
def update_site(site_id: int, payload: SiteUpdate, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    if getattr(site, "deleted_at", None):
        raise HTTPException(status_code=404, detail="Site introuvable")
    if payload.name is not None:
        site.name = payload.name
    if payload.config is not None:
        # validation logique: total rôles <= travailleurs
        try:
            normalized = normalize_site_config(payload.config)
            validate_site_config(normalized)
            payload.config = normalized
        except HTTPException:
            raise
        except Exception:
            pass
        site.config = payload.config
    db.commit()
    db.refresh(site)
    next_week_iso = _next_week_iso(datetime.now())
    counts, pending_counts = _workers_counts_by_site_for_week(
        db, user.id, next_week_iso, site_ids=[int(site.id)],
    )
    workers_count = counts.get(int(site.id), 0)
    pending_workers_count = pending_counts.get(int(site.id), 0)
    linked_by_site = _linked_site_cluster_map_for_director(db, user.id)
    return SiteOut(
        id=site.id,
        name=site.name,
        workers_count=workers_count,
        pending_workers_count=pending_workers_count,
        config=_safe_site_config(site.config, site_id=site.id),
        linked_site_ids=linked_by_site.get(int(site.id), []),
        deleted_at=None,
    )

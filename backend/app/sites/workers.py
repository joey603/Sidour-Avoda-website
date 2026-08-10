from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Body, Response
from sqlalchemy import func
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

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

from .solver_bridge import (
    _apply_shift_kind_prefs_to_answers,
    _apply_shift_slot_prefs_to_answers,
    _shift_kind_prefs_from_answers,
    _shift_slot_prefs_from_answers,
)
from .linked_sites import (
    _linked_site_ids_for_worker,
    _linked_site_ids_by_worker_key,
    _active_director_site_ids,
    _worker_identity_key,
)

@router.get("/{site_id}/workers", response_model=list[WorkerOut])
def list_workers(
    site_id: int,
    week: str | None = Query(None, description="YYYY-MM-DD (week start)"),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_ownership_or_404(db, site_id, user.id)
    wk = _validate_week_iso(week) if week else None
    rows = [row for row in db.query(SiteWorker).filter(SiteWorker.site_id == site_id).all() if _site_worker_visible_for_week(row, wk)]
    director_sites = db.query(Site).filter(Site.director_id == user.id).all()
    director_site_name_by_id = {int(s.id): s.name for s in director_sites}
    director_site_ids = [int(s.id) for s in director_sites]
    active_director_site_ids = _active_director_site_ids(db, user.id)
    director_rows = (
        [row for row in db.query(SiteWorker).filter(SiteWorker.site_id.in_(director_site_ids)).all() if _site_worker_visible_for_week(row, wk)]
        if director_site_ids
        else []
    )
    linked_site_ids_by_key = _linked_site_ids_by_worker_key(director_rows, wk, active_director_site_ids)

    user_ids = sorted({int(r.user_id) for r in rows if getattr(r, "user_id", None)})
    users_by_id = {
        int(u.id): u
        for u in (
            db.query(User)
            .filter(User.id.in_(user_ids))
            .all()
            if user_ids
            else []
        )
    }
    phones = sorted({str(r.phone).strip() for r in rows if getattr(r, "phone", None)})
    users_by_phone = {
        str(u.phone).strip(): u
        for u in (
            db.query(User)
            .filter(User.role == UserRole.worker, User.phone.in_(phones))
            .all()
            if phones
            else []
        )
        if getattr(u, "phone", None)
    }

    unmatched_name_keys = {
        re.sub(r"\s+", " ", str(r.name or "").strip()).lower()
        for r in rows
        if not getattr(r, "user_id", None) and not getattr(r, "phone", None)
    }
    users_by_name_key: dict[str, User] = {}
    if unmatched_name_keys:
        for worker_user in (
            db.query(User)
            .filter(User.role == UserRole.worker, func.lower(User.full_name).in_(list(unmatched_name_keys)))
            .all()
        ):
            user_name_key = re.sub(r"\s+", " ", str(worker_user.full_name or "").strip()).lower()
            if user_name_key and user_name_key in unmatched_name_keys and user_name_key not in users_by_name_key:
                users_by_name_key[user_name_key] = worker_user
    result = []
    for r in rows:
        user_worker = None
        phone = None
        
        # PRIORITÉ 1: Utiliser user_id si disponible (lien direct)
        if r.user_id:
            user_worker = users_by_id.get(int(r.user_id))
            if user_worker:
                phone = user_worker.phone
            else:
                logger.warning(f"[list_workers] Worker '{r.name}' (id={r.id}): user_id={r.user_id} points to non-existent User")
        
        # PRIORITÉ 2: si pas de user_id mais phone présent dans SiteWorker, chercher par téléphone
        if not user_worker and r.phone:
            user_worker = users_by_phone.get(str(r.phone).strip())
            if user_worker:
                phone = user_worker.phone

        # PRIORITÉ 3: Si pas de user_id, chercher par nom
        if not user_worker:
            worker_name_clean = re.sub(r'\s+', ' ', (r.name or "").strip()).lower()
            user_worker = users_by_name_key.get(worker_name_clean)
            if user_worker:
                phone = user_worker.phone

        if not phone:
            phone = r.phone
        
        linked_site_ids = linked_site_ids_by_key.get(_worker_identity_key(r), [int(r.site_id)])
        linked_site_names = [director_site_name_by_id[sid] for sid in linked_site_ids if sid in director_site_name_by_id]
        result.append(WorkerOut(
            id=r.id,
            site_id=r.site_id,
            created_at=getattr(r, "created_at", None),
            name=r.name,
            max_shifts=r.max_shifts,
            roles=r.roles or [],
            availability=r.availability or {},
            answers=r.answers or {},
            phone=phone,
            linked_site_ids=linked_site_ids,
            linked_site_names=linked_site_names,
            pending_approval=bool(getattr(r, "pending_approval", False)),
        ))
    return result


def _normalize_worker_phone_for_password(phone: str | None) -> str:
    return "".join(ch for ch in str(phone or "") if ch.isdigit()).strip()


@router.post("/{site_id}/create-worker-user", response_model=UserOut, status_code=201)
def create_worker_user(site_id: int, payload: CreateWorkerUserRequest, db: Session = Depends(get_db), user: User = Depends(require_role("director"))):
    """Créer un utilisateur worker avec nom et téléphone depuis le directeur"""
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    phone = _normalize_worker_phone_for_password(payload.phone)
    if not phone:
        raise HTTPException(status_code=400, detail="Numéro de téléphone requis")

    existing_phone = db.query(User).filter(User.phone == phone).first()
    if existing_phone:
        if existing_phone.role != UserRole.worker:
            raise HTTPException(status_code=400, detail="Numéro de téléphone déjà enregistré")
        existing_phone.full_name = payload.name
        existing_phone.hashed_password = pwd_context.hash(phone)
        db.commit()
        db.refresh(existing_phone)
        return UserOut(
            id=existing_phone.id,
            email=existing_phone.email,
            full_name=existing_phone.full_name,
            role=existing_phone.role.value,
            phone=existing_phone.phone,
        )
    
    # Créer l'utilisateur worker
    worker_user = User(
        email=None,
        full_name=payload.name,
        hashed_password=pwd_context.hash(phone),
        role=UserRole.worker,
        phone=phone,
    )
    db.add(worker_user)
    db.commit()
    db.refresh(worker_user)
    logger.info(f"[create-worker-user] Created User worker '{payload.name}' (id={worker_user.id}, phone={payload.phone}) for site {site_id}")
    
    return UserOut(id=worker_user.id, email=worker_user.email, full_name=worker_user.full_name, role=worker_user.role.value, phone=worker_user.phone)


@router.post("/{site_id}/workers", response_model=WorkerOut, status_code=201)
def create_worker(site_id: int, payload: WorkerCreate, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    try:
        site = db.get(Site, site_id)
        if not site or site.director_id != user.id:
            logger.error(f"[create-worker] Site {site_id} not found or not owned by director {user.id}")
            raise HTTPException(status_code=404, detail="Site introuvable")
        logger.info(f"[create-worker] Creating worker '{payload.name}' for site {site_id} (director_id={user.id})")
        effective_created_at_ms = _now_ms()
        target_week_iso = _validate_week_iso(payload.week_iso) if payload.week_iso else None
        if payload.week_iso:
            wk = _validate_week_iso(payload.week_iso)
            effective_created_at_ms = int(_week_start_date(datetime.fromisoformat(wk)).timestamp() * 1000)

        def _copy_weekly_availability_from_linked_sites(target_row: SiteWorker) -> None:
            if not target_week_iso:
                return
            try:
                director_site_ids = sorted(_active_director_site_ids(db, user.id))
                if len(director_site_ids) <= 1:
                    return
                all_rows = db.query(SiteWorker).filter(SiteWorker.site_id.in_(director_site_ids)).all()
                target_key = _worker_identity_key(target_row)
                if not target_key:
                    return
                linked_rows = [
                    r
                    for r in all_rows
                    if _worker_identity_key(r) == target_key
                    and not bool(getattr(r, "pending_approval", False))
                    and _site_worker_visible_for_week(r, target_week_iso)
                ]
                if len(linked_rows) <= 1:
                    return

                source_site_ids = sorted({int(r.site_id) for r in linked_rows if int(r.site_id) != int(target_row.site_id)})
                if not source_site_ids:
                    return
                weekly_rows = (
                    db.query(SiteWeeklyAvailability)
                    .filter(SiteWeeklyAvailability.site_id.in_(source_site_ids))
                    .filter(SiteWeeklyAvailability.week_iso == target_week_iso)
                    .all()
                )
                weekly_by_site = {int(r.site_id): r for r in weekly_rows}

                source_weekly_availability: dict[str, list[str]] | None = None
                for linked_row in linked_rows:
                    linked_site_id = int(linked_row.site_id)
                    if linked_site_id == int(target_row.site_id):
                        continue
                    weekly_row = weekly_by_site.get(linked_site_id)
                    if not weekly_row:
                        continue
                    weekly_map = weekly_row.availability if isinstance(weekly_row.availability, dict) else {}
                    candidate = weekly_map.get(str(linked_row.name))
                    if isinstance(candidate, dict):
                        source_weekly_availability = {
                            str(day_key): [str(shift_name) for shift_name in shifts if str(shift_name or "").strip()]
                            for day_key, shifts in candidate.items()
                            if isinstance(shifts, list)
                        }
                        if source_weekly_availability:
                            break
                if not source_weekly_availability:
                    return

                target_weekly_row = (
                    db.query(SiteWeeklyAvailability)
                    .filter(SiteWeeklyAvailability.site_id == int(target_row.site_id))
                    .filter(SiteWeeklyAvailability.week_iso == target_week_iso)
                    .first()
                )
                now = _now_ms()
                if target_weekly_row:
                    data = dict(target_weekly_row.availability or {})
                    data[str(target_row.name)] = source_weekly_availability
                    target_weekly_row.availability = data
                    target_weekly_row.updated_at = now
                else:
                    target_weekly_row = SiteWeeklyAvailability(
                        site_id=int(target_row.site_id),
                        week_iso=target_week_iso,
                        availability={str(target_row.name): source_weekly_availability},
                        updated_at=now,
                    )
                    db.add(target_weekly_row)
            except Exception:
                logger.warning(
                    "[create-worker] weekly availability copy skipped for worker='%s' site=%s week=%s",
                    getattr(target_row, "name", ""),
                    getattr(target_row, "site_id", ""),
                    target_week_iso,
                )
        
        normalized_payload_phone = _normalize_worker_phone_for_password(payload.phone)

        # Chercher le User correspondant par nom ET téléphone (si disponible)
        user_worker = None
        if normalized_payload_phone:
            # Chercher d'abord par téléphone (plus fiable)
            existing_user_by_phone = db.query(User).filter(User.phone == normalized_payload_phone).first()
            if existing_user_by_phone:
                if existing_user_by_phone.role != UserRole.worker:
                    raise HTTPException(status_code=400, detail="Numéro de téléphone déjà enregistré")
                user_worker = existing_user_by_phone
        
        # Si pas trouvé par téléphone, chercher par nom
        if not user_worker:
            worker_name_clean = re.sub(r'\s+', ' ', (payload.name or "").strip()).lower()
            user_worker = (
                db.query(User)
                .filter(User.role == UserRole.worker, func.lower(User.full_name) == worker_name_clean)
                .first()
            )
            if user_worker:
                logger.info(f"[create-worker] Found User by name '{payload.name}' (id={user_worker.id})")

        if normalized_payload_phone:
            if not user_worker:
                user_worker = User(
                    email=None,
                    full_name=payload.name,
                    hashed_password=pwd_context.hash(normalized_payload_phone),
                    role=UserRole.worker,
                    phone=normalized_payload_phone,
                )
                db.add(user_worker)
                db.flush()
            else:
                user_worker.full_name = payload.name
                user_worker.phone = normalized_payload_phone
                user_worker.hashed_password = pwd_context.hash(normalized_payload_phone)
        
        # Vérifier si un worker avec ce nom existe déjà
        existing = (
            db.query(SiteWorker)
            .filter(
                SiteWorker.site_id == site_id,
                func.lower(SiteWorker.name) == func.lower(payload.name),
            )
            .first()
        )
        if existing:
            # Si le worker existe déjà, mettre à jour ses données et le lier au User si nécessaire
            logger.info(f"[create-worker] Worker '{payload.name}' already exists (id={existing.id}), updating")
            existing.removed_from_week_iso = None
            existing.created_at = effective_created_at_ms
            existing.max_shifts = payload.max_shifts
            existing.roles = payload.roles or []
            # IMPORTANT: ne pas écraser les זמינות soumises par le travailleur.
            # Côté directeur, on n'envoie souvent pas "availability" (ou un dict vide),
            # ce qui ne doit pas reset la disponibilité globale.
            if payload.availability is not None and len(payload.availability) > 0:
                existing.availability = payload.availability
            if payload.answers is not None and len(payload.answers) > 0:
                existing.answers = payload.answers
            if payload.phone:
                existing.phone = normalized_payload_phone
            # Lier au User si pas déjà lié et qu'on a trouvé un User
            if user_worker and not existing.user_id:
                existing.user_id = user_worker.id
                logger.info(f"[create-worker] Linked existing worker '{payload.name}' to User id={user_worker.id}")
            if existing.user_id:
                linked_rows = db.query(SiteWorker).filter(SiteWorker.user_id == existing.user_id).all()
                for linked_row in linked_rows:
                    linked_row.max_shifts = payload.max_shifts
            _copy_weekly_availability_from_linked_sites(existing)
            db.commit()
            db.refresh(existing)
            # Récupérer le téléphone du User lié
            phone = None
            if existing.user_id:
                linked_user = db.get(User, existing.user_id)
                phone = linked_user.phone if linked_user else None
            linked_site_ids = _linked_site_ids_for_worker(db, user.id, existing)
            linked_site_name_by_id = {int(s.id): s.name for s in db.query(Site).filter(Site.director_id == user.id).all()}
            return WorkerOut(id=existing.id, site_id=existing.site_id, created_at=getattr(existing, "created_at", None), name=existing.name, max_shifts=existing.max_shifts, roles=existing.roles or [], availability=existing.availability or {}, answers=existing.answers or {}, phone=phone, linked_site_ids=linked_site_ids, linked_site_names=[linked_site_name_by_id[sid] for sid in linked_site_ids if sid in linked_site_name_by_id], pending_approval=bool(getattr(existing, "pending_approval", False)))
        
        # Créer un nouveau worker avec le lien au User si trouvé
        w = SiteWorker(
            site_id=site_id, 
            name=payload.name, 
            phone=normalized_payload_phone or None,
            max_shifts=payload.max_shifts, 
            roles=payload.roles or [], 
            availability=payload.availability or {},
            answers=payload.answers or {},
            user_id=user_worker.id if user_worker else None,
            pending_approval=False,
            created_at=effective_created_at_ms,
        )
        db.add(w)
        db.flush()
        if w.user_id:
            linked_rows = db.query(SiteWorker).filter(SiteWorker.user_id == w.user_id).all()
            for linked_row in linked_rows:
                linked_row.max_shifts = payload.max_shifts
        _copy_weekly_availability_from_linked_sites(w)
        if payload.week_iso and payload.shift_kind_prefs is not None:
            _apply_shift_kind_prefs_to_answers(
                w,
                _validate_week_iso(payload.week_iso),
                payload.shift_kind_prefs.model_dump(),
            )
        if payload.week_iso and payload.shift_slot_prefs is not None:
            _apply_shift_slot_prefs_to_answers(
                w,
                _validate_week_iso(payload.week_iso),
                payload.shift_slot_prefs,
            )
        db.commit()
        db.refresh(w)
        logger.info(f"[create-worker] Created SiteWorker '{payload.name}' (id={w.id}) for site {site_id}, linked to User id={w.user_id}")
        phone = user_worker.phone if user_worker else None
        linked_site_ids = _linked_site_ids_for_worker(db, user.id, w)
        linked_site_name_by_id = {int(s.id): s.name for s in db.query(Site).filter(Site.director_id == user.id).all()}
        return WorkerOut(id=w.id, site_id=w.site_id, created_at=getattr(w, "created_at", None), name=w.name, max_shifts=w.max_shifts, roles=w.roles or [], availability=w.availability or {}, answers=w.answers or {}, phone=phone, linked_site_ids=linked_site_ids, linked_site_names=[linked_site_name_by_id[sid] for sid in linked_site_ids if sid in linked_site_name_by_id], pending_approval=bool(getattr(w, "pending_approval", False)))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[create-worker] Unexpected error creating worker '{payload.name}' for site {site_id}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Erreur lors de la création du travailleur: {str(e)}")


@router.post("/{site_id}/workers/{worker_id}/reset-password-to-phone")
def reset_worker_password_to_phone(
    site_id: int,
    worker_id: int,
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    worker: SiteWorker | None = db.get(SiteWorker, worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker introuvable")
    worker_site = db.get(Site, worker.site_id)
    if not worker_site or worker_site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Worker introuvable")

    phone = _normalize_worker_phone_for_password(getattr(worker, "phone", None))
    user_worker: User | None = db.get(User, worker.user_id) if getattr(worker, "user_id", None) else None
    if user_worker and user_worker.phone:
        phone = _normalize_worker_phone_for_password(user_worker.phone)
    if not phone:
        raise HTTPException(status_code=400, detail="Ce travailleur n'a pas de numéro de téléphone")

    if user_worker is None:
        existing = db.query(User).filter(User.phone == phone).first()
        if existing and existing.role != UserRole.worker:
            raise HTTPException(status_code=400, detail="Numéro de téléphone déjà enregistré")
        user_worker = existing

    if user_worker is None:
        user_worker = User(
            email=None,
            full_name=worker.name,
            hashed_password=pwd_context.hash(phone),
            role=UserRole.worker,
            phone=phone,
        )
        db.add(user_worker)
        db.flush()
    else:
        user_worker.full_name = worker.name
        user_worker.phone = phone
        user_worker.hashed_password = pwd_context.hash(phone)

    worker.user_id = user_worker.id
    worker.phone = phone
    db.commit()
    return {"ok": True}


@router.put("/{site_id}/workers/{worker_id}", response_model=WorkerOut)
def update_worker(site_id: int, worker_id: int, payload: WorkerUpdate, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    w: SiteWorker | None = db.get(SiteWorker, worker_id)
    if not w or w.site_id != site_id:
        raise HTTPException(status_code=404, detail="Worker introuvable")
    # Unicité par site du nom (insensible à la casse), en excluant le worker courant
    if payload.name and payload.name.strip():
        exists = (
            db.query(SiteWorker.id)
            .filter(
                SiteWorker.site_id == site_id,
                SiteWorker.id != worker_id,
                func.lower(SiteWorker.name) == func.lower(payload.name),
            )
            .first()
        )
        if exists:
            raise HTTPException(status_code=400, detail="שם עובד כבר קיים באתר")
    # --- Update identity (name/phone) ---
    old_name = w.name
    old_phone = w.phone
    old_user_id = w.user_id
    w.name = payload.name

    # Trouver le User worker "source of truth" uniquement si nécessaire
    name_changed = str(payload.name or "") != str(old_name or "")
    needs_user_lookup = bool(old_user_id) or payload.phone is not None or name_changed
    user_worker: User | None = None
    if needs_user_lookup and old_user_id:
        cand = db.get(User, old_user_id)
        if cand and cand.role == UserRole.worker:
            user_worker = cand
    if needs_user_lookup and not user_worker and old_phone:
        user_worker = db.query(User).filter(User.role == UserRole.worker, User.phone == old_phone).first()
    if needs_user_lookup and not user_worker and old_name:
        user_worker = db.query(User).filter(User.role == UserRole.worker, func.lower(User.full_name) == func.lower(old_name)).first()

    # Mettre à jour le téléphone si fourni (et propager au User worker pour que la connexion change aussi)
    if payload.phone is not None:
        new_phone = _normalize_worker_phone_for_password(payload.phone) or None

        # Si on ne change pas réellement de téléphone, ne pas lever d'erreur
        if new_phone and user_worker and user_worker.phone == new_phone:
            pass
        elif new_phone:
            conflict = db.query(User).filter(
                User.phone == new_phone,
                User.role == UserRole.worker,
                User.id != (user_worker.id if user_worker else -1),
            ).first()
            if conflict:
                raise HTTPException(status_code=400, detail="Numéro de téléphone déjà enregistré")

        # Si aucun user worker n'existe et qu'on a un phone, en créer un (pour permettre login worker)
        if not user_worker and new_phone:
            user_worker = User(
                email=None,
                full_name=payload.name,
                hashed_password=pwd_context.hash(new_phone),
                role=UserRole.worker,
                phone=new_phone,
            )
            db.add(user_worker)
            db.flush()

        # Propager au user si trouvé/créé
        if user_worker:
            user_worker.full_name = payload.name
            if new_phone is not None:
                user_worker.phone = new_phone
                user_worker.hashed_password = pwd_context.hash(new_phone)
            w.user_id = user_worker.id
        # Mettre à jour aussi la colonne phone du SiteWorker (fallback / lien)
        w.phone = new_phone
    else:
        # Changement de nom uniquement: propager au User pour que la connexion (nom+tel) utilise le nouveau nom
        if user_worker:
            user_worker.full_name = payload.name
            w.user_id = user_worker.id

    # --- Update the rest ---
    w.max_shifts = payload.max_shifts
    w.roles = payload.roles or []
    # Ne mettre à jour availability que si elle est explicitement fournie et non vide
    # Pour éviter d'écraser les זמינות soumises par le travailleur
    if payload.availability is not None and len(payload.availability) > 0:
        w.availability = payload.availability
    # Mettre à jour les réponses si elles sont fournies (même si vides, car elles peuvent contenir des structures par semaine)
    # Important: préserver la structure par semaine {week_key: {general: {}, perDay: {}}}
    if payload.answers is not None:
        # Si les réponses sont un dict (structure par semaine), les fusionner au lieu de les remplacer complètement
        if isinstance(payload.answers, dict) and isinstance(w.answers, dict):
            # Fusionner les réponses: garder les semaines existantes et mettre à jour celles fournies
            merged_answers = dict(w.answers)  # Copie des réponses existantes
            merged_answers.update(payload.answers)  # Mettre à jour avec les nouvelles
            w.answers = merged_answers
        else:
            # Si ce n'est pas un dict ou si les réponses existantes ne sont pas un dict, remplacer complètement
            w.answers = payload.answers
    linked_rows_for_return: list[SiteWorker] | None = None
    if payload.week_iso and isinstance(payload.weekly_availability, dict):
        wk = _validate_week_iso(payload.week_iso)
        now = _now_ms()
        cleaned_weekly_availability = {
            day_key: [str(shift_name) for shift_name in shifts_list if str(shift_name or "").strip()]
            for day_key, shifts_list in (payload.weekly_availability or {}).items()
            if isinstance(shifts_list, list)
        }
        target_rows_for_availability: list[SiteWorker] = [w]
        if payload.propagate_linked_availability:
            if w.user_id:
                linked_rows_for_return = db.query(SiteWorker).filter(SiteWorker.user_id == w.user_id).all()
            else:
                linked_site_ids = _linked_site_ids_for_worker(db, user.id, w)
                linked_rows_for_return = db.query(SiteWorker).filter(SiteWorker.site_id.in_(linked_site_ids)).all()
            target_rows_for_availability = [
                linked_row
                for linked_row in linked_rows_for_return
                if _worker_identity_key(linked_row) == _worker_identity_key(w)
            ]

        target_site_ids = sorted({int(row.site_id) for row in target_rows_for_availability}) or [int(site_id)]
        weekly_rows = (
            db.query(SiteWeeklyAvailability)
            .filter(SiteWeeklyAvailability.site_id.in_(target_site_ids))
            .filter(SiteWeeklyAvailability.week_iso == wk)
            .all()
        ) if target_site_ids else []
        weekly_row_by_site_id = {int(row.site_id): row for row in weekly_rows}

        for target_row in target_rows_for_availability:
            target_site_id = int(target_row.site_id)
            weekly_row = weekly_row_by_site_id.get(target_site_id)
            data = dict((weekly_row.availability or {}) if weekly_row else {})
            data[str(target_row.name)] = cleaned_weekly_availability
            if weekly_row:
                weekly_row.availability = data
                weekly_row.updated_at = now
            else:
                weekly_row = SiteWeeklyAvailability(site_id=target_site_id, week_iso=wk, availability=data, updated_at=now)
                db.add(weekly_row)
                weekly_row_by_site_id[target_site_id] = weekly_row

    # Préférences soft matin/midi/nuit (même semaine que la זמינות directeur)
    if payload.week_iso:
        prefs_wk = _validate_week_iso(payload.week_iso)
        prefs_rows: list[SiteWorker] = [w]
        if payload.propagate_linked_availability:
            if linked_rows_for_return is None:
                if w.user_id:
                    linked_rows_for_return = db.query(SiteWorker).filter(SiteWorker.user_id == w.user_id).all()
                else:
                    linked_site_ids_tmp = _linked_site_ids_for_worker(db, user.id, w)
                    linked_rows_for_return = (
                        db.query(SiteWorker).filter(SiteWorker.site_id.in_(linked_site_ids_tmp)).all()
                    )
            prefs_rows = [
                linked_row
                for linked_row in (linked_rows_for_return or [])
                if _worker_identity_key(linked_row) == _worker_identity_key(w)
            ] or [w]
        prefs_payload = (
            payload.shift_kind_prefs.model_dump()
            if payload.shift_kind_prefs is not None
            else None
        )
        slot_prefs_payload = (
            payload.shift_slot_prefs
            if payload.shift_slot_prefs is not None
            else None
        )
        for prefs_row in prefs_rows:
            _apply_shift_kind_prefs_to_answers(prefs_row, prefs_wk, prefs_payload)
            if "shift_slot_prefs" in payload.model_fields_set:
                _apply_shift_slot_prefs_to_answers(prefs_row, prefs_wk, slot_prefs_payload)

    if w.user_id:
        linked_rows_for_return = linked_rows_for_return or db.query(SiteWorker).filter(SiteWorker.user_id == w.user_id).all()
        for linked_row in linked_rows_for_return:
            linked_row.max_shifts = payload.max_shifts
    db.commit()
    phone = user_worker.phone if user_worker and getattr(user_worker, "phone", None) else w.phone
    if linked_rows_for_return is not None:
        linked_site_ids = sorted({int(row.site_id) for row in linked_rows_for_return}) or [int(w.site_id)]
    else:
        linked_site_ids = _linked_site_ids_for_worker(db, user.id, w)
    linked_site_name_by_id = {
        int(s.id): s.name
        for s in db.query(Site).filter(Site.director_id == user.id).all()
    }
    return WorkerOut(id=w.id, site_id=w.site_id, created_at=getattr(w, "created_at", None), name=w.name, max_shifts=w.max_shifts, roles=w.roles or [], availability=w.availability or {}, answers=w.answers or {}, phone=phone, linked_site_ids=linked_site_ids, linked_site_names=[linked_site_name_by_id[sid] for sid in linked_site_ids if sid in linked_site_name_by_id], pending_approval=bool(getattr(w, "pending_approval", False)))


@router.post("/{site_id}/workers/{worker_id}/approve-invite", response_model=WorkerOut)
def approve_pending_worker(site_id: int, worker_id: int, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    w: SiteWorker | None = db.get(SiteWorker, worker_id)
    if not w or w.site_id != site_id:
        raise HTTPException(status_code=404, detail="Worker introuvable")
    w.pending_approval = False
    db.commit()
    db.refresh(w)
    phone = None
    if w.user_id:
        linked_user = db.get(User, w.user_id)
        phone = linked_user.phone if linked_user else None
    if not phone:
        phone = w.phone
    linked_site_ids = _linked_site_ids_for_worker(db, user.id, w)
    linked_site_name_by_id = {int(s.id): s.name for s in db.query(Site).filter(Site.director_id == user.id).all()}
    return WorkerOut(
        id=w.id,
        site_id=w.site_id,
        created_at=getattr(w, "created_at", None),
        name=w.name,
        max_shifts=w.max_shifts,
        roles=w.roles or [],
        availability=w.availability or {},
        answers=w.answers or {},
        phone=phone,
        linked_site_ids=linked_site_ids,
        linked_site_names=[linked_site_name_by_id[sid] for sid in linked_site_ids if sid in linked_site_name_by_id],
        pending_approval=False,
    )


@router.delete("/{site_id}/workers/{worker_id}/reject-invite", status_code=204)
def reject_pending_worker(site_id: int, worker_id: int, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    w: SiteWorker | None = db.get(SiteWorker, worker_id)
    if not w or w.site_id != site_id:
        raise HTTPException(status_code=404, detail="Worker introuvable")
    db.delete(w)
    db.commit()
    return None


@router.delete("/{site_id}/workers/{worker_id}", status_code=204)
def delete_worker(
    site_id: int,
    worker_id: int,
    week: str | None = Query(None),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    """
    Retire le travailleur du planning à partir du dimanche de la semaine en cours (clé semaine de l'app).
    Les semaines strictement antérieures restent consultables avec ce travailleur dans l'historique.
    """
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    w: SiteWorker | None = db.get(SiteWorker, worker_id)
    if not w or w.site_id != site_id:
        raise HTTPException(status_code=404, detail="Travailleur introuvable sur ce site")

    target_week_iso = _validate_week_iso(week) if week else _week_start_date(datetime.now()).date().isoformat()
    w.removed_from_week_iso = target_week_iso
    db.commit()
    logger.info(
        f"[delete-worker] Worker '{w.name}' (id={worker_id}) removed from site {site_id} from week {w.removed_from_week_iso}"
    )

    return Response(status_code=204)

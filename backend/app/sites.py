from fastapi import APIRouter, Depends, HTTPException, Query
from starlette.requests import Request
from fastapi.responses import StreamingResponse
import asyncio
from fastapi import Body, Response
from sqlalchemy import func
from sqlalchemy.orm import Session
import re

from .deps import require_role, get_db
from .models import Site, SiteAssignment, SiteWorker, SiteMessage, User, UserRole
from .schemas import (
    SiteCreate,
    SiteOut,
    SiteUpdate,
    WorkerCreate,
    WorkerUpdate,
    WorkerOut,
    AIPlanningRequest,
    AIPlanningResponse,
    UserOut,
    CreateWorkerUserRequest,
    SiteMessageCreate,
    SiteMessageUpdate,
    SiteMessageOut,
)
from .ai_solver import solve_schedule, solve_schedule_stream
from passlib.context import CryptContext
import logging
import secrets
logger = logging.getLogger("ai_solver")

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

router = APIRouter(prefix="/director/sites", tags=["sites"])


_WEEK_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _validate_week_iso(week_iso: str) -> str:
    wk = (week_iso or "").strip()
    if not _WEEK_ISO_RE.match(wk):
        raise HTTPException(status_code=400, detail="week_iso invalide (YYYY-MM-DD)")
    return wk


def _now_ms() -> int:
    import time
    return int(time.time() * 1000)


def _director_site_or_404(db: Session, site_id: int, director_id: int) -> Site:
    site = db.get(Site, site_id)
    if not site:
        raise HTTPException(status_code=404, detail="Site introuvable")
    if site.director_id != director_id:
        raise HTTPException(status_code=403, detail="Accès interdit")
    return site


@router.get("/{site_id}/messages", response_model=list[SiteMessageOut])
def list_site_messages(
    site_id: int,
    week: str = Query(..., description="YYYY-MM-DD (week start)"),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_or_404(db, site_id, user.id)
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


def validate_site_config(config: dict):
    stations = (config or {}).get("stations", []) or []
    for st in stations:
        uniform_roles = bool(st.get("uniformRoles"))
        station_workers = int(st.get("workers") or 0)
        # Uniform: sum roles <= station workers
        if uniform_roles:
            total_roles = 0
            for r in (st.get("roles") or []):
                try:
                    if r and r.get("enabled"):
                        total_roles += int(r.get("count") or 0)
                except Exception:
                    pass
            if total_roles > station_workers:
                raise HTTPException(status_code=400, detail="סך התפקידים חייב להיות קטן או שווה למספר העובדים לעמדה")
        # Global shifts (non-uniform): sum roles per shift <= shift workers
        if not uniform_roles:
            for sh in (st.get("shifts") or []):
                if not sh or not sh.get("enabled"):
                    continue
                sh_workers = int(sh.get("workers") or 0)
                total_roles = 0
                for r in (sh.get("roles") or []):
                    try:
                        if r and r.get("enabled"):
                            total_roles += int(r.get("count") or 0)
                    except Exception:
                        pass
                if total_roles > sh_workers:
                    raise HTTPException(status_code=400, detail="סך התפקידים למשמרת חייב להיות קטן או שווה למספר העובדים למשמרת")
        # Per-day overrides: same rule per active day and shift when non-uniform
        if st.get("perDayCustom"):
            day_overrides = st.get("dayOverrides") or {}
            for day_key, ov in (day_overrides or {}).items():
                if not ov or not ov.get("active"):
                    continue
                if not uniform_roles:
                    for sh in (ov.get("shifts") or []):
                        if not sh or not sh.get("enabled"):
                            continue
                        sh_workers = int(sh.get("workers") or 0)
                        total_roles = 0
                        for r in (sh.get("roles") or []):
                            try:
                                if r and r.get("enabled"):
                                    total_roles += int(r.get("count") or 0)
                            except Exception:
                                pass
                        if total_roles > sh_workers:
                            raise HTTPException(status_code=400, detail="סך התפקידים למשמרת חייב להיות קטן או שווה למספר העובדים למשמרת")

@router.get("/", response_model=list[SiteOut])
def list_sites(user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    rows = (
        db.query(Site.id, Site.name, Site.config, func.count(SiteWorker.id).label("workers_count"))
        .outerjoin(SiteWorker, SiteWorker.site_id == Site.id)
        .filter(Site.director_id == user.id)
        .group_by(Site.id)
        .all()
    )
    return [SiteOut(id=r.id, name=r.name, workers_count=r.workers_count, config=r.config) for r in rows]


@router.post("/", response_model=SiteOut, status_code=201)
def create_site(payload: SiteCreate, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    site = Site(name=payload.name, director_id=user.id, config=payload.config or None)
    db.add(site)
    db.commit()
    db.refresh(site)
    return SiteOut(id=site.id, name=site.name, workers_count=0, config=site.config)


@router.get("/all-workers", response_model=list[WorkerOut])
def list_all_workers(user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    """Retourne tous les travailleurs de tous les sites du directeur"""
    # Récupérer tous les sites du directeur
    sites = db.query(Site.id).filter(Site.director_id == user.id).all()
    site_ids = [s.id for s in sites]
    logger.info(f"[all-workers] Director {user.id} has {len(site_ids)} sites: {site_ids}")
    if not site_ids:
        return []
    # Récupérer tous les travailleurs de ces sites
    rows = db.query(SiteWorker).filter(SiteWorker.site_id.in_(site_ids)).all()
    logger.info(f"[all-workers] Found {len(rows)} SiteWorkers: {[(r.id, r.name, r.site_id) for r in rows]}")
    result = []
    # Récupérer tous les workers users une seule fois pour optimiser
    all_workers = db.query(User).filter(User.role == UserRole.worker).all()
    logger.info(f"[all-workers] Found {len(all_workers)} worker users in database")
    
    for r in rows:
        user_worker = None
        phone = None
        
        # PRIORITÉ 1: Utiliser user_id si disponible (lien direct) MAIS seulement si le nom correspond
        if r.user_id:
            user_worker = db.get(User, r.user_id)
            if user_worker:
                # Si le lien est incohérent (mauvais user_id), ignorer et continuer la recherche
                if (user_worker.full_name or "").strip().lower() != (r.name or "").strip().lower():
                    logger.warning(
                        f"[all-workers] Worker '{r.name}' (id={r.id}): user_id={r.user_id} points to '{user_worker.full_name}' -> mismatch, ignoring link"
                    )
                    user_worker = None
                else:
                    phone = user_worker.phone
                    logger.info(f"[all-workers] Worker '{r.name}' (id={r.id}): Found User by user_id={r.user_id}: '{user_worker.full_name}' (phone={phone})")
            else:
                logger.warning(f"[all-workers] Worker '{r.name}' (id={r.id}): user_id={r.user_id} points to non-existent User")
        
        # PRIORITÉ 2: si pas de user_id valide mais phone présent dans SiteWorker, chercher par téléphone (et vérifier nom)
        if not user_worker and r.phone:
            user_worker = db.query(User).filter(User.role == UserRole.worker, User.phone == r.phone).first()
            if user_worker:
                if (user_worker.full_name or "").strip().lower() != (r.name or "").strip().lower():
                    logger.warning(
                        f"[all-workers] Worker '{r.name}' (id={r.id}): phone {r.phone} belongs to '{user_worker.full_name}' -> mismatch, ignoring"
                    )
                    user_worker = None
                else:
                    phone = user_worker.phone
                    logger.info(f"[all-workers] Worker '{r.name}' (id={r.id}): Found User by phone in SiteWorker {r.phone}: '{user_worker.full_name}' (id={user_worker.id})")

        # PRIORITÉ 2: Si pas de user_id, chercher par nom ET téléphone (si disponible dans un autre SiteWorker)
        if not user_worker:
            worker_name_clean = re.sub(r'\s+', ' ', (r.name or "").strip()).lower()
            
            # Chercher d'abord par correspondance exacte du nom
            for u in all_workers:
                user_name_clean = re.sub(r'\s+', ' ', (u.full_name or "").strip()).lower()
                if user_name_clean == worker_name_clean:
                    # Vérifier si ce User est déjà lié à un autre SiteWorker du même site avec le même nom
                    # Si oui, c'est probablement le bon
                    user_worker = u
                    phone = u.phone
                    logger.info(f"[all-workers] Worker '{r.name}' (id={r.id}): Exact name match with User '{u.full_name}' (id={u.id}, phone={phone})")
                    break
        
            # Si pas trouvé, essayer une recherche plus flexible
            if not user_worker and worker_name_clean:
                for u in all_workers:
                    user_name_clean = re.sub(r'\s+', ' ', (u.full_name or "").strip()).lower()
                    if worker_name_clean in user_name_clean or user_name_clean in worker_name_clean:
                        if abs(len(worker_name_clean) - len(user_name_clean)) <= 2:
                            user_worker = u
                            phone = u.phone
                            logger.info(f"[all-workers] Worker '{r.name}' (id={r.id}): Partial name match with User '{u.full_name}' (id={u.id}, phone={phone})")
                            break
        
        # Si toujours pas trouvé, logger pour debug
        if not user_worker:
            logger.warning(f"[all-workers] Worker '{r.name}' (id={r.id}): No matching User found. Available users: {[(u.id, u.full_name, u.phone) for u in all_workers]}")
        if not phone:
            phone = r.phone
        logger.info(f"[all-workers] Worker '{r.name}' (id={r.id}): phone={phone}, user_worker found={user_worker is not None}")
        worker_out = WorkerOut(
            id=r.id,
            site_id=r.site_id,
            name=r.name,
            max_shifts=r.max_shifts,
            roles=r.roles or [],
            availability=r.availability or {},
            answers=r.answers or {},
            phone=phone
        )
        logger.info(f"[all-workers] WorkerOut created for '{r.name}': phone field = {worker_out.phone}")
        result.append(worker_out)
    logger.info(f"[all-workers] Returning {len(result)} workers. Sample worker phone: {result[0].phone if result else 'N/A'}")
    return result


@router.get("/{site_id}", response_model=SiteOut)
def get_site(site_id: int, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    workers_count = db.query(SiteWorker).filter(SiteWorker.site_id == site.id).count()
    return SiteOut(id=site.id, name=site.name, workers_count=workers_count, config=site.config)


@router.delete("/{site_id}", status_code=204)
def delete_site(site_id: int, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    site: Site | None = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    # Supprime aussi les assignments via FK ondelete=CASCADE
    db.delete(site)
    db.commit()
    return None


@router.put("/{site_id}", response_model=SiteOut)
def update_site(site_id: int, payload: SiteUpdate, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    if payload.name is not None:
        site.name = payload.name
    if payload.config is not None:
        # validation logique: total rôles <= travailleurs
        try:
            validate_site_config(payload.config)
        except HTTPException:
            raise
        except Exception:
            pass
        site.config = payload.config
    db.commit()
    db.refresh(site)
    workers_count = db.query(SiteWorker).filter(SiteWorker.site_id == site.id).count()
    return SiteOut(id=site.id, name=site.name, workers_count=workers_count, config=site.config)


@router.get("/{site_id}/workers", response_model=list[WorkerOut])
def list_workers(site_id: int, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    rows = db.query(SiteWorker).filter(SiteWorker.site_id == site_id).all()
    # Récupérer tous les workers users pour trouver les numéros de téléphone
    all_workers = db.query(User).filter(User.role == UserRole.worker).all()
    result = []
    for r in rows:
        user_worker = None
        phone = None
        
        # PRIORITÉ 1: Utiliser user_id si disponible (lien direct)
        if r.user_id:
            user_worker = db.get(User, r.user_id)
            if user_worker:
                phone = user_worker.phone
            else:
                logger.warning(f"[list_workers] Worker '{r.name}' (id={r.id}): user_id={r.user_id} points to non-existent User")
        
        # PRIORITÉ 2: si pas de user_id mais phone présent dans SiteWorker, chercher par téléphone
        if not user_worker and r.phone:
            user_worker = db.query(User).filter(User.role == UserRole.worker, User.phone == r.phone).first()
            if user_worker:
                phone = user_worker.phone

        # PRIORITÉ 3: Si pas de user_id, chercher par nom
        if not user_worker:
            worker_name_clean = re.sub(r'\s+', ' ', (r.name or "").strip()).lower()
            for u in all_workers:
                user_name_clean = re.sub(r'\s+', ' ', (u.full_name or "").strip()).lower()
                if user_name_clean == worker_name_clean:
                    user_worker = u
                    phone = u.phone
                    break

        if not phone:
            phone = r.phone
        
        result.append(WorkerOut(
            id=r.id,
            site_id=r.site_id,
            name=r.name,
            max_shifts=r.max_shifts,
            roles=r.roles or [],
            availability=r.availability or {},
            answers=r.answers or {},
            phone=phone
        ))
    return result


@router.post("/{site_id}/create-worker-user", response_model=UserOut, status_code=201)
def create_worker_user(site_id: int, payload: CreateWorkerUserRequest, db: Session = Depends(get_db), user: User = Depends(require_role("director"))):
    """Créer un utilisateur worker avec nom et téléphone depuis le directeur"""
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    
    # Vérifier si le téléphone existe déjà
    existing_phone = db.query(User).filter(User.phone == payload.phone).first()
    if existing_phone:
        logger.warning(f"[create-worker-user] Phone {payload.phone} already exists for user '{existing_phone.full_name}' (id={existing_phone.id})")
        raise HTTPException(status_code=400, detail="Numéro de téléphone déjà enregistré")
    
    # Générer un mot de passe aléatoire (ce compte n'est pas censé se connecter par password)
    default_password = secrets.token_urlsafe(24)
    
    # Créer l'utilisateur worker
    worker_user = User(
        email=None,
        full_name=payload.name,
        hashed_password=pwd_context.hash(default_password),
        role=UserRole.worker,
        phone=payload.phone,
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
        
        # Chercher le User correspondant par nom ET téléphone (si disponible)
        user_worker = None
        if payload.phone:
            # Chercher d'abord par téléphone (plus fiable)
            user_worker = db.query(User).filter(
                User.role == UserRole.worker,
                User.phone == payload.phone
            ).first()
            if user_worker:
                logger.info(f"[create-worker] Found User by phone '{payload.phone}': '{user_worker.full_name}' (id={user_worker.id})")
        
        # Si pas trouvé par téléphone, chercher par nom
        if not user_worker:
            worker_name_clean = re.sub(r'\s+', ' ', (payload.name or "").strip()).lower()
            all_workers = db.query(User).filter(User.role == UserRole.worker).all()
            for u in all_workers:
                user_name_clean = re.sub(r'\s+', ' ', (u.full_name or "").strip()).lower()
                if user_name_clean == worker_name_clean:
                    user_worker = u
                    logger.info(f"[create-worker] Found User by name '{payload.name}': '{u.full_name}' (id={u.id}, phone={u.phone})")
                    break
        
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
                existing.phone = payload.phone
            # Lier au User si pas déjà lié et qu'on a trouvé un User
            if user_worker and not existing.user_id:
                existing.user_id = user_worker.id
                logger.info(f"[create-worker] Linked existing worker '{payload.name}' to User id={user_worker.id}")
            db.commit()
            db.refresh(existing)
            # Récupérer le téléphone du User lié
            phone = None
            if existing.user_id:
                linked_user = db.get(User, existing.user_id)
                phone = linked_user.phone if linked_user else None
            return WorkerOut(id=existing.id, site_id=existing.site_id, name=existing.name, max_shifts=existing.max_shifts, roles=existing.roles or [], availability=existing.availability or {}, answers=existing.answers or {}, phone=phone)
        
        # Créer un nouveau worker avec le lien au User si trouvé
        w = SiteWorker(
            site_id=site_id, 
            name=payload.name, 
            phone=payload.phone,
            max_shifts=payload.max_shifts, 
            roles=payload.roles or [], 
            availability=payload.availability or {},
            answers=payload.answers or {},
            user_id=user_worker.id if user_worker else None
        )
        db.add(w)
        db.commit()
        db.refresh(w)
        logger.info(f"[create-worker] Created SiteWorker '{payload.name}' (id={w.id}) for site {site_id}, linked to User id={w.user_id}")
        phone = user_worker.phone if user_worker else None
        return WorkerOut(id=w.id, site_id=w.site_id, name=w.name, max_shifts=w.max_shifts, roles=w.roles or [], availability=w.availability or {}, answers=w.answers or {}, phone=phone)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[create-worker] Unexpected error creating worker '{payload.name}' for site {site_id}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Erreur lors de la création du travailleur: {str(e)}")


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

    # Trouver le User worker "source of truth" via les anciennes infos (important quand on renomme)
    user_worker: User | None = None
    if old_user_id:
        cand = db.get(User, old_user_id)
        if cand and cand.role == UserRole.worker:
            user_worker = cand
    if not user_worker and old_phone:
        user_worker = db.query(User).filter(User.role == UserRole.worker, User.phone == old_phone).first()
    if not user_worker and old_name:
        user_worker = db.query(User).filter(User.role == UserRole.worker, func.lower(User.full_name) == func.lower(old_name)).first()

    # Mettre à jour le téléphone si fourni (et propager au User worker pour que la connexion change aussi)
    if payload.phone is not None:
        new_phone = (payload.phone or "").strip() or None

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
            default_password = secrets.token_urlsafe(24)
            user_worker = User(
                email=None,
                full_name=payload.name,
                hashed_password=pwd_context.hash(default_password),
                role=UserRole.worker,
                phone=new_phone,
            )
            db.add(user_worker)
            db.commit()
            db.refresh(user_worker)

        # Propager au user si trouvé/créé
        if user_worker:
            user_worker.full_name = payload.name
            if new_phone is not None:
                user_worker.phone = new_phone
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
    if payload.answers is not None and len(payload.answers) > 0:
        w.answers = payload.answers
    db.commit()
    db.refresh(w)
    phone = None
    if w.user_id:
        linked_user = db.get(User, w.user_id)
        phone = linked_user.phone if linked_user else None
    if not phone:
        phone = w.phone
    return WorkerOut(id=w.id, site_id=w.site_id, name=w.name, max_shifts=w.max_shifts, roles=w.roles or [], availability=w.availability or {}, answers=w.answers or {}, phone=phone)


@router.delete("/{site_id}/workers/{worker_id}", status_code=204)
def delete_worker(site_id: int, worker_id: int, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    """
    Supprime définitivement un travailleur d'un site :
    - il disparaît des listes,
    - il n'est plus rattaché au site à partir d'aujourd'hui.
    """
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    w: SiteWorker | None = db.get(SiteWorker, worker_id)
    if not w or w.site_id != site_id:
        raise HTTPException(status_code=404, detail="Travailleur introuvable sur ce site")

    db.delete(w)
    db.commit()
    logger.info(f"[delete-worker] Deleted worker '{w.name}' (id={worker_id}) from site {site_id}")

    return Response(status_code=204)


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
    # Load workers
    rows = db.query(SiteWorker).filter(SiteWorker.site_id == site_id).all()
    overrides = (payload.weekly_availability or {}) if payload else {}
    logger.info(f"[AI-GEN] Weekly availability overrides: {list(overrides.keys())}")
    workers = []
    for r in rows:
        # Utiliser UNIQUEMENT les disponibilités de la semaine (weekly_availability)
        # Ignorer la disponibilité de base des workers
        ovr = overrides.get(r.name)
        if isinstance(ovr, dict):
            # Utiliser uniquement les overrides de la semaine
            avail = {}
            for day_key, shifts_list in ovr.items():
                if isinstance(shifts_list, list):
                    # Filtrer les valeurs vides
                    valid_shifts = [s for s in shifts_list if s]
                    if valid_shifts:
                        avail[day_key] = valid_shifts
        else:
            # Si pas de disponibilité pour cette semaine, utiliser un dict vide
            avail = {}
        workers.append({
            "id": r.id,
            "name": r.name,
            "max_shifts": r.max_shifts,
            "roles": r.roles or [],
            "availability": avail,
        })
    logger.info(f"[AI-GEN] Loaded {len(workers)} workers: {[w['name'] for w in workers]}")
    for w in workers:
        avail_count = sum(len(shifts) for shifts in w['availability'].values())
        logger.info(f"[AI-GEN] Worker {w['name']}: availability keys={len(w['availability'])}, total shifts={avail_count}, max_shifts={w['max_shifts']}, roles={w['roles']}")
    if not workers:
        # Return empty structure with days/shifts from config mapping
        from .ai_solver import build_capacities_from_config

        days, shifts, stations = build_capacities_from_config(site.config or {})
        return AIPlanningResponse(
            days=days,
            shifts=shifts,
            stations=[st.get("name") for st in stations],
            assignments={day: {sh: [[] for _ in stations] for sh in shifts} for day in days},
            status="NO_WORKERS",
            objective=0.0,
        )
    result = solve_schedule(
        site.config or {},
        workers,
        time_limit_seconds=int(payload.time_limit_seconds or 25),
        max_nights_per_worker=int(payload.max_nights_per_worker or 3),
        num_alternatives=int(payload.num_alternatives or 20),
        fixed_assignments=payload.fixed_assignments or None,
        exclude_days=(payload.exclude_days or None),
    )
    return AIPlanningResponse(
        days=result["days"],
        shifts=result["shifts"],
        stations=result["stations"],
        assignments=result["assignments"],
        alternatives=result.get("alternatives", []),
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
    rows = db.query(SiteWorker).filter(SiteWorker.site_id == site_id).all()
    overrides = (payload.weekly_availability or {}) if payload else {}
    logger.info(f"[SSE] Weekly availability overrides: {list(overrides.keys())}")
    workers = []
    for r in rows:
        # Utiliser UNIQUEMENT les disponibilités de la semaine (weekly_availability)
        # Ignorer la disponibilité de base des workers
        ovr = overrides.get(r.name)
        if isinstance(ovr, dict):
            # Utiliser uniquement les overrides de la semaine
            avail = {}
            for day_key, shifts_list in ovr.items():
                if isinstance(shifts_list, list):
                    # Filtrer les valeurs vides
                    valid_shifts = [s for s in shifts_list if s]
                    if valid_shifts:
                        avail[day_key] = valid_shifts
        else:
            # Si pas de disponibilité pour cette semaine, utiliser un dict vide
            avail = {}
        workers.append({
            "id": r.id,
            "name": r.name,
            "max_shifts": r.max_shifts,
            "roles": r.roles or [],
            "availability": avail,
        })
    logger.info(f"[SSE] Loaded {len(workers)} workers: {[w['name'] for w in workers]}")
    for w in workers:
        avail_count = sum(len(shifts) for shifts in w['availability'].values())
        logger.info(f"[SSE] Worker {w['name']}: availability keys={len(w['availability'])}, total shifts={avail_count}, max_shifts={w['max_shifts']}, roles={w['roles']}")
        if avail_count == 0:
            logger.warning(f"[SSE] Worker {w['name']} has NO availability - this will prevent assignments!")

    # Choose effective parameters (query overrides body if provided)
    eff_time = int(q_time_limit_seconds if q_time_limit_seconds is not None else (payload.time_limit_seconds or 10))
    eff_max_nights = int(q_max_nights_per_worker if q_max_nights_per_worker is not None else (payload.max_nights_per_worker or 3))
    eff_num_alts = int(q_num_alternatives if q_num_alternatives is not None else (payload.num_alternatives or 20))
    logger.info("[SSE] start site=%s time_limit=%s max_nights=%s num_alternatives=%s workers=%s", site_id, eff_time, eff_max_nights, eff_num_alts, [w["name"] for w in workers])

    async def event_stream():
        """Non-bloquant: exécute le solveur dans un thread et stream via une queue."""
        import threading, queue, json, asyncio as _asyncio
        q: "queue.Queue[dict | None]" = queue.Queue(maxsize=256)

        def _producer():
            try:
                gen = solve_schedule_stream(
                    site.config or {},
                    workers,
                    time_limit_seconds=eff_time,
                    max_nights_per_worker=eff_max_nights,
                    num_alternatives=eff_num_alts,
                    fixed_assignments=payload.fixed_assignments or None,
                    exclude_days=(payload.exclude_days or None),
                )
                for item in gen:
                    q.put(item)
            except Exception as e:  # met l'erreur dans le flux
                q.put({"type": "status", "status": "ERROR", "detail": str(e)})
            finally:
                q.put(None)

        threading.Thread(target=_producer, daemon=True).start()

        while True:
            item = await _asyncio.to_thread(q.get)
            if item is None:
                break
            try:
                if item.get("type") == "alternative":
                    logger.debug("[SSE] push alternative index=%s", item.get("index"))
                elif item.get("type") == "base":
                    logger.info("[SSE] push base plan")
                elif item.get("type") == "done":
                    logger.info("[SSE] push done")
                elif item.get("type") == "status":
                    logger.warning("[SSE] status=%s", item.get("status"))
                chunk = f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
                yield chunk
            finally:
                await asyncio.sleep(0)

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_stream(), media_type="text/event-stream; charset=utf-8", headers=headers)



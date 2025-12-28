from fastapi import APIRouter, HTTPException, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import func
from .deps import get_db, get_current_user
from .models import Site, SiteWorker, SiteMessage, User
from .schemas import WorkerCreate, WorkerOut, SiteMessageOut
import re

router = APIRouter(prefix="/public/sites", tags=["public-workers"])

_WEEK_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _validate_week_iso(week_iso: str) -> str:
    wk = (week_iso or "").strip()
    if not _WEEK_ISO_RE.match(wk):
        raise HTTPException(status_code=400, detail="week invalide (YYYY-MM-DD)")
    return wk


@router.get("/worker-sites")
def get_worker_sites(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Endpoint pour obtenir la liste des sites où un travailleur est enregistré"""
    if user.role.value != "worker":
        raise HTTPException(status_code=403, detail="Accès réservé aux travailleurs")
    
    # Récupérer tous les sites où le travailleur est enregistré (par nom)
    rows = (
        db.query(Site.id, Site.name)
        .join(SiteWorker, SiteWorker.site_id == Site.id)
        .filter(func.lower(SiteWorker.name) == func.lower(user.full_name))
        .distinct()
        .all()
    )
    return [{"id": r.id, "name": r.name} for r in rows]


@router.get("/{site_id}/info")
def get_site_info(site_id: int, db: Session = Depends(get_db)):
    """Endpoint public pour obtenir les informations d'un site (nom, shifts, etc.)"""
    site = db.get(Site, site_id)
    if not site:
        raise HTTPException(status_code=404, detail="Site introuvable")
    
    # Extraire les shifts depuis la config
    shifts = []
    config = site.config or {}
    stations = config.get("stations", []) or []
    
    # Parcourir les stations pour trouver tous les shifts uniques
    shifts_set = set()
    for st in stations:
        # Shifts globaux
        for sh in (st.get("shifts") or []):
            if sh and sh.get("enabled") and sh.get("name"):
                shifts_set.add(sh.get("name"))
        
        # Shifts par jour (perDayCustom)
        if st.get("perDayCustom"):
            day_overrides = st.get("dayOverrides") or {}
            for day, ov in day_overrides.items():
                if ov and ov.get("active"):
                    for sh in (ov.get("shifts") or []):
                        if sh and sh.get("enabled") and sh.get("name"):
                            shifts_set.add(sh.get("name"))
    
    # Si aucun shift trouvé, utiliser des valeurs par défaut
    if not shifts_set:
        shifts_set = {"06-14", "14-22", "22-06"}
    
    shifts = sorted(list(shifts_set))
    
    questions = (config.get("questions", []) or [])
    return {"id": site.id, "name": site.name, "shifts": shifts, "questions": questions}


@router.get("/{site_id}/config")
def get_site_config(site_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Endpoint pour obtenir la config complète d'un site (pour les workers authentifiés)"""
    if user.role.value != "worker":
        raise HTTPException(status_code=403, detail="Accès réservé aux travailleurs")
    
    site = db.get(Site, site_id)
    if not site:
        raise HTTPException(status_code=404, detail="Site introuvable")
    
    # Vérifier que le worker est enregistré sur ce site
    worker = (
        db.query(SiteWorker)
        .filter(
            SiteWorker.site_id == site_id,
            func.lower(SiteWorker.name) == func.lower(user.full_name)
        )
        .first()
    )
    
    if not worker:
        raise HTTPException(status_code=403, detail="Vous n'êtes pas enregistré sur ce site")
    
    return {"id": site.id, "name": site.name, "config": site.config or {}}


@router.get("/{site_id}/worker-availability", response_model=WorkerOut)
def get_worker_availability(site_id: int, week_key: str | None = Query(None), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Endpoint pour obtenir les זמינות d'un worker depuis le serveur"""
    if user.role.value != "worker":
        raise HTTPException(status_code=403, detail="Accès réservé aux travailleurs")
    
    site = db.get(Site, site_id)
    if not site:
        raise HTTPException(status_code=404, detail="Site introuvable")
    
    # Récupérer le worker par nom
    worker = (
        db.query(SiteWorker)
        .filter(
            SiteWorker.site_id == site_id,
            func.lower(SiteWorker.name) == func.lower(user.full_name)
        )
        .first()
    )
    
    if not worker:
        # Si le worker n'existe pas encore, retourner des valeurs par défaut
        return WorkerOut(
            id=0,
            site_id=site_id,
            name=user.full_name or "",
            max_shifts=5,
            roles=[],
            availability={},
            answers={},
        )
    
    # Retourner les réponses de la semaine spécifiée si week_key est fourni
    answers = worker.answers or {}
    if week_key and isinstance(answers, dict) and week_key in answers:
        answers = answers[week_key]
    elif week_key:
        # Si week_key est fourni mais pas de réponses pour cette semaine, retourner vide
        answers = {}
    
    return WorkerOut(
        id=worker.id,
        site_id=worker.site_id,
        name=worker.name,
        max_shifts=worker.max_shifts,
        roles=worker.roles or [],
        availability=worker.availability or {},
        answers=answers,
    )


@router.get("/{site_id}/messages", response_model=list[SiteMessageOut])
def get_site_messages_for_worker(
    site_id: int,
    week: str = Query(..., description="YYYY-MM-DD (week start)"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user.role.value != "worker":
        raise HTTPException(status_code=403, detail="Accès réservé aux travailleurs")

    wk = _validate_week_iso(week)

    site = db.get(Site, site_id)
    if not site:
        raise HTTPException(status_code=404, detail="Site introuvable")

    # Vérifier que le worker est enregistré sur ce site
    worker = (
        db.query(SiteWorker)
        .filter(
            SiteWorker.site_id == site_id,
            func.lower(SiteWorker.name) == func.lower(user.full_name)
        )
        .first()
    )
    if not worker:
        raise HTTPException(status_code=403, detail="Vous n'êtes pas enregistré sur ce site")

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


@router.post("/{site_id}/register", response_model=WorkerOut, status_code=201)
def register_worker(site_id: int, payload: WorkerCreate, db: Session = Depends(get_db)):
    """Endpoint public pour permettre aux travailleurs de s'enregistrer et mettre à jour leur זמינות"""
    site = db.get(Site, site_id)
    if not site:
        raise HTTPException(status_code=404, detail="Site introuvable")
    
    # Vérifier si un worker avec ce nom existe déjà pour ce site
    existing = (
        db.query(SiteWorker)
        .filter(
            SiteWorker.site_id == site_id,
            func.lower(SiteWorker.name) == func.lower(payload.name),
        )
        .first()
    )
    
    # Extraire week_key du payload si présent (dans answers ou directement)
    week_key = None
    answers_data = payload.answers or {}
    if isinstance(answers_data, dict) and "week_key" in answers_data:
        week_key = answers_data.pop("week_key")
        # answers_data contient maintenant { general: {}, perDay: {} }
    
    if existing:
        # Si le worker existe déjà, mettre à jour sa זמינות et max_shifts
        existing.availability = payload.availability or {}
        
        # Stocker les réponses par semaine si week_key est fourni
        if week_key and answers_data:
            current_answers = existing.answers or {}
            if not isinstance(current_answers, dict):
                current_answers = {}
            current_answers[week_key] = answers_data
            existing.answers = current_answers
        elif answers_data:
            # Compatibilité ascendante : si pas de week_key, stocker directement
            existing.answers = answers_data
        
        if payload.max_shifts is not None:
            existing.max_shifts = payload.max_shifts
        db.commit()
        db.refresh(existing)
        
        # Retourner les réponses de la semaine si week_key est fourni
        return_answers = existing.answers or {}
        if week_key and isinstance(return_answers, dict) and week_key in return_answers:
            return_answers = return_answers[week_key]
        
        return WorkerOut(
            id=existing.id,
            site_id=existing.site_id,
            name=existing.name,
            max_shifts=existing.max_shifts,
            roles=existing.roles or [],
            availability=existing.availability or {},
            answers=return_answers,
        )
    
    # Créer un nouveau worker
    initial_answers = {}
    if week_key and answers_data:
        initial_answers[week_key] = answers_data
    elif answers_data:
        initial_answers = answers_data
    
    w = SiteWorker(
        site_id=site_id,
        name=payload.name,
        max_shifts=payload.max_shifts or 5,
        roles=payload.roles or [],
        availability=payload.availability or {},
        answers=initial_answers,
    )
    db.add(w)
    db.commit()
    db.refresh(w)
    
    return_answers = w.answers or {}
    if week_key and isinstance(return_answers, dict) and week_key in return_answers:
        return_answers = return_answers[week_key]
    
    return WorkerOut(
        id=w.id,
        site_id=w.site_id,
        name=w.name,
        max_shifts=w.max_shifts,
        roles=w.roles or [],
        availability=w.availability or {},
        answers=return_answers,
    )


from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func
from .deps import get_db, get_current_user
from .models import Site, SiteWorker, User
from .schemas import WorkerCreate, WorkerOut

router = APIRouter(prefix="/public/sites", tags=["public-workers"])


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
    
    return {"id": site.id, "name": site.name, "shifts": shifts}


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
    
    if existing:
        # Si le worker existe déjà, mettre à jour sa זמינות et max_shifts
        existing.availability = payload.availability or {}
        if payload.max_shifts is not None:
            existing.max_shifts = payload.max_shifts
        db.commit()
        db.refresh(existing)
        return WorkerOut(
            id=existing.id,
            site_id=existing.site_id,
            name=existing.name,
            max_shifts=existing.max_shifts,
            roles=existing.roles or [],
            availability=existing.availability or {}
        )
    
    # Créer un nouveau worker
    w = SiteWorker(
        site_id=site_id,
        name=payload.name,
        max_shifts=payload.max_shifts or 5,
        roles=payload.roles or [],
        availability=payload.availability or {}
    )
    db.add(w)
    db.commit()
    db.refresh(w)
    return WorkerOut(
        id=w.id,
        site_id=w.site_id,
        name=w.name,
        max_shifts=w.max_shifts,
        roles=w.roles or [],
        availability=w.availability or {}
    )


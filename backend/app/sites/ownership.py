from fastapi import HTTPException
from sqlalchemy.orm import Session
from ..models import Site

def _director_site_ownership_or_404(db: Session, site_id: int, director_id: int) -> Site:
    """Directeur propriétaire — inclut les sites soft-deleted (consultation / historique)."""
    site = db.get(Site, site_id)
    if not site:
        raise HTTPException(status_code=404, detail="Site introuvable")
    if site.director_id != director_id:
        raise HTTPException(status_code=403, detail="Accès interdit")
    return site


def _director_site_or_404(db: Session, site_id: int, director_id: int) -> Site:
    site = _director_site_ownership_or_404(db, site_id, director_id)
    if getattr(site, "deleted_at", None):
        raise HTTPException(status_code=404, detail="Site introuvable")
    return site


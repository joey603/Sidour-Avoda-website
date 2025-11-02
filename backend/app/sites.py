from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
import asyncio
from fastapi import Body
from sqlalchemy import func
from sqlalchemy.orm import Session

from .deps import require_role, get_db
from .models import Site, SiteAssignment, SiteWorker, User
from .schemas import (
    SiteCreate,
    SiteOut,
    SiteUpdate,
    WorkerCreate,
    WorkerUpdate,
    WorkerOut,
    AIPlanningRequest,
    AIPlanningResponse,
)
from .ai_solver import solve_schedule, solve_schedule_stream
import logging
logger = logging.getLogger("ai_solver")

router = APIRouter(prefix="/director/sites", tags=["sites"])


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
    if not site_ids:
        return []
    # Récupérer tous les travailleurs de ces sites
    rows = db.query(SiteWorker).filter(SiteWorker.site_id.in_(site_ids)).all()
    return [WorkerOut(id=r.id, site_id=r.site_id, name=r.name, max_shifts=r.max_shifts, roles=r.roles or [], availability=r.availability or {}) for r in rows]


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
    return [WorkerOut(id=r.id, site_id=r.site_id, name=r.name, max_shifts=r.max_shifts, roles=r.roles or [], availability=r.availability or {}) for r in rows]


@router.post("/{site_id}/workers", response_model=WorkerOut, status_code=201)
def create_worker(site_id: int, payload: WorkerCreate, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
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
        # Si le worker existe déjà, mettre à jour ses données et le retourner (réutilisation)
        existing.max_shifts = payload.max_shifts
        existing.roles = payload.roles or []
        existing.availability = payload.availability or {}
        db.commit()
        db.refresh(existing)
        return WorkerOut(id=existing.id, site_id=existing.site_id, name=existing.name, max_shifts=existing.max_shifts, roles=existing.roles or [], availability=existing.availability or {})
    # Créer un nouveau worker
    w = SiteWorker(site_id=site_id, name=payload.name, max_shifts=payload.max_shifts, roles=payload.roles or [], availability=payload.availability or {})
    db.add(w)
    db.commit()
    db.refresh(w)
    return WorkerOut(id=w.id, site_id=w.site_id, name=w.name, max_shifts=w.max_shifts, roles=w.roles or [], availability=w.availability or {})


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
    w.name = payload.name
    w.max_shifts = payload.max_shifts
    w.roles = payload.roles or []
    w.availability = payload.availability or {}
    db.commit()
    db.refresh(w)
    return WorkerOut(id=w.id, site_id=w.site_id, name=w.name, max_shifts=w.max_shifts, roles=w.roles or [], availability=w.availability or {})


@router.delete("/{site_id}/workers/{worker_id}", status_code=204)
def delete_worker(site_id: int, worker_id: int, user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    w: SiteWorker | None = db.get(SiteWorker, worker_id)
    if not w or w.site_id != site_id:
        raise HTTPException(status_code=404, detail="Worker introuvable")
    db.delete(w)
    db.commit()
    return None


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
    workers = [
        {
            "id": r.id,
            "name": r.name,
            "max_shifts": r.max_shifts,
            "roles": r.roles or [],
            "availability": r.availability or {},
        }
        for r in rows
    ]
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
def ai_generate_stream(
    site_id: int,
    payload: AIPlanningRequest = Body(default=AIPlanningRequest()),
    # Allow overriding via query string as EventSource uses GET without body
    q_time_limit_seconds: int | None = Query(default=None, alias="time_limit_seconds"),
    q_max_nights_per_worker: int | None = Query(default=None, alias="max_nights_per_worker"),
    q_num_alternatives: int | None = Query(default=None, alias="num_alternatives"),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    rows = db.query(SiteWorker).filter(SiteWorker.site_id == site_id).all()
    workers = [
        {"id": r.id, "name": r.name, "max_shifts": r.max_shifts, "roles": r.roles or [], "availability": r.availability or {}}
        for r in rows
    ]

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



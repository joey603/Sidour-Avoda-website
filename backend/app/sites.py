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
    # Unicité par site du nom (insensible à la casse)
    exists = (
        db.query(SiteWorker.id)
        .filter(
            SiteWorker.site_id == site_id,
            func.lower(SiteWorker.name) == func.lower(payload.name),
        )
        .first()
    )
    if exists:
        raise HTTPException(status_code=400, detail="שם עובד כבר קיים באתר")
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
        time_limit_seconds=int(payload.time_limit_seconds or 10),
        max_nights_per_worker=int(payload.max_nights_per_worker or 3),
        num_alternatives=int(payload.num_alternatives or 20),
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
        {"id": r.id, "name": r.name, "max_shifts": r.max_shifts, "availability": r.availability or {}}
        for r in rows
    ]

    # Choose effective parameters (query overrides body if provided)
    eff_time = int(q_time_limit_seconds if q_time_limit_seconds is not None else (payload.time_limit_seconds or 10))
    eff_max_nights = int(q_max_nights_per_worker if q_max_nights_per_worker is not None else (payload.max_nights_per_worker or 3))
    eff_num_alts = int(q_num_alternatives if q_num_alternatives is not None else (payload.num_alternatives or 20))
    logger.info("[SSE] start site=%s time_limit=%s max_nights=%s num_alternatives=%s workers=%s", site_id, eff_time, eff_max_nights, eff_num_alts, [w["name"] for w in workers])

    async def event_stream():
        try:
            gen = solve_schedule_stream(
                site.config or {},
                workers,
                time_limit_seconds=eff_time,
                max_nights_per_worker=eff_max_nights,
                num_alternatives=eff_num_alts,
            )
            import json
            for item in gen:
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
                await asyncio.sleep(0)  # hint scheduler to flush
        except Exception as e:
            import json
            err = {"type": "status", "status": "ERROR", "detail": str(e)}
            yield "data: " + json.dumps(err, ensure_ascii=False) + "\n\n"

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_stream(), media_type="text/event-stream; charset=utf-8", headers=headers)



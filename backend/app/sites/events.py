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
    _week_iso_dates, _date_iso_to_day_key, _WEEK_DAY_KEYS,
)
from .site_config import validate_site_config, normalize_site_config, _safe_site_config

logger = logging.getLogger("ai_solver")
router = APIRouter()
_TIME_HHMM_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def _normalize_hhmm(value: str | None) -> str | None:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    m = _TIME_HHMM_RE.match(raw)
    if not m:
        raise HTTPException(status_code=400, detail="horaire invalide (HH:MM)")
    return f"{int(m.group(1)):02d}:{m.group(2)}"


def _normalize_event_dates(dates: list[str] | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for d in dates or []:
        iso = _validate_week_iso(str(d or "").strip())
        if iso in seen:
            continue
        seen.add(iso)
        out.append(iso)
    out.sort()
    if not out:
        raise HTTPException(status_code=400, detail="au moins une date est requise")
    return out


def _normalize_event_assignments(
    assignments: dict[str, list[int]] | None,
    dates: list[str],
    site_id: int,
    db: Session,
) -> dict[str, list[int]]:
    date_set = set(dates)
    site_worker_ids = {
        int(w.id)
        for w in db.query(SiteWorker).filter(SiteWorker.site_id == site_id).all()
    }
    out: dict[str, list[int]] = {}
    for day, worker_ids in (assignments or {}).items():
        day_iso = _validate_week_iso(str(day or "").strip())
        if day_iso not in date_set:
            continue
        cleaned: list[int] = []
        seen: set[int] = set()
        for wid in worker_ids or []:
            try:
                wid_i = int(wid)
            except Exception:
                continue
            if wid_i not in site_worker_ids or wid_i in seen:
                continue
            seen.add(wid_i)
            cleaned.append(wid_i)
        out[day_iso] = cleaned
    for d in dates:
        out.setdefault(d, [])
    return out


def _site_event_to_out(row: SiteEvent) -> SiteEventOut:
    dates = row.dates_json if isinstance(row.dates_json, list) else []
    assignments = row.assignments_json if isinstance(row.assignments_json, dict) else {}
    return SiteEventOut(
        id=row.id,
        site_id=row.site_id,
        title=row.title,
        start_time=row.start_time,
        end_time=row.end_time,
        dates=[str(d) for d in dates],
        assignments={
            str(k): [int(x) for x in (v or []) if x is not None]
            for k, v in assignments.items()
        },
        created_at=row.created_at,
        updated_at=row.updated_at,
    )




def _event_intersects_week(row: SiteEvent, week_dates: set[str]) -> bool:
    dates = row.dates_json if isinstance(row.dates_json, list) else []
    return any(str(d) in week_dates for d in dates)



from .solver_bridge import (
    _hm_to_minutes, _shift_start_minutes, _site_shift_names_ordered,
)

def _add_event_lock(
    out: dict[int, dict[str, list[str]]],
    worker_id: int,
    day_key: str,
    shift_name: str,
) -> None:
    if not day_key or not shift_name:
        return
    by_day = out.setdefault(int(worker_id), {})
    cur = by_day.setdefault(day_key, [])
    if shift_name not in cur:
        cur.append(shift_name)


def _compute_site_event_availability_locks(
    db: Session,
    site_id: int,
    week_iso: str,
    config: dict | None,
) -> dict[int, dict[str, list[str]]]:
    """Créneaux indisponibles (אירועים) : jour + garde précédente + règle 8h."""
    shifts = _site_shift_names_ordered(config)
    if not shifts:
        return {}
    week_dates = set(_week_iso_dates(week_iso))
    rows = (
        db.query(SiteEvent)
        .filter(SiteEvent.site_id == int(site_id))
        .all()
    )
    out: dict[int, dict[str, list[str]]] = {}
    last_shift = shifts[-1]
    for ev in rows:
        dates = ev.dates_json if isinstance(ev.dates_json, list) else []
        assignments = ev.assignments_json if isinstance(ev.assignments_json, dict) else {}
        start_min = _hm_to_minutes(ev.start_time)
        end_min = _hm_to_minutes(ev.end_time)
        for date_iso in dates:
            date_s = str(date_iso or "").strip()
            if date_s not in week_dates:
                continue
            day_key = _date_iso_to_day_key(week_iso, date_s)
            if not day_key:
                continue
            worker_ids = assignments.get(date_s) or []
            if not isinstance(worker_ids, list):
                continue
            for wid_raw in worker_ids:
                try:
                    wid = int(wid_raw)
                except Exception:
                    continue
                if wid <= 0:
                    continue
                for sn in shifts:
                    _add_event_lock(out, wid, day_key, sn)
                event_shift_idx = 0
                if start_min is not None:
                    found = next(
                        (
                            i
                            for i, sn in enumerate(shifts)
                            if (_shift_start_minutes(config, sn) is not None)
                            and (_shift_start_minutes(config, sn) or 0) >= start_min
                        ),
                        -1,
                    )
                    event_shift_idx = found if found >= 0 else 0
                if event_shift_idx == 0:
                    day_idx = _WEEK_DAY_KEYS.index(day_key) if day_key in _WEEK_DAY_KEYS else -1
                    if day_idx > 0 and last_shift:
                        _add_event_lock(out, wid, _WEEK_DAY_KEYS[day_idx - 1], last_shift)
                else:
                    _add_event_lock(out, wid, day_key, shifts[event_shift_idx - 1])
                if end_min is not None:
                    for sn in shifts:
                        s = _shift_start_minutes(config, sn)
                        if s is None:
                            continue
                        gap = s - end_min
                        if gap < 0:
                            gap += 24 * 60
                        if 0 < gap < 8 * 60:
                            _add_event_lock(out, wid, day_key, sn)
    return out


def _strip_event_locks_from_solver_workers(
    workers: list[dict],
    locks_by_worker_id: dict[int, dict[str, list[str]]],
) -> list[dict]:
    if not locks_by_worker_id:
        return workers
    for w in workers:
        try:
            wid = int(w.get("id") or 0)
        except Exception:
            continue
        locks = locks_by_worker_id.get(wid) or {}
        if not locks:
            continue
        avail = dict(w.get("availability") or {})
        for day_key, locked_shifts in locks.items():
            locked = set(locked_shifts or [])
            cur = list(avail.get(day_key) or [])
            avail[day_key] = [sn for sn in cur if sn not in locked]
        w["availability"] = avail
    return workers


def _count_site_event_assignments_by_worker_id(
    db: Session,
    site_id: int,
    week_iso: str,
) -> dict[int, int]:
    """Nombre d'affectations אירוע (= gardes) par worker_id pour la semaine."""
    week_dates = set(_week_iso_dates(week_iso))
    rows = db.query(SiteEvent).filter(SiteEvent.site_id == int(site_id)).all()
    counts: dict[int, int] = {}
    for ev in rows:
        dates = ev.dates_json if isinstance(ev.dates_json, list) else []
        assignments = ev.assignments_json if isinstance(ev.assignments_json, dict) else {}
        for date_iso in dates:
            date_s = str(date_iso or "").strip()
            if date_s not in week_dates:
                continue
            worker_ids = assignments.get(date_s) or []
            if not isinstance(worker_ids, list):
                continue
            for wid_raw in worker_ids:
                try:
                    wid = int(wid_raw)
                except Exception:
                    continue
                if wid <= 0:
                    continue
                counts[wid] = counts.get(wid, 0) + 1
    return counts


def _apply_site_event_shift_credits_to_solver_workers(
    workers: list[dict],
    event_counts_by_worker_id: dict[int, int],
) -> list[dict]:
    """Chaque אירוע compte comme 1 garde : réduit max_shifts du solveur."""
    if not event_counts_by_worker_id:
        return workers
    for w in workers:
        try:
            wid = int(w.get("id") or 0)
        except Exception:
            continue
        n = int(event_counts_by_worker_id.get(wid) or 0)
        if n <= 0:
            continue
        try:
            mx = int(w.get("max_shifts") or 5)
        except Exception:
            mx = 5
        w["max_shifts"] = max(0, mx - n)
    return workers


def _apply_site_event_locks_to_solver_workers(
    db: Session,
    site_id: int,
    week_iso: str,
    config: dict | None,
    workers: list[dict],
) -> list[dict]:
    locks = _compute_site_event_availability_locks(db, site_id, week_iso, config)
    workers = _strip_event_locks_from_solver_workers(workers, locks)
    event_counts = _count_site_event_assignments_by_worker_id(db, site_id, week_iso)
    return _apply_site_event_shift_credits_to_solver_workers(workers, event_counts)


def _strip_event_locks_from_availability_by_name(
    availability_by_name: dict[str, dict],
    locks_by_worker_id: dict[int, dict[str, list[str]]],
    name_to_worker_id: dict[str, int],
) -> dict[str, dict]:
    if not locks_by_worker_id or not availability_by_name:
        return availability_by_name
    out: dict[str, dict] = {}
    for name, avail in availability_by_name.items():
        wid = name_to_worker_id.get(str(name or "").strip())
        locks = locks_by_worker_id.get(int(wid)) if wid else None
        if not isinstance(avail, dict) or not locks:
            out[name] = avail
            continue
        next_avail = dict(avail)
        for day_key, locked_shifts in locks.items():
            if day_key.startswith("_"):
                continue
            locked = set(locked_shifts or [])
            cur = next_avail.get(day_key)
            if isinstance(cur, list):
                next_avail[day_key] = [sn for sn in cur if sn not in locked]
        out[name] = next_avail
    return out


@router.get("/{site_id}/events", response_model=list[SiteEventOut])
def list_site_events(
    site_id: int,
    week: str | None = Query(None, description="YYYY-MM-DD (week start); omit for all events"),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_ownership_or_404(db, site_id, user.id)
    rows = (
        db.query(SiteEvent)
        .filter(SiteEvent.site_id == site_id)
        .order_by(SiteEvent.created_at.asc(), SiteEvent.id.asc())
        .all()
    )
    if week:
        wk = _validate_week_iso(week)
        week_dates = _week_date_set(wk)
        rows = [r for r in rows if _event_intersects_week(r, week_dates)]
    return [_site_event_to_out(r) for r in rows]


@router.post("/{site_id}/events", response_model=SiteEventOut, status_code=201)
def create_site_event(
    site_id: int,
    payload: SiteEventCreate,
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_or_404(db, site_id, user.id)
    title = (payload.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="titre requis")
    dates = _normalize_event_dates(payload.dates)
    start_time = _normalize_hhmm(payload.start_time)
    end_time = _normalize_hhmm(payload.end_time)
    assignments = _normalize_event_assignments(payload.assignments, dates, site_id, db)
    now = _now_ms()
    row = SiteEvent(
        site_id=site_id,
        title=title,
        start_time=start_time,
        end_time=end_time,
        dates_json=dates,
        assignments_json=assignments,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _site_event_to_out(row)


@router.patch("/{site_id}/events/{event_id}", response_model=SiteEventOut)
def update_site_event(
    site_id: int,
    event_id: int,
    payload: SiteEventUpdate,
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_or_404(db, site_id, user.id)
    row = db.get(SiteEvent, event_id)
    if not row or row.site_id != site_id:
        raise HTTPException(status_code=404, detail="Événement introuvable")

    if payload.title is not None:
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="titre requis")
        row.title = title

    if "start_time" in payload.model_fields_set:
        row.start_time = _normalize_hhmm(payload.start_time)
    if "end_time" in payload.model_fields_set:
        row.end_time = _normalize_hhmm(payload.end_time)

    dates = list(row.dates_json) if isinstance(row.dates_json, list) else []
    if payload.dates is not None:
        dates = _normalize_event_dates(payload.dates)
        row.dates_json = dates

    if payload.assignments is not None or payload.dates is not None:
        current_assignments = (
            row.assignments_json if isinstance(row.assignments_json, dict) else {}
        )
        next_assignments = payload.assignments if payload.assignments is not None else current_assignments
        row.assignments_json = _normalize_event_assignments(
            next_assignments, dates, site_id, db
        )

    row.updated_at = _now_ms()
    db.commit()
    db.refresh(row)
    return _site_event_to_out(row)


@router.delete("/{site_id}/events/{event_id}", status_code=204)
def delete_site_event(
    site_id: int,
    event_id: int,
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_or_404(db, site_id, user.id)
    row = db.get(SiteEvent, event_id)
    if not row or row.site_id != site_id:
        raise HTTPException(status_code=404, detail="Événement introuvable")
    db.delete(row)
    db.commit()
    return Response(status_code=204)


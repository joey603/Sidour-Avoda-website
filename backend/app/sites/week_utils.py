"""Week / date helpers shared across director sites."""

from __future__ import annotations

import re
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Site, SiteWorker

_WEEK_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_WEEK_DAY_KEYS = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")
_WEEK_DAY_KEYS_FOR_PREFS = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")


def _validate_week_iso(week_iso: str) -> str:
    wk = (week_iso or "").strip()
    if not _WEEK_ISO_RE.match(wk):
        raise HTTPException(status_code=400, detail="week_iso invalide (YYYY-MM-DD)")
    return wk


def _now_ms() -> int:
    import time

    return int(time.time() * 1000)


def _week_start_date(dt: datetime) -> datetime:
    days_since_sunday = (dt.weekday() + 1) % 7
    base = dt - timedelta(days=days_since_sunday)
    return base.replace(hour=0, minute=0, second=0, microsecond=0)


def _next_week_iso(dt: datetime) -> str:
    return (_week_start_date(dt) + timedelta(days=7)).date().isoformat()


def _answers_payload_for_week(raw_answers: object, week_iso: str | None) -> dict:
    """Réponses questionnaire pour une semaine : garde la forme lue par le front, sans l’historique."""
    answers = raw_answers if isinstance(raw_answers, dict) else {}
    if not week_iso:
        return dict(answers)
    week_block = answers.get(week_iso)
    if isinstance(week_block, dict):
        return {week_iso: dict(week_block)}
    wk_field = str(answers.get("week_key") or answers.get("week_iso") or "").strip()
    if wk_field == week_iso and ("general" in answers or "perDay" in answers):
        return dict(answers)
    if "general" in answers or "perDay" in answers:
        return dict(answers)
    return {}


def _site_worker_visible_for_week(row: SiteWorker, week_iso: str | None) -> bool:
    """Visible pour une semaine donnée (dimanche = clé, aligné sur le front planning)."""
    wk = (week_iso or "").strip()
    if not wk:
        # Sans semaine : ne masquer que les retraits déjà effectifs (semaine courante >= removed_from)
        wk_eff = _week_start_date(datetime.now()).date().isoformat()
        removed = getattr(row, "removed_from_week_iso", None)
        if removed:
            r = str(removed).strip()
            if r and wk_eff >= r:
                return False
        return True
    if bool(getattr(row, "pending_approval", False)):
        created_at = int(getattr(row, "created_at", 0) or 0)
        if created_at > 0:
            created_week_iso = _week_start_date(datetime.fromtimestamp(created_at / 1000)).date().isoformat()
            if created_week_iso > wk:
                return False
    removed = getattr(row, "removed_from_week_iso", None)
    if removed:
        r = str(removed).strip()
        if r and wk >= r:
            return False
    return True


def _workers_counts_by_site_for_week(
    db: Session,
    director_id: int,
    week_iso: str,
    site_ids: list[int] | None = None,
) -> tuple[dict[int, int], dict[int, int]]:
    """Compteurs par site pour une semaine (dimanche), alignés sur `list_workers` / planning."""
    q = (
        db.query(SiteWorker)
        .join(Site, Site.id == SiteWorker.site_id)
        .filter(Site.director_id == director_id)
    )
    if site_ids:
        q = q.filter(SiteWorker.site_id.in_([int(sid) for sid in site_ids]))
    rows = q.all()
    counts: dict[int, int] = {}
    pending_counts: dict[int, int] = {}
    for row in rows:
        if not _site_worker_visible_for_week(row, week_iso):
            continue
        sid = int(row.site_id)
        counts[sid] = counts.get(sid, 0) + 1
        if bool(getattr(row, "pending_approval", False)):
            pending_counts[sid] = pending_counts.get(sid, 0) + 1
    return counts, pending_counts


def _schedule_run_time_for_current_week(now: datetime, day_of_week: int, hour: int, minute: int) -> datetime:
    return _week_start_date(now) + timedelta(days=int(day_of_week), hours=int(hour), minutes=int(minute))


def _ms_to_datetime(value: int | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromtimestamp(int(value) / 1000)
    except Exception:
        return None


def _week_iso_dates(week_iso: str) -> list[str]:
    start = datetime.strptime(week_iso, "%Y-%m-%d").date()
    return [(start + timedelta(days=i)).isoformat() for i in range(7)]


def _date_iso_to_day_key(week_iso: str, date_iso: str) -> str | None:
    dates = _week_iso_dates(week_iso)
    try:
        idx = dates.index(date_iso)
    except ValueError:
        return None
    return _WEEK_DAY_KEYS[idx] if 0 <= idx < len(_WEEK_DAY_KEYS) else None


def _week_date_set(week_iso: str) -> set[str]:
    start = datetime.strptime(week_iso, "%Y-%m-%d").date()
    return {(start + timedelta(days=i)).isoformat() for i in range(7)}

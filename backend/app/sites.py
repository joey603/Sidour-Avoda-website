from fastapi import APIRouter, Depends, HTTPException, Query
from starlette.requests import Request
from fastapi.responses import StreamingResponse
import asyncio
from fastapi import Body, Response
from sqlalchemy import func
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
import re
from datetime import datetime, timedelta
from copy import deepcopy

from .deps import require_role, get_db
from .models import Site, SiteAssignment, SiteWorker, SiteMessage, SiteWeeklyAvailability, SiteWeekPlan, User, UserRole, DirectorAutoPlanningConfig
from .schemas import (
    SiteCreate,
    SiteOut,
    NextWeekSavedPlanStatus,
    SiteUpdate,
    WorkerCreate,
    WorkerUpdate,
    WorkerOut,
    AIPlanningRequest,
    AIPlanningResponse,
    UserOut,
    CreateWorkerUserRequest,
    WeeklyAvailabilityPayload,
    WeekPlanPayload,
    AutoPlanningConfigPayload,
    AutoPlanningConfigOut,
    SiteMessageCreate,
    SiteMessageUpdate,
    SiteMessageOut,
    WorkerInviteLinkOut,
)
from .ai_solver import solve_schedule, solve_schedule_stream
from .auth import create_worker_invite_token, ensure_director_code
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


def _week_start_date(dt: datetime) -> datetime:
    days_since_sunday = (dt.weekday() + 1) % 7
    base = dt - timedelta(days=days_since_sunday)
    return base.replace(hour=0, minute=0, second=0, microsecond=0)


def _next_week_iso(dt: datetime) -> str:
    return (_week_start_date(dt) + timedelta(days=7)).date().isoformat()


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


def _schedule_run_time_for_current_week(now: datetime, day_of_week: int, hour: int, minute: int) -> datetime:
    return _week_start_date(now) + timedelta(days=int(day_of_week), hours=int(hour), minutes=int(minute))


def _ms_to_datetime(value: int | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromtimestamp(int(value) / 1000)
    except Exception:
        return None


def _next_effective_run_time(now: datetime, config: DirectorAutoPlanningConfig) -> datetime:
    candidate = _schedule_run_time_for_current_week(now, config.day_of_week, config.hour, config.minute)
    updated_at = _ms_to_datetime(getattr(config, "updated_at", None))
    last_run_at = _ms_to_datetime(getattr(config, "last_run_at", None))

    # Si la config a été créée/modifiée après le créneau de cette semaine,
    # on attend la prochaine occurrence réelle du jour/heure choisis.
    # La saisie UI est à la minute: si on sauvegarde pendant cette même minute,
    # on considère encore que le créneau de cette semaine est valide.
    if updated_at and updated_at >= (candidate + timedelta(minutes=1)):
        candidate += timedelta(days=7)

    while last_run_at and candidate <= last_run_at:
        candidate += timedelta(days=7)

    return candidate


# Plafond משיכות pour la config תכנון אוטומטי (aligné UI).
_AUTO_PLANNING_CONFIG_PULLS_MAX = 30


def _coerce_pulls_limits_for_storage(raw: dict[str, int | None] | None) -> dict[str, int] | None:
    if not raw:
        return None
    out: dict[str, int] = {}
    for k, v in raw.items():
        if v is None:
            continue
        try:
            lim = int(v)
        except (TypeError, ValueError):
            continue
        if lim >= 1:
            out[str(k)] = min(_AUTO_PLANNING_CONFIG_PULLS_MAX, lim)
    return out or None


def _pull_limits_from_config_row(row: DirectorAutoPlanningConfig | None) -> tuple[int | None, dict[int, int | None] | None]:
    if not row:
        return None, None
    raw_pl = getattr(row, "pulls_limit", None)
    gpl: int | None = None
    if raw_pl is not None:
        try:
            gpl = int(raw_pl)
        except (TypeError, ValueError):
            gpl = None
        if gpl is not None:
            if gpl < 1:
                gpl = None
            elif gpl > _AUTO_PLANNING_CONFIG_PULLS_MAX:
                gpl = _AUTO_PLANNING_CONFIG_PULLS_MAX
    raw_by = getattr(row, "pulls_limits_by_site", None)
    norm = _normalize_pulls_limits_by_site(raw_by if isinstance(raw_by, dict) else None)
    if norm:
        norm = {sid: (None if v is None else min(_AUTO_PLANNING_CONFIG_PULLS_MAX, max(1, int(v)))) for sid, v in norm.items()}
    return gpl, (norm if norm else None)


def _serialize_auto_planning_config(row: DirectorAutoPlanningConfig | None) -> AutoPlanningConfigOut:
    auto_save_mode = str(getattr(row, "auto_save_mode", "manual") or "manual")
    if auto_save_mode not in ("manual", "director", "shared"):
        auto_save_mode = "manual"
    next_run_at = None
    # Toujours renvoyer la semaine cible pour la barre UI (même תכנון אוטומטי כבוי).
    target_week_iso = _next_week_iso(datetime.now())
    if row and bool(getattr(row, "enabled", False)):
        next_run_dt = _next_effective_run_time(datetime.now(), row)
        next_run_at = int(next_run_dt.timestamp() * 1000)
        target_week_iso = _next_week_iso(next_run_dt)
    raw_plim = getattr(row, "pulls_limit", None) if row else None
    pulls_limit_out: int | None = None
    if raw_plim is not None:
        try:
            pulls_limit_out = int(raw_plim)
        except Exception:
            pulls_limit_out = None
        if pulls_limit_out is not None:
            if pulls_limit_out < 1:
                pulls_limit_out = None
            else:
                pulls_limit_out = min(_AUTO_PLANNING_CONFIG_PULLS_MAX, pulls_limit_out)
    raw_by_site = getattr(row, "pulls_limits_by_site", None) if row else None
    pulls_limits_by_site_out: dict[str, int] | None = None
    if isinstance(raw_by_site, dict) and raw_by_site:
        tmp: dict[str, int] = {}
        for k, v in raw_by_site.items():
            try:
                lim = int(v) if v is not None else None
            except Exception:
                continue
            if lim is not None and lim >= 1:
                tmp[str(int(k)) if str(k).lstrip("-").isdigit() else str(k)] = min(_AUTO_PLANNING_CONFIG_PULLS_MAX, lim)
        pulls_limits_by_site_out = tmp or None

    return AutoPlanningConfigOut(
        enabled=bool(getattr(row, "enabled", False)),
        day_of_week=int(getattr(row, "day_of_week", 0) or 0),
        hour=int(getattr(row, "hour", 9) or 0),
        minute=int(getattr(row, "minute", 0) or 0),
        auto_pulls_enabled=bool(getattr(row, "auto_pulls_enabled", False)),
        auto_save_mode=auto_save_mode,
        pulls_limit=pulls_limit_out,
        pulls_limits_by_site=pulls_limits_by_site_out,
        last_run_week_iso=getattr(row, "last_run_week_iso", None),
        last_run_at=getattr(row, "last_run_at", None),
        last_error=getattr(row, "last_error", None),
        next_run_at=next_run_at,
        target_week_iso=target_week_iso,
    )


def _build_solver_workers(rows: list[SiteWorker], weekly_overrides: dict[str, dict[str, list[str]]] | None) -> list[dict]:
    overrides = weekly_overrides or {}
    workers: list[dict] = []
    for r in rows:
        ovr = overrides.get(r.name)
        if isinstance(ovr, dict):
            avail = {}
            for day_key, shifts_list in ovr.items():
                if isinstance(shifts_list, list):
                    valid_shifts = [s for s in shifts_list if s]
                    if valid_shifts:
                        avail[day_key] = valid_shifts
        else:
            avail = {}
        workers.append({
            "id": r.id,
            "name": r.name,
            "max_shifts": r.max_shifts,
            "roles": r.roles or [],
            "availability": avail,
        })
    return workers


def _build_worker_snapshots(rows: list[SiteWorker]) -> list[dict]:
    snapshots: list[dict] = []
    for r in rows:
        snapshots.append({
            "id": r.id,
            "name": r.name,
            "max_shifts": r.max_shifts,
            "roles": r.roles or [],
            "availability": r.availability or { "sun": [], "mon": [], "tue": [], "wed": [], "thu": [], "fri": [], "sat": [] },
            "answers": r.answers or {},
        })
    return snapshots


def _save_site_week_plan(db: Session, site_id: int, week_iso: str, scope: str, data: dict) -> None:
    row = (
        db.query(SiteWeekPlan)
        .filter(SiteWeekPlan.site_id == site_id)
        .filter(SiteWeekPlan.week_iso == week_iso)
        .filter(SiteWeekPlan.scope == scope)
        .first()
    )
    now = _now_ms()
    if row:
        row.data = data
        row.updated_at = now
        flag_modified(row, "data")
    else:
        row = SiteWeekPlan(
            site_id=site_id,
            week_iso=week_iso,
            scope=scope,
            data=data,
            updated_at=now,
        )
        db.add(row)


def _norm_name_local(value: str | None) -> str:
    return str(value or "").strip().replace("\u200f", "").replace("\u200e", "").replace("\xa0", " ")


def _norm_role_local(value: str | None) -> str:
    return _norm_name_local(value).replace('"', "'")


def _hours_of(shift_name: str) -> str | None:
    s = str(shift_name or "")
    m = re.search(r"(\d{1,2})\s*[-:–]\s*(\d{1,2})", s)
    if m:
        return f"{m.group(1).zfill(2)}-{m.group(2).zfill(2)}"
    if re.search(r"בוקר", s, re.I):
        return "06-14"
    if re.search(r"צהר(יים|י)ם?", s, re.I):
        return "14-22"
    if re.search(r"לילה|night", s, re.I):
        return "22-06"
    return None


def _hours_from_config(station_cfg: dict | None, shift_name: str, day_key: str) -> str | None:
    station_cfg = station_cfg or {}

    def fmt(start: str | None, end: str | None) -> str | None:
        if not start or not end:
            return None
        return f"{start}-{end}"

    if station_cfg.get("perDayCustom") and isinstance(station_cfg.get("dayOverrides"), dict):
        day_cfg = (station_cfg.get("dayOverrides") or {}).get(day_key) or {}
        if day_cfg and day_cfg.get("active") is not False:
            shift_cfg = next((x for x in (day_cfg.get("shifts") or []) if isinstance(x, dict) and x.get("name") == shift_name), None)
            out = fmt(shift_cfg.get("start") if isinstance(shift_cfg, dict) else None, shift_cfg.get("end") if isinstance(shift_cfg, dict) else None)
            if out:
                return out

    shift_cfg = next((x for x in (station_cfg.get("shifts") or []) if isinstance(x, dict) and x.get("name") == shift_name), None)
    return fmt(shift_cfg.get("start") if isinstance(shift_cfg, dict) else None, shift_cfg.get("end") if isinstance(shift_cfg, dict) else None)


def _parse_hours_range(range_text: str | None) -> tuple[str, str] | None:
    text = str(range_text or "").strip()
    m = re.match(r"^\s*(\d{1,2}):?(\d{2})?\s*[-–]\s*(\d{1,2}):?(\d{2})?\s*$", text)
    if not m:
        return None
    return (f"{int(m.group(1)):02d}:{int(m.group(2) or '0'):02d}", f"{int(m.group(3)):02d}:{int(m.group(4) or '0'):02d}")


def _to_minutes(hhmm: str) -> int | None:
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(hhmm or "").strip())
    if not m:
        return None
    hh = int(m.group(1))
    mm = int(m.group(2))
    if hh < 0 or hh > 23 or mm < 0 or mm > 59:
        return None
    return hh * 60 + mm


def _from_minutes(value: int) -> str:
    value = int(value) % (24 * 60)
    return f"{value // 60:02d}:{value % 60:02d}"


def _split_range_for_pulls(start: str, end: str, max_each_minutes: int = 4 * 60) -> tuple[dict, dict]:
    s = _to_minutes(start)
    e0 = _to_minutes(end)
    if s is None or e0 is None:
        return ({"start": "00:00", "end": "12:00"}, {"start": "12:00", "end": "00:00"})
    e = e0
    if e <= s:
        e += 24 * 60
    duration = e - s
    each = min(max_each_minutes, duration / 2)
    return (
        {"start": _from_minutes(s), "end": _from_minutes(int(s + each))},
        {"start": _from_minutes(int(e - each)), "end": _from_minutes(e)},
    )


def _is_morning_shift_name(shift_name: str) -> bool:
    s = str(shift_name or "").strip()
    low = s.lower()
    return ("בוקר" in s) or low.startswith("06") or ("06-14" in low)


def _is_noon_shift_name(shift_name: str) -> bool:
    s = str(shift_name or "").strip()
    low = s.lower()
    return ("צהר" in s) or low.startswith("14") or ("14-22" in low)


def _is_night_shift_name(shift_name: str) -> bool:
    s = str(shift_name or "").strip()
    low = s.lower()
    return ("לילה" in s) or ("night" in low) or low.startswith("22") or ("22-06" in low)


def _pull_target_shift_priority(shift_name: str) -> tuple[int, str]:
    # Priorité métier: essayer d'abord de combler les trous d'après-midi.
    if _is_noon_shift_name(shift_name):
        return (0, str(shift_name or ""))
    if _is_morning_shift_name(shift_name):
        return (1, str(shift_name or ""))
    if _is_night_shift_name(shift_name):
        return (2, str(shift_name or ""))
    return (3, str(shift_name or ""))


def _boost_generation_budget_for_pulls(
    time_limit_seconds: int,
    num_alternatives: int,
) -> tuple[int, int]:
    # Les plannings avec משיכות ont plus de combinaisons valides à explorer.
    return max(int(time_limit_seconds), 20), max(int(num_alternatives), 80)


def _summarize_auto_planning_result(
    site: Site,
    assignments: dict | None,
    week_iso: str,
    source: str,
    error: str | None = None,
    pulls: dict | None = None,
) -> dict:
    from .ai_solver import build_capacities_from_config

    days, shifts, stations = build_capacities_from_config(site.config or {})
    total_required = 0
    for t_idx, st in enumerate(stations):
        cap_map = (st.get("capacity") or {})
        for day_key in days:
            for shift_name in shifts:
                total_required += int((cap_map.get(day_key, {}) or {}).get(shift_name, 0) or 0)

    total_assigned = 0
    assignments_map = assignments or {}
    if isinstance(assignments_map, dict):
        for day_key in days:
            shifts_map = assignments_map.get(day_key) or {}
            if not isinstance(shifts_map, dict):
                continue
            for shift_name in shifts:
                per_station = shifts_map.get(shift_name) or []
                if not isinstance(per_station, list):
                    continue
                for t_idx in range(len(stations)):
                    cell = per_station[t_idx] if t_idx < len(per_station) else []
                    if isinstance(cell, list):
                        total_assigned += len([nm for nm in cell if str(nm or "").strip()])
    if isinstance(pulls, dict):
        total_assigned = max(0, total_assigned - len(pulls))

    complete = (error is None) and (total_assigned == total_required)
    return {
        "week_iso": week_iso,
        "ran_at": _now_ms(),
        "source": source,
        "complete": complete,
        "assigned_count": total_assigned,
        "required_count": total_required,
        "error": error,
    }


def _store_site_auto_planning_status(site: Site, summary: dict) -> None:
    cfg = dict(site.config or {})
    cfg["autoPlanningLastRun"] = summary
    site.config = cfg
    flag_modified(site, "config")


def _clear_auto_planning_cache_for_director(
    db: Session,
    director_id: int,
    target_week_iso: str,
) -> None:
    """Désactivation du תכנון אוטומטי: purge cache auto hebdo (semaine cible suivante)."""
    sites = db.query(Site).filter(Site.director_id == director_id).all()
    if not sites:
        return
    site_ids = [int(s.id) for s in sites if getattr(s, "id", None)]
    if site_ids:
        auto_rows = (
            db.query(SiteWeekPlan)
            .filter(SiteWeekPlan.site_id.in_(site_ids))
            .filter(SiteWeekPlan.week_iso == target_week_iso)
            .filter(SiteWeekPlan.scope == "auto")
            .all()
        )
        for row in auto_rows:
            db.delete(row)
    for site in sites:
        cfg = dict(site.config or {})
        if "autoPlanningLastRun" not in cfg:
            continue
        cfg.pop("autoPlanningLastRun", None)
        site.config = cfg
        flag_modified(site, "config")


def _apply_auto_pulls_to_payload(site: Site, rows: list[SiteWorker], payload: dict, pulls_limit: int | None = None) -> dict:
    from .ai_solver import build_capacities_from_config

    assignments = payload.get("assignments")
    if not isinstance(assignments, dict):
        return payload

    site_cfg = site.config or {}
    station_cfgs = (site_cfg.get("stations") or []) if isinstance(site_cfg, dict) else []
    days, shifts, stations = build_capacities_from_config(site_cfg)
    name_to_roles = {
        _norm_name_local(r.name): {_norm_role_local(x) for x in (r.roles or [])}
        for r in rows
    }
    pulls: dict[str, dict] = {}
    normalized_pulls_limit = int(pulls_limit) if pulls_limit is not None else None

    def worker_has_role(worker_name: str, role_name: str) -> bool:
        return _norm_role_local(role_name) in name_to_roles.get(_norm_name_local(worker_name), set())

    def get_cell_names(day_key: str, shift_name: str, station_idx: int) -> list[str]:
        per_shift = (assignments.get(day_key) or {}).get(shift_name) or []
        if not isinstance(per_shift, list) or station_idx >= len(per_shift):
            return []
        raw = per_shift[station_idx]
        return [_norm_name_local(x) for x in raw] if isinstance(raw, list) else []

    def set_cell_names(day_key: str, shift_name: str, station_idx: int, names: list[str]) -> None:
        assignments.setdefault(day_key, {})
        per_shift = assignments[day_key].setdefault(shift_name, [])
        while len(per_shift) <= station_idx:
            per_shift.append([])
        per_shift[station_idx] = names

    def pulled_names_for(day_key: str, shift_name: str) -> set[str]:
        out: set[str] = set()
        prefix = f"{day_key}|{shift_name}|"
        for key, entry in pulls.items():
            if not str(key).startswith(prefix):
                continue
            before_name = _norm_name_local(((entry or {}).get("before") or {}).get("name"))
            after_name = _norm_name_local(((entry or {}).get("after") or {}).get("name"))
            if before_name:
                out.add(before_name)
            if after_name:
                out.add(after_name)
        return out

    def prev_of(day_idx: int, shift_idx: int) -> tuple[int, int] | None:
        if day_idx == 0 and shift_idx == 0:
            return None
        if shift_idx == 0:
            return (day_idx - 1, len(shifts) - 1)
        return (day_idx, shift_idx - 1)

    def next_of(day_idx: int, shift_idx: int) -> tuple[int, int] | None:
        if day_idx == len(days) - 1 and shift_idx == len(shifts) - 1:
            return None
        if shift_idx == len(shifts) - 1:
            return (day_idx + 1, 0)
        return (day_idx, shift_idx + 1)

    target_cells: list[tuple[tuple[int, str], int, int, str]] = []
    for station_idx, station in enumerate(stations):
        station_cfg = station_cfgs[station_idx] if station_idx < len(station_cfgs) and isinstance(station_cfgs[station_idx], dict) else {}
        cap_map = station.get("capacity") or {}
        for day_idx, day_key in enumerate(days):
            for shift_idx, shift_name in enumerate(shifts):
                required = int((cap_map.get(day_key, {}) or {}).get(shift_name, 0) or 0)
                prev_coord = prev_of(day_idx, shift_idx)
                next_coord = next_of(day_idx, shift_idx)
                if required <= 0 or not prev_coord or not next_coord:
                    continue
                target_cells.append((_pull_target_shift_priority(shift_name), station_idx, day_idx, shift_name))

    target_cells.sort(key=lambda item: (item[0], item[2], item[1]))

    for _, station_idx, day_idx, shift_name in target_cells:
        if normalized_pulls_limit is not None and len(pulls) >= normalized_pulls_limit:
            break
        station = stations[station_idx]
        station_cfg = station_cfgs[station_idx] if station_idx < len(station_cfgs) and isinstance(station_cfgs[station_idx], dict) else {}
        cap_map = station.get("capacity") or {}
        cap_roles = station.get("capacity_roles") or {}
        day_key = days[day_idx]
        shift_idx = shifts.index(shift_name)
        required = int((cap_map.get(day_key, {}) or {}).get(shift_name, 0) or 0)
        prev_coord = prev_of(day_idx, shift_idx)
        next_coord = next_of(day_idx, shift_idx)
        if required <= 0 or not prev_coord or not next_coord:
            continue

        while True:
            if normalized_pulls_limit is not None and len(pulls) >= normalized_pulls_limit:
                break
            cell_prefix = f"{day_key}|{shift_name}|{station_idx}|"
            existing_pull_keys = [k for k in pulls if str(k).startswith(cell_prefix)]
            current_names = get_cell_names(day_key, shift_name, station_idx)
            assigned_places = max(0, len(current_names) - len(existing_pull_keys))
            if required - assigned_places < 1:
                break

            prev_day, prev_shift = days[prev_coord[0]], shifts[prev_coord[1]]
            next_day, next_shift = days[next_coord[0]], shifts[next_coord[1]]
            prev_prev = prev_of(prev_coord[0], prev_coord[1])
            next_next = next_of(next_coord[0], next_coord[1])
            prev_names = [nm for nm in get_cell_names(prev_day, prev_shift, station_idx) if nm not in pulled_names_for(prev_day, prev_shift)]
            next_names = [nm for nm in get_cell_names(next_day, next_shift, station_idx) if nm not in pulled_names_for(next_day, next_shift)]
            used_in_cell = set(current_names)
            pulled_before_prev = pulled_names_for(days[prev_prev[0]], shifts[prev_prev[1]]) if prev_prev else set()
            pulled_after_next = pulled_names_for(days[next_next[0]], shifts[next_next[1]]) if next_next else set()

            before_candidates = [nm for nm in prev_names if nm not in used_in_cell and nm not in pulled_before_prev]
            after_candidates = [nm for nm in next_names if nm not in used_in_cell and nm not in pulled_after_next]
            both_sides = {nm for nm in before_candidates if nm in set(after_candidates)}
            before_candidates = [nm for nm in before_candidates if nm not in both_sides]
            after_candidates = [nm for nm in after_candidates if nm not in both_sides]
            if not before_candidates or not after_candidates:
                break

            req_roles = (cap_roles.get(day_key, {}) or {}).get(shift_name, {}) or {}
            role_name = None
            before_options = before_candidates
            after_options = after_candidates
            if req_roles:
                for rn in [str(x) for x in req_roles.keys() if str(x).strip()]:
                    b = [nm for nm in before_candidates if worker_has_role(nm, rn)]
                    a = [nm for nm in after_candidates if worker_has_role(nm, rn)]
                    if not b or not a:
                        continue
                    if len(b) == 1 and len(a) == 1 and b[0] == a[0]:
                        continue
                    role_name = rn
                    before_options = b
                    after_options = a
                    break
                if not role_name:
                    break
            elif len(before_options) == 1 and len(after_options) == 1 and before_options[0] == after_options[0]:
                break

            before_name = before_options[0] if before_options else ""
            after_name = next((nm for nm in after_options if nm != before_name), "")
            if not before_name or not after_name:
                break

            hours = _hours_from_config(station_cfg, shift_name, day_key) or _hours_of(shift_name) or "00:00-00:00"
            parsed = _parse_hours_range(hours)
            shift_start, shift_end = parsed if parsed else ("00:00", "00:00")
            before_range, after_range = _split_range_for_pulls(shift_start, shift_end)

            new_pull_count = len(existing_pull_keys) + 1
            next_names = list(current_names)
            if before_name not in next_names:
                next_names.append(before_name)
            if after_name not in next_names:
                next_names.append(after_name)
            if len(next_names) > required + new_pull_count:
                break

            slot_idx = required + len(existing_pull_keys)
            pulls[f"{day_key}|{shift_name}|{station_idx}|{slot_idx}"] = {
                "before": {"name": before_name, "start": before_range["start"], "end": before_range["end"]},
                "after": {"name": after_name, "start": after_range["start"], "end": after_range["end"]},
                "roleName": role_name,
            }
            set_cell_names(day_key, shift_name, station_idx, next_names)

    payload["assignments"] = assignments
    payload["pulls"] = pulls
    return payload


def _enforce_role_requirements_on_assignments(
    site_config: dict | None,
    assignments_value: dict | None,
    workers_rows: list[SiteWorker],
) -> dict:
    """Retire les noms non compatibles avec les rôles requis d’un slot.

    Règle: si un slot a au moins un rôle requis (>0), chaque nom assigné doit porter au moins
    un de ces rôles. Sinon le nom est retiré du slot.
    """
    if not isinstance(assignments_value, dict):
        return {}
    from .ai_solver import build_capacities_from_config

    days, shifts, stations = build_capacities_from_config(site_config or {})
    if not stations:
        return assignments_value

    worker_roles_by_name: dict[str, set[str]] = {}
    for row in workers_rows:
        nm = _norm_name_local(getattr(row, "name", None))
        if not nm:
            continue
        role_set = worker_roles_by_name.setdefault(nm, set())
        for role_name in (getattr(row, "roles", None) or []):
            norm_role = _norm_role_local(role_name)
            if norm_role:
                role_set.add(norm_role)

    out = deepcopy(assignments_value)
    for station_idx, st in enumerate(stations):
        cap_roles = (st.get("capacity_roles") or {}) if isinstance(st, dict) else {}
        for day_key in days:
            for shift_name in shifts:
                role_map_raw = ((cap_roles.get(day_key, {}) or {}).get(shift_name, {}) or {})
                required_roles = {
                    _norm_role_local(role_name)
                    for role_name, cnt in (role_map_raw.items() if isinstance(role_map_raw, dict) else [])
                    if int(cnt or 0) > 0 and _norm_role_local(role_name)
                }
                if not required_roles:
                    continue
                per_shift = (out.get(day_key) or {}).get(shift_name)
                if not isinstance(per_shift, list) or station_idx >= len(per_shift):
                    continue
                cell = per_shift[station_idx]
                if not isinstance(cell, list):
                    continue
                filtered_cell: list[str] = []
                for raw_name in cell:
                    norm_name = _norm_name_local(str(raw_name or ""))
                    if not norm_name:
                        continue
                    worker_roles = worker_roles_by_name.get(norm_name, set())
                    if worker_roles.intersection(required_roles):
                        filtered_cell.append(str(raw_name))
                per_shift[station_idx] = filtered_cell
    return out


def _build_next_week_saved_plan_status(site: Site, row: SiteWeekPlan | None, week_iso: str) -> NextWeekSavedPlanStatus:
    assignments = None
    pulls = None
    scope = None
    if row and isinstance(row.data, dict):
        assignments = row.data.get("assignments")
        pulls = row.data.get("pulls")
        scope = str(row.scope or "").strip() or None
    if not isinstance(assignments, dict):
        return NextWeekSavedPlanStatus(
            exists=False,
            week_iso=week_iso,
            complete=None,
            assigned_count=0,
            required_count=0,
            pulls_count=0,
            scope=None,
            requires_manual_save=False,
        )

    summary = _summarize_auto_planning_result(
        site,
        assignments,
        week_iso,
        "saved-next-week",
        pulls=pulls if isinstance(pulls, dict) else None,
    )
    return NextWeekSavedPlanStatus(
        exists=True,
        week_iso=week_iso,
        complete=bool(summary.get("complete")),
        assigned_count=int(summary.get("assigned_count") or 0),
        required_count=int(summary.get("required_count") or 0),
        pulls_count=len(pulls) if isinstance(pulls, dict) else 0,
        scope=scope if scope in ("auto", "director", "shared") else None,
        requires_manual_save=scope == "auto",
    )


def _week_plan_rank(row: SiteWeekPlan) -> int:
    data = row.data if isinstance(row.data, dict) else {}
    has_assignments = isinstance(data.get("assignments"), dict)
    # Important: si un plan déjà sauvegardé existe (director/shared) pour cette semaine,
    # on ne doit pas "préférer" le brouillon auto, sinon on affiche à tort
    # le badge "ממתין לשמירה".
    if not has_assignments:
        return 0
    if row.scope == "shared":
        return 300
    if row.scope == "director":
        return 200
    if row.scope == "auto":
        return 100
    return 0


def _preferred_week_plan(site_rows: list[SiteWeekPlan]) -> SiteWeekPlan | None:
    best_row: SiteWeekPlan | None = None
    best_rank = -1
    for row in site_rows:
        rank = _week_plan_rank(row)
        if rank > best_rank:
            best_rank = rank
            best_row = row
    return best_row


def _worker_identity_key(row: SiteWorker) -> str:
    if getattr(row, "user_id", None):
        return f"user:{int(row.user_id)}"
    # Keep identity stable across sites even when phone/name formatting differs.
    phone_raw = str(getattr(row, "phone", "") or "")
    phone = "".join(ch for ch in phone_raw if ch.isdigit() or ch == "+").strip()
    if phone:
        return f"phone:{phone}"
    name_raw = _norm_name_local(getattr(row, "name", ""))
    name = re.sub(r"\s+", " ", str(name_raw or "").strip()).lower()
    return f"name:{name}"


def _active_director_site_ids(db: Session, director_id: int) -> set[int]:
    """Sites non supprimés : les liaisons multi-site ne portent que sur ces ids (historique sur site archivé exclu du graphe)."""
    return {
        int(s.id)
        for s in db.query(Site).filter(Site.director_id == director_id, Site.deleted_at.is_(None)).all()
    }


def _connected_site_ids_for_root(db: Session, director_id: int, root_site_id: int, graph_week_iso: str | None = None) -> list[int]:
    """Composantes connexes par travailleur identique. Exclut pending et retraits (removed_from) pour la semaine du graphe (None = effectif « maintenant »)."""
    site_ids_set = _active_director_site_ids(db, director_id)
    site_ids = sorted(site_ids_set)
    rows = (
        [
            row
            for row in db.query(SiteWorker).filter(SiteWorker.site_id.in_(site_ids)).all()
            if not bool(getattr(row, "pending_approval", False)) and _site_worker_visible_for_week(row, graph_week_iso)
        ]
        if site_ids
        else []
    )
    site_to_keys: dict[int, set[str]] = {}
    key_to_sites: dict[str, set[int]] = {}
    for row in rows:
        site_id = int(row.site_id)
        key = _worker_identity_key(row)
        if not key:
            continue
        site_to_keys.setdefault(site_id, set()).add(key)
        key_to_sites.setdefault(key, set()).add(site_id)

    visited: set[int] = set()
    queue: list[int] = [int(root_site_id)]
    while queue:
        site_id = queue.pop(0)
        if site_id in visited:
            continue
        visited.add(site_id)
        for key in site_to_keys.get(site_id, set()):
            for linked_site_id in key_to_sites.get(key, set()):
                if linked_site_id not in visited:
                    queue.append(linked_site_id)
    return sorted(visited)


def _linked_site_cluster_map_for_director(
    db: Session,
    director_id: int,
    graph_week_iso: str | None = None,
) -> dict[int, list[int]]:
    """Pour chaque site, liste triée des ids du même groupe multi-sites (≥2) ; [] si isolé."""
    site_ids_set = _active_director_site_ids(db, director_id)
    site_ids = sorted(site_ids_set)
    if not site_ids:
        return {}
    rows = db.query(SiteWorker).filter(SiteWorker.site_id.in_(site_ids)).all()
    rows = [
        row
        for row in rows
        if not bool(getattr(row, "pending_approval", False)) and _site_worker_visible_for_week(row, graph_week_iso)
    ]
    key_to_sites: dict[str, set[int]] = {}
    for row in rows:
        key = _worker_identity_key(row)
        if not key:
            continue
        key_to_sites.setdefault(key, set()).add(int(row.site_id))
    parent = {sid: sid for sid in site_ids}

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for site_set in key_to_sites.values():
        ids_sorted = sorted(site_set)
        if len(ids_sorted) < 2:
            continue
        first = ids_sorted[0]
        for sid in ids_sorted[1:]:
            union(first, sid)

    root_members: dict[int, list[int]] = {}
    for sid in site_ids:
        r = find(sid)
        root_members.setdefault(r, []).append(sid)
    out: dict[int, list[int]] = {}
    for _root, members in root_members.items():
        msorted = sorted(members)
        if len(msorted) < 2:
            for sid in msorted:
                out[sid] = []
        else:
            for sid in msorted:
                out[sid] = msorted
    return out


def _site_role_key(site_id: int, role_name: str | None) -> str:
    return f"site:{site_id}:{_norm_role_local(role_name)}"


def _linked_site_ids_for_worker(db: Session, director_id: int, row: SiteWorker) -> list[int]:
    director_site_ids = sorted(_active_director_site_ids(db, director_id))
    if not director_site_ids:
        return [int(row.site_id)]
    key = _worker_identity_key(row)
    linked_rows = db.query(SiteWorker).filter(SiteWorker.site_id.in_(director_site_ids)).all()
    linked_site_ids = sorted(
        {
            int(r.site_id)
            for r in linked_rows
            if _worker_identity_key(r) == key
            and not bool(getattr(r, "pending_approval", False))
            and _site_worker_visible_for_week(r, None)
        }
    )
    return linked_site_ids or [int(row.site_id)]


def _linked_site_ids_by_worker_key(
    rows: list[SiteWorker],
    graph_week_iso: str | None = None,
    active_site_ids: set[int] | None = None,
) -> dict[str, list[int]]:
    key_to_site_ids: dict[str, set[int]] = {}
    for row in rows:
        if bool(getattr(row, "pending_approval", False)) or not _site_worker_visible_for_week(row, graph_week_iso):
            continue
        key = _worker_identity_key(row)
        if not key:
            continue
        site_id = int(row.site_id)
        if active_site_ids is not None and site_id not in active_site_ids:
            continue
        key_to_site_ids.setdefault(key, set()).add(site_id)
    return {key: sorted(site_ids) for key, site_ids in key_to_site_ids.items()}


def _prefix_roles_for_combined_station(station_cfg: dict, site_id: int) -> dict:
    cloned = deepcopy(station_cfg)

    def prefix_roles(items: list[dict] | None) -> list[dict]:
        out: list[dict] = []
        for item in (items or []):
            if not isinstance(item, dict):
                continue
            cp = dict(item)
            cp["name"] = _site_role_key(site_id, item.get("name"))
            out.append(cp)
        return out

    cloned["roles"] = prefix_roles(cloned.get("roles"))
    cloned["shifts"] = [
        {**sh, "roles": prefix_roles((sh or {}).get("roles"))}
        for sh in (cloned.get("shifts") or [])
        if isinstance(sh, dict)
    ]
    if isinstance(cloned.get("dayOverrides"), dict):
        next_day_overrides = {}
        for day_key, ov in (cloned.get("dayOverrides") or {}).items():
            if not isinstance(ov, dict):
                next_day_overrides[day_key] = ov
                continue
            next_day_overrides[day_key] = {
                **ov,
                "shifts": [
                    {**sh, "roles": prefix_roles((sh or {}).get("roles"))}
                    for sh in (ov.get("shifts") or [])
                    if isinstance(sh, dict)
                ],
            }
        cloned["dayOverrides"] = next_day_overrides
    return cloned


def _build_multi_site_generation_context(
    db: Session,
    director_id: int,
    root_site_id: int,
    week_iso: str,
    weekly_availability: dict[str, dict[str, list[str]]] | None = None,
    exclude_days: list[str] | None = None,
    fixed_assignments: dict[str, dict[str, list[list[str]]]] | None = None,
) -> dict:
    connected_site_ids = _connected_site_ids_for_root(db, director_id, root_site_id, week_iso)
    sites = db.query(Site).filter(Site.id.in_(connected_site_ids)).all() if connected_site_ids else []
    sites_by_id = {int(s.id): s for s in sites}
    rows = (
        [
            row
            for row in db.query(SiteWorker).filter(SiteWorker.site_id.in_(connected_site_ids)).all()
            if not bool(getattr(row, "pending_approval", False)) and _site_worker_visible_for_week(row, week_iso)
        ]
        if connected_site_ids
        else []
    )
    weekly_rows = (
        db.query(SiteWeeklyAvailability)
        .filter(SiteWeeklyAvailability.site_id.in_(connected_site_ids))
        .filter(SiteWeeklyAvailability.week_iso == week_iso)
        .all()
        if connected_site_ids else []
    )
    weekly_overrides_by_site: dict[int, dict[str, dict[str, list[str]]]] = {
        int(row.site_id): (row.availability or {})
        for row in weekly_rows
    }
    saved_plan_rows = (
        db.query(SiteWeekPlan)
        .filter(SiteWeekPlan.site_id.in_(connected_site_ids))
        .filter(SiteWeekPlan.week_iso == week_iso)
        .filter(SiteWeekPlan.scope.in_(["director", "shared"]))
        .all()
        if connected_site_ids else []
    )
    saved_plan_rows_by_site: dict[int, list[SiteWeekPlan]] = {}
    for row in saved_plan_rows:
        saved_plan_rows_by_site.setdefault(int(row.site_id), []).append(row)

    worker_groups: dict[str, dict] = {}
    current_site_overrides = weekly_availability or {}
    for row in rows:
        key = _worker_identity_key(row)
        group = worker_groups.setdefault(key, {
            "solver_name": f"worker::{key}",
            "site_ids": set(),
            "site_display_names": {},
            "roles": set(),
            "max_shifts": [],
            "availability": None,
        })
        site_id = int(row.site_id)
        group["site_ids"].add(site_id)
        group["site_display_names"][site_id] = row.name
        group["max_shifts"].append(int(row.max_shifts or 5))
        for role_name in (row.roles or []):
            group["roles"].add(_site_role_key(site_id, str(role_name)))
        site_weekly_overrides = weekly_overrides_by_site.get(site_id, {})
        override = None
        if site_id == int(root_site_id):
            override = current_site_overrides.get(row.name)
        if not isinstance(override, dict):
            override = site_weekly_overrides.get(row.name)
        # Fusionner les disponibilités par union des jours/quarts entre les sites:
        # ne pas écraser la disponibilité déjà accumulée — prendre l'union pour que
        # le worker logique soit disponible sur un créneau dès qu'il l'est sur l'un de ses sites.
        if isinstance(override, dict):
            new_avail = {str(k): list(v) for k, v in override.items() if isinstance(v, list)}
        elif isinstance(row.availability, dict):
            new_avail = {str(k): list(v) for k, v in row.availability.items() if isinstance(v, list)}
        else:
            new_avail = None
        if new_avail is not None:
            if group["availability"] is None:
                group["availability"] = new_avail
            else:
                # Union : pour chaque jour, réunion des shifts disponibles
                merged = dict(group["availability"])
                for day_k, shifts_list in new_avail.items():
                    if day_k in merged:
                        existing = set(merged[day_k])
                        existing.update(shifts_list)
                        merged[day_k] = sorted(existing)
                    else:
                        merged[day_k] = list(shifts_list)
                group["availability"] = merged

    combined_stations: list[dict] = []
    station_map: list[dict] = []
    for site_id in connected_site_ids:
        site = sites_by_id.get(site_id)
        if not site:
            continue
        for idx, station_cfg in enumerate(((site.config or {}).get("stations") or [])):
            if not isinstance(station_cfg, dict):
                continue
            cloned = _prefix_roles_for_combined_station(station_cfg, site_id)
            cloned["name"] = f"{site.name} / {cloned.get('name') or f'עמדה {idx + 1}'}"
            cloned["siteId"] = site_id
            cloned["siteName"] = site.name
            cloned["siteStationIndex"] = idx
            cloned["allowedWorkers"] = [
                group["solver_name"]
                for group in worker_groups.values()
                if site_id in group["site_ids"]
            ]
            combined_stations.append(cloned)
            station_map.append({"site_id": site_id, "site_station_index": idx})

    combined_config = {"stations": combined_stations}

    # Pour chaque site, construire la liste des indices de stations dans combined_stations
    site_station_indices: dict[int, list[int]] = {}
    for combined_idx, meta in enumerate(station_map):
        sid = int(meta["site_id"])
        site_station_indices.setdefault(sid, []).append(combined_idx)

    combined_workers = []
    for idx, (key, group) in enumerate(worker_groups.items()):
        global_max = min(group["max_shifts"]) if group["max_shifts"] else 5
        # site_limits: contrainte max_shifts par site pour ce worker multi-site
        # Chaque entrée = (liste d'indices de stations du site, max_shifts pour ce site)
        site_limits = []
        for site_id in group["site_ids"]:
            st_indices = site_station_indices.get(int(site_id), [])
            # max_shifts du worker sur ce site spécifique
            # On prend le max_shifts de la première (et unique) occurrence du worker sur ce site
            site_row_max = 5
            for row in rows:
                if int(row.site_id) == int(site_id) and _worker_identity_key(row) == key:
                    site_row_max = int(row.max_shifts or 5)
                    break
            if st_indices:
                site_limits.append({"station_indices": st_indices, "max": site_row_max})
        combined_workers.append({
            "id": idx + 1,
            "name": group["solver_name"],
            "max_shifts": global_max,
            "roles": sorted(group["roles"]),
            "availability": group["availability"] or {},
            "site_limits": site_limits,
        })

    fixed_assignments_by_site: dict[int, dict[str, dict[str, list[list[str]]]]] = {}
    for site_id in connected_site_ids:
        if int(site_id) == int(root_site_id):
            continue
        preferred_row = _preferred_week_plan(saved_plan_rows_by_site.get(int(site_id), []))
        preferred_data = preferred_row.data if preferred_row and isinstance(preferred_row.data, dict) else {}
        preferred_assignments = preferred_data.get("assignments")
        if isinstance(preferred_assignments, dict):
            fixed_assignments_by_site[int(site_id)] = preferred_assignments
    if fixed_assignments:
        fixed_assignments_by_site[int(root_site_id)] = fixed_assignments

    combined_fixed: dict[str, dict[str, list[list[str]]]] | None = None
    if fixed_assignments_by_site:
        root_site = sites_by_id.get(int(root_site_id))
        if root_site:
            from .ai_solver import build_capacities_from_config
            root_days, root_shifts, _root_stations = build_capacities_from_config(root_site.config or {}, exclude_days)
            name_to_solver_by_site: dict[int, dict[str, str]] = {}
            for key, group in worker_groups.items():
                for site_id, site_name in group["site_display_names"].items():
                    name_to_solver_by_site.setdefault(int(site_id), {})[str(site_name)] = group["solver_name"]
            combined_fixed = {day: {sh: [[] for _ in combined_stations] for sh in root_shifts} for day in root_days}
            station_index_map_by_site: dict[int, dict[int, int]] = {}
            for idx, meta in enumerate(station_map):
                site_id = int(meta["site_id"])
                station_index_map_by_site.setdefault(site_id, {})[int(meta["site_station_index"])] = idx
            for site_id, site_fixed_assignments in fixed_assignments_by_site.items():
                station_index_map = station_index_map_by_site.get(int(site_id), {})
                name_to_solver = name_to_solver_by_site.get(int(site_id), {})
                for day_key, shifts_map in (site_fixed_assignments or {}).items():
                    if day_key not in combined_fixed or not isinstance(shifts_map, dict):
                        continue
                    for shift_name, per_station in shifts_map.items():
                        if shift_name not in combined_fixed[day_key] or not isinstance(per_station, list):
                            continue
                        for local_idx, cell in enumerate(per_station):
                            combined_idx = station_index_map.get(local_idx)
                            if combined_idx is None or not isinstance(cell, list):
                                continue
                            combined_fixed[day_key][shift_name][combined_idx] = [
                                name_to_solver.get(str(name), str(name))
                                for name in cell
                                if str(name or "").strip()
                            ]

    display_name_by_solver_site: dict[tuple[str, int], str] = {}
    for group in worker_groups.values():
        for site_id, display_name in group["site_display_names"].items():
            display_name_by_solver_site[(group["solver_name"], int(site_id))] = str(display_name)

    return {
        "connected_site_ids": connected_site_ids,
        "sites_by_id": sites_by_id,
        "combined_config": combined_config,
        "combined_workers": combined_workers,
        "combined_fixed": combined_fixed,
        "station_map": station_map,
        "display_name_by_solver_site": display_name_by_solver_site,
        "exclude_days": exclude_days,
    }


def _split_multi_site_assignments(
    context: dict,
    combined_assignments_value: dict | None,
    status: str | None = None,
    objective: float | int | None = None,
) -> dict[str, dict]:
    connected_site_ids = context["connected_site_ids"]
    sites_by_id = context["sites_by_id"]
    station_map = context["station_map"]
    display_name_by_solver_site = context["display_name_by_solver_site"]
    exclude_days = context["exclude_days"]

    site_plans_local: dict[str, dict] = {}
    for site_id in connected_site_ids:
        site = sites_by_id.get(site_id)
        if not site:
            continue
        from .ai_solver import build_capacities_from_config
        days, shifts, stations = build_capacities_from_config(site.config or {}, exclude_days)
        required_count = 0
        for st in stations:
            cap_map = (st.get("capacity") or {})
            for day_key in days:
                for shift_name in shifts:
                    required_count += int((cap_map.get(day_key, {}) or {}).get(shift_name, 0) or 0)
        site_plans_local[str(site_id)] = {
            "site_id": site_id,
            "site_name": site.name,
            "days": days,
            "shifts": shifts,
            "stations": [st.get("name") for st in stations],
            "assignments": {day: {shift: [[] for _ in stations] for shift in shifts} for day in days},
            "status": status,
            "objective": objective,
            "assigned_count": 0,
            "required_count": required_count,
            "alternatives": [],
        }

    combined_assignments = combined_assignments_value or {}
    for combined_idx, meta in enumerate(station_map):
        site_id = int(meta["site_id"])
        local_idx = int(meta["site_station_index"])
        site_plan = site_plans_local.get(str(site_id))
        if not site_plan:
            continue
        for day_key in site_plan["days"]:
            for shift_name in site_plan["shifts"]:
                per_station = (combined_assignments.get(day_key) or {}).get(shift_name) or []
                names = per_station[combined_idx] if combined_idx < len(per_station) else []
                if not isinstance(names, list):
                    names = []
                site_plan["assignments"][day_key][shift_name][local_idx] = [
                    display_name_by_solver_site.get((str(name), site_id), str(name))
                    for name in names
                    if str(name or "").strip()
                ]
    # Comptage final par worker sur la grille combinée (avant découpe) et par site après découpe
    _logger = logging.getLogger("sites")
    # Comptage dans le plan combiné brut
    combined_worker_counts: dict[str, int] = {}
    for day_map in combined_assignments.values():
        for per_station in day_map.values():
            for cell in per_station:
                for nm in (cell or []):
                    nm = str(nm or "").strip()
                    if nm:
                        combined_worker_counts[nm] = combined_worker_counts.get(nm, 0) + 1
    # Workers solver qui dépassent leur max_shifts dans le combiné
    context_workers = context.get("combined_workers") if context else None
    if context_workers:
        solver_max: dict[str, int] = {
            str(w.get("name") or "").strip(): int(w.get("max_shifts") or 5)
            for w in context_workers
        }
        over_combined = {
            nm: (cnt, solver_max.get(nm, 5))
            for nm, cnt in combined_worker_counts.items()
            if cnt > solver_max.get(nm, 5)
        }
        if over_combined:
            _logger.warning(
                "[SPLIT] workers over max_shifts in COMBINED plan (before split): %s",
                over_combined,
            )
        else:
            _logger.info(
                "[SPLIT] all workers within max_shifts in combined plan. counts=%s",
                dict(sorted(combined_worker_counts.items())),
            )

    # Construire la map display_name → max_shifts global (min des sites du groupe)
    # pour pouvoir appliquer le plafond global après la découpe.
    display_name_to_max: dict[str, int] = {}
    display_name_by_solver_site_local = context.get("display_name_by_solver_site") or {}
    context_workers_list = context.get("combined_workers") or []
    for w in context_workers_list:
        solver_name = str(w.get("name") or "").strip()
        max_s = int(w.get("max_shifts") or 5)
        # Récupérer tous les display_names associés à ce solver_name (toutes les (solver_name, site_id))
        for (sn, _sid), dname in display_name_by_solver_site_local.items():
            if str(sn) == solver_name:
                dname = str(dname or "").strip()
                if dname:
                    # Prendre le minimum en cas d'incohérence
                    display_name_to_max[dname] = min(display_name_to_max.get(dname, max_s), max_s)

    # Appliquer le plafond global cross-sites :
    # compter toutes les occurrences du display_name sur TOUS les sites, puis retirer les surplus.
    if display_name_to_max:
        global_counts: dict[str, int] = {}
        # Parcourir dans un ordre déterministe (sites triés) pour un comportement reproductible
        for site_id_str in sorted(site_plans_local.keys()):
            sp = site_plans_local[site_id_str]
            for day_key in sp["days"]:
                for shift_name in sp["shifts"]:
                    per_station = (sp["assignments"].get(day_key, {}) or {}).get(shift_name, [])
                    for cell in per_station:
                        if not isinstance(cell, list):
                            continue
                        kept = []
                        for nm in cell:
                            nm = str(nm or "").strip()
                            if not nm:
                                continue
                            max_g = display_name_to_max.get(nm)
                            if max_g is not None and global_counts.get(nm, 0) >= max_g:
                                _logger.warning(
                                    "[SPLIT][GLOBAL_CAP] removed extra assignment: worker=%r site=%s day=%s shift=%s (global_count=%d max=%d)",
                                    nm, site_id_str, day_key, shift_name,
                                    global_counts.get(nm, 0), max_g,
                                )
                                continue
                            global_counts[nm] = global_counts.get(nm, 0) + 1
                            kept.append(nm)
                        cell[:] = kept

    for site_plan in site_plans_local.values():
        assigned_count = 0
        site_worker_counts: dict[str, int] = {}
        for day_key in site_plan["days"]:
            for shift_name in site_plan["shifts"]:
                for cell in (site_plan["assignments"].get(day_key, {}) or {}).get(shift_name, []):
                    if isinstance(cell, list):
                        for nm in cell:
                            nm = str(nm or "").strip()
                            if nm:
                                assigned_count += 1
                                site_worker_counts[nm] = site_worker_counts.get(nm, 0) + 1
        site_plan["assigned_count"] = assigned_count
        _logger.info(
            "[SPLIT] site=%s assigned=%d worker_counts=%s",
            site_plan.get("site_id"),
            assigned_count,
            dict(sorted(site_worker_counts.items())),
        )
    return site_plans_local


def _generate_multi_site_memory_plans(
    db: Session,
    director_id: int,
    root_site_id: int,
    week_iso: str,
    weekly_availability: dict[str, dict[str, list[str]]] | None = None,
    exclude_days: list[str] | None = None,
    fixed_assignments: dict[str, dict[str, list[list[str]]]] | None = None,
    num_alternatives: int | None = 20,
) -> dict:
    context = _build_multi_site_generation_context(
        db,
        director_id,
        root_site_id,
        week_iso,
        weekly_availability=weekly_availability,
        exclude_days=exclude_days,
        fixed_assignments=fixed_assignments,
    )

    result = solve_schedule(
        context["combined_config"],
        context["combined_workers"],
        time_limit_seconds=45,
        max_nights_per_worker=3,
        num_alternatives=num_alternatives,
        fixed_assignments=context["combined_fixed"],
        exclude_days=exclude_days,
    )

    filled_base_site_plans = _split_multi_site_assignments(
        context,
        result.get("assignments") or {},
        status=result.get("status"),
        objective=result.get("objective"),
    )
    filled_base_site_plans = _enforce_role_requirements_on_site_plans(
        db,
        context["sites_by_id"],
        filled_base_site_plans,
    )
    for site_id, site_plan in filled_base_site_plans.items():
        site_plan["status"] = result.get("status")
        site_plan["objective"] = result.get("objective")
    for alt_assignments in (result.get("alternatives") or []):
        alt_site_plans = _split_multi_site_assignments(
            context,
            alt_assignments if isinstance(alt_assignments, dict) else {},
            status=result.get("status"),
            objective=result.get("objective"),
        )
        alt_site_plans = _enforce_role_requirements_on_site_plans(
            db,
            context["sites_by_id"],
            alt_site_plans,
        )
        for site_id, alt_site_plan in alt_site_plans.items():
            filled_base_site_plans[site_id].setdefault("alternatives", []).append(alt_site_plan["assignments"])

    linked_sites = [
        {"id": site_id, "name": context["sites_by_id"][site_id].name}
        for site_id in context["connected_site_ids"]
        if site_id in context["sites_by_id"]
    ]
    return {
        "root_site_id": root_site_id,
        "linked_sites": linked_sites,
        "site_plans": filled_base_site_plans,
    }


def _apply_auto_pulls_to_site_plans(
    db: Session,
    sites_by_id: dict[int, Site],
    site_plans: dict[str, dict],
    pulls_limit: int | None = None,
    pulls_limits_by_site: dict[int, int | None] | None = None,
) -> dict[str, dict]:
    if not site_plans:
        return site_plans
    site_ids = [int(site_id) for site_id in site_plans.keys()]
    rows = db.query(SiteWorker).filter(SiteWorker.site_id.in_(site_ids)).all() if site_ids else []
    rows_by_site: dict[int, list[SiteWorker]] = {}
    for row in rows:
        rows_by_site.setdefault(int(row.site_id), []).append(row)

    for site_id_str, site_plan in site_plans.items():
        site_id = int(site_id_str)
        site = sites_by_id.get(site_id)
        if not site:
            continue
        site_rows = rows_by_site.get(site_id, [])
        if pulls_limits_by_site is not None and site_id not in pulls_limits_by_site:
            site_plan["pulls"] = {}
            if site_plan.get("alternatives") is not None:
                site_plan["alternative_pulls"] = [{} for _ in (site_plan.get("alternatives") or [])]
            continue
        effective_site_limit = pulls_limits_by_site.get(site_id) if pulls_limits_by_site is not None else pulls_limit

        base_payload = _apply_auto_pulls_to_payload(
            site,
            site_rows,
            {"assignments": deepcopy(site_plan.get("assignments") or {}), "pulls": {}},
            pulls_limit=effective_site_limit,
        )
        site_plan["assignments"] = base_payload.get("assignments") or {}
        site_plan["pulls"] = base_payload.get("pulls") or {}
        site_plan["assigned_count"] = max(
            0,
            int(site_plan.get("assigned_count") or 0) - len(site_plan["pulls"]),
        )

        next_alternatives: list[dict] = []
        alternative_pulls: list[dict] = []
        for alt_assignments in (site_plan.get("alternatives") or []):
            alt_payload = _apply_auto_pulls_to_payload(
                site,
                site_rows,
                {"assignments": deepcopy(alt_assignments or {}), "pulls": {}},
                pulls_limit=effective_site_limit,
            )
            next_alternatives.append(alt_payload.get("assignments") or {})
            alternative_pulls.append(alt_payload.get("pulls") or {})
        if next_alternatives:
            site_plan["alternatives"] = next_alternatives
            site_plan["alternative_pulls"] = alternative_pulls
    return site_plans


def _enforce_role_requirements_on_site_plans(
    db: Session,
    sites_by_id: dict[int, Site],
    site_plans: dict[str, dict],
) -> dict[str, dict]:
    if not site_plans:
        return site_plans
    site_ids = [int(site_id) for site_id in site_plans.keys()]
    rows = db.query(SiteWorker).filter(SiteWorker.site_id.in_(site_ids)).all() if site_ids else []
    rows_by_site: dict[int, list[SiteWorker]] = {}
    for row in rows:
        rows_by_site.setdefault(int(row.site_id), []).append(row)

    for site_id_str, site_plan in site_plans.items():
        site_id = int(site_id_str)
        site = sites_by_id.get(site_id)
        if not site:
            continue
        site_rows = rows_by_site.get(site_id, [])
        site_plan["assignments"] = _enforce_role_requirements_on_assignments(
            site.config or {},
            site_plan.get("assignments") if isinstance(site_plan.get("assignments"), dict) else {},
            site_rows,
        )
        if isinstance(site_plan.get("alternatives"), list):
            site_plan["alternatives"] = [
                _enforce_role_requirements_on_assignments(
                    site.config or {},
                    alt if isinstance(alt, dict) else {},
                    site_rows,
                )
                for alt in (site_plan.get("alternatives") or [])
            ]
    return site_plans


def _pulls_count(pulls: dict | None) -> int:
    return len(pulls or {}) if isinstance(pulls, dict) else 0


def _matches_pulls_limit(pulls: dict | None, pulls_limit: int | None) -> bool:
    if pulls_limit is None:
        return True
    return _pulls_count(pulls) <= int(pulls_limit)


def _planning_limit_error_detail(pulls_limit: int) -> str:
    if int(pulls_limit) == 1:
        return "לא נמצא תכנון עם עד משיכה אחת"
    return f"לא נמצא תכנון עם עד {int(pulls_limit)} משיכות"


def _effective_auto_pulls_limit_for_site(
    site_id: int,
    global_limit: int | None,
    by_site: dict[int, int | None] | None,
) -> int | None:
    """Limite משיכות pour un site : entrée explicite dans by_site, sinon limite globale."""
    if by_site and site_id in by_site:
        return by_site.get(site_id)
    return global_limit


def _normalize_pulls_limits_by_site(raw_value: dict | None) -> dict[int, int | None]:
    normalized: dict[int, int | None] = {}
    if not isinstance(raw_value, dict):
        return normalized
    for site_key, raw_limit in raw_value.items():
        try:
            site_id = int(site_key)
        except Exception:
            continue
        if raw_limit is None:
            normalized[site_id] = None
            continue
        try:
            limit = int(raw_limit)
        except Exception:
            continue
        if limit >= 1:
            normalized[site_id] = limit
    return normalized


def _site_pulls_limit_matches(
    site_id: int,
    pulls: dict | None,
    default_pulls_limit: int | None = None,
    pulls_limits_by_site: dict[int, int | None] | None = None,
) -> bool:
    if pulls_limits_by_site is not None:
        if site_id not in pulls_limits_by_site:
            return _pulls_count(pulls) == 0
        return _matches_pulls_limit(pulls, pulls_limits_by_site.get(site_id))
    return _matches_pulls_limit(pulls, default_pulls_limit)


def _planning_limit_error_detail_for_request(
    pulls_limit: int | None = None,
    pulls_limits_by_site: dict[int, int | None] | None = None,
) -> str:
    if pulls_limits_by_site:
        enabled_limits = [limit for limit in pulls_limits_by_site.values() if limit is not None]
        if len(pulls_limits_by_site) == 1 and len(enabled_limits) == 1:
            return _planning_limit_error_detail(enabled_limits[0])
        return "לא נמצא תכנון עם מגבלות המשיכות שנבחרו באתרים המקושרים"
    if pulls_limit is not None:
        return _planning_limit_error_detail(pulls_limit)
    return "לא נמצא תכנון עם מגבלות המשיכות שנבחרו"


def _generate_director_week_plan_payload(
    db: Session,
    site: Site,
    week_iso: str,
    auto_pulls_enabled: bool = False,
    pulls_limit: int | None = None,
) -> dict:
    rows = [
        row
        for row in db.query(SiteWorker).filter(SiteWorker.site_id == site.id).all()
        if not bool(getattr(row, "pending_approval", False)) and _site_worker_visible_for_week(row, week_iso)
    ]
    weekly_row = (
        db.query(SiteWeeklyAvailability)
        .filter(SiteWeeklyAvailability.site_id == site.id)
        .filter(SiteWeeklyAvailability.week_iso == week_iso)
        .first()
    )
    weekly_overrides = (weekly_row.availability or {}) if weekly_row else {}
    workers = _build_solver_workers(rows, weekly_overrides)
    start_dt = datetime.fromisoformat(week_iso)
    end_dt = start_dt + timedelta(days=6)

    def make_payload(assignments_value: dict) -> dict:
        return {
            "siteId": int(site.id),
            "week": {
                "startISO": week_iso,
                "endISO": end_dt.date().isoformat(),
                "label": f"{week_iso} — {end_dt.date().isoformat()}",
            },
            "isManual": False,
            "assignments": assignments_value,
            "pulls": {},
            "workers": _build_worker_snapshots(rows),
        }

    if not workers:
        from .ai_solver import build_capacities_from_config

        days, shifts, stations = build_capacities_from_config(site.config or {})
        assignments = {day: {sh: [[] for _ in stations] for sh in shifts} for day in days}
        payload = make_payload(assignments)
        if auto_pulls_enabled:
            payload = _apply_auto_pulls_to_payload(site, rows, payload, pulls_limit=pulls_limit)
        return payload

    auto_pulls_time_limit, auto_pulls_num_alts = _boost_generation_budget_for_pulls(25, 20)

    result = solve_schedule(
        site.config or {},
        workers,
        time_limit_seconds=auto_pulls_time_limit if auto_pulls_enabled else 25,
        max_nights_per_worker=3,
        num_alternatives=auto_pulls_num_alts if auto_pulls_enabled else 1,
        fixed_assignments=None,
        exclude_days=None,
    )

    if not auto_pulls_enabled:
        cleaned_base_assignments = _enforce_role_requirements_on_assignments(
            site.config or {},
            result.get("assignments") if isinstance(result.get("assignments"), dict) else {},
            rows,
        )
        return make_payload(cleaned_base_assignments)

    candidate_assignments: list[dict] = [
        _enforce_role_requirements_on_assignments(
            site.config or {},
            result.get("assignments") if isinstance(result.get("assignments"), dict) else {},
            rows,
        )
    ]
    for alt in (result.get("alternatives") or []):
        if isinstance(alt, dict):
            candidate_assignments.append(
                _enforce_role_requirements_on_assignments(site.config or {}, alt, rows),
            )

    best_payload: dict | None = None
    best_key: tuple[int, int, int] | None = None
    best_idx = 0

    for idx, candidate in enumerate(candidate_assignments):
        candidate_payload = make_payload(candidate)
        candidate_payload = _apply_auto_pulls_to_payload(site, rows, candidate_payload, pulls_limit=pulls_limit)
        summary = _summarize_auto_planning_result(
            site,
            candidate_payload.get("assignments"),
            week_iso,
            "auto-pulls-eval",
            pulls=candidate_payload.get("pulls") if isinstance(candidate_payload.get("pulls"), dict) else None,
        )
        assigned = int(summary.get("assigned_count") or 0)
        required = int(summary.get("required_count") or 0)
        holes = max(0, required - assigned)
        pulls_count = len(candidate_payload.get("pulls") or {}) if isinstance(candidate_payload.get("pulls"), dict) else 0
        candidate_key = (holes, -assigned, pulls_count)
        if best_key is None or candidate_key < best_key:
            best_key = candidate_key
            best_payload = candidate_payload
            best_idx = idx

    if best_payload is not None:
        logger.info(
            "[AUTO-PLANNING] selected best alternative with pulls site_id=%s site_name=%s candidate_idx=%s holes=%s assigned=%s pulls=%s candidates=%s",
            site.id,
            site.name,
            best_idx,
            best_key[0] if best_key else None,
            -best_key[1] if best_key else None,
            best_key[2] if best_key else None,
            len(candidate_assignments),
        )
        return best_payload

    assignments = result["assignments"]
    payload = make_payload(assignments)
    if auto_pulls_enabled:
        payload = _apply_auto_pulls_to_payload(site, rows, payload, pulls_limit=pulls_limit)
    return payload


def _run_auto_planning_for_director(
    db: Session,
    director_id: int,
    target_week_iso: str,
    source: str = "auto",
    auto_pulls_enabled: bool = False,
    auto_save_mode: str = "manual",
    pulls_limit: int | None = None,
    pulls_limits_by_site: dict[int, int | None] | None = None,
) -> tuple[int, list[str]]:
    sites = db.query(Site).filter(Site.director_id == director_id).all()
    errors: list[str] = []
    success_count = 0
    sites_by_id: dict[int, Site] = {int(site.id): site for site in sites}
    cluster_map = _linked_site_cluster_map_for_director(db, director_id)
    processed_site_ids: set[int] = set()
    logger.info(
        "[AUTO-PLANNING] run start director_id=%s source=%s target_week=%s sites=%s",
        director_id,
        source,
        target_week_iso,
        len(sites),
    )

    def _persist_generated_payload(site: Site, payload: dict) -> None:
        nonlocal success_count
        summary = _summarize_auto_planning_result(
            site,
            payload.get("assignments"),
            target_week_iso,
            source,
            pulls=payload.get("pulls") if isinstance(payload.get("pulls"), dict) else None,
        )
        # ידני : toujours טיוטת `auto` (visible dans le planning) — pas de promotion director/shared sans choix explicite.
        save_mode = str(auto_save_mode or "manual").strip()
        target_scope = "auto"
        if bool(summary.get("complete")) and save_mode in ("director", "shared"):
            target_scope = save_mode
        _save_site_week_plan(db, int(site.id), target_week_iso, target_scope, payload)
        _store_site_auto_planning_status(site, summary)
        success_count += 1

    for site in sites:
        site_id_int = int(site.id)
        if site_id_int in processed_site_ids:
            continue
        linked_ids = [int(x) for x in (cluster_map.get(site_id_int) or []) if int(x) in sites_by_id]
        # Multi-sites: une seule ריצה solver par groupe lié, puis split des plans par site.
        if len(linked_ids) > 1:
            root_site_id = min(linked_ids)
            try:
                logger.info(
                    "[AUTO-PLANNING] multi-site group start director_id=%s root_site_id=%s group_size=%s target_week=%s source=%s",
                    director_id,
                    root_site_id,
                    len(linked_ids),
                    target_week_iso,
                    source,
                )
                generated = _generate_multi_site_memory_plans(
                    db,
                    director_id,
                    root_site_id,
                    target_week_iso,
                    num_alternatives=20 if auto_pulls_enabled else 1,
                )
                site_plans = generated.get("site_plans") if isinstance(generated, dict) else {}
                if not isinstance(site_plans, dict):
                    site_plans = {}
                if auto_pulls_enabled:
                    site_plans = _apply_auto_pulls_to_site_plans(
                        db,
                        {sid: s for sid, s in sites_by_id.items() if sid in linked_ids},
                        site_plans,
                        pulls_limit=pulls_limit,
                        pulls_limits_by_site=pulls_limits_by_site,
                    )
                for linked_sid in linked_ids:
                    linked_site = sites_by_id.get(linked_sid)
                    if not linked_site:
                        continue
                    site_payload = site_plans.get(str(linked_sid)) or site_plans.get(linked_sid)
                    if not isinstance(site_payload, dict):
                        raise RuntimeError(f"missing generated plan for linked site {linked_sid}")
                    _persist_generated_payload(linked_site, site_payload)
                    processed_site_ids.add(linked_sid)
                db.commit()
                logger.info(
                    "[AUTO-PLANNING] multi-site group success director_id=%s root_site_id=%s group_size=%s target_week=%s source=%s",
                    director_id,
                    root_site_id,
                    len(linked_ids),
                    target_week_iso,
                    source,
                )
            except Exception as exc:
                logger.exception(
                    "[AUTO-PLANNING] multi-site group failed director_id=%s root_site_id=%s",
                    director_id,
                    root_site_id,
                )
                for linked_sid in linked_ids:
                    linked_site = sites_by_id.get(linked_sid)
                    if not linked_site:
                        continue
                    _store_site_auto_planning_status(
                        linked_site,
                        _summarize_auto_planning_result(linked_site, None, target_week_iso, source, str(exc)),
                    )
                    processed_site_ids.add(linked_sid)
                db.commit()
                errors.append(f"multi-site group {root_site_id}: {exc}")
            continue

        try:
            logger.info(
                "[AUTO-PLANNING] site start director_id=%s site_id=%s site_name=%s target_week=%s source=%s",
                director_id,
                site.id,
                site.name,
                target_week_iso,
                source,
            )
            site_pulls_limit = _effective_auto_pulls_limit_for_site(int(site.id), pulls_limit, pulls_limits_by_site)
            payload = _generate_director_week_plan_payload(
                db,
                site,
                target_week_iso,
                auto_pulls_enabled=auto_pulls_enabled,
                pulls_limit=site_pulls_limit,
            )
            _persist_generated_payload(site, payload)
            db.commit()
            logger.info(
                "[AUTO-PLANNING] site success director_id=%s site_id=%s site_name=%s target_week=%s source=%s",
                director_id,
                site.id,
                site.name,
                target_week_iso,
                source,
            )
            processed_site_ids.add(site_id_int)
        except Exception as exc:
            logger.exception("[AUTO-PLANNING] Failed for director=%s site=%s", director_id, site.id)
            _store_site_auto_planning_status(
                site,
                _summarize_auto_planning_result(site, None, target_week_iso, source, str(exc)),
            )
            processed_site_ids.add(site_id_int)
            db.commit()
            errors.append(f"{site.name}: {exc}")
    logger.info(
        "[AUTO-PLANNING] run end director_id=%s source=%s target_week=%s success_sites=%s errors=%s",
        director_id,
        source,
        target_week_iso,
        success_count,
        len(errors),
    )
    return success_count, errors


def process_auto_planning_tick(db: Session) -> None:
    now = datetime.now()
    configs = db.query(DirectorAutoPlanningConfig).filter(DirectorAutoPlanningConfig.enabled == True).all()
    logger.info("[AUTO-PLANNING] tick start now=%s enabled_configs=%s", now.isoformat(), len(configs))
    for config in configs:
        next_run_at = _next_effective_run_time(now, config)
        logger.info(
            "[AUTO-PLANNING] tick inspect director_id=%s enabled=%s scheduled_day=%s scheduled_time=%02d:%02d next_run_at=%s last_run_week=%s last_run_at=%s",
            config.director_id,
            config.enabled,
            config.day_of_week,
            config.hour,
            config.minute,
            next_run_at.isoformat(),
            config.last_run_week_iso,
            config.last_run_at,
        )
        if now < next_run_at:
            logger.info(
                "[AUTO-PLANNING] tick skip director_id=%s reason=before_next_run now=%s next_run_at=%s",
                config.director_id,
                now.isoformat(),
                next_run_at.isoformat(),
            )
            continue
        target_week_iso = _next_week_iso(next_run_at)
        if (config.last_run_week_iso or "").strip() == target_week_iso:
            logger.info(
                "[AUTO-PLANNING] tick skip director_id=%s reason=already_ran target_week=%s",
                config.director_id,
                target_week_iso,
            )
            continue

        logger.info(
            "[AUTO-PLANNING] tick trigger director_id=%s target_week=%s now=%s next_run_at=%s",
            config.director_id,
            target_week_iso,
            now.isoformat(),
            next_run_at.isoformat(),
        )
        gpl, by_site = _pull_limits_from_config_row(config)
        _, errors = _run_auto_planning_for_director(
            db,
            config.director_id,
            target_week_iso,
            "scheduled",
            auto_pulls_enabled=bool(getattr(config, "auto_pulls_enabled", False)),
            auto_save_mode=str(getattr(config, "auto_save_mode", "manual") or "manual"),
            pulls_limit=gpl,
            pulls_limits_by_site=by_site,
        )
        config.last_run_week_iso = target_week_iso
        config.last_run_at = _now_ms()
        config.last_error = "\n".join(errors)[:1000] if errors else None
        db.commit()
        logger.info(
            "[AUTO-PLANNING] tick commit director_id=%s target_week=%s last_error=%s",
            config.director_id,
            target_week_iso,
            config.last_error,
        )
    logger.info("[AUTO-PLANNING] tick end now=%s", now.isoformat())


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


@router.get("/settings/auto-planning", response_model=AutoPlanningConfigOut)
def get_auto_planning_config(
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    row = (
        db.query(DirectorAutoPlanningConfig)
        .filter(DirectorAutoPlanningConfig.director_id == user.id)
        .first()
    )
    return _serialize_auto_planning_config(row)


@router.put("/settings/auto-planning", response_model=AutoPlanningConfigOut)
def put_auto_planning_config(
    payload: AutoPlanningConfigPayload,
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    previous_enabled: bool | None = None
    row = (
        db.query(DirectorAutoPlanningConfig)
        .filter(DirectorAutoPlanningConfig.director_id == user.id)
        .first()
    )
    now = _now_ms()
    if not row:
        row = DirectorAutoPlanningConfig(
            director_id=user.id,
            enabled=payload.enabled,
            day_of_week=payload.day_of_week,
            hour=payload.hour,
            minute=payload.minute,
            auto_pulls_enabled=payload.auto_pulls_enabled,
            auto_save_mode=payload.auto_save_mode,
            pulls_limit=payload.pulls_limit,
            pulls_limits_by_site=_coerce_pulls_limits_for_storage(payload.pulls_limits_by_site),
            updated_at=now,
        )
        db.add(row)
    else:
        previous_enabled = bool(getattr(row, "enabled", False))
        row.enabled = payload.enabled
        row.day_of_week = payload.day_of_week
        row.hour = payload.hour
        row.minute = payload.minute
        row.auto_pulls_enabled = payload.auto_pulls_enabled
        row.auto_save_mode = payload.auto_save_mode
        row.pulls_limit = payload.pulls_limit
        row.pulls_limits_by_site = _coerce_pulls_limits_for_storage(payload.pulls_limits_by_site)
        row.updated_at = now
    # Toute modification de créneau redéfinit le prochain déclenchement planifié.
    row.last_run_week_iso = None
    row.last_run_at = None
    if (previous_enabled is True) and (payload.enabled is False):
        target_week_iso = _next_week_iso(datetime.now())
        _clear_auto_planning_cache_for_director(db, int(user.id), target_week_iso)
    db.commit()
    db.refresh(row)
    return _serialize_auto_planning_config(row)


@router.post("/settings/auto-planning/test-now")
def test_auto_planning_now(
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    row = (
        db.query(DirectorAutoPlanningConfig)
        .filter(DirectorAutoPlanningConfig.director_id == user.id)
        .first()
    )
    target_week_iso = _next_week_iso(datetime.now())
    logger.info(
        "[AUTO-PLANNING] manual test trigger director_id=%s target_week=%s",
        user.id,
        target_week_iso,
    )
    if not row:
        row = DirectorAutoPlanningConfig(
            director_id=user.id,
            enabled=False,
            day_of_week=0,
            hour=9,
            minute=0,
            auto_pulls_enabled=False,
            auto_save_mode="manual",
            updated_at=_now_ms(),
        )
        db.add(row)
    gpl, by_site = _pull_limits_from_config_row(row)
    success_count, errors = _run_auto_planning_for_director(
        db,
        user.id,
        target_week_iso,
        "manual-test",
        auto_pulls_enabled=bool(getattr(row, "auto_pulls_enabled", False)),
        auto_save_mode=str(getattr(row, "auto_save_mode", "manual") or "manual"),
        pulls_limit=gpl,
        pulls_limits_by_site=by_site,
    )
    # Un test manuel ne doit jamais bloquer l'exécution planifiée du créneau hebdo.
    row.last_run_week_iso = None
    row.last_run_at = None
    row.last_error = "\n".join(errors)[:1000] if errors else None
    db.commit()
    db.refresh(row)
    return {
        "ok": len(errors) == 0,
        "target_week_iso": target_week_iso,
        "generated_sites": success_count,
        "errors": errors,
        "config": _serialize_auto_planning_config(row).model_dump(),
    }


@router.get("/{site_id}/weekly-availability", response_model=dict[str, dict[str, list[str]]])
def get_weekly_availability(
    site_id: int,
    week: str = Query(..., description="YYYY-MM-DD (week start)"),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    """
    Persistance DB (Neon) des overrides hebdo de disponibilité utilisés par le directeur.
    Remplace le localStorage comme source de vérité entre appareils.
    """
    _director_site_ownership_or_404(db, site_id, user.id)
    wk = _validate_week_iso(week)
    row = (
        db.query(SiteWeeklyAvailability)
        .filter(SiteWeeklyAvailability.site_id == site_id)
        .filter(SiteWeeklyAvailability.week_iso == wk)
        .first()
    )
    return (row.availability or {}) if row else {}


@router.put("/{site_id}/weekly-availability", response_model=dict[str, dict[str, list[str]]])
def put_weekly_availability(
    site_id: int,
    payload: WeeklyAvailabilityPayload,
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_or_404(db, site_id, user.id)
    wk = _validate_week_iso(payload.week_iso)
    now = _now_ms()
    row = (
        db.query(SiteWeeklyAvailability)
        .filter(SiteWeeklyAvailability.site_id == site_id)
        .filter(SiteWeeklyAvailability.week_iso == wk)
        .first()
    )
    data = payload.availability or {}
    if row:
        row.availability = data
        row.updated_at = now
    else:
        row = SiteWeeklyAvailability(site_id=site_id, week_iso=wk, availability=data, updated_at=now)
        db.add(row)
    db.commit()
    db.refresh(row)
    return row.availability or {}


@router.get("/{site_id}/week-plan", response_model=dict | None)
def get_week_plan(
    site_id: int,
    week: str = Query(..., description="YYYY-MM-DD (week start)"),
    scope: str = Query("director", description="director|shared"),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_ownership_or_404(db, site_id, user.id)
    wk = _validate_week_iso(week)
    sc = (scope or "director").strip()
    if sc not in ("auto", "director", "shared"):
        raise HTTPException(status_code=400, detail="scope invalide (auto|director|shared)")
    row = (
        db.query(SiteWeekPlan)
        .filter(SiteWeekPlan.site_id == site_id)
        .filter(SiteWeekPlan.week_iso == wk)
        .filter(SiteWeekPlan.scope == sc)
        .first()
    )
    return row.data if row else None


@router.put("/{site_id}/week-plan", response_model=dict | None)
def put_week_plan(
    site_id: int,
    payload: WeekPlanPayload,
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_or_404(db, site_id, user.id)
    wk = _validate_week_iso(payload.week_iso)
    sc = (payload.scope or "director").strip()
    if sc not in ("auto", "director", "shared"):
        raise HTTPException(status_code=400, detail="scope invalide (auto|director|shared)")
    now = _now_ms()
    row = (
        db.query(SiteWeekPlan)
        .filter(SiteWeekPlan.site_id == site_id)
        .filter(SiteWeekPlan.week_iso == wk)
        .filter(SiteWeekPlan.scope == sc)
        .first()
    )
    data = payload.data or None
    if row:
        row.data = data or {}
        row.updated_at = now
        flag_modified(row, "data")
    else:
        row = SiteWeekPlan(site_id=site_id, week_iso=wk, scope=sc, data=data or {}, updated_at=now)
        db.add(row)
    if sc in ("director", "shared"):
        auto_row = (
            db.query(SiteWeekPlan)
            .filter(SiteWeekPlan.site_id == site_id)
            .filter(SiteWeekPlan.week_iso == wk)
            .filter(SiteWeekPlan.scope == "auto")
            .first()
        )
        if auto_row:
            db.delete(auto_row)
    db.commit()
    return row.data or None


@router.post("/{site_id}/week-plan/promote-auto", response_model=dict | None)
def promote_auto_week_plan(
    site_id: int,
    week: str = Query(..., description="YYYY-MM-DD (week start)"),
    publish: bool = Query(False, description="true => shared, false => director"),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_or_404(db, site_id, user.id)
    wk = _validate_week_iso(week)
    auto_row = (
        db.query(SiteWeekPlan)
        .filter(SiteWeekPlan.site_id == site_id)
        .filter(SiteWeekPlan.week_iso == wk)
        .filter(SiteWeekPlan.scope == "auto")
        .first()
    )
    if not auto_row:
        raise HTTPException(status_code=404, detail="טיוטת תכנון אוטומטית לא נמצאה")
    target_scope = "shared" if publish else "director"
    _save_site_week_plan(
        db,
        site_id,
        wk,
        target_scope,
        auto_row.data if isinstance(auto_row.data, dict) else {},
    )
    db.delete(auto_row)
    db.commit()
    promoted_row = (
        db.query(SiteWeekPlan)
        .filter(SiteWeekPlan.site_id == site_id)
        .filter(SiteWeekPlan.week_iso == wk)
        .filter(SiteWeekPlan.scope == target_scope)
        .first()
    )
    return promoted_row.data if promoted_row else None


@router.delete("/{site_id}/week-plan", status_code=204)
def delete_week_plan(
    site_id: int,
    week: str = Query(..., description="YYYY-MM-DD (week start)"),
    scope: str = Query("director", description="auto|director|shared"),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    site = _director_site_or_404(db, site_id, user.id)
    wk = _validate_week_iso(week)
    sc = (scope or "director").strip()
    if sc not in ("auto", "director", "shared"):
        raise HTTPException(status_code=400, detail="scope invalide (auto|director|shared)")
    row = (
        db.query(SiteWeekPlan)
        .filter(SiteWeekPlan.site_id == site_id)
        .filter(SiteWeekPlan.week_iso == wk)
        .filter(SiteWeekPlan.scope == sc)
        .first()
    )
    if sc == "auto":
        cfg = dict(site.config or {})
        last_run = cfg.get("autoPlanningLastRun")
        if isinstance(last_run, dict) and str(last_run.get("week_iso") or "").strip() == wk:
            cfg.pop("autoPlanningLastRun", None)
            site.config = cfg
            flag_modified(site, "config")
    if row:
        db.delete(row)
        db.commit()
    return Response(status_code=204)


@router.get("/{site_id}/messages", response_model=list[SiteMessageOut])
def list_site_messages(
    site_id: int,
    week: str = Query(..., description="YYYY-MM-DD (week start)"),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_ownership_or_404(db, site_id, user.id)
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

def normalize_site_config(config: dict) -> dict:
    """
    Normalise la config pour éviter les incohérences:
    - si somme des rôles > workers, augmenter workers pour matcher la somme des rôles
    """
    cfg = config or {}
    stations = (cfg.get("stations", []) or [])
    for st in stations:
        if not isinstance(st, dict):
            continue
        uniform_roles = bool(st.get("uniformRoles"))

        def _sum_roles(role_list: list) -> int:
            total = 0
            for r in (role_list or []):
                try:
                    if r and r.get("enabled"):
                        total += int(r.get("count") or 0)
                except Exception:
                    pass
            return total

        if uniform_roles:
            station_workers = int(st.get("workers") or 0)
            total_roles = _sum_roles(st.get("roles") or [])
            if total_roles > station_workers:
                st["workers"] = total_roles

        if not uniform_roles:
            for sh in (st.get("shifts") or []):
                if not sh or not isinstance(sh, dict) or not sh.get("enabled"):
                    continue
                sh_workers = int(sh.get("workers") or 0)
                total_roles = _sum_roles(sh.get("roles") or [])
                if total_roles > sh_workers:
                    sh["workers"] = total_roles

        if st.get("perDayCustom") and not uniform_roles:
            day_overrides = st.get("dayOverrides") or {}
            for _day_key, ov in (day_overrides or {}).items():
                if not ov or not isinstance(ov, dict) or not ov.get("active"):
                    continue
                for sh in (ov.get("shifts") or []):
                    if not sh or not isinstance(sh, dict) or not sh.get("enabled"):
                        continue
                    sh_workers = int(sh.get("workers") or 0)
                    total_roles = _sum_roles(sh.get("roles") or [])
                    if total_roles > sh_workers:
                        sh["workers"] = total_roles

    return cfg

@router.get("/", response_model=list[SiteOut])
def list_sites(user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    # En Postgres, le type JSON n'a pas d'opérateur d'égalité → impossible de GROUP BY sur sites.config.
    # On fait donc 2 requêtes simples et on assemble côté Python.
    sites = db.query(Site).filter(Site.director_id == user.id, Site.deleted_at.is_(None)).all()
    counts_rows = (
        db.query(SiteWorker.site_id, func.count(SiteWorker.id).label("workers_count"))
        .join(Site, Site.id == SiteWorker.site_id)
        .filter(Site.director_id == user.id)
        .group_by(SiteWorker.site_id)
        .all()
    )
    counts = {r.site_id: int(r.workers_count or 0) for r in counts_rows}
    pending_counts_rows = (
        db.query(SiteWorker.site_id, func.count(SiteWorker.id).label("pending_workers_count"))
        .join(Site, Site.id == SiteWorker.site_id)
        .filter(Site.director_id == user.id)
        .filter(SiteWorker.pending_approval == True)
        .group_by(SiteWorker.site_id)
        .all()
    )
    pending_counts = {r.site_id: int(r.pending_workers_count or 0) for r in pending_counts_rows}
    next_week_iso = _next_week_iso(datetime.now())
    plan_rows = (
        db.query(SiteWeekPlan)
        .filter(SiteWeekPlan.week_iso == next_week_iso)
        .filter(SiteWeekPlan.scope.in_(["auto", "director", "shared"]))
        .all()
    )
    preferred_plan_by_site: dict[int, SiteWeekPlan] = {}
    for row in plan_rows:
        existing = preferred_plan_by_site.get(row.site_id)
        if existing is None or _week_plan_rank(row) > _week_plan_rank(existing):
            preferred_plan_by_site[row.site_id] = row
    linked_by_site = _linked_site_cluster_map_for_director(db, user.id, next_week_iso)
    return [
        SiteOut(
            id=s.id,
            name=s.name,
            workers_count=counts.get(s.id, 0),
            pending_workers_count=pending_counts.get(s.id, 0),
            config=s.config,
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
        config=site.config,
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


@router.get("/all-workers", response_model=list[WorkerOut])
def list_all_workers(user: User = Depends(require_role("director")), db: Session = Depends(get_db)):
    """Retourne tous les travailleurs de tous les sites du directeur (sites actifs ou archivés)."""
    # Sites du directeur y compris soft-deleted (pour afficher encore le nom du site dans la liste travailleurs)
    all_dir_sites = db.query(Site).filter(Site.director_id == user.id).all()
    site_by_id = {int(s.id): s for s in all_dir_sites}
    site_ids = list(site_by_id.keys())
    logger.info(f"[all-workers] Director {user.id} has {len(site_ids)} sites: {site_ids}")
    if not site_ids:
        return []
    # Récupérer tous les travailleurs de ces sites, y compris retirés du planning (historique multi-sites).
    rows = [r for r in db.query(SiteWorker).filter(SiteWorker.site_id.in_(site_ids)).all()]
    current_week_iso = _week_start_date(datetime.now()).date().isoformat()
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
        sn = site_by_id.get(int(r.site_id))
        removed_from_week_iso = str(getattr(r, "removed_from_week_iso", "") or "").strip() or None
        removed_by_planning = bool(removed_from_week_iso and current_week_iso >= removed_from_week_iso)
        worker_out = WorkerOut(
            id=r.id,
            site_id=r.site_id,
            created_at=getattr(r, "created_at", None),
            name=r.name,
            max_shifts=r.max_shifts,
            roles=r.roles or [],
            availability=r.availability or {},
            answers=r.answers or {},
            phone=phone,
            site_name=(sn.name if sn else None),
            site_deleted=bool(getattr(sn, "deleted_at", None)) if sn else False,
            removed_from_week_iso=removed_from_week_iso,
            removed_by_planning=removed_by_planning,
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
    pending_workers_count = db.query(SiteWorker).filter(SiteWorker.site_id == site.id, SiteWorker.pending_approval == True).count()
    linked_by_site = _linked_site_cluster_map_for_director(db, user.id)
    return SiteOut(
        id=site.id,
        name=site.name,
        workers_count=workers_count,
        pending_workers_count=pending_workers_count,
        config=site.config,
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
    db.commit()
    db.refresh(user)
    token = create_worker_invite_token(site_id=int(site.id), director_id=int(user.id))
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
    workers_count = db.query(SiteWorker).filter(SiteWorker.site_id == site.id).count()
    pending_workers_count = db.query(SiteWorker).filter(SiteWorker.site_id == site.id, SiteWorker.pending_approval == True).count()
    linked_by_site = _linked_site_cluster_map_for_director(db, user.id)
    return SiteOut(
        id=site.id,
        name=site.name,
        workers_count=workers_count,
        pending_workers_count=pending_workers_count,
        config=site.config,
        linked_site_ids=linked_by_site.get(int(site.id), []),
        deleted_at=None,
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
        for worker_user in db.query(User).filter(User.role == UserRole.worker).all():
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
                existing.phone = payload.phone
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
            phone=payload.phone,
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
            db.flush()

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


@router.get("/{site_id}/linked-sites")
def get_linked_sites(
    site_id: int,
    week: str | None = Query(None),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    week_iso = _validate_week_iso(week) if week else None
    linked_site_ids = _connected_site_ids_for_root(db, user.id, site_id, week_iso)
    sites = db.query(Site).filter(Site.id.in_(linked_site_ids)).all() if linked_site_ids else []
    by_id = {int(s.id): s for s in sites}
    plan_rows_by_site: dict[int, list[SiteWeekPlan]] = {}
    if week_iso and linked_site_ids:
        rows = (
            db.query(SiteWeekPlan)
            .filter(SiteWeekPlan.site_id.in_(linked_site_ids))
            .filter(SiteWeekPlan.week_iso == week_iso)
            .filter(SiteWeekPlan.scope.in_(["auto", "director", "shared"]))
            .all()
        )
        for row in rows:
            plan_rows_by_site.setdefault(int(row.site_id), []).append(row)

    def _preferred_week_plan(site_rows: list[SiteWeekPlan]) -> SiteWeekPlan | None:
        best_row: SiteWeekPlan | None = None
        best_rank = -1
        for row in site_rows:
            rank = _week_plan_rank(row)
            if rank > best_rank:
                best_rank = rank
                best_row = row
        return best_row

    response: list[dict] = []
    for linked_site_id in linked_site_ids:
        linked_site_int = int(linked_site_id)
        linked_site = by_id.get(linked_site_int)
        if not linked_site:
            continue
        entry = {
            "id": linked_site_int,
            "name": linked_site.name,
            "site_deleted": bool(getattr(linked_site, "deleted_at", None)),
            "has_saved_plan": False,
        }
        if week_iso:
            site_rows = plan_rows_by_site.get(linked_site_int, [])
            preferred_row = _preferred_week_plan(site_rows)
            entry["has_saved_plan"] = any(
                str(getattr(r, "scope", "") or "").lower() in {"director", "shared"} for r in site_rows
            )
            data = preferred_row.data if preferred_row and isinstance(preferred_row.data, dict) else {}
            summary = _summarize_auto_planning_result(
                linked_site,
                data.get("assignments"),
                week_iso,
                "linked-sites",
                pulls=data.get("pulls") if isinstance(data.get("pulls"), dict) else None,
            )
            entry["assigned_count"] = int(summary.get("assigned_count") or 0)
            entry["required_count"] = int(summary.get("required_count") or 0)
        response.append(entry)
    # Actifs d’abord, puis sites archivés (soft-delete) ; à l’intérieur de chaque groupe par nom.
    response.sort(
        key=lambda e: (
            1 if e.get("site_deleted") else 0,
            str(e.get("name") or ""),
        )
    )
    return response


@router.post("/{site_id}/ai-generate-linked")
def ai_generate_linked_planning(
    site_id: int,
    payload: AIPlanningRequest = Body(default=AIPlanningRequest()),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")
    week_iso = _validate_week_iso(payload.week_iso) if payload and payload.week_iso else _next_week_iso(datetime.now())
    result = _generate_multi_site_memory_plans(
        db,
        user.id,
        site_id,
        week_iso,
        weekly_availability=(payload.weekly_availability or {}) if payload else None,
        exclude_days=payload.exclude_days if payload else None,
        fixed_assignments=payload.fixed_assignments if payload else None,
        num_alternatives=payload.num_alternatives if payload else 20,
    )
    pulls_limits_by_site = _normalize_pulls_limits_by_site(payload.pulls_limits_by_site if payload else None)
    if payload and payload.auto_pulls_enabled:
        context = _build_multi_site_generation_context(
            db,
            user.id,
            site_id,
            week_iso,
            weekly_availability=(payload.weekly_availability or {}) if payload else None,
            exclude_days=payload.exclude_days if payload else None,
            fixed_assignments=payload.fixed_assignments if payload else None,
        )
        result["site_plans"] = _apply_auto_pulls_to_site_plans(
            db,
            context["sites_by_id"],
            result.get("site_plans") or {},
            pulls_limit=payload.pulls_limit if payload else None,
            pulls_limits_by_site=pulls_limits_by_site or None,
        )
        pulls_limit = int(payload.pulls_limit) if payload and payload.pulls_limit is not None else None
        if pulls_limit is not None or pulls_limits_by_site:
            site_plans = result.get("site_plans") or {}
            candidate_count = 1 + max((len(site_plan.get("alternatives") or []) for site_plan in site_plans.values()), default=0)
            accepted_indices: list[int] = []
            for candidate_idx in range(candidate_count):
                matches_all_sites = True
                for site_key, site_plan in site_plans.items():
                    current_site_id = int(site_key)
                    if candidate_idx == 0:
                        candidate_pulls = site_plan.get("pulls") if isinstance(site_plan.get("pulls"), dict) else {}
                    else:
                        alt_pulls_list = site_plan.get("alternative_pulls") or []
                        candidate_pulls = (alt_pulls_list[candidate_idx - 1] or {}) if candidate_idx - 1 < len(alt_pulls_list) else None
                    if not _site_pulls_limit_matches(
                        current_site_id,
                        candidate_pulls if isinstance(candidate_pulls, dict) else {},
                        default_pulls_limit=pulls_limit,
                        pulls_limits_by_site=pulls_limits_by_site or None,
                    ):
                        matches_all_sites = False
                        break
                if matches_all_sites:
                    accepted_indices.append(candidate_idx)
            if not accepted_indices:
                raise HTTPException(
                    status_code=422,
                    detail=_planning_limit_error_detail_for_request(
                        pulls_limit=pulls_limit,
                        pulls_limits_by_site=pulls_limits_by_site or None,
                    ),
                )
            filtered_site_plans: dict[str, dict] = {}
            for site_key, site_plan in site_plans.items():
                next_site_plan = dict(site_plan)
                first_idx = accepted_indices[0]
                if first_idx == 0:
                    next_site_plan["assignments"] = site_plan.get("assignments") or {}
                    next_site_plan["pulls"] = site_plan.get("pulls") if isinstance(site_plan.get("pulls"), dict) else {}
                else:
                    alternatives = site_plan.get("alternatives") or []
                    alternative_pulls = site_plan.get("alternative_pulls") or []
                    next_site_plan["assignments"] = (alternatives[first_idx - 1] or {}) if first_idx - 1 < len(alternatives) else {}
                    next_site_plan["pulls"] = (alternative_pulls[first_idx - 1] or {}) if first_idx - 1 < len(alternative_pulls) else {}
                next_site_plan["alternatives"] = []
                next_site_plan["alternative_pulls"] = []
                for candidate_idx in accepted_indices[1:]:
                    if candidate_idx == 0:
                        next_site_plan["alternatives"].append(site_plan.get("assignments") or {})
                        next_site_plan["alternative_pulls"].append(site_plan.get("pulls") if isinstance(site_plan.get("pulls"), dict) else {})
                    else:
                        alternatives = site_plan.get("alternatives") or []
                        alternative_pulls = site_plan.get("alternative_pulls") or []
                        if candidate_idx - 1 < len(alternatives):
                            next_site_plan["alternatives"].append(alternatives[candidate_idx - 1] or {})
                            next_site_plan["alternative_pulls"].append((alternative_pulls[candidate_idx - 1] or {}) if candidate_idx - 1 < len(alternative_pulls) else {})
                filtered_site_plans[site_key] = next_site_plan
            result["site_plans"] = filtered_site_plans
    return result


@router.api_route("/{site_id}/ai-generate-linked/stream", methods=["GET", "POST"])
async def ai_generate_linked_planning_stream(
    site_id: int,
    request: Request,
    payload: AIPlanningRequest = Body(default=AIPlanningRequest()),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    if request.method == "GET":
        q_num_alternatives = request.query_params.get("num_alternatives")
        q_time_limit_seconds = request.query_params.get("time_limit_seconds")
        q_max_nights_per_worker = request.query_params.get("max_nights_per_worker")
    else:
        q_num_alternatives = None
        q_time_limit_seconds = None
        q_max_nights_per_worker = None
        try:
            body = await request.json()
            if isinstance(body, dict):
                q_num_alternatives = body.get("num_alternatives")
                q_time_limit_seconds = body.get("time_limit_seconds")
                q_max_nights_per_worker = body.get("max_nights_per_worker")
                payload.pulls_limits_by_site = body.get("pulls_limits_by_site") if isinstance(body.get("pulls_limits_by_site"), dict) else None
                if body and "weekly_availability" in body:
                    cleaned_wa = {}
                    for worker_name, worker_avail in (body.get("weekly_availability") or {}).items():
                        if isinstance(worker_avail, dict):
                            if "availability" in worker_avail and not any(k in worker_avail for k in ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]):
                                cleaned_wa[worker_name] = worker_avail["availability"]
                            else:
                                cleaned_wa[worker_name] = worker_avail
                    payload.weekly_availability = cleaned_wa if cleaned_wa else None
        except Exception:
            pass

    site = db.get(Site, site_id)
    if not site or site.director_id != user.id:
        raise HTTPException(status_code=404, detail="Site introuvable")

    eff_time = int(q_time_limit_seconds if q_time_limit_seconds is not None else (payload.time_limit_seconds or 45))
    eff_max_nights = int(q_max_nights_per_worker if q_max_nights_per_worker is not None else (payload.max_nights_per_worker or 3))
    eff_num_alts = int(q_num_alternatives if q_num_alternatives is not None else (payload.num_alternatives or 1200))
    if payload and payload.auto_pulls_enabled:
        eff_time, eff_num_alts = _boost_generation_budget_for_pulls(eff_time, eff_num_alts)
    eff_pulls_limit = int(payload.pulls_limit) if payload and payload.pulls_limit is not None else None
    eff_pulls_limits_by_site = _normalize_pulls_limits_by_site(payload.pulls_limits_by_site if payload else None)

    context = _build_multi_site_generation_context(
        db,
        user.id,
        site_id,
        _validate_week_iso(payload.week_iso) if payload and payload.week_iso else _next_week_iso(datetime.now()),
        weekly_availability=(payload.weekly_availability or {}) if payload else None,
        exclude_days=payload.exclude_days if payload else None,
        fixed_assignments=payload.fixed_assignments if payload else None,
    )

    linked_sites = [
        {"id": linked_site_id, "name": context["sites_by_id"][linked_site_id].name}
        for linked_site_id in context["connected_site_ids"]
        if linked_site_id in context["sites_by_id"]
    ]

    async def event_stream():
        import threading, queue, json, asyncio as _asyncio
        q: "queue.Queue[dict | None]" = queue.Queue(maxsize=256)

        def _producer():
            matched_candidates = 0
            try:
                gen = solve_schedule_stream(
                    context["combined_config"],
                    context["combined_workers"],
                    time_limit_seconds=eff_time,
                    max_nights_per_worker=eff_max_nights,
                    num_alternatives=eff_num_alts,
                    fixed_assignments=context["combined_fixed"],
                    exclude_days=(payload.exclude_days or None),
                )
                for item in gen:
                    if item.get("type") in {"base", "alternative"}:
                        split_site_plans = _split_multi_site_assignments(
                            context,
                            item.get("assignments") if isinstance(item.get("assignments"), dict) else {},
                            status="STREAMING" if item.get("type") == "base" else None,
                            objective=0,
                        )
                        split_site_plans = _enforce_role_requirements_on_site_plans(
                            db,
                            context["sites_by_id"],
                            split_site_plans,
                        )
                        if payload and payload.auto_pulls_enabled:
                            split_site_plans = _apply_auto_pulls_to_site_plans(
                                db,
                                context["sites_by_id"],
                                split_site_plans,
                                pulls_limit=eff_pulls_limit,
                                pulls_limits_by_site=eff_pulls_limits_by_site or None,
                            )
                        if eff_pulls_limit is not None or eff_pulls_limits_by_site:
                            if not split_site_plans:
                                continue
                            plans = list(split_site_plans.items())
                            if not plans or not all(
                                _site_pulls_limit_matches(
                                    int(site_key),
                                    site_plan.get("pulls") if isinstance(site_plan.get("pulls"), dict) else {},
                                    default_pulls_limit=eff_pulls_limit,
                                    pulls_limits_by_site=eff_pulls_limits_by_site or None,
                                )
                                for site_key, site_plan in plans
                            ):
                                continue
                            matched_candidates += 1
                        q.put({
                            "type": item.get("type"),
                            "index": item.get("index"),
                            "source": item.get("source"),
                            "linked_sites": linked_sites,
                            "site_plans": split_site_plans,
                        })
                    else:
                        if item.get("type") == "done" and (eff_pulls_limit is not None or eff_pulls_limits_by_site) and matched_candidates == 0:
                            q.put({
                                "type": "status",
                                "status": "ERROR",
                                "detail": _planning_limit_error_detail_for_request(
                                    pulls_limit=eff_pulls_limit,
                                    pulls_limits_by_site=eff_pulls_limits_by_site or None,
                                ),
                                "linked_sites": linked_sites,
                            })
                            continue
                        enriched = dict(item)
                        enriched["linked_sites"] = linked_sites
                        q.put(enriched)
            except Exception as e:
                q.put({"type": "status", "status": "ERROR", "detail": str(e), "linked_sites": linked_sites})
            finally:
                q.put(None)

        threading.Thread(target=_producer, daemon=True).start()

        while True:
            item = await _asyncio.to_thread(q.get)
            if item is None:
                break
            try:
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
    week_for_rows = _week_start_date(datetime.now()).date().isoformat()
    if payload and getattr(payload, "week_iso", None):
        try:
            week_for_rows = _validate_week_iso(payload.week_iso)
        except HTTPException:
            pass
    rows = [
        row
        for row in db.query(SiteWorker).filter(SiteWorker.site_id == site_id).all()
        if not bool(getattr(row, "pending_approval", False)) and _site_worker_visible_for_week(row, week_for_rows)
    ]
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
    base_pulls: dict = {}
    alt_pulls: list[dict] = []
    assignments_out = _enforce_role_requirements_on_assignments(
        site.config or {},
        result.get("assignments") if isinstance(result.get("assignments"), dict) else {},
        rows,
    )
    alternatives_out = [
        _enforce_role_requirements_on_assignments(site.config or {}, alt, rows)
        for alt in (result.get("alternatives") or [])
        if isinstance(alt, dict)
    ]
    if payload.auto_pulls_enabled:
        base_candidate_assignments = _enforce_role_requirements_on_assignments(
            site.config or {},
            result.get("assignments") if isinstance(result.get("assignments"), dict) else {},
            rows,
        )
        base_payload = _apply_auto_pulls_to_payload(
            site,
            rows,
            {"assignments": deepcopy(base_candidate_assignments), "pulls": {}},
            pulls_limit=payload.pulls_limit,
        )
        candidate_pairs: list[tuple[dict, dict]] = []
        base_assignments = base_payload.get("assignments") or {}
        base_pulls = base_payload.get("pulls") or {}
        if _matches_pulls_limit(base_pulls, payload.pulls_limit):
            candidate_pairs.append((base_assignments, base_pulls))
        for alt in (result.get("alternatives") or []):
            if not isinstance(alt, dict):
                continue
            alt_cleaned = _enforce_role_requirements_on_assignments(site.config or {}, alt, rows)
            alt_payload = _apply_auto_pulls_to_payload(
                site,
                rows,
                {"assignments": deepcopy(alt_cleaned), "pulls": {}},
                pulls_limit=payload.pulls_limit,
            )
            current_alt_assignments = alt_payload.get("assignments") or {}
            current_alt_pulls = alt_payload.get("pulls") or {}
            if _matches_pulls_limit(current_alt_pulls, payload.pulls_limit):
                candidate_pairs.append((current_alt_assignments, current_alt_pulls))
        if payload.pulls_limit is not None and not candidate_pairs:
            raise HTTPException(status_code=422, detail=_planning_limit_error_detail(payload.pulls_limit))
        if candidate_pairs:
            assignments_out = candidate_pairs[0][0]
            base_pulls = candidate_pairs[0][1]
            alternatives_out = [assignments for assignments, _ in candidate_pairs[1:]]
            alt_pulls = [pulls for _, pulls in candidate_pairs[1:]]
    return AIPlanningResponse(
        days=result["days"],
        shifts=result["shifts"],
        stations=result["stations"],
        assignments=assignments_out,
        alternatives=alternatives_out,
        pulls=base_pulls,
        alternative_pulls=alt_pulls,
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
    week_for_rows = _week_start_date(datetime.now()).date().isoformat()
    if payload and getattr(payload, "week_iso", None):
        try:
            week_for_rows = _validate_week_iso(payload.week_iso)
        except HTTPException:
            pass
    rows = [
        row
        for row in db.query(SiteWorker).filter(SiteWorker.site_id == site_id).all()
        if not bool(getattr(row, "pending_approval", False)) and _site_worker_visible_for_week(row, week_for_rows)
    ]
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
    if payload.auto_pulls_enabled:
        eff_time, eff_num_alts = _boost_generation_budget_for_pulls(eff_time, eff_num_alts)
    eff_pulls_limit = int(payload.pulls_limit) if payload.pulls_limit is not None else None
    logger.info("[SSE] start site=%s time_limit=%s max_nights=%s num_alternatives=%s workers=%s", site_id, eff_time, eff_max_nights, eff_num_alts, [w["name"] for w in workers])

    async def event_stream():
        """Non-bloquant: exécute le solveur dans un thread et stream via une queue."""
        import threading, queue, json, asyncio as _asyncio
        q: "queue.Queue[dict | None]" = queue.Queue(maxsize=256)

        def _producer():
            matched_candidates = 0
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
                    if item.get("type") in {"base", "alternative"} and payload.auto_pulls_enabled:
                        cleaned_assignments = _enforce_role_requirements_on_assignments(
                            site.config or {},
                            item.get("assignments") if isinstance(item.get("assignments"), dict) else {},
                            rows,
                        )
                        transformed = _apply_auto_pulls_to_payload(
                            site,
                            rows,
                            {"assignments": deepcopy(cleaned_assignments), "pulls": {}},
                            pulls_limit=eff_pulls_limit,
                        )
                        if eff_pulls_limit is not None and not _matches_pulls_limit(transformed.get("pulls"), eff_pulls_limit):
                            continue
                        enriched = dict(item)
                        enriched["assignments"] = transformed.get("assignments") or {}
                        enriched["pulls"] = transformed.get("pulls") or {}
                        matched_candidates += 1
                        q.put(enriched)
                        continue
                    if item.get("type") in {"base", "alternative"}:
                        enriched = dict(item)
                        enriched["assignments"] = _enforce_role_requirements_on_assignments(
                            site.config or {},
                            item.get("assignments") if isinstance(item.get("assignments"), dict) else {},
                            rows,
                        )
                        q.put(enriched)
                        continue
                    if item.get("type") == "done" and payload.auto_pulls_enabled and eff_pulls_limit is not None and matched_candidates == 0:
                        q.put({"type": "status", "status": "ERROR", "detail": _planning_limit_error_detail(eff_pulls_limit)})
                        continue
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



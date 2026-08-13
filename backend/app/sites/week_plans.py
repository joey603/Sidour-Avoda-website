from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Body, Response
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from datetime import datetime
from copy import deepcopy
import json
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


def _as_json_object(value: object) -> dict | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8", errors="ignore")
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except Exception:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


class _WeekPlanLite:
    """Plan semaine sans blob חלופות — suffisant pour les badges liste אתרים."""

    __slots__ = ("site_id", "week_iso", "scope", "updated_at", "data")

    def __init__(
        self,
        site_id: int,
        week_iso: str,
        scope: str,
        updated_at: int | None,
        assignments: object,
        pulls: object,
    ) -> None:
        self.site_id = int(site_id)
        self.week_iso = str(week_iso or "")
        self.scope = str(scope or "")
        self.updated_at = int(updated_at or 0)
        self.data = {
            "assignments": _as_json_object(assignments),
            "pulls": _as_json_object(pulls) or {},
        }


def _load_week_plan_lites(db: Session, site_ids: list[int], week_iso: str) -> list[_WeekPlanLite]:
    """Charge assignments + pulls seulement (pas alternatives / workers snapshot)."""
    if not site_ids:
        return []
    rows = (
        db.query(
            SiteWeekPlan.site_id,
            SiteWeekPlan.week_iso,
            SiteWeekPlan.scope,
            SiteWeekPlan.updated_at,
            SiteWeekPlan.data["assignments"].label("assignments"),
            SiteWeekPlan.data["pulls"].label("pulls"),
        )
        .filter(SiteWeekPlan.site_id.in_(site_ids))
        .filter(SiteWeekPlan.week_iso == week_iso)
        .filter(SiteWeekPlan.scope.in_(["auto", "director", "shared"]))
        .all()
    )
    return [
        _WeekPlanLite(
            row.site_id,
            row.week_iso,
            row.scope,
            row.updated_at,
            row.assignments,
            row.pulls,
        )
        for row in rows
    ]


def _build_next_week_saved_plan_status(site: Site, row: object | None, week_iso: str) -> NextWeekSavedPlanStatus:
    from .auto_planning import _summarize_auto_planning_result
    site_config = _safe_site_config(getattr(site, "config", None), site_id=getattr(site, "id", None))
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

    site_for_summary = site
    if site_config is not getattr(site, "config", None):
        site_for_summary = deepcopy(site)
        site_for_summary.config = site_config
    summary = _summarize_auto_planning_result(
        site_for_summary,
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


def _is_empty_auto_week_plan(site: Site | None, row: object | None, week_iso: str) -> bool:
    from .auto_planning import _summarize_auto_planning_result
    if site is None or row is None or str(getattr(row, "scope", "") or "") != "auto":
        return False
    data = row.data if isinstance(row.data, dict) else {}
    assignments = data.get("assignments") if isinstance(data, dict) else None
    if not isinstance(assignments, dict):
        return False
    summary = _summarize_auto_planning_result(
        site,
        assignments,
        week_iso,
        "saved-auto-check",
        pulls=data.get("pulls") if isinstance(data.get("pulls"), dict) else None,
    )
    return int(summary.get("required_count") or 0) > 0 and int(summary.get("assigned_count") or 0) <= 0


def _week_plan_rank(row: object) -> int:
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


def _week_plan_resolve_scope_order(prefer: str | None) -> tuple[str, ...]:
    """Ordre d’un GET `scope=resolve` : identique au waterfall front final (après chargement du site)."""
    pref = str(prefer or "").strip()
    if pref in ("director", "shared"):
        other = "shared" if pref == "director" else "director"
        return (pref, other, "auto")
    # Sans préférence : même rang que `_week_plan_rank` (shared > director > auto).
    return ("shared", "director", "auto")


def _pick_week_plan_row_for_resolve(
    rows: list[SiteWeekPlan],
    site: Site | None,
    week_iso: str,
    prefer: str | None = None,
) -> SiteWeekPlan | None:
    by_scope = {str(getattr(row, "scope", "") or ""): row for row in rows}
    for sc in _week_plan_resolve_scope_order(prefer):
        row = by_scope.get(sc)
        if row is None:
            continue
        data = row.data if isinstance(row.data, dict) else None
        if not isinstance(data, dict) or not isinstance(data.get("assignments"), dict):
            continue
        if sc == "auto" and _is_empty_auto_week_plan(site, row, week_iso):
            continue
        return row
    return None


def _preferred_week_plan(site_rows: list[object]) -> object | None:
    best_row: SiteWeekPlan | None = None
    best_key: tuple[int, int] = (-1, -1)
    for row in site_rows:
        key = (_week_plan_rank(row), int(getattr(row, "updated_at", 0) or 0))
        if key > best_key:
            best_key = key
            best_row = row
    return best_row


def _shape_week_plan_get_payload(
    data: dict | None,
    *,
    parts: str = "full",
    include_workers: bool = True,
    source_scope: str | None = None,
) -> dict | None:
    """Réduit le JSON GET week-plan sans changer assignments / pulls / ordre des חלופות."""
    if not isinstance(data, dict):
        return None
    payload = dict(data)
    if source_scope:
        payload["_source_scope"] = source_scope
    if not include_workers:
        payload.pop("workers", None)
    kind = (parts or "full").strip().lower()
    if kind == "base":
        alts = payload.get("alternatives")
        payload["_alts_count"] = len(alts) if isinstance(alts, list) else 0
        payload.pop("alternatives", None)
        payload.pop("alternative_pulls", None)
        payload.pop("alternativePulls", None)
        payload["_alts_omitted"] = True
        return payload
    if kind == "alternatives":
        alts = payload.get("alternatives") if isinstance(payload.get("alternatives"), list) else []
        alt_pulls = payload.get("alternative_pulls")
        if not isinstance(alt_pulls, list):
            alt_pulls = payload.get("alternativePulls") if isinstance(payload.get("alternativePulls"), list) else []
        out: dict = {
            "alternatives": alts,
            "alternative_pulls": alt_pulls,
        }
        if source_scope:
            out["_source_scope"] = source_scope
        elif "_source_scope" in payload:
            out["_source_scope"] = payload.get("_source_scope")
        return out
    return payload


def _week_plan_debug_meta(row: object | None) -> dict | None:
    if row is None:
        return None
    data = row.data if isinstance(row.data, dict) else {}
    assignments = data.get("assignments") if isinstance(data, dict) else None
    pulls = data.get("pulls") if isinstance(data, dict) else None
    return {
        "scope": str(getattr(row, "scope", "") or ""),
        "updated_at": int(getattr(row, "updated_at", 0) or 0),
        "rank": _week_plan_rank(row),
        "has_assignments": isinstance(assignments, dict),
        "alternatives_count": len(data.get("alternatives") or []) if isinstance(data.get("alternatives"), list) else 0,
        "pulls_count": len(pulls) if isinstance(pulls, dict) else 0,
    }


@router.get("/{site_id}/week-plan", response_model=dict | None)
def get_week_plan(
    site_id: int,
    week: str = Query(..., description="YYYY-MM-DD (week start)"),
    scope: str = Query("director", description="auto|director|shared|resolve"),
    prefer: str | None = Query(None, description="director|shared — used with scope=resolve"),
    parts: str = Query("full", description="full|base|alternatives"),
    include_workers: bool = Query(True),
    user: User = Depends(require_role("director")),
    db: Session = Depends(get_db),
):
    _director_site_ownership_or_404(db, site_id, user.id)
    wk = _validate_week_iso(week)
    sc = (scope or "director").strip()
    if sc not in ("auto", "director", "shared", "resolve"):
        raise HTTPException(status_code=400, detail="scope invalide (auto|director|shared|resolve)")
    parts_kind = (parts or "full").strip().lower()
    if parts_kind not in ("full", "base", "alternatives"):
        raise HTTPException(status_code=400, detail="parts invalide (full|base|alternatives)")
    if sc == "resolve":
        site = db.get(Site, site_id)
        rows = (
            db.query(SiteWeekPlan)
            .filter(SiteWeekPlan.site_id == site_id)
            .filter(SiteWeekPlan.week_iso == wk)
            .all()
        )
        row = _pick_week_plan_row_for_resolve(rows, site, wk, prefer)
        if row is None or not isinstance(row.data, dict):
            return None
        return _shape_week_plan_get_payload(
            row.data,
            parts=parts_kind,
            include_workers=include_workers,
            source_scope=str(getattr(row, "scope", "") or ""),
        )
    row = (
        db.query(SiteWeekPlan)
        .filter(SiteWeekPlan.site_id == site_id)
        .filter(SiteWeekPlan.week_iso == wk)
        .filter(SiteWeekPlan.scope == sc)
        .first()
    )
    if sc == "auto" and _is_empty_auto_week_plan(db.get(Site, site_id), row, wk):
        logger.warning(
            "[AUTO-PLANNING] hiding empty auto week plan site_id=%s week_iso=%s",
            site_id,
            wk,
        )
        return None
    if row is None or not isinstance(row.data, dict):
        return row.data if row else None
    return _shape_week_plan_get_payload(
        row.data,
        parts=parts_kind,
        include_workers=include_workers,
        source_scope=str(getattr(row, "scope", "") or ""),
    )


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
    data = deepcopy(payload.data) if isinstance(payload.data, dict) else None
    linked_auto_payloads_to_save: dict[str, dict] = {}
    if sc == "auto" and isinstance(data, dict):
        from .linked_sites import (
            _connected_site_ids_for_root,
            _enforce_linked_global_caps_on_site_payloads,
        )

        linked_site_ids = _connected_site_ids_for_root(db, user.id, site_id, wk)
        if len(linked_site_ids) > 1:
            existing_auto_rows = (
                db.query(SiteWeekPlan)
                .filter(SiteWeekPlan.site_id.in_(linked_site_ids))
                .filter(SiteWeekPlan.week_iso == wk)
                .filter(SiteWeekPlan.scope == "auto")
                .all()
            )
            payloads_by_site: dict[str, dict] = {
                str(int(existing_row.site_id)): deepcopy(existing_row.data) if isinstance(existing_row.data, dict) else {}
                for existing_row in existing_auto_rows
            }
            payloads_by_site[str(site_id)] = data
            normalized_payloads = _enforce_linked_global_caps_on_site_payloads(
                db,
                linked_site_ids,
                wk,
                payloads_by_site,
            )
            data = normalized_payloads.get(str(site_id), data)
            linked_auto_payloads_to_save = {
                site_id_key: site_payload
                for site_id_key, site_payload in normalized_payloads.items()
                if int(site_id_key) != int(site_id)
            }
    if row:
        row.data = data or {}
        row.updated_at = now
        flag_modified(row, "data")
    else:
        row = SiteWeekPlan(site_id=site_id, week_iso=wk, scope=sc, data=data or {}, updated_at=now)
        db.add(row)
    if sc == "auto" and linked_auto_payloads_to_save:
        for linked_site_id_str, linked_payload in linked_auto_payloads_to_save.items():
            _save_site_week_plan(db, int(linked_site_id_str), wk, "auto", linked_payload)
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
    if sc == "auto":
        from .auto_planning import _mark_auto_planning_week_handled_if_due

        _mark_auto_planning_week_handled_if_due(db, int(user.id), wk, "planning-page")
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

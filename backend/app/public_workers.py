from fastapi import APIRouter, HTTPException, Depends, Query, Body
from sqlalchemy.orm import Session
from sqlalchemy import func, or_
from .deps import get_db, get_current_user
from .models import Site, SiteWorker, SiteWeekPlan, SiteMessage, User, UserRole
from .schemas import (
    WorkerCreate,
    WorkerOut,
    SiteMessageOut,
    WorkerContextOut,
    WorkerContextUpdatePayload,
    WorkerInviteValidationOut,
    WorkerInviteRegistrationPayload,
    WorkerInviteRegistrationOut,
    WorkerInviteClaimPayload,
    WorkerInviteClaimOut,
)
from .auth import (
    create_worker_invite_token,
    decode_worker_invite_token,
    ensure_director_code,
    ensure_worker_site_membership,
    pwd_context,
)
import re
import secrets

router = APIRouter(prefix="/public/sites", tags=["public-workers"])

_WEEK_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _validate_week_iso(week_iso: str) -> str:
    wk = (week_iso or "").strip()
    if not _WEEK_ISO_RE.match(wk):
        raise HTTPException(status_code=400, detail="week invalide (YYYY-MM-DD)")
    return wk


def _norm_worker_name(value: str | None) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).lower()


def _norm_phone(value: str | None) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit() or ch == "+").strip()


def _resolve_invited_site(token: str, db: Session) -> tuple[Site, User]:
    payload = decode_worker_invite_token(token)
    site = db.get(Site, int(payload["site_id"]))
    if not site:
        raise HTTPException(status_code=404, detail="Site introuvable")
    director = db.get(User, int(payload["director_id"]))
    if not director or director.role != UserRole.director or int(site.director_id) != int(director.id):
        raise HTTPException(status_code=401, detail="Lien d'invitation invalide")
    ensure_director_code(director, db)
    db.flush()
    return site, director


@router.get("/invitations/{token}", response_model=WorkerInviteValidationOut)
def validate_worker_invitation(token: str, db: Session = Depends(get_db)):
    site, director = _resolve_invited_site(token, db)
    return WorkerInviteValidationOut(
        site_id=int(site.id),
        site_name=site.name,
        director_name=director.full_name,
        director_code=str(director.director_code or ""),
    )


@router.post("/invitations/register", response_model=WorkerInviteRegistrationOut, status_code=201)
def register_worker_via_invitation(
    payload: WorkerInviteRegistrationPayload = Body(...),
    db: Session = Depends(get_db),
):
    site, director = _resolve_invited_site(payload.token, db)
    normalized_phone = _norm_phone(payload.phone)
    full_name = re.sub(r"\s+", " ", str(payload.full_name or "").strip())
    if not normalized_phone or not full_name:
        raise HTTPException(status_code=400, detail="Nom et téléphone requis")

    existing_user = db.query(User).filter(User.phone == normalized_phone).first()
    already_exists = False
    if existing_user:
        if existing_user.role != UserRole.worker:
            raise HTTPException(status_code=400, detail="Ce numéro est déjà utilisé par un autre compte")
        if existing_user.full_name != full_name:
            existing_user.full_name = full_name
        already_exists = True
    else:
        existing_user = User(
            email=None,
            full_name=full_name,
            hashed_password=pwd_context.hash(secrets.token_urlsafe(24)),
            role=UserRole.worker,
            phone=normalized_phone,
        )
        db.add(existing_user)

    db.commit()
    return WorkerInviteRegistrationOut(
        ok=True,
        already_exists=already_exists,
        site_id=int(site.id),
        site_name=site.name,
        director_code=str(director.director_code or ""),
        phone=normalized_phone,
    )


@router.post("/invitations/claim", response_model=WorkerInviteClaimOut)
def claim_worker_invitation(
    payload: WorkerInviteClaimPayload = Body(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user.role != UserRole.worker:
        raise HTTPException(status_code=403, detail="Accès réservé aux travailleurs")
    site, _director = _resolve_invited_site(payload.token, db)
    _row, changed = ensure_worker_site_membership(db, site, user, pending_approval=True)
    if changed:
        db.commit()
    return WorkerInviteClaimOut(ok=True, created=changed, site_id=int(site.id), site_name=site.name)


def _get_affiliated_site_workers(user: User, db: Session) -> list[SiteWorker]:
    query = db.query(SiteWorker)
    phone = (user.phone or "").strip()
    user_name = _norm_worker_name(user.full_name)
    filters = [SiteWorker.user_id == user.id]
    if phone:
        filters.append(SiteWorker.phone == phone)
    rows = query.filter(or_(*filters)).all()
    if rows:
        return rows
    return query.filter(func.lower(SiteWorker.name) == user_name).all()


def _extract_week_answers(raw_answers: dict | None, week_iso: str | None) -> dict:
    answers = raw_answers or {}
    if not isinstance(answers, dict):
        return {}
    if week_iso and week_iso in answers and isinstance(answers.get(week_iso), dict):
        return answers.get(week_iso) or {}
    if "general" in answers or "perDay" in answers:
        return {
            "general": answers.get("general") if isinstance(answers.get("general"), dict) else {},
            "perDay": answers.get("perDay") if isinstance(answers.get("perDay"), dict) else {},
        }
    return answers


@router.get("/worker-sites")
def get_worker_sites(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Endpoint pour obtenir la liste des sites où un travailleur est enregistré"""
    if user.role.value != "worker":
        raise HTTPException(status_code=403, detail="Accès réservé aux travailleurs")
    
    rows = _get_affiliated_site_workers(user, db)
    site_ids = sorted({int(r.site_id) for r in rows})
    if not site_ids:
        return []
    sites = db.query(Site).filter(Site.id.in_(site_ids)).all()
    by_id = {int(s.id): s for s in sites}
    return [{"id": sid, "name": by_id[sid].name} for sid in site_ids if sid in by_id]


@router.get("/worker-context", response_model=WorkerContextOut)
def get_worker_context(
    week_key: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user.role.value != "worker":
        raise HTTPException(status_code=403, detail="Accès réservé aux travailleurs")

    wk = _validate_week_iso(week_key) if week_key else None
    rows = _get_affiliated_site_workers(user, db)
    site_ids = sorted({int(r.site_id) for r in rows})
    sites = db.query(Site).filter(Site.id.in_(site_ids)).all() if site_ids else []
    sites_by_id = {int(s.id): s for s in sites}

    shifts_set: set[str] = set()
    questions: list[dict] = []
    merged_availability: dict[str, list[str]] = {k: [] for k in ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]}
    merged_answers_general: dict[str, object] = {}
    merged_answers_per_day: dict[str, dict[str, object]] = {}
    max_shifts_candidates: list[int] = []

    for row in rows:
        site = sites_by_id.get(int(row.site_id))
        if not site:
            continue
        config = site.config or {}
        stations = config.get("stations", []) or []
        local_shifts: set[str] = set()
        for st in stations:
            for sh in (st.get("shifts") or []):
                if sh and sh.get("enabled") and sh.get("name"):
                    local_shifts.add(str(sh.get("name")))
            if st.get("perDayCustom"):
                for ov in ((st.get("dayOverrides") or {}).values()):
                    if ov and ov.get("active"):
                        for sh in (ov.get("shifts") or []):
                            if sh and sh.get("enabled") and sh.get("name"):
                                local_shifts.add(str(sh.get("name")))
        shifts_set.update(local_shifts)

        for q in (config.get("questions") or []):
            qid = str((q or {}).get("id") or "").strip()
            label = str((q or {}).get("label") or "").strip()
            if not qid or not label:
                continue
            questions.append({
                "id": f"site:{row.site_id}:{qid}",
                "label": f"{site.name} • {label}",
                "type": (q or {}).get("type") or "text",
                "perDay": bool((q or {}).get("perDay")),
                "options": (q or {}).get("options") or [],
                "slider": (q or {}).get("slider"),
                "source_site_id": int(row.site_id),
                "source_site_name": site.name,
                "original_id": qid,
            })

        avail = row.availability or {}
        if isinstance(avail, dict):
            for day_key, shifts_list in avail.items():
                if isinstance(shifts_list, list):
                    merged_availability[day_key] = sorted({*merged_availability.get(day_key, []), *[str(x) for x in shifts_list if x]})

        if isinstance(row.max_shifts, int) and row.max_shifts > 0:
            max_shifts_candidates.append(int(row.max_shifts))

        week_answers = _extract_week_answers(row.answers if isinstance(row.answers, dict) else {}, wk)
        general = week_answers.get("general") if isinstance(week_answers, dict) else {}
        per_day = week_answers.get("perDay") if isinstance(week_answers, dict) else {}
        if isinstance(general, dict):
            for key, value in general.items():
                merged_answers_general[f"site:{row.site_id}:{key}"] = value
        if isinstance(per_day, dict):
            for key, value in per_day.items():
                if not isinstance(value, dict):
                    continue
                merged_answers_per_day[f"site:{row.site_id}:{key}"] = {str(k): v for k, v in value.items()}

    return WorkerContextOut(
        worker_name=user.full_name or "",
        sites=[{"id": sid, "name": sites_by_id[sid].name} for sid in site_ids if sid in sites_by_id],
        shifts=sorted(shifts_set),
        questions=questions,
        availability=merged_availability,
        answers={"general": merged_answers_general, "perDay": merged_answers_per_day},
        max_shifts=min(max_shifts_candidates) if max_shifts_candidates else 5,
    )


@router.post("/worker-context")
def save_worker_context(
    payload: WorkerContextUpdatePayload = Body(default=WorkerContextUpdatePayload()),
    week_key: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user.role.value != "worker":
        raise HTTPException(status_code=403, detail="Accès réservé aux travailleurs")
    wk = _validate_week_iso(week_key) if week_key else None
    rows = _get_affiliated_site_workers(user, db)
    if not rows:
        raise HTTPException(status_code=404, detail="Aucun site affilié")

    payload_answers = payload.answers if isinstance(payload.answers, dict) else {}
    general_answers = payload_answers.get("general") if isinstance(payload_answers.get("general"), dict) else {}
    per_day_answers = payload_answers.get("perDay") if isinstance(payload_answers.get("perDay"), dict) else {}

    for row in rows:
        row.availability = payload.availability or {}
        row.max_shifts = int(payload.max_shifts or 5)
        if row.user_id is None:
            row.user_id = user.id

        site_general = {}
        for key, value in general_answers.items():
            prefix = f"site:{row.site_id}:"
            if str(key).startswith(prefix):
                site_general[str(key)[len(prefix):]] = value

        site_per_day = {}
        for key, value in per_day_answers.items():
            prefix = f"site:{row.site_id}:"
            if str(key).startswith(prefix) and isinstance(value, dict):
                site_per_day[str(key)[len(prefix):]] = value

        answers_data = {"general": site_general, "perDay": site_per_day}
        if wk:
            base = row.answers if isinstance(row.answers, dict) else {}
            next_answers = dict(base)
            next_answers[wk] = answers_data
            row.answers = next_answers
        else:
            row.answers = answers_data

    db.commit()
    return {"ok": True}


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
            pending_approval=False,
        )
    
    # Retourner les réponses de la semaine spécifiée si week_key est fourni
    answers = worker.answers or {}
    if week_key:
        wk = _validate_week_iso(week_key)
        if isinstance(answers, dict) and wk in answers:
            answers = answers[wk]
        elif isinstance(answers, dict) and ("general" in answers or "perDay" in answers):
            # Compat / migration: ancien format stocké sans clé semaine.
            # On le retourne quand même pour wk, et on le migre sous answers[wk] pour les prochains loads.
            week_answers = {
                "general": answers.get("general") if isinstance(answers.get("general"), dict) else {},
                "perDay": answers.get("perDay") if isinstance(answers.get("perDay"), dict) else {},
            }
            try:
                # IMPORTANT (SQLAlchemy JSON): ne pas muter le dict en place (changements non détectés sans MutableDict)
                base = worker.answers if isinstance(worker.answers, dict) else {}
                if wk not in base:
                    cur = dict(base)
                    cur[wk] = week_answers
                    worker.answers = cur
                    db.commit()
                    db.refresh(worker)
            except Exception:
                pass
            answers = week_answers
        else:
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
        pending_approval=bool(getattr(worker, "pending_approval", False)),
    )


@router.get("/{site_id}/week-plan", response_model=dict | None)
def get_published_week_plan(
    site_id: int,
    week: str = Query(..., description="YYYY-MM-DD (week start)"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Planning publié (scope=shared) pour une semaine donnée (visible pour les workers authentifiés)."""
    if user.role.value != "worker":
        raise HTTPException(status_code=403, detail="Accès réservé aux travailleurs")
    wk = _validate_week_iso(week)
    row = (
        db.query(SiteWeekPlan)
        .filter(SiteWeekPlan.site_id == site_id)
        .filter(SiteWeekPlan.week_iso == wk)
        .filter(SiteWeekPlan.scope == "shared")
        .first()
    )
    return row.data if row else None


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
def register_worker(site_id: int, payload: WorkerCreate, week_key: str | None = Query(None), db: Session = Depends(get_db)):
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
    
    # Extraire week_key via query param (prioritaire) ou via payload.answers.week_key
    wk = (week_key or "").strip() or None
    answers_payload = payload.answers if isinstance(payload.answers, dict) else {}
    body_wk = None
    try:
        body_wk = str(answers_payload.get("week_key") or "").strip() or None
    except Exception:
        body_wk = None
    if not wk and body_wk:
        wk = body_wk
    # Normalize/validate if provided
    if wk:
        wk = _validate_week_iso(str(wk))

    # Normaliser les réponses à stocker (sans week_key)
    # On attend typiquement {general: {...}, perDay: {...}}.
    answers_data: dict = {}
    if isinstance(answers_payload, dict):
        if "general" in answers_payload or "perDay" in answers_payload:
            g = answers_payload.get("general")
            p = answers_payload.get("perDay")
            answers_data = {
                "general": g if isinstance(g, dict) else {},
                "perDay": p if isinstance(p, dict) else {},
            }
        else:
            # fallback: stocker tel quel (évite de perdre des formats inattendus)
            answers_data = {k: v for k, v in answers_payload.items() if k != "week_key"}
    
    if existing:
        # Si le worker existe déjà, mettre à jour sa זמינות et max_shifts
        existing.availability = payload.availability or {}
        
        # Stocker les réponses par semaine si week_key est fourni (query ou body)
        if wk:
            # IMPORTANT (SQLAlchemy JSON): ne pas muter le dict en place (changements non détectés sans MutableDict)
            base = existing.answers if isinstance(existing.answers, dict) else {}
            current_answers = dict(base)
            current_answers[str(wk)] = answers_data
            existing.answers = current_answers
        elif answers_data:
            # Compatibilité ascendante : si pas de week_key, stocker directement
            existing.answers = dict(answers_data) if isinstance(answers_data, dict) else answers_data
        
        if payload.max_shifts is not None:
            existing.max_shifts = payload.max_shifts
        db.commit()
        db.refresh(existing)
        
        # Retourner les réponses de la semaine si week_key est fourni
        return_answers = existing.answers or {}
        if wk and isinstance(return_answers, dict) and str(wk) in return_answers:
            return_answers = return_answers[str(wk)]
        
        return WorkerOut(
            id=existing.id,
            site_id=existing.site_id,
            name=existing.name,
            max_shifts=existing.max_shifts,
            roles=existing.roles or [],
            availability=existing.availability or {},
            answers=return_answers,
            pending_approval=bool(getattr(existing, "pending_approval", False)),
        )
    
    # Créer un nouveau worker
    initial_answers = {}
    if wk:
        initial_answers[str(wk)] = answers_data
    elif answers_data:
        initial_answers = answers_data
    
    w = SiteWorker(
        site_id=site_id,
        name=payload.name,
        max_shifts=payload.max_shifts or 5,
        roles=payload.roles or [],
        availability=payload.availability or {},
        answers=initial_answers,
        pending_approval=False,
    )
    db.add(w)
    db.commit()
    db.refresh(w)
    
    return_answers = w.answers or {}
    if wk and isinstance(return_answers, dict) and str(wk) in return_answers:
        return_answers = return_answers[str(wk)]
    
    return WorkerOut(
        id=w.id,
        site_id=w.site_id,
        name=w.name,
        max_shifts=w.max_shifts,
        roles=w.roles or [],
        availability=w.availability or {},
        answers=return_answers,
        pending_approval=bool(getattr(w, "pending_approval", False)),
    )


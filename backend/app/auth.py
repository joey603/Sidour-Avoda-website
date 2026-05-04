from datetime import datetime, timedelta, timezone
import re
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from jose import jwt
from passlib.context import CryptContext
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from . import pwned_passwords
from .database import SessionLocal, settings
from .models import Site, SiteWorker, User, UserRole, WorkerInviteToken
from .rate_limit import enforce_rate_limit
from .schemas import LoginRequest, Token, UserCreate, UserOut, WorkerLoginRequest


router = APIRouter(prefix="/auth", tags=["auth"])
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
WORKER_INVITE_TOKEN_TYPE = "worker_invite"
_WHITESPACE_RE = re.compile(r"\s+")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _cookie_kwargs() -> dict:
    domain = str(settings.auth_cookie_domain or "").strip() or None
    same_site = str(settings.auth_cookie_samesite or "lax").strip().lower() or "lax"
    if same_site not in {"lax", "strict", "none"}:
        same_site = "lax"
    return {
        "key": settings.auth_cookie_name,
        "httponly": True,
        "secure": bool(settings.auth_cookie_secure),
        "samesite": same_site,
        "domain": domain,
        "path": "/",
    }


def set_auth_cookie(response: Response, token: str) -> None:
    cookie_kwargs = _cookie_kwargs()
    response.set_cookie(
        value=token,
        max_age=int(settings.access_token_expire_minutes * 60),
        **cookie_kwargs,
    )


def clear_auth_cookie(response: Response) -> None:
    cookie_kwargs = _cookie_kwargs()
    response.delete_cookie(**cookie_kwargs)


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.access_token_expire_minutes)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def _normalize_phone(value: str | None) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit() or ch == "+").strip()


def _normalize_name(value: str | None) -> str:
    return _WHITESPACE_RE.sub(" ", str(value or "").strip()).lower()


def ensure_director_code(user: User, db: Session) -> str:
    existing = str(getattr(user, "director_code", "") or "").strip()
    if existing:
        return existing
    while True:
        candidate = secrets.token_hex(3).upper()
        taken = (
            db.query(User.id)
            .filter(User.role == UserRole.director, User.director_code == candidate, User.id != user.id)
            .first()
        )
        if not taken:
            user.director_code = candidate
            return candidate


def create_worker_invite_token(
    site_id: int,
    director_id: int,
    db: Session,
    expires_delta: timedelta | None = None,
) -> str:
    expires_delta = expires_delta or timedelta(minutes=settings.worker_invite_expire_minutes)
    expire = datetime.now(timezone.utc) + expires_delta
    token_id = secrets.token_urlsafe(24)
    invite = WorkerInviteToken(
        token_id=token_id,
        site_id=int(site_id),
        director_id=int(director_id),
        created_at=_now_ms(),
        expires_at=int(expire.timestamp() * 1000),
        used_at=None,
        used_by_user_id=None,
    )
    db.add(invite)
    db.flush()
    return jwt.encode(
        {
            "type": WORKER_INVITE_TOKEN_TYPE,
            "site_id": int(site_id),
            "director_id": int(director_id),
            "jti": token_id,
            "exp": expire,
        },
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )


def decode_worker_invite_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except Exception:
        raise HTTPException(status_code=401, detail="Lien d'invitation invalide")
    if str(payload.get("type") or "") != WORKER_INVITE_TOKEN_TYPE:
        raise HTTPException(status_code=401, detail="Lien d'invitation invalide")
    try:
        site_id = int(payload.get("site_id"))
        director_id = int(payload.get("director_id"))
    except Exception:
        raise HTTPException(status_code=401, detail="Lien d'invitation invalide")
    token_id = str(payload.get("jti") or "").strip()
    if not token_id:
        raise HTTPException(status_code=401, detail="Lien d'invitation invalide")
    return {"site_id": site_id, "director_id": director_id, "jti": token_id}


def resolve_worker_invite_token(
    db: Session,
    token: str,
    *,
    allow_used: bool = False,
) -> tuple[WorkerInviteToken, dict]:
    payload = decode_worker_invite_token(token)
    invite = (
        db.query(WorkerInviteToken)
        .filter(WorkerInviteToken.token_id == payload["jti"])
        .first()
    )
    if not invite:
        raise HTTPException(status_code=401, detail="Lien d'invitation invalide")
    if int(invite.site_id) != int(payload["site_id"]) or int(invite.director_id) != int(payload["director_id"]):
        raise HTTPException(status_code=401, detail="Lien d'invitation invalide")
    if int(getattr(invite, "expires_at", 0) or 0) <= _now_ms():
        raise HTTPException(status_code=401, detail="Lien d'invitation expiré")
    if getattr(invite, "used_at", None) and not allow_used:
        raise HTTPException(status_code=401, detail="Lien d'invitation déjà utilisé")
    return invite, payload


def consume_worker_invite_token(
    invite: WorkerInviteToken,
    *,
    used_by_user_id: int | None = None,
) -> None:
    invite.used_at = _now_ms()
    invite.used_by_user_id = int(used_by_user_id) if used_by_user_id is not None else None


def ensure_worker_site_membership(
    db: Session,
    site: Site,
    user: User,
    *,
    pending_approval: bool = False,
) -> tuple[SiteWorker, bool]:
    now_ms = _now_ms()
    normalized_phone = _normalize_phone(user.phone)
    normalized_name = _normalize_name(user.full_name)

    filters = [SiteWorker.user_id == int(user.id)]
    if normalized_phone:
        filters.append(SiteWorker.phone == normalized_phone)
    if normalized_name:
        filters.append(func.lower(SiteWorker.name) == normalized_name)

    existing = (
        db.query(SiteWorker)
        .filter(SiteWorker.site_id == int(site.id))
        .filter(or_(*filters))
        .first()
    )

    changed = False
    if existing:
        if existing.user_id != user.id:
            existing.user_id = user.id
            changed = True
        if normalized_phone and existing.phone != normalized_phone:
            existing.phone = normalized_phone
            changed = True
        if existing.pending_approval != bool(pending_approval):
            existing.pending_approval = bool(pending_approval)
            changed = True
        if normalized_name and _normalize_name(existing.name) == normalized_name and existing.name != (user.full_name or ""):
            existing.name = user.full_name or existing.name
            changed = True
        return existing, changed

    created = SiteWorker(
        site_id=int(site.id),
        user_id=int(user.id),
        name=(user.full_name or "").strip() or normalized_phone or "Worker",
        phone=normalized_phone or None,
        max_shifts=5,
        roles=[],
        availability={},
        answers={},
        pending_approval=pending_approval,
        created_at=now_ms,
    )
    db.add(created)
    db.flush()
    return created, True


def _issue_token_for_user(user: User, response: Response) -> Token:
    token = create_access_token({"sub": str(user.id), "role": user.role.value})
    set_auth_cookie(response, token)
    return Token(access_token=token, token_type="bearer")


@router.post("/register", response_model=UserOut, status_code=201)
def register(user_in: UserCreate, db: Session = Depends(get_db)):
    if str(user_in.role) != UserRole.worker.value:
        raise HTTPException(status_code=403, detail="La création publique de directeurs est désactivée")
    if settings.enable_pwned_password_check:
        try:
            if pwned_passwords.is_password_pwned(user_in.password):
                raise HTTPException(
                    status_code=400,
                    detail="Ce mot de passe figure dans des fuites de données connues (Have I Been Pwned). Choisissez un autre mot de passe.",
                )
        except pwned_passwords.PwnedPasswordsServiceError:
            raise HTTPException(
                status_code=503,
                detail="Vérification du mot de passe impossible pour le moment. Réessayez plus tard.",
            )
    normalized_phone = _normalize_phone(user_in.phone)
    if user_in.email:
        existing_email = db.query(User).filter(User.email == user_in.email).first()
        if existing_email:
            raise HTTPException(status_code=400, detail="Email déjà enregistré")
    if normalized_phone:
        existing_phone = db.query(User).filter(User.phone == normalized_phone).first()
        if existing_phone:
            raise HTTPException(status_code=400, detail="Numéro de téléphone déjà enregistré")

    user = User(
        email=user_in.email,
        full_name=user_in.full_name,
        hashed_password=pwd_context.hash(user_in.password),
        role=UserRole.worker,
        phone=normalized_phone or None,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return UserOut(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=user.role.value,
        phone=user.phone,
        director_code=user.director_code,
    )


@router.post("/login", response_model=Token)
def login(
    req: LoginRequest,
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
):
    subject = req.email or req.phone or ""
    enforce_rate_limit(
        request,
        scope="auth-login",
        limit=10,
        window_seconds=60,
        subject=subject,
        detail="Trop de tentatives de connexion. Réessaie dans une minute.",
    )
    if req.phone:
        user: User | None = db.query(User).filter(User.phone == _normalize_phone(req.phone)).first()
    elif req.email:
        email_key = (req.email or "").strip().lower()
        if not email_key:
            raise HTTPException(status_code=400, detail="Email ou téléphone requis")
        user = db.query(User).filter(func.lower(User.email) == email_key).first()
    else:
        raise HTTPException(status_code=400, detail="Email ou téléphone requis")

    if not user or not pwd_context.verify(req.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Identifiants invalides")
    return _issue_token_for_user(user, response)


@router.post("/worker-login", response_model=Token)
def worker_login(
    req: WorkerLoginRequest,
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
):
    normalized_phone = _normalize_phone(req.phone)
    enforce_rate_limit(
        request,
        scope="worker-login",
        limit=10,
        window_seconds=60,
        subject=normalized_phone,
        detail="Trop de tentatives de connexion travailleur. Réessaie dans une minute.",
    )
    user: User | None = (
        db.query(User)
        .filter(User.phone == normalized_phone, User.role == UserRole.worker)
        .first()
    )
    if not user or not pwd_context.verify(req.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Identifiants invalides")
    return _issue_token_for_user(user, response)


@router.post("/logout")
def logout(response: Response):
    clear_auth_cookie(response)
    return {"ok": True}



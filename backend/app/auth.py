from datetime import datetime, timedelta, timezone
import re
import secrets

from fastapi import APIRouter, Depends, HTTPException, status
from jose import jwt
from passlib.context import CryptContext
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from .database import SessionLocal, settings
from .models import User, UserRole, SiteWorker, Site
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


def resolve_director_by_code(db: Session, code: str) -> User | None:
    normalized = str(code or "").strip()
    if not normalized:
        return None
    director: User | None = (
        db.query(User)
        .filter(User.role == UserRole.director, User.director_code == normalized)
        .first()
    )
    if director:
        return director
    try:
        director_id_int = int(normalized)
    except Exception:
        return None
    return (
        db.query(User)
        .filter(User.role == UserRole.director, User.id == director_id_int)
        .first()
    )


def create_worker_invite_token(site_id: int, director_id: int, expires_delta: timedelta | None = None) -> str:
    return create_access_token(
        {
            "type": WORKER_INVITE_TOKEN_TYPE,
            "site_id": int(site_id),
            "director_id": int(director_id),
        },
        expires_delta or timedelta(days=30),
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
    return {"site_id": site_id, "director_id": director_id}


def ensure_worker_site_membership(
    db: Session,
    site: Site,
    user: User,
    *,
    pending_approval: bool = False,
) -> tuple[SiteWorker, bool]:
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
        if not pending_approval and existing.pending_approval:
            existing.pending_approval = False
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
    )
    db.add(created)
    db.flush()
    return created, True


@router.post("/register", response_model=UserOut, status_code=201)
def register(user_in: UserCreate, db: Session = Depends(get_db)):
    normalized_phone = _normalize_phone(user_in.phone)
    # Vérifier si email ou phone existe déjà
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
        role=UserRole(user_in.role),
        phone=normalized_phone or None,
    )
    db.add(user)
    if user.role == UserRole.director:
        ensure_director_code(user, db)
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
def login(req: LoginRequest, db: Session = Depends(get_db)):
    # Support login par email ou téléphone
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
    token = create_access_token({"sub": str(user.id), "role": user.role.value})
    return {"access_token": token, "token_type": "bearer"}


@router.post("/worker-login", response_model=Token)
def worker_login(req: WorkerLoginRequest, db: Session = Depends(get_db)):
    """Authentification des travailleurs avec code directeur + téléphone (sans mot de passe)"""
    normalized_phone = _normalize_phone(req.phone)
    # 1) Vérifier que le téléphone correspond à un utilisateur worker
    user: User | None = (
        db.query(User)
        .filter(User.phone == normalized_phone, User.role == UserRole.worker)
        .first()
    )
    if not user:
        raise HTTPException(status_code=401, detail="Identifiants invalides")
    
    # 2) Le "code" identifie le directeur (champ users.director_code)
    code = (req.code or "").strip()
    if not code:
        raise HTTPException(status_code=401, detail="Identifiants invalides")
    director = resolve_director_by_code(db, code)
    if not director:
        raise HTTPException(status_code=401, detail="Identifiants invalides")

    sw: SiteWorker | None = None
    changed = False
    if req.invite_token:
        invite_payload = decode_worker_invite_token(req.invite_token)
        if int(invite_payload["director_id"]) != int(director.id):
            raise HTTPException(status_code=401, detail="Lien d'invitation invalide pour ce code directeur")
        invite_site = db.get(Site, int(invite_payload["site_id"]))
        if not invite_site or int(invite_site.director_id) != int(director.id):
            raise HTTPException(status_code=401, detail="Lien d'invitation invalide pour ce site")
        sw, changed = ensure_worker_site_membership(db, invite_site, user, pending_approval=True)

    # 3) Vérifier que ce worker appartient à au moins un site du directeur
    #    (via lien user_id, ou via phone stocké dans SiteWorker)
    if not sw:
        sw = (
            db.query(SiteWorker)
            .join(Site, Site.id == SiteWorker.site_id)
            .filter(
                Site.director_id == director.id,
                (SiteWorker.user_id == user.id) | (SiteWorker.phone == normalized_phone),
            )
            .first()
        )
    if not sw:
        raise HTTPException(status_code=401, detail="Identifiants invalides")

    # 4) Lier toutes les lignes SiteWorker compatibles à ce user pour stabiliser le multi-sites
    rows_to_link = (
        db.query(SiteWorker)
        .join(Site, Site.id == SiteWorker.site_id)
        .filter(
            Site.director_id == director.id,
            ((SiteWorker.phone == normalized_phone) | (SiteWorker.user_id == user.id)),
        )
        .all()
    )
    for row in rows_to_link:
        if row.user_id != user.id:
            row.user_id = user.id
            changed = True
        if normalized_phone and row.phone != normalized_phone:
            row.phone = normalized_phone
            changed = True
    if changed:
        try:
            db.commit()
        except Exception:
            db.rollback()
    
    token = create_access_token({"sub": str(user.id), "role": user.role.value})
    return {"access_token": token, "token_type": "bearer"}



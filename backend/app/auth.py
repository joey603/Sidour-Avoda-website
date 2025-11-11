from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from jose import jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from .database import SessionLocal, settings
from .models import User, UserRole
from .schemas import LoginRequest, Token, UserCreate, UserOut, WorkerLoginRequest


router = APIRouter(prefix="/auth", tags=["auth"])
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


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


@router.post("/register", response_model=UserOut, status_code=201)
def register(user_in: UserCreate, db: Session = Depends(get_db)):
    # Vérifier si email ou phone existe déjà
    if user_in.email:
        existing_email = db.query(User).filter(User.email == user_in.email).first()
        if existing_email:
            raise HTTPException(status_code=400, detail="Email déjà enregistré")
    if user_in.phone:
        existing_phone = db.query(User).filter(User.phone == user_in.phone).first()
        if existing_phone:
            raise HTTPException(status_code=400, detail="Numéro de téléphone déjà enregistré")
    
    user = User(
        email=user_in.email,
        full_name=user_in.full_name,
        hashed_password=pwd_context.hash(user_in.password),
        role=UserRole(user_in.role),
        phone=user_in.phone,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return UserOut(id=user.id, email=user.email, full_name=user.full_name, role=user.role.value, phone=user.phone)


@router.post("/login", response_model=Token)
def login(req: LoginRequest, db: Session = Depends(get_db)):
    # Support login par email ou téléphone
    if req.phone:
        user: User | None = db.query(User).filter(User.phone == req.phone).first()
    elif req.email:
        user: User | None = db.query(User).filter(User.email == req.email).first()
    else:
        raise HTTPException(status_code=400, detail="Email ou téléphone requis")
    
    if not user or not pwd_context.verify(req.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Identifiants invalides")
    token = create_access_token({"sub": str(user.id), "role": user.role.value})
    return {"access_token": token, "token_type": "bearer"}


@router.post("/worker-login", response_model=Token)
def worker_login(req: WorkerLoginRequest, db: Session = Depends(get_db)):
    """Authentification des travailleurs avec nom et téléphone (sans mot de passe)"""
    # Vérifier que le téléphone et le nom correspondent à un utilisateur worker
    user: User | None = db.query(User).filter(
        User.phone == req.phone,
        User.role == UserRole.worker
    ).first()
    
    if not user:
        raise HTTPException(status_code=401, detail="Identifiants invalides")
    
    # Vérifier que le nom correspond (insensible à la casse)
    if user.full_name.strip().lower() != req.name.strip().lower():
        raise HTTPException(status_code=401, detail="Identifiants invalides")
    
    token = create_access_token({"sub": str(user.id), "role": user.role.value})
    return {"access_token": token, "token_type": "bearer"}



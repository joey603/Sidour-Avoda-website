from fastapi import Depends, HTTPException, Request, status
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from .database import SessionLocal, settings
from .models import User


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _extract_bearer_token(request: Request) -> str | None:
    auth_header = str(request.headers.get("authorization") or "").strip()
    if auth_header.lower().startswith("bearer "):
        token = auth_header[7:].strip()
        if token and token.lower() not in {"null", "undefined"}:
            return token
    cookie_token = str(request.cookies.get(settings.auth_cookie_name) or "").strip()
    if cookie_token:
        return cookie_token
    return None


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Non authentifié",
        headers={"WWW-Authenticate": "Bearer"},
    )
    token = _extract_bearer_token(request)
    if not token:
        raise credentials_exception
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        user_id: str | None = payload.get("sub")
    except JWTError:
        raise credentials_exception
    if user_id is None:
        raise credentials_exception
    user = db.get(User, int(user_id))
    if user is None:
        raise credentials_exception
    return user


def require_role(required_role: str):
    def checker(user: User = Depends(get_current_user)):
        if user.role.value != required_role:
            raise HTTPException(status_code=403, detail="Accès refusé")
        return user

    return checker



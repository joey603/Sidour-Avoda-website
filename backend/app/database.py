from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from pydantic import field_validator
from pydantic_settings import BaseSettings
from pydantic_settings import SettingsConfigDict
import os


BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEFAULT_SQLITE_URL = f"sqlite:///{os.path.join(BASE_DIR, 'dev.db')}"


class Settings(BaseSettings):
    # Charge automatiquement backend/.env (local) + variables d'env (Render)
    model_config = SettingsConfigDict(
        env_file=os.path.join(BASE_DIR, ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Par défaut, utiliser la base SQLite locale (dev.db). Surchargable via DATABASE_URL (ex. Neon).
    database_url: str = DEFAULT_SQLITE_URL

    @field_validator("database_url", mode="before")
    @classmethod
    def database_url_non_vide(cls, v: object) -> object:
        """DATABASE_URL="" dans .env.example → rester sur SQLite local."""
        if v is None:
            return DEFAULT_SQLITE_URL
        if isinstance(v, str) and not v.strip():
            return DEFAULT_SQLITE_URL
        return v
    jwt_secret: str = "change-me"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24

    # Have I Been Pwned (Pwned Passwords) à l’inscription — désactivé par défaut (tests / compat).
    enable_pwned_password_check: bool = False


settings = Settings()

# Normaliser l'URL Postgres pour utiliser psycopg3 (pas psycopg2)
# Render/Neon fournissent souvent "postgresql://...", ce qui fait choisir psycopg2 par défaut.
if isinstance(settings.database_url, str) and settings.database_url.startswith("postgresql://"):
    settings.database_url = "postgresql+psycopg://" + settings.database_url[len("postgresql://"):]
# Ancien schéma éventuel
if isinstance(settings.database_url, str) and settings.database_url.startswith("postgres://"):
    settings.database_url = "postgresql+psycopg://" + settings.database_url[len("postgres://") :]

# Activer connect_args appropriés pour SQLite ; pool recycle pour Neon/serverless (connexions idle)
is_sqlite = settings.database_url.startswith("sqlite:")
_engine_kwargs: dict = {"pool_pre_ping": True}
if is_sqlite:
    _engine_kwargs["connect_args"] = {"check_same_thread": False}
else:
    # Neon ferme les connexions inactives : recycler avant timeout côté serveur
    _engine_kwargs["pool_recycle"] = 280

engine = create_engine(settings.database_url, **_engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass



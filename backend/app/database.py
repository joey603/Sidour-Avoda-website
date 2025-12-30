from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from pydantic_settings import BaseSettings
import os


BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEFAULT_SQLITE_URL = f"sqlite:///{os.path.join(BASE_DIR, 'dev.db')}"


class Settings(BaseSettings):
    # Par défaut, utiliser la base SQLite locale (dev.db). Surchargable via env DATABASE_URL
    database_url: str = os.getenv("DATABASE_URL", DEFAULT_SQLITE_URL)
    jwt_secret: str = os.getenv("JWT_SECRET", "change-me")
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24


settings = Settings()

# Normaliser l'URL Postgres pour utiliser psycopg3 (pas psycopg2)
# Render/Neon fournissent souvent "postgresql://...", ce qui fait choisir psycopg2 par défaut.
if isinstance(settings.database_url, str) and settings.database_url.startswith("postgresql://"):
    settings.database_url = "postgresql+psycopg://" + settings.database_url[len("postgresql://"):]

# Activer connect_args appropriés pour SQLite
is_sqlite = settings.database_url.startswith("sqlite:")
engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    connect_args={"check_same_thread": False} if is_sqlite else {},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass



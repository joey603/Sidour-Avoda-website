import os
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from app.main import create_app
from app.database import Base
import app.deps as deps
import app.auth as auth_mod
from app.models import User, UserRole


@pytest.fixture(scope="session")
def test_engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    try:
        yield engine
    finally:
        Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def db_session(test_engine):
    TestingSessionLocal = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture()
def client(db_session):
    app = create_app()

    def override_get_db():
        try:
            yield db_session
        finally:
            pass

    # Override both deps and auth get_db providers
    app.dependency_overrides[deps.get_db] = override_get_db
    app.dependency_overrides[auth_mod.get_db] = override_get_db

    return TestClient(app)


@pytest.fixture()
def create_director(db_session):
    def _create_director(*, email: str, full_name: str, password: str = "password123", phone: str | None = None):
        user = User(
            email=email,
            full_name=full_name,
            hashed_password=auth_mod.pwd_context.hash(password),
            role=UserRole.director,
            phone=phone,
        )
        db_session.add(user)
        db_session.flush()
        auth_mod.ensure_director_code(user, db_session)
        db_session.commit()
        db_session.refresh(user)
        return user

    return _create_director



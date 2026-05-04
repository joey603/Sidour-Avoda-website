"""
Tests API / sécurité (auth, rôles, tokens) — sans couvrir la logique planning (pages volumineuses).
"""

from jose import jwt

from app.database import settings


def _auth(token: str):
    return {"Authorization": f"Bearer {token}"}


def test_director_routes_require_auth(client):
    """Sans en-tête Bearer, les routes directeur ne doivent pas exposer de données."""
    r = client.get("/director/sites/")
    assert r.status_code in (401, 403), r.text


def test_me_requires_auth(client):
    r = client.get("/me")
    assert r.status_code == 401


def test_invalid_jwt_rejected(client):
    r = client.get("/me", headers=_auth("not.a.valid.jwt.token"))
    assert r.status_code == 401


def test_malformed_jwt_signature_rejected(client):
    """JWT syntaxiquement valide mais mauvaise signature."""
    bad = jwt.encode({"sub": "1"}, "wrong-secret", algorithm=settings.jwt_algorithm)
    r = client.get("/me", headers=_auth(bad))
    assert r.status_code == 401


def test_worker_cannot_list_director_sites(client):
    client.post(
        "/auth/register",
        json={
            "email": "sec.worker@example.com",
            "full_name": "Sec Worker",
            "password": "password123",
            "role": "worker",
        },
    )
    tok = client.post(
        "/auth/login",
        json={"email": "sec.worker@example.com", "password": "password123"},
    ).json()["access_token"]
    r = client.get("/director/sites/", headers=_auth(tok))
    assert r.status_code == 403, r.text


def test_director_can_list_own_sites(client, create_director):
    create_director(email="sec.director@example.com", full_name="Sec Director")
    tok = client.post(
        "/auth/login",
        json={"email": "sec.director@example.com", "password": "password123"},
    ).json()["access_token"]
    r = client.get("/director/sites/", headers=_auth(tok))
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), list)


def test_auth_login_rejects_unknown_user(client):
    r = client.post("/auth/login", json={"email": "nobody@example.com", "password": "x"})
    assert r.status_code == 401


def test_auth_login_is_rate_limited_after_repeated_failures(client):
    for _ in range(10):
        r = client.post("/auth/login", json={"email": "nobody@example.com", "password": "wrongpass123"})
        assert r.status_code == 401
    limited = client.post("/auth/login", json={"email": "nobody@example.com", "password": "wrongpass123"})
    assert limited.status_code == 429


def test_health_public_no_auth(client):
    """Sonde /health pour chargeurs et tests de charge — sans auth."""
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}

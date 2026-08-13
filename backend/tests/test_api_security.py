"""
Tests API / sécurité (auth, rôles, tokens) — sans couvrir la logique planning (pages volumineuses).
"""

from jose import jwt

from app.database import settings
from app.models import Site


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


def test_director_sites_list_tolerates_legacy_invalid_site_config(client, db_session, create_director):
    director = create_director(email="legacy.config@example.com", full_name="Legacy Config")
    db_session.add(Site(name="Legacy Site", director_id=director.id, config=["legacy-bad-config"]))
    db_session.commit()
    tok = client.post(
        "/auth/login",
        json={"email": "legacy.config@example.com", "password": "password123"},
    ).json()["access_token"]
    r = client.get("/director/sites/", headers=_auth(tok))
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body) == 1
    assert body[0]["name"] == "Legacy Site"
    assert body[0]["config"] == {}


def test_auth_login_rejects_unknown_user(client):
    r = client.post("/auth/login", json={"email": "nobody@example.com", "password": "x"})
    assert r.status_code == 401


def test_auth_login_is_rate_limited_after_repeated_failures(client):
    for _ in range(10):
        r = client.post("/auth/login", json={"email": "nobody@example.com", "password": "wrongpass123"})
        assert r.status_code == 401
    limited = client.post("/auth/login", json={"email": "nobody@example.com", "password": "wrongpass123"})
    assert limited.status_code == 429


def test_public_site_info_and_register_require_auth(client, db_session, create_director):
    from tests.test_worker_invites import auth_headers, clear_auth_cookies, create_site, login_director

    create_director(email="sec.public@example.com", full_name="Sec Public")
    director_tok = login_director(client, email="sec.public@example.com", password="password123").json()["access_token"]
    site_id = create_site(client, director_tok, "Private Site").json()["id"]
    clear_auth_cookies(client)

    info = client.get(f"/public/sites/{site_id}/info")
    assert info.status_code == 401, info.text
    anon_reg = client.post(
        f"/public/sites/{site_id}/register",
        json={"name": "Intrus", "max_shifts": 5, "roles": [], "availability": {}},
    )
    assert anon_reg.status_code == 401, anon_reg.text

    invite_token = client.get(
        f"/director/sites/{site_id}/worker-invite",
        headers=auth_headers(director_tok),
    ).json()["token"]
    assert (
        client.post(
            "/public/sites/invitations/register",
            json={
                "token": invite_token,
                "full_name": "Sec Site Worker",
                "phone": "0501112222",
                "password": "workerpass123",
            },
        ).status_code
        == 201
    )
    clear_auth_cookies(client)
    worker_tok = client.post(
        "/auth/worker-login",
        json={"phone": "0501112222", "password": "workerpass123"},
    ).json()["access_token"]
    ok_info = client.get(f"/public/sites/{site_id}/info", headers=auth_headers(worker_tok))
    assert ok_info.status_code == 200, ok_info.text
    assert ok_info.json()["name"] == "Private Site"


def test_health_public_no_auth(client):
    """Sonde /health pour chargeurs et tests de charge — sans auth."""
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body.get("status") == "ok"
    # Absent hors Oracle (fichier watchdog manquant) → null ; présent en prod.
    assert "watchdog" in body
    assert body["watchdog"] is None or isinstance(body["watchdog"], dict)

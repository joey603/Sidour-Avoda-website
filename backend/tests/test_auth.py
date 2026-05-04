def register(client, email="user@example.com", full_name="John Doe", password="password123", role="worker"):
    return client.post(
        "/auth/register",
        json={"email": email, "full_name": full_name, "password": password, "role": role},
    )


def login(client, email="user@example.com", password="password123"):
    return client.post("/auth/login", json={"email": email, "password": password})


def test_register_and_login_worker(client):
    r = register(client)
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["email"] == "user@example.com"
    assert data["role"] == "worker"

    r2 = login(client)
    assert r2.status_code == 200, r2.text
    token = r2.json()["access_token"]
    assert token

    me = client.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    me_json = me.json()
    assert me_json["email"] == "user@example.com"
    assert me_json["role"] == "worker"


def test_duplicate_email(client):
    r1 = register(client, email="dup@example.com")
    assert r1.status_code == 201
    r2 = register(client, email="dup@example.com")
    assert r2.status_code == 400


def test_login_invalid_credentials(client):
    register(client, email="bad@example.com")
    r = login(client, email="bad@example.com", password="wrongpass")
    assert r.status_code == 401


def test_login_email_case_insensitive(client):
    register(client, email="Case.Test@Example.com")
    r = login(client, email="case.test@example.com", password="password123")
    assert r.status_code == 200, r.text
    assert r.json()["access_token"]


def test_login_sets_cookie_and_logout_clears_it(client):
    register(client, email="cookie@example.com")
    login_resp = login(client, email="cookie@example.com", password="password123")
    assert login_resp.status_code == 200, login_resp.text
    set_cookie = login_resp.headers.get("set-cookie") or ""
    assert "sidour_access_token=" in set_cookie
    assert "HttpOnly" in set_cookie

    me = client.get("/me")
    assert me.status_code == 200, me.text
    assert me.json()["email"] == "cookie@example.com"

    logout_resp = client.post("/auth/logout")
    assert logout_resp.status_code == 200, logout_resp.text
    me_after = client.get("/me")
    assert me_after.status_code == 401


def test_public_director_registration_is_blocked(client):
    r = register(client, email="blocked-director@example.com", role="director")
    assert r.status_code == 403


def test_role_access_control(client, create_director):
    # create one worker and one director
    register(client, email="w@example.com", role="worker")
    create_director(email="d@example.com", full_name="Director Auth")

    # login as worker
    tok_worker = login(client, email="w@example.com").json()["access_token"]
    # worker can access worker dashboard
    rw = client.get("/worker/dashboard", headers={"Authorization": f"Bearer {tok_worker}"})
    assert rw.status_code == 200
    # worker cannot access director dashboard
    rd = client.get("/director/dashboard", headers={"Authorization": f"Bearer {tok_worker}"})
    assert rd.status_code == 403

    # login as director
    tok_director = login(client, email="d@example.com").json()["access_token"]
    rd2 = client.get("/director/dashboard", headers={"Authorization": f"Bearer {tok_director}"})
    assert rd2.status_code == 200


def test_requires_authentication(client):
    r = client.get("/me")
    assert r.status_code == 401



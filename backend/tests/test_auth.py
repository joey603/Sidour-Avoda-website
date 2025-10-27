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


def test_role_access_control(client):
    # create one worker and one director
    register(client, email="w@example.com", role="worker")
    register(client, email="d@example.com", role="director")

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



from app.models import SiteWorker, User


def register_user(client, *, email: str, full_name: str, password: str, role: str, phone: str | None = None):
    payload = {
        "email": email,
        "full_name": full_name,
        "password": password,
        "role": role,
    }
    if phone is not None:
        payload["phone"] = phone
    return client.post("/auth/register", json=payload)


def login_director(client, *, email: str, password: str):
    return client.post("/auth/login", json={"email": email, "password": password})


def auth_headers(token: str):
    return {"Authorization": f"Bearer {token}"}


def create_site(client, token: str, name: str = "Site Invite"):
    return client.post(
        "/director/sites/",
        json={"name": name, "config": {}},
        headers=auth_headers(token),
    )


def test_director_can_generate_and_validate_worker_invite_link(client):
    register_resp = register_user(
        client,
        email="director.invite@example.com",
        full_name="Director Invite",
        password="password123",
        role="director",
    )
    assert register_resp.status_code == 201, register_resp.text
    director_code = register_resp.json()["director_code"]
    assert director_code

    login_resp = login_director(client, email="director.invite@example.com", password="password123")
    token = login_resp.json()["access_token"]
    site_resp = create_site(client, token, "Invite Site")
    assert site_resp.status_code == 201, site_resp.text
    site_id = site_resp.json()["id"]

    invite_resp = client.get(f"/director/sites/{site_id}/worker-invite", headers=auth_headers(token))
    assert invite_resp.status_code == 200, invite_resp.text
    invite_data = invite_resp.json()
    assert invite_data["token"]
    assert invite_data["invite_path"].startswith("/invite/worker/")

    validate_resp = client.get(f"/public/sites/invitations/{invite_data['token']}")
    assert validate_resp.status_code == 200, validate_resp.text
    validate_data = validate_resp.json()
    assert validate_data["site_id"] == site_id
    assert validate_data["site_name"] == "Invite Site"
    assert validate_data["director_code"] == director_code


def test_worker_invite_registration_and_login_attach_site(client, db_session):
    register_director_resp = register_user(
        client,
        email="director.attach@example.com",
        full_name="Director Attach",
        password="password123",
        role="director",
    )
    assert register_director_resp.status_code == 201, register_director_resp.text
    director_code = register_director_resp.json()["director_code"]

    director_login_resp = login_director(client, email="director.attach@example.com", password="password123")
    director_token = director_login_resp.json()["access_token"]
    site_resp = create_site(client, director_token, "Attach Site")
    site_id = site_resp.json()["id"]

    invite_resp = client.get(f"/director/sites/{site_id}/worker-invite", headers=auth_headers(director_token))
    invite_token = invite_resp.json()["token"]

    register_worker_resp = client.post(
        "/public/sites/invitations/register",
        json={
            "token": invite_token,
            "full_name": "Worker Attached",
            "phone": "050-123-4567",
        },
    )
    assert register_worker_resp.status_code == 201, register_worker_resp.text
    assert register_worker_resp.json()["phone"] == "0501234567"

    worker_login_resp = client.post(
        "/auth/worker-login",
        json={
            "code": director_code,
            "phone": "0501234567",
            "invite_token": invite_token,
        },
    )
    assert worker_login_resp.status_code == 200, worker_login_resp.text
    worker_token = worker_login_resp.json()["access_token"]

    user = db_session.query(User).filter(User.phone == "0501234567").first()
    worker_row = (
        db_session.query(SiteWorker)
        .filter(SiteWorker.site_id == site_id, SiteWorker.user_id == user.id)
        .first()
    )
    assert worker_row is not None
    assert worker_row.name == "Worker Attached"
    assert worker_row.phone == "0501234567"
    assert worker_row.pending_approval is True

    worker_sites_resp = client.get("/public/sites/worker-sites", headers=auth_headers(worker_token))
    assert worker_sites_resp.status_code == 200, worker_sites_resp.text
    assert any(site["id"] == site_id for site in worker_sites_resp.json())


def test_director_can_approve_or_reject_pending_invited_worker(client, db_session):
    register_director_resp = register_user(
        client,
        email="director.pending@example.com",
        full_name="Director Pending",
        password="password123",
        role="director",
    )
    director_code = register_director_resp.json()["director_code"]
    director_login_resp = login_director(client, email="director.pending@example.com", password="password123")
    director_token = director_login_resp.json()["access_token"]
    site_resp = create_site(client, director_token, "Pending Site")
    site_id = site_resp.json()["id"]
    invite_token = client.get(f"/director/sites/{site_id}/worker-invite", headers=auth_headers(director_token)).json()["token"]

    client.post(
        "/public/sites/invitations/register",
        json={"token": invite_token, "full_name": "Pending Worker", "phone": "0509991111"},
    )
    worker_login_resp = client.post(
        "/auth/worker-login",
        json={"code": director_code, "phone": "0509991111", "invite_token": invite_token},
    )
    assert worker_login_resp.status_code == 200, worker_login_resp.text
    user = db_session.query(User).filter(User.phone == "0509991111").first()
    pending_row = db_session.query(SiteWorker).filter(SiteWorker.site_id == site_id, SiteWorker.user_id == user.id).first()
    assert pending_row is not None
    assert pending_row.pending_approval is True

    approve_resp = client.post(
        f"/director/sites/{site_id}/workers/{pending_row.id}/approve-invite",
        headers=auth_headers(director_token),
    )
    assert approve_resp.status_code == 200, approve_resp.text
    assert approve_resp.json()["pending_approval"] is False
    db_session.refresh(pending_row)
    assert pending_row.pending_approval is False

    second_invite_token = client.get(f"/director/sites/{site_id}/worker-invite", headers=auth_headers(director_token)).json()["token"]
    client.post(
        "/public/sites/invitations/register",
        json={"token": second_invite_token, "full_name": "Rejected Worker", "phone": "0509992222"},
    )
    client.post(
        "/auth/worker-login",
        json={"code": director_code, "phone": "0509992222", "invite_token": second_invite_token},
    )
    rejected_user = db_session.query(User).filter(User.phone == "0509992222").first()
    rejected_row = db_session.query(SiteWorker).filter(SiteWorker.site_id == site_id, SiteWorker.user_id == rejected_user.id).first()
    assert rejected_row is not None
    assert rejected_row.pending_approval is True

    reject_resp = client.delete(
        f"/director/sites/{site_id}/workers/{rejected_row.id}/reject-invite",
        headers=auth_headers(director_token),
    )
    assert reject_resp.status_code == 204, reject_resp.text
    assert db_session.query(SiteWorker).filter(SiteWorker.id == rejected_row.id).first() is None
    assert db_session.query(User).filter(User.id == rejected_user.id).first() is not None


def test_pending_workers_are_excluded_from_planning_generation(client):
    register_director_resp = register_user(
        client,
        email="director.generate@example.com",
        full_name="Director Generate",
        password="password123",
        role="director",
    )
    director_code = register_director_resp.json()["director_code"]
    director_login_resp = login_director(client, email="director.generate@example.com", password="password123")
    director_token = director_login_resp.json()["access_token"]
    site_resp = create_site(client, director_token, "Generation Site")
    site_id = site_resp.json()["id"]
    invite_token = client.get(f"/director/sites/{site_id}/worker-invite", headers=auth_headers(director_token)).json()["token"]

    client.post(
        "/public/sites/invitations/register",
        json={"token": invite_token, "full_name": "Pending Planner", "phone": "0501113333"},
    )
    login_resp = client.post(
        "/auth/worker-login",
        json={"code": director_code, "phone": "0501113333", "invite_token": invite_token},
    )
    assert login_resp.status_code == 200, login_resp.text

    workers_resp = client.get(f"/director/sites/{site_id}/workers", headers=auth_headers(director_token))
    assert workers_resp.status_code == 200, workers_resp.text
    assert len(workers_resp.json()) == 1
    assert workers_resp.json()[0]["pending_approval"] is True

    planning_resp = client.post(
        f"/director/sites/{site_id}/ai-generate",
        headers=auth_headers(director_token),
        json={"weekly_availability": {"Pending Planner": {"sun": ["06-14"]}}},
    )
    assert planning_resp.status_code == 200, planning_resp.text
    assert planning_resp.json()["status"] == "NO_WORKERS"


def test_pending_invited_workers_only_appear_from_registration_week(client, db_session):
    register_director_resp = register_user(
        client,
        email="director.weekfilter@example.com",
        full_name="Director Week Filter",
        password="password123",
        role="director",
    )
    director_code = register_director_resp.json()["director_code"]
    director_login_resp = login_director(client, email="director.weekfilter@example.com", password="password123")
    director_token = director_login_resp.json()["access_token"]
    site_resp = create_site(client, director_token, "Week Filter Site")
    site_id = site_resp.json()["id"]
    invite_token = client.get(f"/director/sites/{site_id}/worker-invite", headers=auth_headers(director_token)).json()["token"]

    client.post(
        "/public/sites/invitations/register",
        json={"token": invite_token, "full_name": "Week Pending", "phone": "0502224444"},
    )
    login_resp = client.post(
        "/auth/worker-login",
        json={"code": director_code, "phone": "0502224444", "invite_token": invite_token},
    )
    assert login_resp.status_code == 200, login_resp.text

    pending_user = db_session.query(User).filter(User.phone == "0502224444").first()
    pending_row = db_session.query(SiteWorker).filter(SiteWorker.site_id == site_id, SiteWorker.user_id == pending_user.id).first()
    assert pending_row is not None
    pending_row.created_at = 1744286400000  # 2025-04-10T12:00:00Z -> week 2025-04-06
    db_session.commit()

    previous_week_resp = client.get(
        f"/director/sites/{site_id}/workers?week=2025-03-30",
        headers=auth_headers(director_token),
    )
    assert previous_week_resp.status_code == 200, previous_week_resp.text
    assert previous_week_resp.json() == []

    registration_week_resp = client.get(
        f"/director/sites/{site_id}/workers?week=2025-04-06",
        headers=auth_headers(director_token),
    )
    assert registration_week_resp.status_code == 200, registration_week_resp.text
    assert len(registration_week_resp.json()) == 1
    assert registration_week_resp.json()[0]["pending_approval"] is True

from datetime import datetime, timedelta

from app.models import Site, SiteMessage, SiteWeekPlan
from app.sites.week_utils import _now_ms
from tests.test_worker_invites import auth_headers, clear_auth_cookies, create_site, login_director


def _week_start_iso() -> str:
    now = datetime.now()
    sunday = now - timedelta(days=(now.weekday() + 1) % 7)
    return sunday.date().isoformat()


def test_worker_home_aggregates_sites_plans_and_messages(client, db_session, create_director):
    create_director(email="director.home@example.com", full_name="Director Home")
    director_login = login_director(client, email="director.home@example.com", password="password123")
    director_token = director_login.json()["access_token"]
    site_resp = create_site(client, director_token, "Home Site")
    assert site_resp.status_code == 201, site_resp.text
    site_id = site_resp.json()["id"]

    invite_token = client.get(
        f"/director/sites/{site_id}/worker-invite",
        headers=auth_headers(director_token),
    ).json()["token"]
    register_resp = client.post(
        "/public/sites/invitations/register",
        json={
            "token": invite_token,
            "full_name": "Home Worker",
            "phone": "0507778888",
            "password": "workerpass123",
        },
    )
    assert register_resp.status_code == 201, register_resp.text

    site = db_session.query(Site).filter(Site.id == site_id).first()
    assert site is not None
    site.config = {
        "stations": [{"name": "עמדה 1", "uniformRoles": True, "shifts": [{"name": "06-14", "enabled": True}]}],
        "salary": {"enabled": False},
    }
    current_week = _week_start_iso()
    next_week = (datetime.fromisoformat(current_week) + timedelta(days=7)).date().isoformat()
    db_session.add(
        SiteWeekPlan(
            site_id=site_id,
            week_iso=current_week,
            scope="shared",
            updated_at=_now_ms(),
            data={
                "assignments": {"sun": {"06-14": [["Home Worker"]]}},
                "workers": [{"name": "Home Worker"}],
                "alternatives": [{"pad": "x"}],
                "pulls": {},
            },
        )
    )
    db_session.add(
        SiteWeekPlan(
            site_id=site_id,
            week_iso=current_week,
            scope="director",
            updated_at=_now_ms(),
            data={"assignments": {"sun": {"06-14": [["DRAFT"]]}}},
        )
    )
    db_session.add(
        SiteMessage(
            site_id=site_id,
            scope="week",
            text="שבוע נוכחי",
            created_week_iso=current_week,
            created_at=_now_ms(),
            updated_at=_now_ms(),
        )
    )
    db_session.add(
        SiteMessage(
            site_id=site_id,
            scope="global",
            text="הודעה כללית",
            created_week_iso=current_week,
            created_at=_now_ms(),
            updated_at=_now_ms(),
        )
    )
    db_session.commit()

    clear_auth_cookies(client)
    worker_login = client.post(
        "/auth/worker-login",
        json={"phone": "0507778888", "password": "workerpass123"},
    )
    assert worker_login.status_code == 200, worker_login.text
    worker_token = worker_login.json()["access_token"]
    headers = auth_headers(worker_token)

    home = client.get(
        f"/public/sites/worker-home?current_week={current_week}&next_week={next_week}",
        headers=headers,
    )
    assert home.status_code == 200, home.text
    sites = home.json().get("sites") or []
    assert len(sites) == 1
    row = sites[0]
    assert row["id"] == site_id
    assert row["name"] == "Home Site"
    assert row["config"]["stations"][0]["name"] == "עמדה 1"
    assert row["current_week_plan"]["assignments"]["sun"]["06-14"] == [["Home Worker"]]
    assert row["current_week_plan"].get("_alts_omitted") is True
    assert "alternatives" not in row["current_week_plan"]
    assert row["next_week_plan"] is None
    current_texts = [m["text"] for m in row["messages_current"]]
    next_texts = [m["text"] for m in row["messages_next"]]
    assert "שבוע נוכחי" in current_texts
    assert "הודעה כללית" in current_texts
    assert "שבוע נוכחי" not in next_texts
    assert "הודעה כללית" in next_texts

    published = client.get(
        f"/public/sites/{site_id}/week-plan?week={current_week}",
        headers=headers,
    )
    assert published.status_code == 200, published.text
    assert published.json()["assignments"] == row["current_week_plan"]["assignments"]

    messages_current = client.get(
        f"/public/sites/{site_id}/messages?week={current_week}",
        headers=headers,
    )
    assert messages_current.status_code == 200, messages_current.text
    assert [m["text"] for m in messages_current.json()] == current_texts

    clear_auth_cookies(client)
    director_home = client.get(
        f"/public/sites/worker-home?current_week={current_week}&next_week={next_week}",
        headers=auth_headers(director_token),
    )
    assert director_home.status_code == 403

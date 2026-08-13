"""Compteur workers_count sur la liste des sites — filtré par semaine (pas le total historique)."""

from datetime import datetime, timedelta

from sqlalchemy.orm.attributes import flag_modified

from app.models import Site, SiteWorker
from app.sites import _next_week_iso, _week_start_date
from app.sites.site_config import _list_site_public_config
from app.sites.week_utils import _answers_payload_for_week


def test_answers_payload_for_week_keeps_only_requested_week():
    week = "2026-05-10"
    other = "2026-05-17"
    full = {
        week: {"general": {"q1": "a"}, "_shift_kind_prefs": {"morning": 1, "noon": 0, "night": 0}},
        other: {"general": {"q1": "b"}},
    }
    sliced = _answers_payload_for_week(full, week)
    assert week in sliced
    assert other not in sliced
    assert sliced[week]["general"]["q1"] == "a"
    assert _answers_payload_for_week(full, "2026-05-24") == {}
    legacy = {"general": {"q1": "x"}, "perDay": {}}
    assert _answers_payload_for_week(legacy, week) == legacy
    assert _answers_payload_for_week(full, None) == full


def test_list_site_public_config_keeps_only_last_run():
    assert _list_site_public_config(None) == {}
    assert _list_site_public_config({"stations": [{"name": "A"}], "questions": []}) == {}
    last_run = {"week_iso": "2026-05-10", "complete": True}
    assert _list_site_public_config({
        "stations": [{"name": "A"}],
        "autoPlanningLastRun": last_run,
    }) == {"autoPlanningLastRun": last_run}


def auth_headers(token: str):
    return {"Authorization": f"Bearer {token}"}


def login_director(client, *, email: str, password: str):
    return client.post("/auth/login", json={"email": email, "password": password})


def create_site(client, token: str, name: str):
    return client.post(
        "/director/sites/",
        json={"name": name, "config": {}},
        headers=auth_headers(token),
    )


def add_worker(client, token: str, site_id: int, name: str):
    return client.post(
        f"/director/sites/{site_id}/workers",
        json={"name": name, "max_shifts": 5, "roles": [], "availability": {}, "answers": {}},
        headers=auth_headers(token),
    )


def test_list_sites_workers_count_uses_next_week_not_historical_total(client, db_session, create_director):
    create_director(email="director.count@example.com", full_name="Director Count")
    login_resp = login_director(client, email="director.count@example.com", password="password123")
    token = login_resp.json()["access_token"]

    site_resp = create_site(client, token, "Count Site")
    assert site_resp.status_code == 201, site_resp.text
    site_id = site_resp.json()["id"]

    for name in ("Alpha", "Beta", "Gamma"):
        w_resp = add_worker(client, token, site_id, name)
        assert w_resp.status_code == 201, w_resp.text

    next_week = _next_week_iso(datetime.now())
    current_week = _week_start_date(datetime.now()).date().isoformat()
    # Gamma part après la semaine suivante → encore compté pour next_week
    week_after_next = (datetime.fromisoformat(next_week).date() + timedelta(days=7)).isoformat()

    leaving = db_session.query(SiteWorker).filter(SiteWorker.site_id == site_id, SiteWorker.name == "Gamma").first()
    assert leaving is not None
    leaving.removed_from_week_iso = week_after_next
    db_session.commit()

    already_gone = db_session.query(SiteWorker).filter(SiteWorker.site_id == site_id, SiteWorker.name == "Alpha").first()
    assert already_gone is not None
    already_gone.removed_from_week_iso = current_week
    db_session.commit()

    list_resp = client.get("/director/sites/", headers=auth_headers(token))
    assert list_resp.status_code == 200, list_resp.text
    site_row = next(row for row in list_resp.json() if row["id"] == site_id)

    # Beta + Gamma (Alpha déjà retiré depuis current_week)
    assert site_row["workers_count"] == 2
    assert db_session.query(SiteWorker).filter(SiteWorker.site_id == site_id).count() == 3


def test_list_sites_returns_lite_config_without_stations(client, db_session, create_director):
    create_director(email="director.lite@example.com", full_name="Director Lite")
    login_resp = login_director(client, email="director.lite@example.com", password="password123")
    token = login_resp.json()["access_token"]

    site_resp = create_site(client, token, "Lite Site")
    assert site_resp.status_code == 201, site_resp.text
    site_id = site_resp.json()["id"]

    site = db_session.query(Site).filter(Site.id == site_id).first()
    assert site is not None
    site.config = {
        "stations": [{"name": "A", "workers": 1, "shifts": []}],
        "questions": [{"id": "q1"}],
        "autoPlanningLastRun": {
            "week_iso": "2026-05-10",
            "ran_at": 1,
            "source": "auto",
            "complete": True,
            "assigned_count": 3,
            "required_count": 3,
        },
    }
    flag_modified(site, "config")
    db_session.commit()

    list_resp = client.get("/director/sites/", headers=auth_headers(token))
    assert list_resp.status_code == 200, list_resp.text
    site_row = next(row for row in list_resp.json() if row["id"] == site_id)
    cfg = site_row.get("config") or {}
    assert "stations" not in cfg
    assert "questions" not in cfg
    assert cfg.get("autoPlanningLastRun", {}).get("week_iso") == "2026-05-10"

    detail_resp = client.get(f"/director/sites/{site_id}", headers=auth_headers(token))
    assert detail_resp.status_code == 200, detail_resp.text
    detail_cfg = detail_resp.json().get("config") or {}
    assert "stations" in detail_cfg
    assert detail_cfg.get("autoPlanningLastRun", {}).get("week_iso") == "2026-05-10"


def test_list_sites_plan_status_does_not_need_alternatives_blob(client, db_session, create_director):
    from app.models import SiteWeekPlan
    from app.sites.week_utils import _now_ms

    create_director(email="director.plans@example.com", full_name="Director Plans")
    login_resp = login_director(client, email="director.plans@example.com", password="password123")
    token = login_resp.json()["access_token"]

    site_resp = create_site(client, token, "Plan Site")
    assert site_resp.status_code == 201, site_resp.text
    site_id = site_resp.json()["id"]

    site = db_session.query(Site).filter(Site.id == site_id).first()
    assert site is not None
    days = {dk: True for dk in ("sun", "mon", "tue", "wed", "thu", "fri", "sat")}
    site.config = {
        "stations": [
            {
                "name": "A",
                "workers": 1,
                "uniformRoles": True,
                "perDayCustom": False,
                "days": days,
                "shifts": [
                    {"name": "בוקר", "enabled": True, "hours": "06:00-14:00"},
                    {"name": "צהריים", "enabled": True, "hours": "14:00-22:00"},
                    {"name": "לילה", "enabled": True, "hours": "22:00-06:00"},
                ],
                "roles": [],
            }
        ]
    }
    flag_modified(site, "config")
    next_week = _next_week_iso(datetime.now())
    db_session.add(
        SiteWeekPlan(
            site_id=site_id,
            week_iso=next_week,
            scope="director",
            updated_at=_now_ms(),
            data={
                "assignments": {
                    "sun": {"בוקר": [["A"]], "צהריים": [["B"]], "לילה": [["C"]]},
                },
                "pulls": {"sun|צהריים|0|1": {"before": {"name": "A"}, "after": {"name": "C"}}},
                "alternatives": [{"pad": "x" * 1000} for _ in range(80)],
                "workers": [{"name": "A", "answers": {"q": "y" * 500}}],
            },
        )
    )
    db_session.commit()

    list_resp = client.get("/director/sites/", headers=auth_headers(token))
    assert list_resp.status_code == 200, list_resp.text
    site_row = next(row for row in list_resp.json() if row["id"] == site_id)
    status = site_row.get("next_week_saved_plan_status") or {}
    assert status.get("exists") is True
    assert status.get("scope") == "director"
    assert status.get("week_iso") == next_week
    assert int(status.get("assigned_count") or 0) == 2
    assert int(status.get("required_count") or 0) == 21
    assert int(status.get("pulls_count") or 0) == 1

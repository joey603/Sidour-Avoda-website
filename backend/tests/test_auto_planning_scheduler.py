from datetime import datetime, timedelta

from app.models import DirectorAutoPlanningConfig
from app.sites import _now_ms, compute_auto_planning_scheduler_sleep_seconds


def test_scheduler_sleep_idle_when_no_enabled_config(db_session):
    sleep = compute_auto_planning_scheduler_sleep_seconds(
        db_session,
        idle_recheck_seconds=3600,
        now=datetime(2026, 6, 21, 12, 0, 0),
    )
    assert sleep == 3600


def test_scheduler_sleep_zero_when_run_is_due(db_session):
    now = datetime(2026, 6, 21, 10, 0, 0)
    db_session.add(
        DirectorAutoPlanningConfig(
            director_id=1,
            enabled=True,
            day_of_week=0,
            hour=9,
            minute=0,
            updated_at=_now_ms(),
        )
    )
    db_session.commit()

    sleep = compute_auto_planning_scheduler_sleep_seconds(
        db_session,
        idle_recheck_seconds=3600,
        now=now,
    )
    assert sleep == 0


def test_scheduler_sleep_until_next_slot(db_session):
    now = datetime(2026, 6, 21, 8, 0, 0)
    db_session.add(
        DirectorAutoPlanningConfig(
            director_id=1,
            enabled=True,
            day_of_week=0,
            hour=9,
            minute=0,
            updated_at=_now_ms(),
        )
    )
    db_session.commit()

    sleep = compute_auto_planning_scheduler_sleep_seconds(
        db_session,
        idle_recheck_seconds=3600,
        now=now,
    )
    assert sleep == 3600

"""Tests de contrat et de régression pour solve_schedule_stream."""

from __future__ import annotations

from copy import deepcopy

import pytest
from ortools.sat.python import cp_model

from app.ai_solver import solve_schedule, solve_schedule_stream
from tests.ai_solver_fixtures import (
    assignments_signature,
    collect_stream_events,
    count_assigned_names,
    minimal_station_config,
    worker,
)


def test_stream_yields_base_then_done_for_feasible_case():
    config = minimal_station_config(workers=1)
    workers = [worker("Alice", availability={"sun": ["06-14"]})]

    events = collect_stream_events(
        solve_schedule_stream(
            config,
            workers,
            time_limit_seconds=5,
            num_alternatives=0,
        )
    )

    types = [e.get("type") for e in events]
    assert "base" in types
    assert types[-1] == "done"
    base = next(e for e in events if e.get("type") == "base")
    assert base.get("assignments")
    assert "Alice" in base["assignments"]["sun"]["06-14"][0]


def test_stream_event_types_are_known():
    config = minimal_station_config(workers=1)
    workers = [worker("Alice", availability={"sun": ["06-14"]})]
    allowed = {"base", "alternative", "done", "status"}

    events = collect_stream_events(
        solve_schedule_stream(config, workers, time_limit_seconds=5, num_alternatives=1)
    )
    assert all(str(e.get("type") or "") in allowed for e in events)


def test_stream_infeasible_yields_status_and_done(monkeypatch):
    config = minimal_station_config(workers=1)
    workers = [worker("Alice", availability={"sun": ["06-14"]})]

    def fake_solve(_self, _model):
        return cp_model.INFEASIBLE

    monkeypatch.setattr(cp_model.CpSolver, "Solve", fake_solve)

    events = collect_stream_events(
        solve_schedule_stream(config, workers, time_limit_seconds=1, num_alternatives=0)
    )
    assert any(e.get("type") == "status" for e in events)
    assert events[-1]["type"] == "done"
    assert not any(e.get("type") == "base" for e in events)


def test_stream_respects_fixed_assignments():
    config = minimal_station_config(workers=1)
    workers = [
        worker("Alice", worker_id=1, availability={"sun": ["06-14"]}),
        worker("Bob", worker_id=2, availability={"sun": ["06-14"]}),
    ]
    fixed = {"sun": {"06-14": [["Bob"]]}}

    events = collect_stream_events(
        solve_schedule_stream(
            config,
            workers,
            time_limit_seconds=5,
            num_alternatives=0,
            fixed_assignments=deepcopy(fixed),
        )
    )
    base = next(e for e in events if e.get("type") == "base")
    assert "Bob" in base["assignments"]["sun"]["06-14"][0]


def test_stream_respects_availability():
    config = minimal_station_config(workers=1, days={"sun": True, "mon": True}, shift_names=["06-14"])
    workers = [worker("Alice", availability={"sun": ["06-14"]})]

    events = collect_stream_events(
        solve_schedule_stream(config, workers, time_limit_seconds=5, num_alternatives=0)
    )
    base = next(e for e in events if e.get("type") == "base")
    assert count_assigned_names(base["assignments"]) == 1
    assert "Alice" in base["assignments"]["sun"]["06-14"][0]
    assert base["assignments"]["mon"]["06-14"][0] == []


def test_stream_max_nights_per_worker():
    config = minimal_station_config(
        workers=1,
        days={"sun": True, "mon": True},
        shift_names=["22-06"],
    )
    workers = [
        worker(
            "NightOwl",
            availability={"sun": ["22-06"], "mon": ["22-06"]},
        )
    ]

    events = collect_stream_events(
        solve_schedule_stream(
            config,
            workers,
            time_limit_seconds=5,
            max_nights_per_worker=1,
            num_alternatives=0,
        )
    )
    base = next(e for e in events if e.get("type") == "base")
    night_count = 0
    for day_map in base["assignments"].values():
        for per_station in day_map.get("22-06", []):
            night_count += len([nm for nm in per_station if str(nm or "").strip()])
    assert night_count <= 1


def test_stream_exclude_days_zeroes_requirements():
    config = minimal_station_config(workers=1)
    workers = [worker("Alice", availability={"sun": ["06-14"]})]

    events = collect_stream_events(
        solve_schedule_stream(
            config,
            workers,
            time_limit_seconds=5,
            num_alternatives=0,
            exclude_days=["sun"],
        )
    )
    base = next(e for e in events if e.get("type") == "base")
    assert count_assigned_names(base["assignments"]) == 0


def test_stream_can_emit_alternatives_with_swap_budget():
    config = minimal_station_config(
        workers=1,
        days={"sun": True},
        shift_names=["06-14", "14-22"],
    )
    workers = [
        worker("Alice", worker_id=1, availability={"sun": ["06-14", "14-22"]}),
        worker("Bob", worker_id=2, availability={"sun": ["06-14", "14-22"]}),
    ]

    events = collect_stream_events(
        solve_schedule_stream(
            config,
            workers,
            time_limit_seconds=15,
            num_alternatives=3,
        )
    )
    alternatives = [e for e in events if e.get("type") == "alternative"]
    assert events[-1]["type"] == "done"
    assert len(alternatives) >= 1
    for alt in alternatives:
        assert count_assigned_names(alt.get("assignments")) == 2


def test_stream_sync_parity_on_assigned_signature():
    """Même entrées : le plan de base stream doit couvrir les mêmes affectations que le sync."""
    config = minimal_station_config(workers=2)
    workers = [
        worker("Alice", worker_id=1, availability={"sun": ["06-14"]}),
        worker("Bob", worker_id=2, availability={"sun": ["06-14"]}),
    ]
    fixed = {"sun": {"06-14": [["Alice"]]}}

    sync = solve_schedule(
        config,
        workers,
        time_limit_seconds=8,
        num_alternatives=0,
        fixed_assignments=deepcopy(fixed),
    )
    stream_events = collect_stream_events(
        solve_schedule_stream(
            config,
            workers,
            time_limit_seconds=8,
            num_alternatives=0,
            fixed_assignments=deepcopy(fixed),
        )
    )
    base = next(e for e in stream_events if e.get("type") == "base")

    assert sync["status"] in ("OPTIMAL", "FEASIBLE")
    assert assignments_signature(sync["assignments"]) == assignments_signature(base["assignments"])
    assert count_assigned_names(sync["assignments"]) == count_assigned_names(base["assignments"])


def test_stream_random_seed_is_deterministic_for_base():
    config = minimal_station_config(workers=2)
    workers = [
        worker("Alice", worker_id=1, availability={"sun": ["06-14"]}),
        worker("Bob", worker_id=2, availability={"sun": ["06-14"]}),
    ]
    kwargs = dict(
        config=config,
        workers=workers,
        time_limit_seconds=8,
        num_alternatives=0,
        random_seed=4242,
    )

    sig_a = assignments_signature(
        next(e for e in collect_stream_events(solve_schedule_stream(**kwargs)) if e.get("type") == "base")[
            "assignments"
        ]
    )
    sig_b = assignments_signature(
        next(e for e in collect_stream_events(solve_schedule_stream(**kwargs)) if e.get("type") == "base")[
            "assignments"
        ]
    )
    assert sig_a == sig_b

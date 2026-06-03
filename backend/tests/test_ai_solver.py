"""Tests unitaires pour ai_solver : config, post-traitement, et petits cas CP-SAT."""

from copy import deepcopy

import pytest
from ortools.sat.python import cp_model

from app.ai_solver import (
    build_capacities_from_config,
    enforce_max_shifts_on_plan,
    finalize_candidate_plan,
    next_day,
    order_days,
    order_shifts,
    sanitize_plan,
    solve_schedule,
)


def test_order_days_standard_week_order():
    assert order_days(["wed", "sun", "mon"]) == ["sun", "mon", "wed"]


def test_order_shifts_groups_morning_noon_night_heuristics():
    names = ["22-06", "06-14", "14-22", "custom"]
    ordered = order_shifts(names)
    assert ordered[:3] == ["06-14", "14-22", "22-06"]
    assert "custom" in ordered


def test_next_day_saturday_to_none():
    assert next_day("sat") is None
    assert next_day("fri") == "sat"


def test_build_capacities_uniform_station_single_shift():
    config = {
        "stations": [
            {
                "name": "Poste A",
                "perDayCustom": False,
                "uniformRoles": True,
                "workers": 2,
                "days": {"sun": True, "mon": False},
                "shifts": [{"name": "06-14", "enabled": True}],
                "roles": [],
            }
        ]
    }
    days, shifts, stations = build_capacities_from_config(config)
    assert days == ["sun"]
    assert "06-14" in shifts
    st0 = stations[0]
    assert st0["capacity"]["sun"]["06-14"] == 2


def test_build_capacities_exclude_days_zeroes_requirements():
    config = {
        "stations": [
            {
                "name": "Poste A",
                "perDayCustom": False,
                "uniformRoles": True,
                "workers": 3,
                "days": {"sun": True},
                "shifts": [{"name": "06-14", "enabled": True}],
                "roles": [],
            }
        ]
    }
    days, shifts, stations = build_capacities_from_config(config, exclude_days=["sun"])
    assert stations[0]["capacity"]["sun"]["06-14"] == 0


def test_sanitize_plan_deduplicates_and_trims_to_capacity():
    days = ["sun"]
    shifts = ["06-14"]
    stations = [
        {
            "name": "S1",
            "capacity": {"sun": {"06-14": 2}},
            "capacity_roles": {},
        }
    ]
    assignments = {"sun": {"06-14": [["alice", "alice", "bob", "carol"]]}}
    sanitize_plan(assignments, days, shifts, stations)
    assert assignments["sun"]["06-14"][0] == ["alice", "bob"]


def test_enforce_max_shifts_on_plan_removes_extras_in_scan_order():
    workers = [{"name": "alice", "max_shifts": 1}]
    assignments = {
        "sun": {"06-14": [["alice"], ["alice"]]},
    }
    enforce_max_shifts_on_plan(assignments, workers, label="test")
    assert assignments["sun"]["06-14"][0] == ["alice"]
    assert assignments["sun"]["06-14"][1] == []


def test_finalize_candidate_plan_applies_max_shifts_then_sanitize():
    days = ["sun"]
    shifts = ["06-14"]
    stations = [
        {"name": "S1", "capacity": {"sun": {"06-14": 1}}, "capacity_roles": {}},
    ]
    workers = [{"name": "alice", "max_shifts": 1}]
    assignments = {"sun": {"06-14": [["alice", "alice"]]}}
    finalize_candidate_plan(assignments, workers, days, shifts, stations, label="ut")
    assert assignments["sun"]["06-14"][0] == ["alice"]


def test_solve_schedule_fills_one_slot_when_feasible():
    config = {
        "stations": [
            {
                "name": "Poste A",
                "perDayCustom": False,
                "uniformRoles": True,
                "workers": 1,
                "days": {"sun": True},
                "shifts": [{"name": "06-14", "enabled": True}],
                "roles": [],
            }
        ]
    }
    workers = [
        {
            "id": 1,
            "name": "Alice",
            "max_shifts": 5,
            "roles": [],
            "availability": {"sun": ["06-14"]},
        }
    ]
    result = solve_schedule(
        config,
        workers,
        time_limit_seconds=5,
        num_alternatives=0,
    )
    assert result["status"] in ("OPTIMAL", "FEASIBLE")
    cell = result["assignments"]["sun"]["06-14"][0]
    assert "Alice" in cell


def test_solve_schedule_respects_role_requirement_on_shift():
    config = {
        "stations": [
            {
                "name": "Poste A",
                "perDayCustom": False,
                "uniformRoles": False,
                "workers": 0,
                "days": {"sun": True},
                "shifts": [
                    {
                        "name": "06-14",
                        "enabled": True,
                        "workers": 1,
                        "roles": [{"name": "מנהל", "enabled": True, "count": 1}],
                    }
                ],
                "roles": [],
            }
        ]
    }
    wrong = [
        {
            "id": 1,
            "name": "Bob",
            "max_shifts": 5,
            "roles": [],
            "availability": {"sun": ["06-14"]},
        }
    ]
    ok = [deepcopy(wrong[0]) | {"name": "Carol", "id": 2, "roles": ["מנהל"]}]

    out_wrong = solve_schedule(config, wrong, time_limit_seconds=5, num_alternatives=0)
    assert out_wrong["assignments"]["sun"]["06-14"][0] == []

    out_ok = solve_schedule(config, ok, time_limit_seconds=5, num_alternatives=0)
    assert out_ok["status"] in ("OPTIMAL", "FEASIBLE")
    assert "Carol" in out_ok["assignments"]["sun"]["06-14"][0]


def test_solve_schedule_returns_status_string_on_infeasible_model(monkeypatch):
    """Si le solveur renvoie INFEASIBLE, la réponse contient un statut explicite et une grille vide de besoins."""

    config = {
        "stations": [
            {
                "name": "Poste A",
                "perDayCustom": False,
                "uniformRoles": True,
                "workers": 1,
                "days": {"sun": True},
                "shifts": [{"name": "06-14", "enabled": True}],
                "roles": [],
            }
        ]
    }
    workers = [
        {
            "id": 1,
            "name": "Alice",
            "max_shifts": 5,
            "roles": [],
            "availability": {"sun": ["06-14"]},
        }
    ]

    def fake_solve(_self, _model):
        return cp_model.INFEASIBLE

    monkeypatch.setattr(cp_model.CpSolver, "Solve", fake_solve)

    result = solve_schedule(config, workers, time_limit_seconds=1, num_alternatives=0)
    assert result["status"] == str(cp_model.INFEASIBLE)
    assert result["assignments"]["sun"]["06-14"][0] == []

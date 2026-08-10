"""Fixtures légères partagées pour les tests ai_solver (sync + stream)."""

from __future__ import annotations

from copy import deepcopy
from typing import Any


def minimal_station_config(
    *,
    workers: int = 1,
    days: dict[str, bool] | None = None,
    shift_names: list[str] | None = None,
    station_name: str = "Poste A",
) -> dict[str, Any]:
    return {
        "stations": [
            {
                "name": station_name,
                "perDayCustom": False,
                "uniformRoles": True,
                "workers": workers,
                "days": days or {"sun": True},
                "shifts": [
                    {"name": name, "enabled": True}
                    for name in (shift_names or ["06-14"])
                ],
                "roles": [],
            }
        ]
    }


def worker(
    name: str,
    *,
    worker_id: int = 1,
    max_shifts: int = 5,
    roles: list[str] | None = None,
    availability: dict[str, list[str]] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": worker_id,
        "name": name,
        "max_shifts": max_shifts,
        "roles": roles or [],
        "availability": availability or {"sun": ["06-14"]},
    }
    payload.update(extra)
    return payload


def count_assigned_names(assignments: dict[str, dict[str, list[list[str]]]] | None) -> int:
    total = 0
    for shifts_map in (assignments or {}).values():
        for per_station in shifts_map.values():
            for cell in per_station:
                total += len([nm for nm in cell if str(nm or "").strip()])
    return total


def assignments_signature(assignments: dict[str, dict[str, list[list[str]]]] | None) -> frozenset[tuple[str, str, int, str]]:
    """Signature stable (jour, shift, station, nom) pour comparer deux plans."""
    sig: set[tuple[str, str, int, str]] = set()
    for day_key, shifts_map in (assignments or {}).items():
        for shift_name, per_station in shifts_map.items():
            for station_idx, cell in enumerate(per_station):
                for nm in cell:
                    name = str(nm or "").strip()
                    if name:
                        sig.add((day_key, shift_name, station_idx, name))
    return frozenset(sig)


def collect_stream_events(gen) -> list[dict]:
    return list(gen)

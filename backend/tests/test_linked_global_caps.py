from app.models import Site, SiteWorker
from app.sites import _enforce_linked_global_caps_on_site_plans


def _build_assignments(count: int) -> dict:
    day_shift_slots = [
        ("sun", "06-14"),
        ("sun", "14-22"),
        ("mon", "06-14"),
        ("mon", "14-22"),
    ]
    assignments: dict[str, dict[str, list[list[str]]]] = {}
    for idx in range(count):
        day_key, shift_name = day_shift_slots[idx]
        assignments.setdefault(day_key, {})
        assignments[day_key][shift_name] = [["test1"]]
    return assignments


def _count_assignments(assignments: dict) -> int:
    total = 0
    for shifts_map in assignments.values():
        for per_station in shifts_map.values():
            for cell in per_station:
                total += len([name for name in cell if str(name or "").strip()])
    return total


def test_linked_global_caps_trim_final_multi_site_payloads_and_refresh_counts(db_session, create_director):
    director = create_director(email="linked.caps@example.com", full_name="Linked Caps")
    sites = []
    for idx in range(3):
        site = Site(name=f"Linked {idx + 1}", director_id=director.id, config={})
        db_session.add(site)
        db_session.flush()
        sites.append(site)
        db_session.add(
            SiteWorker(
                site_id=site.id,
                name="test1",
                phone="0509990000",
                max_shifts=5,
                roles=[],
                availability={},
                answers={},
            )
        )
    db_session.commit()

    site_plans = {
        str(sites[0].id): {
            "assignments": _build_assignments(2),
            "alternatives": [_build_assignments(3)],
            "pulls": {},
            "alternative_pulls": [{}],
            "assigned_count": 99,
        },
        str(sites[1].id): {
            "assignments": _build_assignments(2),
            "alternatives": [_build_assignments(1)],
            "pulls": {},
            "alternative_pulls": [{}],
            "assigned_count": 99,
        },
        str(sites[2].id): {
            "assignments": _build_assignments(2),
            "alternatives": [_build_assignments(2)],
            "pulls": {},
            "alternative_pulls": [{}],
            "assigned_count": 99,
        },
    }

    normalized = _enforce_linked_global_caps_on_site_plans(
        db_session,
        [int(site.id) for site in sites],
        "2026-05-10",
        site_plans,
    )

    base_total = sum(_count_assignments(site_plan["assignments"]) for site_plan in normalized.values())
    alt_total = sum(_count_assignments((site_plan.get("alternatives") or [{}])[0]) for site_plan in normalized.values())

    assert base_total == 5
    assert alt_total == 5
    assert sum(int(site_plan.get("assigned_count") or 0) for site_plan in normalized.values()) == 5

"""Priorité des משיכות צהריים à la création auto."""

from __future__ import annotations

from types import SimpleNamespace

from app.sites.pulls import _apply_auto_pulls_to_payload, _noon_pulls_count


def _site_config_three_shifts(days: list[str] | None = None) -> dict:
    day_keys = days or ["sun", "mon"]
    return {
        "stations": [
            {
                "name": "Poste A",
                "perDayCustom": False,
                "uniformRoles": True,
                "workers": 1,
                "days": {dk: True for dk in day_keys},
                "shifts": [
                    {"name": "בוקר", "enabled": True, "hours": "06:00-14:00"},
                    {"name": "צהריים", "enabled": True, "hours": "14:00-22:00"},
                    {"name": "לילה", "enabled": True, "hours": "22:00-06:00"},
                ],
                "roles": [],
            }
        ]
    }


def _workers(*names: str) -> list[SimpleNamespace]:
    return [SimpleNamespace(name=nm, roles=[]) for nm in names]


def test_skips_night_pull_while_noon_hole_remains():
    """Ne pas créer de משיכה לילה tant qu'un צהריים reste vide."""
    site = SimpleNamespace(config=_site_config_three_shifts(["sun", "mon"]))
    # sun לילה pullable (Hanna midi + Orel lendemain matin), mais mon צהריים encore vide.
    assignments = {
        "sun": {
            "בוקר": [["Extra"]],
            "צהריים": [["Hanna"]],
            "לילה": [[]],
        },
        "mon": {
            "בוקר": [["Orel"]],
            "צהריים": [[]],
            "לילה": [[]],
        },
    }
    payload = _apply_auto_pulls_to_payload(
        site,
        _workers("Hanna", "Orel", "Extra"),
        {"assignments": assignments, "pulls": {}},
        pulls_limit=None,
        pulls_prefer=["noon"],
    )
    pulls = payload.get("pulls") or {}
    assert _noon_pulls_count(pulls) == 0
    assert not any("לילה" in str(k) for k in pulls), pulls
    assert payload["assignments"]["sun"]["לילה"] == [[]]


def test_creates_noon_pull_before_night_when_noon_fillable():
    site = SimpleNamespace(config=_site_config_three_shifts(["sun", "mon"]))
    # sun צהריים vide, pullable: Hanna sun בוקר + Orel sun לילה
    assignments = {
        "sun": {
            "בוקר": [["Hanna"]],
            "צהריים": [[]],
            "לילה": [["Orel"]],
        },
        "mon": {
            "בוקר": [["Extra"]],
            "צהריים": [[]],
            "לילה": [[]],
        },
    }
    payload = _apply_auto_pulls_to_payload(
        site,
        _workers("Hanna", "Orel", "Extra"),
        {"assignments": assignments, "pulls": {}},
        pulls_limit=1,
        pulls_prefer=["noon"],
    )
    pulls = payload.get("pulls") or {}
    assert len(pulls) == 1
    assert _noon_pulls_count(pulls) == 1
    assert any("צהריים" in str(k) for k in pulls)


def test_allows_night_pull_when_no_noon_holes():
    site = SimpleNamespace(config=_site_config_three_shifts(["sun", "mon"]))
    assignments = {
        "sun": {
            "בוקר": [["A"]],
            "צהריים": [["Hanna"]],
            "לילה": [[]],
        },
        "mon": {
            "בוקר": [["Orel"]],
            "צהריים": [["B"]],
            "לילה": [["C"]],
        },
    }
    payload = _apply_auto_pulls_to_payload(
        site,
        _workers("A", "Hanna", "Orel", "B", "C"),
        {"assignments": assignments, "pulls": {}},
        pulls_limit=None,
    )
    pulls = payload.get("pulls") or {}
    assert any("לילה" in str(k) for k in pulls), pulls


def test_sort_key_prefers_more_pulls_when_holes_equal():
    from app.sites.auto_planning import _single_site_candidate_sort_key

    site = SimpleNamespace(config=_site_config_three_shifts(["sun", "mon"]))
    asg: dict = {}
    one = {"sun|צהריים|0|1": {"before": {"name": "Hanna"}, "after": {"name": "Orel"}}}
    two = {
        "sun|צהריים|0|1": {"before": {"name": "Hanna"}, "after": {"name": "Orel"}},
        "mon|צהריים|0|1": {"before": {"name": "A"}, "after": {"name": "B"}},
    }
    k1 = _single_site_candidate_sort_key(site, asg, "2026-W33", one)
    k2 = _single_site_candidate_sort_key(site, asg, "2026-W33", two)
    assert k2 < k1, (k1, k2)


def test_sort_key_prefers_morning_pulls_when_requested():
    from app.sites.auto_planning import _single_site_candidate_sort_key

    site = SimpleNamespace(config=_site_config_three_shifts(["sun", "mon"]))
    asg: dict = {}
    morning = {"sun|בוקר|0|1": {"before": {"name": "Hanna"}, "after": {"name": "Orel"}}}
    night = {
        "sun|לילה|0|1": {"before": {"name": "Hanna"}, "after": {"name": "Orel"}},
        "mon|לילה|0|1": {"before": {"name": "A"}, "after": {"name": "B"}},
    }
    k_morning = _single_site_candidate_sort_key(site, asg, "2026-W33", morning, ["morning"])
    k_night = _single_site_candidate_sort_key(site, asg, "2026-W33", night, ["morning"])
    assert k_morning < k_night, (k_morning, k_night)


def test_hold_until_two_pulls_when_holes_remain():
    from app.sites.auto_planning import _should_hold_plan_until_pull_target

    site = SimpleNamespace(config=_site_config_three_shifts(["sun"]))
    empty = {"sun": {"בוקר": [[]], "צהריים": [[]], "לילה": [[]]}}
    one = {"sun|צהריים|0|1": {"before": {"name": "Hanna"}, "after": {"name": "Orel"}}}
    two = {
        "sun|צהריים|0|1": {"before": {"name": "Hanna"}, "after": {"name": "Orel"}},
        "sun|לילה|0|1": {"before": {"name": "A"}, "after": {"name": "B"}},
    }
    assert _should_hold_plan_until_pull_target(site, empty, "2026-08-16", {}, 2) is True
    assert _should_hold_plan_until_pull_target(site, empty, "2026-08-16", one, 2) is True
    assert _should_hold_plan_until_pull_target(site, empty, "2026-08-16", two, 2) is False
    night_two = {
        "sun|לילה|0|1": {"before": {"name": "A"}, "after": {"name": "B"}},
        "sun|לילה|0|2": {"before": {"name": "C"}, "after": {"name": "D"}},
    }
    assert _should_hold_plan_until_pull_target(site, empty, "2026-08-16", night_two, 2, ["morning"]) is True
    morning_two = {
        "sun|בוקר|0|1": {"before": {"name": "A"}, "after": {"name": "B"}},
        "sun|בוקר|0|2": {"before": {"name": "C"}, "after": {"name": "D"}},
    }
    assert _should_hold_plan_until_pull_target(site, empty, "2026-08-16", morning_two, 2, ["morning"]) is False


def test_mix_allows_night_pull_while_noon_hole_remains():
    site = SimpleNamespace(config=_site_config_three_shifts(["sun", "mon"]))
    assignments = {
        "sun": {
            "בוקר": [["Extra"]],
            "צהריים": [["Hanna"]],
            "לילה": [[]],
        },
        "mon": {
            "בוקר": [["Orel"]],
            "צהריים": [[]],
            "לילה": [[]],
        },
    }
    payload = _apply_auto_pulls_to_payload(
        site,
        _workers("Hanna", "Orel", "Extra"),
        {"assignments": assignments, "pulls": {}},
        pulls_limit=None,
        pulls_prefer=None,
    )
    pulls = payload.get("pulls") or {}
    assert any("לילה" in str(k) for k in pulls), pulls


def test_night_prefer_creates_night_pull_while_noon_hole_remains():
    site = SimpleNamespace(config=_site_config_three_shifts(["sun", "mon"]))
    assignments = {
        "sun": {
            "בוקר": [["Extra"]],
            "צהריים": [["Hanna"]],
            "לילה": [[]],
        },
        "mon": {
            "בוקר": [["Orel"]],
            "צהריים": [[]],
            "לילה": [[]],
        },
    }
    payload = _apply_auto_pulls_to_payload(
        site,
        _workers("Hanna", "Orel", "Extra"),
        {"assignments": assignments, "pulls": {}},
        pulls_limit=None,
        pulls_prefer=["night"],
    )
    pulls = payload.get("pulls") or {}
    assert any("לילה" in str(k) for k in pulls), pulls


def test_do_not_hold_when_zero_holes_even_with_fewer_pulls():
    from app.sites.auto_planning import _should_hold_plan_until_pull_target

    site = SimpleNamespace(config=_site_config_three_shifts(["sun"]))
    full = {"sun": {"בוקר": [["A"]], "צהריים": [["B"]], "לילה": [["C"]]}}
    assert _should_hold_plan_until_pull_target(site, full, "2026-08-16", {}, 2) is False

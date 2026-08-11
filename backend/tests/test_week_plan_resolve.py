from types import SimpleNamespace

from app.sites.week_plans import (
    _pick_week_plan_row_for_resolve,
    _week_plan_resolve_scope_order,
    _shape_week_plan_get_payload,
)


def test_resolve_order_without_prefer_matches_rank():
    assert _week_plan_resolve_scope_order(None) == ("shared", "director", "auto")
    assert _week_plan_resolve_scope_order("auto") == ("shared", "director", "auto")


def test_resolve_order_honors_saved_prefer():
    assert _week_plan_resolve_scope_order("director") == ("director", "shared", "auto")
    assert _week_plan_resolve_scope_order("shared") == ("shared", "director", "auto")


def _row(scope: str, assignments: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(scope=scope, data={"assignments": assignments if assignments is not None else {"sun": {}}})


def test_pick_prefers_shared_when_both_saved_exist():
    picked = _pick_week_plan_row_for_resolve(
        [_row("director"), _row("shared"), _row("auto")],
        site=None,
        week_iso="2026-08-09",
    )
    assert picked is not None
    assert picked.scope == "shared"


def test_pick_falls_back_to_director_then_auto():
    picked = _pick_week_plan_row_for_resolve(
        [_row("director"), _row("auto")],
        site=None,
        week_iso="2026-08-09",
    )
    assert picked is not None
    assert picked.scope == "director"

    picked_auto = _pick_week_plan_row_for_resolve(
        [_row("auto")],
        site=None,
        week_iso="2026-08-09",
    )
    assert picked_auto is not None
    assert picked_auto.scope == "auto"


def test_pick_skips_row_without_assignments():
    empty = SimpleNamespace(scope="shared", data={"pulls": {}})
    picked = _pick_week_plan_row_for_resolve(
        [empty, _row("director")],
        site=None,
        week_iso="2026-08-09",
    )
    assert picked is not None
    assert picked.scope == "director"


def test_shape_week_plan_get_payload_base_keeps_assignments_omits_alts():
    data = {
        "assignments": {"sun": {"06-14": [["A"]]}},
        "pulls": {"k": 1},
        "alternatives": [{"sun": {}}],
        "alternative_pulls": [{}],
        "workers": [{"name": "A"}],
        "isManual": False,
    }
    base = _shape_week_plan_get_payload(data, parts="base", include_workers=False, source_scope="auto")
    assert base is not None
    assert base["assignments"] == data["assignments"]
    assert base["pulls"] == {"k": 1}
    assert base["_alts_omitted"] is True
    assert base["_alts_count"] == 1
    assert "alternatives" not in base
    assert "workers" not in base
    assert base["_source_scope"] == "auto"

    alts = _shape_week_plan_get_payload(data, parts="alternatives", include_workers=False)
    assert alts is not None
    assert alts["alternatives"] == data["alternatives"]
    assert alts["alternative_pulls"] == [{}]
    assert "assignments" not in alts

    full = _shape_week_plan_get_payload(data, parts="full", include_workers=True)
    assert full is not None
    assert full["alternatives"] == data["alternatives"]
    assert full["workers"] == data["workers"]

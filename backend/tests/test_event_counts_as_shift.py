"""counts_as_shift : un אירוע désactivé ne compte pas comme משמרת."""

import sys
from types import ModuleType, SimpleNamespace


def _install_ortools_stub() -> None:
    """évite d'installer ortools juste pour ce test unitaire."""
    if "ortools.sat.python.cp_model" in sys.modules:
        return
    ortools = ModuleType("ortools")
    sat = ModuleType("ortools.sat")
    python = ModuleType("ortools.sat.python")
    cp_model = ModuleType("ortools.sat.python.cp_model")
    sys.modules["ortools"] = ortools
    sys.modules["ortools.sat"] = sat
    sys.modules["ortools.sat.python"] = python
    sys.modules["ortools.sat.python.cp_model"] = cp_model


_install_ortools_stub()

from app.sites.events import _count_site_event_assignments_by_worker_id, _event_counts_as_shift  # noqa: E402


def _ev(*, dates, assignments, counts_as_shift=True):
    return SimpleNamespace(
        dates_json=dates,
        assignments_json=assignments,
        counts_as_shift=counts_as_shift,
    )


def test_event_counts_as_shift_defaults_true():
    assert _event_counts_as_shift(SimpleNamespace(counts_as_shift=True)) is True
    assert _event_counts_as_shift(SimpleNamespace(counts_as_shift=False)) is False
    assert _event_counts_as_shift(SimpleNamespace()) is True


def test_count_skips_events_not_counting_as_shift():
    week_iso = "2026-10-11"
    rows = [
        _ev(
            dates=["2026-10-12", "2026-10-13"],
            assignments={"2026-10-12": [1], "2026-10-13": [1, 2]},
            counts_as_shift=True,
        ),
        _ev(
            dates=["2026-10-14"],
            assignments={"2026-10-14": [1]},
            counts_as_shift=False,
        ),
    ]
    counts = _count_site_event_assignments_by_worker_id(
        db=None,  # type: ignore[arg-type]
        site_id=1,
        week_iso=week_iso,
        event_rows=rows,
    )
    assert counts.get(1) == 2
    assert counts.get(2) == 1

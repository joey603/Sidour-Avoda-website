from __future__ import annotations

from typing import Any, Dict, List, Tuple
import logging
import os

from ortools.sat.python import cp_model

from .ai_solver_utils import (
    DayKey,
    ShiftName,
    _solver_num_search_workers,
    build_capacities_from_config,
    enforce_max_shifts_on_plan,
    finalize_candidate_plan,
    next_day,
    order_days,
    order_shifts,
    sanitize_plan,
)
from .ai_solver_model import (
    build_cp_sat_schedule_model,
    is_morning_shift_name,
    is_night_shift_name,
    is_noon_shift_name,
)

# Réexport public (compat imports existants / tests)
__all__ = [
    "DayKey",
    "ShiftName",
    "build_capacities_from_config",
    "enforce_max_shifts_on_plan",
    "finalize_candidate_plan",
    "next_day",
    "order_days",
    "order_shifts",
    "sanitize_plan",
    "solve_schedule",
    "solve_schedule_stream",
]


def solve_schedule(
    config: Dict[str, Any],
    workers: List[Dict[str, Any]],
    time_limit_seconds: int = 30,
    max_nights_per_worker: int = 3,
    num_alternatives: int = 20,
    fixed_assignments: Dict[str, Dict[str, List[List[str]]]] | None = None,
    exclude_days: List[str] | None = None,
) -> Dict[str, Any]:
    """Return a schedule dict with assignments per day/shift/station as worker name lists.

    workers: [{"id": int, "name": str, "max_shifts": int, "availability": {day: [shift]}}]
    """
    logger = logging.getLogger("ai_solver")
    built = build_cp_sat_schedule_model(
        config or {},
        workers,
        max_nights_per_worker=max_nights_per_worker,
        fixed_assignments=fixed_assignments,
        exclude_days=exclude_days,
        log_label="SOLVER",
    )
    days, shifts, stations = built.days, built.shifts, built.stations
    model, x = built.model, built.x
    W, D, S, T = built.W, built.D, built.S, built.T
    name_to_w = built.name_to_w
    _is_night_name = is_night_shift_name
    _is_morning_name = is_morning_shift_name
    _is_noon_name = is_noon_shift_name
    logger.info(
        "Start solve: days=%s shifts=%s stations=%s workers=%s",
        days,
        shifts,
        [st.get("name") for st in stations],
        [w.get("name") for w in workers],
    )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(time_limit_seconds)
    solver.parameters.num_search_workers = _solver_num_search_workers()

    res = solver.Solve(model)

    # Build empty assignments structure: day -> shift -> list per station of worker names
    assignments: Dict[str, Dict[str, List[List[str]]]] = {
        day: {sh: [[] for _ in stations] for sh in shifts} for day in days
    }

    if res not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {
            "days": days,
            "shifts": shifts,
            "stations": [st.get("name") for st in stations],
            "assignments": assignments,
            "status": str(res),
            "objective": 0,
        }

    # Fill assignments ensuring:
    # - no duplicate name within the same cell
    # - no duplicate name across stations for the same day/shift
    non_empty_cells = 0
    total_required = 0
    for d, day_key in enumerate(days):
        for s, sh_name in enumerate(shifts):
            seen_names: set[str] = set()
            for t, st in enumerate(stations):
                cap_map = st.get("capacity", {})
                required = int(cap_map.get(day_key, {}).get(sh_name, 0))
                if required <= 0:
                    # enforce empty cell
                    assignments[day_key][sh_name][t] = []
                    continue
                non_empty_cells += 1
                total_required += required
                # collect candidates from solver
                candidates: List[str] = []
                for w in W:
                    if solver.BooleanValue(x[(w, d, s, t)]):
                        candidates.append(workers[w]["name"])
                # dedup within cell and across stations for this day/shift
                unique: List[str] = []
                for nm in candidates:
                    if nm in seen_names:
                        continue
                    if nm in unique:
                        continue
                    unique.append(nm)
                    seen_names.add(nm)
                    if len(unique) >= required:
                        break
                assignments[day_key][sh_name][t] = unique
    # Safety: enforce uniqueness within each cell
    sanitize_plan(assignments, days, shifts, stations)
    logger.info("Base plan: cells=%d required_total=%d", non_empty_cells, total_required)
    def _count_assigned(a: Dict[str, Dict[str, List[List[str]]]]) -> int:
        total = 0
        for dk, sm in a.items():
            for sn, per_st in sm.items():
                for lst in per_st:
                    total += len(lst or [])
        return total
    base_total_assigned = _count_assigned(assignments)

    # Greedy post-processing: try to fill remaining holes without violating constraints
    try:
        # Log compteurs avant greedy
        _pre_greedy_counts: Dict[str, int] = {}
        for _dk, _sm in assignments.items():
            for _sn, _perst in _sm.items():
                for _lst in _perst:
                    for _nm in (_lst or []):
                        _pre_greedy_counts[_nm] = _pre_greedy_counts.get(_nm, 0) + 1
        _over_before = {nm: (cnt, workers[name_to_w.get(str(nm or "").strip(), -1)].get("max_shifts", 5) if name_to_w.get(str(nm or "").strip(), -1) >= 0 else 5) for nm, cnt in _pre_greedy_counts.items() if cnt > (workers[name_to_w.get(str(nm or "").strip(), -1)].get("max_shifts", 5) if name_to_w.get(str(nm or "").strip(), -1) >= 0 else 5)}
        if _over_before:
            logger.warning("[GREEDY][PRE] workers already over max_shifts BEFORE greedy: %s", _over_before)
        else:
            logger.info("[GREEDY][PRE] all workers within max_shifts before greedy. counts=%s", dict(sorted(_pre_greedy_counts.items())))
        # Helpers for checks
        shift_index = {nm: i for i, nm in enumerate(shifts)}
        day_index = {dk: i for i, dk in enumerate(days)}
        def name_present_same_day(a, dkey, nm) -> bool:
            for sname in shifts:
                per_station = a.get(dkey, {}).get(sname, []) or []
                for lst in per_station:
                    if nm in (lst or []):
                        return True
            return False
        def has_adjacent_in_assign(a, nm: str, dkey: str, sname: str) -> bool:
            di = day_index.get(dkey, -1)
            si = shift_index.get(sname, -1)
            if di < 0 or si < 0:
                return False
            if si - 1 >= 0:
                prev = []
                for lst in (a.get(dkey, {}).get(shifts[si - 1], []) or []):
                    prev.extend(lst or [])
                if nm in prev:
                    return True
            if si + 1 < len(shifts):
                nxt = []
                for lst in (a.get(dkey, {}).get(shifts[si + 1], []) or []):
                    nxt.extend(lst or [])
                if nm in nxt:
                    return True
            if si == 0 and di - 1 >= 0:
                prev_day = days[di - 1]
                last_shift = shifts[-1]
                prev = []
                for lst in (a.get(prev_day, {}).get(last_shift, []) or []):
                    prev.extend(lst or [])
                if nm in prev:
                    return True
            if si == len(shifts) - 1 and di + 1 < len(days):
                next_day = days[di + 1]
                first = shifts[0]
                nxt = []
                for lst in (a.get(next_day, {}).get(first, []) or []):
                    nxt.extend(lst or [])
                if nm in nxt:
                    return True
            return False
        def is_night(name: str) -> bool:
            s = (name or "").strip().lower()
            return s == "22-06" or ("22" in s and "06" in s) or ("night" in s) or ("\u05dc\u05d9\u05dc\u05d4" in name)
        # Precompute worker maps
        name_to_max = { (w.get("name") or ""): int(w.get("max_shifts") or 5) for w in workers }
        name_to_roles_norm = { (w.get("name") or ""): { _norm_role_local(r) for r in (w.get("roles") or []) } for w in workers }
        name_to_avail = { (w.get("name") or ""): (w.get("availability") or {}) for w in workers }
        # Assigned counts and night counts
        assigned_per_name: Dict[str, int] = {}
        night_count_per_name: Dict[str, int] = {}
        for dk, sm in assignments.items():
            for sn, perst in sm.items():
                for lst in perst:
                    for nm in (lst or []):
                        assigned_per_name[nm] = assigned_per_name.get(nm, 0) + 1
                        if is_night(sn):
                            night_count_per_name[nm] = night_count_per_name.get(nm, 0) + 1
        added = 0
        for t, st in enumerate(stations):
            cap = st.get("capacity", {})
            cap_roles_all = (st.get("capacity_roles", {}) or {})
            for d, day_key in enumerate(days):
                for s, sh_name in enumerate(shifts):
                    required = int(cap.get(day_key, {}).get(sh_name, 0))
                    if required <= 0:
                        continue
                    cell = assignments.get(day_key, {}).get(sh_name, [])[t]
                    if cell is None:
                        continue
                    current = list(cell)
                    if len(current) >= required:
                        continue
                    # Role deficits if any
                    role_caps = (cap_roles_all.get(day_key, {}) or {}).get(sh_name, {}) or {}
                    role_caps_norm = { _norm_role_local(k): int(v) for k, v in role_caps.items() }
                    def count_role_in(names: List[str], role_name: str) -> int:
                        c = 0
                        for nm in names:
                            if role_name in (name_to_roles_norm.get(nm) or set()):
                                c += 1
                        return c
                    # Candidate order: fewest assigned first
                    all_names = [w.get("name") or "" for w in workers]
                    all_names = [nm for nm in all_names if nm and nm not in current]
                    all_names.sort(key=lambda nm: (assigned_per_name.get(nm, 0), nm))
                    while len(current) < required:
                        picked = None
                        # compute deficits
                        deficits = { rn: max(0, int(rc) - count_role_in(current, rn)) for rn, rc in role_caps_norm.items() }
                        must_fill_role = sum(deficits.values()) > 0
                        for nm in all_names:
                            # availability
                            if sh_name not in (name_to_avail.get(nm, {}).get(day_key) or []):
                                continue
                            # same day / adjacency
                            if name_present_same_day(assignments, day_key, nm):
                                continue
                            if has_adjacent_in_assign(assignments, nm, day_key, sh_name):
                                continue
                            # weekly quota
                            if assigned_per_name.get(nm, 0) >= name_to_max.get(nm, 5):
                                continue
                            # nights quota
                            if is_night(sh_name) and night_count_per_name.get(nm, 0) >= max_nights_per_worker:
                                continue
                            # role rule
                            roles_nm = name_to_roles_norm.get(nm) or set()
                            if must_fill_role:
                                # accept only if worker carries a remaining deficit role
                                if not any((r in deficits and deficits[r] > 0) for r in roles_nm):
                                    continue
                            # ok, pick
                            picked = nm
                            break
                        if not picked:
                            break
                        current.append(picked)
                        assignments[day_key][sh_name][t] = current
                        assigned_per_name[picked] = assigned_per_name.get(picked, 0) + 1
                        if is_night(sh_name):
                            night_count_per_name[picked] = night_count_per_name.get(picked, 0) + 1
                        added += 1
        if added:
            logger.info("[GREEDY] trous comblés=%d (post-process)", added)
        # Log compteurs après greedy
        _post_greedy_counts: Dict[str, int] = {}
        for _dk, _sm in assignments.items():
            for _sn, _perst in _sm.items():
                for _lst in _perst:
                    for _nm in (_lst or []):
                        _post_greedy_counts[_nm] = _post_greedy_counts.get(_nm, 0) + 1
        _over_after = {nm: (cnt, workers[name_to_w.get(str(nm or "").strip(), -1)].get("max_shifts", 5) if name_to_w.get(str(nm or "").strip(), -1) >= 0 else 5) for nm, cnt in _post_greedy_counts.items() if cnt > (workers[name_to_w.get(str(nm or "").strip(), -1)].get("max_shifts", 5) if name_to_w.get(str(nm or "").strip(), -1) >= 0 else 5)}
        if _over_after:
            logger.warning("[GREEDY][POST] workers over max_shifts AFTER greedy (before enforce): %s", _over_after)
        else:
            logger.info("[GREEDY][POST] all workers within max_shifts after greedy.")
    except Exception:
        pass
    # Garantie finale: aucun worker ne dépasse son max_shifts après le greedy
    enforce_max_shifts_on_plan(assignments, workers, label="solve_schedule")
    # Diagnostic: trous (holes) par cellule et candidats potentiels simples
    try:
        # index utilitaires
        shift_index = {nm: i for i, nm in enumerate(shifts)}
        day_index = {dk: i for i, dk in enumerate(days)}
        def name_present_same_day(a, dkey, nm) -> bool:
            for sname in shifts:
                per_station = a.get(dkey, {}).get(sname, []) or []
                for lst in per_station:
                    if nm in (lst or []):
                        return True
            return False
        def has_adjacent_in_assign(a, nm: str, dkey: str, sname: str) -> bool:
            di = day_index.get(dkey, -1)
            si = shift_index.get(sname, -1)
            if di < 0 or si < 0:
                return False
            # précédent même jour
            if si - 1 >= 0:
                prev = []
                for lst in (a.get(dkey, {}).get(shifts[si - 1], []) or []):
                    prev.extend(lst or [])
                if nm in prev:
                    return True
            # suivant même jour
            if si + 1 < len(shifts):
                nxt = []
                for lst in (a.get(dkey, {}).get(shifts[si + 1], []) or []):
                    nxt.extend(lst or [])
                if nm in nxt:
                    return True
            # bordure jour
            if si == 0 and di - 1 >= 0:
                prev_day = days[di - 1]
                last_shift = shifts[-1]
                prev = []
                for lst in (a.get(prev_day, {}).get(last_shift, []) or []):
                    prev.extend(lst or [])
                if nm in prev:
                    return True
            if si == len(shifts) - 1 and di + 1 < len(days):
                next_day = days[di + 1]
                first = shifts[0]
                nxt = []
                for lst in (a.get(next_day, {}).get(first, []) or []):
                    nxt.extend(lst or [])
                if nm in nxt:
                    return True
            return False
        # max shifts per worker map
        name_to_max = { (w.get("name") or ""): int(w.get("max_shifts") or 5) for w in workers }
        name_to_avail = { (w.get("name") or ""): (w.get("availability") or {}) for w in workers }
        # count assigned per worker
        assigned_per_name: Dict[str, int] = {}
        for dk, sm in assignments.items():
            for sn, perst in sm.items():
                for lst in perst:
                    for nm in (lst or []):
                        assigned_per_name[nm] = assigned_per_name.get(nm, 0) + 1
        # inspect trous
        holes: List[Tuple[str,str,int,int]] = []  # (day, shift, station_idx, deficit)
        for t, st in enumerate(stations):
            cap_map = st.get("capacity", {})
            for d, day_key in enumerate(days):
                for s, sh_name in enumerate(shifts):
                    req = int(cap_map.get(day_key, {}).get(sh_name, 0))
                    if req <= 0:
                        continue
                    got = len(assignments.get(day_key, {}).get(sh_name, [])[t] or [])
                    if got < req:
                        holes.append((day_key, sh_name, t, req - got))
        if holes:
            logger.info("[BASE] couverture=%d trous=%d", base_total_assigned, sum(d for (_,_,_,d) in holes))
            # pour quelques trous, estimer nb de candidats simples
            for i, (dk, sn, t_idx, deficit) in enumerate(holes[:10]):
                cand = 0
                for nm, max_sh in name_to_max.items():
                    # dispo
                    av = name_to_avail.get(nm) or {}
                    if sn not in (av.get(dk) or []):
                        continue
                    # pas déjà le même jour
                    if name_present_same_day(assignments, dk, nm):
                        continue
                    # pas adjacent
                    if has_adjacent_in_assign(assignments, nm, dk, sn):
                        continue
                    # quota hebdo
                    if assigned_per_name.get(nm, 0) >= max_sh:
                        continue
                    cand += 1
                logger.info("[TROU] %s / %s / station=%s deficit=%d candidats_simples=%d", dk, sn, stations[t_idx].get("name"), deficit, cand)
    except Exception:
        pass

    # Enumerate alternative full solutions by re-solving with a nogood to change global distribution
    # This produces alternatives that can change per-worker totals (not only swaps)
    alternatives_from_resolve: List[Dict[str, Dict[str, List[List[str]]]]] = []
    # Helper to rebuild assignments from current solver state
    def build_assignments_from_solver() -> Dict[str, Dict[str, List[List[str]]]]:
        out: Dict[str, Dict[str, List[List[str]]]] = {day: {sh: [[] for _ in stations] for sh in shifts} for day in days}
        for t, st in enumerate(stations):
            cap = st.get("capacity", {})
            for d, day_key in enumerate(days):
                for s, sh_name in enumerate(shifts):
                    required = int(cap.get(day_key, {}).get(sh_name, 0))
                    if required <= 0:
                        continue
                    chosen_names: List[str] = []
                    for w in W:
                        if solver.BooleanValue(x[(w, d, s, t)]):
                            chosen_names.append(workers[w]["name"])
                    out[day_key][sh_name][t] = chosen_names[:required]
        return out

    # Build set of x-lits True in baseline solution
    def current_true_lits():
        lits = []
        for w in W:
            for d in D:
                for s in S:
                    for t in T:
                        if solver.BooleanValue(x[(w, d, s, t)]):
                            lits.append(x[(w, d, s, t)])
        return lits

    # Small helper to sanitize: ensure uniqueness within each cell and respect capacity
    def _sanitize_assignments(a: Dict[str, Dict[str, List[List[str]]]]):
        for t_i, st in enumerate(stations):
            cap_map = st.get("capacity", {}) or {}
            for dkey in days:
                for sname in shifts:
                    req = int((cap_map.get(dkey, {}) or {}).get(sname, 0))
                    per = (a.get(dkey, {}).get(sname, []) or [])
                    if not per:
                        continue
                    for i in range(len(per)):
                        seen_local: set[str] = set()
                        uniq: List[str] = []
                        for nm in (per[i] or []):
                            v = (nm or "").strip()
                            if not v:
                                continue
                            if v in seen_local:
                                continue
                            seen_local.add(v)
                            uniq.append(v)
                            if req > 0 and len(uniq) >= req:
                                break
                        per[i] = uniq

    # Add successive nogoods and re-solve
    alt_budget_resolve = max(0, int(num_alternatives))
    seen_signatures: set = set()
    # signature helper reusing earlier approach
    def sig_from_assign(a: Dict[str, Dict[str, List[List[str]]]]):
        return tuple(
            (dk, tuple((sn, tuple(tuple(lst) for lst in (a.get(dk, {}).get(sn, []) or []))) for sn in shifts)) for dk in days
        )
    seen_signatures.add(sig_from_assign(assignments))
    while alt_budget_resolve > 0:
        true_lits = current_true_lits()
        if not true_lits:
            break
        # Exclude current full assignment
        model.Add(sum(true_lits) <= len(true_lits) - 1)
        solver2 = cp_model.CpSolver()
        solver2.parameters.max_time_in_seconds = float(max(1, int(time_limit_seconds)))
        solver2.parameters.num_search_workers = _solver_num_search_workers()
        res2 = solver2.Solve(model)
        if res2 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            break
        # Switch main solver reference to new solution for extraction convenience
        solver = solver2
        cand_assign = build_assignments_from_solver()
        finalize_candidate_plan(cand_assign, workers, days, shifts, stations, label="solve_schedule:resolve")
        # Garder uniquement les alternatives avec couverture maximale égale à la base
        if _count_assigned(cand_assign) != base_total_assigned:
            continue
        signature = sig_from_assign(cand_assign)
        if signature in seen_signatures:
            continue
        seen_signatures.add(signature)
        alternatives_from_resolve.append(cand_assign)
        alt_budget_resolve -= 1

    def _names_in_cell(a: Dict[str, Dict[str, List[List[str]]]], dkey: str, sname: str, t_idx: int) -> List[str]:
        return list((a.get(dkey, {}).get(sname, []) or [[] for _ in stations])[t_idx] or [])

    def _write_cell(a: Dict[str, Dict[str, List[List[str]]]], dkey: str, sname: str, t_idx: int, names: List[str]):
        a[dkey][sname][t_idx] = list(names)

    # Generate alternatives with deduplication
    # Respect fixed cells: do not move names that were pre-assigned (fixed_assignments)
    fixed_cells: Dict[Tuple[str, str, int], set[str]] = {}
    try:
        fa = fixed_assignments or {}
        for dkey in days:
            day_map = (fa.get(dkey) or {})
            for sname in shifts:
                per_station = (day_map.get(sname) or [])
                for t_idx in range(len(stations)):
                    names = []
                    try:
                        names = per_station[t_idx] if t_idx < len(per_station) else []
                    except Exception:
                        names = []
                    normed = { _norm_name_local(nm) for nm in (names or []) if str(nm or "").strip() }
                    if normed:
                        fixed_cells[(dkey, sname, t_idx)] = normed
    except Exception:
        fixed_cells = {}
    def _is_fixed_here(nm: str, dkey: str, sname: str, t_idx: int) -> bool:
        key = (dkey, sname, t_idx)
        if key not in fixed_cells:
            return False
        return _norm_name_local(nm) in fixed_cells[key]
    alternatives: List[Dict[str, Dict[str, List[List[str]]]]] = []
    seen: set = set()
    def sig(a: Dict[str, Dict[str, List[List[str]]]]):
        return tuple(
            (dk, tuple((sn, tuple(tuple(lst) for lst in (a.get(dk, {}).get(sn, []) or []))) for sn in shifts)) for dk in days
        )
    seen.add(sig(assignments))
    # Enforce availability when proposing alternatives
    name_to_avail: Dict[str, Dict[str, List[str]]] = { (w.get("name") or ""): (w.get("availability") or {}) for w in workers }
    def is_allowed(nm: str, dkey: str, sname: str) -> bool:
        av = name_to_avail.get(nm) or {}
        lst = av.get(dkey) or []
        return sname in lst
    def name_present_same_day(a, dkey, nm) -> bool:
        for sname in shifts:
            # across all stations
            per_station = a.get(dkey, {}).get(sname, []) or []
            for lst in per_station:
                if nm in (lst or []):
                    return True
        return False

    # Vérification de gardes adjacentes dans un candidat
    shift_index = {sname: i for i, sname in enumerate(shifts)}
    day_index = {dk: i for i, dk in enumerate(days)}

    def has_adjacent_in_candidate(a: Dict[str, Dict[str, List[List[str]]]], nm: str, dk: str, sname: str) -> bool:
        di = day_index.get(dk, -1)
        si = shift_index.get(sname, -1)
        if di < 0 or si < 0:
            return False
        # shift précédent même jour
        if si - 1 >= 0:
            prev_names = []
            per_station = a.get(dk, {}).get(shifts[si - 1], []) or []
            for lst in per_station:
                prev_names.extend(lst or [])
            if nm in prev_names:
                return True
        # shift suivant même jour
        if si + 1 < len(shifts):
            next_names = []
            per_station = a.get(dk, {}).get(shifts[si + 1], []) or []
            for lst in per_station:
                next_names.extend(lst or [])
            if nm in next_names:
                return True
        # bordure de jour: dernier shift la veille / premier shift le lendemain
        if si == 0 and di - 1 >= 0:
            prev_day = days[di - 1]
            last_shift = shifts[-1]
            prev_names = []
            per_station = a.get(prev_day, {}).get(last_shift, []) or []
            for lst in per_station:
                prev_names.extend(lst or [])
            if nm in prev_names:
                return True
        if si == len(shifts) - 1 and di + 1 < len(days):
            next_day_key = days[di + 1]
            first_shift = shifts[0]
            next_names = []
            per_station = a.get(next_day_key, {}).get(first_shift, []) or []
            for lst in per_station:
                next_names.extend(lst or [])
            if nm in next_names:
                return True
        return False

    # Try generate up to N alternatives
    alt_budget = 20 if num_alternatives is None else max(0, int(num_alternatives))
    logger.info("Alt budget=%d", alt_budget)
    for dkey in days:
        if alt_budget <= 0:
            break
        for t_idx, st in enumerate(stations):
            if alt_budget <= 0:
                break

    # If still budget left, try same-day swaps between two filled shifts (keep capacity)
    for dkey in days:
        if alt_budget <= 0:
            break
        for t_idx, st in enumerate(stations):
            if alt_budget <= 0:
                break
            for i1, s1 in enumerate(shifts):
                for i2, s2 in enumerate(shifts):
                    if i2 <= i1:
                        continue
                    names1 = _names_in_cell(assignments, dkey, s1, t_idx)
                    names2 = _names_in_cell(assignments, dkey, s2, t_idx)
                    if not names1 or not names2:
                        continue
                    # swap single names pairwise to create variants
                    for nm1 in names1:
                        for nm2 in names2:
                            if nm1 == nm2:
                                continue
                            # do not move fixed names out of their fixed cells
                            if _is_fixed_here(nm1, dkey, s1, t_idx):
                                continue
                            if _is_fixed_here(nm2, dkey, s2, t_idx):
                                continue
                            # respect availability for destinations
                            if not is_allowed(nm1, dkey, s2):
                                continue
                            if not is_allowed(nm2, dkey, s1):
                                continue
                            cand = {dk: {sn: [list(lst) for lst in per_st] for sn, per_st in smap.items()} for dk, smap in assignments.items()}
                            # remove nm1 from s1, nm2 from s2
                            new1 = [n for n in names1 if n != nm1] + [nm2]
                            new2 = [n for n in names2 if n != nm2] + [nm1]
                            if len(set(new1)) != len(new1) or len(set(new2)) != len(new2):
                                continue
                            _write_cell(cand, dkey, s1, t_idx, new1)
                            _write_cell(cand, dkey, s2, t_idx, new2)
                            _sanitize_assignments(cand)
                            sg = sig(cand)
                            if sg in seen:
                                continue
                            # Vérifier adjacence pour nm2 et nm1 aux nouvelles positions
                            if has_adjacent_in_candidate(cand, nm2, dkey, s1):
                                continue
                            if has_adjacent_in_candidate(cand, nm1, dkey, s2):
                                continue
                            if _count_assigned(cand) != base_total_assigned:
                                continue
                            seen.add(sg)
                            alternatives.append(cand)
                            alt_budget -= 1
                            if alt_budget <= 0:
                                break
                        if alt_budget <= 0:
                            break
                    if alt_budget <= 0:
                        break
                if alt_budget <= 0:
                    break
            # collect non-empty shifts
            non_empty = [sname for sname in shifts if _names_in_cell(assignments, dkey, sname, t_idx)]
            empty = [sname for sname in shifts if not _names_in_cell(assignments, dkey, sname, t_idx)
                     and int(st.get("capacity", {}).get(dkey, {}).get(sname, 0)) > 0]
            # swap between non-empty and empty to build variants
            for s_from in non_empty:
                names_from = _names_in_cell(assignments, dkey, s_from, t_idx)
                for nm in names_from:
                    # cannot move a fixed name from its fixed cell
                    if _is_fixed_here(nm, dkey, s_from, t_idx):
                        continue
                    for s_to in shifts:
                        if s_to == s_from:
                            continue
                        cap_to = int(st.get("capacity", {}).get(dkey, {}).get(s_to, 0))
                        if cap_to <= 0:
                            continue
                        names_to = _names_in_cell(assignments, dkey, s_to, t_idx)
                        if nm in names_to:
                            continue
                        if len(names_to) >= cap_to:
                            continue
                        # respect availability for destination shift
                        if not is_allowed(nm, dkey, s_to):
                            continue
                        # ensure nm not assigned elsewhere same day in other station/shift
                        # Temporarily remove nm from s_from and test presence
                        cand = {dk: {sn: [list(lst) for lst in per_st] for sn, per_st in smap.items()} for dk, smap in assignments.items()}
                        _write_cell(cand, dkey, s_from, t_idx, [n for n in names_from if n != nm])
                        # if still present same day (e.g., other station), skip
                        if name_present_same_day(cand, dkey, nm):
                            continue
                        # place to s_to
                        new_to = names_to + [nm]
                        if len(set(new_to)) != len(new_to):
                            continue
                        _write_cell(cand, dkey, s_to, t_idx, new_to)
                        _sanitize_assignments(cand)
                        sg = sig(cand)
                        if sg in seen:
                            continue
                        if has_adjacent_in_candidate(cand, nm, dkey, s_to):
                            continue
                        if _count_assigned(cand) != base_total_assigned:
                            continue
                        seen.add(sg)
                        alternatives.append(cand)
                        alt_budget -= 1
                        if alt_budget <= 0:
                            break
                    if alt_budget <= 0:
                        break
                if alt_budget <= 0:
                    break
            if alt_budget <= 0:
                break

    # Échanges cross-day sur même עמדה et même shift (respect capacité et adjacence)
    for sname in shifts:
        if alt_budget <= 0:
            break
        for t_idx in range(len(stations)):
            if alt_budget <= 0:
                break
            for d_i in range(len(days)):
                if alt_budget <= 0:
                    break
                d1 = days[d_i]
                names1 = _names_in_cell(assignments, d1, sname, t_idx)
                if not names1:
                    continue
                for d_j in range(d_i + 1, len(days)):
                    if alt_budget <= 0:
                        break
                    d2 = days[d_j]
                    names2 = _names_in_cell(assignments, d2, sname, t_idx)
                    if not names2:
                        continue
                    for nm1 in names1:
                        for nm2 in names2:
                            if nm1 == nm2:
                                continue
                            # do not move fixed names out of their fixed cells
                            if _is_fixed_here(nm1, d1, sname, t_idx):
                                continue
                            if _is_fixed_here(nm2, d2, sname, t_idx):
                                continue
                        # respect availability when swapping days
                        if not is_allowed(nm1, d2, sname):
                            continue
                        if not is_allowed(nm2, d1, sname):
                            continue
                            cand = {dk: {sn: [list(lst) for lst in per_st] for sn, per_st in smap.items()} for dk, smap in assignments.items()}
                            # swap dans sname @ t_idx entre d1 et d2
                            newd1 = [n for n in names1 if n != nm1] + [nm2]
                            newd2 = [n for n in names2 if n != nm2] + [nm1]
                            if len(set(newd1)) != len(newd1) or len(set(newd2)) != len(newd2):
                                continue
                            _write_cell(cand, d1, sname, t_idx, newd1)
                            _write_cell(cand, d2, sname, t_idx, newd2)
                            # Unicité par jour déjà assurée (1 garde/jour) car même shift/station
                            if has_adjacent_in_candidate(cand, nm2, d1, sname):
                                continue
                            if has_adjacent_in_candidate(cand, nm1, d2, sname):
                                continue
                            _sanitize_assignments(cand)
                            sg = sig(cand)
                            if sg in seen:
                                continue
                            if _count_assigned(cand) != base_total_assigned:
                                continue
                            seen.add(sg)
                            alternatives.append(cand)
                            alt_budget -= 1
                            if alt_budget <= 0:
                                break

    # Final pass: try to produce alternatives that reduce morning+night pairs without increasing holes
    def _is_morning_name_local(n: str) -> bool:
        s = (n or "").strip().lower()
        return ("בוקר" in n) or s.startswith("06") or ("06-14" in s)
    def _count_mn_pairs(a: Dict[str, Dict[str, List[List[str]]]]) -> int:
        cnt = 0
        for dk in days:
            for nm in name_to_avail.keys():
                has_m = False; has_n = False
                for si, sn in enumerate(shifts):
                    per = a.get(dk, {}).get(sn, []) or []
                    flat = []
                    for lst in per:
                        flat.extend(lst or [])
                    if _is_morning_name_local(sn) and nm in flat:
                        has_m = True
                    if _is_night_name(sn) and nm in flat:
                        has_n = True
                if has_m and has_n:
                    cnt += 1
        return cnt
    baseline_mn = _count_mn_pairs(assignments)
    # Also, try to reduce Noon(d) + Morning(d+1) pairs by moving next morning to noon (same station)
    def _is_noon_name_local(n: str) -> bool:
        s = (n or "").strip().lower()
        return ("צהר" in n) or s.startswith("14") or ("14-22" in s)
    def _count_nm_pairs(a: Dict[str, Dict[str, List[List[str]]]]) -> int:
        cnt = 0
        for di in range(len(days) - 1):
            d = days[di]
            dnext = days[di + 1]
            for nm in name_to_avail.keys():
                has_noon = False; has_morn_next = False
                for sn in shifts:
                    per = (a.get(d, {}).get(sn, []) or [])
                    flat = []
                    for lst in per:
                        flat.extend(lst or [])
                    if _is_noon_name_local(sn) and nm in flat:
                        has_noon = True
                for sn in shifts:
                    per = (a.get(dnext, {}).get(sn, []) or [])
                    flat = []
                    for lst in per:
                        flat.extend(lst or [])
                    if _is_morning_name(sn) and nm in flat:
                        has_morn_next = True
                if has_noon and has_morn_next:
                    cnt += 1
        return cnt
    baseline_nm = _count_nm_pairs(assignments)
    if alt_budget_resolve >= 0:
        # try simple moves of morning→noon or night→noon to reduce mn pairs
        for dkey in days:
            for t_idx, st in enumerate(stations):
                for sname in shifts:
                    if alt_budget_resolve <= 0:
                        break
                    if not (_is_morning_name_local(sname) or _is_night_name(sname)):
                        continue
                    names_here = _names_in_cell(assignments, dkey, sname, t_idx)
                    if not names_here:
                        continue
                    # candidate destination shifts prioritizing noon-like
                    for nm in list(names_here):
                        # skip fixed names
                        if _is_fixed_here(nm, dkey, sname, t_idx):
                            continue
                        for s_to in shifts:
                            if alt_budget_resolve <= 0:
                                break
                            if s_to == sname:
                                continue
                            # prefer noon
                            to_is_noon = ("צהר" in s_to) or ("14-22" in s_to) or (s_to.strip().startswith("14"))
                            if not to_is_noon:
                                continue
                            cap_to = int(st.get("capacity", {}).get(dkey, {}).get(s_to, 0))
                            if cap_to <= 0:
                                continue
                            names_to = _names_in_cell(assignments, dkey, s_to, t_idx)
                            if nm in names_to or len(names_to) >= cap_to:
                                continue
                            # build candidate
                            cand = {dk: {sn: [list(lst) for lst in per_st] for sn, per_st in smap.items()} for dk, smap in assignments.items()}
                            _write_cell(cand, dkey, sname, t_idx, [n for n in names_here if n != nm])
                            # forbid same-day multi-placement
                            if name_present_same_day(cand, dkey, nm):
                                continue
                            if s_to not in _avail_list_stream_of(nm, dkey):
                                continue
                            if has_adjacent_in_candidate(cand, nm, dkey, s_to):
                                continue
                            new_to2 = names_to + [nm]
                            if len(set(new_to2)) != len(new_to2):
                                continue
                            _write_cell(cand, dkey, s_to, t_idx, new_to2)
                            if _count_assigned(cand) != base_total_assigned:
                                continue
                            if sig(cand) in seen:
                                continue
                            if _count_holes(cand) > 0:
                                continue
                            # accept only if it reduces mn pairs or keeps same holes
                            if _count_mn_pairs(cand) < baseline_mn:
                                seen.add(sig(cand))
                                alternatives_from_resolve.append(cand)
                                alt_budget_resolve -= 1
                                if alt_budget_resolve <= 0:
                                    break

    # Second pass: move Morning(d+1) → Noon(d+1) to reduce Noon(d)+Morning(d+1)
    for di in range(len(days) - 1):
        if alt_budget_resolve <= 0:
            break
        d = days[di]
        dnext = days[di + 1]
        for t_idx, st in enumerate(stations):
            if alt_budget_resolve <= 0:
                break
            # all names in noon(d) and morning(d+1)
            noon_names = []
            for sn in shifts:
                if _is_noon_name_local(sn):
                    noon_names.extend(_names_in_cell(assignments, d, sn, t_idx))
            morning_next_names = []
            for sn in shifts:
                if _is_morning_name(sn):
                    morning_next_names.extend(_names_in_cell(assignments, dnext, sn, t_idx))
            # Intersect per name
            for nm in set(noon_names).intersection(set(morning_next_names)):
                if alt_budget_resolve <= 0:
                    break
                # try move nm from morning(d+1) to noon(d+1)
                for s_to in shifts:
                    if alt_budget_resolve <= 0:
                        break
                    if not _is_noon_name_local(s_to):
                        continue
                    cap_to = int(st.get("capacity", {}).get(dnext, {}).get(s_to, 0))
                    if cap_to <= 0:
                        continue
                    names_to = _names_in_cell(assignments, dnext, s_to, t_idx)
                    if nm in names_to or len(names_to) >= cap_to:
                        continue
                    # build candidate by removing nm from all morning cells of dnext @ station
                    cand = {dk: {sn: [list(lst) for lst in perst] for sn, perst in smap.items()} for dk, smap in assignments.items()}
                    # remove nm from morning cells next day
                    for sn in shifts:
                        if _is_morning_name(sn):
                            lst = _names_in_cell(cand, dnext, sn, t_idx)
                            if nm in lst:
                                _write_cell(cand, dnext, sn, t_idx, [n for n in lst if n != nm])
                    # guards
                    if name_present_same_day(cand, dnext, nm):
                        continue
                    if not is_allowed(nm, dnext, s_to):
                        continue
                    if has_adjacent_in_candidate(cand, nm, dnext, s_to):
                        continue
                    new_to_last = names_to + [nm]
                    if len(set(new_to_last)) != len(new_to_last):
                        continue
                    _write_cell(cand, dnext, s_to, t_idx, new_to_last)
                    if _count_assigned(cand) != base_total_assigned:
                        continue
                    if _count_holes(cand) > 0:
                        continue
                    if _count_nm_pairs(cand) >= baseline_nm:
                        continue
                    signature = sig(cand)
                    if signature in seen:
                        continue
                    seen.add(signature)
                    alternatives_from_resolve.append(cand)
                    alt_budget_resolve -= 1
                    if alt_budget_resolve <= 0:
                                break

    return {
        "days": days,
        "shifts": shifts,
        "stations": [st.get("name") for st in stations],
        "assignments": assignments,
        "alternatives": alternatives + alternatives_from_resolve,
        "status": "FEASIBLE" if res == cp_model.FEASIBLE else "OPTIMAL",
        "objective": solver.ObjectiveValue(),
    }


def solve_schedule_stream(
    config: Dict[str, Any],
    workers: List[Dict[str, Any]],
    time_limit_seconds: int = 30,
    max_nights_per_worker: int = 3,
    num_alternatives: int = 20,
    fixed_assignments: Dict[str, Dict[str, List[List[str]]]] | None = None,
    exclude_days: List[str] | None = None,
    random_seed: int | None = None,
):
    """Generator: yields incremental planning results: base then alternatives.
    Each yield is a dict with keys: type ('base'|'alternative'|'done'|'status'), and data.
    """
    logger = logging.getLogger("ai_solver")
    try:
        logger.info(
            "[STREAM] start time_limit=%s max_nights=%s num_alternatives=%s workers=%s",
            time_limit_seconds,
            max_nights_per_worker,
            num_alternatives,
            [w.get("name") for w in workers],
        )
    except Exception:
        pass
    built = build_cp_sat_schedule_model(
        config or {},
        workers,
        max_nights_per_worker=max_nights_per_worker,
        fixed_assignments=fixed_assignments,
        exclude_days=exclude_days,
        var_prefix="s",
        log_label="STREAM",
    )
    days, shifts, stations = built.days, built.shifts, built.stations
    model, x = built.model, built.x
    W, D, S, T = built.W, built.D, built.S, built.T
    name_to_w = built.name_to_w
    _is_night_name = is_night_shift_name
    _is_morning_name = is_morning_shift_name
    _is_noon_name = is_noon_shift_name

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(time_limit_seconds)
    solver.parameters.num_search_workers = _solver_num_search_workers()
    if random_seed is not None:
        solver.parameters.random_seed = max(1, int(random_seed))
        solver.parameters.randomize_search = True
    res = solver.Solve(model)
    if res not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        logger.warning("[STREAM] base solve failed status=%s", res)
        yield {"type": "status", "status": str(res)}
        yield {"type": "done"}
        return

    # Build base assignments
    base: Dict[str, Dict[str, List[List[str]]]] = {day: {sh: [[] for _ in stations] for sh in shifts} for day in days}
    for d, day_key in enumerate(days):
        for s, sh_name in enumerate(shifts):
            seen: set[str] = set()
            for t in range(len(stations)):
                required = int(stations[t].get("capacity", {}).get(day_key, {}).get(sh_name, 0))
                if required <= 0:
                    continue
                candidates: List[str] = []
                for w in W:
                    if solver.BooleanValue(x[(w, d, s, t)]):
                        nm = workers[w]["name"]
                        if nm in seen:
                            continue
                        candidates.append(nm)
                        seen.add(nm)
                        if len(candidates) >= required:
                            break
                base[day_key][sh_name][t] = candidates
                # Logs de diagnostic par cellule: rôles requis vs placés
                try:
                    rmap_raw = (stations[t].get("capacity_roles", {}) or {}).get(day_key, {}) or {}
                    rmap = rmap_raw.get(sh_name, {}) or {}
                    if rmap:
                        logger.info(
                            "[STREAM][CELL] day=%s shift=%s station=%s required=%d role_caps=%s placed=%s",
                            day_key,
                            sh_name,
                            stations[t].get("name"),
                            required,
                            rmap,
                            candidates,
                        )
                except Exception:
                    pass

    try:
        total_required = 0
        non_empty_cells = 0
        for t, st in enumerate(stations):
            cap = st.get("capacity", {})
            for d, day_key in enumerate(days):
                for s, sh_name in enumerate(shifts):
                    req = int(cap.get(day_key, {}).get(sh_name, 0))
                    total_required += req
                    if req > 0:
                        non_empty_cells += 1
        logger.info(
            "[STREAM] base ready: days=%d shifts=%d stations=%d required_total=%d non_empty_cells=%d",
            len(days), len(shifts), len(stations), total_required, non_empty_cells,
        )
    except Exception:
        pass
    # Greedy fill pass (stream): try to reduce holes without violating constraints and role rules
    try:
        # Helpers already defined: has_adjacent_in_candidate, role_map_for, can_assign_with_roles
        # availability and same-day presence helpers
        def _name_present_same_day(a: Dict[str, Dict[str, List[List[str]]]], dkey: str, nm: str) -> bool:
            for sname in shifts:
                for lst in (a.get(dkey, {}).get(sname, []) or []):
                    if nm in (lst or []):
                        return True
            return False
        # per-worker caps
        name_to_max = { (w.get("name") or ""): int(w.get("max_shifts") or 5) for w in workers }
        name_to_avail = { (w.get("name") or ""): (w.get("availability") or {}) for w in workers }
        # night counter
        def _is_night_name(name: str) -> bool:
            s = (name or "").strip().lower()
            return s == "22-06" or ("22" in s and "06" in s) or ("night" in s) or ("\u05dc\u05d9\u05dc\u05d4" in name)
        night_count: Dict[str, int] = {}
        assign_count: Dict[str, int] = {}
        for dk in days:
            for sn in shifts:
                for lst in (base.get(dk, {}).get(sn, []) or []):
                    for nm in (lst or []):
                        assign_count[nm] = assign_count.get(nm, 0) + 1
                        if _is_night_name(sn):
                            night_count[nm] = night_count.get(nm, 0) + 1
        added = 0
        for dk in days:
            for sn in shifts:
                per_station = base.get(dk, {}).get(sn, []) or []
                for t_idx in range(len(stations)):
                    req = int(stations[t_idx].get("capacity", {}).get(dk, {}).get(sn, 0))
                    if req <= 0:
                        continue
                    names_here = list(per_station[t_idx] or [])
                    if len(names_here) >= req:
                        continue
                    role_caps = role_map_for(t_idx, dk, sn)
                    # iterate all workers in fairness-friendly order (least assigned first)
                    candidates = [(w.get("name") or "") for w in workers]
                    candidates = [nm for nm in candidates if nm and nm not in names_here]
                    candidates.sort(key=lambda nm: (assign_count.get(nm, 0), nm))
                    while len(names_here) < req:
                        picked = None
                        need_role = bool(role_caps) and not can_assign_with_roles(names_here, "__probe__", role_caps)
                        for nm in candidates:
                            # availability
                            if sn not in (name_to_avail.get(nm, {}).get(dk) or []):
                                continue
                            # same-day / adjacency
                            if _name_present_same_day(base, dk, nm):
                                continue
                            if has_adjacent_in_candidate(base, nm, dk, sn):
                                continue
                            # per-worker caps
                            if assign_count.get(nm, 0) >= name_to_max.get(nm, 5):
                                continue
                            if _is_night_name(sn) and night_count.get(nm, 0) >= max_nights_per_worker:
                                continue
                            # role rule: only pick if feasible with roles
                            if role_caps and not can_assign_with_roles(names_here, nm, role_caps):
                                continue
                            picked = nm
                            break
                        if not picked:
                            break
                        names_here.append(picked)
                        base[dk][sn][t_idx] = names_here
                        assign_count[picked] = assign_count.get(picked, 0) + 1
                        if _is_night_name(sn):
                            night_count[picked] = night_count.get(picked, 0) + 1
                        added += 1
        if added:
            logger.info("[STREAM][GREEDY] trous comblés=%d", added)
        # Log compteurs après greedy stream
        _post_stream: Dict[str, int] = {}
        for _dk in days:
            for _sn in shifts:
                for _lst in (base.get(_dk, {}).get(_sn, []) or []):
                    for _nm in (_lst or []):
                        _post_stream[_nm] = _post_stream.get(_nm, 0) + 1
        _over_stream = {nm: (cnt, name_to_max.get(nm, 5)) for nm, cnt in _post_stream.items() if cnt > name_to_max.get(nm, 5)}
        if _over_stream:
            logger.warning("[STREAM][GREEDY][POST] workers over max_shifts: %s", _over_stream)
        else:
            logger.info("[STREAM][GREEDY][POST] all workers within max_shifts after greedy.")
    except Exception:
        pass
    # Garantie finale: aucun worker ne dépasse son max_shifts après le greedy
    enforce_max_shifts_on_plan(base, workers, label="solve_schedule_stream")
    sanitize_plan(base, days, shifts, stations)
    yield {"type": "base", "index": 0, "source": "BASE", "days": days, "shifts": shifts, "stations": [st.get("name") for st in stations], "assignments": base}

    # Now generate alternatives using existing functions on-the-fly
    # Reuse helper functions from above region
    def _names_in_cell(a: Dict[str, Dict[str, List[List[str]]]], dkey: str, sname: str, t_idx: int) -> List[str]:
        return list((a.get(dkey, {}).get(sname, []) or [[] for _ in stations])[t_idx] or [])

    def _write_cell(a: Dict[str, Dict[str, List[List[str]]]], dkey: str, sname: str, t_idx: int, names: List[str]):
        a[dkey][sname][t_idx] = list(names)

    shift_index = {sname: i for i, sname in enumerate(shifts)}
    day_index = {dk: i for i, dk in enumerate(days)}

    def has_adjacent_in_candidate(a: Dict[str, Dict[str, List[List[str]]]], nm: str, dk: str, sname: str) -> bool:
        di = day_index.get(dk, -1)
        si = shift_index.get(sname, -1)
        if di < 0 or si < 0:
            return False
        if si - 1 >= 0:
            prev = []
            for lst in (a.get(dk, {}).get(shifts[si - 1], []) or []):
                prev.extend(lst or [])
            if nm in prev:
                return True
        if si + 1 < len(shifts):
            nxt = []
            for lst in (a.get(dk, {}).get(shifts[si + 1], []) or []):
                nxt.extend(lst or [])
            if nm in nxt:
                return True
        if si == 0 and di - 1 >= 0:
            prev_day = days[di - 1]
            last_shift = shifts[-1]
            prev = []
            for lst in (a.get(prev_day, {}).get(last_shift, []) or []):
                prev.extend(lst or [])
            if nm in prev:
                return True
        if si == len(shifts) - 1 and di + 1 < len(days):
            next_day = days[di + 1]
            first = shifts[0]
            nxt = []
            for lst in (a.get(next_day, {}).get(first, []) or []):
                nxt.extend(lst or [])
            if nm in nxt:
                return True
        return False

    # base copy to start generating alternatives
    def _sanitize_assignments(a: Dict[str, Dict[str, List[List[str]]]]):
        for t_i, st in enumerate(stations):
            cap_map = st.get("capacity", {}) or {}
            for dkey in days:
                for sname in shifts:
                    req = int((cap_map.get(dkey, {}) or {}).get(sname, 0))
                    per = (a.get(dkey, {}).get(sname, []) or [])
                    if not per:
                        continue
                    for i in range(len(per)):
                        seen_local: set[str] = set()
                        uniq: List[str] = []
                        for nm in (per[i] or []):
                            v = (nm or "").strip()
                            if not v:
                                continue
                            if v in seen_local:
                                continue
                            seen_local.add(v)
                            uniq.append(v)
                            if req > 0 and len(uniq) >= req:
                                break
                        per[i] = uniq
    # Respect fixed cells in streaming too
    fixed_cells: Dict[Tuple[str, str, int], set[str]] = {}
    try:
        fa = fixed_assignments or {}
        for dkey in days:
            day_map = (fa.get(dkey) or {})
            for sname in shifts:
                per_station = (day_map.get(sname) or [])
                for t_idx in range(len(stations)):
                    names = []
                    try:
                        names = per_station[t_idx] if t_idx < len(per_station) else []
                    except Exception:
                        names = []
                    normed = { _norm_name_local(nm) for nm in (names or []) if str(nm or "").strip() }
                    if normed:
                        fixed_cells[(dkey, sname, t_idx)] = normed
    except Exception:
        fixed_cells = {}
    def _is_fixed_here(nm: str, dkey: str, sname: str, t_idx: int) -> bool:
        key = (dkey, sname, t_idx)
        if key not in fixed_cells:
            return False
        return _norm_name_local(nm) in fixed_cells[key]
    assignments = {dk: {sn: [list(lst) for lst in perst] for sn, perst in smap.items()} for dk, smap in base.items()}
    _sanitize_assignments(assignments)
    # Baseline coverage (number of assignments) and holes
    def _count_assigned(a: Dict[str, Dict[str, List[List[str]]]]) -> int:
        total = 0
        for dk in days:
            for sn in shifts:
                for lst in (a.get(dk, {}).get(sn, []) or []):
                    total += len(lst or [])
        return total
    baseline_coverage = _count_assigned(assignments)
    def _count_holes(a: Dict[str, Dict[str, List[List[str]]]]) -> int:
        total = 0
        for t_idx in range(len(stations)):
            cap = stations[t_idx].get("capacity", {}) or {}
            for dk in days:
                for sn in shifts:
                    req = int((cap.get(dk, {}) or {}).get(sn, 0))
                    if req <= 0:
                        continue
                    got = len(((a.get(dk, {}) or {}).get(sn, []) or [[] for _ in stations])[t_idx] or [])
                    if got < req:
                        total += (req - got)
        return total
    baseline_holes = _count_holes(assignments)
    seen: set = set()
    def sig(a: Dict[str, Dict[str, List[List[str]]]]):
        return tuple((dk, tuple((sn, tuple(tuple(lst) for lst in (a.get(dk, {}).get(sn, []) or []))) for sn in shifts)) for dk in days)
    seen.add(sig(assignments))

    # Role helpers for alternatives feasibility
    name_to_roles: Dict[str, List[str]] = { (w.get("name") or ""): [str(r) for r in (w.get("roles") or [])] for w in workers }
    def role_map_for(t_idx: int, dkey: str, sname: str) -> Dict[str, int]:
        cap_roles_all = (stations[t_idx].get("capacity_roles", {}) or {})
        return (cap_roles_all.get(dkey, {}) or {}).get(sname, {}) or {}
    def can_assign_with_roles(current_names: List[str], nm: str, role_caps: Dict[str, int]) -> bool:
        if not role_caps:
            return True
        caps = dict(role_caps)
        def fit_one(name: str) -> bool:
            roles = name_to_roles.get(name) or []
            for r in roles:
                if r in caps and caps[r] > 0:
                    caps[r] -= 1
                    return True
            return False
        # assign existing
        for name in current_names:
            if not fit_one(name):
                return False
        # then candidate
        return fit_one(nm)

    # Global availability map and validator for entire candidate plans
    name_to_avail_all: Dict[str, Dict[str, List[str]]] = { (w.get("name") or ""): (w.get("availability") or {}) for w in workers }
    def _avail_list_of(name: str, dkey: str) -> List[str]:
        day_val = (name_to_avail_all.get(name) or {}).get(dkey)
        return day_val if isinstance(day_val, list) else []
    def is_allowed(nm: str, dkey: str, sname: str) -> bool:
        return sname in _avail_list_of(nm, dkey)
    def _respects_availability_all(a: Dict[str, Dict[str, List[List[str]]]]) -> bool:
        for dk in days:
            for sn in shifts:
                per = (a.get(dk, {}).get(sn, []) or [])
                for lst in per:
                    for nm in (lst or []):
                        if sn not in _avail_list_of(nm, dk):
                            return False
        return True

    budget = int(num_alternatives or 20)
    produced = 0
    tried = 0
    skipped_duplicate = 0
    skipped_adjacency = 0
    skipped_capacity = 0
    logger.info("[STREAM] alternatives budget=%d baseline_coverage=%d baseline_holes=%d", budget, baseline_coverage, baseline_holes)
    def _required_of(t_idx: int, dkey: str, sname: str) -> int:
        return int((stations[t_idx].get("capacity", {}) or {}).get(dkey, {}).get(sname, 0))
    # Vérifie que la liste de noms satisfait les rôles requis d'une cellule
    def _meets_roles(names: List[str], t_idx: int, dkey: str, sname: str) -> bool:
        role_caps = role_map_for(t_idx, dkey, sname)
        if not role_caps:
            return True
        caps = dict(role_caps)
        for nm in names:
            roles = name_to_roles.get(nm) or []
            ok = False
            for r in roles:
                if r in caps and caps[r] > 0:
                    caps[r] -= 1
                    ok = True
                    break
            if not ok:
                # Ce nom ne couvre aucun rôle restant requis
                return False
        # Tous les noms ont pu être appariés aux rôles requis
        return True

    # Calcule la somme des déficits de rôles pour une cellule (combien de rôles requis manquent)
    def _role_deficit_for(names: List[str], t_idx: int, dkey: str, sname: str) -> int:
        role_caps = role_map_for(t_idx, dkey, sname)
        if not role_caps:
            return 0
        counts: Dict[str, int] = {}
        for nm in names:
            for r in (name_to_roles.get(nm) or []):
                counts[r] = counts.get(r, 0) + 1
        deficit = 0
        for r, cap in role_caps.items():
            have = counts.get(r, 0)
            if have < int(cap):
                deficit += int(cap) - have
        return deficit

    # (debug alternative detail logger removed)
    # New: alternatives that ONLY fill empty cells, respecting availability/requests and roles.
    try:
        # Build per-worker caps/availability based on current assignments
        name_to_avail_stream: Dict[str, Dict[str, List[str]]] = { (w.get("name") or ""): (w.get("availability") or {}) for w in workers }
        def _avail_list_stream_of(name: str, dkey: str) -> List[str]:
            day_val = (name_to_avail_stream.get(name) or {}).get(dkey)
            return day_val if isinstance(day_val, list) else []
        def _is_night_name_local(n: str) -> bool:
            s = (n or "").strip().lower()
            return s == "22-06" or ("22" in s and "06" in s) or ("night" in s) or ("\u05dc\u05d9\u05dc\u05d4" in n)
        assign_count_fill: Dict[str, int] = {}
        night_count_fill: Dict[str, int] = {}
        for dk in days:
            for sn in shifts:
                for lst in (assignments.get(dk, {}).get(sn, []) or []):
                    for nm in (lst or []):
                        assign_count_fill[nm] = assign_count_fill.get(nm, 0) + 1
                        if _is_night_name_local(sn):
                            night_count_fill[nm] = night_count_fill.get(nm, 0) + 1
        for dkey in days:
            if budget <= 0:
                break
            for t_idx, st in enumerate(stations):
                if budget <= 0:
                    break
                for sname in shifts:
                    if budget <= 0:
                        break
                    req = _required_of(t_idx, dkey, sname)
                    if req <= 0:
                        continue
                    names_here = (assignments.get(dkey, {}).get(sname, []) or [[] for _ in stations])[t_idx] or []
                    if len(names_here) >= req:
                        continue  # already full
                    # (debug cell logging removed)
                    # Propose one candidate per alternative (no movement of existing names)
                    for w in workers:
                        if budget <= 0:
                            break
                        nm = (w.get("name") or "").strip()
                        if not nm or nm in names_here:
                            continue
                        # respect availability/requests
                        if sname not in _avail_list_stream_of(nm, dkey):
                            continue
                        # same-day uniqueness and adjacency
                        # not already assigned same day across any station
                        present_same_day = False
                        for sn in shifts:
                            per = (assignments.get(dkey, {}).get(sn, []) or [])
                            for lst in per:
                                if nm in (lst or []):
                                    present_same_day = True
                                    break
                            if present_same_day:
                                break
                        if present_same_day:
                            continue
                        if has_adjacent_in_candidate(assignments, nm, dkey, sname):
                            continue
                        # per-worker caps
                        maxs = int(w.get("max_shifts") or 5)
                        if assign_count_fill.get(nm, 0) >= maxs:
                            continue
                        if _is_night_name_local(sname) and night_count_fill.get(nm, 0) >= max_nights_per_worker:
                            continue
                        # role feasibility
                        role_caps_here = role_map_for(t_idx, dkey, sname)
                        if role_caps_here and not can_assign_with_roles(list(names_here), nm, role_caps_here):
                            continue
                        # build candidate alt: add nm into this cell only
                        cand = {dk: {sn: [list(lst) for lst in perst] for sn, perst in smap.items()} for dk, smap in assignments.items()}
                        new_names = list(names_here) + [nm]
                        if len(set(new_names)) != len(new_names):
                            continue
                        cand[dkey][sname][t_idx] = new_names
                        signature = sig(cand)
                        tried += 1
                        if signature in seen:
                            skipped_duplicate += 1
                            continue
                        seen.add(signature)
                        # Skip any alternative that violates worker availability/requests globally
                        if not _respects_availability_all(cand):
                            continue
                        # (debug alternative assignment logging removed)
                        finalize_candidate_plan(cand, workers, days, shifts, stations, label="solve_schedule_stream:hole")
                        produced += 1
                        yield {"type": "alternative", "index": produced, "source": "HOLE", "assignments": cand}
                        budget -= 1
                        if budget <= 0:
                            break
        logger.info("[STREAM] hole-fill alternatives produced=%d", produced)
    except Exception as e:
        try:
            logger.exception("[STREAM] hole-fill alternatives error: %s", e)
        except Exception:
            pass
    if budget <= 0:
        yield {"type": "done"}
        return

    for dkey in days:
        if budget <= 0:
            break
        for t_idx, st in enumerate(stations):
            if budget <= 0:
                break
            non_empty = [sname for sname in shifts if _names_in_cell(assignments, dkey, sname, t_idx)]
            for s_from in non_empty:
                names_from = _names_in_cell(assignments, dkey, s_from, t_idx)
                req_from = _required_of(t_idx, dkey, s_from)
                for nm in names_from:
                    if _is_fixed_here(nm, dkey, s_from, t_idx):
                        continue
                    for s_to in shifts:
                        if s_to == s_from:
                            continue
                        cap_to = int(st.get("capacity", {}).get(dkey, {}).get(s_to, 0))
                        if cap_to <= 0:
                            skipped_capacity += 1
                            continue
                        names_to = _names_in_cell(assignments, dkey, s_to, t_idx)
                        # ensure destination has room and source keeps coverage
                        if nm in names_to or len(names_to) >= cap_to or (len(names_from) - 1) < req_from:
                            skipped_capacity += 1
                            continue
                        names_from_new = [n for n in names_from if n != nm]
                        # Vérifier que la source reste valide en termes de rôles
                        if not _meets_roles(names_from_new, t_idx, dkey, s_from):
                            skipped_capacity += 1
                            continue
                        # Ne pas augmenter le déficit de rôles (trous) combiné source+destination
                        base_def_src = _role_deficit_for(names_from, t_idx, dkey, s_from)
                        base_def_dst = _role_deficit_for(names_to, t_idx, dkey, s_to)
                        cand = {dk: {sn: [list(lst) for lst in perst] for sn, perst in smap.items()} for dk, smap in assignments.items()}
                        _write_cell(cand, dkey, s_from, t_idx, names_from_new)
                        if has_adjacent_in_candidate(cand, nm, dkey, s_to):
                            skipped_adjacency += 1
                            continue
                        # role feasibility for destination cell
                        role_caps = role_map_for(t_idx, dkey, s_to)
                        if role_caps and not can_assign_with_roles(list(names_to), nm, role_caps):
                            skipped_capacity += 1
                            continue
                        new_to3 = names_to + [nm]
                        if len(set(new_to3)) != len(new_to3):
                            skipped_capacity += 1
                            continue
                        _write_cell(cand, dkey, s_to, t_idx, new_to3)
                        # calcul du nouveau déficit combinaisons
                        new_def_src = _role_deficit_for(names_from_new, t_idx, dkey, s_from)
                        new_def_dst = _role_deficit_for(names_to + [nm], t_idx, dkey, s_to)
                        if (new_def_src + new_def_dst) > (base_def_src + base_def_dst):
                            skipped_capacity += 1
                            continue
                        # drop any alternative that reduces coverage
                        if _count_assigned(cand) < baseline_coverage:
                            skipped_capacity += 1
                            continue
                        # Candidate moins bonne: la rejeter, mais continuer à chercher d'autres alternatives.
                        if _count_holes(cand) > baseline_holes:
                            skipped_capacity += 1
                            continue
                        signature = sig(cand)
                        tried += 1
                        if signature in seen:
                            skipped_duplicate += 1
                            continue
                        seen.add(signature)
                        # Skip any alternative that violates worker availability/requests globally
                        if not _respects_availability_all(cand):
                            continue
                        finalize_candidate_plan(cand, workers, days, shifts, stations, label="solve_schedule_stream:swap")
                        produced += 1
                        yield {"type": "alternative", "index": produced, "source": "SWAP-INTRA", "assignments": cand}
                        budget -= 1
                        if budget <= 0:
                            break
                    if budget <= 0:
                        break
                if budget <= 0:
                    break
            if budget <= 0:
                break

    # cross-day swaps same station/shift (disabled)
    # (cross-day swap disabled silently)
    # previously cross-day swaps were generated here; now disabled.

    # If budget remains, try re-solving with nogoods to explore structurally different solutions
    if budget > 0:
        logger.info("[STREAM] re-solve phase, remaining budget=%d", budget)

        def _build_assignments_from_current_solver(sol: cp_model.CpSolver) -> Dict[str, Dict[str, List[List[str]]]]:
            out: Dict[str, Dict[str, List[List[str]]]] = {day: {sh: [[] for _ in stations] for sh in shifts} for day in days}
            for t, st in enumerate(stations):
                cap = st.get("capacity", {})
                for d, day_key in enumerate(days):
                    for s, sh_name in enumerate(shifts):
                        required = int(cap.get(day_key, {}).get(sh_name, 0))
                        if required <= 0:
                            continue
                        chosen: List[str] = []
                        for w in W:
                            if sol.BooleanValue(x[(w, d, s, t)]):
                                chosen.append(workers[w]["name"])
                        out[day_key][sh_name][t] = chosen[:required]
            return out

        def _current_true_lits(sol: cp_model.CpSolver) -> List[cp_model.IntVar]:
            lits: List[cp_model.IntVar] = []
            for w in W:
                for d in D:
                    for s in S:
                        for t in T:
                            if sol.BooleanValue(x[(w, d, s, t)]):
                                lits.append(x[(w, d, s, t)])
            return lits

        while budget > 0:
            true_lits = _current_true_lits(solver)
            if not true_lits:
                break
            # exclude current solution
            model.Add(sum(true_lits) <= len(true_lits) - 1)
            solver2 = cp_model.CpSolver()
            solver2.parameters.max_time_in_seconds = float(max(1, int(time_limit_seconds)))
            solver2.parameters.num_search_workers = _solver_num_search_workers()
            if random_seed is not None:
                solver2.parameters.random_seed = max(1, int(random_seed)) + max(1, tried)
                solver2.parameters.randomize_search = True
            res2 = solver2.Solve(model)
            if res2 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                logger.info("[STREAM] re-solve ended with status=%s", res2)
                break
            solver = solver2
            cand = _build_assignments_from_current_solver(solver)
            # baseline guards
            if _count_assigned(cand) < baseline_coverage:
                continue
            if _count_holes(cand) > baseline_holes:
                continue
            signature = sig(cand)
            tried += 1
            if signature in seen:
                skipped_duplicate += 1
                continue
            # adjacency guard
            ok = True
            for dkey in days:
                if not ok:
                    break
                for sname in shifts:
                    if not ok:
                        break
                    for t_idx in range(len(stations)):
                        cell = (cand.get(dkey, {}).get(sname, []) or [[] for _ in stations])[t_idx]
                        for nm in cell:
                            if has_adjacent_in_candidate(cand, nm, dkey, sname):
                                ok = False
                                skipped_adjacency += 1
                                break
                        if not ok:
                            break
            if not ok:
                continue
            seen.add(signature)
            # Skip any alternative that violates worker availability/requests globally
            if not _respects_availability_all(cand):
                continue
            finalize_candidate_plan(cand, workers, days, shifts, stations, label="solve_schedule_stream:resolve")
            produced += 1
            yield {"type": "alternative", "index": produced, "source": "RESOLVE", "assignments": cand}
            budget -= 1

    # Bonus pass: if budget remains, try to yield alternatives reducing morning+night pairs
    if budget > 0:
        def _is_morning_name_local(n: str) -> bool:
            s = (n or "").strip().lower()
            return ("בוקר" in n) or s.startswith("06") or ("06-14" in s)
        def _count_mn_pairs(a: Dict[str, Dict[str, List[List[str]]]]) -> int:
            cnt = 0
            for dk in days:
                # build flat per shift per day
                for nm in name_to_roles.keys():
                    has_m = False; has_n = False
                    for sn in shifts:
                        per = (a.get(dk, {}).get(sn, []) or [])
                        flat = []
                        for lst in per:
                            flat.extend(lst or [])
                        if _is_morning_name_local(sn) and nm in flat:
                            has_m = True
                        if _is_night_name(sn) and nm in flat:
                            has_n = True
                    if has_m and has_n:
                        cnt += 1
            return cnt
        baseline_mn = _count_mn_pairs(assignments)
        for dkey in days:
            if budget <= 0:
                break
            for t_idx, st in enumerate(stations):
                if budget <= 0:
                    break
                for sname in shifts:
                    if budget <= 0:
                        break
                    if not (_is_morning_name_local(sname) or _is_night_name(sname)):
                        continue
                    names_here = _names_in_cell(assignments, dkey, sname, t_idx)
                    for nm in list(names_here):
                        if _is_fixed_here(nm, dkey, sname, t_idx):
                            continue
                        # Try move to noon-like shift same day, same station
                        for s_to in shifts:
                            if budget <= 0:
                                break
                            to_is_noon = ("צהר" in s_to) or ("14-22" in s_to) or (s_to.strip().startswith("14"))
                            if not to_is_noon or s_to == sname:
                                continue
                            cap_to = int(st.get("capacity", {}).get(dkey, {}).get(s_to, 0))
                            if cap_to <= 0:
                                continue
                            names_to = _names_in_cell(assignments, dkey, s_to, t_idx)
                            if nm in names_to or len(names_to) >= cap_to:
                                continue
                            cand = {dk: {sn: [list(lst) for lst in perst] for sn, perst in smap.items()} for dk, smap in assignments.items()}
                            _write_cell(cand, dkey, sname, t_idx, [n for n in names_here if n != nm])
                            if _name_present_same_day(cand, dkey, nm):
                                continue
                            if not is_allowed(nm, dkey, s_to):
                                continue
                            if has_adjacent_in_candidate(cand, nm, dkey, s_to):
                                continue
                            rm_src = role_map_for(t_idx, dkey, sname)
                            if rm_src and not _meets_roles([n for n in names_here if n != nm], t_idx, dkey, sname):
                                continue
                            rm_dst = role_map_for(t_idx, dkey, s_to)
                            if rm_dst and not can_assign_with_roles(list(names_to), nm, rm_dst):
                                continue
                            new_to4 = names_to + [nm]
                            if len(set(new_to4)) != len(new_to4):
                                continue
                            _write_cell(cand, dkey, s_to, t_idx, new_to4)
                            if _count_assigned(cand) < baseline_coverage:
                                continue
                            if _count_holes(cand) > baseline_holes:
                                continue
                            if _count_mn_pairs(cand) >= baseline_mn:
                                continue
                            signature = sig(cand)
                            tried += 1
                            if signature in seen:
                                continue
                            seen.add(signature)
                            # Skip any alternative that violates worker availability/requests globally
                            if not _respects_availability_all(cand):
                                continue
                            finalize_candidate_plan(cand, workers, days, shifts, stations, label="solve_schedule_stream:bonus")
                            produced += 1
                            yield {"type": "alternative", "index": produced, "source": "BONUS", "assignments": cand}
                            budget -= 1
                            if budget <= 0:
                                break

    logger.info(
        "[STREAM] alternatives finished: produced=%d tried=%d skipped_duplicate=%d skipped_adjacency=%d skipped_capacity=%d remaining_budget=%d",
        produced, tried, skipped_duplicate, skipped_adjacency, skipped_capacity, budget,
    )
    yield {"type": "done"}



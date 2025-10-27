from __future__ import annotations

from typing import Any, Dict, List, Tuple
import logging

from ortools.sat.python import cp_model


DayKey = str  # "sun".."sat"
ShiftName = str  # e.g. "06-14", "14-22", "22-06"


def order_days(days: List[DayKey]) -> List[DayKey]:
    ref = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
    return [d for d in ref if d in set(days)]


def order_shifts(shift_names: List[ShiftName]) -> List[ShiftName]:
    # Try to order by typical pattern 06-14, 14-22, 22-06, else keep given order
    preferred = ["06-14", "14-22", "22-06"]
    present = [s for s in preferred if s in shift_names]
    others = [s for s in shift_names if s not in preferred]
    return present + others


def next_day(day: DayKey) -> DayKey | None:
    ref = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
    if day not in ref:
        return None
    idx = ref.index(day)
    return ref[idx + 1] if idx < len(ref) - 1 else None


def build_capacities_from_config(config: Dict[str, Any]) -> Tuple[List[DayKey], List[ShiftName], List[Dict[str, Any]]]:
    """Return (days, shifts, stations) where stations[i] has name, per-day per-shift capacity
    and per-role capacities.

    stations[i] = {
        "name": str,
        "capacity": {day: {shift: int}},  # total required (sum of role counts)
        "capacity_roles": {day: {shift: {role_name: count}}},
    }
    """
    stations_cfg = (config or {}).get("stations", []) or []
    # Collect days and shifts
    all_days: set[DayKey] = set()
    all_shifts: set[ShiftName] = set()
    stations: List[Dict[str, Any]] = []

    def norm_role(name: Any) -> str:
        s = str(name or "").strip()
        # caractères invisibles fréquents (RTL marks, NBSP)
        s = s.replace("\u200f", "").replace("\u200e", "").replace("\xa0", " ")
        # normalisation simple guillemets/quotes
        s = s.replace('"', "'")
        return s

    for st in stations_cfg:
        name = st.get("name") or "Station"
        per_day_custom = bool(st.get("perDayCustom"))
        uniform_roles = bool(st.get("uniformRoles"))
        station_workers = int(st.get("workers") or 0)
        cap: Dict[DayKey, Dict[ShiftName, int]] = {}
        cap_roles: Dict[DayKey, Dict[ShiftName, Dict[str, int]]] = {}

        if per_day_custom:
            day_overrides = st.get("dayOverrides") or {}
            for day, ov in day_overrides.items():
                active = bool((ov or {}).get("active", False))
                if not active:
                    continue
                all_days.add(day)
                shifts_list = (ov or {}).get("shifts") or []
                for sh in shifts_list:
                    if not sh or not sh.get("enabled"):
                        continue
                    sh_name = sh.get("name")
                    # roles per shift (if uniform_roles -> from station roles, else from shift roles)
                    role_counts: Dict[str, int] = {}
                    if uniform_roles:
                        for r in (st.get("roles") or []):
                            if r and r.get("enabled"):
                                cnt = int(r.get("count") or 0)
                                if cnt > 0:
                                    role_counts[norm_role(r.get("name"))] = cnt
                    else:
                        for r in (sh.get("roles") or []):
                            if r and r.get("enabled"):
                                cnt = int(r.get("count") or 0)
                                if cnt > 0:
                                    role_counts[norm_role(r.get("name"))] = cnt
                    # Total requis: priorité au paramètre "workers" (ou station_workers en mode uniforme),
                    # sinon somme des rôles actifs
                    required_total = int(station_workers if uniform_roles else (sh.get("workers") or 0))
                    if required_total <= 0:
                        required_total = sum(role_counts.values())
                    if required_total <= 0:
                        continue
                    all_shifts.add(sh_name)
                    cap.setdefault(day, {})[sh_name] = required_total
                    if role_counts:
                        cap_roles.setdefault(day, {}).setdefault(sh_name, {}).update(role_counts)
        else:
            # global days and shifts
            days_map = st.get("days") or {}
            shifts_list = (st.get("shifts") or [])
            for day, active in days_map.items():
                if not active:
                    continue
                all_days.add(day)
                for sh in shifts_list:
                    if not sh or not sh.get("enabled"):
                        continue
                    sh_name = sh.get("name")
                    role_counts: Dict[str, int] = {}
                    if uniform_roles:
                        for r in (st.get("roles") or []):
                            if r and r.get("enabled"):
                                cnt = int(r.get("count") or 0)
                                if cnt > 0:
                                    role_counts[norm_role(r.get("name"))] = cnt
                    else:
                        for r in (sh.get("roles") or []):
                            if r and r.get("enabled"):
                                cnt = int(r.get("count") or 0)
                                if cnt > 0:
                                    role_counts[norm_role(r.get("name"))] = cnt
                    required_total = int(station_workers if uniform_roles else (sh.get("workers") or 0))
                    if required_total <= 0:
                        required_total = sum(role_counts.values())
                    if required_total <= 0:
                        continue
                    all_shifts.add(sh_name)
                    cap.setdefault(day, {})[sh_name] = required_total
                    if role_counts:
                        cap_roles.setdefault(day, {}).setdefault(sh_name, {}).update(role_counts)

        stations.append({"name": name, "capacity": cap, "capacity_roles": cap_roles})

    days = order_days(list(all_days)) or ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
    shifts = order_shifts(list(all_shifts)) or ["06-14", "14-22", "22-06"]
    return days, shifts, stations


def solve_schedule(
    config: Dict[str, Any],
    workers: List[Dict[str, Any]],
    time_limit_seconds: int = 10,
    max_nights_per_worker: int = 3,
    num_alternatives: int = 20,
) -> Dict[str, Any]:
    """Return a schedule dict with assignments per day/shift/station as worker name lists.

    workers: [{"id": int, "name": str, "max_shifts": int, "availability": {day: [shift]}}]
    """
    logger = logging.getLogger("ai_solver")
    days, shifts, stations = build_capacities_from_config(config or {})
    logger.info("Start solve: days=%s shifts=%s stations=%s workers=%s", days, shifts, [st.get("name") for st in stations], [w.get("name") for w in workers])

    model = cp_model.CpModel()

    W = list(range(len(workers)))
    D = list(range(len(days)))
    S = list(range(len(shifts)))
    T = list(range(len(stations)))

    # Normalisation des libellés de rôle pour aligner config et profils employés
    def _norm_role_local(name: Any) -> str:
        s = str(name or "").strip()
        s = s.replace("\u200f", "").replace("\u200e", "").replace("\xa0", " ")
        s = s.replace('"', "'")
        return s
    worker_roles_norm: List[set[str]] = [
        { _norm_role_local(r) for r in (workers[w].get("roles") or []) }
        for w in W
    ]

    # Decision variables: x[w,d,s,t] in {0,1} worker w works shift s at station t on day d
    x: Dict[Tuple[int, int, int, int], cp_model.IntVar] = {}
    for w in W:
        for d in D:
            for s in S:
                for t in T:
                    # Availability filter: if worker not available for (day, shift), force 0
                    day_key = days[d]
                    sh_name = shifts[s]
                    avail = (workers[w].get("availability") or {}).get(day_key, [])
                    allowed = sh_name in avail if isinstance(avail, list) else False
                    var = model.NewBoolVar(f"x_w{w}_d{d}_s{s}_t{t}")
                    if not allowed:
                        model.Add(var == 0)
                    x[(w, d, s, t)] = var

    # Capacity per station/day/shift
    for t, st in enumerate(stations):
        cap = st.get("capacity", {})
        cap_roles = st.get("capacity_roles", {}) or {}
        for d, day_key in enumerate(days):
            day_caps = cap.get(day_key, {})
            for s, sh_name in enumerate(shifts):
                required = int(day_caps.get(sh_name, 0))
                if required <= 0:
                    # Force no assignment on this cell
                    for w in W:
                        model.Add(x[(w, d, s, t)] == 0)
                    continue
                # Réservation stricte des rôles avec pénalité de pénurie: les non-rôles ne comblent jamais un manque de rôle
                # Construire la map des rôles demandés (normalisés)
                role_map_raw: Dict[str, int] = (cap_roles.get(day_key, {}) or {}).get(sh_name, {}) or {}
                role_map_norm: Dict[str, int] = {_norm_role_local(k): int(v) for k, v in role_map_raw.items()}
                # Borne supérieure par défaut (on ajustera avec la pénurie de rôles)
                if role_map_norm:
                    # Variables de pénurie par rôle (shortfall)
                    shortfalls: List[cp_model.IntVar] = []
                    for idx_r, (r_name, r_cap) in enumerate(role_map_norm.items()):
                        cap_int = max(0, int(r_cap))
                        short = model.NewIntVar(0, cap_int, f"short_t{t}_d{d}_s{s}_r{idx_r}")
                        shortfalls.append(short)
                        # Compte des porteurs du rôle
                        role_count = sum(x[(w, d, s, t)] for w in W if r_name in worker_roles_norm[w])
                        # Rôle rempli + pénurie == capacité de rôle
                        model.Add(role_count + short == cap_int)
                    # Total pénurie toutes catégories
                    short_total = shortfalls[0] if len(shortfalls) == 1 else model.NewIntVar(0, sum(role_map_norm.values()), f"short_total_t{t}_d{d}_s{s}")
                    if len(shortfalls) > 1:
                        model.Add(short_total == sum(shortfalls))
                    # Empêcher qu'un non-rôle comble la pénurie: limiter la couverture totale
                    model.Add(sum(x[(w, d, s, t)] for w in W) <= required - short_total)
                else:
                    # Pas de rôles requis: simple borne supérieure sur la cellule
                    model.Add(sum(x[(w, d, s, t)] for w in W) <= required)

    # At most one shift per day per worker (across all stations and shifts)
    for w in W:
        for d in D:
            model.Add(sum(x[(w, d, s, t)] for s in S for t in T) <= 1)

    # No adjacent shifts for a worker (including across day boundary)
    # Build adjacency pairs (d,s,t1),(d,s+1,t2) across any stations
    for w in W:
        for d in D:
            # same day adjacents between consecutive shifts
            for s in range(len(S) - 1):
                model.Add(sum(x[(w, d, s, t)] for t in T) + sum(x[(w, d, s + 1, t)] for t in T) <= 1)
        # across day boundary: last shift of day d and first of day d+1
        for d in range(len(D) - 1):
            model.Add(sum(x[(w, d, len(S) - 1, t)] for t in T) + sum(x[(w, d + 1, 0, t)] for t in T) <= 1)

    # Max nights per worker (shift name exactly "22-06")
    def _is_night_name(name: str) -> bool:
        s = (name or "").strip().lower()
        return (
            s == "22-06" or ("22" in s and "06" in s) or ("night" in s) or ("לילה" in name)
        )
    night_indices = [i for i, nm in enumerate(shifts) if _is_night_name(nm)]
    if night_indices:
        for w in W:
            model.Add(
                sum(x[(w, d, s, t)] for d in D for s in night_indices for t in T)
                <= max_nights_per_worker
            )

    # No 7 consecutive days for a worker: over a 7-day window sum <= 6
    for w in W:
        day_work = [model.NewBoolVar(f"y_w{w}_d{d}") for d in D]
        for d in D:
            lits = [x[(w, d, s, t)] for s in S for t in T]
            if lits:
                # OR over all shifts/stations that day
                model.AddMaxEquality(day_work[d], lits)
            else:
                model.Add(day_work[d] == 0)
        if len(D) >= 7:
            for start in range(0, len(D) - 6):
                model.Add(sum(day_work[d] for d in range(start, start + 7)) <= 6)

    # Per-worker weekly max
    for w in W:
        max_shifts = int(workers[w].get("max_shifts") or 5)
        model.Add(sum(x[(w, d, s, t)] for d in D for s in S for t in T) <= max_shifts)

    # Objective: maximize coverage, + mild fairness term to approach targets
    coverage = sum(x[(w, d, s, t)] for w in W for d in D for s in S for t in T)

    # Fairness: introduce deviation variables to target = max_shifts (soft)
    fairness_terms: List[cp_model.IntVar] = []
    assigned_vars: List[cp_model.IntVar] = []
    for w in W:
        assigned = model.NewIntVar(0, len(D), f"assign_count_w{w}")
        model.Add(assigned == sum(x[(w, d, s, t)] for d in D for s in S for t in T))
        assigned_vars.append(assigned)
        target = int(workers[w].get("max_shifts") or 5)
        # deviation = |assigned - target| using two non-negative vars
        over = model.NewIntVar(0, len(D), f"dev_over_w{w}")
        under = model.NewIntVar(0, len(D), f"dev_under_w{w}")
        model.Add(assigned - target == over - under)
        dev = model.NewIntVar(0, len(D), f"dev_abs_w{w}")
        model.Add(dev == over + under)
        fairness_terms.append(dev)

    # Minimize maximum deviation as priority after coverage
    max_dev = model.NewIntVar(0, len(D), "max_dev")
    for dev in fairness_terms:
        model.Add(dev <= max_dev)

    # Maximize coverage strongly, then minimize max deviation, then total deviation
    # Weights chosen to keep lexicographic-like priority: coverage >> max_dev >> sum(dev)
    model.Maximize(1000000 * coverage - 10000 * max_dev - 100 * sum(fairness_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(time_limit_seconds)
    solver.parameters.num_search_workers = 8

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
    logger.info("Base plan: cells=%d required_total=%d", non_empty_cells, total_required)
    def _count_assigned(a: Dict[str, Dict[str, List[List[str]]]]) -> int:
        total = 0
        for dk, sm in a.items():
            for sn, per_st in sm.items():
                for lst in per_st:
                    total += len(lst or [])
        return total
    base_total_assigned = _count_assigned(assignments)

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
        solver2.parameters.num_search_workers = 8
        res2 = solver2.Solve(model)
        if res2 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            break
        # Switch main solver reference to new solution for extraction convenience
        solver = solver2
        cand_assign = build_assignments_from_solver()
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
    alt_budget = max(0, int(num_alternatives)) or 20
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
                            # respect availability for destinations
                            if not is_allowed(nm1, dkey, s2):
                                continue
                            if not is_allowed(nm2, dkey, s1):
                                continue
                            cand = {dk: {sn: [list(lst) for lst in per_st] for sn, per_st in smap.items()} for dk, smap in assignments.items()}
                            # remove nm1 from s1, nm2 from s2
                            _write_cell(cand, dkey, s1, t_idx, [n for n in names1 if n != nm1] + [nm2])
                            _write_cell(cand, dkey, s2, t_idx, [n for n in names2 if n != nm2] + [nm1])
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
                        _write_cell(cand, dkey, s_to, t_idx, names_to + [nm])
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
                        # respect availability when swapping days
                        if not is_allowed(nm1, d2, sname):
                            continue
                        if not is_allowed(nm2, d1, sname):
                            continue
                            cand = {dk: {sn: [list(lst) for lst in per_st] for sn, per_st in smap.items()} for dk, smap in assignments.items()}
                            # swap dans sname @ t_idx entre d1 et d2
                            _write_cell(cand, d1, sname, t_idx, [n for n in names1 if n != nm1] + [nm2])
                            _write_cell(cand, d2, sname, t_idx, [n for n in names2 if n != nm2] + [nm1])
                            # Unicité par jour déjà assurée (1 garde/jour) car même shift/station
                            if has_adjacent_in_candidate(cand, nm2, d1, sname):
                                continue
                            if has_adjacent_in_candidate(cand, nm1, d2, sname):
                                continue
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
    time_limit_seconds: int = 10,
    max_nights_per_worker: int = 3,
    num_alternatives: int = 20,
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
    # Build base model and plan using existing function but reusing logic inline for streaming
    days, shifts, stations = build_capacities_from_config(config or {})

    model = cp_model.CpModel()
    W = list(range(len(workers)))
    D = list(range(len(days)))
    S = list(range(len(shifts)))
    T = list(range(len(stations)))

    x: Dict[Tuple[int, int, int, int], cp_model.IntVar] = {}

    # Normalisation locale des rôles et cache par employé
    def _norm_role_local(name: Any) -> str:
        s = str(name or "").strip()
        s = s.replace("\u200f", "").replace("\u200e", "").replace("\xa0", " ")
        s = s.replace('"', "'")
        return s
    worker_roles_norm: List[set[str]] = [
        { _norm_role_local(r) for r in (workers[w].get("roles") or []) }
        for w in W
    ]
    for w in W:
        for d in D:
            for s in S:
                for t in T:
                    day_key = days[d]
                    sh_name = shifts[s]
                    avail = (workers[w].get("availability") or {}).get(day_key, [])
                    allowed = sh_name in avail if isinstance(avail, list) else False
                    var = model.NewBoolVar(f"x_w{w}_d{d}_s{s}_t{t}")
                    if not allowed:
                        model.Add(var == 0)
                    x[(w, d, s, t)] = var

    # capacity
    for t, st in enumerate(stations):
        cap = st.get("capacity", {})
        cap_roles = st.get("capacity_roles", {}) or {}
        for d, day_key in enumerate(days):
            day_caps = cap.get(day_key, {})
            for s, sh_name in enumerate(shifts):
                required = int(day_caps.get(sh_name, 0))
                if required <= 0:
                    for w in W:
                        model.Add(x[(w, d, s, t)] == 0)
                    continue
                # Réservation stricte des rôles (comme solve_schedule):
                role_map_raw: Dict[str, int] = (cap_roles.get(day_key, {}) or {}).get(sh_name, {}) or {}
                role_map_norm: Dict[str, int] = {_norm_role_local(k): int(v) for k, v in role_map_raw.items()}
                if role_map_norm:
                    shortfalls: List[cp_model.IntVar] = []
                    for idx_r, (r_name, r_cap) in enumerate(role_map_norm.items()):
                        cap_int = max(0, int(r_cap))
                        short = model.NewIntVar(0, cap_int, f"s_short_t{t}_d{d}_s{s}_r{idx_r}")
                        shortfalls.append(short)
                        role_count = sum(x[(w, d, s, t)] for w in W if r_name in worker_roles_norm[w])
                        model.Add(role_count + short == cap_int)
                    short_total = shortfalls[0] if len(shortfalls) == 1 else model.NewIntVar(0, sum(role_map_norm.values()), f"s_short_total_t{t}_d{d}_s{s}")
                    if len(shortfalls) > 1:
                        model.Add(short_total == sum(shortfalls))
                    model.Add(sum(x[(w, d, s, t)] for w in W) <= required - short_total)
                else:
                    model.Add(sum(x[(w, d, s, t)] for w in W) <= required)

    # one shift per day per worker
    for w in W:
        for d in D:
            model.Add(sum(x[(w, d, s, t)] for s in S for t in T) <= 1)

    # no adjacent
    for w in W:
        for d in D:
            for s in range(len(S) - 1):
                model.Add(sum(x[(w, d, s, t)] for t in T) + sum(x[(w, d, s + 1, t)] for t in T) <= 1)
        for d in range(len(D) - 1):
            model.Add(sum(x[(w, d, len(S) - 1, t)] for t in T) + sum(x[(w, d + 1, 0, t)] for t in T) <= 1)

    # nights ≤ max_nights_per_worker
    def _is_night_name(name: str) -> bool:
        s = (name or "").strip().lower()
        return s == "22-06" or ("22" in s and "06" in s) or ("night" in s) or ("\u05dc\u05d9\u05dc\u05d4" in name)
    night_indices = [i for i, nm in enumerate(shifts) if _is_night_name(nm)]
    if night_indices:
        for w in W:
            model.Add(sum(x[(w, d, s, t)] for d in D for s in night_indices for t in T) <= max_nights_per_worker)

    # per-week max per worker (target)
    for w in W:
        max_sh = int(workers[w].get("max_shifts") or 5)
        model.Add(sum(x[(w, d, s, t)] for d in D for s in S for t in T) <= max_sh)

    # objective coverage + fairness
    coverage = sum(x[(w, d, s, t)] for w in W for d in D for s in S for t in T)
    fairness_terms: List[cp_model.IntVar] = []
    assigned_vars: List[cp_model.IntVar] = []
    for w in W:
        assigned = model.NewIntVar(0, len(D), f"assign_count_w{w}")
        model.Add(assigned == sum(x[(w, d, s, t)] for d in D for s in S for t in T))
        assigned_vars.append(assigned)
        target = int(workers[w].get("max_shifts") or 5)
        over = model.NewIntVar(0, len(D), f"dev_over_w{w}")
        under = model.NewIntVar(0, len(D), f"dev_under_w{w}")
        model.Add(assigned - target == over - under)
        dev = model.NewIntVar(0, len(D), f"dev_abs_w{w}")
        model.Add(dev == over + under)
        fairness_terms.append(dev)
    max_dev = model.NewIntVar(0, len(D), "max_dev")
    for dev in fairness_terms:
        model.Add(dev <= max_dev)
    model.Maximize(1000000 * coverage - 10000 * max_dev - 100 * sum(fairness_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(time_limit_seconds)
    solver.parameters.num_search_workers = 8
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
    yield {"type": "base", "days": days, "shifts": shifts, "stations": [st.get("name") for st in stations], "assignments": base}

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
    assignments = {dk: {sn: [list(lst) for lst in perst] for sn, perst in smap.items()} for dk, smap in base.items()}
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

    budget = int(num_alternatives or 20)
    produced = 0
    tried = 0
    skipped_duplicate = 0
    skipped_adjacency = 0
    skipped_capacity = 0
    logger.info("[STREAM] alternatives budget=%d", budget)
    for dkey in days:
        if budget <= 0:
            break
        for t_idx, st in enumerate(stations):
            if budget <= 0:
                break
            non_empty = [sname for sname in shifts if _names_in_cell(assignments, dkey, sname, t_idx)]
            for s_from in non_empty:
                names_from = _names_in_cell(assignments, dkey, s_from, t_idx)
                for nm in names_from:
                    for s_to in shifts:
                        if s_to == s_from:
                            continue
                        cap_to = int(st.get("capacity", {}).get(dkey, {}).get(s_to, 0))
                        if cap_to <= 0:
                            skipped_capacity += 1
                            continue
                        names_to = _names_in_cell(assignments, dkey, s_to, t_idx)
                        if nm in names_to or len(names_to) >= cap_to:
                            skipped_capacity += 1
                            continue
                        cand = {dk: {sn: [list(lst) for lst in perst] for sn, perst in smap.items()} for dk, smap in assignments.items()}
                        _write_cell(cand, dkey, s_from, t_idx, [n for n in names_from if n != nm])
                        if has_adjacent_in_candidate(cand, nm, dkey, s_to):
                            skipped_adjacency += 1
                            continue
                        # role feasibility for destination cell
                        role_caps = role_map_for(t_idx, dkey, s_to)
                        if role_caps and not can_assign_with_roles(list(names_to), nm, role_caps):
                            skipped_capacity += 1
                            continue
                        _write_cell(cand, dkey, s_to, t_idx, names_to + [nm])
                        signature = sig(cand)
                        tried += 1
                        if signature in seen:
                            skipped_duplicate += 1
                            continue
                        seen.add(signature)
                        produced += 1
                        yield {"type": "alternative", "index": produced, "assignments": cand}
                        budget -= 1
                        if budget <= 0:
                            break
                    if budget <= 0:
                        break
                if budget <= 0:
                    break
            if budget <= 0:
                break

    # cross-day swaps same station/shift
    for sname in shifts:
        if budget <= 0:
            break
        for t_idx in range(len(stations)):
            if budget <= 0:
                break
            for i in range(len(days)):
                if budget <= 0:
                    break
                d1 = days[i]
                n1 = _names_in_cell(assignments, d1, sname, t_idx)
                if not n1:
                    continue
                for j in range(i + 1, len(days)):
                    if budget <= 0:
                        break
                    d2 = days[j]
                    n2 = _names_in_cell(assignments, d2, sname, t_idx)
                    if not n2:
                        continue
                    for nm1 in n1:
                        for nm2 in n2:
                            if nm1 == nm2:
                                continue
                            cand = {dk: {sn: [list(lst) for lst in perst] for sn, perst in smap.items()} for dk, smap in assignments.items()}
                            newd1 = [n for n in n1 if n != nm1] + [nm2]
                            newd2 = [n for n in n2 if n != nm2] + [nm1]
                            # role feasibility for both cells after swap
                            rm1 = role_map_for(t_idx, d1, sname)
                            rm2 = role_map_for(t_idx, d2, sname)
                            if (rm1 and not can_assign_with_roles([x for x in newd1 if x != nm2], nm2, rm1)) or (rm2 and not can_assign_with_roles([x for x in newd2 if x != nm1], nm1, rm2)):
                                continue
                            _write_cell(cand, d1, sname, t_idx, newd1)
                            _write_cell(cand, d2, sname, t_idx, newd2)
                            if has_adjacent_in_candidate(cand, nm2, d1, sname) or has_adjacent_in_candidate(cand, nm1, d2, sname):
                                skipped_adjacency += 1
                                continue
                            signature = sig(cand)
                            tried += 1
                            if signature in seen:
                                skipped_duplicate += 1
                                continue
                            seen.add(signature)
                            produced += 1
                            yield {"type": "alternative", "index": produced, "assignments": cand}
                            budget -= 1
                            if budget <= 0:
                                break
                        if budget <= 0:
                            break
                    if budget <= 0:
                        break
            if budget <= 0:
                break

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
            solver2.parameters.num_search_workers = 8
            res2 = solver2.Solve(model)
            if res2 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                logger.info("[STREAM] re-solve ended with status=%s", res2)
                break
            solver = solver2
            cand = _build_assignments_from_current_solver(solver)
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
            produced += 1
            yield {"type": "alternative", "index": produced, "assignments": cand}
            budget -= 1

    logger.info(
        "[STREAM] alternatives finished: produced=%d tried=%d skipped_duplicate=%d skipped_adjacency=%d skipped_capacity=%d remaining_budget=%d",
        produced, tried, skipped_duplicate, skipped_adjacency, skipped_capacity, budget,
    )
    yield {"type": "done"}



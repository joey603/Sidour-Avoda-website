"""Construction partagée du modèle CP-SAT de planning (sync + stream)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Tuple
import logging

from ortools.sat.python import cp_model

from .ai_solver_utils import (
    _shift_kind_pref_penalty,
    _shift_slot_pref_hits,
    build_capacities_from_config,
)


def is_night_shift_name(name: str) -> bool:
    s = (name or "").strip().lower()
    return s == "22-06" or ("22" in s and "06" in s) or ("night" in s) or ("לילה" in (name or ""))


def is_morning_shift_name(name: str) -> bool:
    s = (name or "").strip().lower()
    return ("בוקר" in (name or "")) or s.startswith("06") or ("06-14" in s)


def is_noon_shift_name(name: str) -> bool:
    s = (name or "").strip().lower()
    return ("צהר" in (name or "")) or s.startswith("14") or ("14-22" in s)


def _norm_role_local(name: Any) -> str:
    s = str(name or "").strip()
    s = s.replace("\u200f", "").replace("\u200e", "").replace("\xa0", " ")
    s = s.replace('"', "'")
    return s


def _norm_name_local(name: Any) -> str:
    s = str(name or "").strip()
    s = s.replace("\u200f", "").replace("\u200e", "").replace("\xa0", " ")
    return s


@dataclass
class CpSatScheduleModel:
    model: cp_model.CpModel
    x: Dict[Tuple[int, int, int, int], cp_model.IntVar]
    days: List[str]
    shifts: List[str]
    stations: List[Dict[str, Any]]
    workers: List[Dict[str, Any]]
    W: List[int]
    D: List[int]
    S: List[int]
    T: List[int]
    name_to_w: Dict[str, int]
    pre_assign: Dict[Tuple[int, int, int], set[int]]
    morning_indices: List[int]
    noon_indices: List[int]
    night_indices: List[int]


def build_cp_sat_schedule_model(
    config: Dict[str, Any],
    workers: List[Dict[str, Any]],
    *,
    max_nights_per_worker: int = 3,
    fixed_assignments: Dict[str, Dict[str, List[List[str]]]] | None = None,
    exclude_days: List[str] | None = None,
    var_prefix: str = "",
    log_label: str = "SOLVER",
) -> CpSatScheduleModel:
    """Construit le modèle CP-SAT commun (contraintes hard + objectif soft).

    Basé sur l'ancienne construction sync (inclut la contrainte ≤6 jours / fenêtre de 7).
    `var_prefix` évite les collisions de noms de variables si besoin (ex. stream).
    """
    logger = logging.getLogger("ai_solver")
    p = f"{var_prefix}_" if var_prefix else ""

    days, shifts, stations = build_capacities_from_config(config or {}, exclude_days)
    model = cp_model.CpModel()

    W = list(range(len(workers)))
    D = list(range(len(days)))
    S = list(range(len(shifts)))
    T = list(range(len(stations)))

    role_shortfalls_total: List[cp_model.IntVar] = []

    worker_roles_norm: List[set[str]] = [
        {_norm_role_local(r) for r in (workers[w].get("roles") or [])}
        for w in W
    ]

    name_to_w: Dict[str, int] = {_norm_name_local(workers[i].get("name")): i for i in range(len(workers))}

    pre_assign: Dict[Tuple[int, int, int], set[int]] = {}
    fixed_assignments = fixed_assignments or {}
    worker_fixed_slots: Dict[Tuple[int, int], int] = {}
    fixed_conflicts: List[str] = []
    for d, day_key in enumerate(days):
        day_map = fixed_assignments.get(day_key) or {}
        for s, sh_name in enumerate(shifts):
            per_station = day_map.get(sh_name) or []
            for t in range(len(stations)):
                names = []
                try:
                    names = per_station[t] if t < len(per_station) else []
                except Exception:
                    names = []
                if not names:
                    continue
                for nm in names:
                    nm_str = _norm_name_local(nm)
                    if not nm_str:
                        continue
                    widx = name_to_w.get(nm_str)
                    if widx is None:
                        continue
                    slot_key = (widx, d, s)
                    if slot_key in worker_fixed_slots and worker_fixed_slots[slot_key] != t:
                        conflict_msg = (
                            f"worker '{nm_str}' fixed on day={day_key} shift={sh_name} "
                            f"at station {worker_fixed_slots[slot_key]} AND {t} simultaneously"
                        )
                        fixed_conflicts.append(conflict_msg)
                        logger.warning("[%s][FIXED] Contradictory fixed assignment ignored: %s", log_label, conflict_msg)
                        continue
                    worker_fixed_slots[slot_key] = t
                    pre_assign.setdefault((d, s, t), set()).add(widx)
    if fixed_conflicts:
        logger.warning(
            "[%s][FIXED] %d contradictory fixed assignments detected and skipped",
            log_label,
            len(fixed_conflicts),
        )

    x: Dict[Tuple[int, int, int, int], cp_model.IntVar] = {}
    for w in W:
        for d in D:
            for s in S:
                for t in T:
                    day_key = days[d]
                    sh_name = shifts[s]
                    avail = (workers[w].get("availability") or {}).get(day_key, [])
                    allowed = sh_name in avail if isinstance(avail, list) else False
                    station_allowed_workers = stations[t].get("allowed_workers") or []
                    allowed_for_station = (
                        True
                        if not station_allowed_workers
                        else (str(workers[w].get("name") or "") in set(station_allowed_workers))
                    )
                    worker_station_allow = [
                        i
                        for i in (workers[w].get("allowed_station_indices") or [])
                        if isinstance(i, int) and i in range(len(stations))
                    ]
                    allowed_for_worker_station = (not worker_station_allow) or (t in worker_station_allow)
                    var = model.NewBoolVar(f"{p}x_w{w}_d{d}_s{s}_t{t}")
                    if (d, s, t) in pre_assign and w in pre_assign[(d, s, t)]:
                        model.Add(var == 1)
                    else:
                        if not allowed or not allowed_for_station or not allowed_for_worker_station:
                            model.Add(var == 0)
                    x[(w, d, s, t)] = var

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
                role_map_raw: Dict[str, int] = (cap_roles.get(day_key, {}) or {}).get(sh_name, {}) or {}
                role_map_norm: Dict[str, int] = {_norm_role_local(k): int(v) for k, v in role_map_raw.items()}
                if role_map_norm:
                    all_required_roles = set(role_map_norm.keys())
                    for w in W:
                        if not (worker_roles_norm[w] & all_required_roles):
                            model.Add(x[(w, d, s, t)] == 0)
                    shortfalls: List[cp_model.IntVar] = []
                    for idx_r, (r_name, r_cap) in enumerate(role_map_norm.items()):
                        cap_int = max(0, int(r_cap))
                        short = model.NewIntVar(0, cap_int, f"{p}short_t{t}_d{d}_s{s}_r{idx_r}")
                        shortfalls.append(short)
                        role_count = sum(x[(w, d, s, t)] for w in W if r_name in worker_roles_norm[w])
                        model.Add(role_count + short == cap_int)
                    short_total = (
                        shortfalls[0]
                        if len(shortfalls) == 1
                        else model.NewIntVar(0, sum(role_map_norm.values()), f"{p}short_total_t{t}_d{d}_s{s}")
                    )
                    if len(shortfalls) > 1:
                        model.Add(short_total == sum(shortfalls))
                    role_shortfalls_total.append(short_total)
                    model.Add(sum(x[(w, d, s, t)] for w in W) <= required)
                else:
                    model.Add(sum(x[(w, d, s, t)] for w in W) <= required)

    for w in W:
        for d in D:
            for s in S:
                model.Add(sum(x[(w, d, s, t)] for t in T) <= 1)

    for w in W:
        for d in D:
            for s in range(len(S) - 1):
                model.Add(sum(x[(w, d, s, t)] for t in T) + sum(x[(w, d, s + 1, t)] for t in T) <= 1)
        for d in range(len(D) - 1):
            model.Add(sum(x[(w, d, len(S) - 1, t)] for t in T) + sum(x[(w, d + 1, 0, t)] for t in T) <= 1)

    night_indices = [i for i, nm in enumerate(shifts) if is_night_shift_name(nm)]
    if night_indices:
        for w in W:
            model.Add(
                sum(x[(w, d, s, t)] for d in D for s in night_indices for t in T)
                <= max_nights_per_worker
            )

    morning_indices = [i for i, nm in enumerate(shifts) if is_morning_shift_name(nm)]
    noon_indices = [i for i, nm in enumerate(shifts) if is_noon_shift_name(nm)]
    morning_night_pairs: List[cp_model.IntVar] = []
    noon_next_morning_pairs: List[cp_model.IntVar] = []
    if morning_indices and night_indices:
        for w in W:
            for d in D:
                morn_any = model.NewBoolVar(f"{p}mn_morn_any_w{w}_d{d}")
                night_any = model.NewBoolVar(f"{p}mn_night_any_w{w}_d{d}")
                morn_lits = [x[(w, d, s, t)] for s in morning_indices for t in T]
                night_lits = [x[(w, d, s, t)] for s in night_indices for t in T]
                if morn_lits:
                    model.AddMaxEquality(morn_any, morn_lits)
                else:
                    model.Add(morn_any == 0)
                if night_lits:
                    model.AddMaxEquality(night_any, night_lits)
                else:
                    model.Add(night_any == 0)
                both = model.NewBoolVar(f"{p}mn_both_w{w}_d{d}")
                model.Add(both <= morn_any)
                model.Add(both <= night_any)
                model.Add(both >= morn_any + night_any - 1)
                morning_night_pairs.append(both)
        for w in W:
            for d in range(len(D) - 1):
                noon_any = model.NewBoolVar(f"{p}mn2_noon_any_w{w}_d{d}")
                next_morn_any = model.NewBoolVar(f"{p}mn2_morn_any_w{w}_d{d+1}")
                noon_lits = [x[(w, d, s, t)] for s in noon_indices for t in T]
                morn_lits_next = [x[(w, d + 1, s, t)] for s in morning_indices for t in T]
                if noon_lits:
                    model.AddMaxEquality(noon_any, noon_lits)
                else:
                    model.Add(noon_any == 0)
                if morn_lits_next:
                    model.AddMaxEquality(next_morn_any, morn_lits_next)
                else:
                    model.Add(next_morn_any == 0)
                both2 = model.NewBoolVar(f"{p}mn2_both_w{w}_d{d}")
                model.Add(both2 <= noon_any)
                model.Add(both2 <= next_morn_any)
                model.Add(both2 >= noon_any + next_morn_any - 1)
                noon_next_morning_pairs.append(both2)

    for w in W:
        day_work = [model.NewBoolVar(f"{p}y_w{w}_d{d}") for d in D]
        for d in D:
            lits = [x[(w, d, s, t)] for s in S for t in T]
            if lits:
                model.AddMaxEquality(day_work[d], lits)
            else:
                model.Add(day_work[d] == 0)
        if len(D) >= 7:
            for start in range(0, len(D) - 6):
                model.Add(sum(day_work[d] for d in range(start, start + 7)) <= 6)

    for w in W:
        max_shifts = int(workers[w].get("max_shifts") or 5)
        model.Add(sum(x[(w, d, s, t)] for d in D for s in S for t in T) <= max_shifts)

    site_limit_count = 0
    for w in W:
        site_limits = workers[w].get("site_limits") or []
        for limit in site_limits:
            t_indices = [t for t in limit.get("station_indices", []) if t in range(len(stations))]
            site_max = int(limit.get("max") or 5)
            if t_indices:
                model.Add(sum(x[(w, d, s, t)] for d in D for s in S for t in t_indices) <= site_max)
                site_limit_count += 1
    if site_limit_count > 0:
        logger.info(
            "[%s] applied %d per-site max_shifts constraints for multi-site workers",
            log_label,
            site_limit_count,
        )

    coverage = sum(x[(w, d, s, t)] for w in W for d in D for s in S for t in T)
    max_possible_assignments = max(1, len(D) * len(S) * len(T))
    max_target_shifts = max([int(workers[w].get("max_shifts") or 5) for w in W], default=1)
    max_deviation_bound = max(max_possible_assignments, max_target_shifts)
    fairness_terms: List[cp_model.IntVar] = []
    for w in W:
        assigned = model.NewIntVar(0, max_possible_assignments, f"{p}assign_count_w{w}")
        model.Add(assigned == sum(x[(w, d, s, t)] for d in D for s in S for t in T))
        target = int(workers[w].get("max_shifts") or 5)
        over = model.NewIntVar(0, max_deviation_bound, f"{p}dev_over_w{w}")
        under = model.NewIntVar(0, max_deviation_bound, f"{p}dev_under_w{w}")
        model.Add(assigned - target == over - under)
        dev = model.NewIntVar(0, max_deviation_bound, f"{p}dev_abs_w{w}")
        model.Add(dev == over + under)
        fairness_terms.append(dev)

    max_dev = model.NewIntVar(0, max_deviation_bound, f"{p}max_dev")
    for dev in fairness_terms:
        model.Add(dev <= max_dev)

    total_role_shortfall = sum(role_shortfalls_total) if role_shortfalls_total else 0
    mn_penalty = sum(morning_night_pairs) if morning_night_pairs else 0
    nm_penalty = sum(noon_next_morning_pairs) if noon_next_morning_pairs else 0
    skp_penalty = _shift_kind_pref_penalty(
        model,
        x,
        workers,
        W,
        D,
        T,
        morning_indices,
        noon_indices,
        night_indices,
        var_prefix=f"{p}skp" if p else "skp",
    )
    ssp_hits = _shift_slot_pref_hits(
        model,
        x,
        workers,
        W,
        days,
        shifts,
        T,
        var_prefix=f"{p}ssp" if p else "ssp",
    )

    model.Maximize(
        1000000 * coverage
        - 10000 * max_dev
        - 100 * sum(fairness_terms)
        - 10 * total_role_shortfall
        - 5 * mn_penalty
        - 5 * nm_penalty
        - 3 * skp_penalty
        + 2 * ssp_hits
    )

    return CpSatScheduleModel(
        model=model,
        x=x,
        days=days,
        shifts=shifts,
        stations=stations,
        workers=workers,
        W=W,
        D=D,
        S=S,
        T=T,
        name_to_w=name_to_w,
        pre_assign=pre_assign,
        morning_indices=morning_indices,
        noon_indices=noon_indices,
        night_indices=night_indices,
    )

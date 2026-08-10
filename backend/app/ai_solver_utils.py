"""Helpers purs et post-traitement pour le solveur de planning (CP-SAT).

Extraits de ai_solver pour alléger le module principal sans changer le comportement.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple
import logging
import os

from ortools.sat.python import cp_model


DayKey = str  # "sun".."sat"
ShiftName = str  # e.g. "06-14", "14-22", "22-06"


def _solver_num_search_workers() -> int:
    """Cap solver parallelism to avoid saturating the host."""
    try:
        env_value = int(os.getenv("PLANNING_SOLVER_NUM_WORKERS", "4"))
    except Exception:
        env_value = 4
    return max(1, min(env_value, 4))


def _shift_kind_pref_penalty(
    model: cp_model.CpModel,
    x: Dict[Tuple[int, int, int, int], cp_model.IntVar],
    workers: List[dict],
    W: List[int],
    D: List[int],
    T: List[int],
    morning_indices: List[int],
    noon_indices: List[int],
    night_indices: List[int],
    *,
    var_prefix: str = "skp",
) -> Any:
    """Soft |assigned_kind - target| pour shift_kind_prefs (matin/midi/nuit).

    Ne modifie aucune contrainte hard (disponibilité, multi-site, תפקידים).
    Retourne 0 si aucune préférence n'est définie.
    """
    kind_indices = {
        "morning": morning_indices,
        "noon": noon_indices,
        "night": night_indices,
    }
    max_assign = max(1, len(D) * max(1, max(len(morning_indices), len(noon_indices), len(night_indices), 1)) * max(1, len(T)))
    devs: List[cp_model.IntVar] = []
    for w in W:
        prefs = workers[w].get("shift_kind_prefs")
        if not isinstance(prefs, dict):
            continue
        for kind, indices in kind_indices.items():
            if kind not in prefs or not indices:
                continue
            try:
                target = max(0, min(6, int(prefs.get(kind) or 0)))
            except (TypeError, ValueError):
                continue
            assigned = model.NewIntVar(0, max_assign, f"{var_prefix}_cnt_w{w}_{kind}")
            model.Add(assigned == sum(x[(w, d, s, t)] for d in D for s in indices for t in T))
            over = model.NewIntVar(0, max_assign, f"{var_prefix}_over_w{w}_{kind}")
            under = model.NewIntVar(0, max_assign, f"{var_prefix}_under_w{w}_{kind}")
            model.Add(assigned - target == over - under)
            dev = model.NewIntVar(0, max_assign, f"{var_prefix}_dev_w{w}_{kind}")
            model.Add(dev == over + under)
            devs.append(dev)
    return sum(devs) if devs else 0


def _shift_slot_pref_hits(
    model: cp_model.CpModel,
    x: Dict[Tuple[int, int, int, int], cp_model.IntVar],
    workers: List[dict],
    W: List[int],
    days: List[str],
    shifts: List[str],
    T: List[int],
    *,
    var_prefix: str = "ssp",
) -> Any:
    """Soft : récompense les affectations sur créneaux jour×משמרת préférés.

    `shift_slot_prefs` = {dayKey: [shiftName, ...]}. Soft only — ne force rien.
    Retourne la somme des hits (à maximiser), ou 0 si aucune préférence.
    """
    day_index = {d: i for i, d in enumerate(days)}
    shift_index = {s: i for i, s in enumerate(shifts)}
    hit_lits: List[cp_model.IntVar] = []
    for w in W:
        prefs = workers[w].get("shift_slot_prefs")
        if not isinstance(prefs, dict):
            continue
        for day_key, shift_names in prefs.items():
            d = day_index.get(str(day_key or "").strip().lower())
            if d is None:
                continue
            if not isinstance(shift_names, list):
                continue
            for raw_name in shift_names:
                s = shift_index.get(str(raw_name or "").strip())
                if s is None:
                    continue
                # Un hit si le worker est assigné à ce (jour, shift) sur au moins un poste.
                lits = [x[(w, d, s, t)] for t in T if (w, d, s, t) in x]
                if not lits:
                    continue
                hit = model.NewBoolVar(f"{var_prefix}_hit_w{w}_d{d}_s{s}")
                model.AddMaxEquality(hit, lits)
                hit_lits.append(hit)
    return sum(hit_lits) if hit_lits else 0


def order_days(days: List[DayKey]) -> List[DayKey]:
    ref = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
    return [d for d in ref if d in set(days)]


def order_shifts(shift_names: List[ShiftName]) -> List[ShiftName]:
    """Order shifts as morning → noon → night when possible, else keep input order.

    Heuristics align with frontend detectShiftKind:
      - morning: contains "בוקר" or starts with 06 or exactly "06-14"
      - noon: contains "צהריים/צהרים" or starts with 14 or exactly "14-22"
      - night: contains "לילה" or starts with 22 or exactly "22-06" or contains "night"
    """
    def is_morning(name: str) -> bool:
        n = (name or "").strip()
        low = n.lower()
        return ("בוקר" in n) or low.startswith("06") or ("06-14" in low)

    def is_noon(name: str) -> bool:
        n = (name or "").strip()
        low = n.lower()
        return ("צהר" in n) or low.startswith("14") or ("14-22" in low)

    def is_night(name: str) -> bool:
        n = (name or "").strip()
        low = n.lower()
        return ("לילה" in n) or ("night" in low) or low.startswith("22") or ("22-06" in low)

    morning = [s for s in shift_names if is_morning(s)]
    noon = [s for s in shift_names if is_noon(s)]
    night = [s for s in shift_names if is_night(s)]
    used = set(morning + noon + night)
    others = [s for s in shift_names if s not in used]
    # Preserve within-class original order
    return morning + noon + night + others


def next_day(day: DayKey) -> DayKey | None:
    ref = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
    if day not in ref:
        return None
    idx = ref.index(day)
    return ref[idx + 1] if idx < len(ref) - 1 else None


def build_capacities_from_config(config: Dict[str, Any], exclude_days: List[DayKey] | None = None) -> Tuple[List[DayKey], List[ShiftName], List[Dict[str, Any]]]:
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

    def enabled(value: Any) -> bool:
        return value is not False

    def base_day_active(st_cfg: Dict[str, Any], day_key: DayKey) -> bool:
        days_map = st_cfg.get("days") or {}
        if isinstance(days_map, dict) and day_key in days_map:
            return bool(days_map.get(day_key) is not False)
        return True

    def effective_day_override(st_cfg: Dict[str, Any], day_key: DayKey) -> Dict[str, Any]:
        raw_overrides = st_cfg.get("dayOverrides") or {}
        ov = raw_overrides.get(day_key) if isinstance(raw_overrides, dict) else None
        if isinstance(ov, dict):
            shifts_value = ov.get("shifts") or st_cfg.get("shifts") or []
            return {
                **ov,
                "active": ov.get("active", True) is not False,
                "shifts": shifts_value,
            }
        return {
            "active": base_day_active(st_cfg, day_key),
            "shifts": st_cfg.get("shifts") or [],
        }

    excl_set = set(exclude_days or [])

    for st in stations_cfg:
        name = st.get("name") or "Station"
        per_day_custom = bool(st.get("perDayCustom"))
        uniform_roles = bool(st.get("uniformRoles"))
        station_workers = int(st.get("workers") or 0)
        cap: Dict[DayKey, Dict[ShiftName, int]] = {}
        cap_roles: Dict[DayKey, Dict[ShiftName, Dict[str, int]]] = {}

        if per_day_custom:
            raw_day_overrides = st.get("dayOverrides") or {}
            day_keys = set(raw_day_overrides.keys()) if isinstance(raw_day_overrides, dict) else set()
            days_map = st.get("days") or {}
            if isinstance(days_map, dict):
                day_keys.update(days_map.keys())
            if not day_keys:
                day_keys.update(["sun", "mon", "tue", "wed", "thu", "fri", "sat"])
            for day in day_keys:
                ov = effective_day_override(st, day)
                active = bool((ov or {}).get("active", True))
                if not active:
                    continue
                all_days.add(day)
                shifts_list = (ov or {}).get("shifts") or []
                for sh in shifts_list:
                    if not sh or not enabled(sh.get("enabled")):
                        continue
                    sh_name = sh.get("name")
                    # roles per shift (if uniform_roles -> from station roles, else from shift roles)
                    role_counts: Dict[str, int] = {}
                    if uniform_roles:
                        for r in (st.get("roles") or []):
                            if r and enabled(r.get("enabled")):
                                cnt = int(r.get("count") or 0)
                                if cnt > 0:
                                    role_counts[norm_role(r.get("name"))] = cnt
                    else:
                        for r in (sh.get("roles") or []):
                            if r and enabled(r.get("enabled")):
                                cnt = int(r.get("count") or 0)
                                if cnt > 0:
                                    role_counts[norm_role(r.get("name"))] = cnt
                    # Total requis: priorité au paramètre "workers" (ou station_workers en mode uniforme),
                    # sinon somme des rôles actifs
                    required_total = int(station_workers if uniform_roles else (sh.get("workers") or 0))
                    if day in excl_set:
                        required_total = 0
                        role_counts = {}
                    if required_total <= 0:
                        required_total = sum(role_counts.values())
                    if required_total <= 0:
                        # S'assurer que la shift existe avec capacité 0
                        all_shifts.add(sh_name)
                        cap.setdefault(day, {})[sh_name] = 0
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
                    if not sh or not enabled(sh.get("enabled")):
                        continue
                    sh_name = sh.get("name")
                    role_counts: Dict[str, int] = {}
                    if uniform_roles:
                        for r in (st.get("roles") or []):
                            if r and enabled(r.get("enabled")):
                                cnt = int(r.get("count") or 0)
                                if cnt > 0:
                                    role_counts[norm_role(r.get("name"))] = cnt
                    else:
                        for r in (sh.get("roles") or []):
                            if r and enabled(r.get("enabled")):
                                cnt = int(r.get("count") or 0)
                                if cnt > 0:
                                    role_counts[norm_role(r.get("name"))] = cnt
                    required_total = int(station_workers if uniform_roles else (sh.get("workers") or 0))
                    if day in excl_set:
                        required_total = 0
                        role_counts = {}
                    if required_total <= 0:
                        required_total = sum(role_counts.values())
                    if required_total <= 0:
                        all_shifts.add(sh_name)
                        cap.setdefault(day, {})[sh_name] = 0
                        continue
                    all_shifts.add(sh_name)
                    cap.setdefault(day, {})[sh_name] = required_total
                    if role_counts:
                        cap_roles.setdefault(day, {}).setdefault(sh_name, {}).update(role_counts)

        stations.append({
            "name": name,
            "capacity": cap,
            "capacity_roles": cap_roles,
            "allowed_workers": [str(x) for x in (st.get("allowedWorkers") or []) if str(x or "").strip()],
            "site_id": st.get("siteId"),
            "site_name": st.get("siteName"),
            "site_station_index": st.get("siteStationIndex"),
        })

    days = order_days(list(all_days)) or ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
    shifts = order_shifts(list(all_shifts)) or ["06-14", "14-22", "22-06"]
    return days, shifts, stations


def enforce_max_shifts_on_plan(
    assignments: Dict[str, Dict[str, List[List[str]]]],
    workers: List[Dict[str, Any]],
    label: str = "",
) -> None:
    """Retire les affectations qui dépassent max_shifts par worker.
    Parcourt le plan dans l'ordre naturel (jour → shift → station) et supprime
    l'occurrence en trop dès que le compteur d'un worker atteint son plafond.
    Mutates in-place.
    """
    _log = logging.getLogger("ai_solver")
    name_to_max: Dict[str, int] = {
        str(w.get("name") or "").strip(): int(w.get("max_shifts") or 5)
        for w in workers
        if str(w.get("name") or "").strip()
    }
    count: Dict[str, int] = {}
    removed: Dict[str, int] = {}
    for day_key, day_map in assignments.items():
        for sh_name, per_station in day_map.items():
            for t_idx, cell in enumerate(per_station):
                if not isinstance(cell, list):
                    continue
                kept: List[str] = []
                for nm in cell:
                    nm = str(nm or "").strip()
                    if not nm:
                        continue
                    max_s = name_to_max.get(nm, 5)
                    if count.get(nm, 0) >= max_s:
                        removed[nm] = removed.get(nm, 0) + 1
                        _log.warning(
                            "[MAX_SHIFTS][%s] removed extra assignment: worker=%r day=%s shift=%s station_idx=%d (count=%d max=%d)",
                            label, nm, day_key, sh_name, t_idx, count.get(nm, 0), max_s,
                        )
                        continue
                    count[nm] = count.get(nm, 0) + 1
                    kept.append(nm)
                cell[:] = kept
    if removed:
        _log.warning("[MAX_SHIFTS][%s] total removed=%d workers=%s", label, sum(removed.values()), dict(removed))


def sanitize_plan(assignments: Dict[str, Dict[str, List[List[str]]]],
                  days: List[DayKey],
                  shifts: List[ShiftName],
                  stations: List[Dict[str, Any]]) -> None:
    """Ensure no duplicate worker appears twice within the same cell and trim to capacity.
    This function mutates the passed assignments in-place.
    """
    for t_idx, st in enumerate(stations):
        cap_map: Dict[str, Dict[str, int]] = st.get("capacity", {}) or {}
        for d in days:
            day_map = assignments.get(d)
            if day_map is None:
                continue
            for s in shifts:
                per_station = (day_map.get(s) or [])
                if not isinstance(per_station, list) or t_idx >= len(per_station):
                    continue
                required = int((cap_map.get(d, {}) or {}).get(s, 0))
                cell = per_station[t_idx] or []
                seen: set[str] = set()
                uniq: List[str] = []
                for nm in cell:
                    v = (str(nm or "").strip())
                    if not v:
                        continue
                    if v in seen:
                        continue
                    seen.add(v)
                    uniq.append(v)
                    if required > 0 and len(uniq) >= required:
                        break
                per_station[t_idx] = uniq


def finalize_candidate_plan(
    assignments: Dict[str, Dict[str, List[List[str]]]],
    workers: List[Dict[str, Any]],
    days: List[DayKey],
    shifts: List[ShiftName],
    stations: List[Dict[str, Any]],
    label: str = "",
) -> None:
    """Post-traitement final homogène pour toute variante renvoyée au client.
    Garantit d'abord max_shifts, puis unicité/capacité par cellule.
    """
    enforce_max_shifts_on_plan(assignments, workers, label=label)
    sanitize_plan(assignments, days, shifts, stations)
    try:
        _log = logging.getLogger("ai_solver")
        name_to_max: Dict[str, int] = {
            str(w.get("name") or "").strip(): int(w.get("max_shifts") or 5)
            for w in workers
            if str(w.get("name") or "").strip()
        }
        counts: Dict[str, int] = {}
        for day_map in assignments.values():
            if not isinstance(day_map, dict):
                continue
            for per_station in day_map.values():
                if not isinstance(per_station, list):
                    continue
                for cell in per_station:
                    if not isinstance(cell, list):
                        continue
                    for nm in cell:
                        clean = str(nm or "").strip()
                        if not clean:
                            continue
                        counts[clean] = counts.get(clean, 0) + 1
        over = {
            nm: {"total": cnt, "max_shifts": name_to_max.get(nm, 5)}
            for nm, cnt in counts.items()
            if cnt > name_to_max.get(nm, 5)
        }
        if over:
            _log.warning("[MAX_SHIFTS][%s] workers still over max after finalize: %s", label, over)
    except Exception:
        pass


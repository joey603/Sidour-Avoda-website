"""Site config validation / normalization."""

from __future__ import annotations

import logging

from fastapi import HTTPException

logger = logging.getLogger("ai_solver")

def validate_site_config(config: dict):
    stations = (config or {}).get("stations", []) or []
    for st in stations:
        uniform_roles = bool(st.get("uniformRoles"))
        station_workers = int(st.get("workers") or 0)
        # Uniform: sum roles <= station workers
        if uniform_roles:
            total_roles = 0
            for r in (st.get("roles") or []):
                try:
                    if r and r.get("enabled"):
                        total_roles += int(r.get("count") or 0)
                except Exception:
                    pass
            if total_roles > station_workers:
                raise HTTPException(status_code=400, detail="סך התפקידים חייב להיות קטן או שווה למספר העובדים לעמדה")
        # Global shifts (non-uniform): sum roles per shift <= shift workers
        if not uniform_roles:
            for sh in (st.get("shifts") or []):
                if not sh or not sh.get("enabled"):
                    continue
                sh_workers = int(sh.get("workers") or 0)
                total_roles = 0
                for r in (sh.get("roles") or []):
                    try:
                        if r and r.get("enabled"):
                            total_roles += int(r.get("count") or 0)
                    except Exception:
                        pass
                if total_roles > sh_workers:
                    raise HTTPException(status_code=400, detail="סך התפקידים למשמרת חייב להיות קטן או שווה למספר העובדים למשמרת")
        # Per-day overrides: same rule per active day and shift when non-uniform
        if st.get("perDayCustom"):
            day_overrides = st.get("dayOverrides") or {}
            for day_key, ov in (day_overrides or {}).items():
                if not ov or not ov.get("active"):
                    continue
                if not uniform_roles:
                    for sh in (ov.get("shifts") or []):
                        if not sh or not sh.get("enabled"):
                            continue
                        sh_workers = int(sh.get("workers") or 0)
                        total_roles = 0
                        for r in (sh.get("roles") or []):
                            try:
                                if r and r.get("enabled"):
                                    total_roles += int(r.get("count") or 0)
                            except Exception:
                                pass
                        if total_roles > sh_workers:
                            raise HTTPException(status_code=400, detail="סך התפקידים למשמרת חייב להיות קטן או שווה למספר העובדים למשמרת")

def normalize_site_config(config: dict) -> dict:
    """
    Normalise la config pour éviter les incohérences:
    - si somme des rôles > workers, augmenter workers pour matcher la somme des rôles
    """
    cfg = config or {}
    stations = (cfg.get("stations", []) or [])
    for st in stations:
        if not isinstance(st, dict):
            continue
        uniform_roles = bool(st.get("uniformRoles"))

        def _sum_roles(role_list: list) -> int:
            total = 0
            for r in (role_list or []):
                try:
                    if r and r.get("enabled"):
                        total += int(r.get("count") or 0)
                except Exception:
                    pass
            return total

        if uniform_roles:
            station_workers = int(st.get("workers") or 0)
            total_roles = _sum_roles(st.get("roles") or [])
            if total_roles > station_workers:
                st["workers"] = total_roles

        if not uniform_roles:
            for sh in (st.get("shifts") or []):
                if not sh or not isinstance(sh, dict) or not sh.get("enabled"):
                    continue
                sh_workers = int(sh.get("workers") or 0)
                total_roles = _sum_roles(sh.get("roles") or [])
                if total_roles > sh_workers:
                    sh["workers"] = total_roles

        if st.get("perDayCustom") and not uniform_roles:
            day_overrides = st.get("dayOverrides") or {}
            for _day_key, ov in (day_overrides or {}).items():
                if not ov or not isinstance(ov, dict) or not ov.get("active"):
                    continue
                for sh in (ov.get("shifts") or []):
                    if not sh or not isinstance(sh, dict) or not sh.get("enabled"):
                        continue
                    sh_workers = int(sh.get("workers") or 0)
                    total_roles = _sum_roles(sh.get("roles") or [])
                    if total_roles > sh_workers:
                        sh["workers"] = total_roles

    return cfg


def _safe_site_config(raw_config: object, *, site_id: int | None = None) -> dict:
    if isinstance(raw_config, dict):
        return raw_config
    if raw_config is not None:
        logger.warning(
            "[SITE_CONFIG] ignoring invalid config for site=%s type=%s",
            site_id,
            type(raw_config).__name__,
        )
    return {}


"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getWeekKeyISO } from "../lib/week";
import {
  getCachedWeekPlan,
  prefetchAdjacentWeeks,
  setCachedWeekPlan,
} from "../lib/week-nav-cache";
import { loadWeekPlanForSiteWeek, type V2WeekPlanData } from "../lib/week-plan-fetch";
import { readLinkedPlansFromMemory } from "../lib/multi-site-linked-memory";

export type { V2WeekPlanData } from "../lib/week-plan-fetch";

type WeekPlanHookOptions = {
  /** Navigation in-app entre sites liés : une seule requête `auto` (mémoire session = source de vérité). */
  lightweightNav?: boolean;
  /** Navigation depuis le rail multi-sites : éviter le gros fetch initial, le plan vient de sessionStorage. */
  skipInitialReload?: boolean;
  initialPlan?: V2WeekPlanData;
};

/** Charge le תכנון שמור via un GET `scope=resolve` (shared/director/auto). */
export function usePlanningV2WeekPlan(
  siteId: string,
  weekStart: Date,
  preferredScope?: "director" | "shared" | "auto" | null,
  options?: WeekPlanHookOptions,
) {
  const [plan, setPlan] = useState<V2WeekPlanData>(() => {
    if (options?.initialPlan) return options.initialPlan;
    const cached = getCachedWeekPlan(siteId, getWeekKeyISO(weekStart));
    return cached ?? null;
  });
  const [loading, setLoading] = useState(() => !options?.skipInitialReload && !plan);
  const hasLoadedOnceRef = useRef(!!options?.skipInitialReload || !!plan);
  const prevWeekIsoRef = useRef<string | null>(getWeekKeyISO(weekStart));
  const loadReq = useRef(0);
  const lightweightNav = options?.lightweightNav === true;
  const preferredScopeRef = useRef(preferredScope);
  preferredScopeRef.current = preferredScope;

  const reload = useCallback(
    async (opts?: { silent?: boolean; preferredScope?: "director" | "shared" | "auto" | null }) => {
      const silent = opts?.silent === true;
      const id = Number(siteId);
      if (!Number.isFinite(id) || id <= 0) {
        setPlan(null);
        setLoading(false);
        return;
      }
      const isoWeek = getWeekKeyISO(weekStart);
      const req = ++loadReq.current;
      if (silent) {
        const cached = getCachedWeekPlan(siteId, isoWeek);
        if (cached) setPlan(cached);
      } else {
        setLoading(true);
      }
      try {
        const effectivePreferredScope = opts?.preferredScope ?? preferredScopeRef.current;
        const holdForAlts = Math.max(0, Number(readLinkedPlansFromMemory(weekStart)?.activeAltIndex || 0)) > 0;
        const next = await loadWeekPlanForSiteWeek(siteId, isoWeek, effectivePreferredScope, {
          lightweightNav,
          omitWorkers: true,
          onBase:
            silent || holdForAlts
              ? undefined
              : (base) => {
                  if (req !== loadReq.current) return;
                  setPlan(base);
                  setLoading(false);
                },
        });
        if (req !== loadReq.current) return;
        setPlan(next);
        setCachedWeekPlan(siteId, isoWeek, next);
        prefetchAdjacentWeeks(siteId, weekStart, effectivePreferredScope);
      } catch {
        if (req !== loadReq.current) return;
        setPlan(null);
      } finally {
        // Toujours couper le loading si c’est la requête courante (un reload silent
        // peut remplacer un premier chargement non-silent et sinon l’overlay reste coincé).
        if (req === loadReq.current) setLoading(false);
      }
    },
    [siteId, weekStart, lightweightNav],
  );

  useEffect(() => {
    if (options?.skipInitialReload) {
      setPlan(options.initialPlan ?? null);
      setLoading(false);
      hasLoadedOnceRef.current = true;
      prevWeekIsoRef.current = getWeekKeyISO(weekStart);
      return;
    }
    const isoWeek = getWeekKeyISO(weekStart);
    const weekChanged = prevWeekIsoRef.current != null && prevWeekIsoRef.current !== isoWeek;
    prevWeekIsoRef.current = isoWeek;
    // Animation au changement de semaine ; silent seulement pour un refresh même semaine.
    const silent = hasLoadedOnceRef.current && !weekChanged;
    hasLoadedOnceRef.current = true;
    void reload({ silent });
  }, [reload, options?.skipInitialReload, options?.initialPlan, weekStart]);

  return { plan, loading, reloadWeekPlan: reload };
}

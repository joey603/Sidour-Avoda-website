"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getWeekKeyISO } from "../lib/week";
import {
  discardCachedAutoWeekPlans,
  discardUnsavedWeekArtifactsExcept,
  getCachedWeekPlan,
  prefetchAdjacentWeeks,
  setCachedWeekPlan,
  shouldDiscardUnsavedOnPlanningNav,
} from "../lib/week-nav-cache";
import { loadWeekPlanForSiteWeek, type V2WeekPlanData } from "../lib/week-plan-fetch";
import {
  clearMultiSiteNavigationInApp,
  readLinkedPlansFromMemory,
  readMultiSiteNavigationInApp,
} from "../lib/multi-site-linked-memory";

export type { V2WeekPlanData } from "../lib/week-plan-fetch";

function isSavedWeekPlan(plan: V2WeekPlanData): boolean {
  return plan?.sourceScope === "director" || plan?.sourceScope === "shared";
}

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
    if (options?.skipInitialReload || options?.lightweightNav) {
      return cached?.sourceScope === "auto" ? cached ?? null : null;
    }
    return isSavedWeekPlan(cached ?? null) ? cached ?? null : null;
  });
  const [loading, setLoading] = useState(() => !options?.skipInitialReload && !plan);
  const hasLoadedOnceRef = useRef(!!options?.skipInitialReload || !!plan);
  const prevWeekIsoRef = useRef<string | null>(null);
  const prevSiteIdRef = useRef<string | null>(null);
  const loadReq = useRef(0);
  const preferredScopeRef = useRef(preferredScope);
  preferredScopeRef.current = preferredScope;

  const reload = useCallback(
    async (opts?: {
      silent?: boolean;
      preferredScope?: "director" | "shared" | "auto" | null;
      savedOnly?: boolean;
      lightweightNav?: boolean;
    }) => {
      const silent = opts?.silent === true;
      const savedOnly = opts?.savedOnly === true;
      const includeAuto = !savedOnly;
      const lightweightNav = !savedOnly && opts?.lightweightNav === true;
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
        if (cached && (includeAuto || isSavedWeekPlan(cached))) setPlan(cached);
      } else {
        setLoading(true);
      }
      try {
        const effectivePreferredScope = opts?.preferredScope ?? preferredScopeRef.current;
        const holdForAlts = Math.max(0, Number(readLinkedPlansFromMemory(weekStart)?.activeAltIndex || 0)) > 0;
        const next = await loadWeekPlanForSiteWeek(siteId, isoWeek, effectivePreferredScope, {
          lightweightNav: lightweightNav || (!savedOnly && effectivePreferredScope === "auto"),
          savedOnly,
          omitWorkers: true,
          onBase:
            silent || holdForAlts
              ? undefined
              : (base) => {
                  if (req !== loadReq.current) return;
                  if (!includeAuto && base.sourceScope === "auto") return;
                  setPlan(base);
                  setLoading(false);
                },
        });
        if (req !== loadReq.current) return;
        if (next) {
          const visible = !includeAuto && next.sourceScope === "auto" ? null : next;
          setPlan(visible);
          if (visible) setCachedWeekPlan(siteId, isoWeek, visible);
        } else if (savedOnly || !silent) {
          setPlan(null);
        }
        prefetchAdjacentWeeks(siteId, weekStart, effectivePreferredScope);
      } catch {
        if (req !== loadReq.current) return;
        if (!silent) setPlan(null);
      } finally {
        if (req === loadReq.current) setLoading(false);
      }
    },
    [siteId, weekStart],
  );

  const applyLocalWeekPlan = useCallback(
    (next: V2WeekPlanData) => {
      setPlan(next);
      setLoading(false);
      if (next) setCachedWeekPlan(siteId, getWeekKeyISO(weekStart), next);
    },
    [siteId, weekStart],
  );

  const discardLocalAutoWeekPlan = useCallback(() => {
    const isoWeek = getWeekKeyISO(weekStart);
    setPlan((prev) => {
      if (isSavedWeekPlan(prev)) return prev;
      discardCachedAutoWeekPlans([siteId], isoWeek);
      return null;
    });
  }, [siteId, weekStart]);

  useEffect(() => {
    const isoWeek = getWeekKeyISO(weekStart);
    const firstLoad = prevWeekIsoRef.current == null && prevSiteIdRef.current == null;
    const weekChanged = prevWeekIsoRef.current != null && prevWeekIsoRef.current !== isoWeek;
    const siteChanged = prevSiteIdRef.current != null && prevSiteIdRef.current !== siteId;
    const inAppMultiSiteNav = readMultiSiteNavigationInApp() || options?.lightweightNav === true;
    const discardUnsaved = shouldDiscardUnsavedOnPlanningNav({
      firstLoad,
      weekChanged,
      siteChanged,
      inAppMultiSiteNav,
    });
    if (discardUnsaved) {
      discardUnsavedWeekArtifactsExcept([]);
    }
    prevWeekIsoRef.current = isoWeek;
    prevSiteIdRef.current = siteId;

    if (options?.skipInitialReload && !weekChanged) {
      setPlan(options.initialPlan ?? null);
      setLoading(false);
      hasLoadedOnceRef.current = true;
      if (inAppMultiSiteNav) {
        void reload({ silent: true, preferredScope: "auto", lightweightNav: true });
      }
      return;
    }
    // Animation au changement de semaine / site ; silent seulement pour un refresh même contexte.
    const silent = hasLoadedOnceRef.current && !weekChanged && !siteChanged && !firstLoad;
    hasLoadedOnceRef.current = true;
    void reload({
      silent,
      savedOnly: discardUnsaved,
      preferredScope: inAppMultiSiteNav ? "auto" : undefined,
      lightweightNav: inAppMultiSiteNav,
    });
    if (inAppMultiSiteNav && siteChanged && !firstLoad) {
      queueMicrotask(() => clearMultiSiteNavigationInApp());
    }
  }, [reload, options?.skipInitialReload, options?.initialPlan, options?.lightweightNav, weekStart, siteId]);

  return { plan, loading, reloadWeekPlan: reload, applyLocalWeekPlan, discardLocalAutoWeekPlan };
}

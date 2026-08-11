"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { assignmentsNonEmpty } from "../lib/assignments-empty";
import { loadAutoWeekPlanLite, toAutoWeekPlanLite } from "../lib/week-plan-fetch";
import { computeLinkedSiteHoleEntries } from "../lib/linked-site-holes";
import {
  clearLinkedPlansFromMemory,
  clearMultiSiteNavigationInApp,
  countLinkedPlanVisibleAlternatives,
  MULTI_SITE_NAV_FLAG,
  readLinkedPlansFromMemory,
  readMultiSiteNavigationInApp,
  resolveAssignmentsForAlternative,
  resolvePullsForAlternative,
  saveLinkedPlansToMemory,
  type LinkedSitePlan,
} from "../lib/multi-site-linked-memory";
import { readLinkedGenerationStopVisibleCountFromSession } from "../lib/planning-v2-generation-session";
import { getWeekKeyISO } from "../lib/week";
import type { PlanningV2PullsMap, PlanningWorker, SiteSummary } from "../types";
import type { V2WeekPlanData } from "./use-planning-v2-week-plan";
import type { LinkedSiteRow } from "./use-planning-v2-linked-sites";

type LinkedMemoryPlanSlice = {
  displayAssignments: Record<string, Record<string, string[][]>> | null | undefined;
  displayPulls: PlanningV2PullsMap | null | undefined;
  assignmentVariants: Record<string, Record<string, string[][]>>[];
  generationRunning: boolean;
  alternativeCount: number;
  selectedAlternativeIndex: number;
  setSelectedAlternativeIndex: (idx: number) => void;
};

type NavigationMemorySnapshot = {
  activeIdx: number;
  currentPlanAlternativeCount: number;
  hasCurrentPlan: boolean;
};

type RouterLike = {
  push: (href: string) => void;
};

type UsePlanningV2LinkedMemoryArgs = {
  siteId: string;
  weekStart: Date;
  isoWeek: string;
  site: SiteSummary | null;
  workers: PlanningWorker[];
  linkedSites: LinkedSiteRow[];
  weekPlan: V2WeekPlanData;
  protectOfficialSavedPlan: boolean;
  hasOfficialSavedWeekPlan: boolean;
  effectiveAlternativeIndex: number;
  summaryFilterState: { indices: number[]; hasActiveFilters: boolean };
  multiSiteNavigationLoading: boolean;
  setMultiSiteNavigationLoading: Dispatch<SetStateAction<boolean>>;
  linkedPlansMemoryTick: number;
  setLinkedPlansMemoryTick: Dispatch<SetStateAction<number>>;
  hasLinkedSitesRail: boolean;
  siteLoading: boolean;
  workersLoading: boolean;
  weekPlanLoading: boolean;
  router: RouterLike;
  plan: LinkedMemoryPlanSlice;
};

export function usePlanningV2LinkedMemory({
  siteId,
  weekStart,
  isoWeek,
  site,
  workers,
  linkedSites,
  weekPlan,
  protectOfficialSavedPlan,
  hasOfficialSavedWeekPlan,
  effectiveAlternativeIndex,
  summaryFilterState,
  multiSiteNavigationLoading,
  setMultiSiteNavigationLoading,
  linkedPlansMemoryTick,
  setLinkedPlansMemoryTick,
  hasLinkedSitesRail,
  siteLoading,
  workersLoading,
  weekPlanLoading,
  router,
  plan,
}: UsePlanningV2LinkedMemoryArgs) {
  const [showLinkedSitesRail, setShowLinkedSitesRail] = useState(false);
  const prevLinkedSitesLengthRef = useRef<number>(linkedSites.length);
  const lastCurrentSiteMemorySyncRef = useRef("");

  /** Recalculer la barre « אתרים מקושרים » quand sessionStorage (linked plans) change — le useMemo lit la mémoire sans que les autres deps bougent (ex. pendant SSE). */
  useEffect(() => {
    if (linkedSites.length <= 1) return;
    const bump = () => {
      // Pendant le streaming SSE, ne pas re-render toute la page à chaque alternative
      // (sinon les clics חלופות se mettent en file et « rattrapent » ensuite).
      if (plan.generationRunning) return;
      setLinkedPlansMemoryTick((n) => n + 1);
    };
    window.addEventListener("linked-plans-memory-updated", bump as EventListener);
    return () => window.removeEventListener("linked-plans-memory-updated", bump as EventListener);
  }, [linkedSites.length, plan.generationRunning]);

  useEffect(() => {
    const prev = prevLinkedSitesLengthRef.current;
    if (prev <= 1 && linkedSites.length > 1) {
      queueMicrotask(() => setLinkedPlansMemoryTick((n) => n + 1));
    }
    if (prev > 1 && linkedSites.length <= 1) {
      setShowLinkedSitesRail(false);
    }
    prevLinkedSitesLengthRef.current = linkedSites.length;
  }, [linkedSites.length]);

  /** Rail mobile « אתרים מקושרים » : fermé par défaut à chaque changement de site / semaine. */
  useEffect(() => {
    setShowLinkedSitesRail(false);
  }, [siteId, weekStart]);

  const navigateToLinkedSiteFromRail = useCallback(
    (targetId: number) => {
      try {
        sessionStorage.setItem(MULTI_SITE_NAV_FLAG, "1");
      } catch {
        /* ignore */
      }
      // Persister l’index חלופה avant le remount (comme legacy navigate-before-push).
      const mem = readLinkedPlansFromMemory(weekStart);
      if (mem?.plansBySite && Object.keys(mem.plansBySite).length > 0) {
        const uiIdx = Math.max(0, Number(plan.selectedAlternativeIndex || 0));
        const memIdx = Math.max(0, Number(mem.activeAltIndex || 0));
        // Si l’UI n’a pas encore rattrapé la mémoire, ne pas rétrograder l’index partagé.
        const nextIdx = uiIdx < memIdx && plan.alternativeCount <= memIdx ? memIdx : uiIdx;
        saveLinkedPlansToMemory(weekStart, mem.plansBySite, nextIdx);
      }
      setMultiSiteNavigationLoading(true);
      router.push(`/director/planning/${targetId}?week=${encodeURIComponent(isoWeek)}`);
    },
    [router, isoWeek, weekStart, plan.alternativeCount, plan.selectedAlternativeIndex],
  );

  const navigationMemorySnapshot = useMemo<NavigationMemorySnapshot>(() => {
    if (protectOfficialSavedPlan) {
      return { activeIdx: 0, currentPlanAlternativeCount: 0, hasCurrentPlan: false };
    }
    const mem = readLinkedPlansFromMemory(weekStart);
    const currentPlan = mem?.plansBySite?.[String(siteId)];
    if (!currentPlan && linkedSites.length <= 1 && !multiSiteNavigationLoading) {
      return { activeIdx: 0, currentPlanAlternativeCount: 0, hasCurrentPlan: false };
    }
    const stopVisibleCount = readLinkedGenerationStopVisibleCountFromSession(getWeekKeyISO(weekStart));
    const visibleAlternativeCount = countLinkedPlanVisibleAlternatives(currentPlan, stopVisibleCount);
    const maxVisibleIndex = Math.max(0, visibleAlternativeCount - 1);
    const rawActiveIdx = Math.max(0, Number(mem?.activeAltIndex || 0));
    // Pendant « פתח אתר », garder l’index partagé mémoire même si le plan cible
    // n’a pas encore toutes ses alternatives chargées (sinon clamp → חלופה 1).
    const activeIdx = multiSiteNavigationLoading ? rawActiveIdx : Math.min(rawActiveIdx, maxVisibleIndex);
    return {
      activeIdx,
      currentPlanAlternativeCount: visibleAlternativeCount,
      hasCurrentPlan: !!currentPlan,
    };
  }, [protectOfficialSavedPlan, linkedSites.length, multiSiteNavigationLoading, linkedPlansMemoryTick, siteId, weekStart]);

  useEffect(() => {
    if (protectOfficialSavedPlan) return;
    if (!multiSiteNavigationLoading) return;
    if (!navigationMemorySnapshot.hasCurrentPlan) return;
    const targetIdx = Math.max(0, navigationMemorySnapshot.activeIdx);
    const memoryCount = navigationMemorySnapshot.currentPlanAlternativeCount;
    const loadedVariantCount = Array.isArray(plan.assignmentVariants) ? plan.assignmentVariants.length : 0;
    // Attendre que les variantes réellement chargées rattrapent la cible mémoire.
    if (loadedVariantCount <= targetIdx) {
      if (memoryCount <= 0 || loadedVariantCount < memoryCount) return;
    }
    if (plan.selectedAlternativeIndex === targetIdx) return;
    plan.setSelectedAlternativeIndex(targetIdx);
  }, [
    protectOfficialSavedPlan,
    multiSiteNavigationLoading,
    navigationMemorySnapshot.hasCurrentPlan,
    navigationMemorySnapshot.activeIdx,
    navigationMemorySnapshot.currentPlanAlternativeCount,
    plan.assignmentVariants,
    plan.selectedAlternativeIndex,
    plan.setSelectedAlternativeIndex,
  ]);

  useEffect(() => {
    if (linkedSites.length <= 1) return;
    if (plan.generationRunning) return;
    if (weekPlan?.sourceScope !== "auto") return;
    if (readMultiSiteNavigationInApp()) return;
    const isoWeek = getWeekKeyISO(weekStart);
    let cancelled = false;

    const syncLinkedAutoPlansFromDb = async () => {
      const targetSiteIds = Array.from(
        new Set(
          linkedSites
            .map((ls) => Number(ls.id))
            .filter((id) => Number.isFinite(id) && id > 0),
        ),
      );
      if (targetSiteIds.length <= 1) return;

      const currentKey = String(siteId);
      const currentFromPage =
        weekPlan && assignmentsNonEmpty(weekPlan.assignments) ? toAutoWeekPlanLite(weekPlan) : null;
      const entries = await Promise.all(
        targetSiteIds
          .filter((id) => String(id) !== currentKey)
          .map(async (id) => {
            try {
              const lite = await loadAutoWeekPlanLite(String(id), isoWeek);
              if (!lite) return [String(id), null] as const;
              return [String(id), lite satisfies LinkedSitePlan] as const;
            } catch {
              return [String(id), null] as const;
            }
          }),
      );
      if (currentFromPage) {
        entries.push([currentKey, currentFromPage]);
      }

      if (cancelled) return;
      const plansBySite = Object.fromEntries(entries.filter(([, planValue]) => !!planValue)) as Record<string, LinkedSitePlan>;
      if (Object.keys(plansBySite).length <= 1) return;

      const mem = readLinkedPlansFromMemory(weekStart);
      const activeAltIndex = Math.max(0, Number(mem?.activeAltIndex || 0));
      const memoryPlans = mem?.plansBySite && typeof mem.plansBySite === "object" ? mem.plansBySite : {};
      const mergedPlans: Record<string, LinkedSitePlan> = { ...plansBySite };
      for (const [sid, memoryPlan] of Object.entries(memoryPlans)) {
        if (!memoryPlan || typeof memoryPlan !== "object") continue;
        const dbPlan = plansBySite[sid];
        const memoryAltCount = Array.isArray(memoryPlan.alternatives) ? memoryPlan.alternatives.length : 0;
        const dbAltCount = Array.isArray(dbPlan?.alternatives) ? dbPlan.alternatives.length : 0;
        // `עוד` enrichit d'abord sessionStorage. Ne pas écraser ces alternatives par une
        // réponse DB auto plus ancienne quand on navigue vers un autre site lié.
        if (memoryAltCount > dbAltCount || (activeAltIndex > dbAltCount && memoryAltCount >= activeAltIndex)) {
          mergedPlans[sid] = memoryPlan as LinkedSitePlan;
        }
      }
      saveLinkedPlansToMemory(weekStart, mergedPlans, activeAltIndex);
    };

    void syncLinkedAutoPlansFromDb();
    return () => {
      cancelled = true;
    };
  }, [linkedSites, plan.generationRunning, siteId, weekPlan, weekStart]);

  useEffect(() => {
    if (linkedSites.length <= 1) return;
    if (plan.generationRunning) return;
    if (protectOfficialSavedPlan) {
      if (lastCurrentSiteMemorySyncRef.current !== "official-saved-memory-cleared") {
        lastCurrentSiteMemorySyncRef.current = "official-saved-memory-cleared";
        clearLinkedPlansFromMemory(weekStart);
      }
      return;
    }
    const mem = readLinkedPlansFromMemory(weekStart);
    if (!mem?.plansBySite || Object.keys(mem.plansBySite).length === 0) return;
    const memoryActiveIdx = Math.max(0, Number(mem.activeAltIndex || 0));
    const inAppMultiSiteNavigation = readMultiSiteNavigationInApp();
    const currentSiteKey = String(siteId);
    const nextPlans: Record<string, LinkedSitePlan> = JSON.parse(JSON.stringify(mem.plansBySite));
    const activeIdx = Math.max(0, Number(plan.selectedAlternativeIndex || 0));
    // Pendant « פתח אתר » / réhydratation : ne jamais écraser l’index partagé ni clear le flag
    // (sinon un clamp transitoire vers חלופה 1 réécrit activeAltIndex=0 en session).
    if (inAppMultiSiteNavigation || multiSiteNavigationLoading) {
      if (activeIdx !== memoryActiveIdx) return;
      if (plan.alternativeCount <= memoryActiveIdx) return;
    }
    // Ne pas rétrograder l’index mémoire tant que les variantes locales n’ont pas rattrapé.
    if (activeIdx < memoryActiveIdx && plan.alternativeCount <= memoryActiveIdx) {
      return;
    }
    const displayedAssignments = plan.displayAssignments;
    const displayedPulls = (plan.displayPulls || {}) as PlanningV2PullsMap;
    if (!assignmentsNonEmpty(displayedAssignments ?? null)) return;
    const loadedVariantCount = Array.isArray(plan.assignmentVariants) ? plan.assignmentVariants.length : 0;
    // Variantes pas encore réhydratées : displayAssignments peut encore être la חלופה 1
    // alors que selectedAlternativeIndex pointe déjà vers 12 — ne pas écraser la mémoire.
    if (activeIdx > 0 && loadedVariantCount <= activeIdx) {
      return;
    }
    const currentPlan = {
      ...(nextPlans[currentSiteKey] || {}),
    } as LinkedSitePlan;
    const nextDisplayedAssignments = JSON.parse(
      JSON.stringify(displayedAssignments),
    ) as Record<string, Record<string, string[][]>>;
    const nextDisplayedPulls = JSON.parse(JSON.stringify(displayedPulls)) as PlanningV2PullsMap;
    const renderSnapshot = JSON.stringify({
      activeIdx,
      assignments: nextDisplayedAssignments,
      pulls: nextDisplayedPulls,
    });
    if (renderSnapshot === lastCurrentSiteMemorySyncRef.current) {
      return;
    }
    const existingAssignmentsForActiveIdx = resolveAssignmentsForAlternative(currentPlan, activeIdx) || null;
    const existingPullsForActiveIdx = (resolvePullsForAlternative(currentPlan, activeIdx) || {}) as PlanningV2PullsMap;
    const existingSnapshot = JSON.stringify({
      activeIdx,
      assignments: existingAssignmentsForActiveIdx || {},
      pulls: existingPullsForActiveIdx || {},
    });
    const nextSnapshot = JSON.stringify({
      activeIdx,
      assignments: nextDisplayedAssignments,
      pulls: nextDisplayedPulls,
    });
    if (existingSnapshot === nextSnapshot && memoryActiveIdx === activeIdx) {
      lastCurrentSiteMemorySyncRef.current = renderSnapshot;
      return;
    }
    if (activeIdx <= 0) {
      currentPlan.assignments = nextDisplayedAssignments;
      currentPlan.pulls = nextDisplayedPulls;
    } else {
      const alts = Array.isArray(currentPlan.alternatives) ? [...currentPlan.alternatives] : [];
      const altPulls = Array.isArray(currentPlan.alternative_pulls) ? [...currentPlan.alternative_pulls] : [];
      while (alts.length < activeIdx) {
        alts.push(
          JSON.parse(
            JSON.stringify(currentPlan.assignments || {}),
          ) as Record<string, Record<string, string[][]>>,
        );
      }
      while (altPulls.length < activeIdx) {
        altPulls.push(
          JSON.parse(JSON.stringify((currentPlan.pulls || {}) as Record<string, unknown>)) as Record<string, unknown>,
        );
      }
      alts[activeIdx - 1] = nextDisplayedAssignments;
      altPulls[activeIdx - 1] = nextDisplayedPulls as Record<string, unknown>;
      currentPlan.alternatives = alts;
      currentPlan.alternative_pulls = altPulls;
    }
    nextPlans[currentSiteKey] = currentPlan;
    lastCurrentSiteMemorySyncRef.current = renderSnapshot;
    // Préserver le max(mémoire, UI) pour ne jamais perdre l’index partagé au retour de site.
    const idxToPersist = Math.max(activeIdx, memoryActiveIdx);
    saveLinkedPlansToMemory(weekStart, nextPlans, idxToPersist);
  }, [
    linkedSites.length,
    multiSiteNavigationLoading,
    plan.alternativeCount,
    plan.assignmentVariants,
    plan.displayAssignments,
    plan.displayPulls,
    plan.generationRunning,
    plan.selectedAlternativeIndex,
    protectOfficialSavedPlan,
    siteId,
    weekStart,
  ]);

  const linkedSiteHoleEntries = useMemo(
    () =>
      computeLinkedSiteHoleEntries({
        linkedSites,
        weekStart,
        currentSiteId: siteId,
        currentSite: site ?? null,
        currentAssignments: plan.displayAssignments,
        currentPulls: plan.displayPulls ?? null,
        alternativeIndex: plan.selectedAlternativeIndex,
        ignoreLinkedMemory: protectOfficialSavedPlan,
      }),
    [
      hasOfficialSavedWeekPlan,
      protectOfficialSavedPlan,
      linkedSites,
      weekStart,
      siteId,
      site,
      plan.displayAssignments,
      plan.displayPulls,
      plan.selectedAlternativeIndex,
    ],
  );

  const linkedSiteHolesById = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of linkedSiteHoleEntries) m.set(e.id, e.holesCount);
    return m;
  }, [linkedSiteHoleEntries]);

  const multiSiteNavigationTargetIndex =
    multiSiteNavigationLoading && navigationMemorySnapshot.hasCurrentPlan
      ? navigationMemorySnapshot.activeIdx
      : effectiveAlternativeIndex;

  const linkedSitesRailData = useMemo(() => {
    if (linkedSites.length <= 1) return [];
    const currentSiteIdNum = Number(siteId);
    const linkedById = new Map<number, string>();
    linkedSites.forEach((ls) => linkedById.set(Number(ls.id), String(ls.name || `אתר ${ls.id}`)));

    const otherSiteIds = [
      ...new Set(
        linkedSites
          .map((ls) => Number(ls.id))
          .filter((id) => Number.isFinite(id) && id > 0 && id !== currentSiteIdNum),
      ),
    ];
    if (otherSiteIds.length === 0) return [];

    const multiNames = new Set(
      workers
        .filter((w) => Array.isArray(w.linkedSiteIds) && w.linkedSiteIds.length > 1)
        .map((w) => String(w.name || "").trim())
        .filter(Boolean),
    );

    const mem = protectOfficialSavedPlan ? null : readLinkedPlansFromMemory(weekStart);
    const plansBySite = mem?.plansBySite && typeof mem.plansBySite === "object" ? mem.plansBySite : {};

    const rowsForSite = (
      sid: number,
    ): {
      rows: Array<{ dayKey: string; shiftName: string; stationLabel: string; workers: string[] }>;
      workerCounts: Array<{ workerName: string; count: number }>;
    } => {
      if (multiNames.size === 0) return { rows: [], workerCounts: [] };
      const sitePlan = plansBySite[String(sid)] as LinkedSitePlan | undefined;
      if (!sitePlan) return { rows: [], workerCounts: [] };
      const asg = resolveAssignmentsForAlternative(sitePlan, multiSiteNavigationTargetIndex) || {};
      const rows: Array<{ dayKey: string; shiftName: string; stationLabel: string; workers: string[] }> = [];
      const workerCountsMap = new Map<string, number>();
      for (const [dayKey, shiftsMap] of Object.entries(asg)) {
        if (!shiftsMap || typeof shiftsMap !== "object") continue;
        for (const [shiftName, perStation] of Object.entries(shiftsMap)) {
          if (!Array.isArray(perStation)) continue;
          perStation.forEach((cell, stationIdx) => {
            if (!Array.isArray(cell)) return;
            const matched = cell
              .map((n) => String(n || "").trim())
              .filter((n) => n && multiNames.has(n));
            if (matched.length === 0) return;
            matched.forEach((nm) => workerCountsMap.set(nm, (workerCountsMap.get(nm) || 0) + 1));
            rows.push({
              dayKey,
              shiftName,
              stationLabel: `עמדה ${stationIdx + 1}`,
              workers: matched,
            });
          });
        }
      }
      const workerCounts = Array.from(workerCountsMap.entries())
        .map(([workerName, count]) => ({ workerName, count }))
        .sort((a, b) => {
          if (b.count !== a.count) return b.count - a.count;
          return a.workerName.localeCompare(b.workerName, "he");
        });
      return { rows, workerCounts };
    };

    const archivedById = new Map<number, boolean>();
    linkedSites.forEach((ls) => archivedById.set(Number(ls.id), !!ls.site_deleted));

    const out = otherSiteIds.map((sid) => {
      const siteRows = rowsForSite(sid);
      return {
        siteId: sid,
        siteName: linkedById.get(sid) || `אתר ${sid}`,
        siteDeleted: archivedById.get(sid) === true,
        rows: siteRows.rows,
        workerCounts: siteRows.workerCounts,
      };
    });
    return out.sort((a, b) => {
      const aa = a.siteDeleted ? 1 : 0;
      const bb = b.siteDeleted ? 1 : 0;
      if (aa !== bb) return aa - bb;
      return a.siteName.localeCompare(b.siteName, "he");
    });
  }, [
    protectOfficialSavedPlan,
    linkedSites,
    weekStart,
    workers,
    siteId,
    multiSiteNavigationTargetIndex,
    plan.alternativeCount,
    linkedPlansMemoryTick,
  ]);

  const linkedSiteRailBadges = useMemo(() => {
    const weekIso = getWeekKeyISO(weekStart);
    const ids = new Set<number>();
    const current = Number(siteId);
    if (Number.isFinite(current) && current > 0) ids.add(current);
    linkedSites.forEach((ls) => {
      const n = Number(ls.id);
      if (Number.isFinite(n) && n > 0) ids.add(n);
    });
    const linkedSiteIdsKey = Array.from(ids)
      .sort((a, b) => a - b)
      .join("-");
    const filterStorageKey = `planning_v2_multisite_assignment_filters_by_site_${weekIso}_${linkedSiteIdsKey}`;
    const savedBySiteId = new Map<number, boolean>();
    const filterCountBySiteId = new Map<number, number>();
    if (typeof window === "undefined") {
      return { savedBySiteId, filterCountBySiteId };
    }
    try {
      const hasSavedFromApiBySiteId = new Map<number, boolean>();
      linkedSites.forEach((ls) => {
        const sid = Number(ls.id);
        if (!Number.isFinite(sid) || sid <= 0) return;
        hasSavedFromApiBySiteId.set(sid, !!ls.has_saved_plan);
      });
      for (const ls of linkedSites) {
        const sid = Number(ls.id);
        if (!Number.isFinite(sid) || sid <= 0) continue;
        const localGeneric = !!localStorage.getItem(`plan_${sid}_${weekIso}`);
        const localDirector = !!localStorage.getItem(`plan_director_${sid}_${weekIso}`);
        const localShared = !!localStorage.getItem(`plan_shared_${sid}_${weekIso}`);
        const sessionGeneric = !!sessionStorage.getItem(`plan_${sid}_${weekIso}`);
        const sessionDirector = !!sessionStorage.getItem(`plan_director_${sid}_${weekIso}`);
        const sessionShared = !!sessionStorage.getItem(`plan_shared_${sid}_${weekIso}`);
        const currentSitePersistedFromApi =
          String(sid) === String(siteId) &&
          assignmentsNonEmpty(weekPlan?.assignments ?? null) &&
          (weekPlan?.sourceScope === "director" || weekPlan?.sourceScope === "shared");
        savedBySiteId.set(
          sid,
          !!hasSavedFromApiBySiteId.get(sid) ||
            localGeneric ||
            localDirector ||
            localShared ||
            sessionGeneric ||
            sessionDirector ||
            sessionShared ||
            currentSitePersistedFromApi,
        );
      }
    } catch {
      /* ignore */
    }
    try {
      const raw = localStorage.getItem(filterStorageKey);
      const parsed = raw ? (JSON.parse(raw) as Record<string, Record<string, unknown>>) : {};
      for (const ls of linkedSites) {
        const sid = String(ls.id);
        const byWorker = parsed?.[sid];
        if (!byWorker || typeof byWorker !== "object") {
          filterCountBySiteId.set(Number(ls.id), 0);
          continue;
        }
        const count = Object.values(byWorker).filter((v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 0;
        }).length;
        filterCountBySiteId.set(Number(ls.id), count);
      }
    } catch {
      linkedSites.forEach((ls) => filterCountBySiteId.set(Number(ls.id), 0));
    }
    return { savedBySiteId, filterCountBySiteId };
  }, [linkedSites, siteId, weekStart, summaryFilterState, weekPlan?.assignments, weekPlan?.sourceScope]);


  useEffect(() => {
    if (!multiSiteNavigationLoading) return;
    if (siteLoading || workersLoading) return;
    if (!navigationMemorySnapshot.hasCurrentPlan) {
      if (!weekPlanLoading) {
        setMultiSiteNavigationLoading(false);
        clearMultiSiteNavigationInApp();
      }
      return;
    }
    const targetAlternativeIndex = navigationMemorySnapshot.activeIdx;
    const memoryCount = navigationMemorySnapshot.currentPlanAlternativeCount;
    const hasDisplayablePlan = assignmentsNonEmpty(plan.displayAssignments);
    // Compter les variantes réellement chargées (pas alternativeCount « mémoire » gonflé).
    const loadedVariantCount = Array.isArray(plan.assignmentVariants) ? plan.assignmentVariants.length : 0;
    const variantsCaughtUp =
      loadedVariantCount > targetAlternativeIndex || (memoryCount > 0 && loadedVariantCount >= memoryCount);
    const appliedTarget =
      loadedVariantCount > 0 ? Math.min(targetAlternativeIndex, loadedVariantCount - 1) : targetAlternativeIndex;
    // Exiger la vraie חלופה partagée — pas Math.min(target, count-1) seul qui
    // validait à tort חלופה 1 tant que le plan n’était pas réhydraté.
    const alternativesReady =
      hasDisplayablePlan &&
      variantsCaughtUp &&
      loadedVariantCount > targetAlternativeIndex &&
      plan.selectedAlternativeIndex === targetAlternativeIndex &&
      appliedTarget === targetAlternativeIndex;
    if (!alternativesReady) return;
    setMultiSiteNavigationLoading(false);
    clearMultiSiteNavigationInApp();
  }, [
    multiSiteNavigationLoading,
    siteLoading,
    workersLoading,
    weekPlanLoading,
    navigationMemorySnapshot,
    plan.assignmentVariants,
    plan.displayAssignments,
    plan.selectedAlternativeIndex,
  ]);

  /** Pas de défilement de la page sous le panneau mobile « אתרים מקושרים » lorsqu’il est ouvert (< lg). */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 1023px)");
    const apply = () => {
      const lock = mq.matches && hasLinkedSitesRail && showLinkedSitesRail;
      document.body.style.overflow = lock ? "hidden" : "";
      document.documentElement.style.overflow = lock ? "hidden" : "";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
    };
  }, [hasLinkedSitesRail, showLinkedSitesRail]);

  /** Insets du rail mobile : bas de `#app-top-nav` → `top`, haut de la barre d’action → `bottom`. */
  useLayoutEffect(() => {
    const syncRailInsets = () => {
      const navEl = document.getElementById("app-top-nav");
      const barEl = document.getElementById("planning-v2-action-bar");

      let topPx = 0;
      if (navEl) {
        const cs = window.getComputedStyle(navEl);
        const nr = navEl.getBoundingClientRect();
        const navVisible =
          cs.display !== "none" && cs.visibility !== "hidden" && nr.height > 0.5 && nr.bottom > 0;
        topPx = navVisible ? Math.max(0, nr.bottom) : 0;
      }
      document.documentElement.style.setProperty("--planning-v2-rail-top-px", `${topPx}px`);

      if (barEl) {
        const br = barEl.getBoundingClientRect();
        document.documentElement.style.setProperty(
          "--planning-v2-action-bar-px",
          `${Math.max(0, window.innerHeight - br.top)}px`,
        );
      }
    };

    syncRailInsets();
    const ro = new ResizeObserver(() => requestAnimationFrame(syncRailInsets));
    const navEl = document.getElementById("app-top-nav");
    const barEl = document.getElementById("planning-v2-action-bar");
    if (navEl) ro.observe(navEl);
    if (barEl) ro.observe(barEl);
    window.addEventListener("resize", syncRailInsets);
    window.addEventListener("orientationchange", syncRailInsets);
    window.addEventListener("scroll", syncRailInsets, true);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", syncRailInsets);
    vv?.addEventListener("scroll", syncRailInsets);
    requestAnimationFrame(() => requestAnimationFrame(syncRailInsets));
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", syncRailInsets);
      window.removeEventListener("orientationchange", syncRailInsets);
      window.removeEventListener("scroll", syncRailInsets, true);
      vv?.removeEventListener("resize", syncRailInsets);
      vv?.removeEventListener("scroll", syncRailInsets);
      document.documentElement.style.removeProperty("--planning-v2-rail-top-px");
      document.documentElement.style.removeProperty("--planning-v2-action-bar-px");
    };
  }, []);

  return {
    showLinkedSitesRail,
    setShowLinkedSitesRail,
    linkedPlansMemoryTick,
    setLinkedPlansMemoryTick,
    multiSiteNavigationLoading,
    navigateToLinkedSiteFromRail,
    navigationMemorySnapshot,
    linkedSitesRailData,
    linkedSiteRailBadges,
    linkedSiteHoleEntries,
    linkedSiteHolesById,
    multiSiteNavigationTargetIndex,
  };
}

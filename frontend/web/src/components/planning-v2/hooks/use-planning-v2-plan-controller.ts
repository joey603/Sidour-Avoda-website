"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { PlanningV2PullsMap, PlanningWorker, SiteSummary, WorkerAvailability } from "../types";
import { buildEmptyAssignmentsForSite, shiftNamesFromSite } from "../lib/station-grid-helpers";
import type { V2WeekPlanData } from "./use-planning-v2-week-plan";
import { assignmentsNonEmpty } from "../lib/assignments-empty";
import {
  buildWeekPlanDataPayload,
  buildWorkersSnapshotForSave,
  persistWeekPlanToApi,
} from "../lib/week-plan-persist";
import { getWeekKeyISO } from "../lib/week";
import {
  clearLinkedPlansFromMemory,
  readLinkedPlansFromMemory,
  saveLinkedPlansToMemory,
} from "../lib/multi-site-linked-memory";
import { type DraftAlternative, draftAlternativesForMode } from "../lib/planning-v2-draft-alternatives";
import { usePlanningV2Generation } from "./use-planning-v2-generation";
import { usePlanningV2DisplayVariants } from "./use-planning-v2-display-variants";
import {
  EMPTY_PULLS_SHIFT_PREFS,
  pullsPreferPayload,
  type PullsShiftPrefs,
} from "../lib/planning-v2-pulls-match";
import {
  anyPlanHasNonPreferredPulls,
  anyPlanHasPreferredPulls,
  firstNonExclusivePreferredIndex,
  pullsPreferFallbackToastCopy,
  pullsPreferMixedAltsToastCopy,
} from "../lib/planning-v2-pulls-prefer-notices";

const AUTO_PULLS_LIMIT_BY_WEEK_KEY_PREFIX = "planning_v2_auto_pulls_limit_week_";
const AUTO_PULLS_PREFER_BY_WEEK_KEY_PREFIX = "planning_v2_auto_pulls_prefer_week_";

function parsePullsShiftPrefs(raw: string | null): PullsShiftPrefs {
  if (!raw) return { ...EMPTY_PULLS_SHIFT_PREFS };
  try {
    const obj = JSON.parse(raw) as Partial<PullsShiftPrefs>;
    return {
      morning: obj?.morning === true,
      noon: obj?.noon === true,
      night: obj?.night === true,
    };
  } catch {
    return { ...EMPTY_PULLS_SHIFT_PREFS };
  }
}

type PlanControllerArgs = {
  siteId: string;
  weekStart: Date;
  weekPlan: V2WeekPlanData;
  site: SiteSummary | null;
  weekPlanLoading: boolean;
  workers: PlanningWorker[];
  workerRowsForTable: Array<PlanningWorker & { availability: WorkerAvailability }>;
  reloadWeekPlan: (opts?: { silent?: boolean; preferredScope?: "director" | "shared" | "auto" | null }) => void | Promise<void>;
  /** Mode ערוך sur un plan director/shared : garder le brouillon généré visible jusqu'à sauvegarde. */
  editingSaved?: boolean;
  linkedSitesLength: number;
  /** Sites du groupe (courant + liés) pour purger les טיוטות auto issues d’une ריצה depuis la liste sites. */
  weekPurgeSiteIds: number[];
  getVisibleAlternativeCount?: () => number;
  /** Verrous אירועים à retirer de la זמינות envoyée à l’IA. */
  eventLocksByWorkerId?: Record<number, Record<string, string[]>>;
};

export function usePlanningV2PlanController({
  siteId,
  weekStart,
  weekPlan,
  site,
  weekPlanLoading,
  workers,
  workerRowsForTable,
  reloadWeekPlan,
  editingSaved = false,
  linkedSitesLength,
  weekPurgeSiteIds,
  getVisibleAlternativeCount,
  eventLocksByWorkerId = {},
}: PlanControllerArgs) {
  const [draftAssignments, setDraftAssignments] = useState<Record<string, Record<string, string[][]>> | null>(
    null,
  );
  const [draftPulls, setDraftPulls] = useState<PlanningV2PullsMap | null>(null);
  const [draftAlternatives, setDraftAlternatives] = useState<DraftAlternative[]>([]);
  const [draftFixedAssignmentsSnapshot, setDraftFixedAssignmentsSnapshot] = useState<
    Record<string, Record<string, string[][]>> | null
  >(null);
  const [selectedAlternativeIndex, setSelectedAlternativeIndex] = useState(0);
  // Par défaut: משיכות ללא (empty string).
  const [autoPullsLimit, setAutoPullsLimit] = useState("");
  const [autoPullsPrefer, setAutoPullsPrefer] = useState<PullsShiftPrefs>({ ...EMPTY_PULLS_SHIFT_PREFS });
  const [isManual, setIsManual] = useState(false);
  const draftAssignmentsRef = useRef<Record<string, Record<string, string[][]>> | null>(null);
  const draftPullsRef = useRef<PlanningV2PullsMap>({});
  const draftAlternativesRef = useRef<DraftAlternative[]>([]);
  /** Index choisi manuellement pendant le streaming — ne pas le faire écraser par la mémoire. */
  const userPickedAltIndexRef = useRef<number | null>(null);
  const selectedAlternativeIndexRef = useRef(0);
  const viewedAlternativeIndicesRef = useRef<Set<number>>(new Set());
  const weekPlanAssignmentsRef = useRef<Record<string, Record<string, string[][]>> | undefined>(undefined);
  const assignmentVariantsRef = useRef<Array<Record<string, Record<string, string[][]>>>>([]);
  const pullVariantsRef = useRef<PlanningV2PullsMap[]>([]);
  const pullsPreferNoticesRef = useRef({
    active: false,
    fallbackShown: false,
    mixedAltsShown: false,
  });

  const weekIso = getWeekKeyISO(weekStart);
  const autoPullsStorageKey = `${AUTO_PULLS_LIMIT_BY_WEEK_KEY_PREFIX}${weekIso}`;
  const autoPullsPreferStorageKey = `${AUTO_PULLS_PREFER_BY_WEEK_KEY_PREFIX}${weekIso}`;
  const [alternativesUnlockNonce, setAlternativesUnlockNonce] = useState(0);
  const [clientStorageReady, setClientStorageReady] = useState(false);
  const [moreAlternativesAvailable, setMoreAlternativesAvailable] = useState(true);
  const dedupeAlternatives = linkedSitesLength <= 1;

  useEffect(() => {
    setAlternativesUnlockNonce((n) => n + 1);
  }, [siteId, weekIso]);

  useEffect(() => {
    if (linkedSitesLength <= 1 || typeof window === "undefined") return;
    const onMem = () => setAlternativesUnlockNonce((n) => n + 1);
    window.addEventListener("linked-plans-memory-updated", onMem as EventListener);
    return () => window.removeEventListener("linked-plans-memory-updated", onMem as EventListener);
  }, [linkedSitesLength, weekStart]);

  useEffect(() => {
    setClientStorageReady(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(autoPullsStorageKey);
      if (raw == null) {
        setAutoPullsLimit("");
        return;
      }
      const normalized = String(raw);
      setAutoPullsLimit(normalized);
    } catch {
      setAutoPullsLimit("");
    }
  }, [autoPullsStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setAutoPullsPrefer(parsePullsShiftPrefs(localStorage.getItem(autoPullsPreferStorageKey)));
    } catch {
      setAutoPullsPrefer({ ...EMPTY_PULLS_SHIFT_PREFS });
    }
  }, [autoPullsPreferStorageKey]);

  const autoPullsEnabled = autoPullsLimit !== "";
  const hasOfficialSavedWeekPlan =
    assignmentsNonEmpty(weekPlan?.assignments ?? null) &&
    (weekPlan?.sourceScope === "director" || weekPlan?.sourceScope === "shared");
  const protectOfficialSavedPlan = hasOfficialSavedWeekPlan && !editingSaved;

  const generation = usePlanningV2Generation({
    siteId,
    weekStart,
    weekIso,
    site,
    workers,
    workerRowsForTable,
    reloadWeekPlan,
    editingSaved,
    hasOfficialSavedWeekPlan,
    linkedSitesLength,
    weekPurgeSiteIds,
    getVisibleAlternativeCount,
    eventLocksByWorkerId,
    autoPullsEnabled,
    autoPullsLimit,
    autoPullsPrefer,
    dedupeAlternatives,
    assignmentVariantsRef,
    pullVariantsRef,
    draftAssignmentsRef,
    draftPullsRef,
    draftAlternativesRef,
    weekPlanAssignmentsRef,
    setDraftAssignments,
    setDraftPulls,
    setDraftAlternatives,
    setDraftFixedAssignmentsSnapshot,
    setSelectedAlternativeIndex,
    userPickedAltIndexRef,
    selectedAlternativeIndexRef,
    viewedAlternativeIndicesRef,
    setIsManual,
    setMoreAlternativesAvailable,
    setAlternativesUnlockNonce,
  });
  const {
    generationRunning,
    generationStoppable,
    replaceGenerationUiClear,
    startGeneration,
    startMoreAlternatives,
    stopGeneration,
    genBusyRef,
    stopVisibleAlternativeCountRef,
    alternativesFlushRafRef,
    generationRunningRef,
    resetGenerationForScopeChange,
    cancelGenerationForSavedEditing,
  } = generation;

  useEffect(() => {
    if (!generationRunning) {
      userPickedAltIndexRef.current = null;
    }
  }, [generationRunning]);

  useEffect(() => {
    selectedAlternativeIndexRef.current = selectedAlternativeIndex;
    if (selectedAlternativeIndex >= 0) {
      viewedAlternativeIndicesRef.current.add(selectedAlternativeIndex);
    }
  }, [selectedAlternativeIndex]);
  useEffect(() => {
    draftAssignmentsRef.current = draftAssignments;
  }, [draftAssignments]);
  useEffect(() => {
    draftPullsRef.current = draftPulls || {};
  }, [draftPulls]);
  useEffect(() => {
    // Pendant le SSE, la ref est la source de vérité (en avance sur le state).
    // Ne pas l’écraser avec un state en retard (perdrait des alternatives streamées).
    if (generationRunningRef.current) return;
    draftAlternativesRef.current = draftAlternatives;
  }, [draftAlternatives, generationRunningRef]);
  useEffect(() => {
    weekPlanAssignmentsRef.current = weekPlan?.assignments ?? undefined;
  }, [weekPlan?.assignments]);

  /** סנכרון isManual מהשרת פעם אחת אחרי טעינת weekPlan לשבוע (לא בכל refetch — שומר על ידני / אפס גריד). */
  const planLoadedForManualRef = useRef(false);

  // Reset drafts seulement au changement de site / semaine — pas quand linkedSitesLength
  // passe de 0→N (sinon on efface une réhydratation mémoire déjà faite au retour multi-sites).
  useEffect(() => {
    resetGenerationForScopeChange();
    setDraftAssignments(null);
    setDraftPulls(null);
    setDraftAlternatives([]);
    setDraftFixedAssignmentsSnapshot(null);
    const preservedAltIndex = !protectOfficialSavedPlan
      ? Math.max(0, Number(readLinkedPlansFromMemory(weekStart)?.activeAltIndex || 0))
      : 0;
    setSelectedAlternativeIndex(preservedAltIndex);
    userPickedAltIndexRef.current = preservedAltIndex;
    viewedAlternativeIndicesRef.current = new Set();
    setMoreAlternativesAvailable(true);
    planLoadedForManualRef.current = false;
    pullsPreferNoticesRef.current = { active: false, fallbackShown: false, mixedAltsShown: false };
  }, [protectOfficialSavedPlan, resetGenerationForScopeChange, siteId, weekIso, weekStart]);

  // Quand les sites liés arrivent après le 1er rendu, resynchroniser l’index partagé
  // sans vider les drafts / alternatives déjà réhydratés.
  useEffect(() => {
    if (linkedSitesLength <= 1) return;
    if (protectOfficialSavedPlan) return;
    const memIdx = Math.max(0, Number(readLinkedPlansFromMemory(weekStart)?.activeAltIndex || 0));
    setSelectedAlternativeIndex((prev) => (prev === memIdx ? prev : memIdx));
    userPickedAltIndexRef.current = memIdx;
  }, [linkedSitesLength, protectOfficialSavedPlan, weekStart]);

  useEffect(() => {
    if (!protectOfficialSavedPlan) return;
    if (genBusyRef.current) return;
    setDraftAssignments(null);
    setDraftPulls(null);
    setDraftAlternatives([]);
    setDraftFixedAssignmentsSnapshot(null);
    setSelectedAlternativeIndex(0);
    if (linkedSitesLength > 1) {
      clearLinkedPlansFromMemory(weekStart);
    }
  }, [linkedSitesLength, protectOfficialSavedPlan, weekPlan?.assignments, weekPlan?.sourceScope, weekStart]);

  useEffect(() => {
    if (weekPlanLoading) return;
    if (!weekPlan) return;
    if (planLoadedForManualRef.current) return;
    planLoadedForManualRef.current = true;
    setIsManual(!!weekPlan.isManual);
  }, [weekPlanLoading, weekPlan, weekPlan?.isManual]);

  const {
    assignmentVariants,
    pullVariants,
    alternativeCount,
    alternativesUnlocked,
    safeAlternativeIndex,
    displayAssignments,
    displayPulls,
  } = usePlanningV2DisplayVariants({
    draftAssignments,
    draftPulls,
    draftAlternatives,
    setDraftAssignments,
    setDraftPulls,
    setDraftAlternatives,
    draftAssignmentsRef,
    draftAlternativesRef,
    weekPlan,
    site,
    siteId,
    weekStart,
    weekIso,
    linkedSitesLength,
    protectOfficialSavedPlan,
    dedupeAlternatives,
    generation: {
      generationRunning,
      replaceGenerationUiClear,
      stopVisibleAlternativeCountRef,
      generationRunningRef,
      genBusyRef,
    },
    selectedAlternativeIndex,
    setSelectedAlternativeIndex,
    userPickedAltIndexRef,
    weekPlanAssignmentsRef,
    clientStorageReady,
    alternativesUnlockNonce,
    assignmentVariantsRef,
    pullVariantsRef,
  });

  useEffect(() => {
    if (!replaceGenerationUiClear) return;
    pullsPreferNoticesRef.current = { active: true, fallbackShown: false, mixedAltsShown: false };
  }, [replaceGenerationUiClear]);

  useEffect(() => {
    const notices = pullsPreferNoticesRef.current;
    if (!notices.active) return;
    if (!autoPullsEnabled || isManual) return;
    const kinds = pullsPreferPayload(autoPullsPrefer);
    if (!kinds?.length) return;
    if (replaceGenerationUiClear) return;
    const maps = pullVariants;
    if (!maps.length) return;

    if (!generationRunning && !notices.fallbackShown) {
      if (!anyPlanHasPreferredPulls(maps, kinds) && anyPlanHasNonPreferredPulls(maps, kinds)) {
        notices.fallbackShown = true;
        const copy = pullsPreferFallbackToastCopy(kinds);
        toast.message(copy.title, {
          id: "planning-v2-pulls-prefer-fallback",
          description: copy.description,
          duration: 8000,
        });
      }
    }

    if (notices.mixedAltsShown || notices.fallbackShown) return;
    const firstNon = firstNonExclusivePreferredIndex(maps, kinds);
    if (firstNon == null || firstNon <= 0) return;
    if (safeAlternativeIndex < firstNon) return;
    notices.mixedAltsShown = true;
    const copy = pullsPreferMixedAltsToastCopy(kinds);
    toast.message(copy.title, {
      id: "planning-v2-pulls-prefer-mixed-alts",
      description: copy.description,
      duration: 8000,
    });
  }, [
    autoPullsEnabled,
    autoPullsPrefer,
    generationRunning,
    isManual,
    pullVariants,
    replaceGenerationUiClear,
    safeAlternativeIndex,
  ]);

  const savePlan = useCallback(
    async (publishToWorkers: boolean) => {
      const assignments = displayAssignments;
      if (!assignments || !assignmentsNonEmpty(assignments)) {
        toast.error("אין מה לשמור", { description: "לא נמצא תכנון קיים לשמירה" });
        return;
      }
      let pulls: PlanningV2PullsMap = {};
      try {
        pulls = JSON.parse(JSON.stringify(displayPulls || {})) as PlanningV2PullsMap;
      } catch {
        pulls = (displayPulls || {}) as PlanningV2PullsMap;
      }
      let assignmentsSnapshot: typeof assignments;
      try {
        assignmentsSnapshot = JSON.parse(JSON.stringify(assignments)) as typeof assignments;
      } catch {
        assignmentsSnapshot = assignments;
      }
      const payload = buildWeekPlanDataPayload(
        Number(siteId),
        weekStart,
        assignmentsSnapshot,
        pulls,
        buildWorkersSnapshotForSave(workers),
        isManual,
      );
      try {
        await persistWeekPlanToApi(siteId, weekStart, publishToWorkers, payload as unknown as Record<string, unknown>);
        setDraftAssignments(null);
        setDraftPulls(null);
        setDraftFixedAssignmentsSnapshot(null);
        await reloadWeekPlan();
        toast.success(publishToWorkers ? "התכנון נשמר ונשלח" : "התכנון נשמר (למנהל בלבד)");
      } catch (e: unknown) {
        toast.error("שמירה נכשלה", { description: String((e as Error)?.message || "נסה שוב מאוחר יותר.") });
      }
    },
    [displayAssignments, displayPulls, siteId, weekStart, workers, isManual, reloadWeekPlan],
  );

  const clearDraft = useCallback(() => {
    setDraftAssignments(null);
    setDraftPulls(null);
    setDraftAlternatives([]);
    setDraftFixedAssignmentsSnapshot(null);
    setSelectedAlternativeIndex(0);
  }, []);

  /** יציאה ממצב עריכת תכנון שמור — שחזור מיידי ללא טעינה מהשרת. */
  const cancelSavedEditing = useCallback(() => {
    cancelGenerationForSavedEditing();
    draftAssignmentsRef.current = null;
    draftPullsRef.current = {};
    draftAlternativesRef.current = [];
    setDraftAssignments(null);
    setDraftPulls(null);
    setDraftAlternatives([]);
    setDraftFixedAssignmentsSnapshot(null);
    setSelectedAlternativeIndex(0);
    setMoreAlternativesAvailable(true);
    // Remettre ידני/אוטומטי comme au plan sauvegardé (ערוך peut avoir forcé אוטומטי).
    setIsManual(!!weekPlan?.isManual);
    planLoadedForManualRef.current = true;
  }, [cancelGenerationForSavedEditing, weekPlan?.isManual]);

  const enterManualWithGridReset = useCallback(() => {
    const emptyAssignments = buildEmptyAssignmentsForSite(site);
    draftAssignmentsRef.current = emptyAssignments;
    draftPullsRef.current = {};
    draftAlternativesRef.current = [];
    setDraftAssignments(emptyAssignments);
    setDraftPulls({});
    setDraftAlternatives([]);
    setDraftFixedAssignmentsSnapshot(null);
    setSelectedAlternativeIndex(0);
    setIsManual(true);
  }, [site]);

  const enterAutoWithGridReset = useCallback(() => {
    const emptyAssignments = buildEmptyAssignmentsForSite(site);
    draftAssignmentsRef.current = emptyAssignments;
    draftPullsRef.current = {};
    draftAlternativesRef.current = [];
    setDraftAssignments(emptyAssignments);
    setDraftPulls({});
    setDraftAlternatives([]);
    setDraftFixedAssignmentsSnapshot(null);
    setSelectedAlternativeIndex(0);
    setIsManual(false);
  }, [site]);

  const setIsManualPreservingCurrentGrid = useCallback(
    (next: boolean) => {
      if (!next) {
        setIsManual(false);
        return;
      }
      const assignments = displayAssignments && typeof displayAssignments === "object"
        ? (JSON.parse(JSON.stringify(displayAssignments)) as Record<string, Record<string, string[][]>>)
        : buildEmptyAssignmentsForSite(site);
      const pulls = displayPulls && typeof displayPulls === "object"
        ? (JSON.parse(JSON.stringify(displayPulls)) as PlanningV2PullsMap)
        : {};
      setDraftAssignments(assignments);
      setDraftPulls(pulls);
      setDraftAlternatives([]);
      setDraftFixedAssignmentsSnapshot(null);
      setSelectedAlternativeIndex(0);
      setIsManual(true);
    },
    [displayAssignments, displayPulls, site],
  );

  const resetManualStation = useCallback(
    (stationIdx: number) => {
      setDraftPulls((prev) => {
        const raw = (prev ?? (weekPlan?.pulls as PlanningV2PullsMap) ?? {}) as PlanningV2PullsMap;
        const next: PlanningV2PullsMap = {};
        for (const [k, v] of Object.entries(raw)) {
          const parts = String(k).split("|");
          const stIdx = parts.length >= 3 ? parts[2] : "";
          if (String(stIdx) !== String(stationIdx)) next[k] = v;
        }
        return next;
      });
      setDraftAssignments((prev) => {
        const base = JSON.parse(
          JSON.stringify(prev ?? weekPlan?.assignments ?? buildEmptyAssignmentsForSite(site)),
        ) as Record<string, Record<string, string[][]>>;
        const shiftNames = shiftNamesFromSite(site);
        const dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
        for (const d of dayKeys) {
          for (const sn of shiftNames) {
            const shiftData = base[d]?.[sn];
            if (!Array.isArray(shiftData)) continue;
            if (Array.isArray(shiftData[stationIdx])) {
              shiftData[stationIdx] = [];
            }
          }
        }
        return base;
      });
    },
    [site, weekPlan?.assignments, weekPlan?.pulls],
  );

  const getLatestAssignmentBase = useCallback((): Record<string, Record<string, string[][]>> => {
    // Même matrice que le גריד : `displayAssignments` (brouillon + index d’alternative actif).
    // Ne pas lire seulement `draftAssignments` / refs : après « מצב ידני + שמור מיקומים » ou autre
    // parcours, la surbrillance de drag et analyzeManualSlotDrop doivent suivre l’affichage exact.
    if (!displayAssignments || typeof displayAssignments !== "object") {
      return JSON.parse(JSON.stringify(buildEmptyAssignmentsForSite(site))) as Record<
        string,
        Record<string, string[][]>
      >;
    }
    return JSON.parse(JSON.stringify(displayAssignments)) as Record<string, Record<string, string[][]>>;
  }, [site, displayAssignments]);

  const commitDraftAssignments = useCallback((next: Record<string, Record<string, string[][]>>) => {
    setDraftAssignments(next);
  }, []);

  const commitDraftPulls = useCallback((next: PlanningV2PullsMap) => {
    setDraftPulls(next || {});
  }, []);

  const setAutoPullsLimitPersisted = useCallback(
    (v: string) => {
      const next = String(v ?? "");
      setAutoPullsLimit(next);
      if (typeof window === "undefined") return;
      try {
        localStorage.setItem(autoPullsStorageKey, next);
      } catch {
        /* ignore */
      }
    },
    [autoPullsStorageKey],
  );

  const setAutoPullsPreferPersisted = useCallback(
    (next: PullsShiftPrefs) => {
      const normalized: PullsShiftPrefs = {
        morning: next?.morning === true,
        noon: next?.noon === true,
        night: next?.night === true,
      };
      setAutoPullsPrefer(normalized);
      if (typeof window === "undefined") return;
      try {
        localStorage.setItem(autoPullsPreferStorageKey, JSON.stringify(normalized));
      } catch {
        /* ignore */
      }
    },
    [autoPullsPreferStorageKey],
  );

  const flushPendingAlternativesNow = useCallback(() => {
    if (typeof window !== "undefined" && alternativesFlushRafRef.current != null) {
      try {
        window.cancelAnimationFrame(alternativesFlushRafRef.current);
      } catch {
        /* ignore */
      }
      alternativesFlushRafRef.current = null;
    }
    const stopLimit = stopVisibleAlternativeCountRef.current;
    const normalized = draftAlternativesForMode(draftAlternativesRef.current || [], dedupeAlternatives);
    const maxDraftAlternatives =
      stopLimit == null ? normalized.length : draftAssignmentsRef.current ? Math.max(0, stopLimit - 1) : stopLimit;
    const next = normalized.slice(0, maxDraftAlternatives);
    if (stopLimit != null && next.length !== draftAlternativesRef.current.length) {
      draftAlternativesRef.current = next;
    }
    setDraftAlternatives((prev) => {
      if (prev.length === next.length) {
        return prev === draftAlternativesRef.current ? prev : [...next];
      }
      return [...next];
    });
    const hasBase = !!draftAssignmentsRef.current;
    return (hasBase ? 1 : 0) + next.length;
  }, [dedupeAlternatives]);

  const setSelectedAlternativeIndexSynced = useCallback(
    (index: number) => {
      // Pendant le streaming, flusher les alternatives SSE en retard avant d’appliquer
      // l’index. Pas de flushSync ici : ce setter est aussi appelé depuis des useEffect.
      let maxIdx = Number.POSITIVE_INFINITY;
      if (generationRunningRef.current) {
        const liveCount = flushPendingAlternativesNow();
        maxIdx = Math.max(0, liveCount - 1);
      }
      const next = Math.min(Math.max(0, Number(index || 0)), maxIdx);
      userPickedAltIndexRef.current = next;
      selectedAlternativeIndexRef.current = next;
      viewedAlternativeIndicesRef.current.add(next);
      setSelectedAlternativeIndex((prev) => (prev === next ? prev : next));
      if (linkedSitesLength > 1) {
        const mem = readLinkedPlansFromMemory(weekStart);
        if (mem?.plansBySite && Object.keys(mem.plansBySite).length > 0) {
          const curAlt = Math.max(0, Number(mem.activeAltIndex || 0));
          if (curAlt !== next) {
            saveLinkedPlansToMemory(weekStart, mem.plansBySite, next);
          }
        }
      }
    },
    [flushPendingAlternativesNow, linkedSitesLength, siteId, weekIso, weekStart],
  );

  return {
    displayAssignments,
    displayPulls,
    assignmentVariants,
    pullVariants,
    generationRunning,
    generationStoppable,
    startGeneration,
    startMoreAlternatives,
    stopGeneration,
    savePlan,
    autoPullsLimit,
    setAutoPullsLimit: setAutoPullsLimitPersisted,
    autoPullsPrefer,
    setAutoPullsPrefer: setAutoPullsPreferPersisted,
    autoPullsEnabled,
    isManual,
    setIsManual: setIsManualPreservingCurrentGrid,
    selectedAlternativeIndex: safeAlternativeIndex,
    setSelectedAlternativeIndex: setSelectedAlternativeIndexSynced,
    alternativeCount,
    moreAlternativesAvailable,
    alternativesUnlocked,
    draftFixedAssignmentsSnapshot,
    draftActive: draftAssignments !== null,
    clearDraft,
    cancelSavedEditing,
    enterManualWithGridReset,
    enterAutoWithGridReset,
    resetManualStation,
    getLatestAssignmentBase,
    commitDraftAssignments,
    commitDraftPulls,
  };
}

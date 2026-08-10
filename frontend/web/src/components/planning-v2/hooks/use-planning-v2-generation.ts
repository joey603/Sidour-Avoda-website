"use client";

import { startTransition, useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import type { PlanningV2PullsMap, PlanningWorker, SiteSummary, WorkerAvailability } from "../types";
import { assignmentsNonEmpty } from "../lib/assignments-empty";
import {
  buildWeekPlanDataPayload,
  buildWorkersSnapshotForSave,
  persistAutoWeekPlanDraftToApi,
} from "../lib/week-plan-persist";
import { weeklyAvailabilityMapFromRows } from "../lib/weekly-availability-for-ai";
import { stripEventLocksFromAvailabilityMap } from "../lib/event-availability-locks";
import {
  buildPersistableLinkedPlans,
  clearLinkedPlansFromMemory,
  readLinkedPlansFromMemory,
  saveLinkedPlansToMemory,
  type LinkedSitePlan,
} from "../lib/multi-site-linked-memory";
import {
  clearSitesListPlanningBeforePlanningCreat,
  clearSitesListPlanningClientCachesBeforePlanningCreat,
} from "@/lib/clear-sites-list-planning-for-week";
import { clearAllPlanningSessionCaches } from "@/lib/planning-session-cache";
import { apiFetch, getApiBaseUrl } from "@/lib/api";
import { readSseStream } from "../lib/planning-v2-sse";
import {
  GENERATION_ACCEPTED_IDLE_CLOSE_MS,
  GENERATION_PLATEAU_IDLE_CLOSE_MS,
  GENERATION_STAGNANT_NOISE_EVENTS,
  GENERATION_STAGNANT_NOISE_IDLE_MS,
  MULTI_SITE_GENERATION_NUM_ALTERNATIVES,
  MULTI_SITE_GENERATION_TIME_LIMIT_SECONDS,
  SINGLE_SITE_GENERATION_NUM_ALTERNATIVES,
  SINGLE_SITE_GENERATION_TIME_LIMIT_SECONDS,
  VISIBLE_ALTERNATIVES_BATCH_SIZE,
  adjustedAppendGenerationBudget,
} from "../lib/planning-v2-generation-budget";
import {
  linkedPlansMatchRequestedPulls,
  logPlanningV2PullCandidate,
  pullsLimitPayload,
  pullsMatchRequestedCount,
} from "../lib/planning-v2-pulls-match";
import {
  type DraftAlternative,
  alternativeSnapshot,
  buildSeenAlternativeSnapshots,
  buildSeenLinkedAlternativeSnapshots,
  draftAlternativesForMode,
  linkedSitePlansSnapshot,
  normalizeDraftAlternatives,
  uniqueDraftAlternatives,
} from "../lib/planning-v2-draft-alternatives";
import { type HoleScore, linkedPlansHoleScore, singlePlanHoleScore } from "../lib/planning-v2-hole-scores";
import {
  linkedPlansAltCounts,
  linkedSitePlansMaxShiftOverages,
  pruneLinkedPlansOverMaxShifts,
} from "../lib/planning-v2-max-shifts-prune";
import {
  PLANNING_V2_LINKED_GENERATION_STOP_UPDATED_EVENT,
  PLANNING_V2_LINKED_GENERATION_UPDATED_EVENT,
  readLinkedGenerationRunningFromSession,
  readLinkedGenerationStopRequestFromSession,
  readLinkedGenerationStopVisibleCountFromSession,
  writeAlternativesUnlockedToSession,
  writeLinkedGenerationRunningToSession,
  writeLinkedGenerationStopRequestToSession,
  writeLinkedGenerationStopVisibleCountToSession,
} from "../lib/planning-v2-generation-session";

type AssignmentGrid = Record<string, Record<string, string[][]>>;

export type GenerateOptions = {
  excludeDays?: string[];
  fixedAssignments?: AssignmentGrid;
  pullsScope?: "current_only" | "all_sites";
};

type UsePlanningV2GenerationArgs = {
  siteId: string;
  weekStart: Date;
  weekIso: string;
  site: SiteSummary | null;
  workers: PlanningWorker[];
  workerRowsForTable: Array<PlanningWorker & { availability: WorkerAvailability }>;
  reloadWeekPlan: (opts?: { silent?: boolean; preferredScope?: "director" | "shared" | "auto" | null }) => void | Promise<void>;
  editingSaved: boolean;
  hasOfficialSavedWeekPlan: boolean;
  linkedSitesLength: number;
  weekPurgeSiteIds: number[];
  getVisibleAlternativeCount?: () => number;
  eventLocksByWorkerId: Record<number, Record<string, string[]>>;
  autoPullsEnabled: boolean;
  autoPullsLimit: string;
  dedupeAlternatives: boolean;
  assignmentVariantsRef: MutableRefObject<AssignmentGrid[]>;
  pullVariantsRef: MutableRefObject<PlanningV2PullsMap[]>;
  draftAssignmentsRef: MutableRefObject<AssignmentGrid | null>;
  draftPullsRef: MutableRefObject<PlanningV2PullsMap>;
  draftAlternativesRef: MutableRefObject<DraftAlternative[]>;
  weekPlanAssignmentsRef: MutableRefObject<AssignmentGrid | undefined>;
  setDraftAssignments: Dispatch<SetStateAction<AssignmentGrid | null>>;
  setDraftPulls: Dispatch<SetStateAction<PlanningV2PullsMap | null>>;
  setDraftAlternatives: Dispatch<SetStateAction<DraftAlternative[]>>;
  setDraftFixedAssignmentsSnapshot: Dispatch<SetStateAction<AssignmentGrid | null>>;
  setSelectedAlternativeIndex: Dispatch<SetStateAction<number>>;
  setIsManual: Dispatch<SetStateAction<boolean>>;
  setMoreAlternativesAvailable: Dispatch<SetStateAction<boolean>>;
  setAlternativesUnlockNonce: Dispatch<SetStateAction<number>>;
};

export function usePlanningV2Generation({
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
  setIsManual,
  setMoreAlternativesAvailable,
  setAlternativesUnlockNonce,
}: UsePlanningV2GenerationArgs) {
  const [localGenerationRunning, setGenerationRunning] = useState(false);
  const [sharedLinkedGenerationRunning, setSharedLinkedGenerationRunning] = useState(false);
  /** Pendant יצירה « replace », pas de brouillon : sans ça les variantes restent celles du weekPlan jusqu’au reload + premier SSE — compteur חלופות figé. */
  const [replaceGenerationUiClear, setReplaceGenerationUiClear] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const generationIdRef = useRef<string | null>(null);
  const genBusyRef = useRef(false);
  const userStoppedGenerationRef = useRef(false);
  const stopVisibleAlternativeCountRef = useRef<number | null>(null);
  const lastAlternativeSnapshotRef = useRef<string>("");
  const seenAlternativeSnapshotsRef = useRef<Set<string>>(new Set());
  const seenLinkedAlternativeSnapshotsRef = useRef<Set<string>>(new Set());
  const bestGeneratedHoleScoreRef = useRef<HoleScore | null>(null);
  const appendUniqueCountRef = useRef(0);
  const alternativesFlushRafRef = useRef<number | null>(null);
  const generationRunningRef = useRef(false);
  const workersRef = useRef(workers);

  useEffect(() => {
    workersRef.current = workers;
  }, [workers]);

  const pruneLinkedPlansMemoryAfterStop = useCallback(
    (visibleAlternativeCount: number) => {
      if (linkedSitesLength <= 1) return;
      const mem = readLinkedPlansFromMemory(weekStart);
      if (!mem?.plansBySite || typeof mem.plansBySite !== "object") return;
      const maxVisibleIndex = Math.max(0, visibleAlternativeCount - 1);
      const maxStoredAlternatives = maxVisibleIndex;
      const nextPlans: Record<string, LinkedSitePlan> = {};
      let changed = false;
      for (const [sid, plan] of Object.entries(mem.plansBySite)) {
        if (!plan || typeof plan !== "object") continue;
        const alternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
        const alternativePulls = Array.isArray(plan.alternative_pulls) ? plan.alternative_pulls : [];
        const nextAlternatives = alternatives.slice(0, maxStoredAlternatives);
        const nextAlternativePulls = alternativePulls.slice(0, maxStoredAlternatives);
        nextPlans[sid] = {
          ...plan,
          alternatives: nextAlternatives,
          alternative_pulls: nextAlternativePulls,
        };
        if (nextAlternatives.length !== alternatives.length || nextAlternativePulls.length !== alternativePulls.length) {
          changed = true;
        }
      }
      const nextActiveIndex = Math.min(Math.max(0, Number(mem.activeAltIndex || 0)), maxVisibleIndex);
      if (!changed && nextActiveIndex === Math.max(0, Number(mem.activeAltIndex || 0))) return;
      saveLinkedPlansToMemory(weekStart, nextPlans, nextActiveIndex);
    },
    [linkedSitesLength, weekStart],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (linkedSitesLength <= 1) {
      setSharedLinkedGenerationRunning(false);
      return;
    }
    const sync = () => setSharedLinkedGenerationRunning(readLinkedGenerationRunningFromSession(weekIso));
    sync();
    window.addEventListener(PLANNING_V2_LINKED_GENERATION_UPDATED_EVENT, sync as EventListener);
    return () => window.removeEventListener(PLANNING_V2_LINKED_GENERATION_UPDATED_EVENT, sync as EventListener);
  }, [linkedSitesLength, weekIso]);

  const generationRunning = localGenerationRunning || sharedLinkedGenerationRunning;
  const generationStoppable = (localGenerationRunning && abortRef.current !== null) || (linkedSitesLength > 1 && sharedLinkedGenerationRunning);
  generationRunningRef.current = generationRunning;

  const resetGenerationForScopeChange = useCallback(() => {
    try {
      abortRef.current?.abort();
    } catch {
      /* ignore */
    }
    abortRef.current = null;
    genBusyRef.current = false;
    generationIdRef.current = null;
    userStoppedGenerationRef.current = false;
    setGenerationRunning(false);
    setSharedLinkedGenerationRunning(false);
    setReplaceGenerationUiClear(false);
    seenAlternativeSnapshotsRef.current = new Set();
    seenLinkedAlternativeSnapshotsRef.current = new Set();
    bestGeneratedHoleScoreRef.current = null;
    appendUniqueCountRef.current = 0;
    lastAlternativeSnapshotRef.current = "";
  }, []);

  const cancelGenerationForSavedEditing = useCallback(() => {
    userStoppedGenerationRef.current = true;
    try {
      abortRef.current?.abort();
    } catch {
      /* ignore */
    }
    abortRef.current = null;
    genBusyRef.current = false;
    generationIdRef.current = null;
    if (alternativesFlushRafRef.current != null) {
      try {
        window.cancelAnimationFrame(alternativesFlushRafRef.current);
      } catch {
        /* ignore */
      }
      alternativesFlushRafRef.current = null;
    }
    stopVisibleAlternativeCountRef.current = null;
    setGenerationRunning(false);
    setSharedLinkedGenerationRunning(false);
    setReplaceGenerationUiClear(false);
    if (linkedSitesLength > 1) {
      writeLinkedGenerationRunningToSession(weekIso, false);
      writeLinkedGenerationStopRequestToSession(weekIso, false);
      clearLinkedPlansFromMemory(weekStart);
    }
  }, [linkedSitesLength, weekIso, weekStart]);

  const stopGeneration = useCallback(() => {
    userStoppedGenerationRef.current = true;
    if (linkedSitesLength > 1 && !readLinkedGenerationStopRequestFromSession(weekIso)) {
      writeLinkedGenerationStopRequestToSession(weekIso, true);
    }
    const visibleCountAtStop = Math.max(0, assignmentVariantsRef.current.length);
    stopVisibleAlternativeCountRef.current = visibleCountAtStop;
    if (linkedSitesLength > 1) {
      writeLinkedGenerationStopVisibleCountToSession(weekIso, visibleCountAtStop);
    }
    pruneLinkedPlansMemoryAfterStop(visibleCountAtStop);
    try {
      abortRef.current?.abort();
    } catch {
      /* ignore */
    }
    abortRef.current = null;
    if (alternativesFlushRafRef.current != null) {
      try {
        window.cancelAnimationFrame(alternativesFlushRafRef.current);
      } catch {
        /* ignore */
      }
      alternativesFlushRafRef.current = null;
    }
    const maxDraftAlternatives = draftAssignmentsRef.current
      ? Math.max(0, visibleCountAtStop - 1)
      : visibleCountAtStop;
    const flushedAlternatives = draftAlternativesForMode(
      draftAlternativesRef.current || [],
      dedupeAlternatives,
    ).slice(0, maxDraftAlternatives);
    draftAlternativesRef.current = flushedAlternatives;
    setDraftAlternatives([...flushedAlternatives]);
    const maxIndex = draftAssignmentsRef.current ? flushedAlternatives.length : Math.max(0, visibleCountAtStop - 1);
    setSelectedAlternativeIndex((prev) => Math.min(Math.max(0, prev), Math.max(0, maxIndex)));
    setGenerationRunning(false);
    setReplaceGenerationUiClear(false);
    if (linkedSitesLength > 1) {
      writeLinkedGenerationRunningToSession(weekIso, false);
    }
    setSharedLinkedGenerationRunning(false);
    genBusyRef.current = false;
  }, [assignmentVariantsRef, dedupeAlternatives, linkedSitesLength, pruneLinkedPlansMemoryAfterStop, weekIso]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (linkedSitesLength <= 1 || !localGenerationRunning) return;
    const onStopRequest = () => {
      if (!readLinkedGenerationStopRequestFromSession(weekIso)) return;
      stopGeneration();
    };
    window.addEventListener(PLANNING_V2_LINKED_GENERATION_STOP_UPDATED_EVENT, onStopRequest as EventListener);
    return () =>
      window.removeEventListener(PLANNING_V2_LINKED_GENERATION_STOP_UPDATED_EVENT, onStopRequest as EventListener);
  }, [linkedSitesLength, localGenerationRunning, stopGeneration, weekIso]);

  const runGeneration = useCallback(async (options?: GenerateOptions, mode: "replace" | "append" = "replace") => {
    const id = Number(siteId);
    if (!Number.isFinite(id) || id <= 0) return;
    if (genBusyRef.current) return;
    const appendMode = mode === "append";
    const assignmentVariants = assignmentVariantsRef.current;
    const pullVariants = pullVariantsRef.current;
    try {
      abortRef.current?.abort();
    } catch {
      /* ignore */
    }
    const controller = new AbortController();
    abortRef.current = controller;
    generationIdRef.current = null;
    genBusyRef.current = true;
    const resumeFromStoppedVisibleCount =
      appendMode
        ? (stopVisibleAlternativeCountRef.current ??
          (linkedSitesLength > 1 ? readLinkedGenerationStopVisibleCountFromSession(weekIso) : null))
        : null;
    userStoppedGenerationRef.current = false;
    if (linkedSitesLength > 1) {
      writeLinkedGenerationStopRequestToSession(weekIso, false);
    }
    const purgeIds =
      !appendMode
        ? weekPurgeSiteIds.length > 0
          ? weekPurgeSiteIds
          : Number.isFinite(Number(siteId)) && Number(siteId) > 0
            ? [Number(siteId)]
            : []
        : [];
    let appendExistingAlternativesCount = 0;
    if (!appendMode) {
      stopVisibleAlternativeCountRef.current = null;
      if (linkedSitesLength > 1) {
        writeLinkedGenerationStopVisibleCountToSession(weekIso, null);
      }
      // Nettoyage client immédiat avant tout await: évite l'affichage furtif des anciennes alternatives.
      clearAllPlanningSessionCaches();
      if (purgeIds.length > 0) {
        clearSitesListPlanningClientCachesBeforePlanningCreat(weekIso, purgeIds);
        try {
          window.dispatchEvent(
            new CustomEvent("planning-v2-assignment-filters-reset", {
              detail: { weekIso },
            }),
          );
        } catch {
          /* ignore */
        }
      }
      draftAssignmentsRef.current = null;
      draftPullsRef.current = {};
      draftAlternativesRef.current = [];
      seenAlternativeSnapshotsRef.current = new Set();
      seenLinkedAlternativeSnapshotsRef.current = new Set();
      bestGeneratedHoleScoreRef.current = null;
      appendUniqueCountRef.current = 0;
      lastAlternativeSnapshotRef.current = "";
      flushSync(() => {
        setGenerationRunning(true);
        setReplaceGenerationUiClear(true);
        setIsManual(false);
        setSelectedAlternativeIndex(0);
        setMoreAlternativesAvailable(true);
        setDraftAssignments(null);
        setDraftPulls(null);
        setDraftAlternatives([]);
      });
    } else {
      // Sync immédiat : sinon les 1ers events SSE « עוד » flushent encore via startTransition
      // (generationRunningRef encore false) et le compteur חלופות ne monte pas en live.
      generationRunningRef.current = true;
      flushSync(() => {
        setGenerationRunning(true);
        setReplaceGenerationUiClear(false);
      });
      if (resumeFromStoppedVisibleCount != null) {
        stopVisibleAlternativeCountRef.current = resumeFromStoppedVisibleCount;
        pruneLinkedPlansMemoryAfterStop(resumeFromStoppedVisibleCount);
      }
      const normalizedLinkedPlans =
        linkedSitesLength > 1 ? buildPersistableLinkedPlans(readLinkedPlansFromMemory(weekStart)?.plansBySite) : null;
      const currentLinkedPlan = normalizedLinkedPlans?.[String(siteId)];
      const baseAssignments =
        (currentLinkedPlan?.assignments as Record<string, Record<string, string[][]>> | undefined) ??
        draftAssignmentsRef.current ??
        weekPlanAssignmentsRef.current ??
        (assignmentVariants[0] && typeof assignmentVariants[0] === "object" ? assignmentVariants[0] : null);
      const basePulls =
        (((currentLinkedPlan?.pulls as PlanningV2PullsMap | undefined) || undefined) ??
        draftPullsRef.current) ||
        ((pullVariants[0] && typeof pullVariants[0] === "object" ? pullVariants[0] : {}) as PlanningV2PullsMap);
      const existingAlternativesAll = normalizeDraftAlternatives(
        currentLinkedPlan
          ? (Array.isArray(currentLinkedPlan.alternatives) ? currentLinkedPlan.alternatives : []).map((assignments, idx) => ({
              assignments,
              pulls:
                ((Array.isArray(currentLinkedPlan.alternative_pulls) ? currentLinkedPlan.alternative_pulls[idx] : {}) ||
                  {}) as PlanningV2PullsMap,
            }))
          : draftAssignmentsRef.current
            ? draftAlternativesRef.current || []
            : assignmentVariants.slice(1).map((assignments, idx) => ({
                assignments,
                pulls: (pullVariants[idx + 1] || {}) as PlanningV2PullsMap,
              })),
      );
      const existingAlternatives =
        resumeFromStoppedVisibleCount == null
          ? existingAlternativesAll
          : existingAlternativesAll.slice(0, Math.max(0, resumeFromStoppedVisibleCount - 1));
      appendExistingAlternativesCount = existingAlternatives.length;
      if (normalizedLinkedPlans && Object.keys(normalizedLinkedPlans).length > 0) {
        const appendMemoryBefore = readLinkedPlansFromMemory(weekStart);
        const activeIdx = Math.max(0, Number(appendMemoryBefore?.activeAltIndex || 0));
        const nextActiveIdx =
          resumeFromStoppedVisibleCount == null ? activeIdx : Math.min(activeIdx, Math.max(0, resumeFromStoppedVisibleCount - 1));
        // Conserve l’index choisi par l’utilisateur (nav manuelle uniquement — pas d’auto-défilement).
        saveLinkedPlansToMemory(weekStart, normalizedLinkedPlans, nextActiveIdx);
      }
      if (baseAssignments && typeof baseAssignments === "object") {
        draftAssignmentsRef.current = baseAssignments;
        draftPullsRef.current = basePulls;
        draftAlternativesRef.current = draftAlternativesForMode(existingAlternatives, dedupeAlternatives);
        setDraftAssignments(baseAssignments);
        setDraftPulls(basePulls);
        setDraftAlternatives(draftAlternativesForMode(existingAlternatives, dedupeAlternatives));
      }
      stopVisibleAlternativeCountRef.current = null;
      if (linkedSitesLength > 1) {
        writeLinkedGenerationStopVisibleCountToSession(weekIso, null);
      }
      seenAlternativeSnapshotsRef.current = dedupeAlternatives
        ? buildSeenAlternativeSnapshots(baseAssignments, basePulls, existingAlternatives)
        : new Set();
      seenLinkedAlternativeSnapshotsRef.current =
        linkedSitesLength > 1 && dedupeAlternatives
          ? buildSeenLinkedAlternativeSnapshots(readLinkedPlansFromMemory(weekStart)?.plansBySite || {})
          : new Set();
      bestGeneratedHoleScoreRef.current = baseAssignments
        ? singlePlanHoleScore(site, baseAssignments, basePulls)
        : null;
      appendUniqueCountRef.current = 0;
      lastAlternativeSnapshotRef.current = "";
    }
    if (linkedSitesLength > 1) {
      writeLinkedGenerationRunningToSession(weekIso, true);
    }
    if (alternativesFlushRafRef.current != null) {
      try {
        window.cancelAnimationFrame(alternativesFlushRafRef.current);
      } catch {
        /* ignore */
      }
      alternativesFlushRafRef.current = null;
    }
    // Session « mémoire » multi-sites (clés multi_site_*) : efface tout état client lié à une ריצה / navigation précédente.
    if (!appendMode) {
      if (purgeIds.length > 0) {
        try {
          await clearSitesListPlanningBeforePlanningCreat(weekIso, purgeIds);
          await reloadWeekPlan({ silent: true });
        } catch {
          /* ignore */
        }
      }
    }
    const excludeDays = options?.excludeDays;
    const fixedAssignments = options?.fixedAssignments;
    setDraftFixedAssignmentsSnapshot(
      fixedAssignments ? (JSON.parse(JSON.stringify(fixedAssignments)) as Record<string, Record<string, string[][]>>) : null,
    );

    const weekly_availability = stripEventLocksFromAvailabilityMap(
      weeklyAvailabilityMapFromRows(workerRowsForTable),
      eventLocksByWorkerId,
      workers,
    );
    const pulls_limit = pullsLimitPayload(autoPullsEnabled, autoPullsLimit);
    const requestedPullsCount = typeof pulls_limit === "number" ? pulls_limit : null;
    const pulls_limits_by_site =
      linkedSitesLength > 1 && autoPullsEnabled && options?.pullsScope === "current_only"
        ? Object.fromEntries(
            weekPurgeSiteIds
              .filter((id) => Number.isFinite(Number(id)) && Number(id) > 0)
              .map((id) => [String(id), String(id) === String(siteId) ? pulls_limit : 0]),
          )
        : undefined;

    const linked = linkedSitesLength > 1;
    const budget = appendMode
      ? adjustedAppendGenerationBudget(linked, appendExistingAlternativesCount)
      : {
          numAlternatives: linked ? MULTI_SITE_GENERATION_NUM_ALTERNATIVES : SINGLE_SITE_GENERATION_NUM_ALTERNATIVES,
          timeLimitSeconds: linked ? MULTI_SITE_GENERATION_TIME_LIMIT_SECONDS : SINGLE_SITE_GENERATION_TIME_LIMIT_SECONDS,
        };
    const url = linked
      ? `${getApiBaseUrl()}/director/sites/${siteId}/ai-generate-linked/stream`
      : `${getApiBaseUrl()}/director/sites/${siteId}/ai-generate/stream`;

    const body = linked
      ? {
          week_iso: weekIso,
          num_alternatives: budget.numAlternatives,
          time_limit_seconds: budget.timeLimitSeconds,
          auto_pulls_enabled: autoPullsEnabled,
          pulls_limit,
          pulls_limits_by_site,
          fixed_assignments: fixedAssignments,
          exclude_days: excludeDays && excludeDays.length ? excludeDays : undefined,
          weekly_availability,
        }
      : {
          week_iso: weekIso,
          num_alternatives: budget.numAlternatives,
          time_limit_seconds: budget.timeLimitSeconds,
          auto_pulls_enabled: autoPullsEnabled,
          pulls_limit,
          fixed_assignments: fixedAssignments,
          exclude_days: excludeDays && excludeDays.length ? excludeDays : undefined,
          weekly_availability,
        };

    let idleWatch: number | null = null;
    let noResultWatch: number | null = null;
    let stopRequestWatch: number | null = null;
    let idleAutoClosed = false;
    let noResultAutoClosed = false;
    let sawPlanToPersist = false;
    let sawGeneratedPlan = false;
    let generationVisualFinished = false;
    let stopped = false;
    let batchTargetReached = false;
    let serverExhaustedAlternatives = false;
    let lastAcceptedPlanAt = Date.now();
    let stagnantNoiseEvents = 0;
    const visibleAlternativeCountAtStart = Math.max(0, Number(getVisibleAlternativeCount?.() || 0));
    const finishGenerationVisualState = () => {
      if (generationVisualFinished) return;
      generationVisualFinished = true;
      // flushSync : sinon יוצר/stop restent visibles pendant les startTransition des חלופות.
      flushSync(() => {
        setGenerationRunning(false);
        setReplaceGenerationUiClear(false);
        setSharedLinkedGenerationRunning(false);
      });
      abortRef.current = null;
      if (linkedSitesLength > 1) {
        writeLinkedGenerationRunningToSession(weekIso, false);
        writeLinkedGenerationStopRequestToSession(weekIso, false);
      }
    };
    const markAcceptedPlan = () => {
      lastAcceptedPlanAt = Date.now();
      stagnantNoiseEvents = 0;
    };
    const markStagnantNoise = () => {
      stagnantNoiseEvents += 1;
    };
    const scheduleAlternativesFlush = () => {
      if (alternativesFlushRafRef.current != null) return;
      alternativesFlushRafRef.current = window.requestAnimationFrame(() => {
        alternativesFlushRafRef.current = null;
        const apply = () => {
          setDraftAlternatives((prev) => {
            const normalized = draftAlternativesForMode(draftAlternativesRef.current || [], dedupeAlternatives);
            const stopLimit = stopVisibleAlternativeCountRef.current;
            const maxDraftAlternatives =
              stopLimit == null ? normalized.length : draftAssignmentsRef.current ? Math.max(0, stopLimit - 1) : stopLimit;
            const next = normalized.slice(0, maxDraftAlternatives);
            if (stopLimit != null && next.length !== draftAlternativesRef.current.length) {
              draftAlternativesRef.current = next;
            }
            // Multi-site: ne pas court-circuiter sur la seule longueur — les slots
            // peuvent se remplir sans changer length, et startTransition était trop
            // différé pendant le SSE lourd (les alts n’apparaissaient qu’au clic prev/next).
            if (prev.length === next.length) {
              if (linkedSitesLength <= 1) return prev;
              if (prev === next) return prev;
              let same = true;
              for (let i = 0; i < next.length; i += 1) {
                if (prev[i]?.assignments !== next[i]?.assignments || prev[i]?.pulls !== next[i]?.pulls) {
                  same = false;
                  break;
                }
              }
              if (same) return prev;
            }
            return [...next];
          });
        };
        // Pendant le streaming multi-site (יצירה או עוד), appliquer tout de suite
        // pour que le compteur חלופות monte en live. Pas d’auto-navigation d’index :
        // prev/next restent uniquement manuels.
        if (linkedSitesLength > 1 && (generationRunningRef.current || genBusyRef.current)) {
          apply();
        } else {
          startTransition(apply);
        }
      });
    };

    const stopWhenBatchTargetReached = () => {
      const visibleAdded = Math.max(0, Number(getVisibleAlternativeCount?.() || 0) - visibleAlternativeCountAtStart);
      const batchCount = getVisibleAlternativeCount ? visibleAdded : appendUniqueCountRef.current;
      if (batchCount < VISIBLE_ALTERNATIVES_BATCH_SIZE) return false;
      batchTargetReached = true;
      stopped = true;
      finishGenerationVisualState();
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      return true;
    };

    const currentBatchVisibleCount = () =>
      getVisibleAlternativeCount
        ? Math.max(0, Number(getVisibleAlternativeCount() || 0) - visibleAlternativeCountAtStart)
        : appendUniqueCountRef.current;

    const pruneDraftAlternativesByBestHoles = (bestScore: HoleScore) => {
      const before = draftAlternativesRef.current.length;
      draftAlternativesRef.current = normalizeDraftAlternatives(draftAlternativesRef.current || []).filter((alt) => {
        const score = singlePlanHoleScore(site, alt.assignments, alt.pulls);
        return score.holes < bestScore.holes || (score.holes === bestScore.holes && score.pulls <= bestScore.pulls);
      });
      if (draftAlternativesRef.current.length !== before) {
        scheduleAlternativesFlush();
      }
    };

    const shouldRejectForHoleScore = (
      score: HoleScore,
      itemType: "base" | "alternative",
      eventIndex: unknown,
      generationId: unknown,
    ): boolean => {
      if (!autoPullsEnabled) return false;
      const best = bestGeneratedHoleScoreRef.current;
      void itemType;
      void eventIndex;
      void generationId;
      void appendMode;
      void requestedPullsCount;
      if (
        !best ||
        score.holes < best.holes ||
        (score.holes === best.holes && score.pulls < best.pulls) ||
        (score.holes === best.holes && score.pulls === best.pulls && score.assigned > best.assigned)
      ) {
        bestGeneratedHoleScoreRef.current = score;
        pruneDraftAlternativesByBestHoles(score);
        return false;
      }
      if (score.holes > best.holes || (score.holes === best.holes && score.pulls > best.pulls)) {
        return true;
      }
      return false;
    };

    const persistGeneratedAutoDraftToServer = async () => {
      if (linkedSitesLength > 1) {
        const mem = readLinkedPlansFromMemory(weekStart);
        let persistablePlans = buildPersistableLinkedPlans(mem?.plansBySite);
        const currentSiteKey = String(siteId);
        const currentPersistablePlan = persistablePlans[currentSiteKey];
        const currentVisibleAssignments =
          draftAssignmentsRef.current ??
          weekPlanAssignmentsRef.current ??
          (assignmentVariants[0] && typeof assignmentVariants[0] === "object" ? assignmentVariants[0] : null);
        if (
          currentPersistablePlan &&
          !assignmentsNonEmpty(currentPersistablePlan.assignments ?? null) &&
          assignmentsNonEmpty(currentVisibleAssignments ?? null)
        ) {
          persistablePlans = {
            ...persistablePlans,
            [currentSiteKey]: {
              ...currentPersistablePlan,
              assignments: currentVisibleAssignments as Record<string, Record<string, string[][]>>,
              pulls:
                (draftPullsRef.current && typeof draftPullsRef.current === "object"
                  ? draftPullsRef.current
                  : {}) as Record<string, unknown>,
            },
          };
          console.warn("[planning-v2][multi-site][persist][hydrate-current-site-before-save]", {
            siteId: String(siteId),
            weekIso,
            beforeAltCounts: linkedPlansAltCounts(mem?.plansBySite),
            afterAltCounts: linkedPlansAltCounts(persistablePlans),
          });
        }
        const persistedSiteIds: string[] = [];
        for (const [sid, pl] of Object.entries(persistablePlans)) {
          const assignments = pl.assignments;
          if (!assignments || !assignmentsNonEmpty(assignments)) continue;
          const pulls = (pl.pulls && typeof pl.pulls === "object" ? pl.pulls : {}) as Record<string, unknown>;
          const altAsg = Array.isArray(pl.alternatives) ? pl.alternatives : [];
          const altPulls = Array.isArray(pl.alternative_pulls) ? pl.alternative_pulls : [];
          const w = String(sid) === String(siteId) ? workersRef.current : [];
          const base = buildWeekPlanDataPayload(
            Number(sid),
            weekStart,
            assignments as Record<string, Record<string, string[][]>>,
            pulls as PlanningV2PullsMap,
            buildWorkersSnapshotForSave(w),
            false,
          ) as Record<string, unknown>;
          if (altAsg.length > 0) {
            base.alternatives = altAsg;
            base.alternative_pulls = altPulls.map((x) => (x && typeof x === "object" ? x : {}));
          }
          await persistAutoWeekPlanDraftToApi(sid, weekStart, base);
          persistedSiteIds.push(String(sid));
        }
        if (persistedSiteIds.length > 0) {
          try {
            const refreshedEntries = await Promise.all(
              persistedSiteIds.map(async (sid) => {
                const payload = await apiFetch<LinkedSitePlan | null>(
                  `/director/sites/${sid}/week-plan?week=${encodeURIComponent(weekIso)}&scope=auto`,
                  {
                    cache: "no-store" as RequestCache,
                  },
                );
                return [sid, (payload && typeof payload === "object" ? payload : {}) as LinkedSitePlan] as const;
              }),
            );
            const refreshedPlans = Object.fromEntries(refreshedEntries);
            const nextPlans = buildPersistableLinkedPlans({
              ...persistablePlans,
              ...refreshedPlans,
            });
            const nextActiveAltIndex = Math.max(0, Number(mem?.activeAltIndex || 0));
            console.warn("[planning-v2][multi-site][persist][refreshed-auto-plans]", {
              siteId: String(siteId),
              weekIso,
              activeIdx: nextActiveAltIndex,
              savedSiteIds: persistedSiteIds,
              beforeAltCounts: linkedPlansAltCounts(persistablePlans),
              refreshedAltCounts: linkedPlansAltCounts(refreshedPlans),
              afterAltCounts: linkedPlansAltCounts(nextPlans),
            });
            saveLinkedPlansToMemory(weekStart, nextPlans, nextActiveAltIndex);
            seenLinkedAlternativeSnapshotsRef.current = buildSeenLinkedAlternativeSnapshots(nextPlans);
          } catch {
            /* ignore */
          }
        }
        return;
      }
      const asg = draftAssignmentsRef.current;
      if (!asg || !assignmentsNonEmpty(asg)) return;
      const pulls = draftPullsRef.current || {};
      const alts = uniqueDraftAlternatives(draftAlternativesRef.current || []);
      const base = buildWeekPlanDataPayload(
        Number(siteId),
        weekStart,
        asg,
        pulls,
        buildWorkersSnapshotForSave(workersRef.current),
        false,
      ) as Record<string, unknown>;
      if (alts.length > 0) {
        base.alternatives = alts.map((x) => x.assignments);
        base.alternative_pulls = alts.map((x) => x.pulls || {});
      }
      await persistAutoWeekPlanDraftToApi(siteId, weekStart, base);
    };

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        credentials: "include",
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        let detail = `HTTP ${resp.status}`;
        if (resp.status === 429) {
          try {
            const errBody = (await resp.json()) as { detail?: unknown };
            const raw = errBody?.detail;
            detail =
              typeof raw === "string" && raw.trim()
                ? raw.trim()
                : "יצירת תכנון כבר רצה — נסה שוב בעוד רגע.";
          } catch {
            detail = "יצירת תכנון כבר רצה — נסה שוב בעוד רגע.";
          }
        }
        throw new Error(detail);
      }
      if (linkedSitesLength > 1) {
        stopRequestWatch = window.setInterval(() => {
          if (stopped) return;
          if (!readLinkedGenerationStopRequestFromSession(weekIso)) return;
          userStoppedGenerationRef.current = true;
          const visibleCountAtStop = Math.max(0, assignmentVariantsRef.current.length);
          stopVisibleAlternativeCountRef.current = visibleCountAtStop;
          writeLinkedGenerationStopVisibleCountToSession(weekIso, visibleCountAtStop);
          pruneLinkedPlansMemoryAfterStop(visibleCountAtStop);
          stopped = true;
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
        }, 300);
      }
      // Filet de sécurité: si aucune proposition n'arrive, ne pas laisser יוצר tourner indéfiniment.
      noResultWatch = window.setTimeout(() => {
        if (stopped || sawGeneratedPlan) return;
        noResultAutoClosed = true;
        stopped = true;
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      }, 130000);
      // Sans nouveau plan accepté : couper יוצר/stop (le SSE peut encore spammer pulls_debug).
      idleWatch = window.setInterval(() => {
        if (stopped) return;
        if (!sawGeneratedPlan) return;
        const idleMs = Date.now() - lastAcceptedPlanAt;
        const hadAlternatives =
          appendUniqueCountRef.current > 0 || (draftAlternativesRef.current?.length || 0) > 0;
        const silenceLimit = hadAlternatives ? GENERATION_PLATEAU_IDLE_CLOSE_MS : GENERATION_ACCEPTED_IDLE_CLOSE_MS;
        const exhaustedBySilence = idleMs >= silenceLimit;
        // Beaucoup de rejets SSE sans nouvelle חלופה visible → fin perçue plus tôt.
        const exhaustedByNoise =
          idleMs >= GENERATION_STAGNANT_NOISE_IDLE_MS && stagnantNoiseEvents >= GENERATION_STAGNANT_NOISE_EVENTS;
        if (!exhaustedBySilence && !exhaustedByNoise) return;
        idleAutoClosed = true;
        stopped = true;
        finishGenerationVisualState();
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      }, 1000);
      await readSseStream(resp.body.getReader(), (evt) => {
        if (
          stopped ||
          userStoppedGenerationRef.current ||
          (linkedSitesLength > 1 && readLinkedGenerationStopRequestFromSession(weekIso))
        ) {
          if (linkedSitesLength > 1 && readLinkedGenerationStopRequestFromSession(weekIso)) {
            userStoppedGenerationRef.current = true;
            if (stopVisibleAlternativeCountRef.current == null) {
              const visibleCountAtStop = Math.max(0, assignmentVariantsRef.current.length);
              stopVisibleAlternativeCountRef.current = visibleCountAtStop;
              writeLinkedGenerationStopVisibleCountToSession(weekIso, visibleCountAtStop);
              pruneLinkedPlansMemoryAfterStop(visibleCountAtStop);
            }
            try {
              controller.abort();
            } catch {
              /* ignore */
            }
          }
          stopped = true;
          finishGenerationVisualState();
          return true;
        }
        const evtGenerationId =
          typeof evt.generation_id === "string" && String(evt.generation_id).trim()
            ? String(evt.generation_id).trim()
            : null;
        if (evtGenerationId) {
          if (!generationIdRef.current) {
            generationIdRef.current = evtGenerationId;
          } else if (generationIdRef.current !== evtGenerationId) {
            return false;
          }
        }
        // Compte tout événement non suivi d’un markAcceptedPlan (rejets, pulls_debug, etc.).
        markStagnantNoise();
        if (evt.type === "base" && !appendMode) {
          if (linked && evt.site_plans && typeof evt.site_plans === "object") {
            const plans = evt.site_plans as Record<string, { assignments?: unknown; pulls?: unknown }>;
            logPlanningV2PullCandidate({
              itemType: "base",
              appendMode,
              linked,
              siteId,
              weekIso,
              eventIndex: evt.index,
              generationId: evt.generation_id,
              requestedCount: requestedPullsCount,
              pullsScope: options?.pullsScope,
              plans,
            });
            if (!linkedPlansMatchRequestedPulls(plans, siteId, requestedPullsCount, options?.pullsScope)) {
              return false;
            }
            const holeScore = linkedPlansHoleScore(plans, siteId, site);
            if (shouldRejectForHoleScore(holeScore, "base", evt.index, evt.generation_id)) {
              return false;
            }
          } else if (!linked && !pullsMatchRequestedCount(evt.pulls, requestedPullsCount)) {
            logPlanningV2PullCandidate({
              itemType: "base",
              appendMode,
              linked,
              siteId,
              weekIso,
              eventIndex: evt.index,
              generationId: evt.generation_id,
              requestedCount: requestedPullsCount,
              pullsScope: options?.pullsScope,
              pulls: evt.pulls,
            });
            return false;
          } else if (!linked) {
            logPlanningV2PullCandidate({
              itemType: "base",
              appendMode,
              linked,
              siteId,
              weekIso,
              eventIndex: evt.index,
              generationId: evt.generation_id,
              requestedCount: requestedPullsCount,
              pullsScope: options?.pullsScope,
              pulls: evt.pulls,
            });
          }
          if (!linked && evt.assignments && typeof evt.assignments === "object") {
            const holeScore = singlePlanHoleScore(
              site,
              evt.assignments as Record<string, Record<string, string[][]>>,
              evt.pulls && typeof evt.pulls === "object" ? (evt.pulls as PlanningV2PullsMap) : {},
            );
            if (shouldRejectForHoleScore(holeScore, "base", evt.index, evt.generation_id)) {
              return false;
            }
          }
          setReplaceGenerationUiClear(false);
          sawGeneratedPlan = true;
          sawPlanToPersist = true;
          markAcceptedPlan();
          if (linked && evt.site_plans && typeof evt.site_plans === "object") {
            const plans = evt.site_plans as Record<string, { assignments?: unknown; pulls?: unknown }>;
            const existing = readLinkedPlansFromMemory(weekStart);
            const merged: Record<string, LinkedSitePlan> = { ...(existing?.plansBySite || {}) };
            for (const [k, p] of Object.entries(plans)) {
              if (!p || typeof p !== "object") continue;
              const prev = (merged[k] || {}) as LinkedSitePlan;
              merged[k] = {
                ...prev,
                assignments:
                  p.assignments && typeof p.assignments === "object"
                    ? (p.assignments as Record<string, Record<string, string[][]>>)
                    : prev.assignments,
                pulls:
                  p.pulls && typeof p.pulls === "object"
                    ? (p.pulls as Record<string, unknown>)
                    : (prev.pulls || {}),
                alternatives: [],
                alternative_pulls: [],
              };
            }
            saveLinkedPlansToMemory(weekStart, merged, 0);
            const cur = merged[String(siteId)] as LinkedSitePlan | undefined;
            if (cur?.assignments && typeof cur.assignments === "object") {
              const nextAsg = cur.assignments as Record<string, Record<string, string[][]>>;
              const nextPulls =
                cur.pulls && typeof cur.pulls === "object" ? (cur.pulls as PlanningV2PullsMap) : {};
              draftAssignmentsRef.current = nextAsg;
              draftPullsRef.current = nextPulls;
              draftAlternativesRef.current = [];
              seenAlternativeSnapshotsRef.current = buildSeenAlternativeSnapshots(nextAsg, nextPulls, []);
              setDraftAssignments(nextAsg);
              setDraftPulls(nextPulls);
              setDraftAlternatives([]);
              setSelectedAlternativeIndex(0);
              setIsManual(false);
              toast.success("תכנון בסיסי מוכן");
            }
          } else if (!linked && evt.assignments && typeof evt.assignments === "object") {
            const nextAsg = evt.assignments as Record<string, Record<string, string[][]>>;
            const nextPulls = evt.pulls && typeof evt.pulls === "object" ? (evt.pulls as PlanningV2PullsMap) : {};
            draftAssignmentsRef.current = nextAsg;
            draftPullsRef.current = nextPulls;
            draftAlternativesRef.current = [];
            seenAlternativeSnapshotsRef.current = buildSeenAlternativeSnapshots(nextAsg, nextPulls, []);
            setDraftAssignments(nextAsg);
            setDraftPulls(nextPulls);
            setDraftAlternatives([]);
            setSelectedAlternativeIndex(0);
            setIsManual(false);
            toast.success("תכנון בסיסי מוכן");
          }
          return false;
        }
        if (evt.type === "base" && appendMode) {
          if (linked && evt.site_plans && typeof evt.site_plans === "object") {
            const plans = evt.site_plans as Record<string, { assignments?: unknown; pulls?: unknown }>;
            logPlanningV2PullCandidate({
              itemType: "base",
              appendMode,
              linked,
              siteId,
              weekIso,
              eventIndex: evt.index,
              generationId: evt.generation_id,
              requestedCount: requestedPullsCount,
              pullsScope: options?.pullsScope,
              plans,
            });
            if (!linkedPlansMatchRequestedPulls(plans, siteId, requestedPullsCount, options?.pullsScope)) {
              return false;
            }
            const holeScore = linkedPlansHoleScore(plans, siteId, site);
            if (shouldRejectForHoleScore(holeScore, "base", evt.index, evt.generation_id)) {
              return false;
            }
          } else if (!linked && !pullsMatchRequestedCount(evt.pulls, requestedPullsCount)) {
            logPlanningV2PullCandidate({
              itemType: "base",
              appendMode,
              linked,
              siteId,
              weekIso,
              eventIndex: evt.index,
              generationId: evt.generation_id,
              requestedCount: requestedPullsCount,
              pullsScope: options?.pullsScope,
              pulls: evt.pulls,
            });
            return false;
          } else if (!linked) {
            logPlanningV2PullCandidate({
              itemType: "base",
              appendMode,
              linked,
              siteId,
              weekIso,
              eventIndex: evt.index,
              generationId: evt.generation_id,
              requestedCount: requestedPullsCount,
              pullsScope: options?.pullsScope,
              pulls: evt.pulls,
            });
          }
          if (!linked && evt.assignments && typeof evt.assignments === "object") {
            const holeScore = singlePlanHoleScore(
              site,
              evt.assignments as Record<string, Record<string, string[][]>>,
              evt.pulls && typeof evt.pulls === "object" ? (evt.pulls as PlanningV2PullsMap) : {},
            );
            if (shouldRejectForHoleScore(holeScore, "base", evt.index, evt.generation_id)) {
              return false;
            }
          }
          sawGeneratedPlan = true;
          sawPlanToPersist = true;
          let altAssignments: Record<string, Record<string, string[][]>> | null = null;
          let altPulls: PlanningV2PullsMap = {};
          if (linked && evt.site_plans && typeof evt.site_plans === "object") {
            const plans = evt.site_plans as Record<string, { assignments?: unknown; pulls?: unknown }>;
            const maxShiftOverages = linkedSitePlansMaxShiftOverages(plans, workersRef.current);
            if (maxShiftOverages.length > 0) {
              const existing = readLinkedPlansFromMemory(weekStart);
              console.warn("[planning-v2][multi-site][append][skip-over-max][base-event]", {
                siteId: String(siteId),
                weekIso,
                eventIndex: evt.index ?? null,
                appendExistingAlternativesCount,
                currentDraftAlternatives: draftAlternativesRef.current.length,
                memoryAltCounts: linkedPlansAltCounts(existing?.plansBySite),
                overages: maxShiftOverages,
              });
              return false;
            }
            const linkedSnap = linkedSitePlansSnapshot(plans);
            if (dedupeAlternatives && linkedSnap && seenLinkedAlternativeSnapshotsRef.current.has(linkedSnap)) {
              console.warn("[planning-v2][multi-site][append][skip-duplicate][base-event]", {
                siteId: String(siteId),
                weekIso,
                eventIndex: evt.index ?? null,
                appendExistingAlternativesCount,
                currentDraftAlternatives: draftAlternativesRef.current.length,
              });
              return false;
            }
            const existing = readLinkedPlansFromMemory(weekStart);
            const merged: Record<string, LinkedSitePlan> = { ...(existing?.plansBySite || {}) };
            let mergedChanged = false;
            for (const [k, p] of Object.entries(plans)) {
              if (!p || typeof p !== "object" || !p.assignments || typeof p.assignments !== "object") continue;
              const prev = (merged[k] || {}) as LinkedSitePlan;
              const prevAlternatives = Array.isArray(prev.alternatives) ? prev.alternatives : [];
              const prevAlternativePulls = Array.isArray(prev.alternative_pulls) ? prev.alternative_pulls : [];
              merged[k] = {
                ...prev,
                alternatives: [...prevAlternatives, p.assignments as Record<string, Record<string, string[][]>>],
                alternative_pulls: [
                  ...prevAlternativePulls,
                  (p.pulls && typeof p.pulls === "object" ? p.pulls : {}) as Record<string, unknown>,
                ],
              };
              mergedChanged = true;
            }
            if (mergedChanged) {
              const pruned = pruneLinkedPlansOverMaxShifts(merged, workersRef.current);
              if (pruned.dropped.length > 0) {
                console.warn("[planning-v2][multi-site][append][prune-memory-over-max][base-event]", {
                  siteId: String(siteId),
                  weekIso,
                  eventIndex: evt.index ?? null,
                  appendExistingAlternativesCount,
                  beforeAltCounts: linkedPlansAltCounts(merged),
                  afterAltCounts: linkedPlansAltCounts(pruned.plansBySite),
                  dropped: pruned.dropped.slice(-10),
                });
              }
              saveLinkedPlansToMemory(weekStart, pruned.plansBySite, Number(existing?.activeAltIndex || 0));
              const prunedCurrentPlan = pruned.plansBySite[String(siteId)];
              if (prunedCurrentPlan) {
                const beforeCurrentAltCount = Array.isArray(existing?.plansBySite?.[String(siteId)]?.alternatives)
                  ? existing?.plansBySite?.[String(siteId)]?.alternatives?.length || 0
                  : 0;
                const afterCurrentAltCount = Array.isArray(prunedCurrentPlan.alternatives)
                  ? prunedCurrentPlan.alternatives.length
                  : 0;
                draftAlternativesRef.current = normalizeDraftAlternatives(
                  (Array.isArray(prunedCurrentPlan.alternatives) ? prunedCurrentPlan.alternatives : []).map((assignments, idx) => ({
                    assignments,
                    pulls:
                      ((Array.isArray(prunedCurrentPlan.alternative_pulls) ? prunedCurrentPlan.alternative_pulls[idx] : {}) ||
                        {}) as PlanningV2PullsMap,
                  })),
                );
                if (afterCurrentAltCount > beforeCurrentAltCount) {
                  appendUniqueCountRef.current += 1;
                  markAcceptedPlan();
                  if (appendMode) {
                    setMoreAlternativesAvailable(true);
                  }
                }
                scheduleAlternativesFlush();
                if (stopWhenBatchTargetReached()) {
                  finishGenerationVisualState();
                  return true;
                }
              }
              if (dedupeAlternatives && linkedSnap) {
                seenLinkedAlternativeSnapshotsRef.current.add(linkedSnap);
              }
            }
            const curEvent = plans[String(siteId)];
            if (curEvent?.assignments && typeof curEvent.assignments === "object") {
              altAssignments = appendMode ? null : curEvent.assignments as Record<string, Record<string, string[][]>>;
              altPulls =
                curEvent.pulls && typeof curEvent.pulls === "object"
                  ? (curEvent.pulls as PlanningV2PullsMap)
                  : {};
            }
          } else if (!linked && evt.assignments && typeof evt.assignments === "object") {
            altAssignments = evt.assignments as Record<string, Record<string, string[][]>>;
            altPulls = evt.pulls && typeof evt.pulls === "object" ? (evt.pulls as PlanningV2PullsMap) : {};
          }
          if (altAssignments) {
            const nextSnapshot = alternativeSnapshot(altAssignments, altPulls);
            if (dedupeAlternatives && nextSnapshot && seenAlternativeSnapshotsRef.current.has(nextSnapshot)) {
              return false;
            }
            if (dedupeAlternatives && nextSnapshot) {
              seenAlternativeSnapshotsRef.current.add(nextSnapshot);
              lastAlternativeSnapshotRef.current = nextSnapshot;
            }
            draftAlternativesRef.current = [
              ...(draftAlternativesRef.current || []),
              { assignments: altAssignments, pulls: altPulls },
            ];
            appendUniqueCountRef.current += 1;
            markAcceptedPlan();
            if (appendMode) {
              setMoreAlternativesAvailable(true);
            }
            scheduleAlternativesFlush();
            if (stopWhenBatchTargetReached()) {
              finishGenerationVisualState();
              return true;
            }
          }
          return false;
        }
        if (evt.type === "alternative") {
          if (linked && evt.site_plans && typeof evt.site_plans === "object") {
            const plans = evt.site_plans as Record<string, { assignments?: unknown; pulls?: unknown }>;
            logPlanningV2PullCandidate({
              itemType: "alternative",
              appendMode,
              linked,
              siteId,
              weekIso,
              eventIndex: evt.index,
              generationId: evt.generation_id,
              requestedCount: requestedPullsCount,
              pullsScope: options?.pullsScope,
              plans,
            });
            if (!linkedPlansMatchRequestedPulls(plans, siteId, requestedPullsCount, options?.pullsScope)) {
              return false;
            }
            const holeScore = linkedPlansHoleScore(plans, siteId, site);
            if (shouldRejectForHoleScore(holeScore, "alternative", evt.index, evt.generation_id)) {
              return false;
            }
          } else if (!linked && !pullsMatchRequestedCount(evt.pulls, requestedPullsCount)) {
            logPlanningV2PullCandidate({
              itemType: "alternative",
              appendMode,
              linked,
              siteId,
              weekIso,
              eventIndex: evt.index,
              generationId: evt.generation_id,
              requestedCount: requestedPullsCount,
              pullsScope: options?.pullsScope,
              pulls: evt.pulls,
            });
            return false;
          } else if (!linked) {
            logPlanningV2PullCandidate({
              itemType: "alternative",
              appendMode,
              linked,
              siteId,
              weekIso,
              eventIndex: evt.index,
              generationId: evt.generation_id,
              requestedCount: requestedPullsCount,
              pullsScope: options?.pullsScope,
              pulls: evt.pulls,
            });
          }
          if (!linked && evt.assignments && typeof evt.assignments === "object") {
            const holeScore = singlePlanHoleScore(
              site,
              evt.assignments as Record<string, Record<string, string[][]>>,
              evt.pulls && typeof evt.pulls === "object" ? (evt.pulls as PlanningV2PullsMap) : {},
            );
            if (shouldRejectForHoleScore(holeScore, "alternative", evt.index, evt.generation_id)) {
              return false;
            }
          }
          sawGeneratedPlan = true;
          sawPlanToPersist = true;
          const altSlot = Math.max(0, Math.trunc(Number(evt.index || 0)) - 1);
          let altAssignments: Record<string, Record<string, string[][]>> | null = null;
          let altPulls: PlanningV2PullsMap = {};
          if (linked && evt.site_plans && typeof evt.site_plans === "object") {
            const plans = evt.site_plans as Record<string, { assignments?: unknown; pulls?: unknown }>;
            const maxShiftOverages = appendMode ? linkedSitePlansMaxShiftOverages(plans, workersRef.current) : [];
            if (maxShiftOverages.length > 0) {
              const existing = readLinkedPlansFromMemory(weekStart);
              console.warn("[planning-v2][multi-site][append][skip-over-max][alternative-event]", {
                siteId: String(siteId),
                weekIso,
                eventIndex: evt.index ?? null,
                altSlot,
                appendExistingAlternativesCount,
                currentDraftAlternatives: draftAlternativesRef.current.length,
                memoryAltCounts: linkedPlansAltCounts(existing?.plansBySite),
                overages: maxShiftOverages,
              });
              return false;
            }
            const linkedSnap = linkedSitePlansSnapshot(plans);
            if (dedupeAlternatives && linkedSnap && seenLinkedAlternativeSnapshotsRef.current.has(linkedSnap)) {
              console.warn("[planning-v2][multi-site][append][skip-duplicate][alternative-event]", {
                siteId: String(siteId),
                weekIso,
                eventIndex: evt.index ?? null,
                altSlot,
                appendExistingAlternativesCount,
                currentDraftAlternatives: draftAlternativesRef.current.length,
              });
              return false;
            }
            const existing = readLinkedPlansFromMemory(weekStart);
            const merged: Record<string, LinkedSitePlan> = { ...(existing?.plansBySite || {}) };
            let mergedChanged = false;
            for (const [k, p] of Object.entries(plans)) {
              if (!p || typeof p !== "object") continue;
              const prev = (merged[k] || {}) as LinkedSitePlan;
              const nextAssignments =
                p.assignments && typeof p.assignments === "object"
                  ? (p.assignments as Record<string, Record<string, string[][]>>)
                  : null;
              const nextPulls =
                p.pulls && typeof p.pulls === "object"
                  ? (p.pulls as Record<string, unknown>)
                  : {};
              if (!prev.assignments && nextAssignments) {
                merged[k] = {
                  ...prev,
                  assignments: nextAssignments,
                  pulls: nextPulls,
                  alternatives: [],
                  alternative_pulls: [],
                };
                mergedChanged = true;
              } else if (nextAssignments) {
                const prevAlternatives = Array.isArray(prev.alternatives) ? prev.alternatives : [];
                const prevAlternativePulls = Array.isArray(prev.alternative_pulls) ? prev.alternative_pulls : [];
                const nextAlternatives = [...prevAlternatives];
                const nextAlternativePulls = [...prevAlternativePulls];
                const targetAltSlot = appendMode ? nextAlternatives.length : altSlot;
                nextAlternatives[targetAltSlot] = nextAssignments;
                nextAlternativePulls[targetAltSlot] = nextPulls;
                merged[k] = {
                  ...prev,
                  alternatives: nextAlternatives,
                  alternative_pulls: nextAlternativePulls,
                };
                mergedChanged = true;
              }
            }
            if (mergedChanged) {
              const pruned = pruneLinkedPlansOverMaxShifts(merged, workersRef.current);
              if (pruned.dropped.length > 0) {
                console.warn("[planning-v2][multi-site][append][prune-memory-over-max][alternative-event]", {
                  siteId: String(siteId),
                  weekIso,
                  eventIndex: evt.index ?? null,
                  altSlot,
                  appendExistingAlternativesCount,
                  beforeAltCounts: linkedPlansAltCounts(merged),
                  afterAltCounts: linkedPlansAltCounts(pruned.plansBySite),
                  dropped: pruned.dropped.slice(-10),
                });
              }
              saveLinkedPlansToMemory(weekStart, pruned.plansBySite, Number(existing?.activeAltIndex || 0));
              const prunedCurrentPlan = pruned.plansBySite[String(siteId)];
              if (prunedCurrentPlan) {
                const beforeCurrentAltCount = Array.isArray(existing?.plansBySite?.[String(siteId)]?.alternatives)
                  ? existing?.plansBySite?.[String(siteId)]?.alternatives?.length || 0
                  : 0;
                const afterCurrentAltCount = Array.isArray(prunedCurrentPlan.alternatives)
                  ? prunedCurrentPlan.alternatives.length
                  : 0;
                draftAlternativesRef.current = normalizeDraftAlternatives(
                  (Array.isArray(prunedCurrentPlan.alternatives) ? prunedCurrentPlan.alternatives : []).map((assignments, idx) => ({
                    assignments,
                    pulls:
                      ((Array.isArray(prunedCurrentPlan.alternative_pulls) ? prunedCurrentPlan.alternative_pulls[idx] : {}) ||
                        {}) as PlanningV2PullsMap,
                  })),
                );
                if (afterCurrentAltCount > beforeCurrentAltCount) {
                  appendUniqueCountRef.current += 1;
                  markAcceptedPlan();
                  if (appendMode) {
                    setMoreAlternativesAvailable(true);
                  }
                }
                scheduleAlternativesFlush();
                if (stopWhenBatchTargetReached()) return true;
              }
              if (dedupeAlternatives && linkedSnap) {
                seenLinkedAlternativeSnapshotsRef.current.add(linkedSnap);
              }
            }
            const curEvent = plans[String(siteId)];
            if (curEvent?.assignments && typeof curEvent.assignments === "object") {
              altAssignments = appendMode ? null : curEvent.assignments as Record<string, Record<string, string[][]>>;
              altPulls =
                curEvent.pulls && typeof curEvent.pulls === "object"
                  ? (curEvent.pulls as PlanningV2PullsMap)
                  : {};
            }
          } else if (!linked && evt.assignments && typeof evt.assignments === "object") {
            altAssignments = evt.assignments as Record<string, Record<string, string[][]>>;
            altPulls = evt.pulls && typeof evt.pulls === "object" ? (evt.pulls as PlanningV2PullsMap) : {};
          }
          if (altAssignments) {
            const nextSnapshot = alternativeSnapshot(altAssignments, altPulls);
            if (dedupeAlternatives && nextSnapshot && seenAlternativeSnapshotsRef.current.has(nextSnapshot)) {
              return false;
            }
            if (dedupeAlternatives && nextSnapshot) {
              seenAlternativeSnapshotsRef.current.add(nextSnapshot);
              lastAlternativeSnapshotRef.current = nextSnapshot;
            }
            const nextDraftAlternatives = [...(draftAlternativesRef.current || [])];
            const targetAltSlot = appendMode ? nextDraftAlternatives.length : altSlot;
            nextDraftAlternatives[targetAltSlot] = {
              assignments: altAssignments as Record<string, Record<string, string[][]>>,
              pulls: altPulls,
            };
            draftAlternativesRef.current = nextDraftAlternatives;
            appendUniqueCountRef.current += 1;
            markAcceptedPlan();
            if (appendMode) {
              setMoreAlternativesAvailable(true);
            }
            scheduleAlternativesFlush();
            if (stopWhenBatchTargetReached()) return true;
          }
          return false;
        }
        if (evt.type === "status" && evt.status === "ERROR") {
          finishGenerationVisualState();
          toast.error("יצירת תכנון נכשלה", { description: String(evt.detail || "") });
          stopped = true;
          return true;
        }
        if (evt.type === "pulls_debug") {
          const linkedDebug = evt.linked === true;
          const pullsSummary = evt.pulls_summary && typeof evt.pulls_summary === "object"
            ? (evt.pulls_summary as Record<string, { pulls?: unknown; matches?: unknown }>)
            : {};
          const pullsBySite = Object.fromEntries(
            Object.entries(pullsSummary).map(([sid, summary]) => [sid, Number(summary?.pulls || 0)]),
          );
          const totalPulls = linkedDebug
            ? Object.values(pullsBySite).reduce((sum, count) => sum + Number(count || 0), 0)
            : Number(evt.received_pulls || 0);
          console.warn(
            totalPulls > 0
              ? "[planning-v2][משיכות][server-rejected-with-pulls]"
              : "[planning-v2][משיכות][server-rejected-without-pulls]",
            {
              itemType: evt.item_type || null,
              eventIndex: evt.item_index ?? null,
              generationId: evt.generation_id ?? null,
              reason: evt.reason || null,
              linked: linkedDebug,
              siteId: String(siteId),
              weekIso,
              requestedPulls: evt.requested_pulls ?? null,
              receivedPulls: linkedDebug ? undefined : Number(evt.received_pulls || 0),
              totalPulls,
              pullsBySite: linkedDebug ? pullsBySite : undefined,
              pullsSummary: linkedDebug ? pullsSummary : undefined,
              accepted: evt.accepted === true,
            },
          );
          return false;
        }
        if (evt.type === "done") {
          serverExhaustedAlternatives = currentBatchVisibleCount() < VISIBLE_ALTERNATIVES_BATCH_SIZE;
          finishGenerationVisualState();
          if (serverExhaustedAlternatives && sawGeneratedPlan) {
            setMoreAlternativesAvailable(false);
            toast.message("אין חלופות חדשות נוספות");
          } else {
            toast.success("התכנון הושלם");
          }
          stopped = true;
          return true;
        }
        return false;
      });
    } catch (e: unknown) {
      if ((e as Error)?.name === "AbortError") {
        if (batchTargetReached) {
          finishGenerationVisualState();
          toast.success("נמצאו 500 חלופות חדשות");
        } else if (idleAutoClosed) {
          finishGenerationVisualState();
          if (sawGeneratedPlan) {
            setMoreAlternativesAvailable(false);
            toast.message("אין חלופות חדשות נוספות");
          } else {
            toast.success("התכנון הושלם");
          }
        } else if (noResultAutoClosed) {
          finishGenerationVisualState();
          toast.error("יצירת תכנון נכשלה", { description: "לא התקבלו תוצאות מהשרת." });
        } else {
          // Arrêt manuel : masquer immédiatement יוצר... / stop rouge (persist peut encore tourner).
          finishGenerationVisualState();
          toast.message("יצירת התכנון הופסקה");
        }
      } else {
        finishGenerationVisualState();
        toast.error("יצירת תכנון נכשלה", { description: String((e as Error)?.message || "") });
      }
    } finally {
      // Couper l'UI génération tout de suite (avant persist/reload, qui peuvent prendre du temps).
      finishGenerationVisualState();
      if (idleWatch) {
        window.clearInterval(idleWatch);
      }
      if (noResultWatch) {
        window.clearTimeout(noResultWatch);
      }
      if (stopRequestWatch) {
        window.clearInterval(stopRequestWatch);
      }
      if (alternativesFlushRafRef.current != null) {
        try {
          window.cancelAnimationFrame(alternativesFlushRafRef.current);
        } catch {
          /* ignore */
        }
        alternativesFlushRafRef.current = null;
        // Après annulation du RAF, synchroniser pour que React reflète toutes les alternatives reçues.
        const normalizedAlternatives = draftAlternativesForMode(draftAlternativesRef.current || [], dedupeAlternatives);
        const stopLimit = stopVisibleAlternativeCountRef.current;
        const maxDraftAlternatives =
          stopLimit == null
            ? normalizedAlternatives.length
            : draftAssignmentsRef.current
              ? Math.max(0, stopLimit - 1)
              : stopLimit;
        const nextAlternatives = normalizedAlternatives.slice(0, maxDraftAlternatives);
        if (stopLimit != null) {
          draftAlternativesRef.current = nextAlternatives;
        }
        setDraftAlternatives([...nextAlternatives]);
      }
      if (
        sawGeneratedPlan &&
        !batchTargetReached &&
        currentBatchVisibleCount() < VISIBLE_ALTERNATIVES_BATCH_SIZE &&
        (serverExhaustedAlternatives || idleAutoClosed || !controller.signal.aborted)
      ) {
        setMoreAlternativesAvailable(false);
      }
      const stoppedByUser = userStoppedGenerationRef.current && controller.signal.aborted;
      if (sawPlanToPersist && !stoppedByUser) {
        writeAlternativesUnlockedToSession(weekIso, siteId);
        setAlternativesUnlockNonce((n) => n + 1);
        try {
          await persistGeneratedAutoDraftToServer();
          if (!(editingSaved && hasOfficialSavedWeekPlan)) {
            await reloadWeekPlan({ silent: true, preferredScope: "auto" });
            // Après persistance/reload, ne pas garder un brouillon local potentiellement divergent
            // du plan auto réellement stocké (source de désynchronisation multi-site / סה"כ).
            draftAssignmentsRef.current = null;
            draftPullsRef.current = {};
            draftAlternativesRef.current = [];
            setDraftAssignments(null);
            setDraftPulls(null);
            setDraftAlternatives([]);
          }
        } catch (err) {
          console.warn("[planning-v2] persist auto draft after generation:", err);
        }
      }
      setGenerationRunning(false);
      setSharedLinkedGenerationRunning(false);
      setReplaceGenerationUiClear(false);
      if (linkedSitesLength > 1) {
        writeLinkedGenerationRunningToSession(weekIso, false);
        writeLinkedGenerationStopRequestToSession(weekIso, false);
      }
      genBusyRef.current = false;
      abortRef.current = null;
      generationIdRef.current = null;
      if (stoppedByUser) {
        userStoppedGenerationRef.current = false;
      }
    }
  }, [
    dedupeAlternatives,
    assignmentVariantsRef,
    pullVariantsRef,
    siteId,
    weekIso,
    weekStart,
    workerRowsForTable,
    autoPullsEnabled,
    autoPullsLimit,
    linkedSitesLength,
    reloadWeekPlan,
    editingSaved,
    hasOfficialSavedWeekPlan,
    site,
    weekPurgeSiteIds,
    pruneLinkedPlansMemoryAfterStop,
    alternativesFlushRafRef,
    getVisibleAlternativeCount,
  ]);

  const startGeneration = useCallback(
    async (options?: GenerateOptions) => {
      await runGeneration(options, "replace");
    },
    [runGeneration],
  );

  const startMoreAlternatives = useCallback(async () => {
    await runGeneration(undefined, "append");
  }, [runGeneration]);

  return {
    generationRunning,
    generationStoppable,
    replaceGenerationUiClear,
    startGeneration,
    startMoreAlternatives,
    stopGeneration,
    abortRef,
    genBusyRef,
    generationIdRef,
    userStoppedGenerationRef,
    stopVisibleAlternativeCountRef,
    alternativesFlushRafRef,
    generationRunningRef,
    resetGenerationForScopeChange,
    cancelGenerationForSavedEditing,
  };
}

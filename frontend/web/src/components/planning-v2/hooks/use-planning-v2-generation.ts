"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import type { PlanningV2PullsMap, PlanningWorker, SiteSummary, WorkerAvailability } from "../types";
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
import { getApiBaseUrl } from "@/lib/api";
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
  EMPTY_PULLS_SHIFT_PREFS,
  pullsLimitPayload,
  pullsPreferPayload,
  type PullsShiftPrefs,
} from "../lib/planning-v2-pulls-match";
import {
  type DraftAlternative,
  buildSeenAlternativeSnapshots,
  buildSeenLinkedAlternativeSnapshots,
  draftAlternativesForMode,
  normalizeDraftAlternatives,
} from "../lib/planning-v2-draft-alternatives";
import { type HoleScore, singlePlanHoleScore } from "../lib/planning-v2-hole-scores";
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
import { persistGeneratedAutoDraftToServer } from "../lib/planning-v2-generation-persist";
import { pruneLinkedPlansMemoryAfterStop } from "../lib/planning-v2-generation-stop-prune";
import {
  createGenerationSseHelpers,
  createPlanningV2GenerationSseHandler,
  type PlanningV2GenerationSseRuntimeState,
} from "../lib/planning-v2-generation-sse-handler";

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
  autoPullsPrefer?: PullsShiftPrefs;
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
  userPickedAltIndexRef: MutableRefObject<number | null>;
  selectedAlternativeIndexRef: MutableRefObject<number>;
  viewedAlternativeIndicesRef: MutableRefObject<Set<number>>;
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
  autoPullsPrefer = EMPTY_PULLS_SHIFT_PREFS,
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
    pruneLinkedPlansMemoryAfterStop(weekStart, linkedSitesLength, visibleCountAtStop);
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
  }, [assignmentVariantsRef, dedupeAlternatives, linkedSitesLength, weekIso, weekStart]);

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
      userPickedAltIndexRef.current = null;
      selectedAlternativeIndexRef.current = 0;
      viewedAlternativeIndicesRef.current = new Set();
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
        pruneLinkedPlansMemoryAfterStop(weekStart, linkedSitesLength, resumeFromStoppedVisibleCount);
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
        ? singlePlanHoleScore(site, baseAssignments, basePulls, pullsPreferPayload(autoPullsPrefer))
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
    const pulls_prefer = autoPullsEnabled ? pullsPreferPayload(autoPullsPrefer) : undefined;
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
          pulls_prefer,
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
          pulls_prefer,
          fixed_assignments: fixedAssignments,
          exclude_days: excludeDays && excludeDays.length ? excludeDays : undefined,
          weekly_availability,
        };

    let idleWatch: number | null = null;
    let noResultWatch: number | null = null;
    let stopRequestWatch: number | null = null;
    let idleAutoClosed = false;
    let noResultAutoClosed = false;
    const runtime: PlanningV2GenerationSseRuntimeState = {
      stopped: false,
      sawGeneratedPlan: false,
      sawPlanToPersist: false,
      batchTargetReached: false,
      serverExhaustedAlternatives: false,
      lastAcceptedPlanAt: Date.now(),
      stagnantNoiseEvents: 0,
      generationVisualFinished: false,
    };
    const visibleAlternativeCountAtStart = Math.max(0, Number(getVisibleAlternativeCount?.() || 0));
    const sseArgs = {
      appendMode,
      linked,
      linkedSitesLength,
      siteId,
      weekIso,
      weekStart,
      site,
      pullsScope: options?.pullsScope,
      requestedPullsCount,
      pullsPreferKinds: pulls_prefer ?? null,
      appendExistingAlternativesCount,
      visibleAlternativeCountAtStart,
      autoPullsEnabled,
      dedupeAlternatives,
      controller,
      getVisibleAlternativeCount,
      abortRef,
      generationIdRef,
      genBusyRef,
      userStoppedGenerationRef,
      stopVisibleAlternativeCountRef,
      alternativesFlushRafRef,
      generationRunningRef,
      workersRef,
      assignmentVariantsRef,
      draftAssignmentsRef,
      draftPullsRef,
      draftAlternativesRef,
      lastAlternativeSnapshotRef,
      seenAlternativeSnapshotsRef,
      seenLinkedAlternativeSnapshotsRef,
      bestGeneratedHoleScoreRef,
      appendUniqueCountRef,
      setGenerationRunning,
      setReplaceGenerationUiClear,
      setSharedLinkedGenerationRunning,
      setDraftAssignments,
      setDraftPulls,
      setDraftAlternatives,
      setSelectedAlternativeIndex,
      setIsManual,
      setMoreAlternativesAvailable,
      userPickedAltIndexRef,
      selectedAlternativeIndexRef,
      viewedAlternativeIndicesRef,
      runtime,
    };
    const generationSseHelpers = createGenerationSseHelpers(sseArgs);
    const { finishGenerationVisualState, currentBatchVisibleCount } = generationSseHelpers;

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
          if (runtime.stopped) return;
          if (!readLinkedGenerationStopRequestFromSession(weekIso)) return;
          userStoppedGenerationRef.current = true;
          const visibleCountAtStop = Math.max(0, assignmentVariantsRef.current.length);
          stopVisibleAlternativeCountRef.current = visibleCountAtStop;
          writeLinkedGenerationStopVisibleCountToSession(weekIso, visibleCountAtStop);
          pruneLinkedPlansMemoryAfterStop(weekStart, linkedSitesLength, visibleCountAtStop);
          runtime.stopped = true;
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
        }, 300);
      }
      // Filet de sécurité: si aucune proposition n'arrive, ne pas laisser יוצר tourner indéfiniment.
      noResultWatch = window.setTimeout(() => {
        if (runtime.stopped || runtime.sawGeneratedPlan) return;
        noResultAutoClosed = true;
        runtime.stopped = true;
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      }, 130000);
      // Sans nouveau plan accepté : couper יוצר/stop (le SSE peut encore spammer pulls_debug).
      idleWatch = window.setInterval(() => {
        if (runtime.stopped) return;
        if (!runtime.sawGeneratedPlan) return;
        const idleMs = Date.now() - runtime.lastAcceptedPlanAt;
        const hadAlternatives =
          appendUniqueCountRef.current > 0 || (draftAlternativesRef.current?.length || 0) > 0;
        const silenceLimit = hadAlternatives ? GENERATION_PLATEAU_IDLE_CLOSE_MS : GENERATION_ACCEPTED_IDLE_CLOSE_MS;
        const exhaustedBySilence = idleMs >= silenceLimit;
        // Beaucoup de rejets SSE sans nouvelle חלופה visible → fin perçue plus tôt.
        const exhaustedByNoise =
          idleMs >= GENERATION_STAGNANT_NOISE_IDLE_MS &&
          runtime.stagnantNoiseEvents >= GENERATION_STAGNANT_NOISE_EVENTS;
        if (!exhaustedBySilence && !exhaustedByNoise) return;
        idleAutoClosed = true;
        runtime.stopped = true;
        finishGenerationVisualState();
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      }, 1000);
      await readSseStream(
        resp.body.getReader(),
        createPlanningV2GenerationSseHandler({ ...sseArgs, helpers: generationSseHelpers }),
      );
    } catch (e: unknown) {
      if ((e as Error)?.name === "AbortError") {
        if (runtime.batchTargetReached) {
          finishGenerationVisualState();
          toast.success("נמצאו 500 חלופות חדשות");
        } else if (idleAutoClosed) {
          finishGenerationVisualState();
          if (runtime.sawGeneratedPlan) {
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
        runtime.sawGeneratedPlan &&
        !runtime.batchTargetReached &&
        currentBatchVisibleCount() < VISIBLE_ALTERNATIVES_BATCH_SIZE &&
        (runtime.serverExhaustedAlternatives || idleAutoClosed || !controller.signal.aborted)
      ) {
        setMoreAlternativesAvailable(false);
      }
      const stoppedByUser = userStoppedGenerationRef.current && controller.signal.aborted;
      if (runtime.sawPlanToPersist && !stoppedByUser) {
        writeAlternativesUnlockedToSession(weekIso, siteId);
        setAlternativesUnlockNonce((n) => n + 1);
        try {
          await persistGeneratedAutoDraftToServer({
            linkedSitesLength,
            weekStart,
            weekIso,
            siteId,
            assignmentVariants,
            draftAssignmentsRef,
            draftPullsRef,
            draftAlternativesRef,
            weekPlanAssignmentsRef,
            workersRef,
            seenLinkedAlternativeSnapshotsRef,
          });
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
    autoPullsPrefer,
    linkedSitesLength,
    reloadWeekPlan,
    editingSaved,
    hasOfficialSavedWeekPlan,
    site,
    weekPurgeSiteIds,
    alternativesFlushRafRef,
    getVisibleAlternativeCount,
    userPickedAltIndexRef,
    selectedAlternativeIndexRef,
    viewedAlternativeIndicesRef,
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

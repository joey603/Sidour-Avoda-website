import { startTransition, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import type { PlanningV2PullsMap, PlanningWorker, SiteSummary } from "../types";
import {
  buildSeenAlternativeSnapshots,
  draftAlternativesForMode,
  linkedSitePlansSnapshot,
  normalizeDraftAlternatives,
  alternativeSnapshot,
  type DraftAlternative,
} from "./planning-v2-draft-alternatives";
import {
  compareHoleScores,
  type HoleScore,
  linkedPlansHoleScore,
  shouldHoldPlanUntilPullTarget,
  singlePlanHoleScore,
} from "./planning-v2-hole-scores";
import {
  linkedPlansAltCounts,
  linkedSitePlansMaxShiftOverages,
  pruneLinkedPlansOverMaxShifts,
} from "./planning-v2-max-shifts-prune";
import {
  linkedPlansMatchRequestedPulls,
  logPlanningV2PullCandidate,
  pullsMatchRequestedCount,
  type PullsShiftKind,
} from "./planning-v2-pulls-match";
import {
  readLinkedGenerationStopRequestFromSession,
  writeLinkedGenerationRunningToSession,
  writeLinkedGenerationStopRequestToSession,
  writeLinkedGenerationStopVisibleCountToSession,
} from "./planning-v2-generation-session";
import { pruneLinkedPlansMemoryAfterStop } from "./planning-v2-generation-stop-prune";
import {
  readLinkedPlansFromMemory,
  saveLinkedPlansToMemory,
  type LinkedSitePlan,
} from "./multi-site-linked-memory";
import { VISIBLE_ALTERNATIVES_BATCH_SIZE } from "./planning-v2-generation-budget";

type AssignmentGrid = Record<string, Record<string, string[][]>>;

export type SseEvent = Record<string, unknown>;

export type PlanningV2GenerationSseRuntimeState = {
  stopped: boolean;
  sawGeneratedPlan: boolean;
  sawPlanToPersist: boolean;
  batchTargetReached: boolean;
  serverExhaustedAlternatives: boolean;
  lastAcceptedPlanAt: number;
  stagnantNoiseEvents: number;
  generationVisualFinished: boolean;
};

export type PlanningV2GenerationSseHelpers = {
  finishGenerationVisualState: () => void;
  markAcceptedPlan: () => void;
  markStagnantNoise: () => void;
  scheduleAlternativesFlush: () => void;
  stopWhenBatchTargetReached: () => boolean;
  currentBatchVisibleCount: () => number;
  shouldRejectForHoleScore: (
    score: HoleScore,
    itemType: "base" | "alternative",
    eventIndex: unknown,
    generationId: unknown,
  ) => boolean;
  promoteBetterPlanToBase: (
    assignments: AssignmentGrid,
    pulls: PlanningV2PullsMap,
    score: HoleScore,
  ) => boolean;
  maybePaintOrHoldFirstPlan: (
    assignments: AssignmentGrid,
    pulls: PlanningV2PullsMap,
    score: HoleScore,
  ) => "painted" | "held" | "skipped";
  flushPendingHeldBase: () => void;
};

export type PlanningV2GenerationSseArgs = {
  appendMode: boolean;
  linked: boolean;
  linkedSitesLength: number;
  siteId: string;
  weekIso: string;
  weekStart: Date;
  site: SiteSummary | null;
  pullsScope?: "current_only" | "all_sites";
  requestedPullsCount: number | null;
  pullsPreferKinds?: PullsShiftKind[] | null;
  appendExistingAlternativesCount: number;
  visibleAlternativeCountAtStart: number;
  autoPullsEnabled: boolean;
  dedupeAlternatives: boolean;
  controller: AbortController;
  getVisibleAlternativeCount?: () => number;
  abortRef: MutableRefObject<AbortController | null>;
  generationIdRef: MutableRefObject<string | null>;
  genBusyRef: MutableRefObject<boolean>;
  userStoppedGenerationRef: MutableRefObject<boolean>;
  stopVisibleAlternativeCountRef: MutableRefObject<number | null>;
  alternativesFlushRafRef: MutableRefObject<number | null>;
  generationRunningRef: MutableRefObject<boolean>;
  workersRef: MutableRefObject<PlanningWorker[]>;
  assignmentVariantsRef: MutableRefObject<AssignmentGrid[]>;
  draftAssignmentsRef: MutableRefObject<AssignmentGrid | null>;
  draftPullsRef: MutableRefObject<PlanningV2PullsMap>;
  draftAlternativesRef: MutableRefObject<DraftAlternative[]>;
  lastAlternativeSnapshotRef: MutableRefObject<string>;
  seenAlternativeSnapshotsRef: MutableRefObject<Set<string>>;
  seenLinkedAlternativeSnapshotsRef: MutableRefObject<Set<string>>;
  bestGeneratedHoleScoreRef: MutableRefObject<HoleScore | null>;
  appendUniqueCountRef: MutableRefObject<number>;
  setGenerationRunning: Dispatch<SetStateAction<boolean>>;
  setReplaceGenerationUiClear: Dispatch<SetStateAction<boolean>>;
  setSharedLinkedGenerationRunning: Dispatch<SetStateAction<boolean>>;
  setDraftAssignments: Dispatch<SetStateAction<AssignmentGrid | null>>;
  setDraftPulls: Dispatch<SetStateAction<PlanningV2PullsMap | null>>;
  setDraftAlternatives: Dispatch<SetStateAction<DraftAlternative[]>>;
  setSelectedAlternativeIndex: Dispatch<SetStateAction<number>>;
  setIsManual: Dispatch<SetStateAction<boolean>>;
  setMoreAlternativesAvailable: Dispatch<SetStateAction<boolean>>;
  userPickedAltIndexRef?: MutableRefObject<number | null>;
  selectedAlternativeIndexRef?: MutableRefObject<number>;
  runtime: PlanningV2GenerationSseRuntimeState;
};

export function createGenerationSseHelpers(args: PlanningV2GenerationSseArgs): PlanningV2GenerationSseHelpers {
  const {
    appendMode,
    linkedSitesLength,
    site,
    weekIso,
    requestedPullsCount,
    pullsPreferKinds = null,
    visibleAlternativeCountAtStart,
    autoPullsEnabled,
    dedupeAlternatives,
    controller,
    getVisibleAlternativeCount,
    abortRef,
    genBusyRef,
    stopVisibleAlternativeCountRef,
    alternativesFlushRafRef,
    generationRunningRef,
    draftAssignmentsRef,
    draftPullsRef,
    draftAlternativesRef,
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
    userPickedAltIndexRef,
    selectedAlternativeIndexRef,
    runtime,
  } = args;

  const planScore = (
    asg: AssignmentGrid | null | undefined,
    pulls: PlanningV2PullsMap | null | undefined,
  ) => singlePlanHoleScore(site, asg, pulls, pullsPreferKinds);

  const pendingFlushRef = { current: () => {} };

  const finishGenerationVisualState = () => {
    pendingFlushRef.current();
    if (runtime.generationVisualFinished) return;
    runtime.generationVisualFinished = true;
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
    runtime.lastAcceptedPlanAt = Date.now();
    runtime.stagnantNoiseEvents = 0;
  };
  const markStagnantNoise = () => {
    runtime.stagnantNoiseEvents += 1;
  };
  const scheduleAlternativesFlush = () => {
    if (alternativesFlushRafRef.current != null) return;
    alternativesFlushRafRef.current = window.requestAnimationFrame(() => {
      alternativesFlushRafRef.current = null;
      const apply = () => {
        const normalized = draftAlternativesForMode(draftAlternativesRef.current || [], dedupeAlternatives);
        const stopLimit = stopVisibleAlternativeCountRef.current;
        const preferActive = !!(pullsPreferKinds && pullsPreferKinds.length > 0);
        const canResplitBase =
          preferActive &&
          !appendMode &&
          linkedSitesLength <= 1 &&
          !!draftAssignmentsRef.current;

        if (canResplitBase) {
          const all: DraftAlternative[] = [
            { assignments: draftAssignmentsRef.current as AssignmentGrid, pulls: draftPullsRef.current },
            ...normalized,
          ];
          const ranked = [...all].sort((a, b) =>
            compareHoleScores(
              planScore(a.assignments, a.pulls),
              planScore(b.assignments, b.pulls),
              requestedPullsCount,
            ),
          );
          const maxTotal = stopLimit == null ? ranked.length : Math.max(1, stopLimit);
          const sliced = ranked.slice(0, maxTotal);
          const nextBase = sliced[0];
          const nextAlts = sliced.slice(1);
          const pin = userPickedAltIndexRef?.current != null;
          const viewedIdx = Math.max(0, selectedAlternativeIndexRef?.current ?? 0);
          const viewed = pin && viewedIdx < all.length ? all[viewedIdx] : null;
          const viewedSnap = viewed ? alternativeSnapshot(viewed.assignments, viewed.pulls) : "";

          draftAssignmentsRef.current = nextBase.assignments;
          draftPullsRef.current = nextBase.pulls;
          draftAlternativesRef.current = nextAlts;
          setDraftAssignments(nextBase.assignments);
          setDraftPulls(nextBase.pulls);
          setDraftAlternatives([...nextAlts]);

          if (viewedSnap) {
            const newIdx = [nextBase, ...nextAlts].findIndex(
              (p) => alternativeSnapshot(p.assignments, p.pulls) === viewedSnap,
            );
            if (newIdx >= 0) {
              if (selectedAlternativeIndexRef) selectedAlternativeIndexRef.current = newIdx;
              if (userPickedAltIndexRef) userPickedAltIndexRef.current = newIdx;
              setSelectedAlternativeIndex(newIdx);
            }
          }
          return;
        }

        setDraftAlternatives((prev) => {
          const ordered = preferActive
            ? [...normalized].sort((a, b) =>
                compareHoleScores(
                  planScore(a.assignments, a.pulls),
                  planScore(b.assignments, b.pulls),
                  requestedPullsCount,
                ),
              )
            : normalized;
          const maxDraftAlternatives =
            stopLimit == null
              ? ordered.length
              : draftAssignmentsRef.current
                ? Math.max(0, stopLimit - 1)
                : stopLimit;
          const next = ordered.slice(0, maxDraftAlternatives);
          if (stopLimit != null && next.length !== draftAlternativesRef.current.length) {
            draftAlternativesRef.current = next;
          }
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
    runtime.batchTargetReached = true;
    runtime.stopped = true;
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
    if (!best) {
      bestGeneratedHoleScoreRef.current = score;
      return false;
    }
    // Ne jeter que les nouveaux plans avec plus de trous. Un meilleur score משיכות
    // ne doit pas vider les חלופות déjà affichées (sinon le compteur retombe à 1).
    if (score.holes > best.holes) return true;
    if (compareHoleScores(score, best, requestedPullsCount) < 0) {
      bestGeneratedHoleScoreRef.current = score;
    }
    return false;
  };

  type HeldFirstPlan = { assignments: AssignmentGrid; pulls: PlanningV2PullsMap; score: HoleScore };
  let pendingHeldBase: HeldFirstPlan | null = null;

  const paintFirstPlan = (assignments: AssignmentGrid, pulls: PlanningV2PullsMap, score: HoleScore) => {
    const demote =
      pendingHeldBase && pendingHeldBase.assignments !== assignments
        ? pendingHeldBase
        : null;
    pendingHeldBase = null;
    draftAssignmentsRef.current = assignments;
    draftPullsRef.current = pulls;
    setDraftAssignments(assignments);
    setDraftPulls(pulls);
    setReplaceGenerationUiClear(false);
    setSelectedAlternativeIndex(0);
    if (selectedAlternativeIndexRef) selectedAlternativeIndexRef.current = 0;
    setIsManual(false);
    if (demote) {
      draftAlternativesRef.current = normalizeDraftAlternatives([
        { assignments: demote.assignments, pulls: demote.pulls },
        ...(draftAlternativesRef.current || []),
      ]);
      scheduleAlternativesFlush();
    }
    bestGeneratedHoleScoreRef.current = score;
    toast.success("תכנון בסיסי מוכן");
  };

  const maybePaintOrHoldFirstPlan = (
    assignments: AssignmentGrid,
    pulls: PlanningV2PullsMap,
    score: HoleScore,
  ): "painted" | "held" | "skipped" => {
    if (appendMode || linkedSitesLength > 1) return "skipped";
    if (draftAssignmentsRef.current) return "skipped";
    if (autoPullsEnabled && shouldHoldPlanUntilPullTarget(score, requestedPullsCount, pullsPreferKinds)) {
      if (
        !pendingHeldBase ||
        compareHoleScores(score, pendingHeldBase.score, requestedPullsCount) < 0
      ) {
        pendingHeldBase = { assignments, pulls, score };
      }
      return "held";
    }
    paintFirstPlan(assignments, pulls, score);
    return "painted";
  };

  const flushPendingHeldBase = () => {
    if (!pendingHeldBase || draftAssignmentsRef.current) return;
    paintFirstPlan(pendingHeldBase.assignments, pendingHeldBase.pulls, pendingHeldBase.score);
  };
  pendingFlushRef.current = flushPendingHeldBase;

  /** Ne jamais remplacer une חלופה déjà à l’écran : les meilleurs plans s’ajoutent à la fin. */
  const promoteBetterPlanToBase = (
    _assignments: AssignmentGrid,
    _pulls: PlanningV2PullsMap,
    _score: HoleScore,
  ): boolean => false;

  return {
    finishGenerationVisualState,
    markAcceptedPlan,
    markStagnantNoise,
    scheduleAlternativesFlush,
    stopWhenBatchTargetReached,
    currentBatchVisibleCount,
    shouldRejectForHoleScore,
    promoteBetterPlanToBase,
    maybePaintOrHoldFirstPlan,
    flushPendingHeldBase,
  };
}

export function createPlanningV2GenerationSseHandler(
  args: PlanningV2GenerationSseArgs & { helpers?: PlanningV2GenerationSseHelpers },
): (evt: SseEvent) => boolean {
  const {
    appendMode,
    linked,
    linkedSitesLength,
    siteId,
    weekIso,
    weekStart,
    site,
    pullsScope,
    requestedPullsCount,
    pullsPreferKinds = null,
    appendExistingAlternativesCount,
    dedupeAlternatives,
    controller,
    generationIdRef,
    userStoppedGenerationRef,
    stopVisibleAlternativeCountRef,
    workersRef,
    assignmentVariantsRef,
    draftAssignmentsRef,
    draftPullsRef,
    draftAlternativesRef,
    lastAlternativeSnapshotRef,
    seenAlternativeSnapshotsRef,
    seenLinkedAlternativeSnapshotsRef,
    appendUniqueCountRef,
    setReplaceGenerationUiClear,
    setDraftAssignments,
    setDraftPulls,
    setDraftAlternatives,
    setSelectedAlternativeIndex,
    setIsManual,
    setMoreAlternativesAvailable,
    runtime,
  } = args;
  const {
    finishGenerationVisualState,
    markAcceptedPlan,
    markStagnantNoise,
    scheduleAlternativesFlush,
    stopWhenBatchTargetReached,
    currentBatchVisibleCount,
    shouldRejectForHoleScore,
    promoteBetterPlanToBase,
    maybePaintOrHoldFirstPlan,
    flushPendingHeldBase,
  } = args.helpers || createGenerationSseHelpers(args);
  const planScore = (
    asg: AssignmentGrid | null | undefined,
    pulls: PlanningV2PullsMap | null | undefined,
  ) => singlePlanHoleScore(site, asg, pulls, pullsPreferKinds);
  const linkedScore = (
    plans: Record<string, { assignments?: unknown; pulls?: unknown; required_count?: unknown }>,
  ) => linkedPlansHoleScore(plans, siteId, site, pullsPreferKinds);

  return (evt) => {
    if (
      runtime.stopped ||
      userStoppedGenerationRef.current ||
      (linkedSitesLength > 1 && readLinkedGenerationStopRequestFromSession(weekIso))
    ) {
      if (linkedSitesLength > 1 && readLinkedGenerationStopRequestFromSession(weekIso)) {
        userStoppedGenerationRef.current = true;
        if (stopVisibleAlternativeCountRef.current == null) {
          const visibleCountAtStop = Math.max(0, assignmentVariantsRef.current.length);
          stopVisibleAlternativeCountRef.current = visibleCountAtStop;
          writeLinkedGenerationStopVisibleCountToSession(weekIso, visibleCountAtStop);
          pruneLinkedPlansMemoryAfterStop(weekStart, linkedSitesLength, visibleCountAtStop);
        }
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      }
      runtime.stopped = true;
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
          pullsScope,
          plans,
        });
        if (!linkedPlansMatchRequestedPulls(plans, siteId, requestedPullsCount, pullsScope)) {
          return false;
        }
        const holeScore = linkedScore(plans);
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
          pullsScope,
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
          pullsScope,
          pulls: evt.pulls,
        });
      }
      if (!linked && evt.assignments && typeof evt.assignments === "object") {
        const holeScore = planScore(
          evt.assignments as Record<string, Record<string, string[][]>>,
          evt.pulls && typeof evt.pulls === "object" ? (evt.pulls as PlanningV2PullsMap) : {},
        );
        if (shouldRejectForHoleScore(holeScore, "base", evt.index, evt.generation_id)) {
          return false;
        }
        const firstDecision = maybePaintOrHoldFirstPlan(
          evt.assignments as Record<string, Record<string, string[][]>>,
          evt.pulls && typeof evt.pulls === "object" ? (evt.pulls as PlanningV2PullsMap) : {},
          holeScore,
        );
        if (firstDecision === "held") {
          runtime.sawGeneratedPlan = true;
          runtime.sawPlanToPersist = true;
          markAcceptedPlan();
          return false;
        }
        if (firstDecision === "painted") {
          runtime.sawGeneratedPlan = true;
          runtime.sawPlanToPersist = true;
          markAcceptedPlan();
          seenAlternativeSnapshotsRef.current = buildSeenAlternativeSnapshots(
            evt.assignments as Record<string, Record<string, string[][]>>,
            evt.pulls && typeof evt.pulls === "object" ? (evt.pulls as PlanningV2PullsMap) : {},
            [],
          );
          return false;
        }
        // Un 2e « base » alors qu’un plan est déjà à l’écran : ne pas raz les חלופות.
        if (draftAssignmentsRef.current) {
          return false;
        }
      }
      setReplaceGenerationUiClear(false);
      runtime.sawGeneratedPlan = true;
      runtime.sawPlanToPersist = true;
      markAcceptedPlan();
      if (linked && evt.site_plans && typeof evt.site_plans === "object") {
        if (draftAssignmentsRef.current) {
          return false;
        }
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
          pullsScope,
          plans,
        });
        if (!linkedPlansMatchRequestedPulls(plans, siteId, requestedPullsCount, pullsScope)) {
          return false;
        }
        const holeScore = linkedScore(plans);
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
          pullsScope,
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
          pullsScope,
          pulls: evt.pulls,
        });
      }
      if (!linked && evt.assignments && typeof evt.assignments === "object") {
        const holeScore = planScore(
          evt.assignments as Record<string, Record<string, string[][]>>,
          evt.pulls && typeof evt.pulls === "object" ? (evt.pulls as PlanningV2PullsMap) : {},
        );
        if (shouldRejectForHoleScore(holeScore, "base", evt.index, evt.generation_id)) {
          return false;
        }
      }
      runtime.sawGeneratedPlan = true;
      runtime.sawPlanToPersist = true;
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
        const holeScore = planScore(altAssignments, altPulls);
        const firstDecision = maybePaintOrHoldFirstPlan(altAssignments, altPulls, holeScore);
        if (firstDecision === "held" || firstDecision === "painted") {
          appendUniqueCountRef.current += 1;
          markAcceptedPlan();
          if (firstDecision === "painted" && stopWhenBatchTargetReached()) {
            finishGenerationVisualState();
            return true;
          }
          return false;
        }
        if (promoteBetterPlanToBase(altAssignments, altPulls, holeScore)) {
          appendUniqueCountRef.current += 1;
          markAcceptedPlan();
          if (appendMode) {
            setMoreAlternativesAvailable(true);
          }
          if (stopWhenBatchTargetReached()) {
            finishGenerationVisualState();
            return true;
          }
          return false;
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
          pullsScope,
          plans,
        });
        if (!linkedPlansMatchRequestedPulls(plans, siteId, requestedPullsCount, pullsScope)) {
          return false;
        }
        const holeScore = linkedScore(plans);
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
          pullsScope,
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
          pullsScope,
          pulls: evt.pulls,
        });
      }
      if (!linked && evt.assignments && typeof evt.assignments === "object") {
        const holeScore = planScore(
          evt.assignments as Record<string, Record<string, string[][]>>,
          evt.pulls && typeof evt.pulls === "object" ? (evt.pulls as PlanningV2PullsMap) : {},
        );
        if (shouldRejectForHoleScore(holeScore, "alternative", evt.index, evt.generation_id)) {
          return false;
        }
      }
      runtime.sawGeneratedPlan = true;
      runtime.sawPlanToPersist = true;
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
            nextAlternatives.push(nextAssignments);
            nextAlternativePulls.push(nextPulls);
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
        const holeScore = planScore(altAssignments, altPulls);
        const firstDecision = maybePaintOrHoldFirstPlan(altAssignments, altPulls, holeScore);
        if (firstDecision === "held" || firstDecision === "painted") {
          appendUniqueCountRef.current += 1;
          markAcceptedPlan();
          if (firstDecision === "painted" && stopWhenBatchTargetReached()) {
            finishGenerationVisualState();
            return true;
          }
          return false;
        }
        if (promoteBetterPlanToBase(altAssignments, altPulls, holeScore)) {
          appendUniqueCountRef.current += 1;
          markAcceptedPlan();
          if (appendMode) {
            setMoreAlternativesAvailable(true);
          }
          if (stopWhenBatchTargetReached()) return true;
          return false;
        }
        draftAlternativesRef.current = [
          ...(draftAlternativesRef.current || []),
          {
            assignments: altAssignments as Record<string, Record<string, string[][]>>,
            pulls: altPulls,
          },
        ];
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
      runtime.stopped = true;
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
      flushPendingHeldBase();
      runtime.serverExhaustedAlternatives = currentBatchVisibleCount() < VISIBLE_ALTERNATIVES_BATCH_SIZE;
      finishGenerationVisualState();
      if (runtime.serverExhaustedAlternatives && runtime.sawGeneratedPlan) {
        setMoreAlternativesAvailable(false);
        toast.message("אין חלופות חדשות נוספות");
      } else {
        toast.success("התכנון הושלם");
      }
      runtime.stopped = true;
      return true;
    }
    return false;
  };
}

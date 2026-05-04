"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { PlanningV2PullsMap, PlanningWorker, SiteSummary, WorkerAvailability } from "../types";
import { buildEmptyAssignmentsForSite, shiftNamesFromSite } from "../lib/station-grid-helpers";
import type { V2WeekPlanData } from "./use-planning-v2-week-plan";
import { assignmentsNonEmpty } from "../lib/assignments-empty";
import {
  buildWeekPlanDataPayload,
  buildWorkersSnapshotForSave,
  persistAutoWeekPlanDraftToApi,
  persistWeekPlanToApi,
} from "../lib/week-plan-persist";
import { weeklyAvailabilityMapFromRows } from "../lib/weekly-availability-for-ai";
import { getWeekKeyISO } from "../lib/week";
import { readLinkedPlansFromMemory, saveLinkedPlansToMemory, type LinkedSitePlan } from "../lib/multi-site-linked-memory";
import { clearSitesListPlanningBeforePlanningCreat } from "@/lib/clear-sites-list-planning-for-week";
import { clearAllPlanningSessionCaches } from "@/lib/planning-session-cache";
import { getApiBaseUrl } from "@/lib/api";

const AUTO_PULLS_LIMIT_BY_WEEK_KEY_PREFIX = "planning_v2_auto_pulls_limit_week_";
const MULTI_SITE_GENERATION_NUM_ALTERNATIVES = 140;
const MULTI_SITE_GENERATION_TIME_LIMIT_SECONDS = 30;
const SINGLE_SITE_GENERATION_NUM_ALTERNATIVES = 120;
const SINGLE_SITE_GENERATION_TIME_LIMIT_SECONDS = 28;
const MULTI_SITE_GENERATION_MAX_NUM_ALTERNATIVES = 320;
const MULTI_SITE_GENERATION_MAX_TIME_LIMIT_SECONDS = 35;
const SINGLE_SITE_GENERATION_MAX_NUM_ALTERNATIVES = 180;
const SINGLE_SITE_GENERATION_MAX_TIME_LIMIT_SECONDS = 30;

function pullsLimitPayload(autoPullsEnabled: boolean, autoPullsLimit: string): number | null | undefined {
  if (!autoPullsEnabled) return undefined;
  if (autoPullsLimit === "unlimited") return null;
  const n = Number(autoPullsLimit);
  return Number.isFinite(n) ? n : undefined;
}

function adjustedAppendGenerationBudget(linked: boolean, existingAlternativesCount: number) {
  const baseNum = linked ? MULTI_SITE_GENERATION_NUM_ALTERNATIVES : SINGLE_SITE_GENERATION_NUM_ALTERNATIVES;
  const baseTime = linked ? MULTI_SITE_GENERATION_TIME_LIMIT_SECONDS : SINGLE_SITE_GENERATION_TIME_LIMIT_SECONDS;
  const maxNum = linked ? MULTI_SITE_GENERATION_MAX_NUM_ALTERNATIVES : SINGLE_SITE_GENERATION_MAX_NUM_ALTERNATIVES;
  const maxTime = linked ? MULTI_SITE_GENERATION_MAX_TIME_LIMIT_SECONDS : SINGLE_SITE_GENERATION_MAX_TIME_LIMIT_SECONDS;
  const existing = Math.max(0, Math.trunc(Number(existingAlternativesCount || 0)));
  // `עוד` filtre les doublons côté client. On ajoute un buffer proportionnel au stock déjà vu
  // pour garder un effort de recherche comparable à une génération initiale.
  const nextNum = Math.min(maxNum, baseNum + existing);
  const nextTime = Math.min(maxTime, baseTime + Math.ceil(existing / Math.max(1, Math.ceil(baseNum / 4))));
  return {
    numAlternatives: nextNum,
    timeLimitSeconds: nextTime,
  };
}

async function readSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (evt: Record<string, unknown>) => boolean,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const flushFrame = (rawFrame: string): boolean => {
    const frame = String(rawFrame || "").trim();
    if (!frame) return false;
    const dataLines = frame
      .split("\n")
      .map((ln) => ln.trim())
      .filter((ln) => ln.startsWith("data:"))
      .map((ln) => ln.replace(/^data:\s*/, ""));
    if (dataLines.length === 0) return false;
    const jsonStr = dataLines.join("\n").trim();
    if (!jsonStr) return false;
    try {
      const evt = JSON.parse(jsonStr) as Record<string, unknown>;
      return onEvent(evt);
    } catch {
      return false;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      const tail = buffer.trim();
      if (tail) flushFrame(tail);
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    // Serveurs SSE peuvent utiliser \r\n : on normalise pour bien détecter les frames.
    buffer = buffer.replace(/\r/g, "");
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (flushFrame(frame)) return;
    }
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
  reloadWeekPlan: (opts?: { silent?: boolean }) => void | Promise<void>;
  linkedSitesLength: number;
  /** Sites du groupe (courant + liés) pour purger les טיוטות auto issues d’une ריצה depuis la liste sites. */
  weekPurgeSiteIds: number[];
};

type DraftAlternative = { assignments: Record<string, Record<string, string[][]>>; pulls: PlanningV2PullsMap };

function normalizeDraftAlternatives(
  value: Array<DraftAlternative | null | undefined>,
): DraftAlternative[] {
  return (value || []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const assignments = item.assignments;
    if (!assignments || typeof assignments !== "object") return [];
    return [{
      assignments,
      pulls: (item.pulls || {}) as PlanningV2PullsMap,
    }];
  });
}

function alternativeSnapshot(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: PlanningV2PullsMap | null | undefined,
): string {
  if (!assignments || typeof assignments !== "object") return "";
  try {
    return JSON.stringify({ assignments, pulls: pulls || {} });
  } catch {
    return "";
  }
}

function uniqueDraftAlternatives(
  value: Array<DraftAlternative | null | undefined>,
): DraftAlternative[] {
  const seen = new Set<string>();
  return normalizeDraftAlternatives(value).filter((item) => {
    const snap = alternativeSnapshot(item.assignments, item.pulls);
    if (!snap) return true;
    if (seen.has(snap)) return false;
    seen.add(snap);
    return true;
  });
}

function buildSeenAlternativeSnapshots(
  baseAssignments: Record<string, Record<string, string[][]>> | null | undefined,
  basePulls: PlanningV2PullsMap | null | undefined,
  alternatives: Array<DraftAlternative | null | undefined>,
): Set<string> {
  const seen = new Set<string>();
  const baseSnap = alternativeSnapshot(baseAssignments, basePulls);
  if (baseSnap) seen.add(baseSnap);
  for (const alt of uniqueDraftAlternatives(alternatives)) {
    const snap = alternativeSnapshot(alt.assignments, alt.pulls);
    if (snap) seen.add(snap);
  }
  return seen;
}

function draftAlternativesForMode(
  value: Array<DraftAlternative | null | undefined>,
  dedupe: boolean,
): DraftAlternative[] {
  return dedupe ? uniqueDraftAlternatives(value) : normalizeDraftAlternatives(value);
}

const PLANNING_V2_ALTERNATIVES_UNLOCK_PREFIX = "planning_v2_alternatives_unlock_";
const PLANNING_V2_LINKED_GENERATION_PREFIX = "planning_v2_linked_generation_";

function alternativesUnlockSessionKey(weekIso: string, siteId: string) {
  return `${PLANNING_V2_ALTERNATIVES_UNLOCK_PREFIX}${weekIso}_${siteId}`;
}

function readAlternativesUnlockedFromSession(weekIso: string, siteId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(alternativesUnlockSessionKey(weekIso, siteId)) === "1";
  } catch {
    return false;
  }
}

function writeAlternativesUnlockedToSession(weekIso: string, siteId: string) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(alternativesUnlockSessionKey(weekIso, siteId), "1");
  } catch {
    /* ignore */
  }
}

function linkedGenerationSessionKey(weekIso: string) {
  return `${PLANNING_V2_LINKED_GENERATION_PREFIX}${weekIso}`;
}

function readLinkedGenerationRunningFromSession(weekIso: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(linkedGenerationSessionKey(weekIso)) === "1";
  } catch {
    return false;
  }
}

function writeLinkedGenerationRunningToSession(weekIso: string, running: boolean) {
  if (typeof window === "undefined") return;
  try {
    const key = linkedGenerationSessionKey(weekIso);
    if (running) sessionStorage.setItem(key, "1");
    else sessionStorage.removeItem(key);
    queueMicrotask(() => {
      try {
        window.dispatchEvent(new CustomEvent("planning-v2-linked-generation-updated", { detail: { key, running } }));
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

export function usePlanningV2PlanController({
  siteId,
  weekStart,
  weekPlan,
  site,
  weekPlanLoading,
  workers,
  workerRowsForTable,
  reloadWeekPlan,
  linkedSitesLength,
  weekPurgeSiteIds,
}: PlanControllerArgs) {
  type GenerateOptions = {
    excludeDays?: string[];
    fixedAssignments?: Record<string, Record<string, string[][]>>;
  };
  const [draftAssignments, setDraftAssignments] = useState<Record<string, Record<string, string[][]>> | null>(
    null,
  );
  const [draftPulls, setDraftPulls] = useState<PlanningV2PullsMap | null>(null);
  const [draftAlternatives, setDraftAlternatives] = useState<DraftAlternative[]>([]);
  const [draftFixedAssignmentsSnapshot, setDraftFixedAssignmentsSnapshot] = useState<
    Record<string, Record<string, string[][]>> | null
  >(null);
  const [selectedAlternativeIndex, setSelectedAlternativeIndex] = useState(0);
  const [localGenerationRunning, setGenerationRunning] = useState(false);
  const [sharedLinkedGenerationRunning, setSharedLinkedGenerationRunning] = useState(false);
  /** Pendant יצירה « replace », pas de brouillon : sans ça les variantes restent celles du weekPlan jusqu’au reload + premier SSE — compteur חלופות figé. */
  const [replaceGenerationUiClear, setReplaceGenerationUiClear] = useState(false);
  // Par défaut: משיכות ללא (empty string).
  const [autoPullsLimit, setAutoPullsLimit] = useState("");
  const [isManual, setIsManual] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const generationIdRef = useRef<string | null>(null);
  const genBusyRef = useRef(false);
  const draftAssignmentsRef = useRef<Record<string, Record<string, string[][]>> | null>(null);
  const draftPullsRef = useRef<PlanningV2PullsMap>({});
  const draftAlternativesRef = useRef<DraftAlternative[]>([]);
  const lastAlternativeSnapshotRef = useRef<string>("");
  const seenAlternativeSnapshotsRef = useRef<Set<string>>(new Set());
  const appendUniqueCountRef = useRef(0);
  const alternativesFlushRafRef = useRef<number | null>(null);
  const weekPlanAssignmentsRef = useRef<Record<string, Record<string, string[][]>> | undefined>(undefined);
  const workersRef = useRef(workers);

  useEffect(() => {
    draftAssignmentsRef.current = draftAssignments;
  }, [draftAssignments]);
  useEffect(() => {
    draftPullsRef.current = draftPulls || {};
  }, [draftPulls]);
  useEffect(() => {
    draftAlternativesRef.current = draftAlternatives;
  }, [draftAlternatives]);
  useEffect(() => {
    workersRef.current = workers;
  }, [workers]);
  useEffect(() => {
    weekPlanAssignmentsRef.current = weekPlan?.assignments ?? undefined;
  }, [weekPlan?.assignments]);

  const weekIso = getWeekKeyISO(weekStart);
  const autoPullsStorageKey = `${AUTO_PULLS_LIMIT_BY_WEEK_KEY_PREFIX}${weekIso}`;
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
    if (linkedSitesLength <= 1) {
      setSharedLinkedGenerationRunning(false);
      return;
    }
    const sync = () => setSharedLinkedGenerationRunning(readLinkedGenerationRunningFromSession(weekIso));
    sync();
    window.addEventListener("planning-v2-linked-generation-updated", sync as EventListener);
    return () => window.removeEventListener("planning-v2-linked-generation-updated", sync as EventListener);
  }, [linkedSitesLength, weekIso]);

  const generationRunning = localGenerationRunning || sharedLinkedGenerationRunning;
  const generationStoppable = localGenerationRunning && abortRef.current !== null;

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

  const autoPullsEnabled = autoPullsLimit !== "";

  /** סנכרון isManual מהשרת פעם אחת אחרי טעינת weekPlan לשבוע (לא בכל refetch — שומר על ידני / אפס גריד). */
  const planLoadedForManualRef = useRef(false);

  useEffect(() => {
    setDraftAssignments(null);
    setDraftPulls(null);
    setDraftAlternatives([]);
    setDraftFixedAssignmentsSnapshot(null);
    const preservedAltIndex = linkedSitesLength > 1
      ? Math.max(0, Number(readLinkedPlansFromMemory(weekStart)?.activeAltIndex || 0))
      : 0;
    setSelectedAlternativeIndex(preservedAltIndex);
    setMoreAlternativesAvailable(true);
    planLoadedForManualRef.current = false;
    seenAlternativeSnapshotsRef.current = new Set();
    appendUniqueCountRef.current = 0;
    lastAlternativeSnapshotRef.current = "";
  }, [linkedSitesLength, siteId, weekIso, weekStart]);

  // Multi-sites: כשעוברים בין אתרים, לשמור אלטרנטיבה פעילה זהה לכל האתרים דרך sessionStorage.
  useEffect(() => {
    if (linkedSitesLength <= 1) return;
    let lastAppliedSnap = "";
    const refreshFromMemory = () => {
      // Pendant יצירת תכנון (SSE), le flux met déjà à jour l’état React — ne pas réappliquer
      // la mémoire ici : sinon `linked-plans-memory-updated` (microtâche) rivalise avec
      // `setDraftAlternatives` et peut provoquer « Maximum update depth exceeded ».
      if (genBusyRef.current) return;
      const mem = readLinkedPlansFromMemory(weekStart);
      const plan = mem?.plansBySite?.[String(siteId)];
      if (!plan) return;
      const activeIdx = Math.max(0, Number(mem?.activeAltIndex || 0));
      const snap = JSON.stringify({ activeIdx, plan });
      if (snap === lastAppliedSnap) return;
      lastAppliedSnap = snap;
      const localAssignments =
        draftAssignmentsRef.current ??
        weekPlanAssignmentsRef.current ??
        null;
      const hasAuthoritativeLocalPlan =
        !!localAssignments && assignmentsNonEmpty(localAssignments);
      const localAlternativeCount = (() => {
        if (draftAssignmentsRef.current) {
          return 1 + draftAlternativesForMode(draftAlternativesRef.current || [], dedupeAlternatives).length;
        }
        const hasLocalBase = assignmentsNonEmpty(weekPlanAssignmentsRef.current ?? null);
        const localWeekPlanAlternatives = Array.isArray(weekPlan?.alternatives) ? weekPlan.alternatives : [];
        return (hasLocalBase ? 1 : 0) + localWeekPlanAlternatives.length;
      })();
      const memoryHasBase = assignmentsNonEmpty(
        (plan.assignments as Record<string, Record<string, string[][]>> | null | undefined) ?? null,
      );
      const memoryAlternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
      const memoryAlternativeCount =
        (memoryHasBase ? 1 : 0) +
        memoryAlternatives.filter((asg) =>
          assignmentsNonEmpty((asg as Record<string, Record<string, string[][]>> | null | undefined) ?? null)).length;
      const shouldHydrateFromMemory =
        !hasAuthoritativeLocalPlan ||
        memoryAlternativeCount > localAlternativeCount ||
        activeIdx >= Math.max(1, localAlternativeCount);
      // En multi-site, la mémoire session sert à partager l’index d’alternative et les autres sites.
      // Si la mémoire est plus riche (plus d’alternatives, ou index actif hors portée locale),
      // il faut quand même la réhydrater pour préserver exactement la même חלופה après navigation.
      if (shouldHydrateFromMemory) {
        const baseAssignments = plan.assignments as Record<string, Record<string, string[][]>> | undefined;
        if (baseAssignments && typeof baseAssignments === "object") {
          setDraftAssignments(baseAssignments);
        }
        setDraftPulls((plan.pulls as PlanningV2PullsMap) || {});
        const altsAssignments = Array.isArray(plan.alternatives) ? plan.alternatives : [];
        const altsPulls = Array.isArray(plan.alternative_pulls) ? plan.alternative_pulls : [];
        const alts = altsAssignments.flatMap((asg, idx) => {
          if (!asg || typeof asg !== "object") return [];
          return [{
            assignments: asg as Record<string, Record<string, string[][]>>,
            pulls: ((altsPulls[idx] || {}) as PlanningV2PullsMap),
          }];
        });
        setDraftAlternatives(alts);
      }
      setSelectedAlternativeIndex(activeIdx);
    };
    refreshFromMemory();
    const onMem = () => refreshFromMemory();
    window.addEventListener("linked-plans-memory-updated", onMem as EventListener);
    return () => window.removeEventListener("linked-plans-memory-updated", onMem as EventListener);
  }, [linkedSitesLength, siteId, weekStart, generationRunning]);

  useEffect(() => {
    if (weekPlanLoading) return;
    if (!weekPlan) return;
    if (planLoadedForManualRef.current) return;
    planLoadedForManualRef.current = true;
    setIsManual(!!weekPlan.isManual);
  }, [weekPlanLoading, weekPlan, weekPlan?.isManual]);

  const assignmentVariants = useMemo<Array<Record<string, Record<string, string[][]>>>>(() => {
    if (replaceGenerationUiClear && generationRunning && !draftAssignments) {
      return [buildEmptyAssignmentsForSite(site)];
    }
    if (draftAssignments) {
      const normalized = draftAlternativesForMode(draftAlternatives, dedupeAlternatives);
      return [draftAssignments, ...normalized.map((x) => x.assignments)];
    }
    const base = weekPlan?.assignments ? [weekPlan.assignments] : [];
    const altsAssignments = Array.isArray(weekPlan?.alternatives) ? weekPlan.alternatives : [];
    const altsPulls = Array.isArray(weekPlan?.alternativePulls) ? weekPlan.alternativePulls : [];
    const alts = draftAlternativesForMode(
      altsAssignments.map((assignments, idx) => ({
        assignments,
        pulls: (altsPulls[idx] || {}) as PlanningV2PullsMap,
      })),
      dedupeAlternatives,
    );
    return [...base, ...alts.map((x) => x.assignments)];
  }, [
    dedupeAlternatives,
    draftAssignments,
    draftAlternatives,
    generationRunning,
    replaceGenerationUiClear,
    weekPlan?.assignments,
    weekPlan?.alternatives,
    weekPlan?.alternativePulls,
    site,
  ]);

  const pullVariants = useMemo<PlanningV2PullsMap[]>(() => {
    if (replaceGenerationUiClear && generationRunning && !draftAssignments) {
      return [{}];
    }
    if (draftAssignments) {
      const basePulls = draftPulls || {};
      const normalized = draftAlternativesForMode(draftAlternatives, dedupeAlternatives);
      return [basePulls, ...normalized.map((x) => x.pulls || {})];
    }
    const basePulls =
      weekPlan?.pulls && typeof weekPlan.pulls === "object" ? (weekPlan.pulls as PlanningV2PullsMap) : {};
    const altAssignments = Array.isArray(weekPlan?.alternatives) ? weekPlan.alternatives : [];
    const altPulls = Array.isArray(weekPlan?.alternativePulls) ? weekPlan.alternativePulls : [];
    const normalized = draftAlternativesForMode(
      altAssignments.map((assignments, idx) => ({
        assignments,
        pulls: (altPulls[idx] && typeof altPulls[idx] === "object" ? altPulls[idx] : {}) as PlanningV2PullsMap,
      })),
      dedupeAlternatives,
    );
    return [basePulls, ...normalized.map((x) => x.pulls || {})];
  }, [
    dedupeAlternatives,
    draftAssignments,
    draftPulls,
    draftAlternatives,
    generationRunning,
    replaceGenerationUiClear,
    weekPlan?.pulls,
    weekPlan?.alternativePulls,
  ]);

  const alternativeCount = useMemo(() => {
    if (replaceGenerationUiClear && generationRunning && !draftAssignments) return 0;
    return assignmentVariants.length;
  }, [replaceGenerationUiClear, generationRunning, draftAssignments, assignmentVariants.length]);

  /** Débloqué seulement après יצירת תכנון dans cet onglet (session), ou pendant la génération SSE. */
  const alternativesUnlocked = useMemo(() => {
    void alternativesUnlockNonce;
    if (generationRunning) return true;
    if (clientStorageReady && readAlternativesUnlockedFromSession(weekIso, siteId)) return true;
    if (clientStorageReady && linkedSitesLength > 1) {
      const mem = readLinkedPlansFromMemory(weekStart);
      const currentPlan = mem?.plansBySite?.[String(siteId)];
      if (currentPlan) {
        const hasBase = assignmentsNonEmpty(
          (currentPlan.assignments as Record<string, Record<string, string[][]>> | null | undefined) ?? null,
        );
        const hasAlt = Array.isArray(currentPlan.alternatives)
          && currentPlan.alternatives.some((alt) =>
            assignmentsNonEmpty((alt as Record<string, Record<string, string[][]>> | null | undefined) ?? null));
        if (hasBase || hasAlt) return true;
      }
    }
    return false;
  }, [clientStorageReady, weekIso, siteId, generationRunning, alternativesUnlockNonce, linkedSitesLength, weekStart]);

  const safeAlternativeIndex = useMemo(() => {
    const len = assignmentVariants.length;
    if (len <= 0) return 0;
    return Math.min(Math.max(0, selectedAlternativeIndex), len - 1);
  }, [selectedAlternativeIndex, assignmentVariants.length]);

  useEffect(() => {
    // Pendant la génération SSE, `alternativeCount` bouge à chaque événement — ne pas resynchroniser
    // l’index ici (sinon boucle avec les effets du résumé / filtres qui appellent aussi setSelected).
    if (generationRunning) return;
    if (safeAlternativeIndex !== selectedAlternativeIndex) {
      setSelectedAlternativeIndex(safeAlternativeIndex);
    }
  }, [generationRunning, safeAlternativeIndex, selectedAlternativeIndex]);

  const displayAssignments = useMemo(() => {
    if (assignmentVariants.length === 0) return null;
    return assignmentVariants[safeAlternativeIndex] || assignmentVariants[0] || null;
  }, [assignmentVariants, safeAlternativeIndex]);

  const displayPulls = useMemo((): PlanningV2PullsMap | null | undefined => {
    if (pullVariants.length === 0) return undefined;
    return pullVariants[safeAlternativeIndex] || pullVariants[0] || {};
  }, [pullVariants, safeAlternativeIndex]);

  const stopGeneration = useCallback(() => {
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
    setGenerationRunning(false);
    setReplaceGenerationUiClear(false);
    if (linkedSitesLength > 1) {
      writeLinkedGenerationRunningToSession(weekIso, false);
    }
    genBusyRef.current = false;
  }, [linkedSitesLength, weekIso]);

  const runGeneration = useCallback(async (options?: GenerateOptions, mode: "replace" | "append" = "replace") => {
    const id = Number(siteId);
    if (!Number.isFinite(id) || id <= 0) return;
    if (genBusyRef.current) return;
    const appendMode = mode === "append";
    try {
      abortRef.current?.abort();
    } catch {
      /* ignore */
    }
    const controller = new AbortController();
    abortRef.current = controller;
    generationIdRef.current = null;
    genBusyRef.current = true;
    setGenerationRunning(true);
    if (linkedSitesLength > 1) {
      writeLinkedGenerationRunningToSession(weekIso, true);
    }
    let appendExistingAlternativesCount = 0;
    if (!appendMode) {
      setReplaceGenerationUiClear(true);
      setSelectedAlternativeIndex(0);
      setMoreAlternativesAvailable(true);
      draftAssignmentsRef.current = null;
      draftPullsRef.current = {};
      draftAlternativesRef.current = [];
      seenAlternativeSnapshotsRef.current = new Set();
      appendUniqueCountRef.current = 0;
      lastAlternativeSnapshotRef.current = "";
      setDraftAssignments(null);
      setDraftPulls(null);
      setDraftAlternatives([]);
    } else {
      setReplaceGenerationUiClear(false);
      const baseAssignments =
        draftAssignmentsRef.current ??
        weekPlanAssignmentsRef.current ??
        (assignmentVariants[0] && typeof assignmentVariants[0] === "object" ? assignmentVariants[0] : null);
      const basePulls =
        draftPullsRef.current ||
        ((pullVariants[0] && typeof pullVariants[0] === "object" ? pullVariants[0] : {}) as PlanningV2PullsMap);
      const existingAlternatives = normalizeDraftAlternatives(
        draftAssignmentsRef.current
          ? draftAlternativesRef.current || []
          : assignmentVariants.slice(1).map((assignments, idx) => ({
              assignments,
              pulls: (pullVariants[idx + 1] || {}) as PlanningV2PullsMap,
            })),
      );
      appendExistingAlternativesCount = existingAlternatives.length;
      if (baseAssignments && typeof baseAssignments === "object") {
        draftAssignmentsRef.current = baseAssignments;
        draftPullsRef.current = basePulls;
        draftAlternativesRef.current = draftAlternativesForMode(existingAlternatives, dedupeAlternatives);
        setDraftAssignments(baseAssignments);
        setDraftPulls(basePulls);
        setDraftAlternatives(draftAlternativesForMode(existingAlternatives, dedupeAlternatives));
      }
      seenAlternativeSnapshotsRef.current = dedupeAlternatives
        ? buildSeenAlternativeSnapshots(baseAssignments, basePulls, existingAlternatives)
        : new Set();
      appendUniqueCountRef.current = 0;
      lastAlternativeSnapshotRef.current = "";
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
      clearAllPlanningSessionCaches();
      const purgeIds =
        weekPurgeSiteIds.length > 0
          ? weekPurgeSiteIds
          : Number.isFinite(Number(siteId)) && Number(siteId) > 0
            ? [Number(siteId)]
            : [];
      if (purgeIds.length > 0) {
        try {
          await clearSitesListPlanningBeforePlanningCreat(weekIso, purgeIds);
          try {
            window.dispatchEvent(
              new CustomEvent("planning-v2-assignment-filters-reset", {
                detail: { weekIso },
              }),
            );
          } catch {
            /* ignore */
          }
          await reloadWeekPlan();
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

    const weekly_availability = weeklyAvailabilityMapFromRows(workerRowsForTable);
    const pulls_limit = pullsLimitPayload(autoPullsEnabled, autoPullsLimit);

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
    let idleAutoClosed = false;
    let noResultAutoClosed = false;
    let sawPlanToPersist = false;
    let sawGeneratedPlan = false;
    const scheduleAlternativesFlush = () => {
      if (alternativesFlushRafRef.current != null) return;
      alternativesFlushRafRef.current = window.requestAnimationFrame(() => {
        alternativesFlushRafRef.current = null;
        setDraftAlternatives((prev) => {
          const next = draftAlternativesForMode(draftAlternativesRef.current || [], dedupeAlternatives);
          // Évite les renders inutiles quand rien n'a changé.
          if (prev.length === next.length) return prev;
          return [...next];
        });
      });
    };

    const persistGeneratedAutoDraftToServer = async () => {
      if (linkedSitesLength > 1) {
        const mem = readLinkedPlansFromMemory(weekStart);
        for (const [sid, pl] of Object.entries(mem?.plansBySite || {})) {
          const assignments = pl.assignments;
          if (!assignments || !assignmentsNonEmpty(assignments)) continue;
          const pulls = (pl.pulls && typeof pl.pulls === "object" ? pl.pulls : {}) as Record<string, unknown>;
          const altAsg = Array.isArray(pl.alternatives) ? pl.alternatives : [];
          const altPulls = Array.isArray(pl.alternative_pulls) ? pl.alternative_pulls : [];
          const uniqueAlts = normalizeDraftAlternatives(
            altAsg.map((assignmentsItem, idx) => ({
              assignments: assignmentsItem as Record<string, Record<string, string[][]>>,
              pulls: (altPulls[idx] && typeof altPulls[idx] === "object" ? altPulls[idx] : {}) as PlanningV2PullsMap,
            })),
          );
          const w = String(sid) === String(siteId) ? workersRef.current : [];
          const base = buildWeekPlanDataPayload(
            Number(sid),
            weekStart,
            assignments as Record<string, Record<string, string[][]>>,
            pulls as PlanningV2PullsMap,
            buildWorkersSnapshotForSave(w),
            false,
          ) as Record<string, unknown>;
          if (uniqueAlts.length > 0) {
            base.alternatives = uniqueAlts.map((x) => x.assignments);
            base.alternative_pulls = uniqueAlts.map((x) => x.pulls || {});
          }
          await persistAutoWeekPlanDraftToApi(sid, weekStart, base);
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
        throw new Error(`HTTP ${resp.status}`);
      }
      let stopped = false;
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
      }, 30000);
      let lastSseEventAt = Date.now();
      // Aligné sur planning classique: fin propre après 3s d'inactivité SSE.
      const idleCloseMs = 3000;
      idleWatch = window.setInterval(() => {
        if (stopped) return;
        if (!sawGeneratedPlan) return;
        if (Date.now() - lastSseEventAt < idleCloseMs) return;
        idleAutoClosed = true;
        stopped = true;
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      }, 1000);
      await readSseStream(resp.body.getReader(), (evt) => {
        if (stopped) return true;
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
        lastSseEventAt = Date.now();
        if (evt.type === "base" && !appendMode) {
          setReplaceGenerationUiClear(false);
          sawGeneratedPlan = true;
          sawPlanToPersist = true;
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
          sawGeneratedPlan = true;
          sawPlanToPersist = true;
          let altAssignments: Record<string, Record<string, string[][]>> | null = null;
          let altPulls: PlanningV2PullsMap = {};
          if (linked && evt.site_plans && typeof evt.site_plans === "object") {
            const plans = evt.site_plans as Record<string, { assignments?: unknown; pulls?: unknown }>;
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
              saveLinkedPlansToMemory(weekStart, merged, Number(existing?.activeAltIndex || 0));
            }
            const curEvent = plans[String(siteId)];
            if (curEvent?.assignments && typeof curEvent.assignments === "object") {
              altAssignments = curEvent.assignments as Record<string, Record<string, string[][]>>;
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
            if (appendMode) {
              setMoreAlternativesAvailable(true);
            }
            scheduleAlternativesFlush();
          }
          return false;
        }
        if (evt.type === "alternative") {
          sawGeneratedPlan = true;
          sawPlanToPersist = true;
          const altSlot = Math.max(0, Math.trunc(Number(evt.index || 0)) - 1);
          let altAssignments: Record<string, Record<string, string[][]>> | null = null;
          let altPulls: PlanningV2PullsMap = {};
          if (linked && evt.site_plans && typeof evt.site_plans === "object") {
            const plans = evt.site_plans as Record<string, { assignments?: unknown; pulls?: unknown }>;
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
              saveLinkedPlansToMemory(weekStart, merged, Number(existing?.activeAltIndex || 0));
            }
            const curEvent = plans[String(siteId)];
            if (curEvent?.assignments && typeof curEvent.assignments === "object") {
              altAssignments = curEvent.assignments as Record<string, Record<string, string[][]>>;
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
            if (appendMode) {
              setMoreAlternativesAvailable(true);
            }
            scheduleAlternativesFlush();
          }
          return false;
        }
        if (evt.type === "status" && evt.status === "ERROR") {
          toast.error("יצירת תכנון נכשלה", { description: String(evt.detail || "") });
          stopped = true;
          return true;
        }
        if (evt.type === "done") {
          toast.success("התכנון הושלם");
          stopped = true;
          return true;
        }
        return false;
      });
    } catch (e: unknown) {
      if ((e as Error)?.name === "AbortError") {
        if (idleAutoClosed) {
          toast.success("התכנון הושלם");
        } else if (noResultAutoClosed) {
          toast.error("יצירת תכנון נכשלה", { description: "לא התקבלו תוצאות מהשרת." });
        } else {
          toast.message("יצירת התכנון הופסקה");
        }
      } else {
        toast.error("יצירת תכנון נכשלה", { description: String((e as Error)?.message || "") });
      }
    } finally {
      if (idleWatch) {
        window.clearInterval(idleWatch);
      }
      if (noResultWatch) {
        window.clearTimeout(noResultWatch);
      }
      if (alternativesFlushRafRef.current != null) {
        try {
          window.cancelAnimationFrame(alternativesFlushRafRef.current);
        } catch {
          /* ignore */
        }
        alternativesFlushRafRef.current = null;
        // Après annulation du RAF, synchroniser pour que React reflète toutes les alternatives reçues.
        const nextAlternatives = draftAlternativesForMode(draftAlternativesRef.current || [], dedupeAlternatives);
        setDraftAlternatives([...nextAlternatives]);
      }
      // Ne pas utiliser num_alternatives du premier flux pour couper « עוד » : la génération n’est pas
      // déterministe et peut livrer moins d’alternatives que la limite alors que d’autres existent.
      // On désactive uniquement après un flux « append » sans aucune alternative nouvelle (voir ci‑dessous).
      if (appendMode && appendUniqueCountRef.current === 0 && sawGeneratedPlan && (idleAutoClosed || !controller.signal.aborted)) {
        setMoreAlternativesAvailable(false);
        toast.message("אין חלופות חדשות נוספות");
      }
      setGenerationRunning(false);
      setReplaceGenerationUiClear(false);
      if (linkedSitesLength > 1) {
        writeLinkedGenerationRunningToSession(weekIso, false);
      }
      genBusyRef.current = false;
      abortRef.current = null;
      generationIdRef.current = null;
      if (sawPlanToPersist) {
        writeAlternativesUnlockedToSession(weekIso, siteId);
        setAlternativesUnlockNonce((n) => n + 1);
        void (async () => {
          try {
            await persistGeneratedAutoDraftToServer();
            await reloadWeekPlan({ silent: true });
            // Après persistance/reload, ne pas garder un brouillon local potentiellement divergent
            // du plan auto réellement stocké (source de désynchronisation multi-site / סה"כ).
            draftAssignmentsRef.current = null;
            draftPullsRef.current = {};
            draftAlternativesRef.current = [];
            setDraftAssignments(null);
            setDraftPulls(null);
            setDraftAlternatives([]);
          } catch (err) {
            console.warn("[planning-v2] persist auto draft after generation:", err);
          }
        })();
      }
    }
  }, [
    dedupeAlternatives,
    assignmentVariants,
    pullVariants,
    siteId,
    weekIso,
    weekStart,
    workerRowsForTable,
    autoPullsEnabled,
    autoPullsLimit,
    linkedSitesLength,
    reloadWeekPlan,
    weekPurgeSiteIds,
    alternativesFlushRafRef,
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

  /** יציאה ממצב עריכת תכנון שמור — מנקה טיוטה, טוען מחדש מהשרת, מסנכרן isManual. */
  const cancelSavedEditing = useCallback(async () => {
    setDraftAssignments(null);
    setDraftPulls(null);
    setDraftAlternatives([]);
    setDraftFixedAssignmentsSnapshot(null);
    setSelectedAlternativeIndex(0);
    planLoadedForManualRef.current = false;
    await reloadWeekPlan();
  }, [reloadWeekPlan]);

  const enterManualWithGridReset = useCallback(() => {
    setDraftAssignments(buildEmptyAssignmentsForSite(site));
    setDraftPulls({});
    setDraftAlternatives([]);
    setDraftFixedAssignmentsSnapshot(null);
    setSelectedAlternativeIndex(0);
    setIsManual(true);
  }, [site]);

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

  const setSelectedAlternativeIndexSynced = useCallback(
    (index: number) => {
      const next = Math.max(0, Number(index || 0));
      setSelectedAlternativeIndex((prev) => {
        return prev === next ? prev : next;
      });
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
    [siteId, weekIso, linkedSitesLength, weekStart],
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
    autoPullsEnabled,
    isManual,
    setIsManual,
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
    resetManualStation,
    getLatestAssignmentBase,
    commitDraftAssignments,
    commitDraftPulls,
  };
}

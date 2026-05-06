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
import {
  buildPersistableLinkedPlans,
  readLinkedPlansFromMemory,
  saveLinkedPlansToMemory,
  type LinkedSitePlan,
} from "../lib/multi-site-linked-memory";
import { countAssignedCellsForLinkedHoles, countRequiredSlotsFromSiteConfig } from "../lib/linked-site-holes";
import { countAssignmentsPerWorkerName, subtractPullExtrasFromWorkerCounts } from "../lib/assignments-summary-math";
import { clearSitesListPlanningBeforePlanningCreat } from "@/lib/clear-sites-list-planning-for-week";
import { clearAllPlanningSessionCaches } from "@/lib/planning-session-cache";
import { apiFetch, getApiBaseUrl } from "@/lib/api";
import { resolveMaxShifts } from "@/lib/max-shifts";

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

function pullsCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.keys(value as Record<string, unknown>).length;
}

function pullsMatchRequestedCount(pulls: unknown, requestedCount: number | null): boolean {
  if (requestedCount == null) return true;
  return pullsCount(pulls) <= requestedCount;
}

function linkedPlansMatchRequestedPulls(
  plans: Record<string, { pulls?: unknown }> | null | undefined,
  siteId: string,
  requestedCount: number | null,
  pullsScope?: "current_only" | "all_sites",
): boolean {
  if (requestedCount == null) return true;
  if (!plans || typeof plans !== "object") return false;
  if (pullsScope === "current_only") {
    return pullsMatchRequestedCount(plans[String(siteId)]?.pulls, requestedCount);
  }
  const entries = Object.values(plans);
  return entries.length > 0 && entries.every((plan) => pullsMatchRequestedCount(plan?.pulls, requestedCount));
}

function logPlanningV2PullCandidate(params: {
  itemType: "base" | "alternative";
  appendMode: boolean;
  linked: boolean;
  siteId: string;
  weekIso: string;
  eventIndex: unknown;
  generationId: unknown;
  requestedCount: number | null;
  pullsScope?: "current_only" | "all_sites";
  pulls?: unknown;
  plans?: Record<string, { pulls?: unknown }> | null;
}) {
  const base = {
    itemType: params.itemType,
    mode: params.appendMode ? "append" : "replace",
    linked: params.linked,
    siteId: String(params.siteId),
    weekIso: params.weekIso,
    eventIndex: params.eventIndex ?? null,
    generationId: params.generationId ?? null,
    requestedPulls: params.requestedCount,
    pullsScope: params.pullsScope || null,
  };
  if (params.linked) {
    const plans = params.plans || {};
    const pullsBySite = Object.fromEntries(
      Object.entries(plans).map(([linkedSiteId, plan]) => [linkedSiteId, pullsCount(plan?.pulls)]),
    );
    const currentSitePulls = pullsBySite[String(params.siteId)] ?? 0;
    const totalPulls = Object.values(pullsBySite).reduce((sum, count) => sum + Number(count || 0), 0);
    const message =
      totalPulls > 0
        ? "[planning-v2][משיכות][candidate-with-pulls]"
        : "[planning-v2][משיכות][candidate-without-pulls]";
    console.warn(message, {
      ...base,
      currentSitePulls,
      totalPulls,
      pullsBySite,
      willRejectForRequestedPulls:
        params.requestedCount != null &&
        !linkedPlansMatchRequestedPulls(plans, params.siteId, params.requestedCount, params.pullsScope),
    });
    return;
  }
  const currentSitePulls = pullsCount(params.pulls);
  const message =
    currentSitePulls > 0
      ? "[planning-v2][משיכות][candidate-with-pulls]"
      : "[planning-v2][משיכות][candidate-without-pulls]";
  console.warn(message, {
    ...base,
    currentSitePulls,
    totalPulls: currentSitePulls,
    willRejectForRequestedPulls:
      params.requestedCount != null && !pullsMatchRequestedCount(params.pulls, params.requestedCount),
  });
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
  reloadWeekPlan: (opts?: { silent?: boolean; preferredScope?: "director" | "shared" | "auto" | null }) => void | Promise<void>;
  linkedSitesLength: number;
  /** Sites du groupe (courant + liés) pour purger les טיוטות auto issues d’une ריצה depuis la liste sites. */
  weekPurgeSiteIds: number[];
};

type DraftAlternative = { assignments: Record<string, Record<string, string[][]>>; pulls: PlanningV2PullsMap };
type HoleScore = { holes: number; assigned: number; required: number; pulls: number };

function singlePlanHoleScore(
  site: SiteSummary | null,
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: PlanningV2PullsMap | null | undefined,
): HoleScore {
  const required = countRequiredSlotsFromSiteConfig(site);
  const assigned = countAssignedCellsForLinkedHoles(assignments, pulls || {});
  return { assigned, required, holes: Math.max(0, required - assigned), pulls: pullsCount(pulls) };
}

function linkedPlansHoleScore(
  plans: Record<string, { assignments?: unknown; pulls?: unknown; required_count?: unknown }> | null | undefined,
  currentSiteId: string,
  currentSite: SiteSummary | null,
): HoleScore {
  let assigned = 0;
  let required = 0;
  let totalPulls = 0;
  for (const [siteKey, plan] of Object.entries(plans || {})) {
    const assignments = plan?.assignments && typeof plan.assignments === "object"
      ? (plan.assignments as Record<string, Record<string, string[][]>>)
      : null;
    const pulls = plan?.pulls && typeof plan.pulls === "object"
      ? (plan.pulls as PlanningV2PullsMap)
      : {};
    totalPulls += pullsCount(pulls);
    assigned += countAssignedCellsForLinkedHoles(assignments, pulls);
    const rawRequired = Number(plan?.required_count);
    required += Number.isFinite(rawRequired) && rawRequired > 0
      ? rawRequired
      : String(siteKey) === String(currentSiteId)
        ? countRequiredSlotsFromSiteConfig(currentSite)
        : 0;
  }
  return { assigned, required, holes: Math.max(0, required - assigned), pulls: totalPulls };
}

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

function linkedSitePlansSnapshot(
  plans: Record<string, { assignments?: unknown; pulls?: unknown }> | null | undefined,
): string {
  if (!plans || typeof plans !== "object") return "";
  try {
    const normalized = Object.fromEntries(
      Object.entries(plans)
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
        .map(([siteKey, payload]) => [
          siteKey,
          {
            assignments:
              payload && typeof payload === "object" && payload.assignments && typeof payload.assignments === "object"
                ? payload.assignments
                : null,
            pulls:
              payload && typeof payload === "object" && payload.pulls && typeof payload.pulls === "object"
                ? payload.pulls
                : {},
          },
        ]),
    );
    return JSON.stringify(normalized);
  } catch {
    return "";
  }
}

function buildSeenLinkedAlternativeSnapshots(
  plansBySite: Record<string, LinkedSitePlan> | null | undefined,
): Set<string> {
  const seen = new Set<string>();
  if (!plansBySite || typeof plansBySite !== "object") return seen;
  const maxAlternativeCount = Math.max(
    0,
    ...Object.values(plansBySite).map((plan) => (Array.isArray(plan?.alternatives) ? plan.alternatives.length : 0)),
  );
  for (let idx = 0; idx <= maxAlternativeCount; idx += 1) {
    const snapshotPlans: Record<string, { assignments?: unknown; pulls?: unknown }> = {};
    for (const [siteKey, plan] of Object.entries(plansBySite)) {
      if (!plan || typeof plan !== "object") continue;
      if (idx === 0) {
        snapshotPlans[siteKey] = {
          assignments: plan.assignments && typeof plan.assignments === "object" ? plan.assignments : null,
          pulls: plan.pulls && typeof plan.pulls === "object" ? plan.pulls : {},
        };
        continue;
      }
      const alternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
      const alternativePulls = Array.isArray(plan.alternative_pulls) ? plan.alternative_pulls : [];
      if (idx - 1 >= alternatives.length) continue;
      snapshotPlans[siteKey] = {
        assignments: alternatives[idx - 1],
        pulls:
          idx - 1 < alternativePulls.length && alternativePulls[idx - 1] && typeof alternativePulls[idx - 1] === "object"
            ? alternativePulls[idx - 1]
            : {},
      };
    }
    const snap = linkedSitePlansSnapshot(snapshotPlans);
    if (snap) seen.add(snap);
  }
  return seen;
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

function linkedSitePlansRespectMaxShifts(
  plans: Record<string, { assignments?: unknown; pulls?: unknown }>,
  workers: PlanningWorker[],
): boolean {
  return linkedSitePlansMaxShiftOverages(plans, workers).length === 0;
}

function linkedSitePlansMaxShiftOverages(
  plans: Record<string, { assignments?: unknown; pulls?: unknown }>,
  workers: PlanningWorker[],
): Array<{
  workerName: string;
  total: number;
  maxShifts: number;
  siteBreakdown: Record<string, number>;
}> {
  const overages: Array<{
    workerName: string;
    total: number;
    maxShifts: number;
    siteBreakdown: Record<string, number>;
  }> = [];
  for (const worker of workers) {
    if (!Array.isArray(worker.linkedSiteIds) || worker.linkedSiteIds.length <= 1) continue;
    const workerName = String(worker.name || "").trim();
    if (!workerName) continue;
    const maxShifts = resolveMaxShifts(worker.maxShifts);
    if (!Number.isFinite(maxShifts) || maxShifts <= 0) continue;
    let total = 0;
    const siteBreakdown: Record<string, number> = {};
    for (const linkedSiteId of worker.linkedSiteIds) {
      const sitePlan = plans[String(linkedSiteId)];
      if (!sitePlan || !sitePlan.assignments || typeof sitePlan.assignments !== "object") {
        siteBreakdown[String(linkedSiteId)] = 0;
        continue;
      }
      const counts = subtractPullExtrasFromWorkerCounts(
        countAssignmentsPerWorkerName(sitePlan.assignments as Record<string, Record<string, string[][]>>),
        (sitePlan.pulls && typeof sitePlan.pulls === "object" ? sitePlan.pulls : null) as PlanningV2PullsMap | null,
      );
      const siteTotal = Number(counts.get(workerName) || 0);
      siteBreakdown[String(linkedSiteId)] = siteTotal;
      total += siteTotal;
    }
    if (total > Math.trunc(maxShifts)) {
      overages.push({
        workerName,
        total,
        maxShifts: Math.trunc(maxShifts),
        siteBreakdown,
      });
    }
  }
  return overages;
}

function linkedPlansAltCounts(plansBySite: Record<string, LinkedSitePlan> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [sid, plan] of Object.entries(plansBySite || {})) {
    out[String(sid)] = Array.isArray(plan?.alternatives) ? plan.alternatives.length : 0;
  }
  return out;
}

function linkedCandidatePlansAtIndex(
  plansBySite: Record<string, LinkedSitePlan>,
  index: number,
): Record<string, { assignments?: unknown; pulls?: unknown }> {
  const candidate: Record<string, { assignments?: unknown; pulls?: unknown }> = {};
  for (const [sid, plan] of Object.entries(plansBySite || {})) {
    if (index <= 0) {
      candidate[sid] = {
        assignments: plan.assignments,
        pulls: plan.pulls && typeof plan.pulls === "object" ? plan.pulls : {},
      };
      continue;
    }
    const alternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
    const alternativePulls = Array.isArray(plan.alternative_pulls) ? plan.alternative_pulls : [];
    candidate[sid] = {
      assignments: alternatives[index - 1],
      pulls:
        alternativePulls[index - 1] && typeof alternativePulls[index - 1] === "object"
          ? alternativePulls[index - 1]
          : {},
    };
  }
  return candidate;
}

function pruneLinkedPlansOverMaxShifts(
  plansBySite: Record<string, LinkedSitePlan>,
  workers: PlanningWorker[],
): { plansBySite: Record<string, LinkedSitePlan>; dropped: Array<{ index: number; overages: ReturnType<typeof linkedSitePlansMaxShiftOverages> }> } {
  const normalized = buildPersistableLinkedPlans(plansBySite);
  const siteEntries = Object.entries(normalized);
  if (siteEntries.length === 0) return { plansBySite: normalized, dropped: [] };
  const nextPlans = Object.fromEntries(
    siteEntries.map(([sid, plan]) => [
      sid,
      {
        ...plan,
        alternatives: [] as Record<string, Record<string, string[][]>>[],
        alternative_pulls: [] as Record<string, unknown>[],
      } satisfies LinkedSitePlan,
    ]),
  ) as Record<string, LinkedSitePlan>;
  const altCount = Math.min(
    ...siteEntries.map(([, plan]) => (Array.isArray(plan.alternatives) ? plan.alternatives.length : 0)),
  );
  const dropped: Array<{ index: number; overages: ReturnType<typeof linkedSitePlansMaxShiftOverages> }> = [];
  for (let index = 1; index <= altCount; index += 1) {
    const candidate = linkedCandidatePlansAtIndex(normalized, index);
    const overages = linkedSitePlansMaxShiftOverages(candidate, workers);
    if (overages.length > 0) {
      dropped.push({ index, overages });
      continue;
    }
    for (const [sid, plan] of siteEntries) {
      const alternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
      const alternativePulls = Array.isArray(plan.alternative_pulls) ? plan.alternative_pulls : [];
      nextPlans[sid].alternatives?.push(alternatives[index - 1]);
      nextPlans[sid].alternative_pulls?.push(
        (alternativePulls[index - 1] && typeof alternativePulls[index - 1] === "object"
          ? alternativePulls[index - 1]
          : {}) as Record<string, unknown>,
      );
    }
  }
  return { plansBySite: nextPlans, dropped };
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
    pullsScope?: "current_only" | "all_sites";
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
  const seenLinkedAlternativeSnapshotsRef = useRef<Set<string>>(new Set());
  const bestGeneratedHoleScoreRef = useRef<HoleScore | null>(null);
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
    seenLinkedAlternativeSnapshotsRef.current = new Set();
    bestGeneratedHoleScoreRef.current = null;
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
      const normalizedPlans = buildPersistableLinkedPlans(mem?.plansBySite);
      const plan = normalizedPlans[String(siteId)];
      if (!plan) return;
      const activeIdx = Math.max(0, Number(mem?.activeAltIndex || 0));
      const snap = JSON.stringify({ activeIdx, plan });
      if (snap === lastAppliedSnap) return;
      lastAppliedSnap = snap;
      if (mem?.plansBySite) {
        const originalRaw = JSON.stringify(mem.plansBySite);
        const normalizedRaw = JSON.stringify(normalizedPlans);
        if (originalRaw !== normalizedRaw) {
          console.warn("[planning-v2][multi-site][memory][normalize]", {
            siteId: String(siteId),
            weekIso,
            activeIdx,
            beforeAltCounts: linkedPlansAltCounts(mem.plansBySite),
            afterAltCounts: linkedPlansAltCounts(normalizedPlans),
            source: "refreshFromMemory",
          });
          saveLinkedPlansToMemory(weekStart, normalizedPlans, activeIdx);
        }
      }
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
      seenLinkedAlternativeSnapshotsRef.current = new Set();
      bestGeneratedHoleScoreRef.current = null;
      appendUniqueCountRef.current = 0;
      lastAlternativeSnapshotRef.current = "";
      setDraftAssignments(null);
      setDraftPulls(null);
      setDraftAlternatives([]);
    } else {
      setReplaceGenerationUiClear(false);
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
      const existingAlternatives = normalizeDraftAlternatives(
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
      appendExistingAlternativesCount = existingAlternatives.length;
      if (normalizedLinkedPlans && Object.keys(normalizedLinkedPlans).length > 0) {
        const appendMemoryBefore = readLinkedPlansFromMemory(weekStart);
        const activeIdx = Math.max(0, Number(appendMemoryBefore?.activeAltIndex || 0));
        console.warn("[planning-v2][multi-site][append][start]", {
          siteId: String(siteId),
          weekIso,
          activeIdx,
          localAssignmentVariants: assignmentVariants.length,
          appendExistingAlternativesCount,
          memoryAltCountsBefore: linkedPlansAltCounts(appendMemoryBefore?.plansBySite),
          memoryAltCountsAfterNormalize: linkedPlansAltCounts(normalizedLinkedPlans),
          currentSiteAltCount: Array.isArray(currentLinkedPlan?.alternatives) ? currentLinkedPlan.alternatives.length : 0,
        });
        saveLinkedPlansToMemory(weekStart, normalizedLinkedPlans, activeIdx);
      }
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

    const pruneDraftAlternativesByBestHoles = (bestScore: HoleScore) => {
      const before = draftAlternativesRef.current.length;
      draftAlternativesRef.current = normalizeDraftAlternatives(draftAlternativesRef.current || []).filter((alt) => {
        const score = singlePlanHoleScore(site, alt.assignments, alt.pulls);
        return score.holes < bestScore.holes || (score.holes === bestScore.holes && score.pulls <= bestScore.pulls);
      });
      if (draftAlternativesRef.current.length !== before) {
        console.warn("[planning-v2][holes][prune-worse-alternatives]", {
          siteId: String(siteId),
          weekIso,
          bestHoles: bestScore.holes,
          bestPulls: bestScore.pulls,
          before,
          after: draftAlternativesRef.current.length,
        });
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
      const baseLog = {
        siteId: String(siteId),
        weekIso,
        itemType,
        mode: appendMode ? "append" : "replace",
        eventIndex: eventIndex ?? null,
        generationId: generationId ?? null,
        requestedPulls: requestedPullsCount,
        holes: score.holes,
        pulls: score.pulls,
        assigned: score.assigned,
        required: score.required,
        bestHoles: best?.holes ?? null,
        bestPulls: best?.pulls ?? null,
        bestAssigned: best?.assigned ?? null,
      };
      if (
        !best ||
        score.holes < best.holes ||
        (score.holes === best.holes && score.pulls < best.pulls) ||
        (score.holes === best.holes && score.pulls === best.pulls && score.assigned > best.assigned)
      ) {
        bestGeneratedHoleScoreRef.current = score;
        console.warn("[planning-v2][holes][candidate-best-so-far]", baseLog);
        pruneDraftAlternativesByBestHoles(score);
        return false;
      }
      if (score.holes > best.holes || (score.holes === best.holes && score.pulls > best.pulls)) {
        console.warn("[planning-v2][holes][reject-worse-candidate]", baseLog);
        return true;
      }
      console.warn("[planning-v2][holes][candidate-same-best-holes]", baseLog);
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
                  if (appendMode) {
                    setMoreAlternativesAvailable(true);
                  }
                }
                scheduleAlternativesFlush();
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
            if (appendMode) {
              setMoreAlternativesAvailable(true);
            }
            scheduleAlternativesFlush();
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
                  if (appendMode) {
                    setMoreAlternativesAvailable(true);
                  }
                }
                scheduleAlternativesFlush();
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
      if (sawPlanToPersist) {
        writeAlternativesUnlockedToSession(weekIso, siteId);
        setAlternativesUnlockNonce((n) => n + 1);
        try {
          await persistGeneratedAutoDraftToServer();
          await reloadWeekPlan({ silent: true, preferredScope: "auto" });
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
      }
      setGenerationRunning(false);
      setReplaceGenerationUiClear(false);
      if (linkedSitesLength > 1) {
        writeLinkedGenerationRunningToSession(weekIso, false);
      }
      genBusyRef.current = false;
      abortRef.current = null;
      generationIdRef.current = null;
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
    site,
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
    resetManualStation,
    getLatestAssignmentBase,
    commitDraftAssignments,
    commitDraftPulls,
  };
}

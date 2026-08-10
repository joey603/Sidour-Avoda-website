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
  persistWeekPlanToApi,
} from "../lib/week-plan-persist";
import { getWeekKeyISO } from "../lib/week";
import {
  clearLinkedPlansFromMemory,
  readLinkedPlansFromMemory,
  readMultiSiteNavigationInApp,
  saveLinkedPlansToMemory,
} from "../lib/multi-site-linked-memory";
import {
  readAlternativesUnlockedFromSession,
  readLinkedGenerationStopVisibleCountFromSession,
} from "../lib/planning-v2-generation-session";
import { type DraftAlternative, draftAlternativesForMode } from "../lib/planning-v2-draft-alternatives";
import { usePlanningV2Generation } from "./use-planning-v2-generation";

const AUTO_PULLS_LIMIT_BY_WEEK_KEY_PREFIX = "planning_v2_auto_pulls_limit_week_";

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
  const [isManual, setIsManual] = useState(false);
  const draftAssignmentsRef = useRef<Record<string, Record<string, string[][]>> | null>(null);
  const draftPullsRef = useRef<PlanningV2PullsMap>({});
  const draftAlternativesRef = useRef<DraftAlternative[]>([]);
  /** Index choisi manuellement pendant le streaming — ne pas le faire écraser par la mémoire. */
  const userPickedAltIndexRef = useRef<number | null>(null);
  const weekPlanAssignmentsRef = useRef<Record<string, Record<string, string[][]>> | undefined>(undefined);
  const assignmentVariantsRef = useRef<Array<Record<string, Record<string, string[][]>>>>([]);
  const pullVariantsRef = useRef<PlanningV2PullsMap[]>([]);

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
    setMoreAlternativesAvailable(true);
    planLoadedForManualRef.current = false;
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

  // Multi-sites: כשעוברים בין אתרים, לשמור אלטרנטיבה פעילה זהה לכל האתרים דרך sessionStorage.
  useEffect(() => {
    const mem = readLinkedPlansFromMemory(weekStart);
    if (linkedSitesLength <= 1 && !mem?.plansBySite?.[String(siteId)]) return;
    let lastAppliedSnap = "";
    const refreshFromMemory = () => {
      // Pendant יצירת תכנון (SSE), le flux met déjà à jour l’état React — ne pas réappliquer
      // la mémoire ici : sinon `linked-plans-memory-updated` (microtâche) rivalise avec
      // `setDraftAlternatives` et peut provoquer « Maximum update depth exceeded ».
      // Aussi: sur les sites liés (genBusyRef false), éviter d’écraser la navigation חלופות.
      if (genBusyRef.current || generationRunningRef.current) return;
      if (protectOfficialSavedPlan) {
        setSelectedAlternativeIndex(0);
        return;
      }
      const mem = readLinkedPlansFromMemory(weekStart);
      const plansBySite =
        mem?.plansBySite && typeof mem.plansBySite === "object" ? mem.plansBySite : {};
      const plan = plansBySite[String(siteId)];
      if (!plan) return;
      const activeIdx = Math.max(0, Number(mem?.activeAltIndex || 0));
      const stopLimit =
        stopVisibleAlternativeCountRef.current ??
        (linkedSitesLength > 1 ? readLinkedGenerationStopVisibleCountFromSession(weekIso) : null);
      const maxVisibleIndex = stopLimit == null ? null : Math.max(0, stopLimit - 1);
      const appliedActiveIdx = maxVisibleIndex == null ? activeIdx : Math.min(activeIdx, maxVisibleIndex);
      const snap = JSON.stringify({ activeIdx: appliedActiveIdx, plan, stopLimit });
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
      const visibleMemoryAlternatives =
        stopLimit == null ? memoryAlternatives : memoryAlternatives.slice(0, Math.max(0, stopLimit - 1));
      const memoryAlternativeCount =
        (memoryHasBase ? 1 : 0) +
        visibleMemoryAlternatives.filter((asg) =>
          assignmentsNonEmpty((asg as Record<string, Record<string, string[][]>> | null | undefined) ?? null)).length;
      const shouldHydrateFromMemory =
        !hasAuthoritativeLocalPlan ||
        memoryAlternativeCount > localAlternativeCount ||
        appliedActiveIdx >= Math.max(1, localAlternativeCount) ||
        // Index partagé hors portée locale (retour A←B) : forcer la mémoire.
        (linkedSitesLength > 1 && appliedActiveIdx > 0 && appliedActiveIdx >= localAlternativeCount);
      // En multi-site, la mémoire session sert à partager l’index d’alternative et les autres sites.
      // Si la mémoire est plus riche (plus d’alternatives, ou index actif hors portée locale),
      // il faut quand même la réhydrater pour préserver exactement la même חלופה après navigation.
      if (shouldHydrateFromMemory) {
        const baseAssignments = plan.assignments as Record<string, Record<string, string[][]>> | undefined;
        if (baseAssignments && typeof baseAssignments === "object") {
          setDraftAssignments(baseAssignments);
        }
        setDraftPulls((plan.pulls as PlanningV2PullsMap) || {});
        const altsAssignmentsRaw = Array.isArray(plan.alternatives) ? plan.alternatives : [];
        const altsPullsRaw = Array.isArray(plan.alternative_pulls) ? plan.alternative_pulls : [];
        const maxAltCount = stopLimit == null ? altsAssignmentsRaw.length : Math.max(0, stopLimit - 1);
        const altsAssignments = altsAssignmentsRaw.slice(0, maxAltCount);
        const altsPulls = altsPullsRaw.slice(0, maxAltCount);
        const alts = altsAssignments.flatMap((asg, idx) => {
          if (!asg || typeof asg !== "object") return [];
          return [{
            assignments: asg as Record<string, Record<string, string[][]>>,
            pulls: ((altsPulls[idx] || {}) as PlanningV2PullsMap),
          }];
        });
        setDraftAlternatives(alts);
      }
      setSelectedAlternativeIndex(appliedActiveIdx);
    };
    refreshFromMemory();
    const onMem = () => refreshFromMemory();
    window.addEventListener("linked-plans-memory-updated", onMem as EventListener);
    return () => window.removeEventListener("linked-plans-memory-updated", onMem as EventListener);
  }, [
    dedupeAlternatives,
    generationRunning,
    linkedSitesLength,
    protectOfficialSavedPlan,
    siteId,
    weekIso,
    weekPlan?.alternatives,
    weekStart,
  ]);

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
      const stopLimit =
        stopVisibleAlternativeCountRef.current ??
        (linkedSitesLength > 1 ? readLinkedGenerationStopVisibleCountFromSession(weekIso) : null);
      const visibleAlternatives = stopLimit == null ? normalized : normalized.slice(0, Math.max(0, stopLimit - 1));
      return [draftAssignments, ...visibleAlternatives.map((x) => x.assignments)];
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
    const stopLimit =
      stopVisibleAlternativeCountRef.current ??
      (linkedSitesLength > 1 ? readLinkedGenerationStopVisibleCountFromSession(weekIso) : null);
    const visibleAlternatives = stopLimit == null ? alts : alts.slice(0, Math.max(0, stopLimit - 1));
    return [...base, ...visibleAlternatives.map((x) => x.assignments)];
  }, [
    dedupeAlternatives,
    draftAssignments,
    draftAlternatives,
    generationRunning,
    linkedSitesLength,
    replaceGenerationUiClear,
    weekIso,
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
      // draftPulls null = aucune édition explicite des pulls dans ce brouillon.
      // On tombe sur weekPlan.pulls pour que les pulls du plan sauvegardé restent visibles
      // après un drag-drop manuel qui appelle commitDraftAssignments sans toucher draftPulls.
      const savedPulls = weekPlan?.pulls && typeof weekPlan.pulls === "object"
        ? (weekPlan.pulls as PlanningV2PullsMap)
        : {};
      const basePulls = draftPulls !== null ? draftPulls : savedPulls;
      const normalized = draftAlternativesForMode(draftAlternatives, dedupeAlternatives);
      const stopLimit =
        stopVisibleAlternativeCountRef.current ??
        (linkedSitesLength > 1 ? readLinkedGenerationStopVisibleCountFromSession(weekIso) : null);
      const visibleAlternatives = stopLimit == null ? normalized : normalized.slice(0, Math.max(0, stopLimit - 1));
      return [basePulls, ...visibleAlternatives.map((x) => x.pulls || {})];
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
    const stopLimit =
      stopVisibleAlternativeCountRef.current ??
      (linkedSitesLength > 1 ? readLinkedGenerationStopVisibleCountFromSession(weekIso) : null);
    const visibleAlternatives = stopLimit == null ? normalized : normalized.slice(0, Math.max(0, stopLimit - 1));
    return [basePulls, ...visibleAlternatives.map((x) => x.pulls || {})];
  }, [
    dedupeAlternatives,
    draftAssignments,
    draftPulls,
    draftAlternatives,
    generationRunning,
    linkedSitesLength,
    replaceGenerationUiClear,
    weekIso,
    weekPlan?.alternatives,
    weekPlan?.pulls,
    weekPlan?.alternativePulls,
  ]);

  assignmentVariantsRef.current = assignmentVariants;
  pullVariantsRef.current = pullVariants;

  const alternativeCount = useMemo(() => {
    if (replaceGenerationUiClear && generationRunning && !draftAssignments) return 0;
    const localCount = assignmentVariants.length;
    if (linkedSitesLength <= 1) return localCount;
    // Pendant la réhydratation multi-sites, garder le total mémoire pour que
    // « 12/30 » ne redevienne pas « 1/1 » puis « 1/30 » au retour sur un site.
    const mem = readLinkedPlansFromMemory(weekStart);
    const sitePlan = mem?.plansBySite?.[String(siteId)];
    if (!sitePlan) return localCount;
    const stopLimit =
      stopVisibleAlternativeCountRef.current ??
      readLinkedGenerationStopVisibleCountFromSession(weekIso);
    const hasBase = assignmentsNonEmpty(
      (sitePlan.assignments as Record<string, Record<string, string[][]>> | null | undefined) ?? null,
    );
    const memAlts = Array.isArray(sitePlan.alternatives) ? sitePlan.alternatives : [];
    const visibleMemAlts =
      stopLimit == null ? memAlts : memAlts.slice(0, Math.max(0, stopLimit - 1));
    const memoryCount =
      (hasBase ? 1 : 0) +
      visibleMemAlts.filter((asg) =>
        assignmentsNonEmpty((asg as Record<string, Record<string, string[][]>> | null | undefined) ?? null),
      ).length;
    return Math.max(localCount, memoryCount);
  }, [
    replaceGenerationUiClear,
    generationRunning,
    draftAssignments,
    assignmentVariants.length,
    linkedSitesLength,
    siteId,
    weekIso,
    weekStart,
  ]);

  /** Débloqué seulement après יצירת תכנון dans cet onglet (session), ou pendant la génération SSE. */
  const alternativesUnlocked = useMemo(() => {
    void alternativesUnlockNonce;
    if (generationRunning) return true;
    if (clientStorageReady && readAlternativesUnlockedFromSession(weekIso, siteId)) return true;
    if (weekPlan?.sourceScope === "auto") {
      const hasWeekPlanBase = assignmentsNonEmpty(weekPlan.assignments ?? null);
      const hasWeekPlanAlt = Array.isArray(weekPlan.alternatives)
        && weekPlan.alternatives.some((alt) =>
          assignmentsNonEmpty((alt as Record<string, Record<string, string[][]>> | null | undefined) ?? null));
      if (hasWeekPlanBase || hasWeekPlanAlt) return true;
    }
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
  }, [
    clientStorageReady,
    weekIso,
    siteId,
    generationRunning,
    alternativesUnlockNonce,
    weekPlan?.sourceScope,
    weekPlan?.assignments,
    weekPlan?.alternatives,
    linkedSitesLength,
    weekStart,
  ]);

  /**
   * Index « affiché » dans les variantes déjà chargées.
   * En multi-site, on conserve l’index demandé (mémoire / navigation) même si les variantes
   * ne sont pas encore réhydratées — sinon l’UI et la sync mémoire retombent sur חלופה 1.
   */
  const safeAlternativeIndex = useMemo(() => {
    const requested = Math.max(0, selectedAlternativeIndex);
    const len = assignmentVariants.length;
    if (len <= 0) return requested;
    if (requested < len) return requested;
    if (linkedSitesLength > 1) {
      if (readMultiSiteNavigationInApp()) return requested;
      const memIdx = Math.max(0, Number(readLinkedPlansFromMemory(weekStart)?.activeAltIndex || 0));
      if (memIdx === requested || (userPickedAltIndexRef.current != null && userPickedAltIndexRef.current === requested)) {
        return requested;
      }
    }
    return Math.max(0, len - 1);
  }, [assignmentVariants.length, linkedSitesLength, selectedAlternativeIndex, weekStart]);

  /** Index réellement adressable dans assignmentVariants (pour la grille). */
  const displayAlternativeIndex = useMemo(() => {
    const len = assignmentVariants.length;
    if (len <= 0) return 0;
    return Math.min(Math.max(0, selectedAlternativeIndex), len - 1);
  }, [assignmentVariants.length, selectedAlternativeIndex]);

  useEffect(() => {
    // Pendant la génération SSE, `alternativeCount` bouge à chaque événement — ne pas resynchroniser
    // l’index ici (sinon boucle avec les effets du résumé / filtres qui appellent aussi setSelected).
    if (generationRunning) return;
    if (safeAlternativeIndex === selectedAlternativeIndex) return;
    // Multi-site: si l’index mémoire (ex. חלופה 19) dépasse encore assignmentVariants
    // (plan pas entièrement réhydraté), ne pas écraser vers 0 — sinon la navigation
    // « פתח אתר » se fige sur חלופה 1.
    if (selectedAlternativeIndex > displayAlternativeIndex) {
      if (readMultiSiteNavigationInApp()) return;
      if (linkedSitesLength > 1) {
        const memIdx = Math.max(0, Number(readLinkedPlansFromMemory(weekStart)?.activeAltIndex || 0));
        if (memIdx === selectedAlternativeIndex) return;
        if (userPickedAltIndexRef.current != null && userPickedAltIndexRef.current === selectedAlternativeIndex) {
          return;
        }
      }
    }
    setSelectedAlternativeIndex(safeAlternativeIndex);
  }, [
    displayAlternativeIndex,
    generationRunning,
    linkedSitesLength,
    safeAlternativeIndex,
    selectedAlternativeIndex,
    weekStart,
  ]);

  const displayAssignments = useMemo(() => {
    if (assignmentVariants.length === 0) return null;
    return assignmentVariants[displayAlternativeIndex] || assignmentVariants[0] || null;
  }, [assignmentVariants, displayAlternativeIndex]);

  const displayPulls = useMemo((): PlanningV2PullsMap | null | undefined => {
    if (pullVariants.length === 0) return undefined;
    return pullVariants[displayAlternativeIndex] || pullVariants[0] || {};
  }, [pullVariants, displayAlternativeIndex]);

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

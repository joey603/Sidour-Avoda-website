"use client";

import { useEffect, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { PlanningV2PullsMap, SiteSummary } from "../types";
import { assignmentsNonEmpty } from "../lib/assignments-empty";
import { buildEmptyAssignmentsForSite } from "../lib/station-grid-helpers";
import {
  readAlternativesUnlockedFromSession,
  readLinkedGenerationStopVisibleCountFromSession,
} from "../lib/planning-v2-generation-session";
import { type DraftAlternative, draftAlternativesForMode } from "../lib/planning-v2-draft-alternatives";
import {
  readLinkedPlansFromMemory,
  readMultiSiteNavigationInApp,
} from "../lib/multi-site-linked-memory";
import type { V2WeekPlanData } from "./use-planning-v2-week-plan";

type AssignmentGrid = Record<string, Record<string, string[][]>>;

type DisplayVariantsGenerationSlice = {
  generationRunning: boolean;
  replaceGenerationUiClear: boolean;
  stopVisibleAlternativeCountRef: MutableRefObject<number | null>;
  generationRunningRef: MutableRefObject<boolean>;
  genBusyRef: MutableRefObject<boolean>;
};

type UsePlanningV2DisplayVariantsArgs = {
  draftAssignments: AssignmentGrid | null;
  draftPulls: PlanningV2PullsMap | null;
  draftAlternatives: DraftAlternative[];
  setDraftAssignments: Dispatch<SetStateAction<AssignmentGrid | null>>;
  setDraftPulls: Dispatch<SetStateAction<PlanningV2PullsMap | null>>;
  setDraftAlternatives: Dispatch<SetStateAction<DraftAlternative[]>>;
  draftAssignmentsRef: MutableRefObject<AssignmentGrid | null>;
  draftAlternativesRef: MutableRefObject<DraftAlternative[]>;
  weekPlan: V2WeekPlanData;
  site: SiteSummary | null;
  siteId: string;
  weekStart: Date;
  weekIso: string;
  linkedSitesLength: number;
  protectOfficialSavedPlan: boolean;
  dedupeAlternatives: boolean;
  generation: DisplayVariantsGenerationSlice;
  selectedAlternativeIndex: number;
  setSelectedAlternativeIndex: Dispatch<SetStateAction<number>>;
  userPickedAltIndexRef: MutableRefObject<number | null>;
  weekPlanAssignmentsRef: MutableRefObject<AssignmentGrid | undefined>;
  clientStorageReady: boolean;
  alternativesUnlockNonce: number;
  assignmentVariantsRef: MutableRefObject<AssignmentGrid[]>;
  pullVariantsRef: MutableRefObject<PlanningV2PullsMap[]>;
};

export function usePlanningV2DisplayVariants({
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
  generation,
  selectedAlternativeIndex,
  setSelectedAlternativeIndex,
  userPickedAltIndexRef,
  weekPlanAssignmentsRef,
  clientStorageReady,
  alternativesUnlockNonce,
  assignmentVariantsRef,
  pullVariantsRef,
}: UsePlanningV2DisplayVariantsArgs) {
  const {
    generationRunning,
    replaceGenerationUiClear,
    stopVisibleAlternativeCountRef,
    generationRunningRef,
    genBusyRef,
  } = generation;

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
        (plan.assignments as AssignmentGrid | null | undefined) ?? null,
      );
      const memoryAlternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
      const visibleMemoryAlternatives =
        stopLimit == null ? memoryAlternatives : memoryAlternatives.slice(0, Math.max(0, stopLimit - 1));
      const memoryAlternativeCount =
        (memoryHasBase ? 1 : 0) +
        visibleMemoryAlternatives.filter((asg) =>
          assignmentsNonEmpty((asg as AssignmentGrid | null | undefined) ?? null)).length;
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
        const baseAssignments = plan.assignments as AssignmentGrid | undefined;
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
            assignments: asg as AssignmentGrid,
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
    draftAssignmentsRef,
    draftAlternativesRef,
    genBusyRef,
    generationRunningRef,
    setDraftAssignments,
    setDraftAlternatives,
    setDraftPulls,
    setSelectedAlternativeIndex,
    stopVisibleAlternativeCountRef,
    weekPlanAssignmentsRef,
  ]);

  const assignmentVariants = useMemo<AssignmentGrid[]>(() => {
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
    stopVisibleAlternativeCountRef,
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
    stopVisibleAlternativeCountRef,
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
      (sitePlan.assignments as AssignmentGrid | null | undefined) ?? null,
    );
    const memAlts = Array.isArray(sitePlan.alternatives) ? sitePlan.alternatives : [];
    const visibleMemAlts =
      stopLimit == null ? memAlts : memAlts.slice(0, Math.max(0, stopLimit - 1));
    const memoryCount =
      (hasBase ? 1 : 0) +
      visibleMemAlts.filter((asg) =>
        assignmentsNonEmpty((asg as AssignmentGrid | null | undefined) ?? null),
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
    stopVisibleAlternativeCountRef,
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
          assignmentsNonEmpty((alt as AssignmentGrid | null | undefined) ?? null));
      if (hasWeekPlanBase || hasWeekPlanAlt) return true;
    }
    if (clientStorageReady && linkedSitesLength > 1) {
      const mem = readLinkedPlansFromMemory(weekStart);
      const currentPlan = mem?.plansBySite?.[String(siteId)];
      if (currentPlan) {
        const hasBase = assignmentsNonEmpty(
          (currentPlan.assignments as AssignmentGrid | null | undefined) ?? null,
        );
        const hasAlt = Array.isArray(currentPlan.alternatives)
          && currentPlan.alternatives.some((alt) =>
            assignmentsNonEmpty((alt as AssignmentGrid | null | undefined) ?? null));
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
  }, [assignmentVariants.length, linkedSitesLength, selectedAlternativeIndex, userPickedAltIndexRef, weekStart]);

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
    setSelectedAlternativeIndex,
    userPickedAltIndexRef,
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

  return {
    assignmentVariants,
    pullVariants,
    alternativeCount,
    alternativesUnlocked,
    safeAlternativeIndex,
    displayAlternativeIndex,
    displayAssignments,
    displayPulls,
    assignmentVariantsRef,
    pullVariantsRef,
  };
}

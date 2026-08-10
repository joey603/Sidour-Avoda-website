"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { assignmentsNonEmpty } from "../lib/assignments-empty";
import {
  readLinkedPlansFromMemory,
  readMultiSiteNavigationInApp,
  resolveAssignmentsForAlternative,
  type LinkedSitePlan,
} from "../lib/multi-site-linked-memory";
import type { LinkedSiteRow } from "./use-planning-v2-linked-sites";

type SummaryFilterState = {
  indices: number[];
  hasActiveFilters: boolean;
};

type PlanningV2AlternativesBarSnapshot = {
  alternativeCount: number;
  selectedAlternativeIndex: number;
  selectedAlternativeDisplayIndex: number;
  alternativesFiltered: boolean;
  alternativesTotalCount: number;
};

type AlternativesUiPlanSlice = {
  alternativesUnlocked: boolean;
  isManual: boolean;
  alternativeCount: number;
  displayAssignments: Record<string, Record<string, string[][]>> | null | undefined;
  selectedAlternativeIndex: number;
  setSelectedAlternativeIndex: (idx: number) => void;
  generationRunning: boolean;
};

type UsePlanningV2AlternativesUiArgs = {
  siteId: string;
  weekStart: Date;
  linkedSites: LinkedSiteRow[];
  protectOfficialSavedPlan: boolean;
  multiSiteNavigationLoading: boolean;
  linkedPlansMemoryTick: number;
  visibleAlternativeCountRef: MutableRefObject<number>;
  plan: AlternativesUiPlanSlice;
};

export function usePlanningV2AlternativesUi({
  siteId,
  weekStart,
  linkedSites,
  protectOfficialSavedPlan,
  multiSiteNavigationLoading,
  linkedPlansMemoryTick,
  visibleAlternativeCountRef,
  plan,
}: UsePlanningV2AlternativesUiArgs) {
  const [summaryFilterState, setSummaryFilterState] = useState<SummaryFilterState>({
    indices: [],
    hasActiveFilters: false,
  });

  /** חלופות : piloté par l’état des variantes, pas par le contenu affiché momentanément dans la grille. */
  const alternativesUiEnabled = useMemo(
    () => plan.alternativesUnlocked && !plan.isManual && plan.alternativeCount >= 1,
    [plan.alternativesUnlocked, plan.isManual, plan.alternativeCount],
  );

  /** Masquer חלופות si la grille du site courant est vide, sauf multi-site avec un autre site non vide. */
  const currentGridNonEmpty = useMemo(
    () => assignmentsNonEmpty(plan.displayAssignments),
    [plan.displayAssignments],
  );
  const otherLinkedSiteGridNonEmpty = useMemo(() => {
    if (linkedSites.length <= 1 || protectOfficialSavedPlan) return false;
    const mem = readLinkedPlansFromMemory(weekStart);
    const plansBySite = mem?.plansBySite;
    if (!plansBySite || typeof plansBySite !== "object") return false;
    const currentKey = String(siteId);
    const altIdx = plan.selectedAlternativeIndex;
    for (const ls of linkedSites) {
      const key = String(ls.id);
      if (key === currentKey) continue;
      const sitePlan = plansBySite[key] as LinkedSitePlan | undefined;
      if (!sitePlan) continue;
      const asg = resolveAssignmentsForAlternative(sitePlan, altIdx);
      if (assignmentsNonEmpty(asg)) return true;
    }
    return false;
  }, [
    linkedSites,
    siteId,
    weekStart,
    protectOfficialSavedPlan,
    linkedPlansMemoryTick,
    plan.selectedAlternativeIndex,
  ]);

  const alternativesGridVisible = currentGridNonEmpty || otherLinkedSiteGridNonEmpty;
  const alternativesUiVisible = alternativesUiEnabled && alternativesGridVisible;

  const visibleAlternativeIndices = useMemo(() => {
    if (!alternativesUiEnabled) {
      return [0];
    }
    if (!summaryFilterState.hasActiveFilters) {
      return Array.from({ length: Math.max(0, plan.alternativeCount) }, (_, i) => i);
    }
    return summaryFilterState.indices;
  }, [summaryFilterState, plan.alternativeCount, alternativesUiEnabled]);

  useEffect(() => {
    visibleAlternativeCountRef.current = alternativesUiEnabled ? visibleAlternativeIndices.length : 0;
  }, [alternativesUiEnabled, visibleAlternativeIndices.length, visibleAlternativeCountRef]);

  const selectedVisibleAlternativeIndex = useMemo(() => {
    return visibleAlternativeIndices.indexOf(plan.selectedAlternativeIndex);
  }, [visibleAlternativeIndices, plan.selectedAlternativeIndex]);

  /** Alternative réellement affichée après filtres (fallback robuste si l’index courant sort du sous-ensemble). */
  const effectiveAlternativeIndex = useMemo(() => {
    if (visibleAlternativeIndices.length <= 0) {
      return Math.max(0, plan.selectedAlternativeIndex);
    }
    if (visibleAlternativeIndices.includes(plan.selectedAlternativeIndex)) {
      return plan.selectedAlternativeIndex;
    }
    return visibleAlternativeIndices[0] ?? 0;
  }, [visibleAlternativeIndices, plan.selectedAlternativeIndex]);

  /** Dernière barre חלופות valide — utilisée pendant יצירה מאפס jusqu’au premier plan SSE. */
  const lastAlternativesBarRef = useRef<PlanningV2AlternativesBarSnapshot | null>(null);

  useLayoutEffect(() => {
    if (!alternativesUiEnabled) return;
    lastAlternativesBarRef.current = {
      alternativeCount: visibleAlternativeIndices.length,
      selectedAlternativeIndex: Math.max(0, selectedVisibleAlternativeIndex),
      selectedAlternativeDisplayIndex: effectiveAlternativeIndex,
      alternativesFiltered: summaryFilterState.hasActiveFilters,
      alternativesTotalCount: plan.alternativeCount,
    };
  }, [
    alternativesUiEnabled,
    visibleAlternativeIndices.length,
    selectedVisibleAlternativeIndex,
    effectiveAlternativeIndex,
    summaryFilterState.hasActiveFilters,
    plan.alternativeCount,
  ]);

  // Dérivé (pas de setState) : évite « Maximum update depth exceeded » sur la barre חלופות.
  const alternativesBarHold = useMemo((): PlanningV2AlternativesBarSnapshot | null => {
    if (!plan.generationRunning) return null;
    if (alternativesUiEnabled) return null;
    // Génération « replace » : alternativeCount à 0 tout de suite — ne pas figer l’ancien total.
    if (plan.alternativeCount <= 0) return null;
    const snap = lastAlternativesBarRef.current;
    if (!snap || snap.alternativeCount < 1) return null;
    return snap;
  }, [plan.generationRunning, plan.alternativeCount, alternativesUiEnabled]);

  const actionBarAlternativesFrozen =
    plan.generationRunning && !alternativesUiEnabled && alternativesBarHold !== null;
  const actionBarAltSnap = actionBarAlternativesFrozen ? alternativesBarHold : null;
  const actionBarAlternativesResetPending =
    plan.generationRunning && !actionBarAltSnap && plan.alternativeCount === 0;
  // Geler la nav seulement pendant le reset initial (avant le 1er plan SSE).
  // Dès que des חלופות streamées existent, prev/next restent interactifs.
  const actionBarAlternativesNavFrozen = actionBarAlternativesFrozen || actionBarAlternativesResetPending;

  useEffect(() => {
    if (plan.generationRunning) return;
    if (multiSiteNavigationLoading) return;
    if (readMultiSiteNavigationInApp()) return;
    if (!summaryFilterState.hasActiveFilters) return;
    if (effectiveAlternativeIndex === plan.selectedAlternativeIndex) return;
    plan.setSelectedAlternativeIndex(effectiveAlternativeIndex);
  }, [
    effectiveAlternativeIndex,
    multiSiteNavigationLoading,
    plan.generationRunning,
    plan.selectedAlternativeIndex,
    plan.setSelectedAlternativeIndex,
    summaryFilterState.hasActiveFilters,
  ]);

  useEffect(() => {
    // En multi-site, `alternativesUiEnabled` peut passer brièvement à false pendant une
    // resynchronisation mémoire / affichage. Ne pas forcer un retour à l'alternative 0
    // sur cet état transitoire, sinon la navigation "saute" au début.
    if (readMultiSiteNavigationInApp()) return;
    if (linkedSites.length > 1) return;
    if (alternativesUiEnabled) return;
    if (plan.selectedAlternativeIndex === 0) return;
    plan.setSelectedAlternativeIndex(0);
  }, [alternativesUiEnabled, linkedSites.length, plan.selectedAlternativeIndex, plan.setSelectedAlternativeIndex]);

  return {
    summaryFilterState,
    setSummaryFilterState,
    alternativesUiEnabled,
    currentGridNonEmpty,
    otherLinkedSiteGridNonEmpty,
    alternativesGridVisible,
    alternativesUiVisible,
    visibleAlternativeIndices,
    selectedVisibleAlternativeIndex,
    effectiveAlternativeIndex,
    lastAlternativesBarRef,
    alternativesBarHold,
    actionBarAlternativesFrozen,
    actionBarAltSnap,
    actionBarAlternativesResetPending,
    actionBarAlternativesNavFrozen,
  };
}

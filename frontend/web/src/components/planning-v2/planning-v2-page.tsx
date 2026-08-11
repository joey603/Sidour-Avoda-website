"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { fetchMe } from "@/lib/auth";
import { LoadingOverlay } from "@/components/loading-animation";
import { ModalOverlay } from "@/components/ui/modal-scroll-lock";
import { PlanningV2Header } from "./planning-v2-header";
import { PlanningV2LayoutShell } from "./planning-v2-layout-shell";
import { PlanningV2MainPaper } from "./planning-v2-main-paper";
import { PlanningV2SitePaperHeader } from "./planning-v2-site-paper-header";
import { usePlanningV2SiteWorkers } from "./hooks/use-planning-v2-site-workers";
import { usePlanningV2WeekPlan } from "./hooks/use-planning-v2-week-plan";
import { PlanningV2OptionalMessages } from "./planning-v2-optional-messages";
import { PlanningV2SiteEvents } from "./planning-v2-site-events";
import { PlanningV2PlanExportButtons } from "./planning-v2-plan-export-buttons";
import {
  buildEventAvailabilityLocks,
  countEventAssignmentsPerWorkerName,
} from "./lib/event-availability-locks";
import type { SiteEvent } from "./types";
import { PlanningV2FullscreenVisualization } from "./planning-v2-fullscreen-visualization";
import { PlanningV2ActionBar } from "./planning-v2-action-bar";
import { PlanningV2WeekNavigation } from "./planning-v2-week-navigation";
import { PlanningWorkersSection } from "./workers/planning-workers-section";
import { usePlanningV2LinkedSites } from "./hooks/use-planning-v2-linked-sites";
import { usePlanningV2PlanController } from "./hooks/use-planning-v2-plan-controller";
import { assignmentsNonEmpty } from "./lib/assignments-empty";
import { buildDistinctWorkerColorMap } from "./lib/worker-name-chip-color";
import { PlanningV2ManualConfirmDialog } from "./planning-v2-manual-confirm-dialog";
import { PlanningV2LinkedSitesRail } from "./planning-v2-linked-sites-rail";
import { getWeekKeyISO } from "./lib/week";
import { normWorkerName } from "./lib/planning-v2-worker-name";
import { usePlanningV2FullscreenViz } from "./hooks/use-planning-v2-fullscreen-viz";
import { usePlanningV2SessionLifecycle } from "./hooks/use-planning-v2-session-lifecycle";
import { usePlanningV2SavedEditMode } from "./hooks/use-planning-v2-saved-edit-mode";
import { usePlanningV2ManualEditing } from "./hooks/use-planning-v2-manual-editing";
import { usePlanningV2PullsEditing } from "./hooks/use-planning-v2-pulls-editing";
import { usePlanningV2AlternativesUi } from "./hooks/use-planning-v2-alternatives-ui";
import { usePlanningV2LinkedMemory } from "./hooks/use-planning-v2-linked-memory";
import { usePlanningV2AvailabilityOverlays } from "./hooks/use-planning-v2-availability-overlays";
import { usePlanningV2NavigationBootstrap } from "./hooks/use-planning-v2-navigation-bootstrap";
import { PlanningV2VisualizationContent } from "./planning-v2-visualization-content";

function PlanningV2PageInner({ siteId }: { siteId: string }) {
  const {
    site,
    siteLoading,
    workers,
    workersLoading,
    reloadWorkers,
    reloadWeeklyAvailability,
    applyLocalWorkerSave,
    weekStart,
    workerRowsForTable,
  } = usePlanningV2SiteWorkers(siteId);

  const preferredWeekPlanScope = useMemo(
    () => site?.next_week_saved_plan_status?.scope ?? null,
    [site?.next_week_saved_plan_status?.scope],
  );
  const { navigationInApp, initialNavigationWeekPlan } = usePlanningV2NavigationBootstrap(siteId, weekStart);
  const { plan: weekPlan, loading: weekPlanLoading, reloadWeekPlan } = usePlanningV2WeekPlan(
    siteId,
    weekStart,
    preferredWeekPlanScope,
    {
      lightweightNav: navigationInApp,
      skipInitialReload: navigationInApp && !!initialNavigationWeekPlan,
      initialPlan: initialNavigationWeekPlan,
    },
  );
  const { linkedSites, linkedSitesLoading, reloadLinkedSites } = usePlanningV2LinkedSites(siteId, weekStart);
  const weekPurgeSiteIds = useMemo(() => {
    const s = new Set<number>();
    const cur = Number(siteId);
    if (Number.isFinite(cur) && cur > 0) s.add(cur);
    for (const ls of linkedSites) {
      const n = Number(ls.id);
      if (Number.isFinite(n) && n > 0) s.add(n);
    }
    return Array.from(s).sort((a, b) => a - b);
  }, [siteId, linkedSites]);
  const router = useRouter();
  usePlanningV2SessionLifecycle();
  const { visualizationOpen, setVisualizationOpen, fullscreenReveal } = usePlanningV2FullscreenViz();
  const {
    editingSaved,
    setEditingSaved,
    editingSavedGenerationStarted,
    setEditingSavedGenerationStarted,
    isSavedMode,
    weekPlanSaveBadgeConfig,
    showSavedPlanEditBadge,
  } = usePlanningV2SavedEditMode(weekPlan, weekStart);
  const [workerModalSaving, setWorkerModalSaving] = useState(false);
  const [pullsModeStationIdx, setPullsModeStationIdx] = useState<number | null>(null);
  const [shiftHoursModeStationIdx, setShiftHoursModeStationIdx] = useState<number | null>(null);
  const [availabilityOverlays, setAvailabilityOverlays] = useState<Record<string, Record<string, string[]>>>({});
  const [weekSiteEvents, setWeekSiteEvents] = useState<SiteEvent[]>([]);
  const visibleAlternativeCountRef = useRef(0);
  const getVisibleAlternativeCount = useCallback(() => visibleAlternativeCountRef.current, []);
  /** Clic sur une ligne du סיכום שיבוצים → surbrillance de l’עובד dans le גריד. */
  const [summaryHighlightWorkerName, setSummaryHighlightWorkerName] = useState<string | null>(null);

  const eventLocksByWorkerId = useMemo(
    () =>
      buildEventAvailabilityLocks({
        events: weekSiteEvents,
        weekStart,
        site,
      }),
    [weekSiteEvents, weekStart, site],
  );

  const eventAssignmentCountsByName = useMemo(
    () => countEventAssignmentsPerWorkerName(weekSiteEvents, weekStart, workers),
    [weekSiteEvents, weekStart, workers],
  );

  const plan = usePlanningV2PlanController({
    siteId,
    weekStart,
    weekPlan,
    site,
    weekPlanLoading,
    workers,
    workerRowsForTable,
    reloadWeekPlan,
    editingSaved,
    linkedSitesLength: linkedSites.length,
    weekPurgeSiteIds,
    getVisibleAlternativeCount,
    eventLocksByWorkerId,
  });

  const hasOfficialSavedWeekPlan =
    assignmentsNonEmpty(weekPlan?.assignments ?? null) &&
    (weekPlan?.sourceScope === "director" || weekPlan?.sourceScope === "shared");
  const protectOfficialSavedPlan = hasOfficialSavedWeekPlan && !editingSaved;

  /** Changement de semaine sans remount : reset outils locaux (édition saved → hook). */
  useEffect(() => {
    setPullsModeStationIdx(null);
    setShiftHoursModeStationIdx(null);
    setSummaryHighlightWorkerName(null);
    setWeekSiteEvents([]);
  }, [weekStart]);

  const hasMultiWorkersThisWeek = useMemo(
    () => workers.some((w) => Array.isArray(w.linkedSiteIds) && w.linkedSiteIds.length > 1),
    [workers],
  );
  const hasLinkedSitesRail = linkedSites.length > 1 && hasMultiWorkersThisWeek;

  // État partagé Alts ↔ LinkedMemory (évite dépendance circulaire entre hooks).
  const [multiSiteNavigationLoading, setMultiSiteNavigationLoading] = useState(() => navigationInApp);
  const [linkedPlansMemoryTick, setLinkedPlansMemoryTick] = useState(0);

  const {
    summaryFilterState,
    setSummaryFilterState,
    alternativesUiVisible,
    visibleAlternativeIndices,
    selectedVisibleAlternativeIndex,
    effectiveAlternativeIndex,
    actionBarAlternativesFrozen,
    actionBarAltSnap,
    actionBarAlternativesResetPending,
    actionBarAlternativesNavFrozen,
  } = usePlanningV2AlternativesUi({
    siteId,
    weekStart,
    linkedSites,
    protectOfficialSavedPlan,
    multiSiteNavigationLoading,
    linkedPlansMemoryTick,
    visibleAlternativeCountRef,
    plan,
  });

  const {
    showLinkedSitesRail,
    setShowLinkedSitesRail,
    navigateToLinkedSiteFromRail,
    navigationMemorySnapshot,
    linkedSitesRailData,
    linkedSiteRailBadges,
    linkedSiteHolesById,
  } = usePlanningV2LinkedMemory({
    siteId,
    weekStart,
    isoWeek: getWeekKeyISO(weekStart),
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
  });

  const siteIsArchived = Boolean(site?.deletedAt);

  // Multi-site: en mode manuel on autorise l'édition directe du plan affiché (même issu d'une génération auto),
  // les confirmations de contraintes restent gérées par analyzeManualSlotDrop dans handleManualSlotDrop.
  const manualEditable =
    !siteIsArchived && plan.isManual && (!isSavedMode || editingSaved || linkedSites.length > 1);

  const handleResetStation = (stationIdx: number) => {
    plan.resetManualStation(stationIdx);
  };

  const { availabilityByWorkerName, displayedAvailabilityOverlays } = usePlanningV2AvailabilityOverlays({
    workerRowsForTable,
    availabilityOverlays,
    setAvailabilityOverlays,
    eventLocksByWorkerId,
    workers,
    getLatestAssignmentBase: plan.getLatestAssignmentBase,
    displayAssignments: plan.displayAssignments,
  });

  const {
    manualConfirm,
    setManualConfirm,
    manualDragWorkerName,
    manualSelectSource,
    handleDraggingWorkerChange,
    handleWorkerSelectToggle,
    handleManualSlotDrop,
    handleManualSlotDragOutside,
  } = usePlanningV2ManualEditing({
    site,
    siteId,
    weekStart,
    workers,
    workerRowsForTable,
    availabilityByWorkerName,
    eventLocksByWorkerId,
    eventAssignmentCountsByName,
    manualEditable,
    plan,
    setAvailabilityOverlays,
    setPullsModeStationIdx,
    setShiftHoursModeStationIdx,
  });

  const {
    pullScopeDialog,
    setPullScopeDialog,
    handleUpsertPull,
    handleRemovePull,
    handleUpsertGuardDisplay,
    handleRemoveGuardDisplay,
  } = usePlanningV2PullsEditing({
    plan,
    site,
    linkedSitesLength: linkedSites.length,
    weekStart,
  });

  const assignmentHighlightBase = useMemo(() => plan.getLatestAssignmentBase(), [plan.displayAssignments, plan.getLatestAssignmentBase]);
  const workerColorMap = useMemo(() => {
    const bundles = [plan.displayAssignments, ...(plan.assignmentVariants || [])];
    return buildDistinctWorkerColorMap(workers, bundles);
  }, [workers, plan.displayAssignments, plan.assignmentVariants]);

  const savedHighlight = useMemo(
    () =>
      assignmentsNonEmpty(weekPlan?.assignments ?? null) &&
      !editingSaved &&
      (weekPlan?.sourceScope === "director" || weekPlan?.sourceScope === "shared"),
    [weekPlan?.assignments, weekPlan?.sourceScope, editingSaved],
  );

  const refreshWorkersAndGrid = () => {
    void reloadWorkers();
    void reloadWeeklyAvailability();
    void reloadWeekPlan();
    void reloadLinkedSites();
    try {
      window.dispatchEvent(new CustomEvent("auto-planning-worker-changes-updated"));
    } catch {
      /* ignore */
    }
  };

  const handleSavePlan = async (publishToWorkers: boolean) => {
    setPullsModeStationIdx(null);
    setShiftHoursModeStationIdx(null);
    // Arrêter le stream חלופות : après שמור le plan est verrouillé, stop/יוצר n’ont plus de sens.
    if (plan.generationRunning) {
      plan.stopGeneration();
    }
    await plan.savePlan(publishToWorkers);
    setEditingSaved(false);
  };
  const showPlanningLoadingOverlay =
    !workerModalSaving &&
    !plan.generationRunning &&
    // Ne pas bloquer sur siteLoading si le site est déjà connu (changement de semaine soft).
    ((siteLoading && !site) ||
      workersLoading ||
      (weekPlanLoading && !navigationMemorySnapshot.hasCurrentPlan) ||
      // Garder l’overlay jusqu’à la חלופה partagée (évite un flash sur חלופה 1).
      multiSiteNavigationLoading);

  const handleSummaryHighlightToggle = useCallback((name: string) => {
    setSummaryHighlightWorkerName((prev) => {
      const next = normWorkerName(prev || "") === normWorkerName(name) ? null : name;
      if (
        next !== null &&
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 1023px)").matches &&
        hasLinkedSitesRail
      ) {
        queueMicrotask(() => setShowLinkedSitesRail(false));
      }
      return next;
    });
  }, [hasLinkedSitesRail]);

  const handleTogglePullsModeStation = useCallback((idx: number) => {
    setShiftHoursModeStationIdx(null);
    setPullsModeStationIdx((prev) => (prev === idx ? null : idx));
  }, []);

  const handleToggleShiftHoursModeStation = useCallback((idx: number) => {
    setPullsModeStationIdx(null);
    setShiftHoursModeStationIdx((prev) => (prev === idx ? null : idx));
  }, []);

  const linkedSitesRail = (
    <PlanningV2LinkedSitesRail
      alternativesUiVisible={alternativesUiVisible}
      selectedVisibleAlternativeIndex={selectedVisibleAlternativeIndex}
      visibleAlternativeIndicesLength={visibleAlternativeIndices.length}
      linkedSitesRailData={linkedSitesRailData}
      linkedSiteRailBadges={linkedSiteRailBadges}
      linkedSiteHolesById={linkedSiteHolesById}
      workerColorMap={workerColorMap}
      onNavigateToSite={navigateToLinkedSiteFromRail}
    />
  );


  return (
    <div
      className="min-h-screen overflow-x-hidden px-3 py-6 pb-[calc(var(--planning-v2-action-bar-px,14rem)+2rem)] sm:px-4 lg:px-4 [&_button]:touch-manipulation [&_button]:select-none"
      dir="rtl"
    >
      <PlanningV2LayoutShell>
        <PlanningV2Header
          weekPlanSaveBadgeConfig={weekPlanSaveBadgeConfig}
          showEditBadge={showSavedPlanEditBadge}
        />
        {siteIsArchived ? (
          <div
            className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
            role="status"
          >
            <span className="font-medium">האתר נמחק מהרשימה הפעילה.</span> ניתן לצפות בתכנון ובהיסטוריה בלבד.{" "}
            <Link href="/director/sites" className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-50">
              חזרה לרשימת האתרים
            </Link>
          </div>
        ) : null}
        <div className="relative">
        <PlanningV2MainPaper editingSaved={editingSaved} savedHighlight={savedHighlight}>
          {hasLinkedSitesRail ? (
            <button
              type="button"
              onClick={() => {
                setShowLinkedSitesRail((v) => {
                  const next = !v;
                  if (next) {
                    queueMicrotask(() => setLinkedPlansMemoryTick((n) => n + 1));
                  }
                  return next;
                });
              }}
              className="fixed left-2 top-1/2 z-40 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-[#00A8E0] bg-white text-[#00A8E0] shadow-sm hover:bg-[#EAF8FF] dark:border-[#00A8E0] dark:bg-zinc-900 dark:text-[#00A8E0] dark:hover:bg-zinc-800 lg:hidden"
              aria-label={showLinkedSitesRail ? "הסתר תצוגת אתרים מקושרים" : "הצג תצוגת אתרים מקושרים"}
              title={showLinkedSitesRail ? "הסתר תצוגת אתרים מקושרים" : "הצג תצוגת אתרים מקושרים"}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                {showLinkedSitesRail ? (
                  <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                ) : (
                  <path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" />
                )}
              </svg>
            </button>
          ) : null}
          {hasLinkedSitesRail ? (
            <aside
              className={
                "fixed left-0 flex min-h-0 w-full max-w-full flex-col overflow-hidden rounded-r-2xl border-r border-zinc-200 bg-white px-3 pb-0 shadow-xl transition-transform duration-300 dark:border-zinc-800 dark:bg-zinc-950 lg:hidden " +
                (showLinkedSitesRail
                  ? "top-0 z-[35] h-[calc(100dvh-var(--planning-v2-action-bar-px))] pt-[max(0.75rem,env(safe-area-inset-top))] translate-x-0"
                  : "top-[var(--planning-v2-rail-top-px,4.5rem)] z-30 bottom-[var(--planning-v2-action-bar-px)] pt-3 -translate-x-[102%] pointer-events-none")
              }
            >
              {linkedSitesRail}
            </aside>
          ) : null}
          <PlanningV2SitePaperHeader
            siteId={siteId}
            site={site}
            siteLoading={siteLoading}
            readOnly={siteIsArchived}
          />
          <Suspense
            fallback={
              <div className="mb-4 h-10 w-full animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" aria-hidden />
            }
          >
            <PlanningV2WeekNavigation siteId={siteId} weekStart={weekStart} />
          </Suspense>
          <PlanningWorkersSection
            siteId={siteId}
            site={site}
            weekStart={weekStart}
            workers={workers}
            rows={workerRowsForTable}
            availabilityOverlays={availabilityOverlays}
            workersLoading={workersLoading}
            reloadWorkers={reloadWorkers}
            reloadWeeklyAvailability={reloadWeeklyAvailability}
            applyLocalWorkerSave={applyLocalWorkerSave}
            onWorkersChanged={refreshWorkersAndGrid}
            onWorkerModalSavingChange={setWorkerModalSaving}
            workersNameDraggable={manualEditable}
            onWorkerNameDragPreview={handleDraggingWorkerChange}
            selectedWorkerName={manualDragWorkerName}
            selectedWorkerFromGrid={!!manualSelectSource}
            onWorkerSelectToggle={manualEditable ? handleWorkerSelectToggle : undefined}
            readOnly={siteIsArchived}
            eventLocksByWorkerId={eventLocksByWorkerId}
          />
          {!visualizationOpen ? (
            <PlanningV2VisualizationContent
              site={site}
              siteId={siteId}
              weekStart={weekStart}
              workers={workers}
              assignments={plan.displayAssignments}
              assignmentVariants={plan.assignmentVariants}
              assignmentHighlightBase={assignmentHighlightBase}
              pulls={plan.displayPulls}
              draftFixedAssignmentsSnapshot={plan.draftFixedAssignmentsSnapshot}
              isSavedMode={isSavedMode}
              editingSaved={editingSaved}
              loading={weekPlanLoading}
              isManual={plan.isManual}
              manualEditable={manualEditable}
              pullsModeStationIdx={pullsModeStationIdx}
              shiftHoursModeStationIdx={shiftHoursModeStationIdx}
              draggingWorkerName={manualDragWorkerName}
              selectedWorkerSource={manualSelectSource}
              onDraggingWorkerChange={handleDraggingWorkerChange}
              onWorkerSelectToggle={handleWorkerSelectToggle}
              availabilityByWorkerName={availabilityByWorkerName}
              availabilityOverlays={displayedAvailabilityOverlays}
              onTogglePullsModeStation={handleTogglePullsModeStation}
              onToggleShiftHoursModeStation={handleToggleShiftHoursModeStation}
              onUpsertGuardDisplay={handleUpsertGuardDisplay}
              onRemoveGuardDisplay={handleRemoveGuardDisplay}
              onResetStation={handleResetStation}
              onManualSlotDragOutside={handleManualSlotDragOutside}
              onManualSlotDrop={handleManualSlotDrop}
              onUpsertPull={handleUpsertPull}
              onRemovePull={handleRemovePull}
              summaryHighlightWorkerName={summaryHighlightWorkerName}
              pullVariants={plan.pullVariants}
              alternativesEnabled={alternativesUiVisible}
              selectedAlternativeIndex={effectiveAlternativeIndex}
              onSelectedAlternativeChange={plan.setSelectedAlternativeIndex}
              onFilteredAlternativesChange={setSummaryFilterState}
              generationRunning={plan.generationRunning}
              onHighlightWorkerToggle={handleSummaryHighlightToggle}
              eventAssignmentCountsByName={eventAssignmentCountsByName}
            />
          ) : null}
          <PlanningV2SiteEvents
            siteId={siteId}
            weekStart={weekStart}
            workers={workers}
            readOnly={siteIsArchived}
            onEventsChange={setWeekSiteEvents}
          />
          <PlanningV2OptionalMessages siteId={siteId} weekStart={weekStart} readOnly={siteIsArchived} />
          <PlanningV2PlanExportButtons
            siteId={siteId}
            site={site}
            weekStart={weekStart}
            workers={workers}
            assignments={plan.displayAssignments}
            pulls={plan.displayPulls}
            assignmentVariants={plan.assignmentVariants}
            events={weekSiteEvents}
            onOpenVisualization={() => setVisualizationOpen(true)}
          />
        </PlanningV2MainPaper>
        <div className="h-6 shrink-0" aria-hidden />
        {hasLinkedSitesRail ? (
          <aside className="hidden lg:absolute lg:right-[calc(100%+1rem)] lg:top-0 lg:flex lg:h-[calc(100dvh-var(--planning-v2-rail-top-px)-var(--planning-v2-action-bar-px)-0.75rem)] lg:min-h-0 lg:w-[20rem] lg:flex-col lg:overflow-hidden lg:rounded-2xl lg:border lg:border-zinc-200 lg:bg-white lg:p-3 lg:shadow-sm dark:lg:border-zinc-800 dark:lg:bg-zinc-950">
            {linkedSitesRail}
          </aside>
        ) : null}
        </div>
        <PlanningV2ActionBar
          siteId={siteId}
          weekStart={weekStart}
          weekPlan={weekPlan}
          effectiveAssignments={plan.displayAssignments}
          linkedSites={linkedSites}
          readOnly={siteIsArchived}
          editingSaved={editingSaved}
          onEditingSavedChange={setEditingSaved}
          onCancelSavedEdit={() => {
            setPullsModeStationIdx(null);
            setShiftHoursModeStationIdx(null);
            plan.cancelSavedEditing();
          }}
          reloadWeekPlan={reloadWeekPlan}
          generationRunning={plan.generationRunning}
          generationStoppable={plan.generationStoppable}
          onRequestGenerate={(options) => {
            if (editingSaved) {
              setEditingSavedGenerationStarted(true);
            }
            void plan.startGeneration(options);
          }}
          onStopGeneration={plan.stopGeneration}
          autoPullsLimit={plan.autoPullsLimit}
          onAutoPullsLimitChange={plan.setAutoPullsLimit}
          autoPullsPrefer={plan.autoPullsPrefer}
          onAutoPullsPreferChange={plan.setAutoPullsPrefer}
          autoPullsEnabled={plan.autoPullsEnabled}
          isManual={plan.isManual}
          onIsManualChange={(next) => {
            plan.setIsManual(next);
            if (!next) {
              setPullsModeStationIdx(null);
              setShiftHoursModeStationIdx(null);
            }
          }}
          onEnterManualWithGridReset={plan.enterManualWithGridReset}
          onEnterAutoWithGridReset={() => {
            plan.enterAutoWithGridReset();
            setPullsModeStationIdx(null);
            setShiftHoursModeStationIdx(null);
          }}
          onSavePlan={handleSavePlan}
          onDraftClear={plan.clearDraft}
          draftActive={plan.draftActive}
          alternativeCount={
            actionBarAltSnap ? actionBarAltSnap.alternativeCount : actionBarAlternativesResetPending ? 0 : visibleAlternativeIndices.length
          }
          selectedAlternativeIndex={
            actionBarAltSnap
              ? actionBarAltSnap.selectedAlternativeIndex
              : Math.max(0, selectedVisibleAlternativeIndex)
          }
          selectedAlternativeDisplayIndex={
            actionBarAltSnap ? actionBarAltSnap.selectedAlternativeDisplayIndex : effectiveAlternativeIndex
          }
          onRequestMoreAlternatives={
            editingSaved && !editingSavedGenerationStarted
              ? undefined
              : plan.startMoreAlternatives
          }
          moreAlternativesAvailable={plan.moreAlternativesAvailable}
          alternativesEnabled={
            alternativesUiVisible || actionBarAlternativesFrozen || actionBarAlternativesResetPending
          }
          alternativesFrozen={actionBarAlternativesNavFrozen}
          alternativesFiltered={
            actionBarAltSnap ? actionBarAltSnap.alternativesFiltered : summaryFilterState.hasActiveFilters
          }
          alternativesTotalCount={actionBarAltSnap ? actionBarAltSnap.alternativesTotalCount : plan.alternativeCount}
          onSelectedAlternativeChange={(visibleIndex) => {
            const target = visibleAlternativeIndices[visibleIndex];
            if (typeof target === "number") {
              plan.setSelectedAlternativeIndex(target);
              return;
            }
            // Pendant le streaming : avancer/reculer en index absolu même si la liste
            // visible n’a pas encore rattrapé le flush SSE.
            if (plan.generationRunning) {
              const abs = Math.max(0, Number(plan.selectedAlternativeIndex || 0));
              const delta = visibleIndex - Math.max(0, selectedVisibleAlternativeIndex);
              if (delta !== 0) {
                plan.setSelectedAlternativeIndex(Math.max(0, abs + delta));
              }
            }
          }}
        />
      </PlanningV2LayoutShell>
      {showPlanningLoadingOverlay ? <LoadingOverlay size={96} /> : null}
      {visualizationOpen ? (
        <div
          className={
            "fixed inset-0 z-[200] overflow-hidden bg-zinc-950/40 backdrop-blur-[2px] transition-opacity duration-300 ease-out motion-reduce:transition-none dark:bg-black/60 " +
            (fullscreenReveal ? "opacity-100" : "opacity-0")
          }
          aria-modal="true"
          role="dialog"
          aria-labelledby="planning-v2-fs-title"
        >
          <div
            className={
              "flex h-full flex-col overflow-hidden bg-[#fafafa] transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none dark:bg-zinc-950 " +
              (fullscreenReveal ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0")
            }
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 md:px-6">
              <div className="min-w-0">
                <div id="planning-v2-fs-title" className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                  תצוגת מסך מלא
                </div>
                <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                  כמו קובץ ה-HTML מייצוא CSV — גריד צבעוני וסיכום משמרות
                </div>
              </div>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 shadow-sm hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                onClick={() => setVisualizationOpen(false)}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
                סגור
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-3 py-4 md:px-6">
              <div className="mx-auto flex h-full min-h-0 w-full max-w-[1800px] flex-col">
                <PlanningV2FullscreenVisualization
                  siteId={siteId}
                  site={site}
                  weekStart={weekStart}
                  workers={workers}
                  assignments={plan.displayAssignments}
                  pulls={plan.displayPulls}
                  assignmentVariants={plan.assignmentVariants}
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <PlanningV2ManualConfirmDialog
        open={!!manualConfirm}
        title={manualConfirm?.title ?? ""}
        body={manualConfirm?.body ?? ""}
        onConfirm={() => {
          const r = manualConfirm?.resolve;
          setManualConfirm(null);
          r?.(true);
        }}
        onCancel={() => {
          const r = manualConfirm?.resolve;
          setManualConfirm(null);
          r?.(false);
        }}
      />
      {pullScopeDialog ? (
        <ModalOverlay className="z-[200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
            <div className="text-base font-semibold">
              {pullScopeDialog.kind === "guard_hours"
                ? "שינוי שעות באתרים מקושרים"
                : "משיכות באתרים מקושרים"}
            </div>
            <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              {pullScopeDialog.kind === "guard_hours"
                ? pullScopeDialog.mode === "remove"
                  ? "באיזה היקף למחוק את שינוי השעות?"
                  : "באיזה היקף לשמור את שינוי השעות?"
                : pullScopeDialog.mode === "remove"
                ? "באיזה היקף למחוק את המשיכה?"
                : "באיזה היקף לשמור את המשיכה?"}
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => {
                  pullScopeDialog.resolve(null);
                  setPullScopeDialog(null);
                }}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => {
                  pullScopeDialog.resolve("current_only");
                  setPullScopeDialog(null);
                }}
              >
                לאתר הזה בלבד
              </button>
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-3 py-2 text-sm text-white hover:bg-[#0092c6]"
                onClick={() => {
                  pullScopeDialog.resolve("all_sites");
                  setPullScopeDialog(null);
                }}
              >
                לכל האתרים המקושרים
              </button>
            </div>
          </div>
        </ModalOverlay>
      ) : null}
    </div>
  );
}

export function PlanningV2Page() {
  const router = useRouter();
  const params = useParams();
  const siteId = params?.id != null ? String(params.id) : "";

  useEffect(() => {
    fetchMe().then((me) => {
      if (!me) return router.replace("/login/director");
      if (me.role !== "director") return router.replace("/worker");
    });
  }, [router]);

  if (!siteId) {
    return (
      <div className="min-h-screen bg-zinc-50 p-6 dark:bg-zinc-950" dir="rtl">
        <div className="mx-auto max-w-lg rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="mb-4 text-zinc-800 dark:text-zinc-100">לא נמצא מזהה אתר בכתובת.</p>
          <Link
            href="/director"
            className="inline-flex rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            חזרה לדף המנהל
          </Link>
        </div>
      </div>
    );
  }

  return <PlanningWeekShell siteId={siteId} />;
}

/** Remount seulement au changement d’אתר — la semaine soft-reload sans cold start. */
function PlanningWeekShell({ siteId }: { siteId: string }) {
  return <PlanningV2PageInner key={siteId} siteId={siteId} />;
}

"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { fetchMe } from "@/lib/auth";
import { PlanningV2Header } from "./planning-v2-header";
import { PlanningV2LayoutShell } from "./planning-v2-layout-shell";
import { PlanningV2MainPaper } from "./planning-v2-main-paper";
import { PlanningV2SitePaperHeader } from "./planning-v2-site-paper-header";
import { usePlanningV2SiteWorkers } from "./hooks/use-planning-v2-site-workers";
import { usePlanningV2WeekPlan } from "./hooks/use-planning-v2-week-plan";
import { PlanningV2AssignmentsSummary } from "./planning-v2-assignments-summary";
import { PlanningV2OptionalMessages } from "./planning-v2-optional-messages";
import { PlanningV2ActionBar } from "./planning-v2-action-bar";
import { PlanningV2StationWeekGrid } from "./stations/planning-v2-station-week-grid";
import { PlanningV2WeekNavigation } from "./planning-v2-week-navigation";
import { PlanningWorkersSection } from "./workers/planning-workers-section";
import { usePlanningV2LinkedSites } from "./hooks/use-planning-v2-linked-sites";
import { usePlanningV2PlanController } from "./hooks/use-planning-v2-plan-controller";
import { assignmentsNonEmpty } from "./lib/assignments-empty";

function PlanningV2PageInner({ siteId }: { siteId: string }) {
  const {
    site,
    siteLoading,
    workers,
    workersLoading,
    reloadWorkers,
    reloadWeeklyAvailability,
    weekStart,
    workerRowsForTable,
  } = usePlanningV2SiteWorkers(siteId);

  const { plan: weekPlan, loading: weekPlanLoading, reloadWeekPlan } = usePlanningV2WeekPlan(siteId, weekStart);
  const { linkedSites } = usePlanningV2LinkedSites(siteId, weekStart);
  const [editingSaved, setEditingSaved] = useState(false);

  const plan = usePlanningV2PlanController({
    siteId,
    weekStart,
    weekPlan,
    workers,
    workerRowsForTable,
    reloadWeekPlan,
    linkedSitesLength: linkedSites.length,
  });

  const savedHighlight = useMemo(
    () => assignmentsNonEmpty(weekPlan?.assignments ?? null) && !editingSaved,
    [weekPlan?.assignments, editingSaved],
  );

  const refreshWorkersAndGrid = () => {
    void reloadWorkers();
    void reloadWeeklyAvailability();
    void reloadWeekPlan();
  };

  const handleSavePlan = async (publishToWorkers: boolean) => {
    await plan.savePlan(publishToWorkers);
    setEditingSaved(false);
  };

  return (
    <div
      className="min-h-screen px-3 py-6 pb-56 sm:px-4 lg:px-4 md:pb-40 [&_button]:touch-manipulation [&_button]:select-none"
      dir="rtl"
    >
      <PlanningV2LayoutShell>
        <PlanningV2Header siteId={siteId} />
        <PlanningV2MainPaper editingSaved={editingSaved} savedHighlight={savedHighlight}>
          <PlanningV2SitePaperHeader siteId={siteId} site={site} siteLoading={siteLoading} />
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
            workersLoading={workersLoading}
            onWorkersChanged={refreshWorkersAndGrid}
          />
          <PlanningV2StationWeekGrid
            site={site}
            weekStart={weekStart}
            assignments={plan.displayAssignments}
            pulls={plan.displayPulls}
            loading={weekPlanLoading}
          />
          <PlanningV2AssignmentsSummary
            siteId={siteId}
            site={site}
            weekStart={weekStart}
            workers={workers}
            assignments={plan.displayAssignments}
            pulls={plan.displayPulls}
            loading={weekPlanLoading}
          />
          <PlanningV2OptionalMessages siteId={siteId} weekStart={weekStart} />
        </PlanningV2MainPaper>
        <PlanningV2ActionBar
          siteId={siteId}
          weekStart={weekStart}
          weekPlan={weekPlan}
          effectiveAssignments={plan.displayAssignments}
          linkedSites={linkedSites}
          editingSaved={editingSaved}
          onEditingSavedChange={setEditingSaved}
          reloadWeekPlan={reloadWeekPlan}
          generationRunning={plan.generationRunning}
          onRequestGenerate={plan.startGeneration}
          onStopGeneration={plan.stopGeneration}
          autoPullsLimit={plan.autoPullsLimit}
          onAutoPullsLimitChange={plan.setAutoPullsLimit}
          autoPullsEnabled={plan.autoPullsEnabled}
          isManual={plan.isManual}
          onIsManualChange={plan.setIsManual}
          onSavePlan={handleSavePlan}
          onDraftClear={plan.clearDraft}
          draftActive={plan.draftActive}
        />
      </PlanningV2LayoutShell>
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

/** מפתח URL (?week=) + אתר — איפוס מצב עריכה בעת החלפת שבוע בלי useEffect. */
function PlanningWeekShell({ siteId }: { siteId: string }) {
  const searchParams = useSearchParams();
  const weekQ = searchParams.get("week") || "default";
  return <PlanningV2PageInner key={`${siteId}-${weekQ}`} siteId={siteId} />;
}

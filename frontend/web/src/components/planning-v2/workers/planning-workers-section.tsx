"use client";

import { useMemo } from "react";
import { FilterWorkersAnswersModal } from "@/components/planning-shared/filter-workers-answers-modal";
import { LinkedAvailabilityConfirmDialog } from "@/components/planning-shared/linked-availability-confirm-dialog";
import { WorkerEditModal } from "@/components/planning-shared/worker-edit-modal";
import type { PlanningWorker, SiteSummary } from "../types";
import { buildEnabledRoleNameSet } from "../lib/display";
import { usePlanningV2WorkerModals } from "../hooks/use-planning-v2-worker-modals";
import { CreateWorkerStepModal } from "./create-worker-step-modal";
import { ExistingWorkersPickerModal } from "./existing-workers-picker-modal";
import { PlanningWorkersTable } from "./planning-workers-table";

type PlanningWorkersSectionProps = {
  siteId: string;
  site: SiteSummary | null;
  weekStart: Date;
  workers: PlanningWorker[];
  rows: Array<PlanningWorker & { availability: PlanningWorker["availability"] }>;
  workersLoading: boolean;
  onWorkersChanged: () => void;
  /** גרירת שם לגריד במצב ידני */
  workersNameDraggable?: boolean;
  onWorkerNameDragPreview?: (workerName: string | null) => void;
};

export function PlanningWorkersSection({
  siteId,
  site,
  weekStart,
  workers,
  rows,
  workersLoading,
  onWorkersChanged,
  workersNameDraggable = false,
  onWorkerNameDragPreview,
}: PlanningWorkersSectionProps) {
  const modals = usePlanningV2WorkerModals(siteId, site, weekStart, workers, () => {
    onWorkersChanged();
  });

  const enabledRoleNames = useMemo(() => buildEnabledRoleNameSet(site), [site]);
  const questions = (site?.config as { questions?: unknown[] } | undefined)?.questions;
  const hasQuestions = Array.isArray(questions) && questions.length > 0;

  return (
    <>
      <section className="space-y-3">
        <h2 className="text-center text-lg font-semibold">עובדים</h2>
        <div className="space-y-3 rounded-md border p-3 dark:border-zinc-700">
          <div className="flex items-center justify-between">
            <div className="text-sm text-zinc-500">רשימת עובדים</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (!hasQuestions) return;
                  modals.setFilterOpen(true);
                }}
                disabled={!hasQuestions}
                title={!hasQuestions ? "אין שאלות מוגדרות לאתר" : undefined}
                className={
                  "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm " +
                  (!hasQuestions
                    ? "cursor-not-allowed border-zinc-200 bg-white text-zinc-400 opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-600"
                    : "border-orange-600 bg-white text-orange-600 hover:bg-orange-50 dark:border-orange-500 dark:bg-zinc-900 dark:text-orange-400 dark:hover:bg-zinc-800")
                }
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z" />
                </svg>
                סינון תשובות
              </button>
              <button
                type="button"
                onClick={() => modals.openAddWorkerEditor()}
                className="inline-flex items-center gap-2 rounded-md border border-green-600 px-3 py-2 text-sm text-green-600 hover:bg-green-50 dark:border-green-500 dark:text-green-400 dark:hover:bg-green-900/30"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
                </svg>
                הוסף עובד
              </button>
            </div>
          </div>
          {workersLoading ? (
            <div className="py-8 text-center text-sm text-zinc-500">טוען עובדים…</div>
          ) : (
            <PlanningWorkersTable
              rows={rows}
              enabledRoleNames={enabledRoleNames}
              onRowClick={modals.onTableRowClick}
              workerNameDraggable={workersNameDraggable}
              onWorkerNameDragPreview={onWorkerNameDragPreview}
            />
          )}
          <p className="text-center text-[11px] text-zinc-500 dark:text-zinc-400">
            לחיצה על שורה פותחת עריכת זמינות ותפקידים. השיבוצים בגריד מוצגים למטה באותו מסך.
          </p>
        </div>
      </section>

      <CreateWorkerStepModal {...modals.createWorkerStepModalProps} />
      <ExistingWorkersPickerModal {...modals.existingWorkersPickerModalProps} />
      <WorkerEditModal {...modals.workerEditModalProps} />
      <FilterWorkersAnswersModal {...modals.filterModalProps} />
      <LinkedAvailabilityConfirmDialog {...modals.linkedDialogProps} />
    </>
  );
}

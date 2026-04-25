"use client";

import NumberPicker from "@/components/number-picker";
import type { WorkerModalQuestionView } from "./worker-modal-question-view";

export type DayDef = { key: string; label: string };

export type WorkerEditModalProps = {
  open: boolean;
  onClose: () => void;
  editingWorkerId: number | null;
  newWorkerName: string;
  onNewWorkerNameChange: (v: string) => void;
  newWorkerMax: number;
  onNewWorkerMaxChange: (v: number) => void;
  newWorkerRoles: string[];
  onToggleRole: (roleName: string, checked: boolean) => void;
  allRoleNames: string[];
  editingWorkerLinkedSiteNames: string[];
  dayDefs: readonly DayDef[];
  allShiftNames: string[];
  newWorkerAvailability: Record<string, string[]>;
  onToggleAvailability: (dayKey: string, shiftName: string) => void;
  onToggleAvailabilityForAllDays: (shiftName: string | undefined, checked: boolean) => void;
  workerModalShiftBuckets: {
    morningName?: string;
    noonName?: string;
    nightName?: string;
  };
  workerModalBulkSelection: {
    morningAll: boolean;
    noonAll: boolean;
    nightAll: boolean;
  };
  workerModalQuestionView: WorkerModalQuestionView;
  showRestoreAvailabilityButton: boolean;
  onRestoreAvailability: () => void;
  showDeleteButton: boolean;
  deleteDisabled?: boolean;
  onDelete: () => void | Promise<void>;
  workerModalSaving: boolean;
  onSave: () => void | Promise<void>;
};

export function WorkerEditModal({
  open,
  onClose,
  editingWorkerId,
  newWorkerName,
  onNewWorkerNameChange,
  newWorkerMax,
  onNewWorkerMaxChange,
  newWorkerRoles,
  onToggleRole,
  allRoleNames,
  editingWorkerLinkedSiteNames,
  dayDefs,
  allShiftNames,
  newWorkerAvailability,
  onToggleAvailability,
  onToggleAvailabilityForAllDays,
  workerModalShiftBuckets,
  workerModalBulkSelection,
  workerModalQuestionView,
  showRestoreAvailabilityButton,
  onRestoreAvailability,
  showDeleteButton,
  deleteDisabled,
  onDelete,
  workerModalSaving,
  onSave,
}: WorkerEditModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex h-[72vh] h-[72dvh] min-h-0 max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900 md:h-[34rem]">
        <div className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 p-3 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/95 md:p-4">
          <div className="relative flex items-center justify-center">
            <h3 className="text-center text-base font-semibold md:text-lg">
              {editingWorkerId ? "עריכת עובד" : "הוספת עובד"}
            </h3>
            <button
              type="button"
              onClick={() => onClose()}
              className="absolute right-2 top-1.5 rounded-md border px-2 py-1 text-xs hover:bg-zinc-50 md:text-sm dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
          <div className="grid grid-cols-1 justify-items-center gap-2 text-center md:grid-cols-4 md:gap-3">
            <div>
              <label className="block text-xs font-semibold md:text-sm">שם</label>
              <input
                type="text"
                value={newWorkerName}
                onChange={(e) => onNewWorkerNameChange(e.target.value)}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-base text-zinc-900 outline-none ring-0 focus:border-zinc-400 md:px-3 md:py-2 md:text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold md:text-sm">מקס&apos; משמרות בשבוע</label>
              <NumberPicker
                value={newWorkerMax}
                onChange={(value) => onNewWorkerMaxChange(Math.max(0, Math.min(6, value)))}
                min={0}
                max={6}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-base text-zinc-900 outline-none ring-0 focus:border-zinc-400 md:px-3 md:py-2 md:text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              />
            </div>
            <div className="md:col-span-2">
              <div className="mb-1 block text-sm font-semibold">תפקידים</div>
              <div className="flex flex-wrap justify-center gap-2 text-sm">
                {allRoleNames.length === 0 ? (
                  <span className="text-zinc-500">אין תפקידים מוגדרים</span>
                ) : (
                  allRoleNames.map((rn) => (
                    <label key={rn} className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={newWorkerRoles.includes(rn)}
                        onChange={(e) => {
                          onToggleRole(rn, e.target.checked);
                        }}
                      />
                      {rn}
                    </label>
                  ))
                )}
              </div>
            </div>
          </div>
          {editingWorkerLinkedSiteNames.length > 1 && (
            <div className="mt-3 flex w-full flex-col items-center text-center">
              <div className="w-full text-center text-[11px] font-medium text-zinc-500 md:text-xs dark:text-zinc-400">
                משויך לאתרים:
              </div>
              <div className="mt-1 flex w-full items-center justify-center gap-1.5 overflow-x-auto whitespace-nowrap pb-1">
                {editingWorkerLinkedSiteNames.map((siteName: string) => (
                  <span
                    key={siteName}
                    className="shrink-0 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 md:text-xs dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
                  >
                    {siteName}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="mt-3 text-center">
            <div className="mb-1 block text-sm font-semibold">זמינות לפי יום/משמרת</div>
            <div className="space-y-2">
              <div className="mb-2 flex flex-wrap items-center justify-center gap-4 text-sm">
                <label className="inline-flex items-center gap-2 opacity-100">
                  <input
                    type="checkbox"
                    disabled={!workerModalShiftBuckets.morningName}
                    checked={!!workerModalShiftBuckets.morningName && workerModalBulkSelection.morningAll}
                    onChange={(e) =>
                      onToggleAvailabilityForAllDays(workerModalShiftBuckets.morningName, e.target.checked)
                    }
                  />
                  כל הבוקר
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={!workerModalShiftBuckets.noonName}
                    checked={!!workerModalShiftBuckets.noonName && workerModalBulkSelection.noonAll}
                    onChange={(e) =>
                      onToggleAvailabilityForAllDays(workerModalShiftBuckets.noonName, e.target.checked)
                    }
                  />
                  כל הצהריים
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={!workerModalShiftBuckets.nightName}
                    checked={!!workerModalShiftBuckets.nightName && workerModalBulkSelection.nightAll}
                    onChange={(e) =>
                      onToggleAvailabilityForAllDays(workerModalShiftBuckets.nightName, e.target.checked)
                    }
                  />
                  כל הלילה
                </label>
              </div>
              {dayDefs.map((d) => (
                <div key={d.key} className="flex flex-wrap items-center justify-center gap-3 text-sm">
                  <div className="w-10 text-zinc-600 dark:text-zinc-300">{d.label}</div>
                  {allShiftNames.length === 0 ? (
                    <span className="text-zinc-500">אין משמרות פעילות</span>
                  ) : (
                    allShiftNames.map((sn) => (
                      <label key={sn} className="inline-flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={(newWorkerAvailability[d.key] || []).includes(sn)}
                          onChange={() => onToggleAvailability(d.key, sn)}
                        />
                        {sn}
                      </label>
                    ))
                  )}
                </div>
              ))}
            </div>
          </div>

          {(() => {
            if (!editingWorkerId) return null;
            if (!workerModalQuestionView.hasWeekAnswers) {
              return (
                <div className="mt-4 rounded-md border border-zinc-200 p-3 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                  אין תשובות לשאלות עבור השבוע הנוכחי
                </div>
              );
            }
            if (!workerModalQuestionView.generalItems.length && !workerModalQuestionView.perDayItems.length)
              return null;

            return (
              <div className="mt-4 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-700">
                <div className="mb-2 font-semibold">שאלות נוספות</div>
                <div className="space-y-2">
                  {workerModalQuestionView.generalItems.map((item) => {
                    return (
                      <div
                        key={`g_${item.id}`}
                        className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between"
                      >
                        <div className="text-zinc-700 dark:text-zinc-200">{item.label}</div>
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">{item.value}</div>
                      </div>
                    );
                  })}

                  {workerModalQuestionView.perDayItems.map((item) => {
                    return (
                      <div key={`p_${item.id}`} className="rounded-md border border-zinc-100 p-2 dark:border-zinc-800">
                        <div className="mb-1 font-medium text-zinc-800 dark:text-zinc-200">{item.label}</div>
                        <div className="space-y-1">
                          {item.items.map((dayItem) => {
                            return (
                              <div
                                key={`${item.id}_${dayItem.dayKey}`}
                                className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between"
                              >
                                <div className="text-zinc-600 dark:text-zinc-300">{dayItem.dayLabel}</div>
                                <div className="font-medium text-zinc-900 dark:text-zinc-100">{dayItem.value}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 border-t border-zinc-200 bg-white/95 px-3 py-3 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/95 md:px-4">
          <button
            type="button"
            onClick={() => onClose()}
            className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            ביטול
          </button>
          {showRestoreAvailabilityButton && (
            <button
              type="button"
              onClick={() => onRestoreAvailability()}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              שחזר זמינות מהעובד
            </button>
          )}
          {showDeleteButton && (
            <button
              type="button"
              className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-60"
              disabled={deleteDisabled}
              onClick={() => void onDelete()}
            >
              מחק עובד
            </button>
          )}
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={workerModalSaving}
            className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {workerModalSaving ? "שומר..." : "שמור"}
          </button>
        </div>
      </div>
    </div>
  );
}

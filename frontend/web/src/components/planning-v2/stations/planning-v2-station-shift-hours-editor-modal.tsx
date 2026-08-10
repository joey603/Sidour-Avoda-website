"use client";

import type { Dispatch, SetStateAction } from "react";
import { toast } from "sonner";
import TimePicker from "@/components/time-picker";
import { ModalOverlay } from "@/components/ui/modal-scroll-lock";
import { checkGuardDisplayVsShift } from "../lib/planning-v2-station-week-grid-utils";

export type PlanningV2StationShiftHoursEditorState = {
  key: string;
  dayKey: string;
  shiftName: string;
  stationIdx: number;
  slotIdx: number;
  workerName: string;
  start: string;
  end: string;
  shiftStart: string;
  shiftEnd: string;
};

type Props = {
  editor: PlanningV2StationShiftHoursEditorState;
  oorConfirm: boolean;
  onClose: () => void;
  setEditor: Dispatch<SetStateAction<PlanningV2StationShiftHoursEditorState | null>>;
  setOorConfirm: Dispatch<SetStateAction<boolean>>;
  onRemoveGuardDisplay?: (key: string) => boolean | void | Promise<boolean | void>;
  onUpsertGuardDisplay?: (key: string, start: string, end: string) => boolean | void | Promise<boolean | void>;
};

export function PlanningV2StationShiftHoursEditorModal({
  editor,
  oorConfirm,
  onClose,
  setEditor,
  setOorConfirm,
  onRemoveGuardDisplay,
  onUpsertGuardDisplay,
}: Props) {
  return (
    <>
              <ModalOverlay
          className="z-[200] flex items-center justify-center bg-black/50 p-4"
          onClick={onClose}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-semibold text-yellow-800 dark:text-yellow-200">שינוי שעות</div>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={onClose}
                aria-label="סגור"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
              </button>
            </div>
            <div className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
              {(() => {
                const dayLabels: Record<string, string> = {
                  sun: "א'",
                  mon: "ב'",
                  tue: "ג'",
                  wed: "ד'",
                  thu: "ה'",
                  fri: "ו'",
                  sat: "ש'",
                };
                const dayLabel = dayLabels[editor.dayKey] || editor.dayKey;
                return `${dayLabel} • ${editor.shiftName} • עמדה ${editor.stationIdx + 1}`;
              })()}
            </div>
            <div className="rounded-md border border-yellow-200 p-3 dark:border-yellow-700">
              <div className="mb-3 text-sm font-medium text-zinc-800 dark:text-zinc-100">
                {editor.workerName}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-zinc-500">
                  התחלת משמרת
                  <TimePicker
                    value={editor.start}
                    onChange={(v) => setEditor((p) => (p ? { ...p, start: v } : p))}
                    className="mt-1 h-9 w-full rounded-md border border-yellow-200 bg-white px-3 text-sm dark:border-yellow-700 dark:bg-zinc-900"
                    dir="ltr"
                  />
                </label>
                <label className="text-xs text-zinc-500">
                  סיום משמרת
                  <TimePicker
                    value={editor.end}
                    onChange={(v) => setEditor((p) => (p ? { ...p, end: v } : p))}
                    className="mt-1 h-9 w-full rounded-md border border-yellow-200 bg-white px-3 text-sm dark:border-yellow-700 dark:bg-zinc-900"
                    dir="ltr"
                  />
                </label>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-60"
                onClick={async () => {
                  const res = await onRemoveGuardDisplay?.(editor.key);
                  if (res !== false) setEditor(null);
                }}
              >
                מחק
              </button>
              <button
                type="button"
                className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={onClose}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md bg-yellow-500 px-4 py-2 text-sm text-yellow-950 hover:bg-yellow-600"
                onClick={async () => {
                  if (!onUpsertGuardDisplay) return;
                  const check = checkGuardDisplayVsShift(editor);
                  if (!check.formatOk) {
                    toast.error("שעות לא תקינות", { description: "פורמט השעה חייב להיות HH:MM" });
                    return;
                  }
                  if (!check.inRange) {
                    setOorConfirm(true);
                    return;
                  }
                  const res = await onUpsertGuardDisplay(editor.key, editor.start, editor.end);
                  if (res !== false) setEditor(null);
                }}
              >
                שמירה
              </button>
            </div>
          </div>
        </ModalOverlay>
              <ModalOverlay
          className="z-[11000] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setOorConfirm(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-amber-200 bg-white p-4 shadow-lg dark:border-amber-800 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-base font-semibold text-zinc-900 dark:text-zinc-100">שימו לב</div>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              השעות שבחרת אינן בתוך טווח המשמרת. האם לשמור בכל זאת?
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => setOorConfirm(false)}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md bg-yellow-500 px-4 py-2 text-sm text-yellow-950 hover:bg-yellow-600"
                onClick={async () => {
                  if (!onUpsertGuardDisplay || !editor) return;
                  setOorConfirm(false);
                  const res = await onUpsertGuardDisplay(
                    editor.key,
                    editor.start,
                    editor.end,
                  );
                  if (res !== false) setEditor(null);
                }}
              >
                שמור בכל זאת
              </button>
            </div>
          </div>
        </ModalOverlay>
    </>
  );
}

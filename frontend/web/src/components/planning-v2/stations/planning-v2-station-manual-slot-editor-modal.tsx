"use client";

import type { Dispatch, SetStateAction } from "react";
import { toast } from "sonner";
import TimePicker from "@/components/time-picker";
import { ModalOverlay } from "@/components/ui/modal-scroll-lock";
import { checkGuardDisplayVsShift } from "../lib/planning-v2-station-week-grid-utils";

export type PlanningV2StationManualSlotEditorState = {
  mode: "create" | "edit";
  key: string;
  dayKey: string;
  shiftName: string;
  stationIdx: number;
  slotIdx: number;
  workerName: string;
  roleName: string;
  start: string;
  end: string;
  shiftStart: string;
  shiftEnd: string;
  roleOptions: string[];
  workerOptions: string[];
};

export type PlanningV2ManualSlotSavePayload = {
  mode: "create" | "edit";
  dayKey: string;
  shiftName: string;
  stationIndex: number;
  slotIndex: number;
  workerName: string;
  roleName: string;
  start: string;
  end: string;
};

type Props = {
  editor: PlanningV2StationManualSlotEditorState;
  oorConfirm: boolean;
  onClose: () => void;
  setEditor: Dispatch<SetStateAction<PlanningV2StationManualSlotEditorState | null>>;
  setOorConfirm: Dispatch<SetStateAction<boolean>>;
  onSave?: (payload: PlanningV2ManualSlotSavePayload) => boolean | void | Promise<boolean | void>;
  onRemove?: (payload: {
    dayKey: string;
    shiftName: string;
    stationIndex: number;
    slotIndex: number;
  }) => boolean | void | Promise<boolean | void>;
};

const DAY_LABELS: Record<string, string> = {
  sun: "א'",
  mon: "ב'",
  tue: "ג'",
  wed: "ד'",
  thu: "ה'",
  fri: "ו'",
  sat: "ש'",
};

export function PlanningV2StationManualSlotEditorModal({
  editor,
  oorConfirm,
  onClose,
  setEditor,
  setOorConfirm,
  onSave,
  onRemove,
}: Props) {
  const trySave = async (forceOor = false) => {
    if (!onSave) return;
    const check = checkGuardDisplayVsShift({
      start: editor.start,
      end: editor.end,
      shiftStart: editor.shiftStart,
      shiftEnd: editor.shiftEnd,
    });
    if (!check.formatOk) {
      toast.error("שעות לא תקינות", { description: "פורמט השעה חייב להיות HH:MM" });
      return;
    }
    if (!check.inRange && !forceOor) {
      setOorConfirm(true);
      return;
    }
    const res = await onSave({
      mode: editor.mode,
      dayKey: editor.dayKey,
      shiftName: editor.shiftName,
      stationIndex: editor.stationIdx,
      slotIndex: editor.slotIdx,
      workerName: String(editor.workerName || "").trim(),
      roleName: String(editor.roleName || "").trim(),
      start: editor.start,
      end: editor.end,
    });
    if (res !== false) setEditor(null);
  };

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
            <div className="text-lg font-semibold text-teal-800 dark:text-teal-200">
              {editor.mode === "edit" ? "עריכת שיבוץ" : "שיבוץ"}
            </div>
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
            {`${DAY_LABELS[editor.dayKey] || editor.dayKey} • ${editor.shiftName} • עמדה ${editor.stationIdx + 1}`}
          </div>
          <div className="space-y-3 rounded-md border border-teal-200 p-3 dark:border-teal-700">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-zinc-500">
                התחלת משמרת
                <TimePicker
                  value={editor.start}
                  onChange={(v) => setEditor((p) => (p ? { ...p, start: v } : p))}
                  className="mt-1 h-9 w-full rounded-md border border-teal-200 bg-white px-3 text-sm dark:border-teal-700 dark:bg-zinc-900"
                  dir="ltr"
                />
              </label>
              <label className="text-xs text-zinc-500">
                סיום משמרת
                <TimePicker
                  value={editor.end}
                  onChange={(v) => setEditor((p) => (p ? { ...p, end: v } : p))}
                  className="mt-1 h-9 w-full rounded-md border border-teal-200 bg-white px-3 text-sm dark:border-teal-700 dark:bg-zinc-900"
                  dir="ltr"
                />
              </label>
            </div>
            <label className="block text-xs text-zinc-500">
              תפקיד
              <select
                className="mt-1 h-9 w-full rounded-md border border-teal-200 bg-white px-3 text-sm dark:border-teal-700 dark:bg-zinc-900"
                value={editor.roleName}
                onChange={(e) => setEditor((p) => (p ? { ...p, roleName: e.target.value } : p))}
              >
                <option value="">ללא תפקיד</option>
                {editor.roleOptions.map((rn) => (
                  <option key={rn} value={rn}>
                    {rn}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-zinc-500">
              עובד
              <select
                className="mt-1 h-9 w-full rounded-md border border-teal-200 bg-white px-3 text-sm dark:border-teal-700 dark:bg-zinc-900"
                value={editor.workerName}
                onChange={(e) => setEditor((p) => (p ? { ...p, workerName: e.target.value } : p))}
              >
                <option value="">ללא עובד</option>
                {editor.workerOptions.map((nm) => (
                  <option key={nm} value={nm}>
                    {nm}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            {editor.mode === "edit" ? (
              <button
                type="button"
                className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-60"
                onClick={async () => {
                  const res = await onRemove?.({
                    dayKey: editor.dayKey,
                    shiftName: editor.shiftName,
                    stationIndex: editor.stationIdx,
                    slotIndex: editor.slotIdx,
                  });
                  if (res !== false) setEditor(null);
                }}
              >
                מחק
              </button>
            ) : null}
            <button
              type="button"
              className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              onClick={onClose}
            >
              ביטול
            </button>
            <button
              type="button"
              className="rounded-md bg-teal-600 px-4 py-2 text-sm text-white hover:bg-teal-700"
              onClick={() => void trySave(false)}
            >
              שמירה
            </button>
          </div>
        </div>
      </ModalOverlay>
      {oorConfirm && (
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
                className="rounded-md bg-teal-600 px-4 py-2 text-sm text-white hover:bg-teal-700"
                onClick={async () => {
                  setOorConfirm(false);
                  await trySave(true);
                }}
              >
                שמור בכל זאת
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </>
  );
}

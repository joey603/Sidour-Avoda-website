"use client";

import type { Dispatch, SetStateAction } from "react";
import { toast } from "sonner";
import TimePicker from "@/components/time-picker";
import { ModalOverlay } from "@/components/ui/modal-scroll-lock";

export type PlanningV2StationPullsEditorState = {
  key: string;
  dayKey: string;
  shiftName: string;
  stationIdx: number;
  required: number;
  shiftStart: string;
  shiftEnd: string;
  roleName?: string | null;
  beforeOptions: string[];
  afterOptions: string[];
  beforeName: string;
  afterName: string;
  beforeStart: string;
  beforeEnd: string;
  afterStart: string;
  afterEnd: string;
};

type Props = {
  editor: PlanningV2StationPullsEditorState;
  onClose: () => void;
  setEditor: Dispatch<SetStateAction<PlanningV2StationPullsEditorState | null>>;
  onRemovePull?: (key: string) => boolean | void | Promise<boolean | void>;
  onUpsertPull?: (
    key: string,
    payload: { before: { name: string; start: string; end: string }; after: { name: string; start: string; end: string } },
  ) => boolean | void | Promise<boolean | void>;
};

export function PlanningV2StationPullsEditorModal({
  editor: pullsEditor,
  onClose,
  setEditor,
  onRemovePull,
  onUpsertPull,
}: Props) {
  return (
        <ModalOverlay className="z-[200] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
          <div
            className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-semibold">משיכות</div>
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
                const dayLabel = dayLabels[pullsEditor.dayKey] || pullsEditor.dayKey;
                return `${dayLabel} • ${pullsEditor.shiftName} • עמדה ${pullsEditor.stationIdx + 1}`;
              })()}
            </div>
            {pullsEditor.roleName ? (
              <div className="mb-3 text-xs text-zinc-500">
                תפקיד: <span className="font-medium text-zinc-700 dark:text-zinc-200">{pullsEditor.roleName}</span>
              </div>
            ) : null}
            <div className="space-y-3">
              <div className="rounded-md border p-3 dark:border-zinc-700">
                <div className="mb-2 text-sm font-medium">{pullsEditor.beforeName}</div>
                {(pullsEditor.beforeOptions || []).length > 1 && (
                  <div className="mb-3">
                    <div className="mb-1 text-xs text-zinc-500">בחר עובד (לפני)</div>
                    <select
                      value={pullsEditor.beforeName}
                      onChange={(e) => setEditor((p) => (p ? { ...p, beforeName: e.target.value } : p))}
                      size={Math.min(4, Math.max(2, (pullsEditor.beforeOptions || []).length))}
                      className="w-full overflow-y-auto rounded-md border bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      {(pullsEditor.beforeOptions || []).map((nm) => (
                        <option key={nm} value={nm}>
                          {nm}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-zinc-500">
                    התחלה
                    <TimePicker
                      value={pullsEditor.beforeStart}
                      onChange={(v) => setEditor((p) => (p ? { ...p, beforeStart: v } : p))}
                      className="mt-1 h-9 w-full rounded-md border px-3 text-sm dark:border-zinc-700 bg-white dark:bg-zinc-900"
                      dir="ltr"
                    />
                  </label>
                  <label className="text-xs text-zinc-500">
                    סיום
                    <TimePicker
                      value={pullsEditor.beforeEnd}
                      onChange={(v) => setEditor((p) => (p ? { ...p, beforeEnd: v } : p))}
                      className="mt-1 h-9 w-full rounded-md border px-3 text-sm dark:border-zinc-700 bg-white dark:bg-zinc-900"
                      dir="ltr"
                    />
                  </label>
                </div>
              </div>
              <div className="rounded-md border p-3 dark:border-zinc-700">
                <div className="mb-2 text-sm font-medium">{pullsEditor.afterName}</div>
                {(pullsEditor.afterOptions || []).length > 1 && (
                  <div className="mb-3">
                    <div className="mb-1 text-xs text-zinc-500">בחר עובד (אחרי)</div>
                    <select
                      value={pullsEditor.afterName}
                      onChange={(e) => setEditor((p) => (p ? { ...p, afterName: e.target.value } : p))}
                      size={Math.min(4, Math.max(2, (pullsEditor.afterOptions || []).length))}
                      className="w-full overflow-y-auto rounded-md border bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      {(pullsEditor.afterOptions || []).map((nm) => (
                        <option key={nm} value={nm}>
                          {nm}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-zinc-500">
                    התחלה
                    <TimePicker
                      value={pullsEditor.afterStart}
                      onChange={(v) => setEditor((p) => (p ? { ...p, afterStart: v } : p))}
                      className="mt-1 h-9 w-full rounded-md border px-3 text-sm dark:border-zinc-700 bg-white dark:bg-zinc-900"
                      dir="ltr"
                    />
                  </label>
                  <label className="text-xs text-zinc-500">
                    סיום
                    <TimePicker
                      value={pullsEditor.afterEnd}
                      onChange={(v) => setEditor((p) => (p ? { ...p, afterEnd: v } : p))}
                      className="mt-1 h-9 w-full rounded-md border px-3 text-sm dark:border-zinc-700 bg-white dark:bg-zinc-900"
                      dir="ltr"
                    />
                  </label>
                </div>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-60"
                onClick={async () => {
                  const res = await onRemovePull?.(pullsEditor.key);
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
                className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6]"
                onClick={async () => {
                  const beforeName = String(pullsEditor.beforeName || "").trim();
                  const afterName = String(pullsEditor.afterName || "").trim();
                  if (!beforeName || !afterName) {
                    toast.error("לא ניתן ליצור משיכות", { description: "יש לבחור שני עובדים" });
                    return;
                  }
                  const toMinutesLocal = (t: string): number | null => {
                    const m = String(t || "").trim().match(/^(\d{1,2}):(\d{2})$/);
                    if (!m) return null;
                    const hh = Number(m[1]);
                    const mm = Number(m[2]);
                    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
                    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
                    return hh * 60 + mm;
                  };
                  const s0 = toMinutesLocal(pullsEditor.shiftStart);
                  const e0 = toMinutesLocal(pullsEditor.shiftEnd);
                  const bS0 = toMinutesLocal(pullsEditor.beforeStart);
                  const bE0 = toMinutesLocal(pullsEditor.beforeEnd);
                  const aS0 = toMinutesLocal(pullsEditor.afterStart);
                  const aE0 = toMinutesLocal(pullsEditor.afterEnd);
                  if ([s0, e0, bS0, bE0, aS0, aE0].some((x) => x == null)) {
                    toast.error("שעות לא תקינות", { description: "פורמט השעה חייב להיות HH:MM" });
                    return;
                  }
                  const s = s0 as number;
                  let e = e0 as number;
                  const crossesMidnight = e <= s;
                  if (crossesMidnight) e += 24 * 60;
                  const abs = (m: number) => (crossesMidnight && m < s ? m + 24 * 60 : m);
                  const within = (m: number) => {
                    const am = abs(m);
                    return am >= s && am <= e;
                  };
                  const okRange = (startM: number, endM: number) =>
                    within(startM) && within(endM) && abs(startM) <= abs(endM);
                  if (!okRange(bS0 as number, bE0 as number) || !okRange(aS0 as number, aE0 as number)) {
                    toast.error("שעות לא תקינות", { description: "השעות חייבות להיות בתוך טווח המשמרת" });
                    return;
                  }
                  const maxEach = 4 * 60;
                  const durBefore = abs(bE0 as number) - abs(bS0 as number);
                  const durAfter = abs(aE0 as number) - abs(aS0 as number);
                  if (durBefore > maxEach || durAfter > maxEach) {
                    toast.error("שעות לא תקינות", { description: "מקסימום 4 שעות לכל עובד במשיכה" });
                    return;
                  }
                  if (beforeName === afterName) {
                    toast.error("שעות לא תקינות", { description: "בחר שני עובדים שונים" });
                    return;
                  }
                  if (!pullsEditor.required || pullsEditor.required <= 0) {
                    toast.error("לא ניתן ליצור משיכות", { description: "המשמרת לא פעילה / לא נדרש" });
                    return;
                  }
                  const res = await onUpsertPull?.(pullsEditor.key, {
                    before: { name: beforeName, start: pullsEditor.beforeStart, end: pullsEditor.beforeEnd },
                    after: { name: afterName, start: pullsEditor.afterStart, end: pullsEditor.afterEnd },
                  });
                  if (res !== false) setEditor(null);
                }}
              >
                שמירה
              </button>
            </div>
          </div>
        </ModalOverlay>
  );
}

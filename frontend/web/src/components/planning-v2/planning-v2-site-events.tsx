"use client";

import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import LoadingAnimation from "@/components/loading-animation";
import TimePicker from "@/components/time-picker";
import { addDays, formatHebDate, getWeekKeyISO } from "./lib/week";
import { DAY_COLS } from "./lib/station-grid-helpers";
import type { PlanningWorker, SiteEvent } from "./types";
import { ModalOverlay } from "@/components/ui/modal-scroll-lock";

type PlanningV2SiteEventsProps = {
  siteId: string;
  weekStart: Date;
  workers: PlanningWorker[];
  readOnly?: boolean;
  onEventsChange?: (events: SiteEvent[]) => void;
};

type EventDraft = {
  title: string;
  start_time: string;
  end_time: string;
  dates: string[];
  assignments: Record<string, number[]>;
};

const EMPTY_DRAFT: EventDraft = {
  title: "",
  start_time: "",
  end_time: "",
  dates: [],
  assignments: {},
};

function weekIsoDates(weekStart: Date): string[] {
  return Array.from({ length: 7 }, (_, i) => getWeekKeyISO(addDays(weekStart, i)));
}

function dayLabelForIso(weekStart: Date, iso: string): string {
  for (let i = 0; i < 7; i++) {
    if (getWeekKeyISO(addDays(weekStart, i)) === iso) {
      return DAY_COLS[i]?.label || iso;
    }
  }
  return iso;
}

function formatEventTime(ev: SiteEvent): string {
  const a = String(ev.start_time || "").trim();
  const b = String(ev.end_time || "").trim();
  if (a && b) return `${a}–${b}`;
  if (a) return a;
  if (b) return b;
  return "";
}

function workerNameById(workers: PlanningWorker[], id: number): string {
  return workers.find((w) => w.id === id)?.name || `#${id}`;
}

export function PlanningV2SiteEvents({
  siteId,
  weekStart,
  workers,
  readOnly = false,
  onEventsChange,
}: PlanningV2SiteEventsProps) {
  const [weekEvents, setWeekEvents] = useState<SiteEvent[]>([]);
  const [allEvents, setAllEvents] = useState<SiteEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isListOpen, setIsListOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<EventDraft>(EMPTY_DRAFT);
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const [datePickerMonth, setDatePickerMonth] = useState(
    () => new Date(weekStart.getFullYear(), weekStart.getMonth(), 1),
  );
  const [workerPickerDateIso, setWorkerPickerDateIso] = useState<string | null>(null);
  const [workerConflict, setWorkerConflict] = useState<{
    workerId: number;
    targetDateIso: string;
    otherDateIsos: string[];
  } | null>(null);

  const weekDates = useMemo(() => weekIsoDates(weekStart), [weekStart]);
  const wk = useMemo(() => getWeekKeyISO(weekStart), [weekStart]);

  const refreshWeekEvents = useCallback(async () => {
    const id = Number(siteId);
    if (!id) return;
    try {
      setLoading(true);
      const res = await apiFetch<SiteEvent[]>(
        `/director/sites/${siteId}/events?week=${encodeURIComponent(wk)}`,
      );
      const list = Array.isArray(res) ? res : [];
      setWeekEvents(list);
      onEventsChange?.(list);
    } catch {
      setWeekEvents([]);
      onEventsChange?.([]);
      toast.error("לא ניתן לטעון אירועים");
    } finally {
      setLoading(false);
    }
  }, [siteId, wk, onEventsChange]);

  const refreshAllEvents = useCallback(async () => {
    const id = Number(siteId);
    if (!id) return;
    try {
      const res = await apiFetch<SiteEvent[]>(`/director/sites/${siteId}/events`);
      setAllEvents(Array.isArray(res) ? res : []);
    } catch {
      setAllEvents([]);
      toast.error("לא ניתן לטעון את רשימת האירועים");
    }
  }, [siteId]);

  useEffect(() => {
    void refreshWeekEvents();
  }, [refreshWeekEvents]);

  function openCreate() {
    setEditingId(null);
    setDraft({
      ...EMPTY_DRAFT,
      dates: weekDates.length ? [weekDates[0]] : [],
      assignments: {},
    });
    setIsEditorOpen(true);
  }

  function openEdit(ev: SiteEvent) {
    setEditingId(ev.id);
    setDraft({
      title: ev.title || "",
      start_time: ev.start_time || "",
      end_time: ev.end_time || "",
      dates: [...(ev.dates || [])],
      assignments: { ...(ev.assignments || {}) },
    });
    setIsListOpen(false);
    setIsEditorOpen(true);
  }

  function closeEditor() {
    setIsEditorOpen(false);
    setIsDatePickerOpen(false);
    setWorkerPickerDateIso(null);
    setWorkerConflict(null);
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  }

  function openDatePicker() {
    setDatePickerMonth(new Date(weekStart.getFullYear(), weekStart.getMonth(), 1));
    setIsDatePickerOpen(true);
  }

  function pickCustomDate(date: Date) {
    const iso = getWeekKeyISO(date);
    if (draft.dates.includes(iso)) {
      toggleDate(iso);
    } else {
      addCustomDate(iso);
    }
    setIsDatePickerOpen(false);
  }

  function toggleDate(iso: string) {
    setDraft((prev) => {
      const has = prev.dates.includes(iso);
      const dates = has ? prev.dates.filter((d) => d !== iso) : [...prev.dates, iso].sort();
      const assignments = { ...prev.assignments };
      if (has) delete assignments[iso];
      else assignments[iso] = assignments[iso] || [];
      return { ...prev, dates, assignments };
    });
  }

  function addCustomDate(iso: string) {
    const cleaned = String(iso || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
      toast.error("תאריך לא תקין");
      return;
    }
    setDraft((prev) => {
      if (prev.dates.includes(cleaned)) return prev;
      return {
        ...prev,
        dates: [...prev.dates, cleaned].sort(),
        assignments: { ...prev.assignments, [cleaned]: prev.assignments[cleaned] || [] },
      };
    });
  }

  function otherDatesForWorker(workerId: number, exceptDateIso: string): string[] {
    return draft.dates.filter((iso) => {
      if (iso === exceptDateIso) return false;
      return (draft.assignments[iso] || []).includes(workerId);
    });
  }

  function toggleWorker(dateIso: string, workerId: number) {
    setDraft((prev) => {
      const cur = prev.assignments[dateIso] || [];
      const next = cur.includes(workerId) ? cur.filter((x) => x !== workerId) : [...cur, workerId];
      return {
        ...prev,
        assignments: { ...prev.assignments, [dateIso]: next },
      };
    });
  }

  function handleWorkerPick(dateIso: string, workerId: number) {
    const onThisDate = (draft.assignments[dateIso] || []).includes(workerId);
    if (onThisDate) {
      toggleWorker(dateIso, workerId);
      return;
    }
    const otherDateIsos = otherDatesForWorker(workerId, dateIso);
    if (otherDateIsos.length > 0) {
      setWorkerConflict({ workerId, targetDateIso: dateIso, otherDateIsos });
      return;
    }
    toggleWorker(dateIso, workerId);
  }

  function applyWorkerReplaceDate() {
    if (!workerConflict) return;
    const { workerId, targetDateIso, otherDateIsos } = workerConflict;
    setDraft((prev) => {
      const assignments = { ...prev.assignments };
      for (const iso of otherDateIsos) {
        assignments[iso] = (assignments[iso] || []).filter((id) => id !== workerId);
      }
      const cur = assignments[targetDateIso] || [];
      assignments[targetDateIso] = cur.includes(workerId) ? cur : [...cur, workerId];
      return { ...prev, assignments };
    });
    setWorkerConflict(null);
  }

  function applyWorkerKeepBothDates() {
    if (!workerConflict) return;
    const { workerId, targetDateIso } = workerConflict;
    setDraft((prev) => {
      const cur = prev.assignments[targetDateIso] || [];
      if (cur.includes(workerId)) return prev;
      return {
        ...prev,
        assignments: { ...prev.assignments, [targetDateIso]: [...cur, workerId] },
      };
    });
    setWorkerConflict(null);
  }

  async function saveEvent() {
    const title = draft.title.trim();
    if (!title) {
      toast.error("נא להזין כותרת");
      return;
    }
    if (draft.dates.length === 0) {
      toast.error("נא לבחור לפחות תאריך אחד");
      return;
    }
    const payload = {
      title,
      start_time: draft.start_time.trim() || null,
      end_time: draft.end_time.trim() || null,
      dates: draft.dates,
      assignments: draft.assignments,
    };
    setSaving(true);
    try {
      if (editingId) {
        await apiFetch<SiteEvent>(`/director/sites/${siteId}/events/${editingId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        toast.success("האירוע עודכן");
      } else {
        await apiFetch<SiteEvent>(`/director/sites/${siteId}/events`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        toast.success("האירוע נוסף");
      }
      closeEditor();
      await refreshWeekEvents();
      if (isListOpen) await refreshAllEvents();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "נסה שוב";
      toast.error("שמירת האירוע נכשלה", { description: msg });
    } finally {
      setSaving(false);
    }
  }

  async function deleteEvent(ev: SiteEvent) {
    const ok = typeof window !== "undefined" && window.confirm(`למחוק את האירוע "${ev.title}"?`);
    if (!ok) return;
    try {
      await apiFetch(`/director/sites/${siteId}/events/${ev.id}`, { method: "DELETE" });
      toast.success("האירוע נמחק");
      await refreshWeekEvents();
      await refreshAllEvents();
    } catch {
      toast.error("מחיקת האירוע נכשלה");
    }
  }

  const idNum = Number(siteId);
  if (!Number.isFinite(idNum) || idNum <= 0) return null;

  return (
    <>
      <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-zinc-600 dark:text-zinc-300">אירועים</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={readOnly || weekEvents.length === 0}
              title={
                readOnly
                  ? "אתר בארכיון — צפייה בלבד"
                  : weekEvents.length === 0
                    ? "אין אירועים לעריכה"
                    : undefined
              }
              className={
                readOnly || weekEvents.length === 0
                  ? "inline-flex cursor-not-allowed items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-400 opacity-60 dark:border-zinc-700 dark:text-zinc-600"
                  : "inline-flex items-center gap-2 rounded-md border border-amber-700 px-3 py-2 text-sm text-amber-800 hover:bg-amber-50 dark:border-amber-600 dark:text-amber-300 dark:hover:bg-amber-950/30"
              }
              onClick={() => {
                if (readOnly || weekEvents.length === 0) return;
                void refreshAllEvents().then(() => setIsListOpen(true));
              }}
            >
              ערוך
            </button>
            <button
              type="button"
              disabled={readOnly}
              title={readOnly ? "אתר בארכיון — צפייה בלבד" : undefined}
              className={
                readOnly
                  ? "inline-flex cursor-not-allowed items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-400 opacity-60 dark:border-zinc-700 dark:text-zinc-600"
                  : "inline-flex items-center gap-2 rounded-md border border-green-600 px-3 py-2 text-sm text-green-600 hover:bg-green-50 dark:border-green-500 dark:text-green-400 dark:hover:bg-green-900/30"
              }
              onClick={() => {
                if (readOnly) return;
                openCreate();
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M19 11H13V5h-2v6H5v2h6v6h2v-6h6v-2z" />
              </svg>
              הוסף אירוע
            </button>
          </div>
        </div>

        {loading ? (
          <LoadingAnimation className="py-4" size={60} />
        ) : weekEvents.length === 0 ? (
          <div className="text-sm text-zinc-500">אין אירועים לשבוע זה</div>
        ) : (
          <div className="space-y-2">
            {weekEvents.map((ev) => {
              const timeLabel = formatEventTime(ev);
              const weekDatesOfEv = (ev.dates || []).filter((d) => weekDates.includes(d));
              return (
                <div key={ev.id} className="rounded-md border p-3 dark:border-zinc-700">
                  <div className="font-semibold text-zinc-900 dark:text-zinc-100">{ev.title}</div>
                  {timeLabel ? (
                    <div className="mt-0.5 text-xs text-zinc-500">שעות: {timeLabel}</div>
                  ) : null}
                  <div className="mt-2 space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
                    {weekDatesOfEv.map((d) => {
                      const ids = ev.assignments?.[d] || [];
                      const names = ids.map((id) => workerNameById(workers, id));
                      return (
                        <div key={d}>
                          <span className="font-medium">
                            {dayLabelForIso(weekStart, d)} ({formatHebDate(new Date(`${d}T00:00:00`))})
                          </span>
                          {": "}
                          {names.length ? names.join(", ") : "—"}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {isListOpen ? (
        <ModalOverlay
          className="z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setIsListOpen(false)}
        >
          <div
            className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-xl border bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-950"
            dir="rtl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-lg font-semibold">עריכת אירועים</div>
              <button
                type="button"
                className="rounded-md border px-2 py-1 text-sm dark:border-zinc-700"
                onClick={() => setIsListOpen(false)}
              >
                סגור
              </button>
            </div>
            {allEvents.length === 0 ? (
              <div className="text-sm text-zinc-500">אין אירועים</div>
            ) : (
              <div className="space-y-2">
                {[...allEvents]
                  .sort((a, b) => String(a.dates?.[0] || "").localeCompare(String(b.dates?.[0] || "")))
                  .map((ev) => (
                    <div
                      key={ev.id}
                      className="flex items-start justify-between gap-2 rounded-md border p-3 dark:border-zinc-700"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{ev.title}</div>
                        <div className="mt-1 text-xs text-zinc-500">
                          {(ev.dates || []).map((d) => formatHebDate(new Date(`${d}T00:00:00`))).join(", ")}
                          {formatEventTime(ev) ? ` · ${formatEventTime(ev)}` : ""}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          className="rounded-md border border-[#00A8E0] px-2 py-1 text-xs text-[#00A8E0]"
                          onClick={() => openEdit(ev)}
                        >
                          ערוך
                        </button>
                        <button
                          type="button"
                          className="rounded-md border border-red-500 px-2 py-1 text-xs text-red-600"
                          onClick={() => void deleteEvent(ev)}
                        >
                          מחק
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </ModalOverlay>
      ) : null}

      {isEditorOpen ? (
        <ModalOverlay
          className="z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={closeEditor}
        >
          <div
            className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-xl border bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-950"
            dir="rtl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 text-lg font-semibold">{editingId ? "עריכת אירוע" : "הוסף אירוע"}</div>

            <label className="mb-3 block text-sm">
              <span className="mb-1 block font-medium">כותרת</span>
              <input
                type="text"
                value={draft.title}
                onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
                className="w-full rounded-md border px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                placeholder="שם האירוע"
              />
            </label>

            <div className="mb-3 grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="mb-1 block font-medium">שעת התחלה (אופציונלי)</span>
                <TimePicker
                  value={draft.start_time}
                  onChange={(v) => setDraft((p) => ({ ...p, start_time: v }))}
                  dir="ltr"
                  className="w-full rounded-md border px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium">שעת סיום (אופציונלי)</span>
                <TimePicker
                  value={draft.end_time}
                  onChange={(v) => setDraft((p) => ({ ...p, end_time: v }))}
                  dir="ltr"
                  className="w-full rounded-md border px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
            </div>

            <div className="mb-3">
              <div className="mb-1 text-sm font-medium">תאריכים</div>
              <div className="flex flex-wrap justify-center gap-2">
                {weekDates.map((iso, i) => {
                  const active = draft.dates.includes(iso);
                  return (
                    <button
                      key={iso}
                      type="button"
                      onClick={() => toggleDate(iso)}
                      className={
                        "rounded-md border px-2 py-1 text-xs " +
                        (active
                          ? "border-[#00A8E0] bg-[#00A8E0] text-white"
                          : "border-zinc-300 dark:border-zinc-700")
                      }
                    >
                      {DAY_COLS[i]?.label} {formatHebDate(new Date(`${iso}T00:00:00`))}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 flex justify-center">
                <button
                  type="button"
                  onClick={openDatePicker}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#00A8E0] px-2.5 py-1.5 text-xs font-medium text-[#00A8E0] hover:bg-[#00A8E0]/10 dark:border-[#00A8E0] dark:text-[#00A8E0] dark:hover:bg-[#00A8E0]/20"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
                    <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z" />
                    <path d="M7 14h5v5H7z" />
                  </svg>
                  הוסף תאריך מלוח שנה
                </button>
              </div>
              {draft.dates.filter((d) => !weekDates.includes(d)).length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {draft.dates
                    .filter((d) => !weekDates.includes(d))
                    .map((iso) => (
                      <button
                        key={iso}
                        type="button"
                        onClick={() => toggleDate(iso)}
                        className="rounded-md border border-[#00A8E0] bg-[#00A8E0] px-2 py-1 text-xs text-white"
                      >
                        {formatHebDate(new Date(`${iso}T00:00:00`))} ×
                      </button>
                    ))}
                </div>
              ) : null}
            </div>

            <div className="mb-4">
              <div className="mb-2 text-sm font-medium">עובדים לפי תאריך</div>
              {draft.dates.length === 0 ? (
                <div className="text-sm text-zinc-500">בחר תאריכים כדי לשייך עובדים</div>
              ) : (
                <div className="max-h-56 space-y-3 overflow-y-auto overscroll-contain rounded-md border border-zinc-200 p-2 dark:border-zinc-700">
                  {draft.dates.map((iso) => {
                    const selectedIds = draft.assignments[iso] || [];
                    return (
                      <div key={iso} className="rounded-md border p-2 dark:border-zinc-700">
                        <div className="mb-2 text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                          {dayLabelForIso(weekStart, iso)} · {formatHebDate(new Date(`${iso}T00:00:00`))}
                        </div>
                        {selectedIds.length > 0 ? (
                          <div className="mb-2 flex flex-wrap justify-center gap-2">
                            {selectedIds.map((wid) => (
                              <button
                                key={wid}
                                type="button"
                                onClick={() => toggleWorker(iso, wid)}
                                className="rounded-md border border-[#00A8E0] bg-[#00A8E0] px-2 py-1 text-xs text-white"
                                title="הסר עובד"
                              >
                                {workerNameById(workers, wid)} ×
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="mb-2 text-center text-xs text-zinc-500">לא נבחרו עובדים</div>
                        )}
                        <div className="flex justify-center">
                          <button
                            type="button"
                            disabled={workers.length === 0}
                            onClick={() => setWorkerPickerDateIso(iso)}
                            className="inline-flex items-center gap-1.5 rounded-md border border-[#00A8E0] px-2.5 py-1.5 text-xs font-medium text-[#00A8E0] hover:bg-[#00A8E0]/10 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            בחר עובד
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={closeEditor}
                disabled={saving}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6] disabled:opacity-60"
                onClick={() => void saveEvent()}
                disabled={saving}
              >
                {saving ? "שומר…" : "אישור"}
              </button>
            </div>
          </div>
        </ModalOverlay>
      ) : null}

      {isDatePickerOpen ? (
        <ModalOverlay
          className="z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setIsDatePickerOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg border bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
            dir="rtl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">בחר תאריך</h3>
              <button
                type="button"
                onClick={() => setIsDatePickerOpen(false)}
                className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                aria-label="סגור"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
              </button>
            </div>
            <div className="mb-4 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  const nextMonth = new Date(datePickerMonth);
                  nextMonth.setMonth(nextMonth.getMonth() + 1);
                  setDatePickerMonth(nextMonth);
                }}
                className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                aria-label="חודש הבא"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" />
                </svg>
              </button>
              <span className="text-lg font-medium">
                {new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric" }).format(datePickerMonth)}
              </span>
              <button
                type="button"
                onClick={() => {
                  const prevMonth = new Date(datePickerMonth);
                  prevMonth.setMonth(prevMonth.getMonth() - 1);
                  setDatePickerMonth(prevMonth);
                }}
                className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                aria-label="חודש קודם"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                </svg>
              </button>
            </div>
            <div className="mb-2 grid grid-cols-7 gap-1">
              {["א", "ב", "ג", "ד", "ה", "ו", "ש"].map((day) => (
                <div key={day} className="p-2 text-center text-sm font-medium text-zinc-600 dark:text-zinc-400">
                  {day}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {(() => {
                const year = datePickerMonth.getFullYear();
                const month = datePickerMonth.getMonth();
                const firstDay = new Date(year, month, 1);
                const startDate = new Date(firstDay);
                startDate.setDate(startDate.getDate() - firstDay.getDay());
                const days: ReactElement[] = [];
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const selectedSet = new Set(draft.dates);

                for (let i = 0; i < 42; i++) {
                  const date = new Date(startDate);
                  date.setDate(startDate.getDate() + i);
                  date.setHours(0, 0, 0, 0);
                  const iso = getWeekKeyISO(date);
                  const isCurrentMonth = date.getMonth() === month;
                  const isToday = date.getTime() === today.getTime();
                  const isSelected = selectedSet.has(iso);
                  const isWeekDate = weekDates.includes(iso);

                  days.push(
                    <button
                      key={i}
                      type="button"
                      onClick={() => pickCustomDate(date)}
                      className={[
                        "relative flex flex-col items-center rounded p-2 text-sm",
                        !isCurrentMonth ? "text-zinc-300 dark:text-zinc-600" : "",
                        isSelected ? "bg-[#00A8E0] font-semibold text-white" : "",
                        isToday && !isSelected ? "border border-[#00A8E0]" : "",
                        isWeekDate && isCurrentMonth && !isSelected && !isToday
                          ? "bg-[#00A8E0]/15"
                          : "",
                        isCurrentMonth && !isSelected ? "text-zinc-700 dark:text-zinc-300" : "",
                        "hover:bg-zinc-100 dark:hover:bg-zinc-800",
                      ].join(" ")}
                    >
                      <span>{date.getDate()}</span>
                    </button>,
                  );
                }
                return days;
              })()}
            </div>
          </div>
        </ModalOverlay>
      ) : null}

      {workerPickerDateIso ? (
        <ModalOverlay
          className="z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => {
            if (workerConflict) return;
            setWorkerPickerDateIso(null);
          }}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-md flex-col rounded-lg border bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
            dir="rtl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between border-b px-4 py-3 dark:border-zinc-800">
              <div>
                <h3 className="text-lg font-semibold">בחר עובד</h3>
                <div className="text-xs text-zinc-500">
                  {dayLabelForIso(weekStart, workerPickerDateIso)} ·{" "}
                  {formatHebDate(new Date(`${workerPickerDateIso}T00:00:00`))}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setWorkerPickerDateIso(null)}
                className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                aria-label="סגור"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
              </button>
            </div>
            <div className="max-h-[17.5rem] min-h-0 overflow-y-auto overscroll-contain p-3">
              {workers.length === 0 ? (
                <div className="py-6 text-center text-sm text-zinc-500">אין עובדים באתר</div>
              ) : (
                <div className="space-y-1.5">
                  {workers.map((w) => {
                    const active = (draft.assignments[workerPickerDateIso] || []).includes(w.id);
                    const otherDates = otherDatesForWorker(w.id, workerPickerDateIso);
                    const assignedElsewhere = !active && otherDates.length > 0;
                    return (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => handleWorkerPick(workerPickerDateIso, w.id)}
                        className={
                          "flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm text-right " +
                          (active
                            ? "border-[#00A8E0] bg-[#00A8E0] text-white"
                            : assignedElsewhere
                              ? "border-zinc-200 bg-zinc-100 text-zinc-400 opacity-60 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-500"
                              : "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800")
                        }
                      >
                        <span>{w.name}</span>
                        {active ? <span aria-hidden>✓</span> : null}
                        {assignedElsewhere ? (
                          <span className="text-[10px] text-zinc-400">משובץ בתאריך אחר</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex shrink-0 justify-end border-t px-4 py-3 dark:border-zinc-800">
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white"
                onClick={() => setWorkerPickerDateIso(null)}
              >
                אישור
              </button>
            </div>
          </div>
        </ModalOverlay>
      ) : null}

      {workerConflict ? (
        <ModalOverlay
          className="z-[70] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setWorkerConflict(null)}
        >
          <div
            className="w-full max-w-md rounded-lg border bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
            dir="rtl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-lg font-semibold text-[#00A8E0]">שים לב</div>
            <p className="mb-2 text-sm text-zinc-700 dark:text-zinc-200">
              עובד זה כבר שובץ לאירוע זה בתאריך אחר
              {workerConflict.otherDateIsos.length === 1
                ? ` (${formatHebDate(new Date(`${workerConflict.otherDateIsos[0]}T00:00:00`))})`
                : ""}
              .
            </p>
            <p className="mb-4 text-xs text-zinc-500">
              {workerNameById(workers, workerConflict.workerId)} · תאריך נבחר:{" "}
              {formatHebDate(new Date(`${workerConflict.targetDateIso}T00:00:00`))}
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-3 py-2 text-sm text-white"
                onClick={applyWorkerReplaceDate}
              >
                החלף את התאריך בתאריך זה
              </button>
              <button
                type="button"
                className="rounded-md border border-[#00A8E0] px-3 py-2 text-sm font-medium text-[#00A8E0]"
                onClick={applyWorkerKeepBothDates}
              >
                שייך לשני התאריכים
              </button>
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm dark:border-zinc-700"
                onClick={() => setWorkerConflict(null)}
              >
                ביטול
              </button>
            </div>
          </div>
        </ModalOverlay>
      ) : null}
    </>
  );
}

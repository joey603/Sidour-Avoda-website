"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import LoadingAnimation from "@/components/loading-animation";
import { addDays, formatHebDate, getWeekKeyISO } from "./lib/week";
import { DAY_COLS } from "./lib/station-grid-helpers";
import type { PlanningWorker, SiteEvent } from "./types";

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
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
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
              disabled={readOnly}
              title={readOnly ? "אתר בארכיון — צפייה בלבד" : undefined}
              className={
                readOnly
                  ? "inline-flex cursor-not-allowed items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-400 opacity-60 dark:border-zinc-700 dark:text-zinc-600"
                  : "inline-flex items-center gap-2 rounded-md border border-amber-700 px-3 py-2 text-sm text-amber-800 hover:bg-amber-50 dark:border-amber-600 dark:text-amber-300 dark:hover:bg-amber-950/30"
              }
              onClick={() => {
                if (readOnly) return;
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
                  : "inline-flex items-center gap-2 rounded-md border border-[#722F37] px-3 py-2 text-sm text-[#722F37] hover:bg-[#722F37]/10 dark:border-[#a85a62] dark:text-[#d4a0a6] dark:hover:bg-[#722F37]/20"
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
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
                          className="rounded-md border border-[#722F37] px-2 py-1 text-xs text-[#722F37]"
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
        </div>
      ) : null}

      {isEditorOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
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
                <input
                  type="time"
                  value={draft.start_time}
                  onChange={(e) => setDraft((p) => ({ ...p, start_time: e.target.value }))}
                  className="w-full rounded-md border px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium">שעת סיום (אופציונלי)</span>
                <input
                  type="time"
                  value={draft.end_time}
                  onChange={(e) => setDraft((p) => ({ ...p, end_time: e.target.value }))}
                  className="w-full rounded-md border px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
            </div>

            <div className="mb-3">
              <div className="mb-1 text-sm font-medium">תאריכים</div>
              <div className="flex flex-wrap gap-2">
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
                          ? "border-[#722F37] bg-[#722F37] text-white"
                          : "border-zinc-300 dark:border-zinc-700")
                      }
                    >
                      {DAY_COLS[i]?.label} {formatHebDate(new Date(`${iso}T00:00:00`))}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="date"
                  id="event-extra-date"
                  className="rounded-md border px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
                <button
                  type="button"
                  className="rounded-md border px-2 py-1 text-xs dark:border-zinc-700"
                  onClick={() => {
                    const el = document.getElementById("event-extra-date") as HTMLInputElement | null;
                    if (el?.value) addCustomDate(el.value);
                  }}
                >
                  הוסף תאריך
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
                        className="rounded-md border border-[#722F37] bg-[#722F37] px-2 py-1 text-xs text-white"
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
                <div className="max-h-48 space-y-3 overflow-y-auto overscroll-contain rounded-md border border-zinc-200 p-2 dark:border-zinc-700">
                  {draft.dates.map((iso) => (
                    <div key={iso} className="rounded-md border p-2 dark:border-zinc-700">
                      <div className="mb-2 text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                        {dayLabelForIso(weekStart, iso)} · {formatHebDate(new Date(`${iso}T00:00:00`))}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {workers.length === 0 ? (
                          <span className="text-xs text-zinc-500">אין עובדים באתר</span>
                        ) : (
                          workers.map((w) => {
                            const active = (draft.assignments[iso] || []).includes(w.id);
                            return (
                              <button
                                key={w.id}
                                type="button"
                                onClick={() => toggleWorker(iso, w.id)}
                                className={
                                  "rounded-md border px-2 py-1 text-xs " +
                                  (active
                                    ? "border-[#722F37] bg-[#722F37] text-white"
                                    : "border-zinc-300 dark:border-zinc-700")
                                }
                              >
                                {w.name}
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm dark:border-zinc-700"
                onClick={closeEditor}
                disabled={saving}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md bg-[#722F37] px-3 py-2 text-sm text-white disabled:opacity-60"
                onClick={() => void saveEvent()}
                disabled={saving}
              >
                {saving ? "שומר…" : "אישור"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

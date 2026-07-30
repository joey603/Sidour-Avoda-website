import type { PlanningWorker, SiteEvent } from "../types";
import { addDays, formatHebDate, getWeekKeyISO } from "./week";
import { DAY_COLS } from "./station-grid-helpers";

export const EVENT_BORDEAUX = "722F37";
export const EVENT_BORDEAUX_CSS = "#722F37";

export type EventExportOccurrence = {
  eventId: number;
  title: string;
  dateIso: string;
  dayLabel: string;
  dateLabel: string;
  workerNames: string[];
};

function dayLabelForIso(weekStart: Date, iso: string): string {
  for (let i = 0; i < 7; i++) {
    if (getWeekKeyISO(addDays(weekStart, i)) === iso) {
      return DAY_COLS[i]?.label || iso;
    }
  }
  return iso;
}

function workerNameById(workers: PlanningWorker[], id: number): string {
  return workers.find((w) => w.id === id)?.name || `#${id}`;
}

/** Une occurrence = (événement × date de la semaine courante). */
export function buildEventExportOccurrences(params: {
  events: SiteEvent[] | null | undefined;
  weekStart: Date;
  workers: PlanningWorker[];
}): EventExportOccurrence[] {
  const { events, weekStart, workers } = params;
  const weekDates = new Set(Array.from({ length: 7 }, (_, i) => getWeekKeyISO(addDays(weekStart, i))));
  const out: EventExportOccurrence[] = [];
  for (const ev of events || []) {
    for (const dateIso of ev.dates || []) {
      if (!weekDates.has(dateIso)) continue;
      const ids = ev.assignments?.[dateIso] || [];
      out.push({
        eventId: ev.id,
        title: String(ev.title || "").trim() || "אירוע",
        dateIso,
        dayLabel: dayLabelForIso(weekStart, dateIso),
        dateLabel: formatHebDate(new Date(`${dateIso}T00:00:00`)),
        workerNames: ids.map((id) => workerNameById(workers, id)),
      });
    }
  }
  out.sort((a, b) => a.dateIso.localeCompare(b.dateIso) || a.title.localeCompare(b.title, "he"));
  return out;
}

/** HTML petit tableau style מאבטח — en-tête bordeaux. */
export function buildEventTablesHtml(occurrences: EventExportOccurrence[]): string {
  if (!occurrences.length) return "";
  const CELL =
    "border:1px solid #000;padding:3px 6px;text-align:center;font-family:Arial,sans-serif;font-size:11px;";
  return occurrences
    .map((occ, i) => {
      const header = `${escapeHtml(occ.title)} · ${escapeHtml(occ.dayLabel)} ${escapeHtml(occ.dateLabel)}`;
      const rows =
        occ.workerNames.length === 0
          ? `<tr><td colspan="3" style="${CELL}background:#fff;color:#000;">—</td></tr>`
          : occ.workerNames
              .map(
                (nm) =>
                  `<tr><td colspan="3" style="${CELL}background:#fff;color:#000;">${escapeHtml(nm)}</td></tr>`,
              )
              .join("");
      const top = i === 0 ? "0" : "8px";
      return `<table dir="rtl" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#fff;width:100%;margin-top:${top};">
  <tr><td colspan="3" style="${CELL}background:${EVENT_BORDEAUX_CSS};color:#fff;font-weight:bold;">${header}</td></tr>
  ${rows}
</table>`;
    })
    .join("");
}

function escapeHtml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

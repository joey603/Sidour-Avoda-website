import { addDays, getWeekKeyISO } from "./week";
import { DAY_COLS, hoursFromConfig, hoursOf, shiftNamesFromSite } from "./station-grid-helpers";
import { displayShiftOrderIndex } from "./display";
import type { PlanningWorker, SiteSummary } from "../types";

export type SiteEventAssignmentMap = Record<string, number[]>;

export type SiteEventLike = {
  id: number;
  title: string;
  start_time?: string | null;
  end_time?: string | null;
  dates: string[];
  assignments: SiteEventAssignmentMap;
};

/** workerId → dayKey → shift names locked (bordeaux, non cliquable). */
export type EventAvailabilityLocksByWorkerId = Record<number, Record<string, string[]>>;

const DAY_KEYS: readonly string[] = DAY_COLS.map((d) => d.key);

function parseHmToMinutes(hm: string | null | undefined): number | null {
  const raw = String(hm || "").trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

function parseHoursRange(hours: string | null): { fromMin: number; toMin: number } | null {
  if (!hours) return null;
  const m = String(hours).match(/(\d{1,2})\s*[-:–]\s*(\d{1,2})/);
  if (!m) return null;
  const fromMin = Number(m[1]) * 60;
  const toRaw = Number(m[2]) * 60;
  if (!Number.isFinite(fromMin) || !Number.isFinite(toRaw)) return null;
  return { fromMin, toMin: toRaw };
}

function isoToDayKey(weekStart: Date, iso: string): string | null {
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    if (getWeekKeyISO(d) === iso) return DAY_KEYS[i] || null;
  }
  return null;
}

function prevDayKey(dayKey: string): string | null {
  const idx = DAY_KEYS.indexOf(dayKey);
  if (idx <= 0) return null;
  return DAY_KEYS[idx - 1] || null;
}

function sortedShiftNames(site: SiteSummary | null): string[] {
  const names = shiftNamesFromSite(site);
  return [...names].sort((a, b) => displayShiftOrderIndex(a) - displayShiftOrderIndex(b));
}

function shiftStartMinutes(site: SiteSummary | null, shiftName: string): number | null {
  const stations = (site?.config?.stations || []) as unknown[];
  for (const st of stations) {
    const h = hoursFromConfig(st, shiftName) || hoursOf(shiftName);
    const parsed = parseHoursRange(h);
    if (parsed) return parsed.fromMin;
  }
  const fallback = parseHoursRange(hoursOf(shiftName));
  return fallback?.fromMin ?? null;
}

function addLock(
  out: EventAvailabilityLocksByWorkerId,
  workerId: number,
  dayKey: string,
  shiftName: string,
) {
  if (!dayKey || !shiftName) return;
  if (!out[workerId]) out[workerId] = {};
  const day = out[workerId][dayKey] || [];
  if (!day.includes(shiftName)) day.push(shiftName);
  out[workerId][dayKey] = day;
}

/**
 * Calcule les créneaux זמינות verrouillés par affectation à un événement.
 * - Toutes les gardes du jour de l'événement
 * - Garde précédente chronologique (nuit de la veille si matin / journée entière)
 * - Si end_time : gardes du même jour dont le début est à moins de 8 h après la fin
 */
export function buildEventAvailabilityLocks(params: {
  events: SiteEventLike[];
  weekStart: Date;
  site: SiteSummary | null;
}): EventAvailabilityLocksByWorkerId {
  const { events, weekStart, site } = params;
  const shifts = sortedShiftNames(site);
  const out: EventAvailabilityLocksByWorkerId = {};
  if (shifts.length === 0) return out;

  const lastShift = shifts[shifts.length - 1];

  for (const ev of events || []) {
    const dates = Array.isArray(ev.dates) ? ev.dates : [];
    const assignments = ev.assignments || {};
    const startMin = parseHmToMinutes(ev.start_time);
    const endMin = parseHmToMinutes(ev.end_time);

    for (const dateIso of dates) {
      const dayKey = isoToDayKey(weekStart, dateIso);
      if (!dayKey) continue;
      const workerIds = assignments[dateIso] || [];
      if (!Array.isArray(workerIds) || workerIds.length === 0) continue;

      for (const widRaw of workerIds) {
        const workerId = Number(widRaw);
        if (!Number.isFinite(workerId) || workerId <= 0) continue;

        // 1) Toutes les gardes du jour
        for (const sn of shifts) {
          addLock(out, workerId, dayKey, sn);
        }

        // 2) Garde précédente (nuit de la veille pour un événement matin / journée)
        // Si horaire : première garde dont le début est >= start, sinon première garde du jour
        let eventShiftIdx = 0;
        if (startMin != null) {
          const found = shifts.findIndex((sn) => {
            const s = shiftStartMinutes(site, sn);
            return s != null && s >= startMin;
          });
          eventShiftIdx = found >= 0 ? found : 0;
        }
        if (eventShiftIdx === 0) {
          const prev = prevDayKey(dayKey);
          if (prev && lastShift) addLock(out, workerId, prev, lastShift);
        } else {
          addLock(out, workerId, dayKey, shifts[eventShiftIdx - 1]);
        }

        // 3) Règle 8 h après end_time
        if (endMin != null) {
          for (const sn of shifts) {
            const s = shiftStartMinutes(site, sn);
            if (s == null) continue;
            let gap = s - endMin;
            // Garde de nuit qui commence le soir (ex. 22h) après un événement finissant tôt → gap positif
            // Si la garde commence « avant » end (overnight), gap négatif : ajouter 24h
            if (gap < 0) gap += 24 * 60;
            if (gap > 0 && gap < 8 * 60) {
              addLock(out, workerId, dayKey, sn);
            }
          }
        }
      }
    }
  }

  return out;
}

export function locksForWorkerName(
  locksById: EventAvailabilityLocksByWorkerId,
  workers: PlanningWorker[],
  workerName: string,
): Record<string, string[]> {
  const trimmed = String(workerName || "").trim();
  if (!trimmed) return {};
  const w = workers.find((x) => String(x.name || "").trim() === trimmed);
  if (!w?.id) return {};
  return locksById[w.id] || {};
}

/** Retire les créneaux verrouillés de la map זמינות (pour IA / checks). */
export function stripEventLocksFromAvailabilityMap(
  availabilityByWorkerName: Record<string, Record<string, string[]>>,
  locksById: EventAvailabilityLocksByWorkerId,
  workers: PlanningWorker[],
): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  for (const [name, avail] of Object.entries(availabilityByWorkerName || {})) {
    const locks = locksForWorkerName(locksById, workers, name);
    const next: Record<string, string[]> = { ...avail };
    for (const [dayKey, shifts] of Object.entries(locks)) {
      const locked = new Set(shifts);
      const list = Array.isArray(next[dayKey]) ? next[dayKey] : [];
      next[dayKey] = list.filter((sn) => !locked.has(sn));
    }
    // preserve _stations if present
    if (Array.isArray((avail as { _stations?: string[] })._stations)) {
      (next as { _stations?: string[] })._stations = [...(avail as { _stations?: string[] })._stations!];
    }
    out[name] = next;
  }
  return out;
}

export function isShiftLockedByEvent(
  locks: Record<string, string[]> | undefined,
  dayKey: string,
  shiftName: string,
): boolean {
  if (!locks) return false;
  return (locks[dayKey] || []).includes(shiftName);
}

/** Chaque date d'événement affectée compte comme 1 שיבוץ / garde. */
export function countEventAssignmentsPerWorkerName(
  events: SiteEventLike[],
  weekStart: Date,
  workers: PlanningWorker[],
): Map<string, number> {
  const weekDates = new Set(Array.from({ length: 7 }, (_, i) => getWeekKeyISO(addDays(weekStart, i))));
  const idToName = new Map<number, string>();
  for (const w of workers || []) {
    const nm = String(w.name || "").trim();
    if (nm && Number.isFinite(w.id)) idToName.set(Number(w.id), nm);
  }
  const counts = new Map<string, number>();
  for (const ev of events || []) {
    for (const dateIso of ev.dates || []) {
      if (!weekDates.has(dateIso)) continue;
      for (const widRaw of ev.assignments?.[dateIso] || []) {
        const wid = Number(widRaw);
        const name = idToName.get(wid);
        if (!name) continue;
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
  }
  return counts;
}

export function addEventCountsToAssignmentCounts(
  base: Map<string, number>,
  eventCounts: Map<string, number>,
): Map<string, number> {
  const out = new Map(base);
  for (const [name, n] of eventCounts) {
    if (!n) continue;
    out.set(name, (out.get(name) || 0) + n);
  }
  return out;
}

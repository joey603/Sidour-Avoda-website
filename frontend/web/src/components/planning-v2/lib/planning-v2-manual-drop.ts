import type { PlanningWorker } from "../types";

export type ManualDragSource = {
  dayKey: string;
  shiftName: string;
  stationIndex: number;
  slotIndex: number;
  workerName: string;
};

function normName(s: string): string {
  return String(s || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

function isMorning(n?: string) {
  return !!n && (/בוקר/.test(n) || /^0?6/.test(n) || /06-14/i.test(n));
}
function isNoon(n?: string) {
  return !!n && (/צהר/.test(n) || /^1?4/.test(n) || /14-22/i.test(n));
}
function isNight(n?: string) {
  return !!n && (/לילה/.test(n) || /night/i.test(n) || /^2?2/.test(n) || /22-06/i.test(n));
}

function matchesShift(target: string, list: string[]): boolean {
  if (list.includes(target)) return true;
  if (isMorning(target) && list.some(isMorning)) return true;
  if (isNoon(target) && list.some(isNoon)) return true;
  if (isNight(target) && list.some(isNight)) return true;
  return false;
}

function ensureShiftRow(
  next: Record<string, Record<string, string[][]>>,
  dayKey: string,
  shiftName: string,
  stationsCount: number,
): void {
  if (!next[dayKey]) next[dayKey] = {};
  if (!next[dayKey][shiftName]) next[dayKey][shiftName] = Array.from({ length: stationsCount }, () => []);
  const row = next[dayKey][shiftName];
  if (row.length !== stationsCount) {
    next[dayKey][shiftName] = Array.from({ length: stationsCount }, (_, i) => row[i] || []);
  }
}

/**
 * Applique un drop (ou déplacement) sur une copie des assignations — logique alignée sur le planning (version allégée).
 */
export function applyManualSlotDropToBase(
  baseInput: Record<string, Record<string, string[][]>>,
  args: {
    stationsCount: number;
    dayKey: string;
    shiftName: string;
    stationIndex: number;
    slotIndex: number;
    workerName: string;
    dragSource: ManualDragSource | null;
    isManual: boolean;
    /** זמינות par worker name (merged row) */
    availabilityByWorkerName: Record<string, Record<string, string[]>>;
    workers: PlanningWorker[];
  },
): Record<string, Record<string, string[][]>> | null {
  const trimmed = String(args.workerName || "").trim();
  if (!trimmed) return null;

  const next: Record<string, Record<string, string[][]>> = JSON.parse(JSON.stringify(baseInput || {}));
  const { dayKey, shiftName, stationIndex, slotIndex, stationsCount, dragSource, isManual } = args;

  ensureShiftRow(next, dayKey, shiftName, stationsCount);

  const w = args.workers.find((x) => (x.name || "").trim() === trimmed);
  const effAvail =
    (args.availabilityByWorkerName[trimmed] as Record<string, string[]> | undefined) ||
    ((w?.availability || {}) as Record<string, string[]>);
  const dayList = (effAvail?.[dayKey] || []) as string[];
  const allowed = matchesShift(shiftName, dayList);
  if (!allowed) {
    const ok =
      typeof window !== "undefined" &&
      window.confirm &&
      window.confirm(`לעובד "${trimmed}" אין זמינות למשמרת זו. להקצות בכל זאת?`);
    if (!ok) return null;
  }

  const beforeArr: string[] = Array.from(next[dayKey][shiftName][stationIndex] || []);
  const nextTarget = Array.from(beforeArr as string[]);
  while (nextTarget.length <= slotIndex) nextTarget.push("");
  const nt = normName(trimmed);
  for (let i = 0; i < nextTarget.length; i++) {
    if (normName(nextTarget[i]) === nt) nextTarget[i] = "";
  }
  nextTarget[slotIndex] = trimmed;
  next[dayKey][shiftName][stationIndex] = nextTarget;

  const isMoveFromSlot = !!(
    isManual &&
    dragSource &&
    normName(dragSource.workerName) === nt
  );
  if (isMoveFromSlot && dragSource) {
    try {
      const sameCell =
        dragSource.dayKey === dayKey &&
        dragSource.shiftName === shiftName &&
        Number(dragSource.stationIndex) === Number(stationIndex);
      if (!sameCell || Number(dragSource.slotIndex) !== Number(slotIndex)) {
        ensureShiftRow(next, dragSource.dayKey, dragSource.shiftName, stationsCount);
        const srcArr: string[] = Array.from(next[dragSource.dayKey][dragSource.shiftName][dragSource.stationIndex] || []);
        while (srcArr.length <= dragSource.slotIndex) srcArr.push("");
        srcArr[dragSource.slotIndex] = "";
        next[dragSource.dayKey][dragSource.shiftName][dragSource.stationIndex] = srcArr;
      }
    } catch {
      /* ignore */
    }
  }

  return next;
}

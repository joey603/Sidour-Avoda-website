import type { PlanningV2PullEntry } from "../types";
import { normPullWorkerName } from "../lib/station-grid-helpers";

function isRealPullEntry(entry: unknown): boolean {
  const e = entry as PlanningV2PullEntry | undefined;
  return !!String(e?.before?.name || "").trim() && !!String(e?.after?.name || "").trim();
}

/** Plage שינוי שעות affichée sous le nom (rouge), clé = même slot que משיכה. */
/** Vérifie le format HH:MM et si [start,end] garde est dans la plage משמרת (pour confirmation optionnelle). */
function checkGuardDisplayVsShift(ed: {
  shiftStart: string;
  shiftEnd: string;
  start: string;
  end: string;
}): { formatOk: false } | { formatOk: true; inRange: boolean } {
  const toMinutesLocal = (t: string): number | null => {
    const m = String(t || "").trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  };
  const s0 = toMinutesLocal(ed.shiftStart);
  const e0 = toMinutesLocal(ed.shiftEnd);
  const gS = toMinutesLocal(ed.start);
  const gE = toMinutesLocal(ed.end);
  if ([s0, e0, gS, gE].some((x) => x == null)) return { formatOk: false };
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
  return { formatOk: true, inRange: okRange(gS as number, gE as number) };
}

function guardDisplayTimeForSlot(
  pulls: Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  slotIdx: number,
): string | null {
  if (!pulls) return null;
  const key = `${dayKey}|${shiftName}|${stationIdx}|${slotIdx}`;
  const e = pulls[key] as PlanningV2PullEntry | undefined;
  const s = String(e?.guardDisplay?.start || "").trim();
  const en = String(e?.guardDisplay?.end || "").trim();
  if (s && en) return `${s}–${en}`;
  return null;
}

function normName(s: unknown): string {
  return String(s || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

function draftFixedCellNamesInRow(row: unknown): string[] {
  if (!Array.isArray(row)) return [];
  const out: string[] = [];
  for (const cell of row) {
    if (Array.isArray(cell)) {
      for (const inner of cell) {
        const n = normName(inner);
        if (n) out.push(n);
      }
    } else {
      const n = normName(cell);
      if (n) out.push(n);
    }
  }
  return out;
}

function isWorkerInDraftFixedSnapshot(
  snap: Record<string, Record<string, string[][]>> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  workerName: string,
): boolean {
  if (!snap) return false;
  const row = snap[dayKey]?.[shiftName]?.[stationIdx];
  const names = draftFixedCellNamesInRow(row);
  const n = normName(workerName);
  if (!n) return false;
  return names.includes(n);
}

function shouldShowDraftFixedPinForWorker(
  snap: Record<string, Record<string, string[][]>> | null | undefined,
  isSavedMode: boolean,
  editingSaved: boolean,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  workerName: string,
  cellAssignedNames: string[],
): boolean {
  if (!snap || (isSavedMode && !editingSaved)) return false;
  const snapNames = draftFixedCellNamesInRow(snap[dayKey]?.[shiftName]?.[stationIdx]);
  if (!snapNames.length) return false;
  // Affichage robuste du cadenas: dès que le worker fait partie du snapshot fixe de la cellule.
  // Le planning classique garde aussi ce comportement visuel après génération autour des fixes.
  return isWorkerInDraftFixedSnapshot(snap, dayKey, shiftName, stationIdx, workerName);
}

/** שמור sans עריכה : pas d’interaction sur les bulles d’une משיכה (comme le planning classique). */
function blockSavedViewPullBubble(
  isSavedMode: boolean,
  editingSaved: boolean,
  pulls: Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  workerName: string,
): boolean {
  if (!isSavedMode || editingSaved) return false;
  const nm = normPullWorkerName(String(workerName || ""));
  if (!nm) return false;
  const prefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  for (const [k, v] of Object.entries(pulls || {})) {
    if (!String(k).startsWith(prefix)) continue;
    if (!isRealPullEntry(v)) continue;
    const e = v as PlanningV2PullEntry;
    if (normPullWorkerName(String(e?.before?.name || "")) === nm) return true;
    if (normPullWorkerName(String(e?.after?.name || "")) === nm) return true;
  }
  return false;
}

function truncateMobile6(value: unknown): string {
  const s = String(value ?? "");
  const chars = Array.from(s);
  return chars.length > 6 ? chars.slice(0, 4).join("") + "…" : s;
}

function isRtlName(s: string): boolean {
  return /[\u0590-\u05FF]/.test(String(s || ""));
}

function expandedKeyFor(
  dayKey: string,
  shiftName: string,
  stationIndex: number,
  slotIndex: number,
  token: string,
): string {
  return `${dayKey}|${shiftName}|${stationIndex}|${slotIndex}|${token}`;
}

/** Plage horaire משיכה pour ce nom dans la cellule (affichage lecture seule). */
function pullTimeRangeForName(
  pulls: Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  workerName: string,
): string | null {
  if (!pulls) return null;
  const prefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  const nm = normName(workerName);
  for (const [k, v] of Object.entries(pulls)) {
    if (!String(k).startsWith(prefix)) continue;
    const e = v as {
      before?: { name?: string; start?: string; end?: string };
      after?: { name?: string; start?: string; end?: string };
    };
    if (normName(e?.before?.name) === nm) {
      const s = String(e?.before?.start || "").trim();
      const en = String(e?.before?.end || "").trim();
      if (s && en) return `${s}–${en}`;
    }
    if (normName(e?.after?.name) === nm) {
      const s = String(e?.after?.start || "").trim();
      const en = String(e?.after?.end || "").trim();
      if (s && en) return `${s}–${en}`;
    }
  }
  return null;
}

/** Nombre de משיכות dans la cellule (même préfixe que le planning). */
function countPullEntriesInCell(
  pulls: Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
): number {
  if (!pulls) return 0;
  const prefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  let n = 0;
  for (const k of Object.keys(pulls)) {
    if (!String(k).startsWith(prefix)) continue;
    if (isRealPullEntry(pulls[k])) n++;
  }
  return n;
}

/**
 * Tableau de slots (ordre préservé) + injection des noms משיכה dans les trous,
 * comme `cellRaw` dans le planning — base pour N sous-slots et comptage שיבוצים.
 */
function mergeCellRawWithPulls(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
): string[] {
  const cell = assignments?.[dayKey]?.[shiftName]?.[stationIdx];
  const baseArr: string[] = Array.isArray(cell)
    ? (cell as unknown[]).map((x) => String(x ?? ""))
    : [];
  const cellPrefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  const have = new Set(baseArr.map((x) => normName(x)).filter(Boolean));
  const normSlot = (s: unknown) => String(s ?? "");
  const addInto = (name: string) => {
    const n = normName(name);
    if (!n || have.has(n)) return;
    const emptyIdx = baseArr.findIndex((x) => !normName(x));
    if (emptyIdx >= 0) baseArr[emptyIdx] = normSlot(name);
    else baseArr.push(normSlot(name));
    have.add(n);
  };
  try {
    if (pulls) {
      Object.entries(pulls).forEach(([k, entry]) => {
        if (!String(k).startsWith(cellPrefix)) return;
        if (!isRealPullEntry(entry)) return;
        const e = entry as { before?: { name?: string }; after?: { name?: string } };
        const b = String(e?.before?.name || "").trim();
        const a = String(e?.after?.name || "").trim();
        if (b) addInto(b);
        if (a) addInto(a);
      });
    }
  } catch {
    /* ignore */
  }
  return baseArr;
}

function parseHoursRange(range: string | null): { start: string; end: string } | null {
  const raw = String(range || "").trim();
  if (!raw) return null;
  const m = raw.match(/^\s*(\d{1,2})\s*[:\-]\s*(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*[:\-]\s*(\d{1,2})\s*$/);
  if (!m) return null;
  const h1 = Math.min(23, Math.max(0, Number(m[1])));
  const m1 = Math.min(59, Math.max(0, Number(m[2])));
  const h2 = Math.min(23, Math.max(0, Number(m[3])));
  const m2 = Math.min(59, Math.max(0, Number(m[4])));
  const pad = (n: number) => String(n).padStart(2, "0");
  return { start: `${pad(h1)}:${pad(m1)}`, end: `${pad(h2)}:${pad(m2)}` };
}

function splitRangeForPulls(start: string, end: string): { before: { start: string; end: string }; after: { start: string; end: string } } {
  const parseMin = (t: string): number => {
    const [h, m] = String(t || "00:00").split(":").map((x) => Number(x || 0));
    return ((h % 24) * 60 + (m % 60) + 1440) % 1440;
  };
  const fmt = (n: number): string => {
    const x = ((Math.round(n) % 1440) + 1440) % 1440;
    const h = Math.floor(x / 60);
    const m = x % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };
  const s = parseMin(start);
  const eRaw = parseMin(end);
  const e = eRaw <= s ? eRaw + 1440 : eRaw;
  const mid = s + (e - s) / 2;
  return {
    before: { start: fmt(s), end: fmt(mid) },
    after: { start: fmt(mid), end: fmt(e) },
  };
}

const MIN_STATION_GRID_ZOOM = 1;
const MAX_STATION_GRID_ZOOM = 2;
const STATION_GRID_ZOOM_STEP = 0.1;

function roundStationZoom(value: number): number {
  return Math.round(value * 10) / 10;
}
export {
  MIN_STATION_GRID_ZOOM,
  MAX_STATION_GRID_ZOOM,
  STATION_GRID_ZOOM_STEP,
  roundStationZoom,
  isRealPullEntry,
  checkGuardDisplayVsShift,
  guardDisplayTimeForSlot,
  normName,
  draftFixedCellNamesInRow,
  isWorkerInDraftFixedSnapshot,
  shouldShowDraftFixedPinForWorker,
  blockSavedViewPullBubble,
  truncateMobile6,
  isRtlName,
  expandedKeyFor,
  pullTimeRangeForName,
  countPullEntriesInCell,
  mergeCellRawWithPulls,
  parseHoursRange,
  splitRangeForPulls,
};

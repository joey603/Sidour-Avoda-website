import type { PlanningV2PullEntry, PlanningV2PullsMap } from "../types";
import { DAY_COLS, normPullWorkerName } from "./station-grid-helpers";

function normName(s: string): string {
  return normPullWorkerName(s);
}

function isRealPullEntry(entry: unknown): boolean {
  const e = entry as PlanningV2PullEntry | undefined;
  return !!String(e?.before?.name || "").trim() && !!String(e?.after?.name || "").trim();
}

export type SlotTimeMeta = {
  label: string;
  red: boolean;
  roleName?: string;
  /** Fond תצוגה מלאה : שינוי שעות (jaune) ou משיכה (orange). */
  highlight?: "guard" | "pull";
};

type PullsLike = PlanningV2PullsMap | Record<string, unknown>;

function pullEntryForWorkerInCell(
  pulls: PullsLike,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  workerName: string,
): PlanningV2PullEntry | null {
  const nm = normName(workerName);
  if (!nm) return null;
  const prefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  for (const [k, v] of Object.entries(pulls)) {
    if (!String(k).startsWith(prefix)) continue;
    const e = v as PlanningV2PullEntry;
    const b = normName(String(e?.before?.name || ""));
    const a = normName(String(e?.after?.name || ""));
    if (b === nm || a === nm) return e;
  }
  return null;
}

function formatHourDisplay(t: string): string {
  const m = String(t || "")
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return String(t || "").trim();
  return `${String(Number(m[1])).padStart(2, "0")}:${(m[2] || "00").padStart(2, "0")}`;
}

type AssignmentsLike = Record<string, Record<string, string[][]>> | null | undefined;

function assignedNamesInCell(
  assignments: AssignmentsLike,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
): string[] {
  const cell = assignments?.[dayKey]?.[shiftName]?.[stationIdx];
  if (!Array.isArray(cell)) return [];
  return (cell as unknown[]).map((x) => String(x ?? "").trim()).filter(Boolean);
}

function findCellGuardDisplay(
  pulls: PullsLike | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  assignments: AssignmentsLike,
): { start: string; end: string } | null {
  if (!pulls) return null;
  const cell = assignments?.[dayKey]?.[shiftName]?.[stationIdx];
  if (Array.isArray(cell)) {
    for (let i = 0; i < cell.length; i++) {
      if (!String(cell[i] ?? "").trim()) continue;
      const e = pulls[`${dayKey}|${shiftName}|${stationIdx}|${i}`] as PlanningV2PullEntry | undefined;
      const s = formatHourDisplay(String(e?.guardDisplay?.start || "").trim());
      const en = formatHourDisplay(String(e?.guardDisplay?.end || "").trim());
      if (s && en) return { start: s, end: en };
    }
  }
  const prefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  for (const [k, v] of Object.entries(pulls)) {
    if (!String(k).startsWith(prefix)) continue;
    const e = v as PlanningV2PullEntry;
    const s = formatHourDisplay(String(e?.guardDisplay?.start || "").trim());
    const en = formatHourDisplay(String(e?.guardDisplay?.end || "").trim());
    if (s && en) return { start: s, end: en };
  }
  return null;
}

function neighborShiftCoord(
  dayIdx: number,
  shiftIdx: number,
  shiftsCount: number,
  dir: -1 | 1,
): { dayIdx: number; shiftIdx: number } | null {
  if (dir < 0) {
    if (dayIdx === 0 && shiftIdx === 0) return null;
    if (shiftIdx === 0) return { dayIdx: dayIdx - 1, shiftIdx: shiftsCount - 1 };
    return { dayIdx, shiftIdx: shiftIdx - 1 };
  }
  if (dayIdx === DAY_COLS.length - 1 && shiftIdx === shiftsCount - 1) return null;
  if (shiftIdx === shiftsCount - 1) return { dayIdx: dayIdx + 1, shiftIdx: 0 };
  return { dayIdx, shiftIdx: shiftIdx + 1 };
}

/**
 * Ajuste les horaires d'une garde (1 personne) selon le שינוי שעות
 * de la garde précédente / suivante (également 1 personne) :
 * - début ← fin de la garde d'avant
 * - fin ← début de la garde d'après
 *
 * Retourne null si la cellule a déjà son propre guardDisplay, ou si
 * aucune frontière voisine ne force un changement.
 */
export function guardAdjacentBoundaryHours(
  pulls: PullsLike | null | undefined,
  assignments: AssignmentsLike,
  shiftNamesAll: string[],
  dayIdx: number,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  homeFrom: string,
  homeTo: string,
): { from: string; to: string } | null {
  if (!pulls || !assignments) return null;
  const homeF = formatHourDisplay(homeFrom);
  const homeT = formatHourDisplay(homeTo);
  if (!homeF || !homeT) return null;

  if (assignedNamesInCell(assignments, dayKey, shiftName, stationIdx).length !== 1) return null;
  // Priorité au שינוי שעות de la cellule elle-même
  if (findCellGuardDisplay(pulls, dayKey, shiftName, stationIdx, assignments)) return null;

  const shiftIdx = shiftNamesAll.indexOf(shiftName);
  if (shiftIdx < 0) return null;
  const shiftsCount = shiftNamesAll.length;

  let from = homeF;
  let to = homeT;

  const prev = neighborShiftCoord(dayIdx, shiftIdx, shiftsCount, -1);
  if (prev) {
    const prevDayKey = DAY_COLS[prev.dayIdx]?.key;
    const prevShift = shiftNamesAll[prev.shiftIdx];
    if (prevDayKey && prevShift) {
      if (assignedNamesInCell(assignments, prevDayKey, prevShift, stationIdx).length === 1) {
        const gd = findCellGuardDisplay(pulls, prevDayKey, prevShift, stationIdx, assignments);
        if (gd?.end) from = gd.end;
      }
    }
  }

  const next = neighborShiftCoord(dayIdx, shiftIdx, shiftsCount, 1);
  if (next) {
    const nextDayKey = DAY_COLS[next.dayIdx]?.key;
    const nextShift = shiftNamesAll[next.shiftIdx];
    if (nextDayKey && nextShift) {
      if (assignedNamesInCell(assignments, nextDayKey, nextShift, stationIdx).length === 1) {
        const gd = findCellGuardDisplay(pulls, nextDayKey, nextShift, stationIdx, assignments);
        if (gd?.start) to = gd.start;
      }
    }
  }

  if (from === homeF && to === homeT) return null;
  return { from, to };
}

function timeRangeForWorkerInPull(entry: PlanningV2PullEntry, workerName: string): string | null {
  const nm = normName(workerName);
  if (!nm) return null;
  const beforeName = normName(String(entry.before?.name || ""));
  const afterName = normName(String(entry.after?.name || ""));

  if (beforeName === nm) {
    const s = String(entry.before?.start || "").trim();
    const en = String(entry.before?.end || "").trim();
    if (s && en) return `${s}–${en}`;
    if (s) return s;
    if (en) return en;
  }
  if (afterName === nm) {
    const s = String(entry.after?.start || "").trim();
    const en = String(entry.after?.end || "").trim();
    if (s && en) return `${s}–${en}`;
    if (s) return s;
    if (en) return en;
  }
  return null;
}

/**
 * Horaires affichés sur la garde adjacente à une משיכה (pas la cellule trou) :
 * - before (garde du matin si משיכה midi/nuit) : début de sa garde → fin indiquée dans la משיכה
 * - after (remplaçant) : début indiqué dans la משיכה → fin de sa garde
 *
 * Ex. matin→nuit, transition 18:00 :
 *   Hanna (before) : 6:00 → 18:00
 *   autre (after)  : 18:00 → 6:00
 */
export function pullExtendedHoursForAdjacentRole(
  pulls: PullsLike | null | undefined,
  stationIdx: number,
  workerName: string,
  role: "before" | "after",
  homeShiftFrom: string,
  homeShiftTo: string,
): { from: string; to: string } | null {
  if (!pulls) return null;
  const nm = normName(workerName);
  if (!nm) return null;
  const homeFrom = formatHourDisplay(homeShiftFrom);
  const homeTo = formatHourDisplay(homeShiftTo);
  if (!homeFrom || !homeTo) return null;

  for (const [k, entryAny] of Object.entries(pulls)) {
    const parts = String(k || "").split("|");
    if (parts.length < 4) continue;
    if (Number(parts[2]) !== Number(stationIdx)) continue;
    const entry = entryAny as PlanningV2PullEntry;
    const beforeName = normName(String(entry?.before?.name || ""));
    const afterName = normName(String(entry?.after?.name || ""));
    const hasBoth = !!beforeName && !!afterName;
    if (!hasBoth) continue;

    if (role === "before" && beforeName === nm) {
      const pullEnd = formatHourDisplay(String(entry.before?.end || "").trim());
      if (pullEnd) return { from: homeFrom, to: pullEnd };
    }
    if (role === "after" && afterName === nm) {
      const pullStart = formatHourDisplay(String(entry.after?.start || "").trim());
      if (pullStart) return { from: pullStart, to: homeTo };
    }
  }
  return null;
}

/**
 * Retourne les métadonnées d'affichage (horaire + couleur) pour un slot dans l'export.
 * Priorité : guardDisplay > plage complète before/after (comme le grig)
 * > frontière ajustée via שינוי שעות des gardes adjacentes (1 personne/garde).
 */
export function slotTimeMetaFromPulls(
  pulls: PullsLike | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  slotIdx: number,
  workerName: string,
  adjacentOpts?: {
    assignments?: AssignmentsLike;
    shiftNamesAll?: string[];
    dayIdx?: number;
    homeFrom?: string;
    homeTo?: string;
  },
): SlotTimeMeta | null {
  if (!pulls) return null;

  const slotKey = `${dayKey}|${shiftName}|${stationIdx}|${slotIdx}`;
  const slotEntry = pulls[slotKey] as PlanningV2PullEntry | undefined;

  const gdStart = String(slotEntry?.guardDisplay?.start || "").trim();
  const gdEnd = String(slotEntry?.guardDisplay?.end || "").trim();
  if (gdStart && gdEnd) {
    return { label: `${gdStart}–${gdEnd}`, red: true, highlight: "guard" };
  }

  const pullEntry = pullEntryForWorkerInCell(pulls, dayKey, shiftName, stationIdx, workerName);
  if (pullEntry) {
    const range = timeRangeForWorkerInPull(pullEntry, workerName);
    if (range) {
      return { label: range, red: true, highlight: "pull" };
    }
  }

  if (
    adjacentOpts?.assignments &&
    adjacentOpts.shiftNamesAll &&
    adjacentOpts.dayIdx != null &&
    adjacentOpts.homeFrom &&
    adjacentOpts.homeTo
  ) {
    const adj = guardAdjacentBoundaryHours(
      pulls,
      adjacentOpts.assignments,
      adjacentOpts.shiftNamesAll,
      adjacentOpts.dayIdx,
      dayKey,
      shiftName,
      stationIdx,
      adjacentOpts.homeFrom,
      adjacentOpts.homeTo,
    );
    if (adj) {
      return { label: `${adj.from}–${adj.to}`, red: true, highlight: "guard" };
    }
  }

  return null;
}

/**
 * Horaires + surbrillance pour un slot (Excel / צילום / תצוגה).
 * Ordre : שינוי שעות → משיכה (cellule ou adjacente) → frontière שינוי שעות voisines.
 */
export function resolveSlotExportHours(
  pulls: PullsLike | null | undefined,
  assignments: AssignmentsLike,
  shiftNamesAll: string[],
  dayIdx: number,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  slotIdx: number,
  workerName: string,
  homeShiftFrom: string,
  homeShiftTo: string,
): { highlight: boolean; from: string; to: string } {
  const meta = slotTimeMetaFromPulls(pulls, dayKey, shiftName, stationIdx, slotIdx, workerName, {
    assignments,
    shiftNamesAll,
    dayIdx,
    homeFrom: homeShiftFrom,
    homeTo: homeShiftTo,
  });
  const pullRel = buildPullHighlightKindByNormName(
    pulls,
    shiftNamesAll,
    dayIdx,
    dayKey,
    shiftName,
    stationIdx,
  ).get(normName(workerName));

  const highlight =
    meta?.highlight === "guard" ||
    meta?.highlight === "pull" ||
    pullRel === "before" ||
    pullRel === "after" ||
    pullRel === "cell";

  let custom: { from: string; to: string } | null = null;
  if (meta?.highlight === "guard" && meta.label) {
    const m = String(meta.label).match(/(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?/);
    if (m) {
      const fmt = (h: string, min?: string) =>
        `${String(Number(h)).padStart(2, "0")}:${(min || "00").padStart(2, "0")}`;
      custom = { from: fmt(m[1], m[2]), to: fmt(m[3], m[4]) };
    }
  }

  if (!custom && (pullRel === "before" || pullRel === "after")) {
    custom = pullExtendedHoursForAdjacentRole(
      pulls,
      stationIdx,
      workerName,
      pullRel,
      homeShiftFrom,
      homeShiftTo,
    );
  }

  return {
    highlight: !!highlight,
    from: custom?.from || "",
    to: custom?.to || "",
  };
}

/** Anneau orange משיכה (trou, garde avant ou garde après) — trait fin (évite l’effet trop épais, surtout au zoom). */
export function pullHighlightRingClass(
  kind: "cell" | "before" | "after" | undefined,
  _opts?: { thin?: boolean },
): string {
  if (!kind) return "";
  return " ring-1 ring-orange-400";
}

/**
 * Anneau orange sur le trou + garde before (précédente) + garde after (suivante) — comme le grig planning.
 */
export function buildPullHighlightKindByNormName(
  pulls: PullsLike | null | undefined,
  shiftNamesAll: string[],
  dayIdx: number,
  dayKey: string,
  shiftName: string,
  stationIndex: number,
): Map<string, "cell" | "before" | "after"> {
  const out = new Map<string, "cell" | "before" | "after">();
  if (!pulls) return out;
  const shiftsCount = shiftNamesAll.length;
  const shiftIdx = shiftNamesAll.indexOf(shiftName);
  if (shiftIdx < 0) return out;

  const sameCoord = (a: { dayIdx: number; shiftIdx: number } | null, bDayIdx: number, bShiftIdx: number) =>
    !!a && a.dayIdx === bDayIdx && a.shiftIdx === bShiftIdx;

  for (const [pullKey, entryAny] of Object.entries(pulls)) {
    if (!isRealPullEntry(entryAny)) continue;
    const parts = String(pullKey || "").split("|");
    if (parts.length < 4) continue;
    const pullDayKey = parts[0];
    const pullShiftName = parts[1];
    if (Number(parts[2]) !== Number(stationIndex)) continue;

    const pullDayIdx = DAY_COLS.findIndex((c) => c.key === pullDayKey);
    const pullShiftIdx = shiftNamesAll.indexOf(pullShiftName);
    if (pullDayIdx < 0 || pullShiftIdx < 0) continue;

    const pullPrevCoord =
      pullDayIdx === 0 && pullShiftIdx === 0
        ? null
        : pullShiftIdx === 0
          ? { dayIdx: pullDayIdx - 1, shiftIdx: shiftsCount - 1 }
          : { dayIdx: pullDayIdx, shiftIdx: pullShiftIdx - 1 };
    const pullNextCoord =
      pullDayIdx === DAY_COLS.length - 1 && pullShiftIdx === shiftsCount - 1
        ? null
        : pullShiftIdx === shiftsCount - 1
          ? { dayIdx: pullDayIdx + 1, shiftIdx: 0 }
          : { dayIdx: pullDayIdx, shiftIdx: pullShiftIdx + 1 };

    const entry = entryAny as PlanningV2PullEntry;
    const beforeName = normName(String(entry?.before?.name || ""));
    const afterName = normName(String(entry?.after?.name || ""));

    if (pullDayKey === dayKey && pullShiftName === shiftName) {
      if (beforeName) out.set(beforeName, "cell");
      if (afterName) out.set(afterName, "cell");
      continue;
    }
    if (beforeName && sameCoord(pullPrevCoord, dayIdx, shiftIdx)) {
      out.set(beforeName, "before");
    }
    if (afterName && sameCoord(pullNextCoord, dayIdx, shiftIdx)) {
      out.set(afterName, "after");
    }
  }
  return out;
}

import type { PlanningV2PullEntry, PlanningV2PullsMap } from "../types";
import { DAY_COLS } from "./station-grid-helpers";

function normName(s: string): string {
  return String(s || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
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
 * Retourne les métadonnées d'affichage (horaire + couleur) pour un slot dans l'export.
 * Priorité : guardDisplay > plage complète before/after (comme le grig).
 */
export function slotTimeMetaFromPulls(
  pulls: PullsLike | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  slotIdx: number,
  workerName: string,
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
  if (!pullEntry) return null;

  const range = timeRangeForWorkerInPull(pullEntry, workerName);
  if (!range) return null;

  return { label: range, red: true, highlight: "pull" };
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

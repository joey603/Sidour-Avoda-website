import type { PlanningV2PullEntry, PlanningV2PullsMap } from "../types";

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
};

/**
 * Retourne les métadonnées d'affichage (horaire + couleur) pour un slot dans l'export.
 * Priorité : guardDisplay > before/after timing.
 */
export function slotTimeMetaFromPulls(
  pulls: PlanningV2PullsMap | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  slotIdx: number,
  workerName: string,
): SlotTimeMeta | null {
  if (!pulls) return null;

  const key = `${dayKey}|${shiftName}|${stationIdx}|${slotIdx}`;
  const entry = pulls[key] as PlanningV2PullEntry | undefined;
  if (!entry) return null;

  // guardDisplay → affichage rouge explicite (override)
  const gdStart = String(entry.guardDisplay?.start || "").trim();
  const gdEnd = String(entry.guardDisplay?.end || "").trim();
  if (gdStart && gdEnd) {
    return { label: `${gdStart}–${gdEnd}`, red: true };
  }

  // Pull before/after : affiche l'horaire de passage pour le worker concerné
  const nm = normName(workerName);
  if (!nm) return null;

  const beforeName = normName(String(entry.before?.name || ""));
  const afterName = normName(String(entry.after?.name || ""));

  if (beforeName && beforeName === nm) {
    // Worker "before" : affiche l'heure de fin ou l'heure d'arrivée du "after"
    const end = String(entry.before?.end || "").trim();
    const afterStart = String(entry.after?.start || "").trim();
    const timeStr = afterStart || end;
    if (timeStr) return { label: timeStr, red: true };
  }

  if (afterName && afterName === nm) {
    // Worker "after" : affiche son heure d'arrivée
    const start = String(entry.after?.start || "").trim();
    if (start) return { label: start, red: true };
  }

  return null;
}

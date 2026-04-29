import { getRequiredFor } from "./station-grid-helpers";
import type { PlanningWorker } from "../types";
import {
  readLinkedPlansFromMemory,
  resolveAssignmentsForAlternative,
  resolvePullsForAlternative,
} from "./multi-site-linked-memory";

/** Compte chaque nom de cellule (comme le tableau סיכום du planning). */
export function countAssignmentsPerWorkerName(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (!assignments || typeof assignments !== "object") return counts;
  for (const dKey of Object.keys(assignments)) {
    const shiftsMap = assignments[dKey] || {};
    for (const sn of Object.keys(shiftsMap)) {
      const perStation: string[][] = shiftsMap[sn] || [];
      for (const namesHere of perStation) {
        for (const nm of namesHere || []) {
          const clean = String(nm || "").trim();
          if (!clean) continue;
          counts.set(clean, (counts.get(clean) || 0) + 1);
        }
      }
    }
  }
  return counts;
}

/** Retire du comptage par עובד les noms dupliqués par les משיכות (before/after). */
export function subtractPullExtrasFromWorkerCounts(
  rawCounts: Map<string, number>,
  pulls: Record<string, { before?: { name?: string }; after?: { name?: string } }> | null | undefined,
): Map<string, number> {
  const out = new Map(rawCounts);
  if (!pulls || typeof pulls !== "object") return out;
  for (const entry of Object.values(pulls)) {
    if (!entry || typeof entry !== "object") continue;
    const before = String(entry.before?.name || "").trim();
    const after = String(entry.after?.name || "").trim();
    if (before) out.set(before, Math.max(0, (out.get(before) || 0) - 1));
    if (after) out.set(after, Math.max(0, (out.get(after) || 0) - 1));
  }
  return out;
}

export function colorIdentityForWorker(worker: PlanningWorker): string {
  const phone = String(worker.phone || "")
    .split("")
    .filter((ch) => /\d|\+/.test(ch))
    .join("")
    .trim();
  if (phone) return `phone:${phone}`;
  const linkedIds = Array.isArray(worker.linkedSiteIds)
    ? worker.linkedSiteIds.map((id) => Number(id)).filter(Number.isFinite).sort((a, b) => a - b)
    : [];
  const normName = String(worker.name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (linkedIds.length > 1) return `linked:${linkedIds.join(",")}:${normName}`;
  return `name:${normName}`;
}

export function sumTotalRequiredFromAssignments(
  stations: unknown[],
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
): number {
  if (!assignments) return 0;
  let total = 0;
  for (const dKey of Object.keys(assignments)) {
    const shiftsMap = assignments[dKey] || {};
    for (const sn of Object.keys(shiftsMap)) {
      for (let tIdx = 0; tIdx < stations.length; tIdx++) {
        total += getRequiredFor(stations[tIdx] as any, sn, dKey);
      }
    }
  }
  return total;
}

/**
 * Totaux par identité (téléphone / cluster lié) pour la colonne « total שיבוצים » multi-sites.
 */
export function buildTotalAssignmentsByIdentity(
  workers: PlanningWorker[],
  weekStart: Date,
  currentAssignments: Record<string, Record<string, string[][]>> | null | undefined,
  currentPulls?: Record<string, { before?: { name?: string }; after?: { name?: string } }> | null,
  selectedAlternativeIndex?: number,
): Map<string, number> {
  const workersByName = new Map<string, PlanningWorker>();
  for (const w of workers) {
    const n = String(w.name || "").trim();
    if (n) workersByName.set(n, w);
  }
  const totals = new Map<string, number>();
  const accumulate = (
    assignments: typeof currentAssignments,
    pulls?: Record<string, { before?: { name?: string }; after?: { name?: string } }> | null,
  ) => {
    const nameCounts = countAssignmentsPerWorkerName(assignments);
    const adjusted = subtractPullExtrasFromWorkerCounts(nameCounts, pulls ?? null);
    for (const [name, count] of adjusted) {
      const w = workersByName.get(name);
      if (!w) continue;
      const id = colorIdentityForWorker(w);
      totals.set(id, (totals.get(id) || 0) + count);
    }
  };
  const mem = readLinkedPlansFromMemory(weekStart);
  if (mem?.plansBySite && Object.keys(mem.plansBySite).length > 0) {
    const idx =
      typeof selectedAlternativeIndex === "number" && Number.isFinite(selectedAlternativeIndex)
        ? Math.max(0, Math.trunc(selectedAlternativeIndex))
        : (mem.activeAltIndex || 0);
    for (const plan of Object.values(mem.plansBySite)) {
      accumulate(
        resolveAssignmentsForAlternative(plan, idx),
        resolvePullsForAlternative(plan, idx) as Record<
          string,
          { before?: { name?: string }; after?: { name?: string } }
        > | null,
      );
    }
    return totals;
  }
  accumulate(currentAssignments, currentPulls ?? null);
  return totals;
}

export function totalAssignmentsForSummaryWorker(
  workerName: string,
  localCount: number,
  showMultiSiteColumn: boolean,
  workersByName: Map<string, PlanningWorker>,
  byIdentity: Map<string, number>,
): number {
  if (!showMultiSiteColumn) return localCount;
  const w = workersByName.get(String(workerName || "").trim());
  if (!w || (w.linkedSiteIds || []).length <= 1) return localCount;
  return byIdentity.get(colorIdentityForWorker(w)) ?? localCount;
}

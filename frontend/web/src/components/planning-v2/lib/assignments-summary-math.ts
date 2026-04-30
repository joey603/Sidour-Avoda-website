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
    const sharedIdx = Math.max(0, Math.trunc(Number(mem.activeAltIndex || 0)));
    const debugBySite: Record<string, { altIdx: number; counts: Record<string, number> }> = {};
    for (const [sitePlanId, plan] of Object.entries(mem.plansBySite)) {
      const planAlts = Array.isArray(plan.alternatives) ? plan.alternatives : [];
      // Si sharedIdx dépasse les alternatives disponibles pour ce site,
      // utiliser la dernière alternative disponible (pas le plan de base)
      // pour éviter de mixer des plans de moments différents.
      let safeIdx: number;
      if (sharedIdx <= 0) {
        safeIdx = 0;
      } else if (sharedIdx - 1 < planAlts.length) {
        safeIdx = sharedIdx;
      } else {
        safeIdx = planAlts.length; // dernière alternative (1-indexed)
      }
      const resolvedAsg = resolveAssignmentsForAlternative(plan, safeIdx);
      const resolvedPulls = resolvePullsForAlternative(plan, safeIdx) as Record<
        string,
        { before?: { name?: string }; after?: { name?: string } }
      > | null;
      const nameCounts = countAssignmentsPerWorkerName(resolvedAsg);
      const adjusted = subtractPullExtrasFromWorkerCounts(nameCounts, resolvedPulls ?? null);
      const siteDebug: Record<string, number> = {};
      for (const [name, count] of adjusted) {
        const w = workersByName.get(name);
        if (!w) continue;
        const id = colorIdentityForWorker(w);
        totals.set(id, (totals.get(id) || 0) + count);
        siteDebug[name] = count;
      }
      debugBySite[sitePlanId] = { altIdx: safeIdx, counts: siteDebug };
    }
    // Log des contributions par site pour les workers multi-sites dépassant leur max
    const overWorkers: Array<{ name: string; total: number; max: number; bySite: Record<string, number> }> = [];
    for (const w of workers) {
      if ((w.linkedSiteIds || []).length <= 1) continue;
      const id = colorIdentityForWorker(w);
      const total = totals.get(id) || 0;
      const maxS = Number((w as unknown as { max_shifts?: number }).max_shifts ?? w.maxShifts ?? 0);
      if (maxS > 0 && total > maxS) {
        const bySite: Record<string, number> = {};
        for (const [sid, { altIdx, counts }] of Object.entries(debugBySite)) {
          const c = counts[w.name];
          if (c !== undefined) bySite[`site_${sid}(alt${altIdx})`] = c;
        }
        overWorkers.push({ name: w.name, total, max: maxS, bySite });
      }
    }
    if (overWorkers.length > 0) {
      console.debug("[planning-v2][total-assignments] workers over max_shifts (peut être faux si alternatives désynchronisées entre sites):", overWorkers, { sharedIdx });
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

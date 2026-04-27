import type { LinkedSiteRow } from "../hooks/use-planning-v2-linked-sites";
import type { SiteSummary } from "../types";
import type { PlanningV2PullsMap } from "../types";
import {
  readLinkedPlansFromMemory,
  resolveAssignmentsForAlternative,
  resolvePullsForAlternative,
  type LinkedSitePlan,
} from "./multi-site-linked-memory";

/** Comme `countAssignedCells` dans `planning/[id]/page.tsx` : משיכות ne comptent pas comme postes occupés supplémentaires. */
export function countAssignedCellsForLinkedHoles(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls?: Record<string, unknown> | null | undefined,
): number {
  if (!assignments || typeof assignments !== "object") return 0;
  let total = 0;
  for (const dayKey of Object.keys(assignments)) {
    const shiftsMap = assignments[dayKey] || {};
    for (const shiftName of Object.keys(shiftsMap)) {
      const perStation = shiftsMap[shiftName] || [];
      for (const cell of perStation) {
        if (Array.isArray(cell)) total += cell.filter((name) => String(name || "").trim()).length;
      }
    }
  }
  const pullsCount = pulls && typeof pulls === "object" ? Object.keys(pulls).length : 0;
  return Math.max(0, total - pullsCount);
}

/** Comme `countRequiredForCurrentSite` dans la page planning (config stations). */
export function countRequiredSlotsFromSiteConfig(site: SiteSummary | null): number {
  const stations = (site?.config?.stations || []) as Array<Record<string, unknown>>;
  let total = 0;
  for (const st of stations) {
    const uniformRoles = !!st?.uniformRoles;
    const stationWorkers = Number(st?.workers || 0);
    if (st?.perDayCustom) {
      const dayOverrides = (st?.dayOverrides || {}) as Record<string, Record<string, unknown>>;
      for (const dayCfg of Object.values(dayOverrides)) {
        if (!dayCfg || typeof dayCfg !== "object" || !dayCfg.active) continue;
        for (const shift of (dayCfg.shifts || []) as Array<Record<string, unknown>>) {
          if (!shift?.enabled) continue;
          const roleTotal = Array.isArray(shift?.roles)
            ? (shift.roles as Array<Record<string, unknown>>)
                .filter((role) => role?.enabled)
                .reduce((sum, role) => sum + Number(role?.count || 0), 0)
            : 0;
          const required = uniformRoles ? stationWorkers : Number(shift?.workers || 0);
          total += required > 0 ? required : roleTotal;
        }
      }
    } else {
      const activeDays = Object.values((st?.days || {}) as Record<string, unknown>).filter(Boolean).length;
      for (const shift of (st?.shifts || []) as Array<Record<string, unknown>>) {
        if (!shift?.enabled) continue;
        const roleTotal = Array.isArray(shift?.roles)
          ? (shift.roles as Array<Record<string, unknown>>)
              .filter((role) => role?.enabled)
              .reduce((sum, role) => sum + Number(role?.count || 0), 0)
          : 0;
        const required = uniformRoles ? stationWorkers : Number(shift?.workers || 0);
        total += (required > 0 ? required : roleTotal) * activeDays;
      }
    }
  }
  return total;
}

export type LinkedSiteHoleEntry = {
  id: number;
  name: string;
  assignedCount: number;
  requiredCount: number;
  holesCount: number;
};

/**
 * Même logique que `linkedSiteEntries` dans `app/director/planning/[id]/page.tsx` :
 * assigned/required depuis la mémoire multi-site + חלופה active, sinon repli API / site courant.
 */
export function computeLinkedSiteHoleEntries(opts: {
  linkedSites: LinkedSiteRow[];
  weekStart: Date;
  currentSiteId: string;
  currentSite: SiteSummary | null;
  currentAssignments: Record<string, Record<string, string[][]>> | null | undefined;
  currentPulls: PlanningV2PullsMap | null | undefined;
  /** Index חלופה absolu (0 = base), aligné sur `activeAltIndex` en session. */
  alternativeIndex: number;
}): LinkedSiteHoleEntry[] {
  const linkedMemory = readLinkedPlansFromMemory(opts.weekStart);
  const activeAltIndex = Number(linkedMemory?.activeAltIndex ?? opts.alternativeIndex ?? 0);
  const currentAssigned = countAssignedCellsForLinkedHoles(opts.currentAssignments, opts.currentPulls || {});
  const currentRequired = countRequiredSlotsFromSiteConfig(opts.currentSite);

  return opts.linkedSites.map((linkedSite) => {
    const memoryPlan = linkedMemory?.plansBySite?.[String(linkedSite.id)] as
      | (LinkedSitePlan & { required_count?: number })
      | undefined;
    const planAssignments = memoryPlan ? resolveAssignmentsForAlternative(memoryPlan, activeAltIndex) : null;
    const planPulls = memoryPlan ? resolvePullsForAlternative(memoryPlan, activeAltIndex) : null;
    const assigned = planAssignments
      ? countAssignedCellsForLinkedHoles(planAssignments, planPulls)
      : typeof linkedSite.assigned_count === "number"
        ? linkedSite.assigned_count
        : String(linkedSite.id) === String(opts.currentSiteId)
          ? currentAssigned
          : 0;
    const required =
      typeof memoryPlan?.required_count === "number"
        ? memoryPlan.required_count
        : typeof linkedSite.required_count === "number"
          ? linkedSite.required_count
          : String(linkedSite.id) === String(opts.currentSiteId)
            ? currentRequired
            : 0;
    return {
      id: linkedSite.id,
      name: linkedSite.name,
      assignedCount: assigned,
      requiredCount: required,
      holesCount: Math.max(0, required - assigned),
    };
  });
}

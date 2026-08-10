import type { PlanningV2PullsMap, SiteSummary } from "../types";
import { countAssignedCellsForLinkedHoles, countRequiredSlotsFromSiteConfig } from "./linked-site-holes";
import { pullsCount } from "./planning-v2-pulls-match";

export type HoleScore = { holes: number; assigned: number; required: number; pulls: number };

export function singlePlanHoleScore(
  site: SiteSummary | null,
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: PlanningV2PullsMap | null | undefined,
): HoleScore {
  const required = countRequiredSlotsFromSiteConfig(site);
  const assigned = countAssignedCellsForLinkedHoles(assignments, pulls || {});
  return { assigned, required, holes: Math.max(0, required - assigned), pulls: pullsCount(pulls) };
}

export function linkedPlansHoleScore(
  plans: Record<string, { assignments?: unknown; pulls?: unknown; required_count?: unknown }> | null | undefined,
  currentSiteId: string,
  currentSite: SiteSummary | null,
): HoleScore {
  let assigned = 0;
  let required = 0;
  let totalPulls = 0;
  for (const [siteKey, plan] of Object.entries(plans || {})) {
    const assignments =
      plan?.assignments && typeof plan.assignments === "object"
        ? (plan.assignments as Record<string, Record<string, string[][]>>)
        : null;
    const pulls =
      plan?.pulls && typeof plan.pulls === "object" ? (plan.pulls as PlanningV2PullsMap) : {};
    totalPulls += pullsCount(pulls);
    assigned += countAssignedCellsForLinkedHoles(assignments, pulls);
    const rawRequired = Number(plan?.required_count);
    required +=
      Number.isFinite(rawRequired) && rawRequired > 0
        ? rawRequired
        : String(siteKey) === String(currentSiteId)
          ? countRequiredSlotsFromSiteConfig(currentSite)
          : 0;
  }
  return { assigned, required, holes: Math.max(0, required - assigned), pulls: totalPulls };
}

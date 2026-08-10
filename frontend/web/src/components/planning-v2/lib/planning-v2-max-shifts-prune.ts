import { resolveMaxShifts } from "@/lib/max-shifts";
import type { PlanningV2PullsMap, PlanningWorker } from "../types";
import { countAssignmentsPerWorkerName, subtractPullExtrasFromWorkerCounts } from "./assignments-summary-math";
import { buildPersistableLinkedPlans, type LinkedSitePlan } from "./multi-site-linked-memory";

export function linkedSitePlansMaxShiftOverages(
  plans: Record<string, { assignments?: unknown; pulls?: unknown }>,
  workers: PlanningWorker[],
): Array<{
  workerName: string;
  total: number;
  maxShifts: number;
  siteBreakdown: Record<string, number>;
}> {
  const overages: Array<{
    workerName: string;
    total: number;
    maxShifts: number;
    siteBreakdown: Record<string, number>;
  }> = [];
  for (const worker of workers) {
    if (!Array.isArray(worker.linkedSiteIds) || worker.linkedSiteIds.length <= 1) continue;
    const workerName = String(worker.name || "").trim();
    if (!workerName) continue;
    const maxShifts = resolveMaxShifts(worker.maxShifts);
    if (!Number.isFinite(maxShifts) || maxShifts <= 0) continue;
    let total = 0;
    const siteBreakdown: Record<string, number> = {};
    for (const linkedSiteId of worker.linkedSiteIds) {
      const sitePlan = plans[String(linkedSiteId)];
      if (!sitePlan || !sitePlan.assignments || typeof sitePlan.assignments !== "object") {
        siteBreakdown[String(linkedSiteId)] = 0;
        continue;
      }
      const counts = subtractPullExtrasFromWorkerCounts(
        countAssignmentsPerWorkerName(sitePlan.assignments as Record<string, Record<string, string[][]>>),
        (sitePlan.pulls && typeof sitePlan.pulls === "object" ? sitePlan.pulls : null) as PlanningV2PullsMap | null,
      );
      const siteTotal = Number(counts.get(workerName) || 0);
      siteBreakdown[String(linkedSiteId)] = siteTotal;
      total += siteTotal;
    }
    if (total > Math.trunc(maxShifts)) {
      overages.push({
        workerName,
        total,
        maxShifts: Math.trunc(maxShifts),
        siteBreakdown,
      });
    }
  }
  return overages;
}

export function linkedSitePlansRespectMaxShifts(
  plans: Record<string, { assignments?: unknown; pulls?: unknown }>,
  workers: PlanningWorker[],
): boolean {
  return linkedSitePlansMaxShiftOverages(plans, workers).length === 0;
}

export function linkedPlansAltCounts(plansBySite: Record<string, LinkedSitePlan> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [sid, plan] of Object.entries(plansBySite || {})) {
    out[String(sid)] = Array.isArray(plan?.alternatives) ? plan.alternatives.length : 0;
  }
  return out;
}

export function linkedCandidatePlansAtIndex(
  plansBySite: Record<string, LinkedSitePlan>,
  index: number,
): Record<string, { assignments?: unknown; pulls?: unknown }> {
  const candidate: Record<string, { assignments?: unknown; pulls?: unknown }> = {};
  for (const [sid, plan] of Object.entries(plansBySite || {})) {
    if (index <= 0) {
      candidate[sid] = {
        assignments: plan.assignments,
        pulls: plan.pulls && typeof plan.pulls === "object" ? plan.pulls : {},
      };
      continue;
    }
    const alternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
    const alternativePulls = Array.isArray(plan.alternative_pulls) ? plan.alternative_pulls : [];
    candidate[sid] = {
      assignments: alternatives[index - 1],
      pulls:
        alternativePulls[index - 1] && typeof alternativePulls[index - 1] === "object"
          ? alternativePulls[index - 1]
          : {},
    };
  }
  return candidate;
}

export function pruneLinkedPlansOverMaxShifts(
  plansBySite: Record<string, LinkedSitePlan>,
  workers: PlanningWorker[],
): {
  plansBySite: Record<string, LinkedSitePlan>;
  dropped: Array<{ index: number; overages: ReturnType<typeof linkedSitePlansMaxShiftOverages> }>;
} {
  const normalized = buildPersistableLinkedPlans(plansBySite);
  const siteEntries = Object.entries(normalized);
  if (siteEntries.length === 0) return { plansBySite: normalized, dropped: [] };
  const nextPlans = Object.fromEntries(
    siteEntries.map(([sid, plan]) => [
      sid,
      {
        ...plan,
        alternatives: [] as Record<string, Record<string, string[][]>>[],
        alternative_pulls: [] as Record<string, unknown>[],
      } satisfies LinkedSitePlan,
    ]),
  ) as Record<string, LinkedSitePlan>;
  const altCount = Math.min(
    ...siteEntries.map(([, plan]) => (Array.isArray(plan.alternatives) ? plan.alternatives.length : 0)),
  );
  const dropped: Array<{ index: number; overages: ReturnType<typeof linkedSitePlansMaxShiftOverages> }> = [];
  for (let index = 1; index <= altCount; index += 1) {
    const candidate = linkedCandidatePlansAtIndex(normalized, index);
    const overages = linkedSitePlansMaxShiftOverages(candidate, workers);
    if (overages.length > 0) {
      dropped.push({ index, overages });
      continue;
    }
    for (const [sid, plan] of siteEntries) {
      const alternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
      const alternativePulls = Array.isArray(plan.alternative_pulls) ? plan.alternative_pulls : [];
      nextPlans[sid].alternatives?.push(alternatives[index - 1]);
      nextPlans[sid].alternative_pulls?.push(
        (alternativePulls[index - 1] && typeof alternativePulls[index - 1] === "object"
          ? alternativePulls[index - 1]
          : {}) as Record<string, unknown>,
      );
    }
  }
  return { plansBySite: nextPlans, dropped };
}

import type { PlanningV2PullsMap } from "../types";
import type { LinkedSitePlan } from "./multi-site-linked-memory";

export type DraftAlternative = {
  assignments: Record<string, Record<string, string[][]>>;
  pulls: PlanningV2PullsMap;
};

export function normalizeDraftAlternatives(
  value: Array<DraftAlternative | null | undefined>,
): DraftAlternative[] {
  return (value || []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const assignments = item.assignments;
    if (!assignments || typeof assignments !== "object") return [];
    return [
      {
        assignments,
        pulls: (item.pulls || {}) as PlanningV2PullsMap,
      },
    ];
  });
}

export function alternativeSnapshot(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: PlanningV2PullsMap | null | undefined,
): string {
  if (!assignments || typeof assignments !== "object") return "";
  try {
    return JSON.stringify({ assignments, pulls: pulls || {} });
  } catch {
    return "";
  }
}

export function linkedSitePlansSnapshot(
  plans: Record<string, { assignments?: unknown; pulls?: unknown }> | null | undefined,
): string {
  if (!plans || typeof plans !== "object") return "";
  try {
    const normalized = Object.fromEntries(
      Object.entries(plans)
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
        .map(([siteKey, payload]) => [
          siteKey,
          {
            assignments:
              payload && typeof payload === "object" && payload.assignments && typeof payload.assignments === "object"
                ? payload.assignments
                : null,
            pulls:
              payload && typeof payload === "object" && payload.pulls && typeof payload.pulls === "object"
                ? payload.pulls
                : {},
          },
        ]),
    );
    return JSON.stringify(normalized);
  } catch {
    return "";
  }
}

export function buildSeenLinkedAlternativeSnapshots(
  plansBySite: Record<string, LinkedSitePlan> | null | undefined,
): Set<string> {
  const seen = new Set<string>();
  if (!plansBySite || typeof plansBySite !== "object") return seen;
  const maxAlternativeCount = Math.max(
    0,
    ...Object.values(plansBySite).map((plan) => (Array.isArray(plan?.alternatives) ? plan.alternatives.length : 0)),
  );
  for (let idx = 0; idx <= maxAlternativeCount; idx += 1) {
    const snapshotPlans: Record<string, { assignments?: unknown; pulls?: unknown }> = {};
    for (const [siteKey, plan] of Object.entries(plansBySite)) {
      if (!plan || typeof plan !== "object") continue;
      if (idx === 0) {
        snapshotPlans[siteKey] = {
          assignments: plan.assignments && typeof plan.assignments === "object" ? plan.assignments : null,
          pulls: plan.pulls && typeof plan.pulls === "object" ? plan.pulls : {},
        };
        continue;
      }
      const alternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
      const alternativePulls = Array.isArray(plan.alternative_pulls) ? plan.alternative_pulls : [];
      if (idx - 1 >= alternatives.length) continue;
      snapshotPlans[siteKey] = {
        assignments: alternatives[idx - 1],
        pulls:
          idx - 1 < alternativePulls.length && alternativePulls[idx - 1] && typeof alternativePulls[idx - 1] === "object"
            ? alternativePulls[idx - 1]
            : {},
      };
    }
    const snap = linkedSitePlansSnapshot(snapshotPlans);
    if (snap) seen.add(snap);
  }
  return seen;
}

export function uniqueDraftAlternatives(
  value: Array<DraftAlternative | null | undefined>,
): DraftAlternative[] {
  const seen = new Set<string>();
  return normalizeDraftAlternatives(value).filter((item) => {
    const snap = alternativeSnapshot(item.assignments, item.pulls);
    if (!snap) return true;
    if (seen.has(snap)) return false;
    seen.add(snap);
    return true;
  });
}

export function buildSeenAlternativeSnapshots(
  baseAssignments: Record<string, Record<string, string[][]>> | null | undefined,
  basePulls: PlanningV2PullsMap | null | undefined,
  alternatives: Array<DraftAlternative | null | undefined>,
): Set<string> {
  const seen = new Set<string>();
  const baseSnap = alternativeSnapshot(baseAssignments, basePulls);
  if (baseSnap) seen.add(baseSnap);
  for (const alt of uniqueDraftAlternatives(alternatives)) {
    const snap = alternativeSnapshot(alt.assignments, alt.pulls);
    if (snap) seen.add(snap);
  }
  return seen;
}

export function draftAlternativesForMode(
  value: Array<DraftAlternative | null | undefined>,
  dedupe: boolean,
): DraftAlternative[] {
  return dedupe ? uniqueDraftAlternatives(value) : normalizeDraftAlternatives(value);
}

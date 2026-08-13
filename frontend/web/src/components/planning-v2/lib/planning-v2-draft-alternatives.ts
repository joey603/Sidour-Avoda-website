import type { PlanningV2PullsMap } from "../types";
import type { LinkedSitePlan } from "./multi-site-linked-memory";
import { countMorningNightSameDayPairs } from "./planning-v2-hole-scores";

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

/**
 * Pendant une préférence משיכות, la 1re vue (index 0) n’est pas figée
 * tant que l’utilisateur n’a pas choisi une autre חלופה.
 */
export function viewedIndicesForPreferResplit(
  viewed: Iterable<number> | null | undefined,
  selectedIndex: number,
  userPickedIndex: number | null | undefined,
): Set<number> {
  const next = new Set<number>();
  for (const raw of viewed || []) {
    const idx = Math.trunc(Number(raw));
    if (Number.isFinite(idx) && idx >= 0) next.add(idx);
  }
  const selected = Math.trunc(Number(selectedIndex));
  if (Number.isFinite(selected) && selected >= 0) next.add(selected);
  const pickedRaw = userPickedIndex == null ? null : Math.trunc(Number(userPickedIndex));
  const picked = pickedRaw != null && Number.isFinite(pickedRaw) ? pickedRaw : null;
  if (picked == null && selected === 0) next.delete(0);
  return next;
}

/**
 * Reclasse uniquement les חלופות pas encore vues.
 * Chaque index déjà consulté reste occupé par le même plan.
 */
export function rankUnseenDraftPlans(
  plans: DraftAlternative[],
  viewedIndices: Iterable<number> | null | undefined,
  compare: (a: DraftAlternative, b: DraftAlternative) => number,
): DraftAlternative[] {
  if (plans.length <= 1) return plans;
  const lockedByIdx = new Map<number, DraftAlternative>();
  for (const raw of viewedIndices || []) {
    const idx = Math.trunc(Number(raw));
    if (!Number.isFinite(idx) || idx < 0 || idx >= plans.length) continue;
    const plan = plans[idx];
    if (plan) lockedByIdx.set(idx, plan);
  }
  if (lockedByIdx.size === 0) return [...plans].sort(compare);

  const lockedSnaps = new Set<string>();
  for (const plan of lockedByIdx.values()) {
    const snap = alternativeSnapshot(plan.assignments, plan.pulls);
    if (snap) lockedSnaps.add(snap);
  }
  const rest = plans.filter((plan) => {
    const snap = alternativeSnapshot(plan.assignments, plan.pulls);
    return !snap || !lockedSnaps.has(snap);
  });
  rest.sort(compare);

  const result: DraftAlternative[] = [];
  let restI = 0;
  const lastIdx = Math.max(plans.length - 1, ...lockedByIdx.keys());
  for (let i = 0; i <= lastIdx; i += 1) {
    const locked = lockedByIdx.get(i);
    if (locked) {
      result.push(locked);
    } else if (restI < rest.length) {
      result.push(rest[restI++]);
    }
  }
  while (restI < rest.length) {
    result.push(rest[restI++]);
  }
  return result;
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

/** Pousse en fin de liste les חלופות où quelqu’un a בוקר+לילה le même jour — freeze ignoré. */
export function rankMorningNightPairsLast(plans: DraftAlternative[]): DraftAlternative[] {
  if (plans.length <= 1) return plans;
  const clean: DraftAlternative[] = [];
  const sameDay: DraftAlternative[] = [];
  for (const plan of plans) {
    if (countMorningNightSameDayPairs(plan.assignments, plan.pulls) > 0) sameDay.push(plan);
    else clean.push(plan);
  }
  return [...clean, ...sameDay];
}

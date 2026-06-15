/** Compatible avec `planning/[id]/page.tsx` — même préfixe sessionStorage. */

import { assignmentsNonEmpty } from "./assignments-empty";

export type LinkedSitePlan = {
  assignments?: Record<string, Record<string, string[][]>>;
  alternatives?: Record<string, Record<string, string[][]>>[];
  pulls?: Record<string, unknown>;
  alternative_pulls?: Record<string, unknown>[];
  /** Présent quand le plan a été enrichi côté client (comme la page planning). */
  required_count?: number;
};

export type LinkedPlansMemory = {
  activeAltIndex: number;
  plansBySite: Record<string, LinkedSitePlan>;
};

const multiSiteMemoryPrefix = "multi_site_generated_";

export const MULTI_SITE_NAV_FLAG = "multi_site_navigation_in_app";

export function readMultiSiteNavigationInApp(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(MULTI_SITE_NAV_FLAG) === "1";
  } catch {
    return false;
  }
}

export function clearMultiSiteNavigationInApp(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(MULTI_SITE_NAV_FLAG);
  } catch {
    /* ignore */
  }
}

/** Nombre total d’alternatives visibles stockées en mémoire pour un site (base incluse). */
export function countLinkedPlanVisibleAlternatives(
  plan: LinkedSitePlan | null | undefined,
  stopVisibleCount: number | null = null,
): number {
  if (!plan || typeof plan !== "object") return 0;
  const hasBase = assignmentsNonEmpty(
    (plan.assignments as Record<string, Record<string, string[][]>> | null | undefined) ?? null,
  );
  const altCount = Array.isArray(plan.alternatives)
    ? plan.alternatives.filter((alt) =>
        assignmentsNonEmpty((alt as Record<string, Record<string, string[][]>> | null | undefined) ?? null),
      ).length
    : 0;
  const rawTotal = (hasBase ? 1 : 0) + altCount;
  if (stopVisibleCount == null) return rawTotal;
  return Math.min(rawTotal, Math.max(1, stopVisibleCount));
}

function isoPlanKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function multiSiteMemoryKey(start: Date): string {
  return `${multiSiteMemoryPrefix}${isoPlanKey(start)}`;
}

export function resolveAssignmentsForAlternative(plan: LinkedSitePlan, index: number) {
  if (index <= 0) return plan.assignments;
  const alternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
  const assignments = alternatives[index - 1];
  return assignments && typeof assignments === "object"
    ? (assignments as Record<string, Record<string, string[][]>>)
    : plan.assignments;
}

export function resolvePullsForAlternative(
  plan: LinkedSitePlan,
  index: number,
): Record<string, unknown> | undefined {
  if (index <= 0) return plan.pulls as Record<string, unknown> | undefined;
  const alternativePulls = Array.isArray(plan.alternative_pulls) ? plan.alternative_pulls : [];
  const pulls = alternativePulls[index - 1];
  return pulls && typeof pulls === "object" ? (pulls as Record<string, unknown>) : undefined;
}

export function resolveSharedAlternativeIndex(plan: LinkedSitePlan, requestedIndex: number): number {
  const sharedIdx = Math.max(0, Math.trunc(Number(requestedIndex || 0)));
  const alternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
  if (sharedIdx <= 0) return 0;
  if (sharedIdx - 1 < alternatives.length) return sharedIdx;
  return alternatives.length;
}

export function hasSharedAlternativeIndex(plan: LinkedSitePlan, requestedIndex: number): boolean {
  const sharedIdx = Math.max(0, Math.trunc(Number(requestedIndex || 0)));
  if (sharedIdx <= 0) return true;
  const alternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
  return sharedIdx - 1 < alternatives.length;
}

export function resolveAssignmentsForSharedAlternative(plan: LinkedSitePlan, requestedIndex: number) {
  return resolveAssignmentsForAlternative(plan, resolveSharedAlternativeIndex(plan, requestedIndex));
}

export function resolvePullsForSharedAlternative(
  plan: LinkedSitePlan,
  requestedIndex: number,
): Record<string, unknown> | undefined {
  return resolvePullsForAlternative(plan, resolveSharedAlternativeIndex(plan, requestedIndex));
}

function linkedPlansSnapshot(
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

export function buildPersistableLinkedPlans(
  plansBySite: Record<string, LinkedSitePlan> | null | undefined,
): Record<string, LinkedSitePlan> {
  if (!plansBySite || typeof plansBySite !== "object") return {};
  const siteEntries = Object.entries(plansBySite).filter(([, plan]) => !!plan && typeof plan === "object");
  if (siteEntries.length === 0) return {};

  const normalized = Object.fromEntries(
    siteEntries.map(([siteId, plan]) => [
      siteId,
      {
        assignments: plan.assignments,
        pulls: plan.pulls && typeof plan.pulls === "object" ? plan.pulls : {},
        alternatives: [] as Record<string, Record<string, string[][]>>[],
        alternative_pulls: [] as Record<string, unknown>[],
      } satisfies LinkedSitePlan,
    ]),
  ) as Record<string, LinkedSitePlan>;

  const maxSharedAlternativeCount = Math.min(
    ...siteEntries.map(([, plan]) => (Array.isArray(plan.alternatives) ? plan.alternatives.length : 0)),
  );
  const seen = new Set<string>();
  const baseSnapshot = linkedPlansSnapshot(
    Object.fromEntries(
      siteEntries.map(([siteId, plan]) => [
        siteId,
        {
          assignments: plan.assignments,
          pulls: plan.pulls && typeof plan.pulls === "object" ? plan.pulls : {},
        },
      ]),
    ),
  );
  if (baseSnapshot) seen.add(baseSnapshot);

  for (let idx = 0; idx < maxSharedAlternativeCount; idx += 1) {
    const candidateSnapshot: Record<string, { assignments?: unknown; pulls?: unknown }> = {};
    let complete = true;
    for (const [siteId, plan] of siteEntries) {
      const alternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
      const alternativePulls = Array.isArray(plan.alternative_pulls) ? plan.alternative_pulls : [];
      const assignments = alternatives[idx];
      if (!assignments || typeof assignments !== "object") {
        complete = false;
        break;
      }
      candidateSnapshot[siteId] = {
        assignments,
        pulls:
          alternativePulls[idx] && typeof alternativePulls[idx] === "object"
            ? alternativePulls[idx]
            : {},
      };
    }
    if (!complete) continue;
    const snapshot = linkedPlansSnapshot(candidateSnapshot);
    if (!snapshot || seen.has(snapshot)) continue;
    seen.add(snapshot);
    for (const [siteId] of siteEntries) {
      const sitePayload = candidateSnapshot[siteId];
      normalized[siteId].alternatives?.push(
        sitePayload.assignments as Record<string, Record<string, string[][]>>,
      );
      normalized[siteId].alternative_pulls?.push(
        (sitePayload.pulls && typeof sitePayload.pulls === "object" ? sitePayload.pulls : {}) as Record<string, unknown>,
      );
    }
  }

  return normalized;
}

export function readLinkedPlansFromMemory(start: Date): LinkedPlansMemory | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(multiSiteMemoryKey(start));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    if ("plansBySite" in p && p.plansBySite && typeof p.plansBySite === "object") {
      return {
        activeAltIndex: Number(p.activeAltIndex || 0),
        plansBySite: p.plansBySite as Record<string, LinkedSitePlan>,
      };
    }
    return {
      activeAltIndex: 0,
      plansBySite: parsed as Record<string, LinkedSitePlan>,
    };
  } catch {
    return null;
  }
}

/** Efface le cache session des plannings multi-sites pour cette semaine (avant une nouvelle יצירת תכנון). */
export function clearLinkedPlansFromMemory(start: Date): void {
  if (typeof window === "undefined") return;
  try {
    const key = multiSiteMemoryKey(start);
    sessionStorage.removeItem(key);
    queueMicrotask(() => {
      try {
        window.dispatchEvent(new CustomEvent("linked-plans-memory-updated", { detail: { storageKey: key } }));
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

export function saveLinkedPlansToMemory(
  start: Date,
  plansBySite: Record<string, LinkedSitePlan>,
  activeAltIndex = 0,
): void {
  if (typeof window === "undefined") return;
  try {
    const key = multiSiteMemoryKey(start);
    const payload: LinkedPlansMemory = {
      activeAltIndex: Math.max(0, Number(activeAltIndex || 0)),
      plansBySite: plansBySite || {},
    };
    const nextRaw = JSON.stringify(payload);
    const prevRaw = sessionStorage.getItem(key);
    if (prevRaw === nextRaw) return;
    sessionStorage.setItem(key, nextRaw);
    // Différer : un listener synchrone (ex. refreshFromMemory) pendant readSseStream peut enchaîner des setState
    // et provoquer « Maximum update depth » si d’autres effets réagissent dans la même pile.
    queueMicrotask(() => {
      try {
        window.dispatchEvent(new CustomEvent("linked-plans-memory-updated", { detail: { storageKey: key } }));
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

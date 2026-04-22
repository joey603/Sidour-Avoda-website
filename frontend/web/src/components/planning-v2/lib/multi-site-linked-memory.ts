/** Compatible avec `planning/[id]/page.tsx` — même préfixe sessionStorage. */

export type LinkedSitePlan = {
  assignments?: Record<string, Record<string, string[][]>>;
  alternatives?: Record<string, Record<string, string[][]>>[];
  pulls?: Record<string, unknown>;
  alternative_pulls?: Record<string, unknown>[];
};

export type LinkedPlansMemory = {
  activeAltIndex: number;
  plansBySite: Record<string, LinkedSitePlan>;
};

const multiSiteMemoryPrefix = "multi_site_generated_";

function isoPlanKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function multiSiteMemoryKey(start: Date): string {
  return `${multiSiteMemoryPrefix}${isoPlanKey(start)}`;
}

export function resolveAssignmentsForAlternative(plan: LinkedSitePlan, index: number) {
  if (index <= 0) return plan.assignments;
  return (plan.alternatives || [])[index - 1] || plan.assignments;
}

export function resolvePullsForAlternative(
  plan: LinkedSitePlan,
  index: number,
): Record<string, unknown> | undefined {
  if (index <= 0) return plan.pulls as Record<string, unknown> | undefined;
  const alts = plan.alternative_pulls;
  if (!Array.isArray(alts) || index - 1 < 0) return undefined;
  return alts[index - 1] as Record<string, unknown> | undefined;
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

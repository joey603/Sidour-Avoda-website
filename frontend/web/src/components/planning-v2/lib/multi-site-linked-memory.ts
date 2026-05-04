/** Compatible avec `planning/[id]/page.tsx` — même préfixe sessionStorage. */

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

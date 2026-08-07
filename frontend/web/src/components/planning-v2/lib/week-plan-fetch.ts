import { apiFetch } from "@/lib/api";

export type V2WeekPlanData = {
  assignments: Record<string, Record<string, string[][]>>;
  pulls?: Record<string, unknown>;
  alternatives?: Record<string, Record<string, string[][]>>[];
  alternativePulls?: Record<string, unknown>[];
  isManual?: boolean;
  workers?: unknown[];
  /** Scope API utilisé (priorité director → shared → auto). L’UI « plan verrouillé » ignore `auto`. */
  sourceScope?: "director" | "shared" | "auto";
} | null;

async function fetchWeekPlanScope(siteId: string, isoWeek: string, scope: "director" | "shared" | "auto") {
  try {
    return await apiFetch<Record<string, unknown> | null>(
      `/director/sites/${siteId}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=${scope}`,
      {
        cache: "no-store" as RequestCache,
      },
    );
  } catch {
    return null;
  }
}

function buildWeekPlanScopePriority(
  preferredScope?: "director" | "shared" | "auto" | null,
): Array<"director" | "shared" | "auto"> {
  const savedScopes = ["director", "shared"] as const;
  if (preferredScope === "director" || preferredScope === "shared") {
    return [preferredScope, ...savedScopes.filter((scope) => scope !== preferredScope), "auto"];
  }
  // `auto` est seulement une טיוטה. Même si le statut la signale comme préférée,
  // un plan sauvegardé director/shared doit toujours gagner.
  return ["director", "shared", "auto"];
}

export function normalizeWeekPlan(raw: Record<string, unknown> | null | undefined): V2WeekPlanData {
  if (!raw || typeof raw !== "object" || !raw.assignments) return null;
  return {
    assignments: raw.assignments as Record<string, Record<string, string[][]>>,
    pulls: raw.pulls && typeof raw.pulls === "object" ? (raw.pulls as Record<string, unknown>) : undefined,
    alternatives: Array.isArray(raw.alternatives)
      ? (raw.alternatives as Record<string, Record<string, string[][]>>[])
      : [],
    alternativePulls: Array.isArray(raw.alternative_pulls)
      ? (raw.alternative_pulls as Record<string, unknown>[])
      : Array.isArray(raw.alternativePulls)
        ? (raw.alternativePulls as Record<string, unknown>[])
        : [],
    isManual: !!raw.isManual,
    workers: Array.isArray(raw.workers) ? raw.workers : undefined,
  };
}

/** Lecture séquentielle director → shared → auto, arrêt au premier plan trouvé. */
export async function loadWeekPlanForSiteWeek(
  siteId: string,
  isoWeek: string,
  preferredScope?: "director" | "shared" | "auto" | null,
  options?: { lightweightNav?: boolean },
): Promise<V2WeekPlanData> {
  const orderedScopes = options?.lightweightNav
    ? (["auto"] as const)
    : buildWeekPlanScopePriority(preferredScope);
  for (const scope of orderedScopes) {
    const raw = await fetchWeekPlanScope(siteId, isoWeek, scope);
    const normalized = normalizeWeekPlan(raw as Record<string, unknown>);
    if (normalized) {
      return { ...normalized, sourceScope: scope };
    }
  }
  return null;
}

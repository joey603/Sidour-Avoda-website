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

function asSourceScope(value: unknown): "director" | "shared" | "auto" | undefined {
  return value === "director" || value === "shared" || value === "auto" ? value : undefined;
}

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

export function normalizeWeekPlan(raw: Record<string, unknown> | null | undefined): V2WeekPlanData {
  if (!raw || typeof raw !== "object" || !raw.assignments) return null;
  const sourceScope = asSourceScope(raw._source_scope ?? raw.sourceScope);
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
    sourceScope,
  };
}

async function loadWeekPlanWaterfall(
  siteId: string,
  isoWeek: string,
  preferredScope?: "director" | "shared" | "auto" | null,
): Promise<V2WeekPlanData> {
  const saved = ["director", "shared"] as const;
  const ordered: Array<"director" | "shared" | "auto"> =
    preferredScope === "director" || preferredScope === "shared"
      ? [preferredScope, ...saved.filter((scope) => scope !== preferredScope), "auto"]
      : ["shared", "director", "auto"];
  for (const scope of ordered) {
    const raw = await fetchWeekPlanScope(siteId, isoWeek, scope);
    const normalized = normalizeWeekPlan(raw as Record<string, unknown>);
    if (normalized) return { ...normalized, sourceScope: scope };
  }
  return null;
}

/** Un GET `scope=resolve` (même priorité qu’avant : saved puis auto). */
export async function loadWeekPlanForSiteWeek(
  siteId: string,
  isoWeek: string,
  preferredScope?: "director" | "shared" | "auto" | null,
  options?: { lightweightNav?: boolean },
): Promise<V2WeekPlanData> {
  if (options?.lightweightNav) {
    const raw = await fetchWeekPlanScope(siteId, isoWeek, "auto");
    const normalized = normalizeWeekPlan(raw as Record<string, unknown>);
    return normalized ? { ...normalized, sourceScope: "auto" } : null;
  }
  const prefer =
    preferredScope === "director" || preferredScope === "shared"
      ? `&prefer=${preferredScope}`
      : "";
  try {
    const raw = await apiFetch<Record<string, unknown> | null>(
      `/director/sites/${siteId}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=resolve${prefer}`,
      {
        cache: "no-store" as RequestCache,
      },
    );
    const normalized = normalizeWeekPlan(raw as Record<string, unknown>);
    if (!normalized) return null;
    return {
      ...normalized,
      sourceScope: normalized.sourceScope ?? asSourceScope(raw?._source_scope) ?? "director",
    };
  } catch {
    // Backend pas encore déployé : ancien waterfall, même résultat.
    return loadWeekPlanWaterfall(siteId, isoWeek, preferredScope);
  }
}

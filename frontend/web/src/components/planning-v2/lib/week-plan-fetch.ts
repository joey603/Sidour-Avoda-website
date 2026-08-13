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

export type LoadWeekPlanOptions = {
  lightweightNav?: boolean;
  omitWorkers?: boolean;
  /** Hors semaine actuelle / suivante : uniquement director/shared, pas les brouillons auto. */
  savedOnly?: boolean;
  /** Appelé dès que la grille (חלופה 0) est là — les חלופות suivent sans reclasse. */
  onBase?: (plan: NonNullable<V2WeekPlanData>) => void;
};

function asSourceScope(value: unknown): "director" | "shared" | "auto" | undefined {
  return value === "director" || value === "shared" || value === "auto" ? value : undefined;
}

function weekPlanQuery(
  isoWeek: string,
  scope: string,
  extra?: { prefer?: string; parts?: "full" | "base" | "alternatives"; omitWorkers?: boolean },
) {
  let qs = `week=${encodeURIComponent(isoWeek)}&scope=${scope}`;
  if (extra?.prefer) qs += `&prefer=${extra.prefer}`;
  if (extra?.parts && extra.parts !== "full") qs += `&parts=${extra.parts}`;
  if (extra?.omitWorkers) qs += `&include_workers=false`;
  return qs;
}

async function fetchWeekPlanRaw(
  siteId: string,
  isoWeek: string,
  scope: string,
  extra?: { prefer?: string; parts?: "full" | "base" | "alternatives"; omitWorkers?: boolean },
) {
  try {
    return await apiFetch<Record<string, unknown> | null>(
      `/director/sites/${siteId}/week-plan?${weekPlanQuery(isoWeek, scope, extra)}`,
      {
        cache: "no-store" as RequestCache,
      },
    );
  } catch {
    return null;
  }
}

async function fetchWeekPlanScope(siteId: string, isoWeek: string, scope: "director" | "shared" | "auto") {
  return fetchWeekPlanRaw(siteId, isoWeek, scope);
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

function savedScopeOrder(
  preferredScope?: "director" | "shared" | "auto" | null,
): Array<"director" | "shared"> {
  if (preferredScope === "director" || preferredScope === "shared") {
    return [preferredScope, preferredScope === "director" ? "shared" : "director"];
  }
  return ["shared", "director"];
}

async function loadWeekPlanWaterfall(
  siteId: string,
  isoWeek: string,
  preferredScope?: "director" | "shared" | "auto" | null,
  savedOnly = false,
): Promise<V2WeekPlanData> {
  const saved = ["director", "shared"] as const;
  const ordered: Array<"director" | "shared" | "auto"> = savedOnly
    ? [...savedScopeOrder(preferredScope)]
    : preferredScope === "director" || preferredScope === "shared"
      ? [preferredScope, ...saved.filter((scope) => scope !== preferredScope), "auto"]
      : ["shared", "director", "auto"];
  for (const scope of ordered) {
    const raw = await fetchWeekPlanScope(siteId, isoWeek, scope);
    const normalized = normalizeWeekPlan(raw as Record<string, unknown>);
    if (normalized) return { ...normalized, sourceScope: scope };
  }
  return null;
}

async function loadSavedWeekPlanOnly(
  siteId: string,
  isoWeek: string,
  preferredScope?: "director" | "shared" | "auto" | null,
  options?: LoadWeekPlanOptions,
): Promise<V2WeekPlanData> {
  const omitWorkers = options?.omitWorkers === true;
  for (const scope of savedScopeOrder(preferredScope)) {
    const altsP = fetchWeekPlanRaw(siteId, isoWeek, scope, { parts: "alternatives", omitWorkers });
    const raw = await fetchWeekPlanRaw(siteId, isoWeek, scope, { parts: "base", omitWorkers });
    const finished = await finishWeekPlanLoad(raw, altsP, scope, options);
    if (finished) return { ...finished, sourceScope: finished.sourceScope ?? scope };
  }
  return null;
}

function mergeWeekPlanAlternatives(
  base: NonNullable<V2WeekPlanData>,
  altsRaw: Record<string, unknown> | null,
): NonNullable<V2WeekPlanData> {
  const alternatives = Array.isArray(altsRaw?.alternatives)
    ? (altsRaw.alternatives as Record<string, Record<string, string[][]>>[])
    : [];
  const alternativePulls = Array.isArray(altsRaw?.alternative_pulls)
    ? (altsRaw.alternative_pulls as Record<string, unknown>[])
    : Array.isArray(altsRaw?.alternativePulls)
      ? (altsRaw.alternativePulls as Record<string, unknown>[])
      : [];
  return { ...base, alternatives, alternativePulls };
}

async function finishWeekPlanLoad(
  baseRaw: Record<string, unknown> | null,
  altsPromise: Promise<Record<string, unknown> | null>,
  fallbackScope: "director" | "shared" | "auto",
  options?: LoadWeekPlanOptions,
): Promise<V2WeekPlanData> {
  const normalized = normalizeWeekPlan(baseRaw);
  if (!normalized) return null;
  const withScope: NonNullable<V2WeekPlanData> = {
    ...normalized,
    sourceScope: normalized.sourceScope ?? asSourceScope(baseRaw?._source_scope) ?? fallbackScope,
  };
  if (baseRaw?._alts_omitted !== true) {
    return withScope;
  }
  options?.onBase?.(withScope);
  const altsRaw = await altsPromise;
  return mergeWeekPlanAlternatives(withScope, altsRaw);
}

/** Plan auto sans snapshot workers — même assignments / pulls / ordre des חלופות. */
export type AutoWeekPlanLite = {
  assignments: Record<string, Record<string, string[][]>>;
  pulls: Record<string, unknown>;
  alternatives: Record<string, Record<string, string[][]>>[];
  alternative_pulls: Record<string, unknown>[];
};

export function toAutoWeekPlanLite(plan: NonNullable<V2WeekPlanData>): AutoWeekPlanLite {
  return {
    assignments: plan.assignments,
    pulls: plan.pulls && typeof plan.pulls === "object" ? plan.pulls : {},
    alternatives: Array.isArray(plan.alternatives) ? plan.alternatives : [],
    alternative_pulls: Array.isArray(plan.alternativePulls) ? plan.alternativePulls : [],
  };
}

export async function loadAutoWeekPlanLite(siteId: string, isoWeek: string): Promise<AutoWeekPlanLite | null> {
  // Fond / sync rail : un GET full (pas base+alternatives). Même payload, moins d’allers-retours.
  const raw = await fetchWeekPlanRaw(siteId, isoWeek, "auto", { omitWorkers: true });
  const plan = normalizeWeekPlan(raw);
  if (!plan) return null;
  return toAutoWeekPlanLite(plan);
}

/** Un GET `scope=resolve` (même priorité qu’avant : saved puis auto). */
export async function loadWeekPlanForSiteWeek(
  siteId: string,
  isoWeek: string,
  preferredScope?: "director" | "shared" | "auto" | null,
  options?: LoadWeekPlanOptions,
): Promise<V2WeekPlanData> {
  const omitWorkers = options?.omitWorkers === true;
  if (options?.savedOnly) {
    return loadSavedWeekPlanOnly(siteId, isoWeek, preferredScope, options);
  }
  if (options?.lightweightNav) {
    const altsP = fetchWeekPlanRaw(siteId, isoWeek, "auto", { parts: "alternatives", omitWorkers });
    const raw = await fetchWeekPlanRaw(siteId, isoWeek, "auto", { parts: "base", omitWorkers });
    return finishWeekPlanLoad(raw, altsP, "auto", options);
  }
  const prefer =
    preferredScope === "director" || preferredScope === "shared" ? preferredScope : undefined;
  try {
    const altsP = fetchWeekPlanRaw(siteId, isoWeek, "resolve", {
      prefer,
      parts: "alternatives",
      omitWorkers,
    });
    const raw = await fetchWeekPlanRaw(siteId, isoWeek, "resolve", {
      prefer,
      parts: "base",
      omitWorkers,
    });
    const finished = await finishWeekPlanLoad(raw, altsP, "director", options);
    if (finished) return finished;
    if (raw == null) {
      return loadWeekPlanWaterfall(siteId, isoWeek, preferredScope);
    }
    return null;
  } catch {
    // Backend pas encore déployé : ancien waterfall, même résultat.
    return loadWeekPlanWaterfall(siteId, isoWeek, preferredScope);
  }
}

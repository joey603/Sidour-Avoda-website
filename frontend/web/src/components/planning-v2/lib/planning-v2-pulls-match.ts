/** Helpers de matching / comptage des משיכות pour le filtrage SSE. */

export function pullsLimitPayload(autoPullsEnabled: boolean, autoPullsLimit: string): number | null | undefined {
  if (!autoPullsEnabled) return undefined;
  if (autoPullsLimit === "unlimited") return null;
  const n = Number(autoPullsLimit);
  return Number.isFinite(n) ? n : undefined;
}

export function pullsCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.keys(value as Record<string, unknown>).length;
}

/** מגבלת משיכות = plafond « עד N » (0 inclus). Ne pas exiger au moins une משיכה. */
export function pullsMatchRequestedCount(pulls: unknown, requestedCount: number | null): boolean {
  const count = pullsCount(pulls);
  if (requestedCount == null) return true;
  return count <= requestedCount;
}

export function linkedPlansMatchRequestedPulls(
  plans: Record<string, { pulls?: unknown }> | null | undefined,
  siteId: string,
  requestedCount: number | null,
  pullsScope?: "current_only" | "all_sites",
): boolean {
  if (!plans || typeof plans !== "object") return false;
  if (pullsScope === "current_only") {
    return pullsMatchRequestedCount(plans[String(siteId)]?.pulls, requestedCount);
  }
  const entries = Object.values(plans);
  return entries.length > 0 && entries.every((plan) => pullsMatchRequestedCount(plan?.pulls, requestedCount));
}

export function logPlanningV2PullCandidate(params: {
  itemType: "base" | "alternative";
  appendMode: boolean;
  linked: boolean;
  siteId: string;
  weekIso: string;
  eventIndex: unknown;
  generationId: unknown;
  requestedCount: number | null;
  pullsScope?: "current_only" | "all_sites";
  pulls?: unknown;
  plans?: Record<string, { pulls?: unknown }> | null;
}) {
  void params;
}

import {
  readLinkedPlansFromMemory,
  saveLinkedPlansToMemory,
  type LinkedSitePlan,
} from "./multi-site-linked-memory";

export function pruneLinkedPlansMemoryAfterStop(
  weekStart: Date,
  linkedSitesLength: number,
  visibleAlternativeCount: number,
): void {
  if (linkedSitesLength <= 1) return;
  const mem = readLinkedPlansFromMemory(weekStart);
  if (!mem?.plansBySite || typeof mem.plansBySite !== "object") return;
  const maxVisibleIndex = Math.max(0, visibleAlternativeCount - 1);
  const maxStoredAlternatives = maxVisibleIndex;
  const nextPlans: Record<string, LinkedSitePlan> = {};
  let changed = false;
  for (const [sid, plan] of Object.entries(mem.plansBySite)) {
    if (!plan || typeof plan !== "object") continue;
    const alternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
    const alternativePulls = Array.isArray(plan.alternative_pulls) ? plan.alternative_pulls : [];
    const nextAlternatives = alternatives.slice(0, maxStoredAlternatives);
    const nextAlternativePulls = alternativePulls.slice(0, maxStoredAlternatives);
    nextPlans[sid] = {
      ...plan,
      alternatives: nextAlternatives,
      alternative_pulls: nextAlternativePulls,
    };
    if (nextAlternatives.length !== alternatives.length || nextAlternativePulls.length !== alternativePulls.length) {
      changed = true;
    }
  }
  const nextActiveIndex = Math.min(Math.max(0, Number(mem.activeAltIndex || 0)), maxVisibleIndex);
  if (!changed && nextActiveIndex === Math.max(0, Number(mem.activeAltIndex || 0))) return;
  saveLinkedPlansToMemory(weekStart, nextPlans, nextActiveIndex);
}

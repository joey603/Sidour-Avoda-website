import type { PlanningV2PullsMap, SiteSummary } from "../types";
import { countAssignedCellsForLinkedHoles, countRequiredSlotsFromSiteConfig } from "./linked-site-holes";
import { pullsCount, type PullsShiftKind } from "./planning-v2-pulls-match";

function shiftKindFromName(shiftName: string): PullsShiftKind | null {
  const s = String(shiftName || "").trim();
  const low = s.toLowerCase();
  if (/בוקר/.test(s) || low.startsWith("06") || low.includes("06-14")) return "morning";
  if (/צהר/.test(s) || low.startsWith("14") || low.includes("14-22")) return "noon";
  if (/לילה/.test(s) || low.includes("night") || low.startsWith("22") || low.includes("22-06")) return "night";
  return null;
}

/** Compte les משיכות dont la cellule cible matche les kinds préférés. Mix (vide) = 0. */
export function preferredPullsCount(value: unknown, preferKinds?: PullsShiftKind[] | null): number {
  if (!preferKinds || preferKinds.length === 0) return 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const want = new Set(preferKinds);
  let total = 0;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const parts = String(key || "").split("|");
    if (parts.length < 2) continue;
    const kind = shiftKindFromName(parts[1] || "");
    if (kind && want.has(kind)) total += 1;
  }
  return total;
}

/** Compte les משיכות dont la cellule cible est צהריים (clé day|shift|…). */
export function noonPullsCount(value: unknown): number {
  return preferredPullsCount(value, ["noon"]);
}

export type HoleScore = {
  holes: number;
  assigned: number;
  required: number;
  pulls: number;
  noonPulls: number;
};

function pullsTargetGap(score: HoleScore, requestedPullsCount: number | null | undefined): number {
  if (requestedPullsCount == null || requestedPullsCount <= 0) return 0;
  return Math.max(0, requestedPullsCount - score.pulls);
}

/**
 * Attendre avant d’afficher la 1re vue :
 * il reste des trous et on n’a pas encore atteint N משיכות.
 * La préférence de kind est souple : ne pas bloquer s’il n’y a pas de משיכה demandée.
 */
export function shouldHoldPlanUntilPullTarget(
  score: HoleScore,
  requestedPullsCount: number | null | undefined,
  _preferKinds?: PullsShiftKind[] | null,
): boolean {
  if (score.holes <= 0) return false;
  if (requestedPullsCount != null && requestedPullsCount > 0 && score.pulls < requestedPullsCount) {
    return true;
  }
  return false;
}

/**
 * Avec préférence בוקר/צהריים/לילה : ne pas peindre la 1re vue tant qu’il n’y a
 * aucune משיכה du kind demandé (évite le flash « sans préférence » puis le saut).
 * Si aucun plan préféré n’arrive, le flush de fin affiche le fallback.
 */
export function shouldHoldFirstPlanForPreference(
  score: HoleScore,
  preferKinds?: PullsShiftKind[] | null,
): boolean {
  if (!preferKinds || preferKinds.length === 0) return false;
  return score.noonPulls <= 0;
}

/**
 * <0 si a est meilleur que b.
 * 1) moins de trous
 * 2) plus de משיכות sur les kinds préférés (vide = mix, no-op)
 * 3) si une limite N est demandée : se rapprocher de N משיכות
 * 4) plus de créneaux couverts
 */
export function compareHoleScores(
  a: HoleScore,
  b: HoleScore,
  requestedPullsCount?: number | null,
): number {
  if (a.holes !== b.holes) return a.holes - b.holes;
  if (a.noonPulls !== b.noonPulls) return b.noonPulls - a.noonPulls;
  const gapA = pullsTargetGap(a, requestedPullsCount);
  const gapB = pullsTargetGap(b, requestedPullsCount);
  if (gapA !== gapB) return gapA - gapB;
  if (requestedPullsCount == null && a.pulls !== b.pulls) return a.pulls - b.pulls;
  if (a.assigned !== b.assigned) return b.assigned - a.assigned;
  return 0;
}

export function singlePlanHoleScore(
  site: SiteSummary | null,
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: PlanningV2PullsMap | null | undefined,
  preferKinds?: PullsShiftKind[] | null,
): HoleScore {
  const required = countRequiredSlotsFromSiteConfig(site);
  const assigned = countAssignedCellsForLinkedHoles(assignments, pulls || {});
  return {
    assigned,
    required,
    holes: Math.max(0, required - assigned),
    pulls: pullsCount(pulls),
    noonPulls: preferredPullsCount(pulls, preferKinds),
  };
}

export function linkedPlansHoleScore(
  plans: Record<string, { assignments?: unknown; pulls?: unknown; required_count?: unknown }> | null | undefined,
  currentSiteId: string,
  currentSite: SiteSummary | null,
  preferKinds?: PullsShiftKind[] | null,
): HoleScore {
  let assigned = 0;
  let required = 0;
  let totalPulls = 0;
  let totalNoonPulls = 0;
  for (const [siteKey, plan] of Object.entries(plans || {})) {
    const assignments =
      plan?.assignments && typeof plan.assignments === "object"
        ? (plan.assignments as Record<string, Record<string, string[][]>>)
        : null;
    const pulls =
      plan?.pulls && typeof plan.pulls === "object" ? (plan.pulls as PlanningV2PullsMap) : {};
    totalPulls += pullsCount(pulls);
    totalNoonPulls += preferredPullsCount(pulls, preferKinds);
    assigned += countAssignedCellsForLinkedHoles(assignments, pulls);
    const rawRequired = Number(plan?.required_count);
    required +=
      Number.isFinite(rawRequired) && rawRequired > 0
        ? rawRequired
        : String(siteKey) === String(currentSiteId)
          ? countRequiredSlotsFromSiteConfig(currentSite)
          : 0;
  }
  return {
    assigned,
    required,
    holes: Math.max(0, required - assigned),
    pulls: totalPulls,
    noonPulls: totalNoonPulls,
  };
}

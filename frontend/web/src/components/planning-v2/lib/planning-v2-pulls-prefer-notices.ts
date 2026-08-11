import { preferredPullsCount } from "./planning-v2-hole-scores";
import { pullsCount, type PullsShiftKind } from "./planning-v2-pulls-match";

const KIND_LABEL_HE: Record<PullsShiftKind, string> = {
  morning: "בוקר",
  noon: "צהריים",
  night: "לילה",
};

export function hebrewPreferKindsLabel(kinds: PullsShiftKind[]): string {
  const parts = kinds.map((k) => KIND_LABEL_HE[k]).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} ו${parts[1]}`;
  return `${parts[0]}, ${parts[1]} ו${parts[2]}`;
}

/** Au moins une משיכה hors kinds préférés. */
export function planHasNonPreferredPulls(
  pulls: unknown,
  preferKinds?: PullsShiftKind[] | null,
): boolean {
  if (!preferKinds || preferKinds.length === 0) return false;
  const total = pullsCount(pulls);
  if (total <= 0) return false;
  return preferredPullsCount(pulls, preferKinds) < total;
}

export function anyPlanHasPreferredPulls(
  pullMaps: unknown[],
  preferKinds?: PullsShiftKind[] | null,
): boolean {
  if (!preferKinds || preferKinds.length === 0) return false;
  return pullMaps.some((p) => preferredPullsCount(p, preferKinds) > 0);
}

export function anyPlanHasNonPreferredPulls(
  pullMaps: unknown[],
  preferKinds?: PullsShiftKind[] | null,
): boolean {
  return pullMaps.some((p) => planHasNonPreferredPulls(p, preferKinds));
}

/**
 * Premier index dont les משיכות ne sont plus uniquement le kind préféré
 * (matin / nuit / mixte / autre).
 */
export function firstNonExclusivePreferredIndex(
  pullMaps: unknown[],
  preferKinds?: PullsShiftKind[] | null,
): number | null {
  if (!preferKinds || preferKinds.length === 0) return null;
  for (let i = 0; i < pullMaps.length; i += 1) {
    if (planHasNonPreferredPulls(pullMaps[i], preferKinds)) return i;
  }
  return null;
}

export function pullsPreferFallbackToastCopy(kinds: PullsShiftKind[]): {
  title: string;
  description: string;
} {
  const label = hebrewPreferKindsLabel(kinds);
  return {
    title: `לא נוצרו משיכות ${label}`,
    description: "נוצרו משיכות במשמרות אחרות — אין מספיק אפשרויות במשמרת המועדפת.",
  };
}

export function pullsPreferMixedAltsToastCopy(kinds: PullsShiftKind[]): {
  title: string;
  description: string;
} {
  const label = hebrewPreferKindsLabel(kinds);
  return {
    title: `מכאן והלאה — לא רק משיכות ${label}`,
    description: "החלופות הבאות כוללות משיכות במשמרות אחרות או מעורבות.",
  };
}

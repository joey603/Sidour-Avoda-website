export const DEFAULT_MAX_SHIFTS = 5;

export function resolveMaxShifts(...values: unknown[]): number {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return DEFAULT_MAX_SHIFTS;
}

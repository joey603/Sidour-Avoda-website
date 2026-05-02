const EMPTY_WORKER_AVAILABILITY = {
  sun: [] as string[],
  mon: [] as string[],
  tue: [] as string[],
  wed: [] as string[],
  thu: [] as string[],
  fri: [] as string[],
  sat: [] as string[],
};

const AVAILABILITY_DAY_KEYS = Object.keys(EMPTY_WORKER_AVAILABILITY) as Array<keyof typeof EMPTY_WORKER_AVAILABILITY>;

function normStationsMeta(x: Record<string, unknown> | null | undefined): string {
  const raw = x?._stations;
  if (!Array.isArray(raw)) return "";
  return JSON.stringify([...raw].map(String).sort());
}

/** Vrai seulement si la grille jour / משמרת a changé (pas nom, rôles, max_shifts). */
export function isAvailabilityDayShiftChanged(
  before: Record<string, string[]> | null | undefined,
  after: Record<string, string[]> | null | undefined,
): boolean {
  try {
    const norm = (x: Record<string, string[]> | null | undefined) => {
      const b = x || EMPTY_WORKER_AVAILABILITY;
      const o: Record<string, string[]> = {};
      for (const k of AVAILABILITY_DAY_KEYS) {
        o[k] = [...(b[k] || [])].map(String).sort();
      }
      return JSON.stringify(o);
    };
    return (
      norm(before) !== norm(after) ||
      normStationsMeta(before as Record<string, unknown>) !== normStationsMeta(after as Record<string, unknown>)
    );
  } catch {
    return true;
  }
}

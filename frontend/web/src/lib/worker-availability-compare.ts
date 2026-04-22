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
    return norm(before) !== norm(after);
  } catch {
    return true;
  }
}

/** True si au moins une cellule contient un nom non vide (aligné sur le planning). */
export function assignmentsNonEmpty(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
): boolean {
  if (!assignments || typeof assignments !== "object") return false;
  for (const dayKey of Object.keys(assignments)) {
    const shiftsMap = assignments[dayKey];
    if (!shiftsMap || typeof shiftsMap !== "object") continue;
    for (const shiftName of Object.keys(shiftsMap)) {
      const perStation = shiftsMap[shiftName];
      if (!Array.isArray(perStation)) continue;
      for (const cell of perStation) {
        if (Array.isArray(cell) && cell.some((n) => n && String(n).trim().length > 0)) return true;
      }
    }
  }
  return false;
}

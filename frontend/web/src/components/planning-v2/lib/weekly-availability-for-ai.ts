import type { WorkerAvailability } from "../types";

/** Même principe que `buildWeeklyAvailabilityForRequest` sur le planning : map nom → זמינות par jour. */
export function weeklyAvailabilityMapFromRows(
  rows: Array<{ name: string; availability?: WorkerAvailability }>,
): Record<string, WorkerAvailability> {
  const out: Record<string, WorkerAvailability> = {};
  const ensureDays = (wa: WorkerAvailability): WorkerAvailability => {
    const out: WorkerAvailability = {
      sun: Array.isArray(wa.sun) ? wa.sun : [],
      mon: Array.isArray(wa.mon) ? wa.mon : [],
      tue: Array.isArray(wa.tue) ? wa.tue : [],
      wed: Array.isArray(wa.wed) ? wa.wed : [],
      thu: Array.isArray(wa.thu) ? wa.thu : [],
      fri: Array.isArray(wa.fri) ? wa.fri : [],
      sat: Array.isArray(wa.sat) ? wa.sat : [],
    };
    if (Array.isArray(wa._stations) && wa._stations.length > 0) {
      out._stations = [...wa._stations];
    }
    return out;
  };
  for (const w of rows) {
    const name = String(w.name || "").trim();
    if (!name) continue;
    out[name] = ensureDays((w.availability || {}) as WorkerAvailability);
  }
  return out;
}

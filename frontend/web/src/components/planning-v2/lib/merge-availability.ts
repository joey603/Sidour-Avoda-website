import type { WorkerAvailability } from "../types";
import { EMPTY_WORKER_AVAILABILITY } from "./constants";
import { DAY_DEFS } from "./display";

export function mergeWorkerAvailability(
  baseAvailability: Record<string, string[]> | undefined,
  weekOverride: Record<string, string[]> | undefined,
  isNextWeekDisplay: boolean,
): WorkerAvailability {
  const merged: WorkerAvailability = { ...EMPTY_WORKER_AVAILABILITY };
  DAY_DEFS.forEach((dayDef) => {
    const dayKey = dayDef.key;
    if (Object.prototype.hasOwnProperty.call(weekOverride || {}, dayKey) && Array.isArray(weekOverride?.[dayKey])) {
      merged[dayKey] = [...(weekOverride?.[dayKey] || [])];
    } else if (isNextWeekDisplay) {
      merged[dayKey] = Array.isArray(baseAvailability?.[dayKey]) ? [...(baseAvailability?.[dayKey] || [])] : [];
    } else {
      merged[dayKey] = [];
    }
  });
  return merged;
}

export function cloneWorkerAvailability(av: WorkerAvailability | undefined): WorkerAvailability {
  const out: WorkerAvailability = { ...EMPTY_WORKER_AVAILABILITY };
  DAY_DEFS.forEach((dayDef) => {
    out[dayDef.key] = [...(av?.[dayDef.key] || [])];
  });
  return out;
}

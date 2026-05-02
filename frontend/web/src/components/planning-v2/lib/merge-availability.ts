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
  const metaWeek = weekOverride?._stations;
  const metaBase = baseAvailability?._stations;
  if (Array.isArray(metaWeek)) {
    merged._stations = [...metaWeek];
  } else if (isNextWeekDisplay && Array.isArray(metaBase)) {
    merged._stations = [...metaBase];
  }
  return merged;
}

export function cloneWorkerAvailability(av: WorkerAvailability | undefined): WorkerAvailability {
  const out: WorkerAvailability = { ...EMPTY_WORKER_AVAILABILITY };
  DAY_DEFS.forEach((dayDef) => {
    out[dayDef.key] = [...(av?.[dayDef.key] || [])];
  });
  if (Array.isArray(av?._stations)) {
    out._stations = [...av._stations];
  }
  return out;
}

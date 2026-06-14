import type { WorkerAvailability } from "../types";
import { EMPTY_WORKER_AVAILABILITY } from "./constants";
import { DAY_DEFS } from "./display";

/** Fusionne uniquement les overrides hebdomadaires (DB / localStorage). Pas de repli sur le profil global. */
export function mergeWorkerAvailability(
  weekOverride: Record<string, string[]> | undefined,
): WorkerAvailability {
  const merged: WorkerAvailability = { ...EMPTY_WORKER_AVAILABILITY };
  DAY_DEFS.forEach((dayDef) => {
    const dayKey = dayDef.key;
    if (Object.prototype.hasOwnProperty.call(weekOverride || {}, dayKey) && Array.isArray(weekOverride?.[dayKey])) {
      merged[dayKey] = [...(weekOverride?.[dayKey] || [])];
    } else {
      merged[dayKey] = [];
    }
  });
  if (Array.isArray(weekOverride?._stations)) {
    merged._stations = [...weekOverride._stations];
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

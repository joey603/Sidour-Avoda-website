"use client";

import { useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import { EMPTY_WORKER_AVAILABILITY } from "../lib/constants";
import {
  stripEventLocksFromAvailabilityMap,
  type EventAvailabilityLocksByWorkerId,
} from "../lib/event-availability-locks";
import { normWorkerName } from "../lib/planning-v2-worker-name";
import type { PlanningWorker, WorkerAvailability } from "../types";

type AssignmentsMap = Record<string, Record<string, string[][]>>;
type AvailabilityOverlays = Record<string, Record<string, string[]>>;

type UsePlanningV2AvailabilityOverlaysArgs = {
  workerRowsForTable: Array<PlanningWorker & { availability: WorkerAvailability }>;
  availabilityOverlays: AvailabilityOverlays;
  setAvailabilityOverlays: Dispatch<SetStateAction<AvailabilityOverlays>>;
  eventLocksByWorkerId: EventAvailabilityLocksByWorkerId;
  workers: PlanningWorker[];
  getLatestAssignmentBase: () => AssignmentsMap;
  displayAssignments: AssignmentsMap | null | undefined;
};

function cellHasWorker(
  base: AssignmentsMap | null | undefined,
  dayKey: string,
  shiftName: string,
  workerName: string,
): boolean {
  const target = normWorkerName(workerName);
  if (!target) return false;
  const perStation = base?.[dayKey]?.[shiftName];
  return Array.isArray(perStation)
    ? perStation.some(
        (cell) =>
          Array.isArray(cell) &&
          cell.some((nm) => normWorkerName(String(nm || "")) === target),
      )
    : false;
}

function hasWorkerInAnyShift(base: AssignmentsMap | null | undefined, workerName: string): boolean {
  const target = normWorkerName(workerName);
  if (!target) return false;
  for (const shiftsMap of Object.values(base || {})) {
    if (!shiftsMap || typeof shiftsMap !== "object") continue;
    for (const perStation of Object.values(shiftsMap)) {
      if (!Array.isArray(perStation)) continue;
      const found = perStation.some(
        (cell) =>
          Array.isArray(cell) &&
          cell.some((nm) => normWorkerName(String(nm || "")) === target),
      );
      if (found) return true;
    }
  }
  return false;
}

export function usePlanningV2AvailabilityOverlays({
  workerRowsForTable,
  availabilityOverlays,
  setAvailabilityOverlays,
  eventLocksByWorkerId,
  workers,
  getLatestAssignmentBase,
  displayAssignments,
}: UsePlanningV2AvailabilityOverlaysArgs) {
  const availabilityByWorkerName = useMemo(() => {
    const o: Record<string, WorkerAvailability> = {};
    for (const r of workerRowsForTable) {
      const nm = String(r.name || "").trim();
      if (!nm) continue;
      const base = (r.availability || {}) as WorkerAvailability;
      const overlay = (availabilityOverlays[nm] || {}) as Record<string, string[]>;
      const merged: WorkerAvailability = { ...EMPTY_WORKER_AVAILABILITY };
      for (const d of ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const) {
        const next = new Set<string>([...(base[d] || []), ...(overlay[d] || [])]);
        merged[d] = Array.from(next);
      }
      if (Array.isArray(base._stations) && base._stations.length > 0) {
        merged._stations = [...base._stations];
      }
      o[nm] = merged;
    }
    return stripEventLocksFromAvailabilityMap(o, eventLocksByWorkerId, workers) as Record<
      string,
      WorkerAvailability
    >;
  }, [workerRowsForTable, availabilityOverlays, eventLocksByWorkerId, workers]);

  const displayedAvailabilityOverlays = useMemo(() => {
    const base = getLatestAssignmentBase();
    const out: AvailabilityOverlays = {};
    for (const [workerName, byDay] of Object.entries(availabilityOverlays || {})) {
      const nextByDay: Record<string, string[]> = {};
      for (const [dayKey, shifts] of Object.entries(byDay || {})) {
        const kept: string[] = [];
        for (const shiftName of shifts || []) {
          const exists = cellHasWorker(base, dayKey, shiftName, workerName);
          if (exists) kept.push(shiftName);
        }
        if (kept.length > 0) nextByDay[dayKey] = kept;
      }
      if (Object.keys(nextByDay).length > 0) out[workerName] = nextByDay;
    }
    return out;
  }, [availabilityOverlays, displayAssignments, getLatestAssignmentBase]);

  // Nettoyage auto des overlays rouges quand le worker n'est plus réellement sur le planning.
  useEffect(() => {
    const base = getLatestAssignmentBase();
    setAvailabilityOverlays((prev) => {
      let changed = false;
      const next: AvailabilityOverlays = {};
      for (const [workerName, byDay] of Object.entries(prev || {})) {
        if (!hasWorkerInAnyShift(base, workerName)) {
          changed = true;
          continue;
        }
        const cleanedByDay: Record<string, string[]> = {};
        for (const [dayKey, shifts] of Object.entries(byDay || {})) {
          const kept = (shifts || []).filter((shiftName) => cellHasWorker(base, dayKey, shiftName, workerName));
          if (kept.length > 0) cleanedByDay[dayKey] = kept;
          if (kept.length !== (shifts || []).length) changed = true;
        }
        if (Object.keys(cleanedByDay).length > 0) next[workerName] = cleanedByDay;
      }
      return changed ? next : prev;
    });
  }, [displayAssignments, getLatestAssignmentBase, setAvailabilityOverlays]);

  return {
    availabilityByWorkerName,
    displayedAvailabilityOverlays,
  };
}

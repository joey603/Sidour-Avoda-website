import { apiFetch } from "@/lib/api";
import type { PlanningWorker, WorkerAvailability } from "../types";
import { formatHebDate, getWeekKeyISO } from "./week";

function isoPlanKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function buildWorkersSnapshotForSave(workers: PlanningWorker[]) {
  return workers.map((w) => ({
    id: w.id,
    name: w.name,
    max_shifts: typeof w.maxShifts === "number" ? w.maxShifts : 0,
    roles: Array.isArray(w.roles) ? w.roles : [],
    availability: (w.availability || {}) as WorkerAvailability,
    answers: (w.answers && typeof w.answers === "object" ? w.answers : {}) as Record<string, unknown>,
    phone: w.phone ?? null,
    linked_site_ids: Array.isArray(w.linkedSiteIds) ? w.linkedSiteIds : [],
    linked_site_names: Array.isArray(w.linkedSiteNames) ? w.linkedSiteNames : [],
  }));
}

export function buildWeekPlanDataPayload(
  siteId: number,
  weekStart: Date,
  assignments: Record<string, Record<string, string[][]>> | null,
  pulls: Record<string, unknown>,
  workersSnapshot: ReturnType<typeof buildWorkersSnapshotForSave>,
  isManualPlan: boolean,
) {
  const start = new Date(weekStart);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return {
    siteId,
    week: {
      startISO: isoPlanKey(start),
      endISO: isoPlanKey(end),
      label: `${formatHebDate(start)} — ${formatHebDate(end)}`,
    },
    isManual: isManualPlan,
    assignments,
    pulls,
    workers: workersSnapshot,
  };
}

export async function persistWeekPlanToApi(
  siteId: string,
  weekStart: Date,
  publishToWorkers: boolean,
  data: Record<string, unknown>,
): Promise<void> {
  const scope = publishToWorkers ? "shared" : "director";
  const week_iso = getWeekKeyISO(weekStart);
  await apiFetch(`/director/sites/${siteId}/week-plan`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
    body: JSON.stringify({ week_iso, scope, data }),
  });
}

/** Brouillon תכנון אוטומטי (scope `auto`) — mis à jour après chaque génération IA réussie. */
export async function persistAutoWeekPlanDraftToApi(
  siteId: string,
  weekStart: Date,
  data: Record<string, unknown>,
): Promise<void> {
  const week_iso = getWeekKeyISO(weekStart);
  await apiFetch(`/director/sites/${siteId}/week-plan`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
    body: JSON.stringify({ week_iso, scope: "auto", data }),
  });
}

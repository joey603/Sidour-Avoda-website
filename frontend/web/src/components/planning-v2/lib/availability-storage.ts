import { apiFetch } from "@/lib/api";
import type { WorkerAvailability } from "../types";
import { getWeekKeyISO } from "./week";

function isoWeekSunday(d: Date): string {
  const x = new Date(d);
  const iso = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  const wk = new Date(x);
  wk.setDate(x.getDate() - x.getDay());
  return iso(wk);
}

/** Clé localStorage pour les overrides de זמינות (identique au planning). */
export function availabilityStorageKey(siteId: string, date: Date): string {
  return `avail_${siteId}_${isoWeekSunday(date)}`;
}

export function readWeeklyAvailabilityForSiteWeek(
  siteId: string,
  weekStart: Date,
): Record<string, WorkerAvailability> {
  try {
    if (typeof window === "undefined") return {};
    const raw = localStorage.getItem(availabilityStorageKey(siteId, weekStart));
    if (!raw) return {};
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Écrit localStorage + API (aligné sur le planning director). */
export async function persistWeeklyAvailabilityForSiteWeek(
  siteId: string,
  weekStart: Date,
  next: Record<string, WorkerAvailability>,
): Promise<void> {
  try {
    if (typeof window !== "undefined") {
      localStorage.setItem(availabilityStorageKey(siteId, weekStart), JSON.stringify(next));
    }
  } catch {
    /* ignore */
  }
  try {
    const wk = getWeekKeyISO(weekStart);
    await apiFetch(`/director/sites/${siteId}/weekly-availability`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
      body: JSON.stringify({ week_iso: wk, availability: next }),
    });
  } catch {
    /* local only */
  }
}

export async function persistWorkerNameWeeklyOverride(
  siteId: string,
  weekStart: Date,
  workerName: string,
  availability: WorkerAvailability,
): Promise<void> {
  const cur = readWeeklyAvailabilityForSiteWeek(siteId, weekStart);
  await persistWeeklyAvailabilityForSiteWeek(siteId, weekStart, { ...cur, [workerName]: { ...availability } });
}

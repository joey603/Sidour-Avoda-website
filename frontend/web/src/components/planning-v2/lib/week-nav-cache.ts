"use client";

import { apiFetch } from "@/lib/api";
import { resolveMaxShifts } from "@/lib/max-shifts";
import type { PlanningWorker, WorkerAvailability } from "../types";
import { EMPTY_WORKER_AVAILABILITY } from "./constants";
import { addDays, getWeekKeyISO } from "./week";
import { loadWeekPlanForSiteWeek, type V2WeekPlanData } from "./week-plan-fetch";

type WeekNavWorkersCacheEntry = {
  workers: PlanningWorker[];
  weeklyAvailability: Record<string, WorkerAvailability>;
};

const weekPlanCache = new Map<string, V2WeekPlanData>();
const weekWorkersCache = new Map<string, WeekNavWorkersCacheEntry>();
const prefetchInFlight = new Set<string>();

function cacheKey(siteId: string, weekIso: string) {
  return `${siteId}|${weekIso}`;
}

export function getCachedWeekPlan(siteId: string, weekIso: string): V2WeekPlanData | undefined {
  const key = cacheKey(siteId, weekIso);
  return weekPlanCache.has(key) ? weekPlanCache.get(key) : undefined;
}

export function setCachedWeekPlan(siteId: string, weekIso: string, plan: V2WeekPlanData) {
  weekPlanCache.set(cacheKey(siteId, weekIso), plan);
}

/** Oublie les טיוטות auto en cache (garde director/shared) pour ne pas repeindre l’ancien plan. */
export function discardCachedAutoWeekPlans(siteIds: Array<string | number>, weekIso: string): void {
  const wk = String(weekIso || "").trim();
  if (!wk) return;
  for (const sid of siteIds) {
    const id = String(sid);
    const cached = getCachedWeekPlan(id, wk);
    if (cached?.sourceScope === "director" || cached?.sourceScope === "shared") continue;
    weekPlanCache.delete(cacheKey(id, wk));
  }
}

export function getCachedWeekWorkers(siteId: string, weekIso: string): WeekNavWorkersCacheEntry | undefined {
  return weekWorkersCache.get(cacheKey(siteId, weekIso));
}

export function setCachedWeekWorkers(
  siteId: string,
  weekIso: string,
  workers: PlanningWorker[],
  weeklyAvailability: Record<string, WorkerAvailability>,
) {
  weekWorkersCache.set(cacheKey(siteId, weekIso), { workers, weeklyAvailability });
}

function mapApiWorker(w: Record<string, unknown>): PlanningWorker {
  return {
    id: Number(w.id),
    name: String(w.name),
    maxShifts: resolveMaxShifts(w.max_shifts, w.maxShifts),
    roles: Array.isArray(w.roles) ? (w.roles as string[]) : [],
    availability: (w.availability as PlanningWorker["availability"]) || { ...EMPTY_WORKER_AVAILABILITY },
    answers: (w.answers as Record<string, unknown>) || {},
    phone: (w.phone as string | null | undefined) ?? null,
    linkedSiteIds: Array.isArray(w.linked_site_ids) ? (w.linked_site_ids as number[]) : [],
    linkedSiteNames: Array.isArray(w.linked_site_names) ? (w.linked_site_names as string[]) : [],
    pendingApproval: !!(w.pending_approval ?? w.pendingApproval),
    createdAt: Number(w.created_at ?? w.createdAt ?? 0) || 0,
    removedFromWeekIso: (w.removed_from_week_iso as string | null | undefined) ?? null,
  };
}

async function prefetchOneWeek(
  siteId: string,
  weekStart: Date,
  preferredScope?: "director" | "shared" | "auto" | null,
) {
  const weekIso = getWeekKeyISO(weekStart);
  const key = cacheKey(siteId, weekIso);
  if (prefetchInFlight.has(key)) return;
  const hasPlan = weekPlanCache.has(key);
  const hasWorkers = weekWorkersCache.has(key);
  if (hasPlan && hasWorkers) return;
  prefetchInFlight.add(key);
  try {
    const [plan, workersRaw, availRaw] = await Promise.all([
      hasPlan
        ? Promise.resolve(weekPlanCache.get(key) ?? null)
        : loadWeekPlanForSiteWeek(siteId, weekIso, preferredScope, { omitWorkers: true }),
      hasWorkers
        ? Promise.resolve(null)
        : apiFetch<Record<string, unknown>[]>(
            `/director/sites/${siteId}/workers?week=${encodeURIComponent(weekIso)}`,
            { cache: "no-store" as RequestCache },
          ).catch(() => null),
      hasWorkers
        ? Promise.resolve(null)
        : apiFetch<Record<string, WorkerAvailability>>(
            `/director/sites/${siteId}/weekly-availability?week=${encodeURIComponent(weekIso)}`,
            { cache: "no-store" as RequestCache },
          ).catch(() => null),
    ]);
    if (!hasPlan) {
      setCachedWeekPlan(siteId, weekIso, plan);
    }
    if (!hasWorkers && Array.isArray(workersRaw)) {
      const workers = workersRaw.map((row) => mapApiWorker(row));
      const weeklyAvailability =
        availRaw && typeof availRaw === "object" ? (availRaw as Record<string, WorkerAvailability>) : {};
      setCachedWeekWorkers(siteId, weekIso, workers, weeklyAvailability);
    }
  } catch {
    /* prefetch best-effort */
  } finally {
    prefetchInFlight.delete(key);
  }
}

/** Prefetch prev/next week workers + week-plan pour un clic quasi immédiat. */
export function prefetchAdjacentWeeks(
  siteId: string,
  weekStart: Date,
  preferredScope?: "director" | "shared" | "auto" | null,
) {
  const id = Number(siteId);
  if (!Number.isFinite(id) || id <= 0) return;
  void prefetchOneWeek(siteId, addDays(weekStart, -7), preferredScope);
  void prefetchOneWeek(siteId, addDays(weekStart, 7), preferredScope);
}

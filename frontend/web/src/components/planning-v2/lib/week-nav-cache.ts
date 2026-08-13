"use client";

import { apiFetch } from "@/lib/api";
import { resolveMaxShifts } from "@/lib/max-shifts";
import type { PlanningWorker, WorkerAvailability } from "../types";
import { EMPTY_WORKER_AVAILABILITY } from "./constants";
import { addDays, currentWeekStart, getWeekKeyISO } from "./week";
import { clearLinkedPlansMemoryExcept } from "./multi-site-linked-memory";
import { loadWeekPlanForSiteWeek, type V2WeekPlanData } from "./week-plan-fetch";

type WeekNavWorkersCacheEntry = {
  workers: PlanningWorker[];
  weeklyAvailability: Record<string, WorkerAvailability>;
};

const weekPlanCache = new Map<string, V2WeekPlanData>();
const weekWorkersCache = new Map<string, WeekNavWorkersCacheEntry>();
const prefetchInFlight = new Set<string>();
/** Semaines dont les טיוטות auto / חלופות restent en cache (actuelle + suivante). */
const retainedUnsavedWeekIsos = new Set<string>();

function cacheKey(siteId: string, weekIso: string) {
  return `${siteId}|${weekIso}`;
}

function parseCacheKey(key: string): { siteId: string; weekIso: string } | null {
  const sep = key.indexOf("|");
  if (sep <= 0) return null;
  return { siteId: key.slice(0, sep), weekIso: key.slice(sep + 1) };
}

function isSavedWeekPlan(plan: V2WeekPlanData): boolean {
  return plan?.sourceScope === "director" || plan?.sourceScope === "shared";
}

function normalizeKeepWeekIsos(weekIsos: string[]): string[] {
  return Array.from(new Set(weekIsos.map((w) => String(w || "").trim()).filter(Boolean)));
}

export function getCachedWeekPlan(siteId: string, weekIso: string): V2WeekPlanData | undefined {
  const key = cacheKey(siteId, weekIso);
  return weekPlanCache.has(key) ? weekPlanCache.get(key) : undefined;
}

export function setCachedWeekPlan(siteId: string, weekIso: string, plan: V2WeekPlanData) {
  if (retainedUnsavedWeekIsos.size > 0 && !retainedUnsavedWeekIsos.has(weekIso) && !isSavedWeekPlan(plan)) {
    weekPlanCache.delete(cacheKey(siteId, weekIso));
    return;
  }
  weekPlanCache.set(cacheKey(siteId, weekIso), plan);
}

/** Oublie les טיוטות auto en cache (garde director/shared) pour ne pas repeindre l’ancien plan. */
export function discardCachedAutoWeekPlans(siteIds: Array<string | number>, weekIso: string): void {
  const wk = String(weekIso || "").trim();
  if (!wk) return;
  for (const sid of siteIds) {
    const id = String(sid);
    const cached = getCachedWeekPlan(id, wk);
    if (isSavedWeekPlan(cached)) continue;
    weekPlanCache.delete(cacheKey(id, wk));
  }
}

function weekIsoFromStorageKey(key: string): string | null {
  const match = String(key || "").match(/(\d{4}-\d{2}-\d{2})$/);
  return match ? match[1] : null;
}

function isSavedPlanStorageKey(key: string): boolean {
  return key.startsWith("plan_director_") || key.startsWith("plan_shared_");
}

function isUnsavedPlanStorageKey(key: string): boolean {
  if (!key || isSavedPlanStorageKey(key)) return false;
  return (
    key.startsWith("plan_") ||
    key.startsWith("multi_site_generated_") ||
    key.startsWith("planning_v2_page_generated_auto_draft_")
  );
}

function discardUnsavedBrowserPlanKeysExcept(keepWeekIsos: string[]): void {
  if (typeof window === "undefined") return;
  const keep = new Set(normalizeKeepWeekIsos(keepWeekIsos));
  const stores: Storage[] = [];
  try {
    stores.push(localStorage, sessionStorage);
  } catch {
    return;
  }
  for (const store of stores) {
    const removed: string[] = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (!key || !isUnsavedPlanStorageKey(key)) continue;
        const weekIso = weekIsoFromStorageKey(key);
        if (keep.size > 0 && weekIso && keep.has(weekIso)) continue;
        removed.push(key);
      }
      for (const key of removed) store.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

/** `keepWeekIsos` vide = aucune טיוטה auto conservée. */
export function retainUnsavedCachedWeekPlans(keepWeekIsos: string[]): void {
  const keep = normalizeKeepWeekIsos(keepWeekIsos);
  retainedUnsavedWeekIsos.clear();
  for (const wk of keep) retainedUnsavedWeekIsos.add(wk);
  for (const key of Array.from(weekPlanCache.keys())) {
    const parsed = parseCacheKey(key);
    if (!parsed) continue;
    if (keep.length > 0 && retainedUnsavedWeekIsos.has(parsed.weekIso)) continue;
    if (isSavedWeekPlan(weekPlanCache.get(key))) continue;
    weekPlanCache.delete(key);
  }
}

/** Cache mémoire + session/local : brouillons יצירת תכנון non sauvegardés. Liste vide = tout effacer. */
export function discardUnsavedWeekArtifactsExcept(keepWeekIsos: string[] = []): void {
  retainUnsavedCachedWeekPlans(keepWeekIsos);
  clearLinkedPlansMemoryExcept(keepWeekIsos);
  discardUnsavedBrowserPlanKeysExcept(keepWeekIsos);
}

/**
 * Vider les unsaved au changement de semaine, ou à l’ouverture depuis la liste אתרים.
 * Ne pas vider pendant « פתח אתר » (même session multi-sites).
 */
export function shouldDiscardUnsavedOnPlanningNav(opts: {
  firstLoad: boolean;
  weekChanged: boolean;
  siteChanged: boolean;
  inAppMultiSiteNav: boolean;
}): boolean {
  if (opts.weekChanged) return true;
  if (opts.inAppMultiSiteNav) return false;
  return opts.firstLoad || opts.siteChanged;
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
        : loadWeekPlanForSiteWeek(siteId, weekIso, preferredScope, { omitWorkers: true, savedOnly: true }),
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

/** Prefetch uniquement la semaine d’après calendaire (plan + workers). */
export function prefetchAdjacentWeeks(
  siteId: string,
  _weekStart: Date,
  preferredScope?: "director" | "shared" | "auto" | null,
) {
  const id = Number(siteId);
  if (!Number.isFinite(id) || id <= 0) return;
  void prefetchOneWeek(siteId, addDays(currentWeekStart(), 7), preferredScope);
}

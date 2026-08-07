"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { resolveMaxShifts } from "@/lib/max-shifts";
import { toast } from "sonner";
import type { PlanningWorker, SiteSummary, WorkerAvailability } from "../types";
import { EMPTY_WORKER_AVAILABILITY } from "../lib/constants";
import { availabilityStorageKey, readWeeklyAvailabilityForSiteWeek } from "../lib/availability-storage";
import { mergeWorkerAvailability } from "../lib/merge-availability";
import {
  getCachedWeekWorkers,
  prefetchAdjacentWeeks,
  setCachedWeekWorkers,
} from "../lib/week-nav-cache";
import {
  defaultPlanningWeekStart,
  getWeekKeyISO,
  parseWeekQueryParam,
} from "../lib/week";

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

function isWorkerVisibleForSelectedWeek(worker: PlanningWorker, weekStart: Date): boolean {
  const weekIso = getWeekKeyISO(weekStart);
  const createdAt = Number(worker.createdAt || 0);
  if (Number.isFinite(createdAt) && createdAt > 0) {
    const createdDate = new Date(createdAt);
    if (!Number.isNaN(createdDate.getTime())) {
      const createdWeek = new Date(createdDate);
      createdWeek.setDate(createdWeek.getDate() - createdWeek.getDay());
      createdWeek.setHours(0, 0, 0, 0);
      if (getWeekKeyISO(createdWeek) > weekIso) return false;
    }
  }
  const removedIso = String(worker.removedFromWeekIso || "").trim();
  if (removedIso && weekIso >= removedIso) return false;
  return true;
}

export function usePlanningV2SiteWorkers(siteId: string) {
  const searchParams = useSearchParams();
  const weekQuery = searchParams.get("week");

  const weekFromUrl = useMemo(() => parseWeekQueryParam(weekQuery), [weekQuery]);

  const [weekStart, setWeekStart] = useState<Date>(() => weekFromUrl ?? defaultPlanningWeekStart());

  useEffect(() => {
    if (weekFromUrl) {
      setWeekStart(weekFromUrl);
    }
  }, [weekFromUrl]);

  const [site, setSite] = useState<SiteSummary | null>(null);
  const [siteLoading, setSiteLoading] = useState(true);
  const initialWeekIso = getWeekKeyISO(weekFromUrl ?? defaultPlanningWeekStart());
  const initialWorkersCache = getCachedWeekWorkers(siteId, initialWeekIso);
  const [workers, setWorkers] = useState<PlanningWorker[]>(() => initialWorkersCache?.workers ?? []);
  const [workersLoading, setWorkersLoading] = useState(() => !initialWorkersCache);
  const loadReq = useRef(0);
  /** Disponibilités / demandes par nom — aligné sur `loadWeeklyAvailability` dans planning/[id]. */
  const [weeklyAvailability, setWeeklyAvailability] = useState<Record<string, WorkerAvailability>>(
    () => initialWorkersCache?.weeklyAvailability ?? {},
  );
  const weeklyAvailReq = useRef(0);
  const hasLoadedWorkersOnceRef = useRef(!!initialWorkersCache);
  const hasLoadedAvailOnceRef = useRef(!!initialWorkersCache);
  const prevWorkersWeekIsoRef = useRef<string | null>(initialWeekIso);
  const prevAvailWeekIsoRef = useRef<string | null>(initialWeekIso);
  const weeklyAvailabilityRef = useRef(weeklyAvailability);
  const workersRef = useRef(workers);
  weeklyAvailabilityRef.current = weeklyAvailability;
  workersRef.current = workers;

  const reloadSite = useCallback(async () => {
    const id = Number(siteId);
    if (!Number.isFinite(id) || id <= 0) {
      setSite(null);
      setSiteLoading(false);
      return;
    }
    setSiteLoading(true);
    try {
      const raw = await apiFetch<SiteSummary & { deleted_at?: number | null }>(`/director/sites/${siteId}`);
      const { deleted_at: deletedAtRaw, ...rest } = raw;
      setSite({ ...rest, deletedAt: deletedAtRaw ?? null });
    } catch {
      setSite(null);
      toast.error("לא ניתן לטעון את פרטי האתר");
    } finally {
      setSiteLoading(false);
    }
  }, [siteId]);

  const reloadWorkers = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    const id = Number(siteId);
    if (!Number.isFinite(id) || id <= 0) {
      setWorkers([]);
      setWorkersLoading(false);
      return;
    }
    const req = ++loadReq.current;
    const wk = getWeekKeyISO(weekStart);
    if (silent) {
      const cached = getCachedWeekWorkers(siteId, wk);
      if (cached) {
        setWorkers(cached.workers.filter((w) => isWorkerVisibleForSelectedWeek(w, weekStart)));
        if (Object.keys(cached.weeklyAvailability).length > 0) {
          setWeeklyAvailability(cached.weeklyAvailability);
        }
      }
    } else {
      setWorkersLoading(true);
    }
    try {
      const list = await apiFetch<Record<string, unknown>[]>(
        `/director/sites/${siteId}/workers?week=${encodeURIComponent(wk)}`,
        {
          cache: "no-store" as RequestCache,
        },
      );
      if (req !== loadReq.current) return;
      const mapped = (list || []).map((row) => mapApiWorker(row));
      const visible = mapped.filter((w) => isWorkerVisibleForSelectedWeek(w, weekStart));
      setWorkers(visible);
      const cachedAvail =
        getCachedWeekWorkers(siteId, wk)?.weeklyAvailability ?? weeklyAvailabilityRef.current;
      setCachedWeekWorkers(siteId, wk, visible, cachedAvail);
      prefetchAdjacentWeeks(siteId, weekStart, site?.next_week_saved_plan_status?.scope ?? null);
    } catch (e: unknown) {
      if (req !== loadReq.current) return;
      const msg = e instanceof Error ? e.message : "נסה שוב מאוחר יותר.";
      toast.error("שגיאה בטעינת עובדים", { description: msg });
      setWorkers([]);
    } finally {
      // Toujours couper le loading si c’est la requête courante (un reload silent
      // peut remplacer un premier chargement non-silent et sinon l’overlay reste coincé).
      if (req === loadReq.current) setWorkersLoading(false);
    }
  }, [siteId, weekStart, site?.next_week_saved_plan_status?.scope]);

  const reloadWeeklyAvailability = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    const id = Number(siteId);
    if (!Number.isFinite(id) || id <= 0) {
      setWeeklyAvailability({});
      return;
    }
    const req = ++weeklyAvailReq.current;
    const wk = getWeekKeyISO(weekStart);
    if (silent) {
      const cached = getCachedWeekWorkers(siteId, wk);
      if (cached && Object.keys(cached.weeklyAvailability).length > 0) {
        setWeeklyAvailability(cached.weeklyAvailability);
      }
    }
    try {
      const fromApi = await apiFetch<Record<string, WorkerAvailability>>(
        `/director/sites/${siteId}/weekly-availability?week=${encodeURIComponent(wk)}`,
        {
          cache: "no-store" as RequestCache,
        },
      );
      if (req !== weeklyAvailReq.current) return;
      const normalized =
        fromApi && typeof fromApi === "object" ? (fromApi as Record<string, WorkerAvailability>) : {};
      setWeeklyAvailability(normalized);
      const cachedWorkers = getCachedWeekWorkers(siteId, wk)?.workers ?? workersRef.current;
      setCachedWeekWorkers(siteId, wk, cachedWorkers, normalized);
      try {
        localStorage.setItem(availabilityStorageKey(siteId, weekStart), JSON.stringify(normalized));
      } catch {
        /* ignore */
      }
    } catch {
      if (req !== weeklyAvailReq.current) return;
      setWeeklyAvailability(readWeeklyAvailabilityForSiteWeek(siteId, weekStart));
    }
  }, [siteId, weekStart]);

  useEffect(() => {
    void reloadSite();
  }, [reloadSite]);

  useEffect(() => {
    const wk = getWeekKeyISO(weekStart);
    const weekChanged = prevWorkersWeekIsoRef.current != null && prevWorkersWeekIsoRef.current !== wk;
    prevWorkersWeekIsoRef.current = wk;
    // Animation au changement de semaine ; silent seulement pour un refresh même semaine.
    const silent = hasLoadedWorkersOnceRef.current && !weekChanged;
    hasLoadedWorkersOnceRef.current = true;
    void reloadWorkers({ silent });
  }, [reloadWorkers, weekStart]);

  useEffect(() => {
    const wk = getWeekKeyISO(weekStart);
    const weekChanged = prevAvailWeekIsoRef.current != null && prevAvailWeekIsoRef.current !== wk;
    prevAvailWeekIsoRef.current = wk;
    const silent = hasLoadedAvailOnceRef.current && !weekChanged;
    hasLoadedAvailOnceRef.current = true;
    void reloadWeeklyAvailability({ silent });
  }, [reloadWeeklyAvailability, weekStart]);

  const workerRowsForTable = useMemo(() => {
    return workers.map((worker) => ({
      ...worker,
      availability: mergeWorkerAvailability(weeklyAvailability[worker.name] || {}),
    }));
  }, [workers, weeklyAvailability]);

  return {
    site,
    siteLoading,
    reloadSite,
    workers,
    workersLoading,
    reloadWorkers,
    reloadWeeklyAvailability,
    weekKeyISO: getWeekKeyISO(weekStart),
    weekStart,
    workerRowsForTable,
  };
}

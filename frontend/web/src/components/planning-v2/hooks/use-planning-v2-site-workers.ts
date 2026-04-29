"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import type { PlanningWorker, SiteSummary, WorkerAvailability } from "../types";
import { EMPTY_WORKER_AVAILABILITY } from "../lib/constants";
import { availabilityStorageKey, readWeeklyAvailabilityForSiteWeek } from "../lib/availability-storage";
import { mergeWorkerAvailability } from "../lib/merge-availability";
import {
  defaultPlanningWeekStart,
  getWeekKeyISO,
  isNextWeekDisplayed,
  parseWeekQueryParam,
} from "../lib/week";

function mapApiWorker(w: Record<string, unknown>): PlanningWorker {
  return {
    id: Number(w.id),
    name: String(w.name),
    maxShifts: Number(w.max_shifts ?? w.maxShifts ?? 0),
    roles: Array.isArray(w.roles) ? (w.roles as string[]) : [],
    availability: (w.availability as PlanningWorker["availability"]) || { ...EMPTY_WORKER_AVAILABILITY },
    answers: (w.answers as Record<string, unknown>) || {},
    phone: (w.phone as string | null | undefined) ?? null,
    linkedSiteIds: Array.isArray(w.linked_site_ids) ? (w.linked_site_ids as number[]) : [],
    linkedSiteNames: Array.isArray(w.linked_site_names) ? (w.linked_site_names as string[]) : [],
    pendingApproval: !!(w.pending_approval ?? w.pendingApproval),
  };
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
  const [workers, setWorkers] = useState<PlanningWorker[]>([]);
  const [workersLoading, setWorkersLoading] = useState(true);
  const loadReq = useRef(0);
  /** Disponibilités / demandes par nom — aligné sur `loadWeeklyAvailability` dans planning/[id]. */
  const [weeklyAvailability, setWeeklyAvailability] = useState<Record<string, WorkerAvailability>>({});
  const weeklyAvailReq = useRef(0);

  const reloadSite = useCallback(async () => {
    const id = Number(siteId);
    if (!Number.isFinite(id) || id <= 0) {
      setSite(null);
      setSiteLoading(false);
      return;
    }
    setSiteLoading(true);
    try {
      const raw = await apiFetch<SiteSummary & { deleted_at?: number | null }>(`/director/sites/${siteId}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
      });
      const { deleted_at: deletedAtRaw, ...rest } = raw;
      setSite({ ...rest, deletedAt: deletedAtRaw ?? null });
    } catch {
      setSite(null);
      toast.error("לא ניתן לטעון את פרטי האתר");
    } finally {
      setSiteLoading(false);
    }
  }, [siteId]);

  const reloadWorkers = useCallback(async () => {
    const id = Number(siteId);
    if (!Number.isFinite(id) || id <= 0) {
      setWorkers([]);
      setWorkersLoading(false);
      return;
    }
    const req = ++loadReq.current;
    setWorkersLoading(true);
    try {
      const wk = getWeekKeyISO(weekStart);
      const list = await apiFetch<Record<string, unknown>[]>(
        `/director/sites/${siteId}/workers?week=${encodeURIComponent(wk)}`,
        {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          cache: "no-store" as RequestCache,
        },
      );
      if (req !== loadReq.current) return;
      setWorkers((list || []).map((row) => mapApiWorker(row)));
    } catch (e: unknown) {
      if (req !== loadReq.current) return;
      const msg = e instanceof Error ? e.message : "נסה שוב מאוחר יותר.";
      toast.error("שגיאה בטעינת עובדים", { description: msg });
      setWorkers([]);
    } finally {
      if (req === loadReq.current) setWorkersLoading(false);
    }
  }, [siteId, weekStart]);

  const reloadWeeklyAvailability = useCallback(async () => {
    const id = Number(siteId);
    if (!Number.isFinite(id) || id <= 0) {
      setWeeklyAvailability({});
      return;
    }
    const req = ++weeklyAvailReq.current;
    try {
      const wk = getWeekKeyISO(weekStart);
      const fromApi = await apiFetch<Record<string, WorkerAvailability>>(
        `/director/sites/${siteId}/weekly-availability?week=${encodeURIComponent(wk)}`,
        {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          cache: "no-store" as RequestCache,
        },
      );
      if (req !== weeklyAvailReq.current) return;
      const normalized =
        fromApi && typeof fromApi === "object" ? (fromApi as Record<string, WorkerAvailability>) : {};
      setWeeklyAvailability(normalized);
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
    void reloadWorkers();
  }, [reloadWorkers]);

  useEffect(() => {
    void reloadWeeklyAvailability();
  }, [reloadWeeklyAvailability]);

  const workerRowsForTable = useMemo(() => {
    const isNext = isNextWeekDisplayed(weekStart);
    return workers.map((worker) => ({
      ...worker,
      availability: mergeWorkerAvailability(
        worker.availability || EMPTY_WORKER_AVAILABILITY,
        weeklyAvailability[worker.name] || {},
        isNext,
      ),
    }));
  }, [workers, weeklyAvailability, weekStart]);

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

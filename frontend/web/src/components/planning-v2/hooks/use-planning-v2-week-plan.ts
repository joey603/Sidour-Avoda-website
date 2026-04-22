"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { getWeekKeyISO } from "../lib/week";

export type V2WeekPlanData = {
  assignments: Record<string, Record<string, string[][]>>;
  pulls?: Record<string, unknown>;
  isManual?: boolean;
  workers?: unknown[];
} | null;

async function fetchWeekPlanScope(siteId: string, isoWeek: string, scope: "director" | "shared" | "auto") {
  try {
    return await apiFetch<Record<string, unknown> | null>(
      `/director/sites/${siteId}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=${scope}`,
      {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        cache: "no-store" as RequestCache,
      },
    );
  } catch {
    return null;
  }
}

function normalizePlan(raw: Record<string, unknown> | null | undefined): V2WeekPlanData {
  if (!raw || typeof raw !== "object" || !raw.assignments) return null;
  return {
    assignments: raw.assignments as Record<string, Record<string, string[][]>>,
    pulls: raw.pulls && typeof raw.pulls === "object" ? (raw.pulls as Record<string, unknown>) : undefined,
    isManual: !!raw.isManual,
    workers: Array.isArray(raw.workers) ? raw.workers : undefined,
  };
}

/** Charge le תכנון שמור (director → shared → auto), comme `fetchExistingSavedPlanForSite` sur le planning. */
export function usePlanningV2WeekPlan(siteId: string, weekStart: Date) {
  const [plan, setPlan] = useState<V2WeekPlanData>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const id = Number(siteId);
    if (!Number.isFinite(id) || id <= 0) {
      setPlan(null);
      setLoading(false);
      return;
    }
    const isoWeek = getWeekKeyISO(weekStart);
    setLoading(true);
    try {
      const [fromDirector, fromShared, fromAuto] = await Promise.all([
        fetchWeekPlanScope(siteId, isoWeek, "director"),
        fetchWeekPlanScope(siteId, isoWeek, "shared"),
        fetchWeekPlanScope(siteId, isoWeek, "auto"),
      ]);
      const pick =
        normalizePlan(fromDirector as Record<string, unknown>) ||
        normalizePlan(fromShared as Record<string, unknown>) ||
        normalizePlan(fromAuto as Record<string, unknown>);
      setPlan(pick);
    } catch {
      setPlan(null);
    } finally {
      setLoading(false);
    }
  }, [siteId, weekStart]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { plan, loading, reloadWeekPlan: reload };
}

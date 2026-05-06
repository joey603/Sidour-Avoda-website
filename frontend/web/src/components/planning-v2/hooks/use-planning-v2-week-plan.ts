"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { getWeekKeyISO } from "../lib/week";

export type V2WeekPlanData = {
  assignments: Record<string, Record<string, string[][]>>;
  pulls?: Record<string, unknown>;
  alternatives?: Record<string, Record<string, string[][]>>[];
  alternativePulls?: Record<string, unknown>[];
  isManual?: boolean;
  workers?: unknown[];
  /** Scope API utilisé (priorité director → shared → auto). L’UI « plan verrouillé » ignore `auto`. */
  sourceScope?: "director" | "shared" | "auto";
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
    alternatives: Array.isArray(raw.alternatives)
      ? (raw.alternatives as Record<string, Record<string, string[][]>>[])
      : [],
    alternativePulls: Array.isArray(raw.alternative_pulls)
      ? (raw.alternative_pulls as Record<string, unknown>[])
      : Array.isArray(raw.alternativePulls)
        ? (raw.alternativePulls as Record<string, unknown>[])
        : [],
    isManual: !!raw.isManual,
    workers: Array.isArray(raw.workers) ? raw.workers : undefined,
  };
}

/** Charge le תכנון שמור (director → shared → auto), comme `fetchExistingSavedPlanForSite` sur le planning. */
export function usePlanningV2WeekPlan(
  siteId: string,
  weekStart: Date,
  preferredScope?: "director" | "shared" | "auto" | null,
) {
  const [plan, setPlan] = useState<V2WeekPlanData>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async (opts?: { silent?: boolean; preferredScope?: "director" | "shared" | "auto" | null }) => {
    const silent = opts?.silent === true;
    const id = Number(siteId);
    if (!Number.isFinite(id) || id <= 0) {
      setPlan(null);
      setLoading(false);
      return;
    }
    const isoWeek = getWeekKeyISO(weekStart);
    if (!silent) setLoading(true);
    try {
      const effectivePreferredScope = opts?.preferredScope ?? preferredScope;
      const orderedScopes = (
        effectivePreferredScope && ["director", "shared", "auto"].includes(effectivePreferredScope)
          ? [effectivePreferredScope, ...(["director", "shared", "auto"] as const).filter((scope) => scope !== effectivePreferredScope)]
          : (["director", "shared", "auto"] as const)
      ) as Array<"director" | "shared" | "auto">;
      const entries = await Promise.all(
        orderedScopes.map(async (scope) => [scope, await fetchWeekPlanScope(siteId, isoWeek, scope)] as const),
      );
      console.warn("[planning-v2][week-plan][load-scopes]", {
        siteId,
        isoWeek,
        preferredScope: effectivePreferredScope || null,
        orderedScopes,
        results: entries.map(([scope, raw]) => ({
          scope,
          hasPlan: !!(raw && typeof raw === "object" && raw.assignments),
          alternativesCount:
            raw && typeof raw === "object" && Array.isArray(raw.alternatives) ? raw.alternatives.length : 0,
          pullsCount:
            raw && typeof raw === "object" && raw.pulls && typeof raw.pulls === "object"
              ? Object.keys(raw.pulls).length
              : 0,
        })),
      });
      for (const [scope, raw] of entries) {
        const normalized = normalizePlan(raw as Record<string, unknown>);
        if (normalized) {
          console.warn("[planning-v2][week-plan][selected-scope]", {
            siteId,
            isoWeek,
            preferredScope: effectivePreferredScope || null,
            selectedScope: scope,
            alternativesCount: normalized.alternatives?.length || 0,
            pullsCount: normalized.pulls ? Object.keys(normalized.pulls).length : 0,
          });
          setPlan({ ...normalized, sourceScope: scope });
          return;
        }
      }
      console.warn("[planning-v2][week-plan][selected-scope]", {
        siteId,
        isoWeek,
        preferredScope: effectivePreferredScope || null,
        selectedScope: null,
      });
      setPlan(null);
    } catch {
      setPlan(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [siteId, weekStart, preferredScope]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { plan, loading, reloadWeekPlan: reload };
}

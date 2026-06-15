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

function buildWeekPlanScopePriority(
  preferredScope?: "director" | "shared" | "auto" | null,
): Array<"director" | "shared" | "auto"> {
  const savedScopes = ["director", "shared"] as const;
  if (preferredScope === "director" || preferredScope === "shared") {
    return [preferredScope, ...savedScopes.filter((scope) => scope !== preferredScope), "auto"];
  }
  // `auto` est seulement une טיוטה. Même si le statut la signale comme préférée,
  // un plan sauvegardé director/shared doit toujours gagner.
  return ["director", "shared", "auto"];
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

type WeekPlanHookOptions = {
  /** Navigation in-app entre sites liés : une seule requête `auto` (mémoire session = source de vérité). */
  lightweightNav?: boolean;
  /** Navigation depuis le rail multi-sites : éviter le gros fetch initial, le plan vient de sessionStorage. */
  skipInitialReload?: boolean;
  initialPlan?: V2WeekPlanData;
};

/** Charge le תכנון שמור (director → shared → auto), comme `fetchExistingSavedPlanForSite` sur le planning. */
export function usePlanningV2WeekPlan(
  siteId: string,
  weekStart: Date,
  preferredScope?: "director" | "shared" | "auto" | null,
  options?: WeekPlanHookOptions,
) {
  const [plan, setPlan] = useState<V2WeekPlanData>(() => options?.initialPlan ?? null);
  const [loading, setLoading] = useState(() => !options?.skipInitialReload);

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
      const orderedScopes = options?.lightweightNav
        ? (["auto"] as const)
        : buildWeekPlanScopePriority(effectivePreferredScope);
      const entries = await Promise.all(
        orderedScopes.map(async (scope) => [scope, await fetchWeekPlanScope(siteId, isoWeek, scope)] as const),
      );
      for (const [scope, raw] of entries) {
        const normalized = normalizePlan(raw as Record<string, unknown>);
        if (normalized) {
          setPlan({ ...normalized, sourceScope: scope });
          return;
        }
      }
      setPlan(null);
    } catch {
      setPlan(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [siteId, weekStart, preferredScope, options?.lightweightNav]);

  useEffect(() => {
    if (options?.skipInitialReload) {
      setPlan(options.initialPlan ?? null);
      setLoading(false);
      return;
    }
    void reload();
  }, [reload, options?.skipInitialReload, options?.initialPlan]);

  return { plan, loading, reloadWeekPlan: reload };
}

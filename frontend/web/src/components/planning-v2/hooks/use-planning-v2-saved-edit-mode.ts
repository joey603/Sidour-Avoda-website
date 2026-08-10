"use client";

import { useEffect, useMemo, useState } from "react";
import { assignmentsNonEmpty } from "../lib/assignments-empty";
import type { V2WeekPlanData } from "./use-planning-v2-week-plan";

/** Mode ערוך sur plan officiel + badges נשמר / נשלח + reset outils locaux au changement de semaine. */
export function usePlanningV2SavedEditMode(weekPlan: V2WeekPlanData, weekStart: Date) {
  const [editingSaved, setEditingSaved] = useState(false);
  const [editingSavedGenerationStarted, setEditingSavedGenerationStarted] = useState(false);

  useEffect(() => {
    if (!editingSaved) {
      setEditingSavedGenerationStarted(false);
    }
  }, [editingSaved]);

  useEffect(() => {
    setEditingSaved(false);
    setEditingSavedGenerationStarted(false);
  }, [weekStart]);

  const isSavedMode =
    assignmentsNonEmpty(weekPlan?.assignments ?? null) &&
    (weekPlan?.sourceScope === "director" || weekPlan?.sourceScope === "shared");

  const weekPlanSaveBadgeKind = useMemo<null | "director" | "shared">(() => {
    if (editingSaved) return null;
    if (!assignmentsNonEmpty(weekPlan?.assignments ?? null)) return null;
    if (weekPlan?.sourceScope === "shared") return "shared";
    if (weekPlan?.sourceScope === "director") return "director";
    return null;
  }, [editingSaved, weekPlan?.assignments, weekPlan?.sourceScope]);

  const weekPlanSaveBadgeConfig = useMemo(() => {
    if (weekPlanSaveBadgeKind === "director") {
      return {
        label: "נשמר (מנהל)",
        className:
          "inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
      };
    }
    if (weekPlanSaveBadgeKind === "shared") {
      return {
        label: "נשמר ונשלח לעובדים",
        className:
          "inline-flex items-center rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-xs text-teal-800 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300",
      };
    }
    return null;
  }, [weekPlanSaveBadgeKind]);

  const showSavedPlanEditBadge =
    editingSaved && assignmentsNonEmpty(weekPlan?.assignments ?? null);

  return {
    editingSaved,
    setEditingSaved,
    editingSavedGenerationStarted,
    setEditingSavedGenerationStarted,
    isSavedMode,
    weekPlanSaveBadgeConfig,
    showSavedPlanEditBadge,
  };
}

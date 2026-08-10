"use client";

import { useMemo } from "react";
import { assignmentsNonEmpty } from "../lib/assignments-empty";
import {
  readLinkedPlansFromMemory,
  readMultiSiteNavigationInApp,
} from "../lib/multi-site-linked-memory";
import type { V2WeekPlanData } from "./use-planning-v2-week-plan";

export function usePlanningV2NavigationBootstrap(siteId: string, weekStart: Date) {
  const navigationInApp = useMemo(() => readMultiSiteNavigationInApp(), []);
  const initialNavigationWeekPlan = useMemo<V2WeekPlanData>(() => {
    if (!navigationInApp) return null;
    const mem = readLinkedPlansFromMemory(weekStart);
    const plan = mem?.plansBySite?.[String(siteId)];
    // Précharger base + alternatives pour que assignmentVariants couvre activeAltIndex
    // dès le premier rendu (évite le clamp vers חלופה 1).
    const assignments =
      plan?.assignments && typeof plan.assignments === "object"
        ? (plan.assignments as Record<string, Record<string, string[][]>>)
        : null;
    if (!assignments || !assignmentsNonEmpty(assignments)) return null;
    return {
      assignments,
      pulls: plan?.pulls && typeof plan.pulls === "object" ? plan.pulls : {},
      alternatives: Array.isArray(plan?.alternatives) ? plan.alternatives : [],
      alternativePulls: Array.isArray(plan?.alternative_pulls) ? plan.alternative_pulls : [],
      sourceScope: "auto",
    };
  }, [navigationInApp, siteId, weekStart]);

  return {
    navigationInApp,
    initialNavigationWeekPlan,
  };
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { PlanningV2PullsMap, PlanningWorker, WorkerAvailability } from "../types";
import type { V2WeekPlanData } from "./use-planning-v2-week-plan";
import { assignmentsNonEmpty } from "../lib/assignments-empty";
import {
  buildWeekPlanDataPayload,
  buildWorkersSnapshotForSave,
  persistWeekPlanToApi,
} from "../lib/week-plan-persist";
import { weeklyAvailabilityMapFromRows } from "../lib/weekly-availability-for-ai";
import { getWeekKeyISO } from "../lib/week";

function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
}

function pullsLimitPayload(autoPullsEnabled: boolean, autoPullsLimit: string): number | null | undefined {
  if (!autoPullsEnabled) return undefined;
  if (autoPullsLimit === "unlimited") return null;
  const n = Number(autoPullsLimit);
  return Number.isFinite(n) ? n : undefined;
}

async function readSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (evt: Record<string, unknown>) => boolean,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (!frame.startsWith("data:")) continue;
      const jsonStr = frame.replace(/^data:\s*/, "");
      try {
        const evt = JSON.parse(jsonStr) as Record<string, unknown>;
        if (onEvent(evt)) return;
      } catch {
        /* ignore frame */
      }
    }
  }
}

type PlanControllerArgs = {
  siteId: string;
  weekStart: Date;
  weekPlan: V2WeekPlanData;
  workers: PlanningWorker[];
  workerRowsForTable: Array<PlanningWorker & { availability: WorkerAvailability }>;
  reloadWeekPlan: () => void | Promise<void>;
  linkedSitesLength: number;
};

export function usePlanningV2PlanController({
  siteId,
  weekStart,
  weekPlan,
  workers,
  workerRowsForTable,
  reloadWeekPlan,
  linkedSitesLength,
}: PlanControllerArgs) {
  const [draftAssignments, setDraftAssignments] = useState<Record<string, Record<string, string[][]>> | null>(
    null,
  );
  const [draftPulls, setDraftPulls] = useState<PlanningV2PullsMap | null>(null);
  const [generationRunning, setGenerationRunning] = useState(false);
  const [autoPullsLimit, setAutoPullsLimit] = useState("2");
  const [isManual, setIsManual] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const genBusyRef = useRef(false);

  const weekIso = getWeekKeyISO(weekStart);

  const autoPullsEnabled = autoPullsLimit !== "";

  useEffect(() => {
    setIsManual(!!weekPlan?.isManual);
  }, [siteId, weekIso, weekPlan?.isManual]);

  useEffect(() => {
    setDraftAssignments(null);
    setDraftPulls(null);
  }, [siteId, weekIso]);

  const displayAssignments = useMemo(() => {
    if (draftAssignments) return draftAssignments;
    return weekPlan?.assignments ?? null;
  }, [draftAssignments, weekPlan?.assignments]);

  const displayPulls = useMemo((): PlanningV2PullsMap | null | undefined => {
    if (draftPulls !== null) return draftPulls;
    const p = weekPlan?.pulls;
    if (!p || typeof p !== "object") return undefined;
    return p as PlanningV2PullsMap;
  }, [draftPulls, weekPlan?.pulls]);

  const stopGeneration = useCallback(() => {
    try {
      abortRef.current?.abort();
    } catch {
      /* ignore */
    }
    abortRef.current = null;
    setGenerationRunning(false);
    genBusyRef.current = false;
  }, []);

  const startGeneration = useCallback(async () => {
    const id = Number(siteId);
    if (!Number.isFinite(id) || id <= 0) return;
    if (genBusyRef.current) return;
    try {
      abortRef.current?.abort();
    } catch {
      /* ignore */
    }
    const controller = new AbortController();
    abortRef.current = controller;
    genBusyRef.current = true;
    setGenerationRunning(true);

    const weekly_availability = weeklyAvailabilityMapFromRows(workerRowsForTable);
    const pulls_limit = pullsLimitPayload(autoPullsEnabled, autoPullsLimit);

    const linked = linkedSitesLength > 1;
    const url = linked
      ? `${apiBaseUrl()}/director/sites/${siteId}/ai-generate-linked/stream`
      : `${apiBaseUrl()}/director/sites/${siteId}/ai-generate/stream`;

    const body = linked
      ? {
          week_iso: weekIso,
          num_alternatives: 500,
          auto_pulls_enabled: autoPullsEnabled,
          pulls_limit,
          fixed_assignments: undefined,
          exclude_days: undefined,
          weekly_availability,
        }
      : {
          week_iso: weekIso,
          num_alternatives: 500,
          auto_pulls_enabled: autoPullsEnabled,
          pulls_limit,
          fixed_assignments: undefined,
          exclude_days: undefined,
          weekly_availability,
        };

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("access_token")}`,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`HTTP ${resp.status}`);
      }
      let stopped = false;
      await readSseStream(resp.body.getReader(), (evt) => {
        if (stopped) return true;
        if (evt.type === "base") {
          if (linked && evt.site_plans && typeof evt.site_plans === "object") {
            const plans = evt.site_plans as Record<string, { assignments?: unknown; pulls?: unknown }>;
            const cur = plans[String(siteId)];
            if (cur?.assignments && typeof cur.assignments === "object") {
              setDraftAssignments(cur.assignments as Record<string, Record<string, string[][]>>);
              setDraftPulls(
                cur.pulls && typeof cur.pulls === "object" ? (cur.pulls as PlanningV2PullsMap) : {},
              );
              setIsManual(false);
              toast.success("תכנון בסיסי מוכן");
            }
          } else if (!linked && evt.assignments && typeof evt.assignments === "object") {
            setDraftAssignments(evt.assignments as Record<string, Record<string, string[][]>>);
            setDraftPulls(evt.pulls && typeof evt.pulls === "object" ? (evt.pulls as PlanningV2PullsMap) : {});
            setIsManual(false);
            toast.success("תכנון בסיסי מוכן");
          }
          return false;
        }
        if (evt.type === "status" && evt.status === "ERROR") {
          toast.error("יצירת תכנון נכשלה", { description: String(evt.detail || "") });
          stopped = true;
          return true;
        }
        if (evt.type === "done") {
          toast.success("התכנון הושלם");
          stopped = true;
          return true;
        }
        return false;
      });
    } catch (e: unknown) {
      if ((e as Error)?.name === "AbortError") {
        toast.message("יצירת התכנון הופסקה");
      } else {
        toast.error("יצירת תכנון נכשלה", { description: String((e as Error)?.message || "") });
      }
    } finally {
      setGenerationRunning(false);
      genBusyRef.current = false;
      abortRef.current = null;
    }
  }, [siteId, weekIso, workerRowsForTable, autoPullsEnabled, autoPullsLimit, linkedSitesLength]);

  const savePlan = useCallback(
    async (publishToWorkers: boolean) => {
      const assignments = displayAssignments;
      if (!assignments || !assignmentsNonEmpty(assignments)) {
        toast.error("אין מה לשמור", { description: "לא נמצא תכנון קיים לשמירה" });
        return;
      }
      let pulls: PlanningV2PullsMap = {};
      try {
        pulls = JSON.parse(JSON.stringify(displayPulls || {})) as PlanningV2PullsMap;
      } catch {
        pulls = (displayPulls || {}) as PlanningV2PullsMap;
      }
      let assignmentsSnapshot: typeof assignments;
      try {
        assignmentsSnapshot = JSON.parse(JSON.stringify(assignments)) as typeof assignments;
      } catch {
        assignmentsSnapshot = assignments;
      }
      const payload = buildWeekPlanDataPayload(
        Number(siteId),
        weekStart,
        assignmentsSnapshot,
        pulls,
        buildWorkersSnapshotForSave(workers),
        isManual,
      );
      try {
        await persistWeekPlanToApi(siteId, weekStart, publishToWorkers, payload as unknown as Record<string, unknown>);
        setDraftAssignments(null);
        setDraftPulls(null);
        await reloadWeekPlan();
        toast.success(publishToWorkers ? "התכנון נשמר ונשלח" : "התכנון נשמר (למנהל בלבד)");
      } catch (e: unknown) {
        toast.error("שמירה נכשלה", { description: String((e as Error)?.message || "נסה שוב מאוחר יותר.") });
      }
    },
    [displayAssignments, displayPulls, siteId, weekStart, workers, isManual, reloadWeekPlan],
  );

  const clearDraft = useCallback(() => {
    setDraftAssignments(null);
    setDraftPulls(null);
  }, []);

  return {
    displayAssignments,
    displayPulls,
    generationRunning,
    startGeneration,
    stopGeneration,
    savePlan,
    autoPullsLimit,
    setAutoPullsLimit,
    autoPullsEnabled,
    isManual,
    setIsManual,
    draftActive: draftAssignments !== null,
    clearDraft,
  };
}

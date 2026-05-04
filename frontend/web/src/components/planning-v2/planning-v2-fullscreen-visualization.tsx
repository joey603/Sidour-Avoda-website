"use client";

import { useEffect, useMemo, useState } from "react";
import type { PlanningV2PullsMap, PlanningWorker, SiteSummary } from "./types";
import { buildDistinctWorkerColorMap } from "./lib/worker-name-chip-color";
import { buildPlanningGridStyledHtml } from "./lib/planning-v2-plan-export";
import { assignmentsNonEmpty } from "./lib/assignments-empty";

type PlanningV2FullscreenVisualizationProps = {
  siteId: string;
  site: SiteSummary | null;
  weekStart: Date;
  workers: PlanningWorker[];
  assignments: Record<string, Record<string, string[][]>> | null | undefined;
  pulls?: PlanningV2PullsMap | null;
  assignmentVariants?: Array<Record<string, Record<string, string[][]>>> | null;
};

/** Plein écran : identique au fichier HTML téléchargé avec ייצוא CSV (`buildPlanningGridStyledHtml`). */
export function PlanningV2FullscreenVisualization({
  siteId,
  site,
  weekStart,
  workers,
  assignments,
  pulls,
  assignmentVariants,
}: PlanningV2FullscreenVisualizationProps) {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const siteLabel = site?.name?.trim() || `אתר ${siteId}`;

  const nameColorMap = useMemo(() => {
    const bundles = [assignments, ...(assignmentVariants || [])].filter(
      (x): x is Record<string, Record<string, string[][]>> => !!x && typeof x === "object",
    );
    return buildDistinctWorkerColorMap(workers, bundles);
  }, [workers, assignments, assignmentVariants]);

  const srcDoc = useMemo(() => {
    if (!assignmentsNonEmpty(assignments ?? null)) return "";
    return buildPlanningGridStyledHtml({
      siteLabel,
      weekStart,
      workers,
      assignments,
      pulls: pulls ?? null,
      site,
      nameColorMap,
    });
  }, [siteLabel, weekStart, workers, assignments, pulls, site, nameColorMap]);

  return (
    <div
      className={
        "flex min-h-0 flex-1 flex-col transition-all duration-300 ease-out motion-reduce:transition-none " +
        (entered ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0")
      }
    >
      <div
        className={
          "min-h-0 w-full overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg ring-1 ring-zinc-900/[0.06] transition-[transform,box-shadow] duration-300 ease-out motion-reduce:transition-none dark:border-zinc-700 dark:bg-white dark:ring-white/[0.08] " +
          (entered ? "scale-100" : "scale-[0.98]")
        }
      >
        {srcDoc ? (
          <iframe
            title={`תצוגת תכנון — ${siteLabel}`}
            srcDoc={srcDoc}
            sandbox="allow-same-origin"
            className="block h-[min(75dvh,calc(100dvh-12rem))] w-full border-0 bg-white"
          />
        ) : (
          <div className="flex h-48 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
            אין תכנון להצגה
          </div>
        )}
      </div>
    </div>
  );
}

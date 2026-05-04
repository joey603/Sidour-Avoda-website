"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import type { PlanningV2PullsMap, PlanningWorker, SiteSummary } from "./types";
import { assignmentsNonEmpty } from "./lib/assignments-empty";
import { buildDistinctWorkerColorMap } from "./lib/worker-name-chip-color";
import { getWeekKeyISO } from "./lib/week";
import { generatePlanningPdfBlob } from "./lib/planning-v2-js-pdf-export";
import {
  buildPlanningDataCsv,
  buildPlanningExportTableData,
  buildPlanningGridStyledHtml,
  safePlanningExportFilePart,
  triggerDownloadBlob,
} from "./lib/planning-v2-plan-export";

type PlanningV2PlanExportButtonsProps = {
  siteId: string;
  site: SiteSummary | null;
  weekStart: Date;
  workers: PlanningWorker[];
  assignments: Record<string, Record<string, string[][]>> | null | undefined;
  pulls?: PlanningV2PullsMap | null;
  assignmentVariants?: Array<Record<string, Record<string, string[][]>>> | null;
  onOpenVisualization?: () => void;
};

export function PlanningV2PlanExportButtons({
  siteId,
  site,
  weekStart,
  workers,
  assignments,
  pulls,
  assignmentVariants,
  onOpenVisualization,
}: PlanningV2PlanExportButtonsProps) {
  const [pdfExporting, setPdfExporting] = useState(false);
  const canVisualize = assignmentsNonEmpty(assignments ?? null);
  const nameColorMap = useMemo(() => {
    const bundles = [assignments, ...(assignmentVariants || [])].filter(
      (x): x is Record<string, Record<string, string[][]>> => !!x && typeof x === "object",
    );
    return buildDistinctWorkerColorMap(workers, bundles);
  }, [workers, assignments, assignmentVariants]);

  const handleExportPdf = useCallback(async () => {
    const label = safePlanningExportFilePart(site?.name || siteId);
    const weekIso = getWeekKeyISO(weekStart);
    const siteLabel = site?.name?.trim() || `אתר ${siteId}`;
    const filename = `${label}-${weekIso}-planning.pdf`;
    setPdfExporting(true);
    try {
      const tableData = buildPlanningExportTableData({
        siteLabel,
        weekStart,
        workers,
        assignments,
        pulls: pulls ?? null,
        site,
        nameColorMap,
      });
      const blob = await generatePlanningPdfBlob(tableData);
      triggerDownloadBlob(filename, blob);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "נסה שוב.";
      toast.error("יצירת PDF נכשלה", { description: msg });
    } finally {
      setPdfExporting(false);
    }
  }, [site, siteId, weekStart, workers, assignments, pulls, nameColorMap]);

  const handleExportCsv = useCallback(() => {
    const label = safePlanningExportFilePart(site?.name || siteId);
    const weekIso = getWeekKeyISO(weekStart);
    const siteLabel = site?.name?.trim() || `אתר ${siteId}`;
    const csv = buildPlanningDataCsv({
      siteLabel,
      weekStart,
      workers,
      assignments,
      pulls: pulls ?? null,
      site,
      nameColorMap,
    });
    triggerDownloadBlob(
      `${label}-${weekIso}-planning-data.csv`,
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const html = buildPlanningGridStyledHtml({
      siteLabel,
      weekStart,
      workers,
      assignments,
      pulls: pulls ?? null,
      site,
      nameColorMap,
    });
    window.setTimeout(() => {
      triggerDownloadBlob(
        `${label}-${weekIso}-planning-grid.html`,
        new Blob([html], { type: "text/html;charset=utf-8" }),
      );
    }, 300);
  }, [site, siteId, weekStart, workers, assignments, pulls, nameColorMap]);

  return (
    <div className="mt-4 flex w-full flex-wrap items-center justify-start gap-2" dir="ltr">
      <button
        type="button"
        onClick={onOpenVisualization}
        disabled={!canVisualize}
        className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-gradient-to-b from-sky-50 to-sky-100/80 px-2.5 py-1.5 text-xs font-medium text-sky-900 shadow-sm transition hover:border-sky-400 hover:from-sky-100 hover:to-sky-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-sky-700 dark:from-sky-950/50 dark:to-sky-950/30 dark:text-sky-100 dark:hover:border-sky-600 dark:hover:from-sky-900/60"
        title={canVisualize ? "פתיחת תצוגת מסך מלא לגריד ולסיכום" : "אין תכנון להצגה"}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" className="shrink-0 text-sky-700 dark:text-sky-300" fill="currentColor" aria-hidden>
          <path d="M4 9V4h5v2H6v3H4zm10-5h6v6h-2V6h-4V4zM4 15h2v3h3v2H4v-5zm14 3v-3h2v5h-5v-2h3z" />
        </svg>
        תצוגה מלאה
      </button>
      <button
        type="button"
        onClick={() => void handleExportPdf()}
        disabled={pdfExporting}
        className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-gradient-to-b from-sky-50 to-sky-100/80 px-2.5 py-1.5 text-xs font-medium text-sky-900 shadow-sm transition hover:border-sky-400 hover:from-sky-100 hover:to-sky-100 disabled:opacity-60 dark:border-sky-700 dark:from-sky-950/50 dark:to-sky-950/30 dark:text-sky-100 dark:hover:border-sky-600 dark:hover:from-sky-900/60"
        title="אותו תוכן כמו ב-CSV — PDF עם גופן עברי (ללא html2canvas)"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" className="shrink-0 text-sky-700 dark:text-sky-300" fill="currentColor" aria-hidden>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM6 20V4h7v5h5v11H6zm2-2h8v-2H8v2zm0-4h8v-2H8v2zm0-4h5V8H8v2z" />
        </svg>
        {pdfExporting ? "מייצא…" : "ייצוא PDF"}
      </button>
      <button
        type="button"
        onClick={handleExportCsv}
        className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-gradient-to-b from-sky-50 to-sky-100/80 px-2.5 py-1.5 text-xs font-medium text-sky-900 shadow-sm transition hover:border-sky-400 hover:from-sky-100 hover:to-sky-100 dark:border-sky-700 dark:from-sky-950/50 dark:to-sky-950/30 dark:text-sky-100 dark:hover:border-sky-600 dark:hover:from-sky-900/60"
        title="יורדים קובץ CSV (נתונים) וקובץ HTML מעוצב (גריד צבעוני)"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" className="shrink-0 text-sky-700 dark:text-sky-300" fill="currentColor" aria-hidden>
          <path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2v9.67z" />
        </svg>
        ייצוא CSV
      </button>
    </div>
  );
}

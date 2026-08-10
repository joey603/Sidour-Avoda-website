"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import type { PlanningV2PullsMap, PlanningWorker, SiteEvent, SiteSummary } from "./types";
import { assignmentsNonEmpty } from "./lib/assignments-empty";
import { buildDistinctWorkerColorMap } from "./lib/worker-name-chip-color";
import { ModalOverlay } from "@/components/ui/modal-scroll-lock";
import {
  formatHebDate,
  getWeekKeyISO,
  HEBREW_MONTH_NAMES,
  weekStartsIntersectingMonth,
} from "./lib/week";
import { generatePlanningPdfBlob } from "./lib/planning-v2-js-pdf-export";
import {
  buildPlanningExportTableData,
  safePlanningExportFilePart,
  triggerDownloadBlob,
} from "./lib/planning-v2-plan-export";
import type { MonthWeekScreenshotInput } from "./lib/planning-v2-schedule-screenshot";
import {
  computeSalaryReportForWeek,
  mergeSalaryReports,
  type SalaryReport,
} from "./lib/salary-calculator";
import { isSiteSalaryEnabled } from "./lib/site-salary-config";
import { PlanningV2SalaryReportModal } from "./planning-v2-salary-report-modal";

type PlanningV2PlanExportButtonsProps = {
  siteId: string;
  site: SiteSummary | null;
  weekStart: Date;
  workers: PlanningWorker[];
  assignments: Record<string, Record<string, string[][]>> | null | undefined;
  pulls?: PlanningV2PullsMap | null;
  assignmentVariants?: Array<Record<string, Record<string, string[][]>>> | null;
  events?: SiteEvent[] | null;
  onOpenVisualization?: () => void;
};

type WeekPlanRaw = {
  assignments?: Record<string, Record<string, string[][]>>;
  pulls?: PlanningV2PullsMap;
};

async function fetchWeekPlanPreferred(siteId: string, weekIso: string): Promise<WeekPlanRaw | null> {
  for (const scope of ["director", "shared", "auto"] as const) {
    try {
      const raw = await apiFetch<WeekPlanRaw | null>(
        `/director/sites/${siteId}/week-plan?week=${encodeURIComponent(weekIso)}&scope=${scope}`,
        { cache: "no-store" as RequestCache },
      );
      if (raw && raw.assignments && typeof raw.assignments === "object") {
        return raw;
      }
    } catch {
      /* try next scope */
    }
  }
  return null;
}

async function fetchWeekEvents(siteId: string, weekIso: string): Promise<SiteEvent[]> {
  try {
    const res = await apiFetch<SiteEvent[]>(
      `/director/sites/${siteId}/events?week=${encodeURIComponent(weekIso)}`,
      { cache: "no-store" as RequestCache },
    );
    return Array.isArray(res) ? res : [];
  } catch {
    return [];
  }
}

const btnClass =
  "inline-flex items-center gap-1 rounded-md border border-sky-300 bg-gradient-to-b from-sky-50 to-sky-100/80 px-2.5 py-1.5 text-xs font-medium text-sky-900 shadow-sm transition hover:border-sky-400 hover:from-sky-100 hover:to-sky-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-sky-700 dark:from-sky-950/50 dark:to-sky-950/30 dark:text-sky-100 dark:hover:border-sky-600 dark:hover:from-sky-900/60";

export function PlanningV2PlanExportButtons({
  siteId,
  site,
  weekStart,
  workers,
  assignments,
  pulls,
  assignmentVariants,
  events = [],
  onOpenVisualization,
}: PlanningV2PlanExportButtonsProps) {
  const [pdfExporting, setPdfExporting] = useState(false);
  const [excelExporting, setExcelExporting] = useState(false);
  const [screenshotExporting, setScreenshotExporting] = useState(false);
  const [monthPhotoOpen, setMonthPhotoOpen] = useState(false);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [selectedYear, setSelectedYear] = useState(() => weekStart.getFullYear());
  const [selectedMonthIndex, setSelectedMonthIndex] = useState(() => weekStart.getMonth());
  const [monthPhotoExporting, setMonthPhotoExporting] = useState(false);
  const [salaryOpen, setSalaryOpen] = useState(false);
  const [salaryTitle, setSalaryTitle] = useState("משכורת");
  const [salaryLoading, setSalaryLoading] = useState(false);
  const [salaryError, setSalaryError] = useState<string | null>(null);
  const salaryFeatureEnabled = useMemo(
    () => isSiteSalaryEnabled((site?.config as Record<string, unknown> | undefined) || null),
    [site?.config],
  );
  const [salaryReport, setSalaryReport] = useState<SalaryReport | null>(null);
  const [salaryMonthOpen, setSalaryMonthOpen] = useState(false);
  const [photoPreview, setPhotoPreview] = useState<{
    blob: Blob;
    url: string;
    filename: string;
    title: string;
    subtitle?: string;
  } | null>(null);
  const photoPreviewUrlRef = useRef<string | null>(null);

  const clearPhotoPreview = useCallback(() => {
    if (photoPreviewUrlRef.current) {
      URL.revokeObjectURL(photoPreviewUrlRef.current);
      photoPreviewUrlRef.current = null;
    }
    setPhotoPreview(null);
  }, []);

  const openPhotoPreview = useCallback(
    (blob: Blob, filename: string, title: string, subtitle?: string) => {
      clearPhotoPreview();
      const url = URL.createObjectURL(blob);
      photoPreviewUrlRef.current = url;
      setPhotoPreview({ blob, url, filename, title, subtitle });
    },
    [clearPhotoPreview],
  );

  useEffect(() => {
    if (!monthPhotoOpen) return;
    setSelectedYear(weekStart.getFullYear());
    setSelectedMonthIndex(weekStart.getMonth());
    setMonthPickerOpen(false);
  }, [monthPhotoOpen, weekStart]);

  useEffect(() => {
    return () => {
      if (photoPreviewUrlRef.current) {
        URL.revokeObjectURL(photoPreviewUrlRef.current);
        photoPreviewUrlRef.current = null;
      }
    };
  }, []);

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
        events,
      });
      const blob = await generatePlanningPdfBlob(tableData);
      triggerDownloadBlob(filename, blob);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "נסה שוב.";
      toast.error("יצירת PDF נכשלה", { description: msg });
    } finally {
      setPdfExporting(false);
    }
  }, [site, siteId, weekStart, workers, assignments, pulls, nameColorMap, events]);

  const handleExportExcel = useCallback(async () => {
    const label = safePlanningExportFilePart(site?.name || siteId);
    const weekIso = getWeekKeyISO(weekStart);
    const siteLabel = site?.name?.trim() || `אתר ${siteId}`;
    const filename = `${label}-${weekIso}-planning.xlsx`;
    setExcelExporting(true);
    try {
      const { generatePlanningExcelBlob } = await import("./lib/planning-v2-excel-export");
      const blob = await generatePlanningExcelBlob({
        siteLabel,
        weekStart,
        workers,
        assignments,
        pulls: pulls ?? null,
        site,
        events,
      });
      triggerDownloadBlob(filename, blob);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "נסה שוב.";
      toast.error("יצירת Excel נכשלה", { description: msg });
    } finally {
      setExcelExporting(false);
    }
  }, [site, siteId, weekStart, workers, assignments, pulls, events]);

  const handleExportScreenshot = useCallback(async () => {
    const label = safePlanningExportFilePart(site?.name || siteId);
    const weekIso = getWeekKeyISO(weekStart);
    const siteLabel = site?.name?.trim() || `אתר ${siteId}`;
    const filename = `${label}-${weekIso}-planning.png`;
    setScreenshotExporting(true);
    try {
      const { generatePlanningScheduleScreenshotPng } = await import("./lib/planning-v2-schedule-screenshot");
      const blob = await generatePlanningScheduleScreenshotPng({
        siteLabel,
        weekStart,
        workers,
        assignments,
        pulls: pulls ?? null,
        site,
        events,
      });
      openPhotoPreview(blob, filename, "תצוגה מקדימה · צילום שבוע", `שבוע מתאריך ${formatHebDate(weekStart)}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "נסה שוב.";
      toast.error("צילום המסך נכשל", { description: msg });
    } finally {
      setScreenshotExporting(false);
    }
  }, [site, siteId, weekStart, workers, assignments, pulls, events, openPhotoPreview]);

  const handleConfirmMonthPhoto = useCallback(async () => {
    const label = safePlanningExportFilePart(site?.name || siteId);
    const siteLabel = site?.name?.trim() || `אתר ${siteId}`;
    const monthPart = `${selectedYear}-${String(selectedMonthIndex + 1).padStart(2, "0")}`;
    const filename = `${label}-${monthPart}-month-planning.png`;
    const currentWeekIso = getWeekKeyISO(weekStart);
    const weekStarts = weekStartsIntersectingMonth(selectedYear, selectedMonthIndex);

    setMonthPhotoExporting(true);
    try {
      const weeks: MonthWeekScreenshotInput[] = [];
      for (const ws of weekStarts) {
        const weekIso = getWeekKeyISO(ws);
        let weekAssignments: Record<string, Record<string, string[][]>> | null = null;
        let weekPulls: PlanningV2PullsMap | null = null;
        let weekEvents: SiteEvent[] = [];

        if (weekIso === currentWeekIso && assignmentsNonEmpty(assignments ?? null)) {
          weekAssignments = (assignments || {}) as Record<string, Record<string, string[][]>>;
          weekPulls = (pulls ?? null) as PlanningV2PullsMap | null;
          weekEvents = Array.isArray(events) ? events : [];
        } else {
          const [plan, evs] = await Promise.all([
            fetchWeekPlanPreferred(siteId, weekIso),
            fetchWeekEvents(siteId, weekIso),
          ]);
          if (plan?.assignments && assignmentsNonEmpty(plan.assignments)) {
            weekAssignments = plan.assignments;
            weekPulls = (plan.pulls && typeof plan.pulls === "object" ? plan.pulls : null) as PlanningV2PullsMap | null;
          }
          weekEvents = evs;
        }

        if (!weekAssignments || !assignmentsNonEmpty(weekAssignments)) {
          continue;
        }

        weeks.push({
          siteLabel,
          weekStart: ws,
          workers,
          assignments: weekAssignments,
          pulls: weekPulls,
          site,
          events: weekEvents,
          weekLabel: `שבוע מתאריך ${formatHebDate(ws)}`,
        });
      }

      if (weeks.length === 0) {
        toast.error("אין תכנון שמור לחודש זה");
        return;
      }

      const { generatePlanningMonthScreenshotPng } = await import("./lib/planning-v2-schedule-screenshot");
      const blob = await generatePlanningMonthScreenshotPng({
        siteLabel,
        year: selectedYear,
        monthIndex: selectedMonthIndex,
        weeks,
      });
      const monthLabel = `${HEBREW_MONTH_NAMES[selectedMonthIndex] || ""} ${selectedYear}`.trim();
      openPhotoPreview(blob, filename, "תצוגה מקדימה · צילום חודש", monthLabel);
      setMonthPhotoOpen(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "נסה שוב.";
      toast.error("צילום החודש נכשל", { description: msg });
    } finally {
      setMonthPhotoExporting(false);
    }
  }, [
    site,
    siteId,
    selectedYear,
    selectedMonthIndex,
    weekStart,
    workers,
    assignments,
    pulls,
    events,
    openPhotoPreview,
  ]);

  const handleSavePhotoPreview = useCallback(() => {
    if (!photoPreview) return;
    triggerDownloadBlob(photoPreview.filename, photoPreview.blob);
    clearPhotoPreview();
    toast.success("הצילום נשמר");
  }, [photoPreview, clearPhotoPreview]);

  const selectedMonthLabel = `${HEBREW_MONTH_NAMES[selectedMonthIndex] || ""} ${selectedYear}`;

  const handleSalaryWeek = useCallback(() => {
    setSalaryTitle("משכורת שבוע");
    setSalaryError(null);
    setSalaryLoading(false);
    try {
      const report = computeSalaryReportForWeek({
        weekStart,
        site,
        workers,
        assignments,
        pulls,
      });
      setSalaryReport(report);
      setSalaryOpen(true);
    } catch (e: unknown) {
      setSalaryError(String((e as Error)?.message || "חישוב נכשל"));
      setSalaryReport(null);
      setSalaryOpen(true);
    }
  }, [assignments, pulls, site, weekStart, workers]);

  const handleSalaryMonth = useCallback(async () => {
    setSalaryMonthOpen(false);
    setSalaryTitle(`משכורת חודש · ${HEBREW_MONTH_NAMES[selectedMonthIndex] || ""} ${selectedYear}`);
    setSalaryError(null);
    setSalaryLoading(true);
    setSalaryReport(null);
    setSalaryOpen(true);
    try {
      const weekStarts = weekStartsIntersectingMonth(selectedYear, selectedMonthIndex);
      const reports: SalaryReport[] = [];
      for (const ws of weekStarts) {
        const weekIso = getWeekKeyISO(ws);
        const plan = await fetchWeekPlanPreferred(siteId, weekIso);
        if (!plan?.assignments) continue;
        reports.push(
          computeSalaryReportForWeek({
            weekStart: ws,
            site,
            workers,
            assignments: plan.assignments,
            pulls: plan.pulls || null,
            periodLabel: weekIso,
          }),
        );
      }
      if (reports.length === 0) {
        setSalaryError("לא נמצא תכנון שמור לחודש זה");
        setSalaryReport(null);
      } else {
        setSalaryReport(
          mergeSalaryReports(
            reports,
            `${HEBREW_MONTH_NAMES[selectedMonthIndex] || ""} ${selectedYear}`,
            { applyMonthlyBonus: true },
          ),
        );
      }
    } catch (e: unknown) {
      setSalaryError(String((e as Error)?.message || "חישוב נכשל"));
      setSalaryReport(null);
    } finally {
      setSalaryLoading(false);
    }
  }, [selectedMonthIndex, selectedYear, site, siteId, workers]);

  return (
    <>
      <div className="mt-4 flex w-full flex-col items-start gap-2 md:flex-row md:items-center md:justify-between" dir="ltr">
        <div className="flex flex-wrap items-center justify-start gap-2">
          <button
            type="button"
            onClick={onOpenVisualization}
            disabled={!canVisualize}
            className={btnClass}
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
            disabled={pdfExporting || !canVisualize}
            className={btnClass}
            title={canVisualize ? "אותו תוכן כמו ב-CSV — PDF עם גופן עברי (ללא html2canvas)" : "אין תכנון לייצוא"}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" className="shrink-0 text-sky-700 dark:text-sky-300" fill="currentColor" aria-hidden>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM6 20V4h7v5h5v11H6zm2-2h8v-2H8v2zm0-4h8v-2H8v2zm0-4h5V8H8v2z" />
            </svg>
            {pdfExporting ? "מייצא…" : "ייצוא PDF"}
          </button>
          <button
            type="button"
            onClick={() => void handleExportExcel()}
            disabled={excelExporting || !canVisualize}
            className={btnClass}
            title="קובץ Excel בפורמט סידור שבועי (צבעים, מ/עד, סיכום עובדים)"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" className="shrink-0 text-sky-700 dark:text-sky-300" fill="currentColor" aria-hidden>
              <path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2v9.67z" />
            </svg>
            {excelExporting ? "מייצא…" : "ייצוא Excel"}
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-start gap-2 md:ms-auto">
          <button
            type="button"
            onClick={() => void handleExportScreenshot()}
            disabled={screenshotExporting || !canVisualize}
            className={btnClass}
            title="צילום מסך של הסידור השבועי (PNG, מימדים קבועים וחדים)"
            aria-label="צילום מסך"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" className="shrink-0 text-sky-700 dark:text-sky-300" fill="currentColor" aria-hidden>
              <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z" />
            </svg>
            {screenshotExporting ? "מכין תצוגה…" : "צילום"}
          </button>
          <button
            type="button"
            onClick={() => {
              clearPhotoPreview();
              setMonthPhotoOpen(true);
            }}
            disabled={monthPhotoExporting}
            className={btnClass}
            title="צילום של כל השבועות השמורים בחודש (כולל אירועים)"
            aria-label="צילום חודש"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" className="shrink-0 text-sky-700 dark:text-sky-300" fill="currentColor" aria-hidden>
              <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2zM7 12h5v5H7v-5z" />
            </svg>
            צילום חודש
          </button>
          {salaryFeatureEnabled ? (
            <>
              <button
                type="button"
                onClick={() => handleSalaryWeek()}
                disabled={!canVisualize}
                className={btnClass}
                title="חישוב משכורת ברוטו לשבוע לפי הגדרות האתר (שעות נוספות / שבת / חג)"
                aria-label="משכורת"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" className="shrink-0 text-sky-700 dark:text-sky-300" fill="currentColor" aria-hidden>
                  <path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c2.03-.39 3.7-1.61 3.7-3.7 0-2.58-2.23-3.56-4.8-4.25z" />
                </svg>
                משכורת
              </button>
              <button
                type="button"
                onClick={() => {
                  clearPhotoPreview();
                  setSalaryMonthOpen(true);
                }}
                className={btnClass}
                title="חישוב משכורת ברוטו לחודש לפי כל השבועות השמורים"
                aria-label="משכורת חודש"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" className="shrink-0 text-sky-700 dark:text-sky-300" fill="currentColor" aria-hidden>
                  <path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7v-5z" />
                </svg>
                משכורת חודש
              </button>
            </>
          ) : null}
        </div>
      </div>

      {salaryFeatureEnabled ? (
      <PlanningV2SalaryReportModal
        open={salaryOpen}
        title={salaryTitle}
        report={salaryReport}
        loading={salaryLoading}
        error={salaryError}
        onClose={() => {
          if (salaryLoading) return;
          setSalaryOpen(false);
        }}
      />
      ) : null}

      {salaryFeatureEnabled && salaryMonthOpen ? (
        <ModalOverlay
          className="z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setSalaryMonthOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-950"
            dir="rtl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 text-lg font-semibold">משכורת חודש</div>
            <label className="mb-1 block text-sm font-medium">חודש</label>
            <div className="mb-4 flex gap-2">
              <select
                className="w-full rounded-md border px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                value={selectedMonthIndex}
                onChange={(e) => setSelectedMonthIndex(Number(e.target.value))}
              >
                {HEBREW_MONTH_NAMES.map((label, idx) => (
                  <option key={label} value={idx}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                className="w-28 rounded-md border px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                value={selectedYear}
                onChange={(e) => setSelectedYear(Number(e.target.value) || selectedYear)}
              />
            </div>
            <p className="mb-4 text-xs text-zinc-500">
              יחושב ברוטו לפי כל השבועות עם תכנון שמור בחודש, לפי תעריפים והגדרות שעות נוספות/שבת/חג באתר.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm dark:border-zinc-700"
                onClick={() => setSalaryMonthOpen(false)}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6]"
                onClick={() => void handleSalaryMonth()}
              >
                חשב
              </button>
            </div>
          </div>
        </ModalOverlay>
      ) : null}

      {monthPhotoOpen ? (
        <ModalOverlay
          className="z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => {
            if (monthPhotoExporting) return;
            setMonthPhotoOpen(false);
          }}
        >
          <div
            className="w-full max-w-md rounded-xl border bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-950"
            dir="rtl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 text-lg font-semibold">צילום חודש</div>
            <label className="mb-1 block text-sm font-medium">חודש</label>
            <button
              type="button"
              disabled={monthPhotoExporting}
              onClick={() => setMonthPickerOpen(true)}
              className="mb-4 flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              <span>{selectedMonthLabel}</span>
              <span className="text-zinc-400">▼</span>
            </button>
            <p className="mb-4 text-xs text-zinc-500">
              יוצג תצוגה מקדימה לפני השמירה. ייכללו כל השבועות עם תכנון שמור בחודש זה, כולל טבלאות אירועים לצד מאבטח.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm dark:border-zinc-700"
                disabled={monthPhotoExporting}
                onClick={() => setMonthPhotoOpen(false)}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-3 py-2 text-sm text-white disabled:opacity-60"
                disabled={monthPhotoExporting}
                onClick={() => void handleConfirmMonthPhoto()}
              >
                {monthPhotoExporting ? "מכין תצוגה…" : "הצג תצוגה מקדימה"}
              </button>
            </div>
          </div>
        </ModalOverlay>
      ) : null}

      {photoPreview ? (
        <div
          className="fixed bottom-0 left-0 right-0 top-[var(--app-top-nav-height,4.5rem)] z-[70] flex items-center justify-center bg-black/50 p-3 sm:p-6"
          onClick={clearPhotoPreview}
        >
          <div
            className="flex max-h-full min-h-0 w-full max-w-5xl flex-col rounded-xl border bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-950"
            dir="rtl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 dark:border-zinc-800">
              <div>
                <div className="text-lg font-semibold">{photoPreview.title}</div>
                {photoPreview.subtitle ? (
                  <div className="text-xs text-zinc-500">{photoPreview.subtitle}</div>
                ) : null}
              </div>
              <button
                type="button"
                className="rounded-md border px-2 py-1 text-sm dark:border-zinc-700"
                onClick={clearPhotoPreview}
              >
                סגור
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-zinc-100 p-3 dark:bg-zinc-900">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photoPreview.url}
                alt={photoPreview.title}
                className="mx-auto block h-auto max-w-full rounded border border-zinc-200 bg-white shadow-sm dark:border-zinc-700"
              />
            </div>
            <div className="flex shrink-0 justify-end gap-2 border-t px-4 py-3 dark:border-zinc-800">
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm dark:border-zinc-700"
                onClick={clearPhotoPreview}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-3 py-2 text-sm text-white"
                onClick={handleSavePhotoPreview}
              >
                אשר ושמור
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {monthPickerOpen ? (
        <ModalOverlay
          className="z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setMonthPickerOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl border bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-950"
            dir="rtl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-lg font-semibold">בחירת חודש · {selectedYear}</div>
              <button
                type="button"
                className="rounded-md border px-2 py-1 text-sm dark:border-zinc-700"
                onClick={() => setMonthPickerOpen(false)}
              >
                סגור
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {HEBREW_MONTH_NAMES.map((name, idx) => {
                const active = idx === selectedMonthIndex;
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => {
                      setSelectedMonthIndex(idx);
                      setMonthPickerOpen(false);
                    }}
                    className={
                      "rounded-md border px-2 py-2 text-sm " +
                      (active
                        ? "border-[#00A8E0] bg-[#00A8E0] text-white"
                        : "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900")
                    }
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
        </ModalOverlay>
      ) : null}
    </>
  );
}

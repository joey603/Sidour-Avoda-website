"use client";

import DOMPurify from "dompurify";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PlanningV2MainPaper } from "@/components/planning-v2/planning-v2-main-paper";
import { PlanningV2StationWeekGrid } from "@/components/planning-v2/stations/planning-v2-station-week-grid";
import type { PlanningWorker, SiteSummary } from "@/components/planning-v2/types";

export type WorkerHomeSiteMessage = {
  id: number;
  site_id: number;
  text: string;
  scope: "global" | "week";
  created_week_iso: string;
  stopped_week_iso?: string | null;
  origin_id?: number | null;
  created_at: number;
  updated_at: number;
};

export function toPlanningWorkers(weekPlan: { workers?: unknown[] } | null | undefined): PlanningWorker[] {
  const list = weekPlan?.workers;
  if (!Array.isArray(list)) return [];
  return list.map((w: any, i: number) => ({
    id: typeof w.id === "number" ? w.id : i + 1,
    name: String(w.name || ""),
    maxShifts:
      typeof w.max_shifts === "number"
        ? w.max_shifts
        : typeof w.maxShifts === "number"
          ? w.maxShifts
          : 5,
    roles: Array.isArray(w.roles) ? w.roles : [],
    availability: w.availability && typeof w.availability === "object" ? w.availability : {},
    answers: {},
  }));
}

function MarkdownOrHtml({ raw }: { raw: string }) {
  const isHtml = /<\/?[a-z][\s\S]*>/i.test(raw);
  if (isHtml) {
    const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, ADD_TAGS: ["mark"], ADD_ATTR: ["style", "data-color"] });
    return <div className="prose prose-sm max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: clean }} />;
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 list-disc pr-5">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal pr-5">{children}</ol>,
        li: ({ children }) => <li className="mb-1 last:mb-0">{children}</li>,
        a: ({ children, href }) => (
          <a className="underline decoration-dotted" href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
        table: ({ children }) => (
          <div className="overflow-x-hidden md:overflow-x-auto">
            <table className="w-full border-collapse text-[10px] md:text-sm table-fixed">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border px-1 md:px-2 py-1 text-right bg-zinc-50 dark:bg-zinc-800">{children}</th>,
        td: ({ children }) => <td className="border px-1 md:px-2 py-1 text-right align-top">{children}</td>,
      }}
    >
      {raw}
    </ReactMarkdown>
  );
}

type WorkerHomeSitePanelsProps = {
  siteId: number;
  siteName: string;
  config: Record<string, unknown> | null;
  currentWeekStart: Date;
  nextWeekStart: Date;
  formatWeekRange: (weekStart: Date) => string;
  currentWeek: any | null;
  nextWeek: any | null;
  messagesCurrent: WorkerHomeSiteMessage[];
  messagesNext: WorkerHomeSiteMessage[];
  /** Bloc résumé (טבלת סיכום) sous la grille — construit par la page */
  summaryCurrent: React.ReactNode;
  summaryNext: React.ReactNode;
  /** Clic sur une ligne du סיכום → surbrillance de l’עובד dans le גריד (comme planning v2). */
  summaryHighlightWorkerNameCurrent?: string | null;
  summaryHighlightWorkerNameNext?: string | null;
};

export function WorkerHomeSitePanels({
  siteId,
  siteName,
  config,
  currentWeekStart,
  nextWeekStart,
  formatWeekRange,
  currentWeek,
  nextWeek,
  messagesCurrent,
  messagesNext,
  summaryCurrent,
  summaryNext,
  summaryHighlightWorkerNameCurrent = null,
  summaryHighlightWorkerNameNext = null,
}: WorkerHomeSitePanelsProps) {
  const siteSummary: SiteSummary = {
    id: siteId,
    name: siteName,
    config: config || {},
  };

  const workersCurrent = toPlanningWorkers(currentWeek);
  const workersNext = toPlanningWorkers(nextWeek);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">{siteName}</h2>
      </div>

      <PlanningV2MainPaper>
        <h3 className="mb-4 border-b border-zinc-100 pb-2 text-lg font-semibold dark:border-zinc-800">
          שבוע נוכחי: {formatWeekRange(currentWeekStart)}
        </h3>
        {!config || !currentWeek ? (
          <p className="text-sm text-zinc-500">אין נתוני תכנון שמורים לשבוע זה.</p>
        ) : (
          <>
            <PlanningV2StationWeekGrid
              site={siteSummary}
              siteId={String(siteId)}
              weekStart={currentWeekStart}
              workers={workersCurrent}
              assignments={currentWeek.assignments}
              pulls={(currentWeek as { pulls?: Record<string, unknown> }).pulls}
              isSavedMode
              editingSaved={false}
              loading={false}
              isManual={false}
              manualEditable={false}
              summaryHighlightWorkerName={summaryHighlightWorkerNameCurrent}
            />
            {summaryCurrent}
          </>
        )}
        <div className="mt-4 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">הודעות</div>
          {messagesCurrent.length === 0 ? (
            <div className="text-sm text-zinc-500">אין הודעות</div>
          ) : (
            <div className="space-y-2">
              {messagesCurrent.map((m) => (
                <div key={m.id} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-700" dir="rtl">
                  <MarkdownOrHtml raw={String(m.text || "")} />
                </div>
              ))}
            </div>
          )}
        </div>
      </PlanningV2MainPaper>

      <PlanningV2MainPaper>
        <h3 className="mb-4 border-b border-zinc-100 pb-2 text-lg font-semibold dark:border-zinc-800">
          שבוע הבא: {formatWeekRange(nextWeekStart)}
        </h3>
        {!config || !nextWeek ? (
          <p className="text-sm text-zinc-500">אין נתוני תכנון שמורים לשבוע זה.</p>
        ) : (
          <>
            <PlanningV2StationWeekGrid
              site={siteSummary}
              siteId={String(siteId)}
              weekStart={nextWeekStart}
              workers={workersNext}
              assignments={nextWeek.assignments}
              pulls={(nextWeek as { pulls?: Record<string, unknown> }).pulls}
              isSavedMode
              editingSaved={false}
              loading={false}
              isManual={false}
              manualEditable={false}
              summaryHighlightWorkerName={summaryHighlightWorkerNameNext}
            />
            {summaryNext}
          </>
        )}
        <div className="mt-4 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">הודעות</div>
          {messagesNext.length === 0 ? (
            <div className="text-sm text-zinc-500">אין הודעות</div>
          ) : (
            <div className="space-y-2">
              {messagesNext.map((m) => (
                <div key={m.id} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-700" dir="rtl">
                  <MarkdownOrHtml raw={String(m.text || "")} />
                </div>
              ))}
            </div>
          )}
        </div>
      </PlanningV2MainPaper>
    </div>
  );
}

"use client";

import Link from "next/link";
import { clearAllPlanningSessionCaches } from "@/lib/planning-session-cache";

export type PlanningV2SaveBadgeConfig = {
  label: string;
  className: string;
};

type PlanningV2HeaderProps = {
  /** כמו `weekPlanSaveBadgeConfig` ב-planning הישן — נשמר (מנהל) / נשמר ונשלח לעובדים */
  weekPlanSaveBadgeConfig?: PlanningV2SaveBadgeConfig | null;
  /** מצב עריכת תכנון שמור — תג «ערוך» */
  showEditBadge?: boolean;
};

export function PlanningV2Header({
  weekPlanSaveBadgeConfig = null,
  showEditBadge = false,
}: PlanningV2HeaderProps) {
  const showBadgeRow = !!(weekPlanSaveBadgeConfig || showEditBadge);

  return (
    <header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">תכנון משמרות</h1>
          {showBadgeRow ? (
            <div className="sticky top-2 z-[41] flex w-fit max-w-full flex-wrap items-center gap-1.5">
              {showEditBadge ? (
                <span className="inline-flex items-center rounded-full border border-sky-400 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-900 dark:border-sky-600 dark:bg-sky-950/50 dark:text-sky-100">
                  ערוך
                </span>
              ) : null}
              {weekPlanSaveBadgeConfig ? (
                <span
                  className={`${weekPlanSaveBadgeConfig.className} mr-2 max-w-[calc(100vw-2rem)] sm:mr-3 sm:max-w-[calc(100vw-2.25rem)]`}
                >
                  {weekPlanSaveBadgeConfig.label}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <nav className="flex flex-wrap items-center gap-2">
          <Link
            href="/director/sites"
            onClick={() => {
              clearAllPlanningSessionCaches();
            }}
            aria-label="רשימת אתרים"
            title="רשימת אתרים"
            className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white p-2 text-zinc-800 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden>
              <path d="M14 6l-6 6 6 6V6z" />
            </svg>
          </Link>
        </nav>
      </div>
    </header>
  );
}

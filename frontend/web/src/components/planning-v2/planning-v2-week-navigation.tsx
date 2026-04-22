"use client";

import { type ReactElement, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { addDays, formatHebDate, getWeekKeyISO } from "./lib/week";

type PlanningV2WeekNavigationProps = {
  siteId: string;
  weekStart: Date;
};

export function PlanningV2WeekNavigation({ siteId, weekStart }: PlanningV2WeekNavigationProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() =>
    new Date(weekStart.getFullYear(), weekStart.getMonth(), 1),
  );

  useEffect(() => {
    setCalendarMonth(new Date(weekStart.getFullYear(), weekStart.getMonth(), 1));
  }, [weekStart]);

  function updateWeekStart(nextWeekStart: Date) {
    const normalized = new Date(nextWeekStart);
    normalized.setHours(0, 0, 0, 0);
    try {
      const paramsObj = new URLSearchParams(searchParams.toString());
      paramsObj.set("week", getWeekKeyISO(normalized));
      router.replace(`/director/planning-v2/${siteId}?${paramsObj.toString()}`);
    } catch {
      router.replace(`/director/planning-v2/${siteId}?week=${encodeURIComponent(getWeekKeyISO(normalized))}`);
    }
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-center gap-3 text-sm text-zinc-600 dark:text-zinc-300">
        <div className="hidden items-center gap-3 md:flex">
          <button
            type="button"
            aria-label="שבוע קודם"
            onClick={() => updateWeekStart(addDays(weekStart, -7))}
            className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
              <path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" />
            </svg>
          </button>
          <span>
            שבוע: {formatHebDate(weekStart)} — {formatHebDate(addDays(weekStart, 6))}
          </span>
          <button
            type="button"
            aria-label="שבוע הבא"
            onClick={() => updateWeekStart(addDays(weekStart, 7))}
            className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
              <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="בחר שבוע מלוח שנה"
            onClick={() => setIsCalendarOpen(true)}
            className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
              <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z" />
              <path d="M7 14h5v5H7z" />
            </svg>
          </button>
        </div>

        <div className="flex w-full items-center justify-center gap-3 md:hidden">
          <button
            type="button"
            aria-label="שבוע קודם"
            onClick={() => updateWeekStart(addDays(weekStart, -7))}
            className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
              <path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" />
            </svg>
          </button>
          <div className="flex flex-1 flex-col items-center gap-1">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">שבוע</span>
            <div className="flex flex-col items-center gap-0.5">
              <span>{formatHebDate(weekStart)}</span>
              <span className="text-zinc-400">—</span>
              <span>{formatHebDate(addDays(weekStart, 6))}</span>
            </div>
          </div>
          <button
            type="button"
            aria-label="שבוע הבא"
            onClick={() => updateWeekStart(addDays(weekStart, 7))}
            className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
              <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="בחר שבוע מלוח שנה"
            onClick={() => setIsCalendarOpen(true)}
            className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
              <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z" />
              <path d="M7 14h5v5H7z" />
            </svg>
          </button>
        </div>
      </div>

      {isCalendarOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setIsCalendarOpen(false)}
        >
          <div
            className="mx-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">בחר שבוע</h3>
              <button
                type="button"
                onClick={() => setIsCalendarOpen(false)}
                className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
              </button>
            </div>
            <div className="mb-4 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  const nextMonth = new Date(calendarMonth);
                  nextMonth.setMonth(nextMonth.getMonth() + 1);
                  setCalendarMonth(nextMonth);
                }}
                className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" />
                </svg>
              </button>
              <span className="text-lg font-medium">
                {new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric" }).format(calendarMonth)}
              </span>
              <button
                type="button"
                onClick={() => {
                  const prevMonth = new Date(calendarMonth);
                  prevMonth.setMonth(prevMonth.getMonth() - 1);
                  setCalendarMonth(prevMonth);
                }}
                className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                </svg>
              </button>
            </div>
            <div className="mb-2 grid grid-cols-7 gap-1">
              {["א", "ב", "ג", "ד", "ה", "ו", "ש"].map((day) => (
                <div key={day} className="p-2 text-center text-sm font-medium text-zinc-600 dark:text-zinc-400">
                  {day}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {(() => {
                const year = calendarMonth.getFullYear();
                const month = calendarMonth.getMonth();
                const firstDay = new Date(year, month, 1);
                const startDate = new Date(firstDay);
                startDate.setDate(startDate.getDate() - firstDay.getDay());
                const days: ReactElement[] = [];
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                const iso = (d: Date) =>
                  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

                const hasSavedPlan = (date: Date): boolean => {
                  if (typeof window === "undefined") return false;
                  const weekStartForDate = new Date(date);
                  weekStartForDate.setDate(date.getDate() - date.getDay());
                  const key = `plan_${siteId}_${iso(weekStartForDate)}`;
                  const raw = localStorage.getItem(key);
                  if (!raw) return false;
                  try {
                    const parsed = JSON.parse(raw);
                    return !!(parsed && parsed.assignments);
                  } catch {
                    return false;
                  }
                };

                for (let i = 0; i < 42; i++) {
                  const date = new Date(startDate);
                  date.setDate(date.getDate() + i);
                  const isCurrentMonth = date.getMonth() === month;
                  const isToday = date.getTime() === today.getTime();
                  const isWeekStart = date.getDay() === 0;
                  const weekStartForDate = new Date(date);
                  weekStartForDate.setDate(date.getDate() - date.getDay());
                  weekStartForDate.setHours(0, 0, 0, 0);
                  const wk = new Date(weekStart);
                  wk.setHours(0, 0, 0, 0);
                  const isCurrentWeek = weekStartForDate.getTime() === wk.getTime();
                  const hasPlan = hasSavedPlan(date);

                  days.push(
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        const selectedWeekStart = new Date(date);
                        selectedWeekStart.setDate(date.getDate() - date.getDay());
                        selectedWeekStart.setHours(0, 0, 0, 0);
                        updateWeekStart(selectedWeekStart);
                        setCalendarMonth(new Date(year, month, 1));
                        setIsCalendarOpen(false);
                      }}
                      className={[
                        "relative flex flex-col items-center rounded p-2 text-sm",
                        !isCurrentMonth ? "text-zinc-300 dark:text-zinc-600" : "",
                        isToday ? "bg-[#00A8E0] font-semibold text-white" : "",
                        isCurrentWeek && isCurrentMonth && !isToday
                          ? "border border-[#00A8E0] bg-[#00A8E0]/20"
                          : "",
                        isWeekStart && isCurrentMonth ? "font-semibold" : "",
                        isCurrentMonth && !isToday && !isCurrentWeek ? "text-zinc-700 dark:text-zinc-300" : "",
                        "hover:bg-zinc-100 dark:hover:bg-zinc-800",
                      ].join(" ")}
                    >
                      <span>{date.getDate()}</span>
                      {hasPlan ? <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-red-500" /> : null}
                    </button>,
                  );
                }
                return days;
              })()}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

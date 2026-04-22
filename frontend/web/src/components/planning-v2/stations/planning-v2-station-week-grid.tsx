"use client";

import { useState } from "react";
import type { SiteSummary } from "../types";
import { addDays, formatHebDate } from "../lib/week";
import {
  DAY_COLS,
  getRequiredFor,
  hoursFromConfig,
  hoursOf,
  isDayActive,
  shiftNamesFromSite,
} from "../lib/station-grid-helpers";
import { workerNameChipColor } from "../lib/worker-name-chip-color";

type PlanningV2StationWeekGridProps = {
  site: SiteSummary | null;
  weekStart: Date;
  assignments: Record<string, Record<string, string[][]>> | null | undefined;
  pulls?: Record<string, unknown> | null;
  loading?: boolean;
};

function normName(s: unknown): string {
  return String(s || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

function truncateMobile6(value: unknown): string {
  const s = String(value ?? "");
  const chars = Array.from(s);
  return chars.length > 6 ? chars.slice(0, 4).join("") + "…" : s;
}

function isRtlName(s: string): boolean {
  return /[\u0590-\u05FF]/.test(String(s || ""));
}

function expandedKeyFor(
  dayKey: string,
  shiftName: string,
  stationIndex: number,
  slotIndex: number,
  token: string,
): string {
  return `${dayKey}|${shiftName}|${stationIndex}|${slotIndex}|${token}`;
}

/** Plage horaire משיכה pour ce nom dans la cellule (affichage lecture seule). */
function pullTimeRangeForName(
  pulls: Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  workerName: string,
): string | null {
  if (!pulls) return null;
  const prefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  const nm = normName(workerName);
  for (const [k, v] of Object.entries(pulls)) {
    if (!String(k).startsWith(prefix)) continue;
    const e = v as {
      before?: { name?: string; start?: string; end?: string };
      after?: { name?: string; start?: string; end?: string };
    };
    if (normName(e?.before?.name) === nm) {
      const s = String(e?.before?.start || "").trim();
      const en = String(e?.before?.end || "").trim();
      if (s && en) return `${s}–${en}`;
    }
    if (normName(e?.after?.name) === nm) {
      const s = String(e?.after?.start || "").trim();
      const en = String(e?.after?.end || "").trim();
      if (s && en) return `${s}–${en}`;
    }
  }
  return null;
}

/** Nombre de משיכות dans la cellule (même préfixe que le planning). */
function countPullEntriesInCell(
  pulls: Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
): number {
  if (!pulls) return 0;
  const prefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  let n = 0;
  for (const k of Object.keys(pulls)) {
    if (String(k).startsWith(prefix)) n++;
  }
  return n;
}

/**
 * Tableau de slots (ordre préservé) + injection des noms משיכה dans les trous,
 * comme `cellRaw` dans le planning — base pour N sous-slots et comptage שיבוצים.
 */
function mergeCellRawWithPulls(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
): string[] {
  const cell = assignments?.[dayKey]?.[shiftName]?.[stationIdx];
  const baseArr: string[] = Array.isArray(cell)
    ? (cell as unknown[]).map((x) => String(x ?? ""))
    : [];
  const cellPrefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  const have = new Set(baseArr.map((x) => normName(x)).filter(Boolean));
  const normSlot = (s: unknown) => String(s ?? "");
  const addInto = (name: string) => {
    const n = normName(name);
    if (!n || have.has(n)) return;
    const emptyIdx = baseArr.findIndex((x) => !normName(x));
    if (emptyIdx >= 0) baseArr[emptyIdx] = normSlot(name);
    else baseArr.push(normSlot(name));
    have.add(n);
  };
  try {
    if (pulls) {
      Object.entries(pulls).forEach(([k, entry]) => {
        if (!String(k).startsWith(cellPrefix)) return;
        const e = entry as { before?: { name?: string }; after?: { name?: string } };
        const b = String(e?.before?.name || "").trim();
        const a = String(e?.after?.name || "").trim();
        if (b) addInto(b);
        if (a) addInto(a);
      });
    }
  } catch {
    /* ignore */
  }
  return baseArr;
}

function pullRingClass(
  pulls: Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  workerName: string,
): string {
  if (!pulls) return "";
  const prefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  const nm = normName(workerName);
  if (!nm) return "";
  for (const [k, v] of Object.entries(pulls)) {
    if (!String(k).startsWith(prefix)) continue;
    const e = v as { before?: { name?: string }; after?: { name?: string } };
    if (normName(e?.before?.name) === nm || normName(e?.after?.name) === nm) {
      return " ring-2 ring-orange-400";
    }
  }
  return "";
}

/**
 * גריד שבועי לפי עמדה — structure / tailles / couleurs alignées sur le planning (affichage lecture seule).
 */
export function PlanningV2StationWeekGrid({
  site,
  weekStart,
  assignments,
  pulls,
  loading,
}: PlanningV2StationWeekGridProps) {
  const [expandedSlotKey, setExpandedSlotKey] = useState<string | null>(null);
  const stations = (Array.isArray(site?.config?.stations) ? site?.config?.stations : []) as Record<
    string,
    unknown
  >[];
  const shiftNamesAll = shiftNamesFromSite(site);

  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);

  if (loading) {
    return (
      <section className="space-y-4">
        <h2 className="text-center text-lg font-semibold">גריד שבועי לפי עמדה</h2>
        <div className="py-10 text-center text-sm text-zinc-500">טוען גריד…</div>
      </section>
    );
  }

  if (stations.length === 0) {
    return (
      <section className="space-y-4">
        <h2 className="text-center text-lg font-semibold">גריד שבועי לפי עמדה</h2>
        <p className="text-center text-sm text-zinc-500">אין עמדות מוגדרות בהגדרות האתר.</p>
      </section>
    );
  }

  const assignmentsSafe: Record<string, Record<string, string[][]>> =
    assignments && typeof assignments === "object" ? assignments : {};

  return (
    <section className="space-y-4">
      <h2 className="text-center text-lg font-semibold">גריד שבועי לפי עמדה</h2>

      <div className="space-y-6">
        {stations.map((st, idx: number) => (
          <div key={idx} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {String((st as { name?: unknown }).name || "") || `עמדה ${idx + 1}`}
              </div>
            </div>
            <div className="max-h-[24rem] overflow-y-auto overflow-x-hidden md:overflow-x-auto">
              <table className="w-full table-fixed border-collapse text-[8px] md:text-sm">
                <thead>
                  <tr className="border-b dark:border-zinc-800">
                    <th className="w-10 px-0 py-0.5 text-right align-bottom md:w-28 md:px-2 md:py-2 text-[8px] md:text-sm">
                      משמרת
                    </th>
                    {DAY_COLS.map((d, i) => {
                      const date = addDays(weekStart, i);
                      return (
                        <th key={d.key} className="px-0.5 py-0.5 text-center align-bottom md:px-2 md:py-2">
                          <div className="flex min-w-0 flex-col items-center leading-tight">
                            <span className="max-w-full truncate whitespace-nowrap text-[5px] text-zinc-500 md:text-xs">
                              {formatHebDate(date)}
                            </span>
                            <span className="mt-0.5 text-[8px] md:text-sm">{d.label}</span>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    if (shiftNamesAll.length === 0) {
                      return (
                        <tr>
                          <td colSpan={8} className="py-4 text-center text-xs text-zinc-500">
                            אין משמרות פעילות לעמדה זו
                          </td>
                        </tr>
                      );
                    }
                    return shiftNamesAll.map((sn) => {
                      const stationShift = ((st.shifts as unknown[]) || []).find(
                        (x) => (x as { name?: string })?.name === sn,
                      ) as { name?: string; enabled?: boolean } | undefined;
                      const shiftRowEnabled = !!stationShift?.enabled;
                      return (
                      <tr key={sn} className="border-b last:border-0 dark:border-zinc-800">
                        <td className="w-10 px-0 py-0.5 md:w-28 md:px-2 md:py-2">
                          <div className="flex min-w-0 flex-col items-start">
                            {(() => {
                              const h = hoursFromConfig(st, sn) || hoursOf(sn);
                              return h ? (
                                <div className="mb-0.5 text-[7px] leading-none text-zinc-500 md:text-[10px]" dir="ltr">
                                  {(() => {
                                    const s = String(h || "").trim();
                                    const parts = s.split(/[-–—]/).map((x) => x.trim()).filter(Boolean);
                                    if (parts.length >= 2) {
                                      return (
                                        <span className="flex flex-col">
                                          <span>{parts[0]}</span>
                                          <span>{parts[1]}</span>
                                        </span>
                                      );
                                    }
                                    return s;
                                  })()}
                                </div>
                              ) : null;
                            })()}
                            <div className="whitespace-normal break-words text-[6px] font-medium leading-tight md:text-sm">
                              {sn}
                            </div>
                          </div>
                        </td>
                        {DAY_COLS.map((d, dayIdx) => {
                          const required = getRequiredFor(st, sn, d.key);
                          const activeDay = isDayActive(st, d.key);
                          const dateCell = addDays(weekStart, dayIdx);
                          const isPastDay = dateCell < today0;
                          const cellRaw = mergeCellRawWithPulls(
                            assignmentsSafe,
                            pulls || null,
                            d.key,
                            sn,
                            idx,
                          );
                          const assignedNamesNonEmpty = cellRaw
                            .map((x) => String(x || "").trim())
                            .filter(Boolean);
                          const showCell = activeDay && required > 0;
                          const pullsInCell = countPullEntriesInCell(pulls || null, d.key, sn, idx);
                          const assignedCount = Math.max(0, assignedNamesNonEmpty.length - pullsInCell);
                          const slotCount = Math.max(
                            required + pullsInCell,
                            assignedNamesNonEmpty.length,
                            cellRaw.length,
                            1,
                          );

                          return (
                            <td
                              key={d.key}
                              className={
                                "px-2 py-2 text-center " +
                                (shiftRowEnabled ? "" : "text-zinc-400 ") +
                                (!activeDay ? "bg-zinc-100 text-zinc-400 dark:bg-zinc-900/40 " : "") +
                                (isPastDay ? " bg-zinc-100 dark:bg-zinc-900/40 " : "")
                              }
                            >
                              {shiftRowEnabled ? (
                                <div className="flex flex-col items-center rounded-md">
                                  {showCell ? (
                                <div className="mb-1 flex min-w-full flex-col items-center gap-1">
                                  {Array.from({ length: slotCount }).map((_, slotIdx) => {
                                    const nm = String(cellRaw[slotIdx] || "").trim();
                                    if (!nm) {
                                      return (
                                        <div
                                          key={`empty-${d.key}-${sn}-${idx}-${slotIdx}`}
                                          className="group/slot flex w-full justify-center py-0.5"
                                        >
                                          <span
                                            aria-hidden
                                            className="inline-flex min-h-6 min-w-[2.15rem] w-auto max-w-[6rem] flex-col items-center justify-center overflow-hidden rounded-full border border-zinc-200 bg-zinc-100 px-1 py-0.5 text-[8px] text-zinc-400 transition-[max-width,transform] duration-200 ease-out md:min-h-9 md:w-full md:max-w-[6rem] md:px-3 md:py-1 md:text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
                                          >
                                            <span className="text-[7px] font-medium opacity-0 md:text-[10px]">
                                              —
                                            </span>
                                            <span className="text-[8px] leading-none text-zinc-400 md:text-xs dark:text-zinc-400">
                                              —
                                            </span>
                                          </span>
                                        </div>
                                      );
                                    }
                                    const c = workerNameChipColor(nm);
                                    const ring = pullRingClass(pulls || null, d.key, sn, idx, nm);
                                    const nmKey = normName(nm);
                                    const expKey = expandedKeyFor(
                                      d.key,
                                      sn,
                                      idx,
                                      slotIdx,
                                      nmKey || `slot-${slotIdx}`,
                                    );
                                    const pullTime = pullTimeRangeForName(
                                      pulls || null,
                                      d.key,
                                      sn,
                                      idx,
                                      nm,
                                    );
                                    return (
                                      <div
                                        key={`${d.key}-${sn}-${idx}-slot-${slotIdx}-${nmKey}`}
                                        className="group/slot relative flex w-full justify-center py-0.5"
                                      >
                                        <span
                                          tabIndex={0}
                                          className={
                                            "relative inline-flex min-h-6 w-auto max-w-[6rem] min-w-0 cursor-default select-none flex-col items-center overflow-hidden rounded-full border px-1 py-0.5 shadow-sm transition-[max-width,transform] duration-200 ease-out md:min-h-9 md:w-full md:max-w-[6rem] md:px-3 md:py-1 md:group-hover/slot:max-w-[18rem] md:group-hover/slot:z-30 md:focus:max-w-[18rem] md:focus:z-30 focus:outline-none" +
                                            (expandedSlotKey === expKey
                                              ? " z-30 w-[18rem] max-w-[18rem]"
                                              : "") +
                                            ring
                                          }
                                          style={{
                                            backgroundColor: c.bg,
                                            borderColor: c.border,
                                            color: c.text,
                                          }}
                                          title={nm}
                                          onPointerDown={() => setExpandedSlotKey(expKey)}
                                          onPointerEnter={(e) => {
                                            if (e.pointerType === "mouse") setExpandedSlotKey(expKey);
                                          }}
                                          onPointerLeave={(e) => {
                                            if (e.pointerType === "mouse") {
                                              setExpandedSlotKey((k) => (k === expKey ? null : k));
                                            }
                                          }}
                                          onFocus={() => setExpandedSlotKey(expKey)}
                                          onBlur={() =>
                                            setExpandedSlotKey((k) => (k === expKey ? null : k))
                                          }
                                        >
                                          <span className="flex w-full min-w-0 flex-1 flex-col items-center overflow-hidden text-center leading-tight">
                                            <span
                                              className={
                                                "block w-full min-w-0 max-w-full leading-tight md:text-center " +
                                                (isRtlName(nm) ? "text-right" : "text-left")
                                              }
                                              dir={isRtlName(nm) ? "rtl" : "ltr"}
                                            >
                                              <span className="md:hidden">
                                                {expandedSlotKey === expKey ? (
                                                  <span className="whitespace-nowrap text-[7px]">{nm}</span>
                                                ) : (
                                                  <span className="text-[7px]">{truncateMobile6(nm)}</span>
                                                )}
                                              </span>
                                              <span className="hidden max-w-full truncate text-[8px] md:block md:text-sm">
                                                {nm}
                                              </span>
                                            </span>
                                            {pullTime ? (
                                              <span
                                                dir="ltr"
                                                className="mt-0.5 max-w-full truncate text-[6px] leading-tight text-zinc-800/85 dark:text-zinc-200/85 md:text-[10px]"
                                              >
                                                {pullTime}
                                              </span>
                                            ) : null}
                                          </span>
                                        </span>
                                      </div>
                                    );
                                  })}
                                  <div className="mt-0.5 flex w-full min-w-0 flex-col items-center gap-0.5 leading-tight max-md:max-w-[5.5rem] md:max-w-none md:mt-1 md:gap-1">
                                    <span
                                      className={
                                        "flex w-full items-center justify-center gap-0.5 whitespace-nowrap text-[7px] md:text-[10px] " +
                                        (assignedCount < required
                                          ? "text-red-600 dark:text-red-400"
                                          : required > 0 && assignedCount >= required
                                            ? "text-green-600 dark:text-green-400"
                                            : "")
                                      }
                                    >
                                      <span>שיבוצים:</span>
                                      <span className="font-medium tabular-nums">{assignedCount}</span>
                                    </span>
                                    <span className="flex w-full items-center justify-center gap-0.5 whitespace-nowrap text-[7px] text-zinc-500 md:text-[10px]">
                                      <span>נדרש:</span>
                                      <span className="font-medium tabular-nums text-zinc-600 dark:text-zinc-400">
                                        {required}
                                      </span>
                                    </span>
                                  </div>
                                </div>
                                  ) : (
                                    <span className="text-[9px] md:text-xs">לא פעיל</span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-[9px] md:text-xs">לא פעיל</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

"use client";

import { workerNameChipColor } from "./lib/worker-name-chip-color";
import { isRtlName, truncateMobile6 } from "./lib/planning-v2-worker-name";

export type LinkedSitesRailSiteBlock = {
  siteId: number;
  siteName: string;
  siteDeleted: boolean;
  rows: Array<{ dayKey: string; shiftName: string; stationLabel: string; workers: string[] }>;
  workerCounts: Array<{ workerName: string; count: number }>;
};

export type LinkedSitesRailBadges = {
  savedBySiteId: Map<number, boolean>;
  filterCountBySiteId: Map<number, number>;
};

type WorkerChipColor = { bg: string; border: string; text: string };

type PlanningV2LinkedSitesRailProps = {
  alternativesUiVisible: boolean;
  selectedVisibleAlternativeIndex: number;
  visibleAlternativeIndicesLength: number;
  linkedSitesRailData: LinkedSitesRailSiteBlock[];
  linkedSiteRailBadges: LinkedSitesRailBadges;
  linkedSiteHolesById: Map<number, number>;
  workerColorMap: Map<string, WorkerChipColor>;
  onNavigateToSite: (siteId: number) => void;
};

export function PlanningV2LinkedSitesRail({
  alternativesUiVisible,
  selectedVisibleAlternativeIndex,
  visibleAlternativeIndicesLength,
  linkedSitesRailData,
  linkedSiteRailBadges,
  linkedSiteHolesById,
  workerColorMap,
  onNavigateToSite,
}: PlanningV2LinkedSitesRailProps) {
  return (
    <div className="flex h-full min-h-0 w-full max-w-full flex-1 flex-col gap-3 overflow-hidden">
      <div className="shrink-0 border-b border-zinc-100 bg-white pb-2 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-base font-extrabold text-zinc-900 dark:text-zinc-100">אתרים מקושרים</div>
          <div className="flex flex-col items-end gap-0.5">
            {alternativesUiVisible ? (
              <span className="rounded-md border border-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                חלופה מסוננת{" "}
                {Math.max(1, selectedVisibleAlternativeIndex >= 0 ? selectedVisibleAlternativeIndex + 1 : 1)}/
                {Math.max(1, visibleAlternativeIndicesLength)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">
          מוצגים רק עובדים רב-אתריים בעמדות של החלופה הנוכחית.
        </div>
      </div>
      <div className="planning-v2-linked-rail-scroll min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-auto overscroll-y-contain pt-1 pb-2 pl-0.5 pr-0.5 touch-pan-y [-webkit-overflow-scrolling:touch]">
        {linkedSitesRailData.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 p-2 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            אין אתרים מקושרים נוספים להצגה.
          </div>
        ) : (
          linkedSitesRailData.map((siteBlock) => (
            <div key={siteBlock.siteId} className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
              <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-200">
                    <span className="min-w-0 break-words">{siteBlock.siteName}</span>
                    {linkedSiteRailBadges.savedBySiteId.get(siteBlock.siteId) ? (
                      <span className="shrink-0 rounded bg-emerald-100 px-1 py-px text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                        תכנון שמור
                      </span>
                    ) : null}
                    {siteBlock.siteDeleted ? (
                      <span className="shrink-0 rounded bg-zinc-200 px-1 py-px text-[10px] font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300">
                        ארכיון
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-[10px] font-bold text-red-600 dark:text-red-400">
                    חוסרים:{" "}
                    {linkedSiteHolesById.has(siteBlock.siteId)
                      ? linkedSiteHolesById.get(siteBlock.siteId)
                      : "—"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigateToSite(siteBlock.siteId)}
                  className="shrink-0 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[10px] font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  פתח אתר
                </button>
              </div>
              <div className="mb-2 rounded-md border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="mb-1 text-[10px] font-semibold text-zinc-600 dark:text-zinc-300">
                  עובדים רב-אתריים משובצים באתר זה
                  {(linkedSiteRailBadges.filterCountBySiteId.get(siteBlock.siteId) || 0) > 0 ? (
                    <span className="ms-1 inline-flex items-center rounded border border-orange-200 bg-orange-50 px-1.5 py-px text-[9px] font-semibold text-orange-700 dark:border-orange-800 dark:bg-orange-900/30 dark:text-orange-300">
                      פילטר
                    </span>
                  ) : null}
                </div>
                {siteBlock.workerCounts.length === 0 ? (
                  <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                    אין שיבוצים רב-אתריים בחלופה זו.
                  </div>
                ) : (
                  <div className="max-h-24 overflow-y-auto">
                    <table className="w-full border-collapse text-[10px]">
                      <thead>
                        <tr className="border-b dark:border-zinc-800">
                          <th className="px-1 py-1 text-right text-zinc-500 dark:text-zinc-400">עובד</th>
                          <th className="w-14 px-1 py-1 text-center text-zinc-500 dark:text-zinc-400">
                            {(linkedSiteRailBadges.filterCountBySiteId.get(siteBlock.siteId) || 0) > 0 ? (
                              <span className="inline-flex items-center rounded border border-orange-300 px-1.5 py-0.5 text-orange-700 dark:border-orange-700 dark:text-orange-300">
                                שיבוצים
                              </span>
                            ) : (
                              "שיבוצים"
                            )}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {siteBlock.workerCounts.map((entry) => (
                          <tr
                            key={`${siteBlock.siteId}-${entry.workerName}`}
                            className="border-b last:border-0 dark:border-zinc-800"
                          >
                            <td className="px-1 py-1 text-zinc-700 dark:text-zinc-200">{entry.workerName}</td>
                            <td className="px-1 py-1 text-center font-semibold text-zinc-700 dark:text-zinc-200">
                              {(linkedSiteRailBadges.filterCountBySiteId.get(siteBlock.siteId) || 0) > 0 ? (
                                <span className="inline-flex min-w-6 items-center justify-center rounded border border-orange-300 px-1 py-px text-orange-700 dark:border-orange-700 dark:text-orange-300">
                                  {entry.count}
                                </span>
                              ) : (
                                entry.count
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              {(() => {
                const dayOrder = [
                  "sun",
                  "sunday",
                  "mon",
                  "monday",
                  "tue",
                  "tuesday",
                  "wed",
                  "wednesday",
                  "thu",
                  "thursday",
                  "fri",
                  "friday",
                  "sat",
                  "saturday",
                ];
                const dayLabel: Record<string, string> = {
                  sun: "א׳",
                  sunday: "א׳",
                  mon: "ב׳",
                  monday: "ב׳",
                  tue: "ג׳",
                  tuesday: "ג׳",
                  wed: "ד׳",
                  wednesday: "ד׳",
                  thu: "ה׳",
                  thursday: "ה׳",
                  fri: "ו׳",
                  friday: "ו׳",
                  sat: "ש׳",
                  saturday: "ש׳",
                };
                const shiftOrder = ["morning", "noon", "night", "בוקר", "צהריים", "לילה"];

                if (siteBlock.rows.length === 0) {
                  return (
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-[11px]">
                        <thead>
                          <tr className="border-b dark:border-zinc-800">
                            <th className="px-1 py-1 text-right text-zinc-500 dark:text-zinc-400">משמרת</th>
                            <th className="min-w-[10rem] px-1 py-1 text-center text-zinc-500 dark:text-zinc-400"> </th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-b dark:border-zinc-800">
                            <td className="whitespace-nowrap px-1 py-2 align-middle text-zinc-400 dark:text-zinc-500">
                              —
                            </td>
                            <td className="border border-dashed border-zinc-200 px-2 py-3 text-center text-[10px] leading-snug text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                              אין עובדים רב-אתריים משובצים בחלופה זו.
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  );
                }

                const days = [...new Set(siteBlock.rows.map((r) => String(r.dayKey || "")))].sort((a, b) => {
                  const ia = dayOrder.indexOf(a.toLowerCase());
                  const ib = dayOrder.indexOf(b.toLowerCase());
                  if (ia >= 0 || ib >= 0) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
                  return a.localeCompare(b);
                });
                const shifts = [...new Set(siteBlock.rows.map((r) => String(r.shiftName || "")))].sort((a, b) => {
                  const ia = shiftOrder.findIndex((x) => a.toLowerCase().includes(x.toLowerCase()));
                  const ib = shiftOrder.findIndex((x) => b.toLowerCase().includes(x.toLowerCase()));
                  if (ia >= 0 || ib >= 0) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
                  return a.localeCompare(b);
                });
                const cellMap = new Map<string, Array<{ stationLabel: string; workers: string[] }>>();
                siteBlock.rows.forEach((r) => {
                  const k = `${r.dayKey}||${r.shiftName}`;
                  const current = cellMap.get(k) || [];
                  cellMap.set(k, [...current, { stationLabel: r.stationLabel, workers: r.workers }]);
                });
                return (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-[11px]">
                      <thead>
                        <tr className="border-b dark:border-zinc-800">
                          <th className="px-1 py-1 text-right text-zinc-500 dark:text-zinc-400">משמרת</th>
                          {days.map((d) => (
                            <th
                              key={`${siteBlock.siteId}-${d}`}
                              className="px-1 py-1 text-center text-zinc-500 dark:text-zinc-400"
                            >
                              {dayLabel[d.toLowerCase()] || d}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {shifts.map((s) => (
                          <tr key={`${siteBlock.siteId}-${s}`} className="border-b last:border-0 dark:border-zinc-800">
                            <td className="whitespace-nowrap px-1 py-1 font-medium text-zinc-700 dark:text-zinc-200">
                              {s}
                            </td>
                            {days.map((d) => {
                              const k = `${d}||${s}`;
                              const lines = cellMap.get(k) || [];
                              return (
                                <td key={`${siteBlock.siteId}-${d}-${s}`} className="align-top px-1 py-1">
                                  {lines.length === 0 ? (
                                    <span className="text-zinc-400 dark:text-zinc-500">—</span>
                                  ) : (
                                    <div className="space-y-0.5">
                                      {lines.slice(0, 3).map((line, idx) => (
                                        <div
                                          key={`${k}-${idx}`}
                                          className="rounded bg-zinc-50 px-1 py-0.5 dark:bg-zinc-900/50"
                                        >
                                          <div className="mb-0.5 text-[10px] text-zinc-600 dark:text-zinc-400">
                                            {line.stationLabel}
                                          </div>
                                          <div className="flex flex-wrap gap-1">
                                            {line.workers.map((nm) => {
                                                      const col = workerNameChipColor(nm, workerColorMap);
                                              return (
                                                <span
                                                  key={`${k}-${idx}-${nm}`}
                                                  className="inline-flex max-w-[6.5rem] min-w-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] md:max-w-[10rem]"
                                                  style={{
                                                    backgroundColor: col.bg,
                                                    borderColor: col.border,
                                                    color: col.text,
                                                  }}
                                                  dir={isRtlName(nm) ? "rtl" : "ltr"}
                                                >
                                                  <span className="md:hidden">{truncateMobile6(nm)}</span>
                                                  <span className="hidden max-w-full truncate md:inline">{nm}</span>
                                                </span>
                                              );
                                            })}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

"use client";

import type { SalaryReport } from "./lib/salary-calculator";

type PlanningV2SalaryReportModalProps = {
  open: boolean;
  title: string;
  report: SalaryReport | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
};

function fmtMoney(n: number): string {
  return n.toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtHours(n: number): string {
  return n.toLocaleString("he-IL", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

export function PlanningV2SalaryReportModal({
  open,
  title,
  report,
  loading,
  error,
  onClose,
}: PlanningV2SalaryReportModalProps) {
  if (!open) return null;

  const showTravel = !!report && report.config.travelMode !== "none";
  const showMonthlyBonus = !!report && report.lines.some((l) => l.monthlyBonus > 0);

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-950"
        dir="rtl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-3 dark:border-zinc-800">
          <div>
            <div className="text-lg font-semibold">{title}</div>
            {report ? <div className="text-xs text-zinc-500">{report.periodLabel}</div> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            סגור
          </button>
        </div>

        <div className="flex-1 overflow-auto px-4 py-3">
          {loading ? (
            <div className="py-10 text-center text-sm text-zinc-500">מחשב משכורת…</div>
          ) : error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          ) : !report ? (
            <div className="py-10 text-center text-sm text-zinc-500">אין נתונים</div>
          ) : report.config.defaultHourlyRate <= 0 && Object.keys(report.config.ratesByRole).length === 0 ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              לא הוגדר שכר שעתי בהגדרות האתר. היכנסו ל־הגדרות האתר ומלאו את תעריף השעה (ובמידת הצורך לפי תפקיד).
            </div>
          ) : report.lines.length === 0 ? (
            <div className="py-10 text-center text-sm text-zinc-500">אין שיבוצים לתקופה זו</div>
          ) : (
            <>
              <div className="mb-3 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
                <div className="rounded-md border px-3 py-2 dark:border-zinc-800">
                  <div className="text-xs text-zinc-500">סה״כ שעות עבודה</div>
                  <div className="font-semibold tabular-nums">{fmtHours(report.totalHours)}</div>
                </div>
                <div className="rounded-md border px-3 py-2 dark:border-zinc-800">
                  <div className="text-xs text-zinc-500">ברוטו כולל</div>
                  <div className="font-semibold tabular-nums text-[#00A8E0]">
                    ₪{fmtMoney(report.totalGross)}
                  </div>
                </div>
                <div className="rounded-md border px-3 py-2 dark:border-zinc-800">
                  <div className="text-xs text-zinc-500">שעות נוספות</div>
                  <div className="text-xs text-zinc-600 dark:text-zinc-300">
                    שעה 9 → {report.config.otHour9Percent}%
                    <br />
                    שעה 10 → {report.config.otHour10Percent}%
                    <br />
                    שעה 11+ → {report.config.otHour11Percent}%
                  </div>
                </div>
                <div className="rounded-md border px-3 py-2 dark:border-zinc-800">
                  <div className="text-xs text-zinc-500">שבת / ימי חג</div>
                  <div className="text-xs text-zinc-600 dark:text-zinc-300">
                    ו׳ {String(report.config.weekendStartHour).padStart(2, "0")}:
                    {String(report.config.weekendStartMinute).padStart(2, "0")} → א׳{" "}
                    {String(report.config.weekendEndHour).padStart(2, "0")}:
                    {String(report.config.weekendEndMinute).padStart(2, "0")} · {report.config.weekendPremiumPercent}%
                    <br />
                    יום טוב + חגים לאומיים {report.config.yomTovPremiumPercent}% (לא חול המועד)
                  </div>
                </div>
              </div>

              {showTravel ||
              showMonthlyBonus ||
              report.config.defaultMonthlyBonus > 0 ||
              Object.keys(report.config.monthlyBonusByRole).length > 0 ? (
                <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                  {showTravel ? (
                    <div>
                      נסיעות:{" "}
                      {report.config.travelMode === "fixed"
                        ? `₪${fmtMoney(report.config.travelFixedPerShift)} למשמרת`
                        : `${fmtHours(report.config.travelHoursPerShift)} שעות שכר למשמרת (100% בלבד, לא נספר כזמן עבודה)`}
                      {" · "}
                      {report.config.travelAllWorkers
                        ? "כל העובדים"
                        : report.config.travelWorkerNames.length > 0
                          ? `רק: ${report.config.travelWorkerNames.join(", ")}`
                          : "עובדים נבחרים (לא הוגדרו)"}
                    </div>
                  ) : null}
                  {showMonthlyBonus ? (
                    <div>
                      מענק חודשי לפי תפקיד — כלול בברוטו
                      {report.config.monthlyBonusAllWorkers
                        ? " · כל העובדים"
                        : report.config.monthlyBonusWorkerNames.length > 0
                          ? ` · רק: ${report.config.monthlyBonusWorkerNames.join(", ")}`
                          : " · עובדים נבחרים"}
                      .
                    </div>
                  ) : report.config.defaultMonthlyBonus > 0 ||
                    Object.keys(report.config.monthlyBonusByRole).length > 0 ? (
                    <div>
                      מענק חודשי מוגדר בהגדרות — מופיע בחישוב «משכורת חודש» בלבד
                      {report.config.monthlyBonusAllWorkers
                        ? ""
                        : report.config.monthlyBonusWorkerNames.length > 0
                          ? ` · רק: ${report.config.monthlyBonusWorkerNames.join(", ")}`
                          : " · עובדים נבחרים"}
                      .
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="overflow-x-auto rounded-md border dark:border-zinc-800">
                <table className="min-w-full text-sm">
                  <thead className="bg-zinc-50 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
                    <tr>
                      <th className="px-2 py-2 text-right font-medium">עובד</th>
                      <th className="px-2 py-2 text-right font-medium">תעריף</th>
                      <th className="px-2 py-2 text-right font-medium">שעות</th>
                      <th className="px-2 py-2 text-right font-medium">רגיל</th>
                      <th className="px-2 py-2 text-right font-medium">ש׳ 9–10</th>
                      <th className="px-2 py-2 text-right font-medium">ש׳ 11+/שבת·חג</th>
                      {showTravel ? (
                        <th className="px-2 py-2 text-right font-medium">נסיעות</th>
                      ) : null}
                      {showMonthlyBonus ? (
                        <th className="px-2 py-2 text-right font-medium">מענק</th>
                      ) : null}
                      <th className="px-2 py-2 text-right font-medium">ברוטו</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.lines.map((line) => (
                      <tr key={line.workerName} className="border-t dark:border-zinc-800">
                        <td className="px-2 py-1.5">
                          <div className="font-medium">{line.workerName}</div>
                          {line.roles.length > 0 ? (
                            <div className="text-[11px] text-zinc-500">{line.roles.join(", ")}</div>
                          ) : null}
                        </td>
                        <td className="px-2 py-1.5 tabular-nums">₪{fmtMoney(line.hourlyRate)}</td>
                        <td className="px-2 py-1.5 tabular-nums">{fmtHours(line.totalHours)}</td>
                        <td className="px-2 py-1.5 tabular-nums">{fmtHours(line.regularHours)}</td>
                        <td className="px-2 py-1.5 tabular-nums">{fmtHours(line.ot125Hours)}</td>
                        <td className="px-2 py-1.5 tabular-nums">
                          {fmtHours(line.ot150Hours + line.premiumHours)}
                        </td>
                        {showTravel ? (
                          <td className="px-2 py-1.5 tabular-nums">
                            <div>₪{fmtMoney(line.travelPay)}</div>
                            <div className="text-[10px] text-zinc-500">
                              {line.travelShifts} מש׳
                              {line.travelBonusHours > 0
                                ? ` · ${fmtHours(line.travelBonusHours)} שע׳ בונוס`
                                : ""}
                            </div>
                          </td>
                        ) : null}
                        {showMonthlyBonus ? (
                          <td className="px-2 py-1.5 tabular-nums">₪{fmtMoney(line.monthlyBonus)}</td>
                        ) : null}
                        <td className="px-2 py-1.5 font-semibold tabular-nums">₪{fmtMoney(line.grossPay)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
                חישוב ברוטו משוער לפי הגדרות האתר: שעות נוספות יומיות, שבת/ימי חג, נסיעות (בונוס
                בלבד) ומענק חודשי. שעות נסיעות לא נספרות כזמן עבודה ואינן מקבלות אחוזי שבת/שעות
                נוספות. יש לאמת מול רואה חשבון / חוקי עבודה ספציפיים לאתר.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { type ReactElement, useEffect, useMemo, useState } from "react";
import type { PlanningWorker, SiteSummary } from "./types";
import { workerNameChipColor } from "./lib/worker-name-chip-color";
import {
  buildTotalAssignmentsByIdentity,
  countAssignmentsPerWorkerName,
  subtractPullExtrasFromWorkerCounts,
  sumTotalRequiredFromAssignments,
  totalAssignmentsForSummaryWorker,
} from "./lib/assignments-summary-math";
import { usePlanningV2LinkedSites } from "./hooks/use-planning-v2-linked-sites";

function isRtlName(s: string): boolean {
  return /[\u0590-\u05FF]/.test(String(s || ""));
}

function truncateSummaryMobile(value: unknown): string {
  const str = String(value ?? "");
  const chars = Array.from(str);
  return chars.length > 10 ? chars.slice(0, 8).join("") + "…" : str;
}

function SummaryWorkerChip({ name }: { name: string }): ReactElement {
  const col = workerNameChipColor(name);
  return (
    <span
      className="inline-flex min-h-6 w-fit max-w-[8rem] min-w-0 items-start overflow-hidden rounded-full border px-1.5 py-0.5 shadow-sm md:min-h-9 md:max-w-[24rem] md:px-3 md:py-1"
      style={{ backgroundColor: col.bg, borderColor: col.border, color: col.text }}
    >
      <span className="flex min-w-0 max-w-full flex-col items-center overflow-hidden text-center leading-tight">
        <span
          className={
            "block min-w-0 max-w-full leading-tight md:text-center " +
            (isRtlName(name) ? "text-right" : "text-left")
          }
          dir={isRtlName(name) ? "rtl" : "ltr"}
        >
          <span className="text-[8px] md:hidden">{truncateSummaryMobile(name)}</span>
          <span className="hidden truncate text-[8px] md:block md:text-sm">{name}</span>
        </span>
      </span>
    </span>
  );
}

type PlanningV2AssignmentsSummaryProps = {
  siteId: string;
  site: SiteSummary | null;
  weekStart: Date;
  workers: PlanningWorker[];
  assignments: Record<string, Record<string, string[][]>> | null | undefined;
  pulls?: Record<string, { before?: { name?: string }; after?: { name?: string } }> | null;
  loading?: boolean;
};

export function PlanningV2AssignmentsSummary({
  siteId,
  site,
  weekStart,
  workers,
  assignments,
  pulls,
  loading,
}: PlanningV2AssignmentsSummaryProps) {
  const { linkedSites } = usePlanningV2LinkedSites(siteId, weekStart);
  const showMultiSiteTotalColumn = linkedSites.length > 1;

  const [memoryTick, setMemoryTick] = useState(0);
  useEffect(() => {
    const onMem = () => setMemoryTick((t) => t + 1);
    window.addEventListener("linked-plans-memory-updated", onMem);
    return () => window.removeEventListener("linked-plans-memory-updated", onMem);
  }, []);

  const stations = (site?.config?.stations || []) as unknown[];

  const workersByName = useMemo(() => {
    const m = new Map<string, PlanningWorker>();
    for (const w of workers) {
      const n = String(w.name || "").trim();
      if (n) m.set(n, w);
    }
    return m;
  }, [workers]);

  const byIdentity = useMemo(() => {
    void memoryTick;
    return buildTotalAssignmentsByIdentity(workers, weekStart, assignments ?? {}, pulls ?? null);
  }, [workers, weekStart, assignments, pulls, memoryTick]);

  const { items, totalRequired, totalAssigned } = useMemo(() => {
    const plan = assignments ?? {};
    const counts = countAssignmentsPerWorkerName(plan);
    const countsAdjusted = subtractPullExtrasFromWorkerCounts(counts, pulls ?? null);
    workers.forEach((w) => {
      const n = String(w.name || "").trim();
      if (n && !countsAdjusted.has(n)) countsAdjusted.set(n, 0);
    });
    const isPendingApprovalName = (name: string) =>
      !!workers.find((w) => String(w.name || "").trim() === String(name || "").trim())?.pendingApproval;
    const order = new Map<string, number>();
    workers.forEach((w, i) => order.set(w.name, i));
    const sorted = Array.from(countsAdjusted.entries())
      .filter(([nm]) => !isPendingApprovalName(nm))
      .sort((a, b) => {
        const ia = order.has(a[0]) ? (order.get(a[0]) as number) : Number.MAX_SAFE_INTEGER;
        const ib = order.has(b[0]) ? (order.get(b[0]) as number) : Number.MAX_SAFE_INTEGER;
        if (ia !== ib) return ia - ib;
        return a[0].localeCompare(b[0]);
      });
    const tr = sumTotalRequiredFromAssignments(stations, plan);
    const ta = Array.from(countsAdjusted.values()).reduce((a, b) => a + b, 0);
    return { items: sorted, totalRequired: tr, totalAssigned: ta };
  }, [assignments, workers, stations, pulls]);

  if (loading) {
    return (
      <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
        <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">סיכום שיבוצים לעמדה (כל העמדות)</div>
        <p className="text-sm text-zinc-500">טוען…</p>
      </div>
    );
  }

  if (workers.length === 0) {
    return (
      <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
        <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">סיכום שיבוצים לעמדה (כל העמדות)</div>
        <div className="text-sm text-zinc-500">אין שיבוצים</div>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
      <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">סיכום שיבוצים לעמדה (כל העמדות)</div>
      <div className="mb-2 flex flex-wrap items-center justify-end gap-6 text-xs md:text-sm">
        <div>
          סה&quot;כ נדרש: <span className="font-medium">{totalRequired}</span>
        </div>
        <div>
          סה&quot;כ שיבוצים: <span className="font-medium">{totalAssigned}</span>
        </div>
      </div>
      <div className="max-h-[24rem] overflow-y-auto overflow-x-hidden md:overflow-x-auto">
        <table className="w-full table-fixed border-collapse text-[10px] md:text-sm">
          <thead>
            <tr className="border-b dark:border-zinc-800">
              <th className="w-32 px-1 py-1 text-center md:w-64 md:px-2 md:py-2">עובד</th>
              <th className="w-16 whitespace-nowrap px-1 py-1 text-right md:w-28 md:px-2 md:py-2">מס&apos; משמרות</th>
              {showMultiSiteTotalColumn ? (
                <th className="w-16 whitespace-nowrap px-1 py-1 text-right md:w-28 md:px-2 md:py-2">
                  total שיבוצים
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {items.map(([nm, c]) => (
              <tr key={nm} className="border-b last:border-0 dark:border-zinc-800">
                <td className="w-32 overflow-hidden px-1 py-1 text-center md:w-64 md:px-2 md:py-2">
                  <SummaryWorkerChip name={nm} />
                </td>
                <td className="w-16 whitespace-nowrap px-1 py-1 md:w-28 md:px-2 md:py-2">{c}</td>
                {showMultiSiteTotalColumn ? (
                  <td className="w-16 whitespace-nowrap px-1 py-1 text-right md:w-28 md:px-2 md:py-2">
                    {totalAssignmentsForSummaryWorker(nm, c, true, workersByName, byIdentity)}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

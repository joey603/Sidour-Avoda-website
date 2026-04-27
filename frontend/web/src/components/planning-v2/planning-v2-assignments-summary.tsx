"use client";

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import NumberPicker from "@/components/number-picker";
import type { PlanningV2PullsMap, PlanningWorker, SiteSummary } from "./types";
import { buildWorkerNameColorMap, workerNameChipColor } from "./lib/worker-name-chip-color";
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

function SummaryWorkerChip({
  name,
  nameColorMap,
}: {
  name: string;
  nameColorMap: Map<string, { bg: string; border: string; text: string }>;
}): ReactElement {
  const col = workerNameChipColor(name, nameColorMap);
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
  pulls?: PlanningV2PullsMap | null;
  assignmentVariants?: Array<Record<string, Record<string, string[][]>>>;
  pullVariants?: PlanningV2PullsMap[];
  selectedAlternativeIndex?: number;
  onSelectedAlternativeChange?: (index: number) => void;
  onFilteredAlternativesChange?: (payload: { indices: number[]; hasActiveFilters: boolean }) => void;
  loading?: boolean;
};

export function PlanningV2AssignmentsSummary({
  siteId,
  site,
  weekStart,
  workers,
  assignments,
  pulls,
  assignmentVariants = [],
  pullVariants = [],
  selectedAlternativeIndex = 0,
  onSelectedAlternativeChange,
  onFilteredAlternativesChange,
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

  const nameColorMap = useMemo(() => {
    const names: string[] = [];
    for (const w of workers) {
      const n = String(w?.name || "").trim();
      if (n) names.push(n);
    }
    return buildWorkerNameColorMap(names);
  }, [workers]);

  const [assignmentCountFilters, setAssignmentCountFilters] = useState<Record<string, string>>({});
  const hasActiveAssignmentCountFilters = useMemo(
    () => Object.values(assignmentCountFilters).some((v) => String(v || "").trim() !== ""),
    [assignmentCountFilters],
  );

  const assignmentCountsByVariant = useMemo(() => {
    const variants = Array.isArray(assignmentVariants) ? assignmentVariants : [];
    return variants.map((variantAssignments, idx) =>
      subtractPullExtrasFromWorkerCounts(
        countAssignmentsPerWorkerName(variantAssignments || {}),
        (pullVariants[idx] || {}) as PlanningV2PullsMap,
      ),
    );
  }, [assignmentVariants, pullVariants]);

  const generatedAssignmentCountOptionsByWorker = useMemo(() => {
    const out = new Map<string, number[]>();
    for (const counts of assignmentCountsByVariant) {
      for (const [nm, val] of counts.entries()) {
        const cur = out.get(nm) || [];
        if (!cur.includes(val)) cur.push(val);
        out.set(nm, cur);
      }
    }
    for (const nm of out.keys()) {
      out.set(
        nm,
        [...(out.get(nm) || [])].sort((a, b) => a - b),
      );
    }
    return out;
  }, [assignmentCountsByVariant]);

  const filteredAlternativeIndices = useMemo(() => {
    if (!assignmentCountsByVariant.length) return [];
    const active = Object.entries(assignmentCountFilters).filter(([, v]) => String(v || "").trim() !== "");
    if (active.length === 0) {
      return assignmentCountsByVariant.map((_, idx) => idx);
    }
    return assignmentCountsByVariant
      .map((counts, idx) => ({ counts, idx }))
      .filter(({ counts }) =>
        active.every(([nm, raw]) => {
          const target = Number(raw);
          if (!Number.isFinite(target)) return true;
          return Number(counts.get(nm) || 0) === target;
        }),
      )
      .map((x) => x.idx);
  }, [assignmentCountsByVariant, assignmentCountFilters]);

  /** Clé stable : évite useEffect qui se redéclenchent à chaque render à cause d’une nouvelle ref de tableau. */
  const filteredAlternativeIndicesKey = useMemo(
    () => filteredAlternativeIndices.join(","),
    [filteredAlternativeIndices],
  );

  function handleAssignmentCountFilterChange(workerName: string, rawValue: string, maxAllowed?: number) {
    const cleaned = String(rawValue || "").replace(/[^\d]/g, "");
    setAssignmentCountFilters((prev) => {
      const next = { ...prev };
      if (!cleaned) {
        delete next[workerName];
      } else {
        const numeric = Number(cleaned);
        const bounded = Number.isFinite(maxAllowed) ? Math.min(numeric, Number(maxAllowed)) : numeric;
        next[workerName] = String(bounded);
      }
      return next;
    });
  }

  useEffect(() => {
    if (!onSelectedAlternativeChange) return;
    if (assignmentCountsByVariant.length <= 1) return;
    if (!filteredAlternativeIndicesKey) return;
    const indices = filteredAlternativeIndicesKey
      .split(",")
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));
    if (indices.length === 0) return;
    if (indices.includes(selectedAlternativeIndex)) return;
    const pick = indices[0];
    if (typeof pick !== "number" || pick === selectedAlternativeIndex) return;
    onSelectedAlternativeChange(pick);
  }, [
    onSelectedAlternativeChange,
    assignmentCountsByVariant.length,
    filteredAlternativeIndicesKey,
    selectedAlternativeIndex,
  ]);

  const lastFilterNotifyKey = useRef<string>("");
  useEffect(() => {
    if (!onFilteredAlternativesChange) return;
    const notifyKey = `${filteredAlternativeIndicesKey}|${hasActiveAssignmentCountFilters ? 1 : 0}`;
    if (notifyKey === lastFilterNotifyKey.current) return;
    lastFilterNotifyKey.current = notifyKey;
    onFilteredAlternativesChange({
      indices: filteredAlternativeIndices,
      hasActiveFilters: hasActiveAssignmentCountFilters,
    });
  }, [
    onFilteredAlternativesChange,
    filteredAlternativeIndices,
    filteredAlternativeIndicesKey,
    hasActiveAssignmentCountFilters,
  ]);

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
      <div className="mb-2 flex items-center justify-between gap-3 text-sm text-zinc-600 dark:text-zinc-300 flex-wrap">
        <div>סיכום שיבוצים לעמדה (כל העמדות)</div>
        {assignmentCountsByVariant.length > 1 && hasActiveAssignmentCountFilters ? (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {filteredAlternativeIndices.length}/{assignmentCountsByVariant.length}
            </span>
            <button
              type="button"
              onClick={() => setAssignmentCountFilters({})}
              className="inline-flex items-center rounded-md border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              איפוס סינון
            </button>
          </div>
        ) : null}
      </div>
      <div className="mb-2 flex flex-wrap items-center justify-end gap-6 text-xs md:text-sm">
        <div>
          סה&quot;כ נדרש: <span className="font-medium">{totalRequired}</span>
        </div>
        <div>
          סה&quot;כ שיבוצים: <span className="font-medium">{totalAssigned}</span>
        </div>
      </div>
      {assignmentCountsByVariant.length > 1 && filteredAlternativeIndices.length === 0 ? (
        <div className="mb-2 text-sm text-amber-600 dark:text-amber-400">
          אין חלופות שתואמות את מספרי המשמרות שנבחרו.
        </div>
      ) : null}
      <div className="max-h-[24rem] overflow-y-auto overflow-x-hidden md:overflow-x-auto">
        <table className="w-full border-collapse table-fixed text-[10px] md:text-sm">
          <thead>
            <tr className="border-b dark:border-zinc-800">
              <th className="sticky top-0 z-20 bg-white px-1 md:px-2 py-1 md:py-2 text-center w-32 md:w-64 shadow-[0_1px_0_0_rgb(228_228_231)] dark:bg-zinc-950 dark:shadow-[0_1px_0_0_rgb(39_39_42)]">עובד</th>
              <th className="sticky top-0 z-20 bg-white px-1 md:px-2 py-1 md:py-2 text-right w-16 md:w-28 whitespace-nowrap shadow-[0_1px_0_0_rgb(228_228_231)] dark:bg-zinc-950 dark:shadow-[0_1px_0_0_rgb(39_39_42)]">מס&apos; משמרות</th>
              {showMultiSiteTotalColumn ? (
                <th className="sticky top-0 z-20 bg-white px-1 md:px-2 py-1 md:py-2 text-right w-16 md:w-28 whitespace-nowrap shadow-[0_1px_0_0_rgb(228_228_231)] dark:bg-zinc-950 dark:shadow-[0_1px_0_0_rgb(39_39_42)]">
                  סה״כ שיבוצים
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {items.map(([nm, c]) => {
              const allowedCounts = generatedAssignmentCountOptionsByWorker.get(nm) || [c];
              const minAllowed = allowedCounts[0] ?? 0;
              const maxAllowed = allowedCounts[allowedCounts.length - 1] ?? c;
              const isManuallyModified = Object.prototype.hasOwnProperty.call(assignmentCountFilters, nm);
              return (
              <tr key={nm} className="border-b last:border-0 dark:border-zinc-800">
                <td className="px-1 md:px-2 py-1 md:py-2 w-32 md:w-64 overflow-hidden text-center">
                  <SummaryWorkerChip name={nm} nameColorMap={nameColorMap} />
                </td>
                <td className="px-1 md:px-2 py-1 md:py-2 w-16 md:w-28 whitespace-nowrap">
                  {assignmentCountsByVariant.length > 1 ? (
                    <>
                      <div className="md:hidden">
                        <NumberPicker
                          value={Number(assignmentCountFilters[nm] ?? c)}
                          onChange={(value) => handleAssignmentCountFilterChange(nm, String(value), maxAllowed)}
                          min={minAllowed}
                          max={maxAllowed}
                          placeholder={String(c)}
                          className={
                            "w-14 rounded-md border px-2 py-1 text-center text-[10px] outline-none " +
                            (isManuallyModified
                              ? "border-orange-400 bg-orange-50 text-orange-700 focus:border-orange-500 dark:border-orange-600 dark:bg-orange-950/30 dark:text-orange-300"
                              : "border-zinc-300 bg-white focus:border-[#00A8E0] dark:border-zinc-700 dark:bg-zinc-950")
                          }
                        />
                      </div>
                      <input
                        type="number"
                        min={minAllowed}
                        max={maxAllowed}
                        inputMode="numeric"
                        value={assignmentCountFilters[nm] ?? ""}
                        placeholder={String(c)}
                        onChange={(e) => handleAssignmentCountFilterChange(nm, e.target.value, maxAllowed)}
                        className={
                          "hidden md:block w-14 rounded-md border px-2 py-1 text-center text-[10px] md:text-sm outline-none " +
                          (isManuallyModified
                            ? "border-orange-400 bg-orange-50 text-orange-700 focus:border-orange-500 dark:border-orange-600 dark:bg-orange-950/30 dark:text-orange-300"
                            : "border-zinc-300 bg-white focus:border-[#00A8E0] dark:border-zinc-700 dark:bg-zinc-950")
                        }
                        aria-label={`מספר משמרות עבור ${nm}`}
                        title={`Valeurs générées: ${allowedCounts.join(", ")}`}
                      />
                    </>
                  ) : (
                    c
                  )}
                </td>
                {showMultiSiteTotalColumn ? (
                  <td className="px-1 md:px-2 py-1 md:py-2 w-16 md:w-28 whitespace-nowrap text-right">
                    {totalAssignmentsForSummaryWorker(nm, c, true, workersByName, byIdentity)}
                  </td>
                ) : null}
              </tr>
            )})}
          </tbody>
        </table>
      </div>
    </div>
  );
}

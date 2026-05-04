"use client";

import { type ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import NumberPicker from "@/components/number-picker";
import type { PlanningV2PullsMap, PlanningWorker, SiteSummary } from "./types";
import { buildDistinctWorkerColorMap, workerNameChipColor } from "./lib/worker-name-chip-color";
import {
  buildTotalAssignmentsByIdentity,
  countAssignmentsPerWorkerName,
  subtractPullExtrasFromWorkerCounts,
  sumTotalRequiredFromAssignments,
  totalAssignmentsForSummaryWorker,
} from "./lib/assignments-summary-math";
import { usePlanningV2LinkedSites } from "./hooks/use-planning-v2-linked-sites";
import { getWeekKeyISO } from "./lib/week";
import {
  readLinkedPlansFromMemory,
  resolveAssignmentsForAlternative,
  resolvePullsForAlternative,
} from "./lib/multi-site-linked-memory";

function isRtlName(s: string): boolean {
  return /[\u0590-\u05FF]/.test(String(s || ""));
}

function truncateSummaryMobile(value: unknown): string {
  const str = String(value ?? "");
  const chars = Array.from(str);
  return chars.length > 10 ? chars.slice(0, 8).join("") + "…" : str;
}

function normHighlightName(s: string): string {
  return String(s || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

function normSummaryWorkerName(s: string): string {
  return String(s || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function countVisibleAssignmentsWithPulls(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: PlanningV2PullsMap | null | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();
  const plan = assignments ?? {};
  for (const [dayKey, shiftsMap] of Object.entries(plan)) {
    for (const [shiftName, perStation] of Object.entries(shiftsMap || {})) {
      (perStation || []).forEach((cell, stationIdx) => {
        const merged = Array.isArray(cell) ? cell.map((x) => String(x || "").trim()) : [];
        const have = new Set(merged.map((x) => normSummaryWorkerName(x)).filter(Boolean));
        const cellPrefix = `${dayKey}|${shiftName}|${stationIdx}|`;
        Object.entries(pulls || {}).forEach(([key, entry]) => {
          if (!String(key).startsWith(cellPrefix) || !entry || typeof entry !== "object") return;
          const before = String((entry as PlanningV2PullsMap[string])?.before?.name || "").trim();
          const after = String((entry as PlanningV2PullsMap[string])?.after?.name || "").trim();
          for (const name of [before, after]) {
            const norm = normSummaryWorkerName(name);
            if (!norm || have.has(norm)) continue;
            merged.push(name);
            have.add(norm);
          }
        });
        for (const name of merged) {
          const clean = String(name || "").trim();
          if (!clean) continue;
          counts.set(clean, (counts.get(clean) || 0) + 1);
        }
      });
    }
  }
  return counts;
}

function SummaryWorkerChip({
  name,
  nameColorMap,
  highlighted,
}: {
  name: string;
  nameColorMap: Map<string, { bg: string; border: string; text: string }>;
  highlighted?: boolean;
}): ReactElement {
  const col = workerNameChipColor(name, nameColorMap);
  /** Dépliage comme le chip du גריד au survol : élargir jusqu’au nom complet, sans changer la taille du texte. */
  return (
    <span
      className={
        "inline-flex min-h-6 items-center rounded-full border px-1.5 py-0.5 shadow-sm transition-[max-width] duration-200 ease-out md:min-h-9 md:px-3 md:py-1 " +
        (highlighted
          ? "max-w-[min(100%,85vw)] shrink-0 overflow-visible ring-2 ring-[#00A8E0] ring-offset-2 ring-offset-white dark:ring-offset-zinc-950 "
          : "max-w-[8rem] min-w-0 overflow-hidden md:max-w-[24rem] ")
      }
      style={{ backgroundColor: col.bg, borderColor: col.border, color: col.text }}
    >
      <span
        className={
          "flex min-w-0 flex-col items-center justify-center text-center leading-tight " +
          (highlighted ? "max-w-none overflow-visible" : "max-w-full overflow-hidden")
        }
      >
        <span
          className={
            "block max-w-full leading-tight md:text-center " +
            (highlighted ? "whitespace-nowrap " : "") +
            (isRtlName(name) ? "text-right" : "text-left")
          }
          dir={isRtlName(name) ? "rtl" : "ltr"}
        >
          {highlighted ? (
            <>
              <span className="text-[8px] md:hidden">{name}</span>
              <span className="hidden md:inline md:text-sm">{name}</span>
            </>
          ) : (
            <>
          <span className="text-[8px] md:hidden">{truncateSummaryMobile(name)}</span>
          <span className="hidden truncate text-[8px] md:block md:text-sm">{name}</span>
            </>
          )}
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
  /** Faux tant que יצירת תכנון n’a pas encore produit d’alternatives (bloque filtres multi-variantes). */
  alternativesEnabled?: boolean;
  selectedAlternativeIndex?: number;
  onSelectedAlternativeChange?: (index: number) => void;
  onFilteredAlternativesChange?: (payload: { indices: number[]; hasActiveFilters: boolean }) => void;
  loading?: boolean;
  /** Pendant יצירת תכנון (SSE), ne pas forcer l’index — évite « Maximum update depth exceeded ». */
  generationRunning?: boolean;
  /** Aligné avec la surbrillance dans גריד שבועי לפי עמדה. */
  highlightedWorkerName?: string | null;
  onHighlightWorkerToggle?: (workerName: string) => void;
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
  alternativesEnabled = true,
  selectedAlternativeIndex = 0,
  onSelectedAlternativeChange,
  onFilteredAlternativesChange,
  loading,
  generationRunning = false,
  highlightedWorkerName = null,
  onHighlightWorkerToggle,
}: PlanningV2AssignmentsSummaryProps) {
  const { linkedSites } = usePlanningV2LinkedSites(siteId, weekStart);
  const showMultiSiteTotalColumn = linkedSites.length > 1;
  const weekIso = useMemo(() => getWeekKeyISO(weekStart), [weekStart]);
  const linkedSiteIdsKey = useMemo(() => {
    const ids = new Set<number>();
    const cur = Number(siteId);
    if (Number.isFinite(cur) && cur > 0) ids.add(cur);
    for (const ls of linkedSites) {
      const n = Number(ls.id);
      if (Number.isFinite(n) && n > 0) ids.add(n);
    }
    return Array.from(ids)
      .sort((a, b) => a - b)
      .join("-");
  }, [linkedSites, siteId]);
  const multiSiteFiltersStorageKey = useMemo(
    () => `planning_v2_multisite_assignment_filters_by_site_${weekIso}_${linkedSiteIdsKey}`,
    [weekIso, linkedSiteIdsKey],
  );

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
    return buildTotalAssignmentsByIdentity(
      workers,
      siteId,
      weekStart,
      assignments ?? {},
      pulls ?? null,
      selectedAlternativeIndex,
    );
  }, [workers, siteId, weekStart, assignments, pulls, selectedAlternativeIndex, memoryTick]);

  const nameColorMap = useMemo(() => {
    const bundles = [assignments, ...(assignmentVariants || [])].filter(
      (x): x is Record<string, Record<string, string[][]>> =>
        !!x && typeof x === "object",
    );
    return buildDistinctWorkerColorMap(workers, bundles);
  }, [workers, assignments, assignmentVariants]);

  const [assignmentCountFilters, setAssignmentCountFilters] = useState<Record<string, string>>({});
  const [persistedMultiSiteFilters, setPersistedMultiSiteFilters] = useState<Record<string, Record<string, number>>>({});

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(multiSiteFiltersStorageKey);
      const parsed = raw ? JSON.parse(raw) : {};
      const normalized: Record<string, Record<string, number>> = {};
      if (parsed && typeof parsed === "object") {
        for (const [sid, siteFilters] of Object.entries(parsed as Record<string, unknown>)) {
          if (!siteFilters || typeof siteFilters !== "object") continue;
          const nextSite: Record<string, number> = {};
          for (const [workerName, rawVal] of Object.entries(siteFilters as Record<string, unknown>)) {
            const n = Number(rawVal);
            if (!Number.isFinite(n) || n < 0) continue;
            nextSite[String(workerName)] = Math.trunc(n);
          }
          if (Object.keys(nextSite).length > 0) normalized[String(sid)] = nextSite;
        }
      }
      setPersistedMultiSiteFilters(normalized);
      const nextLocalFilters: Record<string, string> = {};
      for (const [workerName, value] of Object.entries(normalized[String(siteId)] || {})) {
        const n = Number(value);
        if (!Number.isFinite(n)) continue;
        nextLocalFilters[String(workerName)] = String(Math.max(0, Math.trunc(n)));
      }
      setAssignmentCountFilters(nextLocalFilters);
    } catch {
      setPersistedMultiSiteFilters({});
      setAssignmentCountFilters({});
    }
  }, [multiSiteFiltersStorageKey, siteId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onReset = (evt: Event) => {
      const custom = evt as CustomEvent<{ weekIso?: string }>;
      const evtWeek = String(custom.detail?.weekIso || "").trim();
      if (evtWeek && evtWeek !== weekIso) return;
      setAssignmentCountFilters({});
      setPersistedMultiSiteFilters({});
    };
    window.addEventListener("planning-v2-assignment-filters-reset", onReset as EventListener);
    return () =>
      window.removeEventListener("planning-v2-assignment-filters-reset", onReset as EventListener);
  }, [weekIso]);

  const persistLocalFilterForWorker = useMemo(
    () => (workerName: string, valueOrNull: number | null) => {
      const cleanWorker = String(workerName || "").trim();
      if (!cleanWorker) return;
      setPersistedMultiSiteFilters((prev) => {
        const next: Record<string, Record<string, number>> = { ...prev };
        const bySite = { ...(next[String(siteId)] || {}) };
        if (valueOrNull == null) {
          delete bySite[cleanWorker];
        } else {
          bySite[cleanWorker] = Math.max(0, Math.trunc(valueOrNull));
        }
        if (Object.keys(bySite).length === 0) delete next[String(siteId)];
        else next[String(siteId)] = bySite;
        try {
          localStorage.setItem(multiSiteFiltersStorageKey, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [siteId, multiSiteFiltersStorageKey],
  );
  const hasLocalAssignmentCountFilters = useMemo(
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

  const activeAssignmentCountFilters = useMemo(
    () =>
      Object.entries(persistedMultiSiteFilters).flatMap(([sid, siteFilters]) => {
        if (!siteFilters || typeof siteFilters !== "object") return [] as Array<[string, string, number]>;
        return Object.entries(siteFilters).flatMap(([workerName, raw]) => {
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) return [] as Array<[string, string, number]>;
          return [[String(sid), String(workerName), Math.trunc(n)] as [string, string, number]];
        });
      }),
    [persistedMultiSiteFilters],
  );
  const hasActiveAssignmentCountFilters = activeAssignmentCountFilters.length > 0;

  /** Legacy parity: cacher toute alternative qui dépasse max_shifts global multi-site. */
  const maxShiftsCompatibleIndices = useMemo(() => {
    if (!assignmentCountsByVariant.length) return [] as number[];
    const currentSiteId = String(siteId);
    const linkedMemory = readLinkedPlansFromMemory(weekStart);
    const countsCache = new Map<string, Map<string, number>>();
    const getCountsForSite = (targetSiteId: string, idx: number) => {
      const cacheKey = `${targetSiteId}:${idx}`;
      if (countsCache.has(cacheKey)) return countsCache.get(cacheKey) || null;
      let counts: Map<string, number> | null = null;
      if (targetSiteId === currentSiteId) {
        counts = assignmentCountsByVariant[idx] || new Map<string, number>();
      } else {
        const sitePlan = linkedMemory?.plansBySite?.[targetSiteId];
        if (sitePlan) {
          counts = subtractPullExtrasFromWorkerCounts(
            countAssignmentsPerWorkerName(resolveAssignmentsForAlternative(sitePlan, idx)),
            (resolvePullsForAlternative(sitePlan, idx) || {}) as PlanningV2PullsMap,
          );
        }
      }
      if (counts) countsCache.set(cacheKey, counts);
      return counts;
    };

    const compatible: number[] = [];
    assignmentCountsByVariant.forEach((currentSiteCounts, idx) => {
      let ok = true;
      for (const w of workers) {
        if ((w.linkedSiteIds || []).length <= 1) continue;
        const workerName = String(w.name || "").trim();
        if (!workerName) continue;
        const maxShifts = Number((w as unknown as { max_shifts?: number }).max_shifts ?? w.maxShifts ?? 0);
        if (!Number.isFinite(maxShifts) || maxShifts <= 0) continue;
        let total = Number(currentSiteCounts.get(workerName) || 0);
        for (const linkedId of w.linkedSiteIds || []) {
          const sid = String(linkedId);
          if (sid === currentSiteId) continue;
          const linkedCounts = getCountsForSite(sid, idx);
          total += Number(linkedCounts?.get(workerName) || 0);
        }
        if (total > Math.trunc(maxShifts)) {
          ok = false;
          break;
        }
      }
      if (ok) compatible.push(idx);
    });
    return compatible;
  }, [assignmentCountsByVariant, workers, weekStart, siteId]);

  const filteredAlternativeIndices = useMemo(() => {
    if (!assignmentCountsByVariant.length) return [];
    const maxCompatibleSet = new Set<number>(maxShiftsCompatibleIndices);
    if (activeAssignmentCountFilters.length === 0) {
      return assignmentCountsByVariant.map((_, idx) => idx).filter((idx) => maxCompatibleSet.has(idx));
    }
    const linkedMemory = readLinkedPlansFromMemory(weekStart);
    const countsCache = new Map<string, Map<string, number>>();
    const getCountsForSite = (targetSiteId: string, idx: number) => {
      const cacheKey = `${targetSiteId}:${idx}`;
      if (countsCache.has(cacheKey)) return countsCache.get(cacheKey) || null;
      let counts: Map<string, number> | null = null;
      if (targetSiteId === String(siteId)) {
        counts = assignmentCountsByVariant[idx] || new Map<string, number>();
      } else {
        const sitePlan = linkedMemory?.plansBySite?.[targetSiteId];
        if (sitePlan) {
          counts = subtractPullExtrasFromWorkerCounts(
            countAssignmentsPerWorkerName(resolveAssignmentsForAlternative(sitePlan, idx)),
            (resolvePullsForAlternative(sitePlan, idx) || {}) as PlanningV2PullsMap,
          );
        }
      }
      if (counts) countsCache.set(cacheKey, counts);
      return counts;
    };
    return assignmentCountsByVariant
      .map((counts, idx) => ({ counts, idx }))
      .filter(({ idx }) => maxCompatibleSet.has(idx))
      .filter(({ counts, idx }) =>
        activeAssignmentCountFilters.every(([filterSiteId, workerName, target]) => {
          const targetCounts =
            filterSiteId === String(siteId) ? counts : getCountsForSite(filterSiteId, idx);
          return !!targetCounts && Number(targetCounts.get(workerName) || 0) === target;
        }),
      )
      .map((x) => x.idx);
  }, [assignmentCountsByVariant, activeAssignmentCountFilters, weekStart, siteId, maxShiftsCompatibleIndices]);

  const generatedAssignmentCountOptionsByWorker = useMemo(() => {
    const out = new Map<string, number[]>();
    const maxCompatibleSet = new Set<number>(maxShiftsCompatibleIndices);
    const linkedMemory = readLinkedPlansFromMemory(weekStart);
    const countsCache = new Map<string, Map<string, number>>();
    const getCountsForSite = (targetSiteId: string, idx: number) => {
      const cacheKey = `${targetSiteId}:${idx}`;
      if (countsCache.has(cacheKey)) return countsCache.get(cacheKey) || null;
      let counts: Map<string, number> | null = null;
      if (targetSiteId === String(siteId)) {
        counts = assignmentCountsByVariant[idx] || new Map<string, number>();
      } else {
        const sitePlan = linkedMemory?.plansBySite?.[targetSiteId];
        if (sitePlan) {
          counts = subtractPullExtrasFromWorkerCounts(
            countAssignmentsPerWorkerName(resolveAssignmentsForAlternative(sitePlan, idx)),
            (resolvePullsForAlternative(sitePlan, idx) || {}) as PlanningV2PullsMap,
          );
        }
      }
      if (counts) countsCache.set(cacheKey, counts);
      return counts;
    };

    for (const w of workers) {
      const workerName = String(w.name || "").trim();
      if (!workerName) continue;
      const values = new Set<number>();
      assignmentCountsByVariant.forEach((counts, idx) => {
        if (!maxCompatibleSet.has(idx)) return;
        const matchesOtherFilters = activeAssignmentCountFilters.every(([filterSiteId, filterWorkerName, target]) => {
          if (filterSiteId === String(siteId) && filterWorkerName === workerName) return true;
          const targetCounts =
            filterSiteId === String(siteId) ? counts : getCountsForSite(filterSiteId, idx);
          return !!targetCounts && Number(targetCounts.get(filterWorkerName) || 0) === target;
        });
        if (!matchesOtherFilters) return;
        values.add(Number(counts.get(workerName) || 0));
      });
      out.set(workerName, Array.from(values).sort((a, b) => a - b));
    }
    return out;
  }, [workers, assignmentCountsByVariant, activeAssignmentCountFilters, weekStart, siteId, maxShiftsCompatibleIndices]);

  const combinedFilteredAlternativeIndices = filteredAlternativeIndices;
  const hasCrossSiteAlternativeFilters = useMemo(
    () => activeAssignmentCountFilters.some(([sid]) => String(sid) !== String(siteId)),
    [activeAssignmentCountFilters, siteId],
  );

  /** Clé stable : évite useEffect qui se redéclenchent à chaque render à cause d’une nouvelle ref de tableau. */
  const filteredAlternativeIndicesKey = useMemo(
    () => combinedFilteredAlternativeIndices.join(","),
    [combinedFilteredAlternativeIndices],
  );

  function handleAssignmentCountFilterChange(workerName: string, rawValue: string, maxAllowed?: number) {
    const cleaned = String(rawValue || "").replace(/[^\d]/g, "");
    setAssignmentCountFilters((prev) => {
      const next = { ...prev };
      if (!cleaned) {
        delete next[workerName];
        persistLocalFilterForWorker(workerName, null);
      } else {
        const numeric = Number(cleaned);
        const bounded = Number.isFinite(maxAllowed) ? Math.min(numeric, Number(maxAllowed)) : numeric;
        next[workerName] = String(bounded);
        persistLocalFilterForWorker(workerName, Number(next[workerName]));
      }
      return next;
    });
  }

  function handleResetCurrentSiteFilters() {
    setAssignmentCountFilters({});
    setPersistedMultiSiteFilters((prev) => {
      const next: Record<string, Record<string, number>> = { ...prev };
      delete next[String(siteId)];
      try {
        localStorage.setItem(multiSiteFiltersStorageKey, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  // Ne pas auto-bascule d'alternative ici:
  // dans certains cas multi-sites, la liste filtrée peut évoluer rapidement
  // et provoquer un enchaînement 0->1->2->... non souhaité.
  // Le changement d'alternative doit rester piloté par l'utilisateur.

  /** Combinaison de filtres impossible → réinitialiser avant peinture pour éviter état bloquant. */
  useLayoutEffect(() => {
    if (!hasLocalAssignmentCountFilters) return;
    if (assignmentCountsByVariant.length <= 1) return;
    if (combinedFilteredAlternativeIndices.length !== 0) return;
    setAssignmentCountFilters({});
  }, [
    hasLocalAssignmentCountFilters,
    assignmentCountsByVariant.length,
    combinedFilteredAlternativeIndices.length,
  ]);

  const lastFilterNotifyKey = useRef<string>("");
  useEffect(() => {
    lastFilterNotifyKey.current = "";
  }, [alternativesEnabled]);

  useEffect(() => {
    if (!onFilteredAlternativesChange) return;
    if (!alternativesEnabled) {
      const notifyKey = "alternatives-locked|nofilter";
      if (notifyKey === lastFilterNotifyKey.current) return;
      lastFilterNotifyKey.current = notifyKey;
      onFilteredAlternativesChange({ indices: [], hasActiveFilters: false });
      return;
    }
    const notifyKey = `${filteredAlternativeIndicesKey}|${hasActiveAssignmentCountFilters ? 1 : 0}`;
    if (notifyKey === lastFilterNotifyKey.current) return;
    lastFilterNotifyKey.current = notifyKey;
    onFilteredAlternativesChange({
      indices: combinedFilteredAlternativeIndices,
      hasActiveFilters: hasActiveAssignmentCountFilters || hasCrossSiteAlternativeFilters,
    });
  }, [
    alternativesEnabled,
    onFilteredAlternativesChange,
    combinedFilteredAlternativeIndices,
    filteredAlternativeIndicesKey,
    hasActiveAssignmentCountFilters,
    hasCrossSiteAlternativeFilters,
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

  const visibleCountsWithPulls = useMemo(
    () => countVisibleAssignmentsWithPulls(assignments ?? {}, pulls ?? null),
    [assignments, pulls],
  );

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
        {assignmentCountsByVariant.length > 1 && hasLocalAssignmentCountFilters ? (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {combinedFilteredAlternativeIndices.length}/{assignmentCountsByVariant.length}
            </span>
            <button
              type="button"
              onClick={handleResetCurrentSiteFilters}
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
      {assignmentCountsByVariant.length > 1 && combinedFilteredAlternativeIndices.length === 0 ? (
        <div className="mb-2 text-sm text-amber-600 dark:text-amber-400">
          אין חלופות שתואמות את מספרי המשמרות שנבחרו.
        </div>
      ) : null}
      <div className="max-h-[24rem] overflow-y-auto overflow-x-auto [-webkit-overflow-scrolling:touch]">
        <table className="min-w-[280px] w-full border-collapse text-[10px] md:text-sm">
          <thead>
            <tr className="border-b dark:border-zinc-800">
              <th className="sticky top-0 z-20 min-w-[8rem] bg-white px-1 md:px-2 py-1 md:py-2 text-center shadow-[0_1px_0_0_rgb(228_228_231)] dark:bg-zinc-950 dark:shadow-[0_1px_0_0_rgb(39_39_42)]">
                עובד
              </th>
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
              let maxAllowed = allowedCounts[allowedCounts.length - 1] ?? c;
              const workerForRow = workersByName.get(String(nm || "").trim());
              if (showMultiSiteTotalColumn && workerForRow && (workerForRow.linkedSiteIds || []).length > 1) {
                const selectedOnOtherSites = activeAssignmentCountFilters.reduce((acc, [sid, workerName, target]) => {
                  if (String(sid) === String(siteId)) return acc;
                  if (String(workerName) !== String(nm)) return acc;
                  return acc + (Number.isFinite(target) ? Number(target) : 0);
                }, 0);
                const globalCap = Number(
                  (workerForRow as unknown as { max_shifts?: number }).max_shifts ?? workerForRow.maxShifts ?? 0,
                );
                if (Number.isFinite(globalCap) && globalCap > 0) {
                  maxAllowed = Math.max(minAllowed, Math.min(maxAllowed, globalCap - selectedOnOtherSites));
                }
              }
              const boundedAllowedCounts = allowedCounts.filter((v) => v >= minAllowed && v <= maxAllowed);
              const isManuallyModified = Object.prototype.hasOwnProperty.call(assignmentCountFilters, nm);
              const rawFilter =
                assignmentCountFilters[nm] !== undefined && String(assignmentCountFilters[nm]).trim() !== ""
                  ? Number(assignmentCountFilters[nm])
                  : c;
              const pickerValue = boundedAllowedCounts.includes(rawFilter)
                ? rawFilter
                : boundedAllowedCounts.reduce(
                    (best, x) => (Math.abs(x - rawFilter) < Math.abs(best - rawFilter) ? x : best),
                    boundedAllowedCounts[0] ?? Math.min(Math.max(rawFilter, minAllowed), maxAllowed),
                  );
              const filterSelectClass =
                "w-full max-w-[4.5rem] rounded-md border px-1.5 py-1 text-center text-[10px] outline-none md:max-w-[5.5rem] md:px-2 md:py-1 md:text-sm " +
                (isManuallyModified
                  ? "border-orange-400 bg-orange-50 text-orange-700 dark:border-orange-600 dark:bg-orange-950/30 dark:text-orange-300"
                  : "border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-950");
              const rowSummaryHighlight =
                !!highlightedWorkerName &&
                !!onHighlightWorkerToggle &&
                normHighlightName(nm) === normHighlightName(highlightedWorkerName);
              return (
              <tr key={nm} className="border-b last:border-0 dark:border-zinc-800">
                <td
                  className={
                    "px-1 md:px-2 py-1 md:py-2 text-center align-middle " +
                    (rowSummaryHighlight
                      ? "max-w-[min(92vw,42rem)] overflow-visible whitespace-nowrap "
                      : "w-32 max-w-[10rem] overflow-hidden md:w-64 md:max-w-[26rem] ") +
                    (onHighlightWorkerToggle
                      ? "cursor-pointer touch-manipulation rounded-md outline-none transition-[background-color,max-width] duration-200 focus-visible:ring-2 focus-visible:ring-[#00A8E0] "
                      : "") +
                    (rowSummaryHighlight
                      ? "bg-sky-50 ring-1 ring-[#00A8E0]/50 dark:bg-sky-950/40 dark:ring-[#00A8E0]/40 "
                      : "")
                  }
                  role={onHighlightWorkerToggle ? "button" : undefined}
                  tabIndex={onHighlightWorkerToggle ? 0 : undefined}
                  aria-pressed={rowSummaryHighlight ? true : undefined}
                  onClick={() => onHighlightWorkerToggle?.(nm)}
                  onKeyDown={(e) => {
                    if (!onHighlightWorkerToggle) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onHighlightWorkerToggle(nm);
                    }
                  }}
                >
                  <span className="inline-flex max-w-full justify-center">
                    <SummaryWorkerChip
                      name={nm}
                      nameColorMap={nameColorMap}
                      highlighted={rowSummaryHighlight}
                    />
                  </span>
                </td>
                <td className="px-1 md:px-2 py-1 md:py-2 w-16 md:w-28 whitespace-nowrap">
                  {assignmentCountsByVariant.length > 1 ? (
                        <NumberPicker
                      value={pickerValue}
                          onChange={(value) => handleAssignmentCountFilterChange(nm, String(value), maxAllowed)}
                          min={minAllowed}
                          max={maxAllowed}
                      allowedOptions={boundedAllowedCounts}
                          placeholder={String(c)}
                      disabled={!alternativesEnabled}
                      className={filterSelectClass}
                      inputAriaLabel={`מספר משמרות עבור ${nm}`}
                      title={
                        !alternativesEnabled
                          ? "יש ליצור תכנון לפני סינון חלופות"
                          : `אפשרויות: ${boundedAllowedCounts.join(", ")}`
                      }
                    />
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

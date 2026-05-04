"use client";

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { fetchMe } from "@/lib/auth";
import LoadingAnimation from "@/components/loading-animation";
import { PlanningV2Header } from "./planning-v2-header";
import { PlanningV2LayoutShell } from "./planning-v2-layout-shell";
import { PlanningV2MainPaper } from "./planning-v2-main-paper";
import { PlanningV2SitePaperHeader } from "./planning-v2-site-paper-header";
import { usePlanningV2SiteWorkers } from "./hooks/use-planning-v2-site-workers";
import { usePlanningV2WeekPlan } from "./hooks/use-planning-v2-week-plan";
import { PlanningV2AssignmentsSummary } from "./planning-v2-assignments-summary";
import { PlanningV2OptionalMessages } from "./planning-v2-optional-messages";
import { PlanningV2PlanExportButtons } from "./planning-v2-plan-export-buttons";
import { PlanningV2FullscreenVisualization } from "./planning-v2-fullscreen-visualization";
import { PlanningV2ActionBar } from "./planning-v2-action-bar";
import { PlanningV2StationWeekGrid } from "./stations/planning-v2-station-week-grid";
import { PlanningV2WeekNavigation } from "./planning-v2-week-navigation";
import { PlanningWorkersSection } from "./workers/planning-workers-section";
import { usePlanningV2LinkedSites } from "./hooks/use-planning-v2-linked-sites";
import { usePlanningV2PlanController } from "./hooks/use-planning-v2-plan-controller";
import { assignmentsNonEmpty } from "./lib/assignments-empty";
import { buildDistinctWorkerColorMap, workerNameChipColor } from "./lib/worker-name-chip-color";
import { analyzeManualSlotDrop, type ManualDropFlags } from "./lib/planning-v2-manual-full-drop";
import type { ManualDragSource } from "./lib/planning-v2-manual-drop";
import { PlanningV2ManualConfirmDialog } from "./planning-v2-manual-confirm-dialog";
import type { PlanningV2PullEntry, PlanningV2PullsMap, WorkerAvailability } from "./types";
import { EMPTY_WORKER_AVAILABILITY } from "./lib/constants";
import { getRequiredFor } from "./lib/station-grid-helpers";
import { getWeekKeyISO } from "./lib/week";
import { computeLinkedSiteHoleEntries } from "./lib/linked-site-holes";
import {
  readLinkedPlansFromMemory,
  resolveAssignmentsForAlternative,
  resolvePullsForAlternative,
  saveLinkedPlansToMemory,
  type LinkedSitePlan,
} from "./lib/multi-site-linked-memory";
import { clearAllPlanningSessionCaches } from "@/lib/planning-session-cache";
const MULTI_SITE_NAV_FLAG = "multi_site_navigation_in_app";

function normWorkerName(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

function planningV2PullEntryIsReal(e: PlanningV2PullEntry | undefined): boolean {
  return !!String(e?.before?.name || "").trim() && !!String(e?.after?.name || "").trim();
}

function truncateMobile6(value: unknown): string {
  const s = String(value ?? "");
  const chars = Array.from(s);
  return chars.length > 6 ? chars.slice(0, 4).join("") + "…" : s;
}

function isRtlName(value: string): boolean {
  return /[\u0590-\u05FF]/.test(String(value || ""));
}

function PlanningV2PageInner({ siteId }: { siteId: string }) {
  const {
    site,
    siteLoading,
    workers,
    workersLoading,
    reloadWorkers,
    reloadWeeklyAvailability,
    weekStart,
    workerRowsForTable,
  } = usePlanningV2SiteWorkers(siteId);

  const { plan: weekPlan, loading: weekPlanLoading, reloadWeekPlan } = usePlanningV2WeekPlan(siteId, weekStart);
  const { linkedSites, reloadLinkedSites } = usePlanningV2LinkedSites(siteId, weekStart);
  const weekPurgeSiteIds = useMemo(() => {
    const s = new Set<number>();
    const cur = Number(siteId);
    if (Number.isFinite(cur) && cur > 0) s.add(cur);
    for (const ls of linkedSites) {
      const n = Number(ls.id);
      if (Number.isFinite(n) && n > 0) s.add(n);
    }
    return Array.from(s).sort((a, b) => a - b);
  }, [siteId, linkedSites]);
  const router = useRouter();
  const [editingSaved, setEditingSaved] = useState(false);
  const [pullsModeStationIdx, setPullsModeStationIdx] = useState<number | null>(null);
  const [shiftHoursModeStationIdx, setShiftHoursModeStationIdx] = useState<number | null>(null);
  const [manualConfirm, setManualConfirm] = useState<{
    title: string;
    body: string;
    resolve: (v: boolean) => void;
  } | null>(null);
  const [manualDragWorkerName, setManualDragWorkerName] = useState<string | null>(null);
  const [showLinkedSitesRail, setShowLinkedSitesRail] = useState(false);
  const [availabilityOverlays, setAvailabilityOverlays] = useState<Record<string, Record<string, string[]>>>({});
  const [summaryFilterState, setSummaryFilterState] = useState<{
    indices: number[];
    hasActiveFilters: boolean;
  }>({ indices: [], hasActiveFilters: false });
  const [visualizationOpen, setVisualizationOpen] = useState(false);
  const [fullscreenReveal, setFullscreenReveal] = useState(false);
  const lastCurrentSiteMemorySyncRef = useRef("");
  /** Clic sur une ligne du סיכום שיבוצים → surbrillance de l’עובד dans le גריד. */
  const [summaryHighlightWorkerName, setSummaryHighlightWorkerName] = useState<string | null>(null);
  const [pullScopeDialog, setPullScopeDialog] = useState<{
    mode: "upsert" | "remove";
    kind?: "pull" | "guard_hours";
    resolve: (scope: "current_only" | "all_sites" | null) => void;
  } | null>(null);

  const plan = usePlanningV2PlanController({
    siteId,
    weekStart,
    weekPlan,
    site,
    weekPlanLoading,
    workers,
    workerRowsForTable,
    reloadWeekPlan,
    linkedSitesLength: linkedSites.length,
    weekPurgeSiteIds,
  });

  /** חלופות : après יצירת תכנון, grille remplie — afficher 1/1 + « עוד » même s’il n’y a qu’une seule variante (base). */
  const alternativesUiEnabled = useMemo(
    () =>
      plan.alternativesUnlocked &&
      !plan.isManual &&
      assignmentsNonEmpty(plan.displayAssignments) &&
      plan.alternativeCount >= 1,
    [plan.alternativesUnlocked, plan.isManual, plan.displayAssignments, plan.alternativeCount],
  );

  /** Recalculer la barre « אתרים מקושרים » quand sessionStorage (linked plans) change — le useMemo lit la mémoire sans que les autres deps bougent (ex. pendant SSE). */
  const [linkedPlansMemoryTick, setLinkedPlansMemoryTick] = useState(0);
  useEffect(() => {
    if (linkedSites.length <= 1) return;
    const bump = () => setLinkedPlansMemoryTick((n) => n + 1);
    window.addEventListener("linked-plans-memory-updated", bump as EventListener);
    return () => window.removeEventListener("linked-plans-memory-updated", bump as EventListener);
  }, [linkedSites.length]);

  const prevLinkedSitesLengthRef = useRef<number>(linkedSites.length);
  useEffect(() => {
    const prev = prevLinkedSitesLengthRef.current;
    if (prev <= 1 && linkedSites.length > 1) {
      setShowLinkedSitesRail(true);
      queueMicrotask(() => setLinkedPlansMemoryTick((n) => n + 1));
    }
    if (prev > 1 && linkedSites.length <= 1) {
      setShowLinkedSitesRail(false);
    }
    prevLinkedSitesLengthRef.current = linkedSites.length;
  }, [linkedSites.length]);

  // Fin de « session » onglet : fermeture / navigation pleine page — pas au démontage SPA
  // (changement site/semaine avec `key=` sinon on casse la barre multi-sites + drapeau in-app).
  useEffect(() => {
    const onPageHide = (e: PageTransitionEvent) => {
      if (e.persisted) return;
      clearAllPlanningSessionCaches();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  useEffect(() => {
    if (!visualizationOpen) {
      setFullscreenReveal(false);
      return;
    }
    const id = requestAnimationFrame(() => setFullscreenReveal(true));
    const prevOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setVisualizationOpen(false);
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(id);
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [visualizationOpen]);

  /** Plan « officiel » (מנהל / משותף) — pas une טיוטת auto seule (pas d’encadré vert / pas de blocage génération). */
  const isSavedMode =
    assignmentsNonEmpty(weekPlan?.assignments ?? null) &&
    (weekPlan?.sourceScope === "director" || weekPlan?.sourceScope === "shared");

  /** תגיות כמו ב-planning הישן (`weekPlanSaveBadgeKind` / `weekPlanSaveBadgeConfig`). */
  const weekPlanSaveBadgeKind = useMemo<null | "director" | "shared">(() => {
    if (editingSaved) return null;
    if (!assignmentsNonEmpty(weekPlan?.assignments ?? null)) return null;
    if (weekPlan?.sourceScope === "shared") return "shared";
    if (weekPlan?.sourceScope === "director") return "director";
    return null;
  }, [editingSaved, weekPlan?.assignments, weekPlan?.sourceScope]);

  const weekPlanSaveBadgeConfig = useMemo(() => {
    if (weekPlanSaveBadgeKind === "director") {
      return {
        label: "נשמר (מנהל)",
        className:
          "inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
      };
    }
    if (weekPlanSaveBadgeKind === "shared") {
      return {
        label: "נשמר ונשלח לעובדים",
        className:
          "inline-flex items-center rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-xs text-teal-800 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300",
      };
    }
    return null;
  }, [weekPlanSaveBadgeKind]);

  const showSavedPlanEditBadge =
    editingSaved && assignmentsNonEmpty(weekPlan?.assignments ?? null);

  const siteIsArchived = Boolean(site?.deletedAt);

  // Multi-site: en mode manuel on autorise l'édition directe du plan affiché (même issu d'une génération auto),
  // les confirmations de contraintes restent gérées par analyzeManualSlotDrop dans handleManualSlotDrop.
  const manualEditable =
    !siteIsArchived && plan.isManual && (!isSavedMode || editingSaved || linkedSites.length > 1);

  const handleResetStation = (stationIdx: number) => {
    plan.resetManualStation(stationIdx);
  };

  const waitManualConfirm = useCallback((title: string, body: string) => {
    return new Promise<boolean>((resolve) => {
      setManualConfirm({ title, body, resolve });
    });
  }, []);

  const availabilityByWorkerName = useMemo(() => {
    const o: Record<string, WorkerAvailability> = {};
    for (const r of workerRowsForTable) {
      const nm = String(r.name || "").trim();
      if (!nm) continue;
      const base = (r.availability || {}) as WorkerAvailability;
      const overlay = (availabilityOverlays[nm] || {}) as Record<string, string[]>;
      const merged: WorkerAvailability = { ...EMPTY_WORKER_AVAILABILITY };
      for (const d of ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const) {
        const next = new Set<string>([...(base[d] || []), ...(overlay[d] || [])]);
        merged[d] = Array.from(next);
      }
      if (Array.isArray(base._stations) && base._stations.length > 0) {
        merged._stations = [...base._stations];
      }
      o[nm] = merged;
    }
    return o;
  }, [workerRowsForTable, availabilityOverlays]);

  const assignmentHighlightBase = useMemo(() => plan.getLatestAssignmentBase(), [plan.displayAssignments, plan.getLatestAssignmentBase]);
  const workerColorMap = useMemo(() => {
    const bundles = [plan.displayAssignments, ...(plan.assignmentVariants || [])];
    return buildDistinctWorkerColorMap(workers, bundles);
  }, [workers, plan.displayAssignments, plan.assignmentVariants]);

  const linkedSiteHoleEntries = useMemo(
    () =>
      computeLinkedSiteHoleEntries({
        linkedSites,
        weekStart,
        currentSiteId: siteId,
        currentSite: site ?? null,
        currentAssignments: plan.displayAssignments,
        currentPulls: plan.displayPulls ?? null,
        alternativeIndex: plan.selectedAlternativeIndex,
      }),
    [
      linkedSites,
      weekStart,
      siteId,
      site,
      plan.displayAssignments,
      plan.displayPulls,
      plan.selectedAlternativeIndex,
    ],
  );

  const linkedSiteHolesById = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of linkedSiteHoleEntries) m.set(e.id, e.holesCount);
    return m;
  }, [linkedSiteHoleEntries]);

  const displayedAvailabilityOverlays = useMemo(() => {
    const base = plan.getLatestAssignmentBase();
    const cellHasWorker = (dayKey: string, shiftName: string, workerName: string): boolean => {
      const target = normWorkerName(workerName);
      if (!target) return false;
      const perStation = base?.[dayKey]?.[shiftName];
      return Array.isArray(perStation)
        ? perStation.some(
            (cell) =>
              Array.isArray(cell) &&
              cell.some((nm) => normWorkerName(String(nm || "")) === target),
          )
        : false;
    };
    const out: Record<string, Record<string, string[]>> = {};
    for (const [workerName, byDay] of Object.entries(availabilityOverlays || {})) {
      const nextByDay: Record<string, string[]> = {};
      for (const [dayKey, shifts] of Object.entries(byDay || {})) {
        const kept: string[] = [];
        for (const shiftName of shifts || []) {
          const exists = cellHasWorker(dayKey, shiftName, workerName);
          if (exists) kept.push(shiftName);
        }
        if (kept.length > 0) nextByDay[dayKey] = kept;
      }
      if (Object.keys(nextByDay).length > 0) out[workerName] = nextByDay;
    }
    return out;
  }, [availabilityOverlays, plan.displayAssignments, plan.getLatestAssignmentBase]);

  // Nettoyage auto des overlays rouges quand le worker n'est plus réellement sur le planning.
  useEffect(() => {
    const base = plan.getLatestAssignmentBase();
    const hasWorkerInAnyShift = (workerName: string): boolean => {
      const target = normWorkerName(workerName);
      if (!target) return false;
      for (const shiftsMap of Object.values(base || {})) {
        if (!shiftsMap || typeof shiftsMap !== "object") continue;
        for (const perStation of Object.values(shiftsMap)) {
          if (!Array.isArray(perStation)) continue;
          const found = perStation.some(
            (cell) =>
              Array.isArray(cell) &&
              cell.some((nm) => normWorkerName(String(nm || "")) === target),
          );
          if (found) return true;
        }
      }
      return false;
    };
    const hasWorkerInShift = (workerName: string, dayKey: string, shiftName: string): boolean => {
      const target = normWorkerName(workerName);
      if (!target) return false;
      const perStation = base?.[dayKey]?.[shiftName];
      return Array.isArray(perStation)
        ? perStation.some(
            (cell) =>
              Array.isArray(cell) &&
              cell.some((nm) => normWorkerName(String(nm || "")) === target),
          )
        : false;
    };
    setAvailabilityOverlays((prev) => {
      let changed = false;
      const next: Record<string, Record<string, string[]>> = {};
      for (const [workerName, byDay] of Object.entries(prev || {})) {
        if (!hasWorkerInAnyShift(workerName)) {
          changed = true;
          continue;
        }
        const cleanedByDay: Record<string, string[]> = {};
        for (const [dayKey, shifts] of Object.entries(byDay || {})) {
          const kept = (shifts || []).filter((shiftName) => hasWorkerInShift(workerName, dayKey, shiftName));
          if (kept.length > 0) cleanedByDay[dayKey] = kept;
          if (kept.length !== (shifts || []).length) changed = true;
        }
        if (Object.keys(cleanedByDay).length > 0) next[workerName] = cleanedByDay;
      }
      return changed ? next : prev;
    });
  }, [plan.displayAssignments, plan.getLatestAssignmentBase]);

  const isoWeek = useMemo(() => getWeekKeyISO(weekStart), [weekStart]);

  const navigateToLinkedSiteFromRail = useCallback(
    (targetId: number) => {
      try {
        sessionStorage.setItem(MULTI_SITE_NAV_FLAG, "1");
      } catch {
        /* ignore */
      }
      router.push(`/director/planning-v2/${targetId}?week=${encodeURIComponent(isoWeek)}`);
    },
    [router, isoWeek],
  );

  const handleManualSlotDrop = useCallback(
    async (p: {
      dayKey: string;
      shiftName: string;
      stationIndex: number;
      slotIndex: number;
      workerName: string;
      dragSource: ManualDragSource | null;
    }) => {
      let flags: ManualDropFlags = {};
      for (let guard = 0; guard < 12; guard++) {
        const base = plan.getLatestAssignmentBase();
        const r = analyzeManualSlotDrop({
          site,
          siteId,
          weekStart,
          workers,
          availabilityByWorkerName,
          base,
          dayKey: p.dayKey,
          shiftName: p.shiftName,
          stationIndex: p.stationIndex,
          slotIndex: p.slotIndex,
          workerName: p.workerName,
          dragSource: p.dragSource,
          flags,
          pulls: plan.displayPulls ?? null,
        });
        if (r.action === "block") {
          toast.error("לא ניתן לשבץ", { description: r.message });
          return;
        }
        if (r.action === "apply") {
          if (flags.forceAvailability) {
            const nm = String(p.workerName || "").trim();
            if (nm) {
              const canonicalName =
                workerRowsForTable.find((r) => normWorkerName(r.name) === normWorkerName(nm))?.name || nm;
              setAvailabilityOverlays((prev) => {
                const next = { ...prev };
                const byDay = { ...(next[canonicalName] || {}) } as Record<string, string[]>;
                const cur = new Set<string>([...(byDay[p.dayKey] || [])]);
                cur.add(p.shiftName);
                byDay[p.dayKey] = Array.from(cur);
                next[canonicalName] = byDay;
                return next;
              });
            }
          }
          let nextAssignments = r.next;
          // Garde-fou move: si drop depuis une cellule vers une autre, on vide explicitement la source.
          if (p.dragSource) {
            const src = p.dragSource;
            const sameCell =
              src.dayKey === p.dayKey &&
              src.shiftName === p.shiftName &&
              Number(src.stationIndex) === Number(p.stationIndex) &&
              Number(src.slotIndex) === Number(p.slotIndex);
            if (!sameCell) {
              const srcRow = nextAssignments?.[src.dayKey]?.[src.shiftName]?.[src.stationIndex];
              if (Array.isArray(srcRow)) {
                const srcNext = JSON.parse(JSON.stringify(nextAssignments)) as Record<
                  string,
                  Record<string, string[][]>
                >;
                const arr = Array.from(srcNext[src.dayKey]?.[src.shiftName]?.[src.stationIndex] || []);
                while (arr.length <= src.slotIndex) arr.push("");
                arr[src.slotIndex] = "";
                if (!srcNext[src.dayKey]) srcNext[src.dayKey] = {};
                if (!srcNext[src.dayKey][src.shiftName]) srcNext[src.dayKey][src.shiftName] = [];
                srcNext[src.dayKey][src.shiftName][src.stationIndex] = arr;
                nextAssignments = srcNext;
              }
            }
          }
          plan.commitDraftAssignments(nextAssignments);
          return;
        }
        if (r.action === "confirm_availability") {
          const ok = await waitManualConfirm(
            "זמינות",
            `לעובד "${r.workerName}" אין זמינות למשמרת זו. להקצות בכל זאת?`,
          );
          if (!ok) return;
          {
            const nm = String(r.workerName || "").trim();
            if (nm) {
              const canonicalName =
                workerRowsForTable.find((row) => normWorkerName(row.name) === normWorkerName(nm))?.name || nm;
              setAvailabilityOverlays((prev) => {
                const next = { ...prev };
                const byDay = { ...(next[canonicalName] || {}) } as Record<string, string[]>;
                const cur = new Set<string>([...(byDay[p.dayKey] || [])]);
                cur.add(p.shiftName);
                byDay[p.dayKey] = Array.from(cur);
                next[canonicalName] = byDay;
                return next;
              });
            }
          }
          flags = { ...flags, forceAvailability: true };
          continue;
        }
        if (r.action === "confirm_role") {
          const ok = await waitManualConfirm(
            "תפקיד",
            `לעובד "${r.workerName}" אין את התפקיד "${r.roleName}" בתא זה. להקצות בכל זאת?`,
          );
          if (!ok) return;
          flags = { ...flags, forceRole: true };
          continue;
        }
        if (r.action === "confirm_rules") {
          const ok = await waitManualConfirm(
            "שיבוץ חורג מהכללים",
            `שיבוץ עלול להפר חוקים:\n- ${r.lines.join("\n- ")}\n\nלהקצות בכל זאת?`,
          );
          if (!ok) return;
          flags = { ...flags, forceRules: true };
          continue;
        }
        if (r.action === "confirm_max_shifts") {
          const ok = await waitManualConfirm(
            "מקסימום משמרות",
            `השיבוץ יגיע ל-${r.total} משמרות השבוע, מעל המקסימום המוגדר לעובד (${r.maxShifts}). להקצות בכל זאת?`,
          );
          if (!ok) return;
          flags = { ...flags, forceMaxShifts: true };
          continue;
        }
      }
      toast.error("שגיאה", { description: "יותר מדי שלבי אישור — נסה שוב." });
    },
    [site, siteId, weekStart, workers, availabilityByWorkerName, plan, waitManualConfirm, workerRowsForTable],
  );

  const handleManualSlotDragOutside = useCallback(
    (dragSource: ManualDragSource) => {
      const src = dragSource;
      if (!src) return;
      const base = plan.getLatestAssignmentBase();
      const row = base[src.dayKey]?.[src.shiftName]?.[src.stationIndex];
      if (!Array.isArray(row)) return;
      const next = JSON.parse(JSON.stringify(base)) as Record<string, Record<string, string[][]>>;
      const srcArr = Array.from(next[src.dayKey]?.[src.shiftName]?.[src.stationIndex] || []);
      while (srcArr.length <= src.slotIndex) srcArr.push("");
      srcArr[src.slotIndex] = "";
      if (!next[src.dayKey]) next[src.dayKey] = {};
      if (!next[src.dayKey][src.shiftName]) next[src.dayKey][src.shiftName] = [];
      next[src.dayKey][src.shiftName][src.stationIndex] = srcArr;
      plan.commitDraftAssignments(next);
    },
    [plan],
  );

  const handleUpsertPull = useCallback(
    async (key: string, entry: PlanningV2PullEntry) => {
      const parts = String(key || "").split("|");
      if (parts.length < 4) return false;
      const dayKey = String(parts[0] || "");
      const shiftName = String(parts[1] || "");
      const stationIdx = Number(parts[2] || -1);
      if (!dayKey || !shiftName || !Number.isFinite(stationIdx) || stationIdx < 0) return false;
      const beforeName = String(entry?.before?.name || "").trim();
      const afterName = String(entry?.after?.name || "").trim();
      if (!beforeName || !afterName) return false;

      const nextPulls = JSON.parse(JSON.stringify((plan.displayPulls || {}) as PlanningV2PullsMap)) as PlanningV2PullsMap;
      const oldEntry = nextPulls[key];
      const cellPrefix = `${dayKey}|${shiftName}|${stationIdx}|`;
      const others = Object.entries(nextPulls)
        .filter(([k]) => String(k).startsWith(cellPrefix) && String(k) !== String(key))
        .map(([, e]) => e);
      const usedElsewhere = (nm: string) =>
        others.some((e) => String(e?.before?.name || "").trim() === nm || String(e?.after?.name || "").trim() === nm);

      const baseAssignments = plan.getLatestAssignmentBase();
      const currentCell = baseAssignments?.[dayKey]?.[shiftName]?.[stationIdx];
      let names = Array.isArray(currentCell)
        ? (currentCell as string[]).map((x) => String(x || "").trim()).filter(Boolean)
        : [];

      if (oldEntry) {
        const oldBefore = String(oldEntry?.before?.name || "").trim();
        const oldAfter = String(oldEntry?.after?.name || "").trim();
        const keep = new Set([beforeName, afterName]);
        if (oldBefore && !keep.has(oldBefore) && !usedElsewhere(oldBefore)) names = names.filter((x) => x !== oldBefore);
        if (oldAfter && !keep.has(oldAfter) && !usedElsewhere(oldAfter)) names = names.filter((x) => x !== oldAfter);
      }
      const toAdd = [beforeName, afterName].filter((x) => x && !names.includes(x));
      const nextNames = [...names, ...toAdd];

      const stCfg = (site?.config?.stations as unknown[] | undefined)?.[stationIdx];
      const required = getRequiredFor(stCfg as any, shiftName, dayKey);
      const maxNamesAllowed = Number(required || 0) + (oldEntry ? others.length + 1 : others.length + 1);
      if (nextNames.length > maxNamesAllowed) {
        toast.error("לא ניתן ליצור משיכות", { description: "אין מספיק מקום בעמדה" });
        return false;
      }

      const nextAssignments = JSON.parse(JSON.stringify(baseAssignments)) as Record<string, Record<string, string[][]>>;
      nextAssignments[dayKey] = nextAssignments[dayKey] || {};
      nextAssignments[dayKey][shiftName] = Array.isArray(nextAssignments[dayKey][shiftName])
        ? nextAssignments[dayKey][shiftName]
        : [];
      while (nextAssignments[dayKey][shiftName].length <= stationIdx) nextAssignments[dayKey][shiftName].push([]);
      nextAssignments[dayKey][shiftName][stationIdx] = nextNames;
      const applyCurrentOnly = () => {
        nextPulls[key] = entry;
        plan.commitDraftAssignments(nextAssignments);
        plan.commitDraftPulls(nextPulls);
      };
      if (linkedSites.length <= 1) {
        applyCurrentOnly();
        return true;
      }
      const scope = await new Promise<"current_only" | "all_sites" | null>((resolve) => {
        setPullScopeDialog({ mode: "upsert", resolve });
      });
      if (!scope) return false;
      applyCurrentOnly();
      if (scope === "all_sites") {
        const mem = readLinkedPlansFromMemory(weekStart);
        if (mem?.plansBySite && Object.keys(mem.plansBySite).length > 0) {
          const activeIdx = Math.max(0, Number(mem.activeAltIndex || 0));
          const nextPlans: Record<string, LinkedSitePlan> = JSON.parse(JSON.stringify(mem.plansBySite));
          for (const sid of Object.keys(nextPlans)) {
            const planForSite = nextPlans[sid];
            if (!planForSite) continue;
            const curAssignments = (resolveAssignmentsForAlternative(planForSite, activeIdx) ||
              {}) as Record<string, Record<string, string[][]>>;
            const curPulls = (resolvePullsForAlternative(planForSite, activeIdx) || {}) as PlanningV2PullsMap;
            const asg = JSON.parse(JSON.stringify(curAssignments)) as Record<string, Record<string, string[][]>>;
            const pls = JSON.parse(JSON.stringify(curPulls)) as PlanningV2PullsMap;
            const row = asg?.[dayKey]?.[shiftName]?.[stationIdx];
            const names = Array.isArray(row) ? row.map((x) => String(x || "").trim()).filter(Boolean) : [];
            const toAddAll = [beforeName, afterName].filter((x) => x && !names.includes(x));
            const nextNamesAll = [...names, ...toAddAll];
            asg[dayKey] = asg[dayKey] || {};
            asg[dayKey][shiftName] = Array.isArray(asg[dayKey][shiftName]) ? asg[dayKey][shiftName] : [];
            while (asg[dayKey][shiftName].length <= stationIdx) asg[dayKey][shiftName].push([]);
            asg[dayKey][shiftName][stationIdx] = nextNamesAll;
            pls[key] = entry;
            if (activeIdx <= 0) {
              planForSite.assignments = asg;
              planForSite.pulls = pls;
            } else {
              const alts = Array.isArray(planForSite.alternatives) ? [...planForSite.alternatives] : [];
              const altPulls = Array.isArray(planForSite.alternative_pulls) ? [...planForSite.alternative_pulls] : [];
              while (alts.length < activeIdx) alts.push(planForSite.assignments || {});
              while (altPulls.length < activeIdx) altPulls.push((planForSite.pulls || {}) as Record<string, unknown>);
              alts[activeIdx - 1] = asg;
              altPulls[activeIdx - 1] = pls as Record<string, unknown>;
              planForSite.alternatives = alts;
              planForSite.alternative_pulls = altPulls;
            }
          }
          saveLinkedPlansToMemory(weekStart, nextPlans, activeIdx);
        }
      }
      return true;
    },
    [plan, site, linkedSites.length, weekStart],
  );

  const handleRemovePull = useCallback(
    async (key: string) => {
      const parts = String(key || "").split("|");
      if (parts.length < 4) return false;
      const dayKey = String(parts[0] || "");
      const shiftName = String(parts[1] || "");
      const stationIdx = Number(parts[2] || -1);
      if (!dayKey || !shiftName || !Number.isFinite(stationIdx) || stationIdx < 0) return false;

      const nextPulls = JSON.parse(JSON.stringify((plan.displayPulls || {}) as PlanningV2PullsMap)) as PlanningV2PullsMap;
      const existing = nextPulls[key];
      if (!existing) return true;
      delete nextPulls[key];

      const cellPrefix = `${dayKey}|${shiftName}|${stationIdx}|`;
      const others = Object.entries(nextPulls)
        .filter(([k]) => String(k).startsWith(cellPrefix))
        .map(([, e]) => e);
      const keep = new Set<string>();
      others.forEach((e) => {
        const b = String(e?.before?.name || "").trim();
        const a = String(e?.after?.name || "").trim();
        if (b) keep.add(b);
        if (a) keep.add(a);
      });
      const removeNames = [
        String(existing?.before?.name || "").trim(),
        String(existing?.after?.name || "").trim(),
      ].filter(Boolean);

      const baseAssignments = plan.getLatestAssignmentBase();
      const currentCell = baseAssignments?.[dayKey]?.[shiftName]?.[stationIdx];
      const names = Array.isArray(currentCell)
        ? (currentCell as string[]).map((x) => String(x || "").trim()).filter(Boolean)
        : [];
      const nextNames = names.filter((nm) => !removeNames.includes(nm) || keep.has(nm));

      const nextAssignments = JSON.parse(JSON.stringify(baseAssignments)) as Record<string, Record<string, string[][]>>;
      nextAssignments[dayKey] = nextAssignments[dayKey] || {};
      nextAssignments[dayKey][shiftName] = Array.isArray(nextAssignments[dayKey][shiftName])
        ? nextAssignments[dayKey][shiftName]
        : [];
      while (nextAssignments[dayKey][shiftName].length <= stationIdx) nextAssignments[dayKey][shiftName].push([]);
      nextAssignments[dayKey][shiftName][stationIdx] = nextNames;

      const applyCurrentOnly = () => {
        plan.commitDraftAssignments(nextAssignments);
        plan.commitDraftPulls(nextPulls);
      };
      if (linkedSites.length <= 1) {
        applyCurrentOnly();
        return true;
      }
      const scope = await new Promise<"current_only" | "all_sites" | null>((resolve) => {
        setPullScopeDialog({ mode: "remove", resolve });
      });
      if (!scope) return false;
      applyCurrentOnly();
      if (scope === "all_sites") {
        const mem = readLinkedPlansFromMemory(weekStart);
        if (mem?.plansBySite && Object.keys(mem.plansBySite).length > 0) {
          const activeIdx = Math.max(0, Number(mem.activeAltIndex || 0));
          const nextPlans: Record<string, LinkedSitePlan> = JSON.parse(JSON.stringify(mem.plansBySite));
          for (const sid of Object.keys(nextPlans)) {
            const planForSite = nextPlans[sid];
            if (!planForSite) continue;
            const curAssignments = (resolveAssignmentsForAlternative(planForSite, activeIdx) ||
              {}) as Record<string, Record<string, string[][]>>;
            const curPulls = (resolvePullsForAlternative(planForSite, activeIdx) || {}) as PlanningV2PullsMap;
            const asg = JSON.parse(JSON.stringify(curAssignments)) as Record<string, Record<string, string[][]>>;
            const pls = JSON.parse(JSON.stringify(curPulls)) as PlanningV2PullsMap;
            const existingInSite = pls[key];
            if (!existingInSite) continue;
            delete pls[key];
            const othersSite = Object.entries(pls)
              .filter(([k]) => String(k).startsWith(cellPrefix))
              .map(([, e]) => e);
            const keepSite = new Set<string>();
            othersSite.forEach((e) => {
              const b = String(e?.before?.name || "").trim();
              const a = String(e?.after?.name || "").trim();
              if (b) keepSite.add(b);
              if (a) keepSite.add(a);
            });
            const removeNamesSite = [
              String(existingInSite?.before?.name || "").trim(),
              String(existingInSite?.after?.name || "").trim(),
            ].filter(Boolean);
            const row = asg?.[dayKey]?.[shiftName]?.[stationIdx];
            const namesSite = Array.isArray(row) ? row.map((x) => String(x || "").trim()).filter(Boolean) : [];
            const nextNamesSite = namesSite.filter((nm) => !removeNamesSite.includes(nm) || keepSite.has(nm));
            asg[dayKey] = asg[dayKey] || {};
            asg[dayKey][shiftName] = Array.isArray(asg[dayKey][shiftName]) ? asg[dayKey][shiftName] : [];
            while (asg[dayKey][shiftName].length <= stationIdx) asg[dayKey][shiftName].push([]);
            asg[dayKey][shiftName][stationIdx] = nextNamesSite;
            if (activeIdx <= 0) {
              planForSite.assignments = asg;
              planForSite.pulls = pls;
            } else {
              const alts = Array.isArray(planForSite.alternatives) ? [...planForSite.alternatives] : [];
              const altPulls = Array.isArray(planForSite.alternative_pulls) ? [...planForSite.alternative_pulls] : [];
              while (alts.length < activeIdx) alts.push(planForSite.assignments || {});
              while (altPulls.length < activeIdx) altPulls.push((planForSite.pulls || {}) as Record<string, unknown>);
              alts[activeIdx - 1] = asg;
              altPulls[activeIdx - 1] = pls as Record<string, unknown>;
              planForSite.alternatives = alts;
              planForSite.alternative_pulls = altPulls;
            }
          }
          saveLinkedPlansToMemory(weekStart, nextPlans, activeIdx);
        }
      }
      return true;
    },
    [plan, linkedSites.length, weekStart],
  );

  const handleUpsertGuardDisplay = useCallback(
    async (key: string, start: string, end: string) => {
      const parts = String(key || "").split("|");
      if (parts.length < 4) return false;
      const dayKey = String(parts[0] || "");
      const shiftName = String(parts[1] || "");
      const stationIdx = Number(parts[2] || -1);
      if (!dayKey || !shiftName || !Number.isFinite(stationIdx) || stationIdx < 0) return false;

      const nextPulls = JSON.parse(JSON.stringify((plan.displayPulls || {}) as PlanningV2PullsMap)) as PlanningV2PullsMap;
      const existing = nextPulls[key] || {};
      nextPulls[key] = {
        ...existing,
        guardDisplay: { start: String(start || "").trim(), end: String(end || "").trim() },
      };

      const applyCurrentOnly = () => {
        plan.commitDraftPulls(nextPulls);
      };

      if (linkedSites.length <= 1) {
        applyCurrentOnly();
        return true;
      }
      const scope = await new Promise<"current_only" | "all_sites" | null>((resolve) => {
        setPullScopeDialog({ mode: "upsert", kind: "guard_hours", resolve });
      });
      if (!scope) return false;
      applyCurrentOnly();
      if (scope === "all_sites") {
        const mem = readLinkedPlansFromMemory(weekStart);
        if (mem?.plansBySite && Object.keys(mem.plansBySite).length > 0) {
          const activeIdx = Math.max(0, Number(mem.activeAltIndex || 0));
          const nextPlans: Record<string, LinkedSitePlan> = JSON.parse(JSON.stringify(mem.plansBySite));
          for (const sid of Object.keys(nextPlans)) {
            const planForSite = nextPlans[sid];
            if (!planForSite) continue;
            const curPulls = (resolvePullsForAlternative(planForSite, activeIdx) || {}) as PlanningV2PullsMap;
            const pls = JSON.parse(JSON.stringify(curPulls)) as PlanningV2PullsMap;
            const ex = pls[key] || {};
            pls[key] = {
              ...ex,
              guardDisplay: { start: String(start || "").trim(), end: String(end || "").trim() },
            };
            if (activeIdx <= 0) {
              planForSite.pulls = pls;
            } else {
              const altPulls = Array.isArray(planForSite.alternative_pulls) ? [...planForSite.alternative_pulls] : [];
              while (altPulls.length < activeIdx) altPulls.push((planForSite.pulls || {}) as Record<string, unknown>);
              altPulls[activeIdx - 1] = pls as Record<string, unknown>;
              planForSite.alternative_pulls = altPulls;
            }
          }
          saveLinkedPlansToMemory(weekStart, nextPlans, activeIdx);
        }
      }
      return true;
    },
    [plan, linkedSites.length, weekStart],
  );

  const handleRemoveGuardDisplay = useCallback(
    async (key: string) => {
      const parts = String(key || "").split("|");
      if (parts.length < 4) return false;
      const dayKey = String(parts[0] || "");
      const shiftName = String(parts[1] || "");
      const stationIdx = Number(parts[2] || -1);
      if (!dayKey || !shiftName || !Number.isFinite(stationIdx) || stationIdx < 0) return false;

      const nextPulls = JSON.parse(JSON.stringify((plan.displayPulls || {}) as PlanningV2PullsMap)) as PlanningV2PullsMap;
      const existing = nextPulls[key];
      if (!existing?.guardDisplay) return true;

      const nextEntry: PlanningV2PullEntry = { ...existing };
      delete nextEntry.guardDisplay;
      if (planningV2PullEntryIsReal(nextEntry)) {
        nextPulls[key] = nextEntry;
      } else {
        delete nextPulls[key];
      }

      const applyCurrentOnly = () => {
        plan.commitDraftPulls(nextPulls);
      };

      if (linkedSites.length <= 1) {
        applyCurrentOnly();
        return true;
      }
      const scope = await new Promise<"current_only" | "all_sites" | null>((resolve) => {
        setPullScopeDialog({ mode: "remove", kind: "guard_hours", resolve });
      });
      if (!scope) return false;
      applyCurrentOnly();
      if (scope === "all_sites") {
        const mem = readLinkedPlansFromMemory(weekStart);
        if (mem?.plansBySite && Object.keys(mem.plansBySite).length > 0) {
          const activeIdx = Math.max(0, Number(mem.activeAltIndex || 0));
          const nextPlans: Record<string, LinkedSitePlan> = JSON.parse(JSON.stringify(mem.plansBySite));
          for (const sid of Object.keys(nextPlans)) {
            const planForSite = nextPlans[sid];
            if (!planForSite) continue;
            const curPulls = (resolvePullsForAlternative(planForSite, activeIdx) || {}) as PlanningV2PullsMap;
            const pls = JSON.parse(JSON.stringify(curPulls)) as PlanningV2PullsMap;
            const exIn = pls[key];
            if (!exIn?.guardDisplay) continue;
            const ne: PlanningV2PullEntry = { ...exIn };
            delete ne.guardDisplay;
            if (planningV2PullEntryIsReal(ne)) pls[key] = ne;
            else delete pls[key];
            if (activeIdx <= 0) {
              planForSite.pulls = pls;
            } else {
              const altPulls = Array.isArray(planForSite.alternative_pulls) ? [...planForSite.alternative_pulls] : [];
              while (altPulls.length < activeIdx) altPulls.push((planForSite.pulls || {}) as Record<string, unknown>);
              altPulls[activeIdx - 1] = pls as Record<string, unknown>;
              planForSite.alternative_pulls = altPulls;
            }
          }
          saveLinkedPlansToMemory(weekStart, nextPlans, activeIdx);
        }
      }
      return true;
    },
    [plan, linkedSites.length, weekStart],
  );

  const savedHighlight = useMemo(
    () =>
      assignmentsNonEmpty(weekPlan?.assignments ?? null) &&
      !editingSaved &&
      (weekPlan?.sourceScope === "director" || weekPlan?.sourceScope === "shared"),
    [weekPlan?.assignments, weekPlan?.sourceScope, editingSaved],
  );

  const visibleAlternativeIndices = useMemo(() => {
    if (!alternativesUiEnabled) {
      return [0];
    }
    if (!summaryFilterState.hasActiveFilters) {
      return Array.from({ length: Math.max(0, plan.alternativeCount) }, (_, i) => i);
    }
    return summaryFilterState.indices;
  }, [summaryFilterState, plan.alternativeCount, alternativesUiEnabled]);

  const selectedVisibleAlternativeIndex = useMemo(() => {
    return visibleAlternativeIndices.indexOf(plan.selectedAlternativeIndex);
  }, [visibleAlternativeIndices, plan.selectedAlternativeIndex]);

  /** Alternative réellement affichée après filtres (fallback robuste si l’index courant sort du sous-ensemble). */
  const effectiveAlternativeIndex = useMemo(() => {
    if (visibleAlternativeIndices.length <= 0) {
      return Math.max(0, plan.selectedAlternativeIndex);
    }
    if (visibleAlternativeIndices.includes(plan.selectedAlternativeIndex)) {
      return plan.selectedAlternativeIndex;
    }
    return visibleAlternativeIndices[0] ?? 0;
  }, [visibleAlternativeIndices, plan.selectedAlternativeIndex]);

  useEffect(() => {
    if (plan.generationRunning) return;
    if (!summaryFilterState.hasActiveFilters) return;
    if (effectiveAlternativeIndex === plan.selectedAlternativeIndex) return;
    plan.setSelectedAlternativeIndex(effectiveAlternativeIndex);
  }, [
    effectiveAlternativeIndex,
    plan.generationRunning,
    plan.selectedAlternativeIndex,
    plan.setSelectedAlternativeIndex,
    summaryFilterState.hasActiveFilters,
  ]);

  useEffect(() => {
    // En multi-site, `alternativesUiEnabled` peut passer brièvement à false pendant une
    // resynchronisation mémoire / affichage. Ne pas forcer un retour à l'alternative 0
    // sur cet état transitoire, sinon la navigation "saute" au début.
    if (linkedSites.length > 1) return;
    if (alternativesUiEnabled) return;
    if (plan.selectedAlternativeIndex !== 0) {
      plan.setSelectedAlternativeIndex(0);
    }
  }, [alternativesUiEnabled, linkedSites.length, plan.selectedAlternativeIndex, plan.setSelectedAlternativeIndex]);

  useEffect(() => {
    if (linkedSites.length <= 1) return;
    if (plan.generationRunning) return;
    const mem = readLinkedPlansFromMemory(weekStart);
    if (!mem?.plansBySite || Object.keys(mem.plansBySite).length === 0) return;
    const memoryActiveIdx = Math.max(0, Number(mem.activeAltIndex || 0));
    let inAppMultiSiteNavigation = false;
    try {
      inAppMultiSiteNavigation = sessionStorage.getItem(MULTI_SITE_NAV_FLAG) === "1";
    } catch {
      inAppMultiSiteNavigation = false;
    }
    const currentSiteKey = String(siteId);
    const nextPlans: Record<string, LinkedSitePlan> = JSON.parse(JSON.stringify(mem.plansBySite));
    const activeIdx = Math.max(0, Number(plan.selectedAlternativeIndex || 0));
    if (inAppMultiSiteNavigation && activeIdx !== memoryActiveIdx) {
      return;
    }
    if (inAppMultiSiteNavigation && activeIdx === memoryActiveIdx) {
      try {
        sessionStorage.removeItem(MULTI_SITE_NAV_FLAG);
      } catch {
        /* ignore */
      }
    }
    const displayedAssignments = plan.displayAssignments;
    const displayedPulls = (plan.displayPulls || {}) as PlanningV2PullsMap;
    if (!assignmentsNonEmpty(displayedAssignments ?? null)) return;
    const currentPlan = {
      ...(nextPlans[currentSiteKey] || {}),
    } as LinkedSitePlan;
    const nextDisplayedAssignments = JSON.parse(
      JSON.stringify(displayedAssignments),
    ) as Record<string, Record<string, string[][]>>;
    const nextDisplayedPulls = JSON.parse(
      JSON.stringify(displayedPulls),
    ) as PlanningV2PullsMap;
    const renderSnapshot = JSON.stringify({
      activeIdx,
      assignments: nextDisplayedAssignments,
      pulls: nextDisplayedPulls,
    });
    if (renderSnapshot === lastCurrentSiteMemorySyncRef.current) {
      return;
    }
    const existingAssignmentsForActiveIdx = resolveAssignmentsForAlternative(currentPlan, activeIdx) || null;
    const existingPullsForActiveIdx = (resolvePullsForAlternative(currentPlan, activeIdx) || {}) as PlanningV2PullsMap;
    const existingSnapshot = JSON.stringify({
      activeIdx,
      assignments: existingAssignmentsForActiveIdx || {},
      pulls: existingPullsForActiveIdx || {},
    });
    const nextSnapshot = JSON.stringify({
      activeIdx,
      assignments: nextDisplayedAssignments,
      pulls: nextDisplayedPulls,
    });
    if (existingSnapshot === nextSnapshot && memoryActiveIdx === activeIdx) {
      lastCurrentSiteMemorySyncRef.current = renderSnapshot;
      return;
    }
    if (activeIdx <= 0) {
      currentPlan.assignments = nextDisplayedAssignments;
      currentPlan.pulls = nextDisplayedPulls;
    } else {
      const alts = Array.isArray(currentPlan.alternatives) ? [...currentPlan.alternatives] : [];
      const altPulls = Array.isArray(currentPlan.alternative_pulls) ? [...currentPlan.alternative_pulls] : [];
      while (alts.length < activeIdx) {
        alts.push(
          JSON.parse(
            JSON.stringify(currentPlan.assignments || {}),
          ) as Record<string, Record<string, string[][]>>,
        );
      }
      while (altPulls.length < activeIdx) {
        altPulls.push(
          JSON.parse(JSON.stringify((currentPlan.pulls || {}) as Record<string, unknown>)) as Record<string, unknown>,
        );
      }
      alts[activeIdx - 1] = nextDisplayedAssignments;
      altPulls[activeIdx - 1] = nextDisplayedPulls as Record<string, unknown>;
      currentPlan.alternatives = alts;
      currentPlan.alternative_pulls = altPulls;
    }
    nextPlans[currentSiteKey] = currentPlan;
    lastCurrentSiteMemorySyncRef.current = renderSnapshot;
    saveLinkedPlansToMemory(weekStart, nextPlans, activeIdx);
  });

  const linkedSitesRailData = useMemo(() => {
    if (linkedSites.length <= 1) return [];
    const currentSiteIdNum = Number(siteId);
    const linkedById = new Map<number, string>();
    linkedSites.forEach((ls) => linkedById.set(Number(ls.id), String(ls.name || `אתר ${ls.id}`)));

    const otherSiteIds = [
      ...new Set(
        linkedSites
          .map((ls) => Number(ls.id))
          .filter((id) => Number.isFinite(id) && id > 0 && id !== currentSiteIdNum),
      ),
    ];
    if (otherSiteIds.length === 0) return [];

    const multiNames = new Set(
      workers
        .filter((w) => Array.isArray(w.linkedSiteIds) && w.linkedSiteIds.length > 1)
        .map((w) => String(w.name || "").trim())
        .filter(Boolean),
    );

    const mem = readLinkedPlansFromMemory(weekStart);
    const plansBySite =
      mem?.plansBySite && typeof mem.plansBySite === "object" ? mem.plansBySite : {};

    const rowsForSite = (
      sid: number,
    ): {
      rows: Array<{ dayKey: string; shiftName: string; stationLabel: string; workers: string[] }>;
      workerCounts: Array<{ workerName: string; count: number }>;
    } => {
      if (multiNames.size === 0) return { rows: [], workerCounts: [] };
      const sitePlan = plansBySite[String(sid)] as LinkedSitePlan | undefined;
      if (!sitePlan) return { rows: [], workerCounts: [] };
      const asg = resolveAssignmentsForAlternative(sitePlan, effectiveAlternativeIndex) || {};
      const rows: Array<{ dayKey: string; shiftName: string; stationLabel: string; workers: string[] }> = [];
      const workerCountsMap = new Map<string, number>();
      for (const [dayKey, shiftsMap] of Object.entries(asg)) {
        if (!shiftsMap || typeof shiftsMap !== "object") continue;
        for (const [shiftName, perStation] of Object.entries(shiftsMap)) {
          if (!Array.isArray(perStation)) continue;
          perStation.forEach((cell, stationIdx) => {
            if (!Array.isArray(cell)) return;
            const matched = cell
              .map((n) => String(n || "").trim())
              .filter((n) => n && multiNames.has(n));
            if (matched.length === 0) return;
            matched.forEach((nm) => workerCountsMap.set(nm, (workerCountsMap.get(nm) || 0) + 1));
            rows.push({
              dayKey,
              shiftName,
              stationLabel: `עמדה ${stationIdx + 1}`,
              workers: matched,
            });
          });
        }
      }
      const workerCounts = Array.from(workerCountsMap.entries())
        .map(([workerName, count]) => ({ workerName, count }))
        .sort((a, b) => {
          if (b.count !== a.count) return b.count - a.count;
          return a.workerName.localeCompare(b.workerName, "he");
        });
      return { rows, workerCounts };
    };

    const archivedById = new Map<number, boolean>();
    linkedSites.forEach((ls) => archivedById.set(Number(ls.id), !!ls.site_deleted));

    const out = otherSiteIds.map((sid) => {
      const siteRows = rowsForSite(sid);
      return {
      siteId: sid,
      siteName: linkedById.get(sid) || `אתר ${sid}`,
      siteDeleted: archivedById.get(sid) === true,
        rows: siteRows.rows,
        workerCounts: siteRows.workerCounts,
      };
    });
    return out.sort((a, b) => {
      const aa = a.siteDeleted ? 1 : 0;
      const bb = b.siteDeleted ? 1 : 0;
      if (aa !== bb) return aa - bb;
      return a.siteName.localeCompare(b.siteName, "he");
    });
  }, [
    linkedSites,
    weekStart,
    workers,
    siteId,
    effectiveAlternativeIndex,
    plan.alternativeCount,
    linkedPlansMemoryTick,
  ]);

  const linkedSiteRailBadges = useMemo(() => {
    const weekIso = getWeekKeyISO(weekStart);
    const ids = new Set<number>();
    const current = Number(siteId);
    if (Number.isFinite(current) && current > 0) ids.add(current);
    linkedSites.forEach((ls) => {
      const n = Number(ls.id);
      if (Number.isFinite(n) && n > 0) ids.add(n);
    });
    const linkedSiteIdsKey = Array.from(ids)
      .sort((a, b) => a - b)
      .join("-");
    const filterStorageKey = `planning_v2_multisite_assignment_filters_by_site_${weekIso}_${linkedSiteIdsKey}`;
    const savedBySiteId = new Map<number, boolean>();
    const filterCountBySiteId = new Map<number, number>();
    if (typeof window === "undefined") {
      return { savedBySiteId, filterCountBySiteId };
    }
    try {
      const hasSavedFromApiBySiteId = new Map<number, boolean>();
      linkedSites.forEach((ls) => {
        const sid = Number(ls.id);
        if (!Number.isFinite(sid) || sid <= 0) return;
        hasSavedFromApiBySiteId.set(sid, !!ls.has_saved_plan);
      });
      for (const ls of linkedSites) {
        const sid = Number(ls.id);
        if (!Number.isFinite(sid) || sid <= 0) continue;
        const localGeneric = !!localStorage.getItem(`plan_${sid}_${weekIso}`);
        const localDirector = !!localStorage.getItem(`plan_director_${sid}_${weekIso}`);
        const localShared = !!localStorage.getItem(`plan_shared_${sid}_${weekIso}`);
        const sessionGeneric = !!sessionStorage.getItem(`plan_${sid}_${weekIso}`);
        const sessionDirector = !!sessionStorage.getItem(`plan_director_${sid}_${weekIso}`);
        const sessionShared = !!sessionStorage.getItem(`plan_shared_${sid}_${weekIso}`);
        const currentSitePersistedFromApi =
          String(sid) === String(siteId) &&
          assignmentsNonEmpty(weekPlan?.assignments ?? null) &&
          (weekPlan?.sourceScope === "director" || weekPlan?.sourceScope === "shared");
        savedBySiteId.set(
          sid,
          !!hasSavedFromApiBySiteId.get(sid) ||
          localGeneric ||
            localDirector ||
            localShared ||
            sessionGeneric ||
            sessionDirector ||
            sessionShared ||
            currentSitePersistedFromApi,
        );
      }
    } catch {
      /* ignore */
    }
    try {
      const raw = localStorage.getItem(filterStorageKey);
      const parsed = raw ? (JSON.parse(raw) as Record<string, Record<string, unknown>>) : {};
      for (const ls of linkedSites) {
        const sid = String(ls.id);
        const byWorker = parsed?.[sid];
        if (!byWorker || typeof byWorker !== "object") {
          filterCountBySiteId.set(Number(ls.id), 0);
          continue;
        }
        const count = Object.values(byWorker).filter((v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 0;
        }).length;
        filterCountBySiteId.set(Number(ls.id), count);
      }
    } catch {
      linkedSites.forEach((ls) => filterCountBySiteId.set(Number(ls.id), 0));
    }
    return { savedBySiteId, filterCountBySiteId };
  }, [linkedSites, siteId, weekStart, summaryFilterState, weekPlan?.assignments, weekPlan?.sourceScope]);

  const refreshWorkersAndGrid = () => {
    void reloadWorkers();
    void reloadWeeklyAvailability();
    void reloadWeekPlan();
    void reloadLinkedSites();
    try {
      window.dispatchEvent(new CustomEvent("auto-planning-worker-changes-updated"));
    } catch {
      /* ignore */
    }
  };

  const handleSavePlan = async (publishToWorkers: boolean) => {
    await plan.savePlan(publishToWorkers);
    setEditingSaved(false);
  };
  const hasMultiWorkersThisWeek = useMemo(
    () => workers.some((w) => Array.isArray(w.linkedSiteIds) && w.linkedSiteIds.length > 1),
    [workers],
  );
  const hasLinkedSitesRail = linkedSites.length > 1 && hasMultiWorkersThisWeek;

  /** Pas de défilement de la page sous le panneau mobile « אתרים מקושרים » lorsqu’il est ouvert (< lg). */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 1023px)");
    const apply = () => {
      const lock = mq.matches && hasLinkedSitesRail && showLinkedSitesRail;
      document.body.style.overflow = lock ? "hidden" : "";
      document.documentElement.style.overflow = lock ? "hidden" : "";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
    };
  }, [hasLinkedSitesRail, showLinkedSitesRail]);

  /** Insets du rail mobile : bas de `#app-top-nav` → `top`, haut de la barre d’action → `bottom`. */
  useLayoutEffect(() => {
    const syncRailInsets = () => {
      const navEl = document.getElementById("app-top-nav");
      const barEl = document.getElementById("planning-v2-action-bar");

      let topPx = 0;
      if (navEl) {
        const cs = window.getComputedStyle(navEl);
        const nr = navEl.getBoundingClientRect();
        const navVisible =
          cs.display !== "none" && cs.visibility !== "hidden" && nr.height > 0.5 && nr.bottom > 0;
        topPx = navVisible ? Math.max(0, nr.bottom) : 0;
      }
      document.documentElement.style.setProperty("--planning-v2-rail-top-px", `${topPx}px`);

      if (barEl) {
        const br = barEl.getBoundingClientRect();
        document.documentElement.style.setProperty(
          "--planning-v2-action-bar-px",
          `${Math.max(0, window.innerHeight - br.top)}px`,
        );
      }
    };

    syncRailInsets();
    const ro = new ResizeObserver(() => requestAnimationFrame(syncRailInsets));
    const navEl = document.getElementById("app-top-nav");
    const barEl = document.getElementById("planning-v2-action-bar");
    if (navEl) ro.observe(navEl);
    if (barEl) ro.observe(barEl);
    window.addEventListener("resize", syncRailInsets);
    window.addEventListener("orientationchange", syncRailInsets);
    window.addEventListener("scroll", syncRailInsets, true);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", syncRailInsets);
    vv?.addEventListener("scroll", syncRailInsets);
    requestAnimationFrame(() => requestAnimationFrame(syncRailInsets));
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", syncRailInsets);
      window.removeEventListener("orientationchange", syncRailInsets);
      window.removeEventListener("scroll", syncRailInsets, true);
      vv?.removeEventListener("resize", syncRailInsets);
      vv?.removeEventListener("scroll", syncRailInsets);
      document.documentElement.style.removeProperty("--planning-v2-rail-top-px");
      document.documentElement.style.removeProperty("--planning-v2-action-bar-px");
    };
  }, []);

  const handleSummaryHighlightToggle = useCallback((name: string) => {
    setSummaryHighlightWorkerName((prev) => {
      const next = normWorkerName(prev || "") === normWorkerName(name) ? null : name;
      if (
        next !== null &&
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 1023px)").matches &&
        hasLinkedSitesRail
      ) {
        queueMicrotask(() => setShowLinkedSitesRail(false));
      }
      return next;
    });
  }, [hasLinkedSitesRail]);

  const renderPlanningVisualizationContent = useCallback(() => (
    <div className="space-y-4">
      <PlanningV2StationWeekGrid
        site={site}
        siteId={siteId}
        weekStart={weekStart}
        workers={workers}
        assignments={plan.displayAssignments}
        assignmentVariants={plan.assignmentVariants}
        assignmentHighlightBase={assignmentHighlightBase}
        pulls={plan.displayPulls}
        draftFixedAssignmentsSnapshot={plan.draftFixedAssignmentsSnapshot}
        isSavedMode={isSavedMode}
        editingSaved={editingSaved}
        loading={weekPlanLoading}
        isManual={plan.isManual}
        manualEditable={manualEditable}
        pullsModeStationIdx={pullsModeStationIdx}
        shiftHoursModeStationIdx={shiftHoursModeStationIdx}
        draggingWorkerName={manualDragWorkerName}
        onDraggingWorkerChange={setManualDragWorkerName}
        availabilityByWorkerName={availabilityByWorkerName}
        availabilityOverlays={displayedAvailabilityOverlays}
        onTogglePullsModeStation={(idx) => {
          setShiftHoursModeStationIdx(null);
          setPullsModeStationIdx((prev) => (prev === idx ? null : idx));
        }}
        onToggleShiftHoursModeStation={(idx) => {
          setPullsModeStationIdx(null);
          setShiftHoursModeStationIdx((prev) => (prev === idx ? null : idx));
        }}
        onUpsertGuardDisplay={handleUpsertGuardDisplay}
        onRemoveGuardDisplay={handleRemoveGuardDisplay}
        onResetStation={handleResetStation}
        onManualSlotDragOutside={handleManualSlotDragOutside}
        onManualSlotDrop={handleManualSlotDrop}
        onUpsertPull={handleUpsertPull}
        onRemovePull={handleRemovePull}
        summaryHighlightWorkerName={summaryHighlightWorkerName}
      />
      <PlanningV2AssignmentsSummary
        siteId={siteId}
        site={site}
        weekStart={weekStart}
        workers={workers}
        assignments={plan.displayAssignments}
        pulls={plan.displayPulls}
        assignmentVariants={plan.assignmentVariants}
        pullVariants={plan.pullVariants}
        alternativesEnabled={alternativesUiEnabled}
        selectedAlternativeIndex={effectiveAlternativeIndex}
        onSelectedAlternativeChange={plan.setSelectedAlternativeIndex}
        onFilteredAlternativesChange={setSummaryFilterState}
        loading={weekPlanLoading}
        generationRunning={plan.generationRunning}
        highlightedWorkerName={summaryHighlightWorkerName}
        onHighlightWorkerToggle={handleSummaryHighlightToggle}
      />
    </div>
  ), [
    assignmentHighlightBase,
    availabilityByWorkerName,
    displayedAvailabilityOverlays,
    editingSaved,
    effectiveAlternativeIndex,
    handleManualSlotDragOutside,
    handleManualSlotDrop,
    handleRemoveGuardDisplay,
    handleRemovePull,
    handleResetStation,
    handleSummaryHighlightToggle,
    handleUpsertGuardDisplay,
    handleUpsertPull,
    isSavedMode,
    manualDragWorkerName,
    manualEditable,
    plan.assignmentVariants,
    plan.displayAssignments,
    plan.displayPulls,
    plan.draftFixedAssignmentsSnapshot,
    plan.generationRunning,
    plan.isManual,
    plan.pullVariants,
    plan.setSelectedAlternativeIndex,
    pullsModeStationIdx,
    shiftHoursModeStationIdx,
    site,
    siteId,
    summaryHighlightWorkerName,
    weekPlanLoading,
    weekStart,
    workers,
    alternativesUiEnabled,
  ]);

  const renderLinkedSitesRailContent = () => (
    <div className="flex h-full min-h-0 w-full max-w-full flex-1 flex-col gap-3 overflow-hidden">
      <div className="shrink-0 border-b border-zinc-100 bg-white pb-2 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-base font-extrabold text-zinc-900 dark:text-zinc-100">אתרים מקושרים</div>
          <div className="flex flex-col items-end gap-0.5">
            {alternativesUiEnabled ? (
                <span className="rounded-md border border-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                חלופה מסוננת{" "}
                {Math.max(1, selectedVisibleAlternativeIndex >= 0 ? selectedVisibleAlternativeIndex + 1 : 1)}
                /{Math.max(1, visibleAlternativeIndices.length)}
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
                            חוסרים: {linkedSiteHolesById.has(siteBlock.siteId) ? linkedSiteHolesById.get(siteBlock.siteId) : "—"}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => navigateToLinkedSiteFromRail(siteBlock.siteId)}
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
                          <tr key={`${siteBlock.siteId}-${entry.workerName}`} className="border-b last:border-0 dark:border-zinc-800">
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
                        const dayOrder = ["sun", "sunday", "mon", "monday", "tue", "tuesday", "wed", "wednesday", "thu", "thursday", "fri", "friday", "sat", "saturday"];
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
                                    <td className="whitespace-nowrap px-1 py-2 align-middle text-zinc-400 dark:text-zinc-500">—</td>
                                    <td className="border border-dashed border-zinc-200 px-2 py-3 text-center text-[10px] leading-snug text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                                      אין עובדים רב-אתריים משובצים בחלופה זו.
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          );
                        }

                        const days = [...new Set(siteBlock.rows.map((r) => String(r.dayKey || "")))]
                          .sort((a, b) => {
                            const ia = dayOrder.indexOf(a.toLowerCase());
                            const ib = dayOrder.indexOf(b.toLowerCase());
                            if (ia >= 0 || ib >= 0) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
                            return a.localeCompare(b);
                          });
                        const shifts = [...new Set(siteBlock.rows.map((r) => String(r.shiftName || "")))]
                          .sort((a, b) => {
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
                                    <th key={`${siteBlock.siteId}-${d}`} className="px-1 py-1 text-center text-zinc-500 dark:text-zinc-400">
                                      {dayLabel[d.toLowerCase()] || d}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {shifts.map((s) => (
                                  <tr key={`${siteBlock.siteId}-${s}`} className="border-b last:border-0 dark:border-zinc-800">
                                    <td className="whitespace-nowrap px-1 py-1 font-medium text-zinc-700 dark:text-zinc-200">{s}</td>
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
                                                <div key={`${k}-${idx}`} className="rounded bg-zinc-50 px-1 py-0.5 dark:bg-zinc-900/50">
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

  return (
    <div
      className="min-h-screen overflow-x-hidden px-3 py-6 pb-56 sm:px-4 lg:px-4 md:pb-40 [&_button]:touch-manipulation [&_button]:select-none"
      dir="rtl"
    >
      <PlanningV2LayoutShell>
        <PlanningV2Header
          weekPlanSaveBadgeConfig={weekPlanSaveBadgeConfig}
          showEditBadge={showSavedPlanEditBadge}
        />
        {siteIsArchived ? (
          <div
            className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
            role="status"
          >
            <span className="font-medium">האתר נמחק מהרשימה הפעילה.</span> ניתן לצפות בתכנון ובהיסטוריה בלבד.{" "}
            <Link href="/director/sites" className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-50">
              חזרה לרשימת האתרים
            </Link>
          </div>
        ) : null}
        <div className="relative">
        <PlanningV2MainPaper editingSaved={editingSaved} savedHighlight={savedHighlight}>
          {hasLinkedSitesRail ? (
            <button
              type="button"
              onClick={() => {
                setShowLinkedSitesRail((v) => {
                  const next = !v;
                  if (next) {
                    queueMicrotask(() => setLinkedPlansMemoryTick((n) => n + 1));
                  }
                  return next;
                });
              }}
              className="fixed left-2 top-1/2 z-40 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-[#00A8E0] bg-white text-[#00A8E0] shadow-sm hover:bg-[#EAF8FF] dark:border-[#00A8E0] dark:bg-zinc-900 dark:text-[#00A8E0] dark:hover:bg-zinc-800 lg:hidden"
              aria-label={showLinkedSitesRail ? "הסתר תצוגת אתרים מקושרים" : "הצג תצוגת אתרים מקושרים"}
              title={showLinkedSitesRail ? "הסתר תצוגת אתרים מקושרים" : "הצג תצוגת אתרים מקושרים"}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                {showLinkedSitesRail ? (
                  <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                ) : (
                  <path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" />
                )}
              </svg>
            </button>
          ) : null}
          {hasLinkedSitesRail ? (
            <aside
              className={
                "fixed left-0 flex min-h-0 w-full max-w-full flex-col overflow-hidden rounded-r-2xl border-r border-zinc-200 bg-white px-3 pb-0 shadow-xl transition-transform duration-300 dark:border-zinc-800 dark:bg-zinc-950 lg:hidden " +
                (showLinkedSitesRail
                  ? "top-0 z-[35] h-[calc(100dvh-var(--planning-v2-action-bar-px))] pt-[max(0.75rem,env(safe-area-inset-top))] translate-x-0"
                  : "top-[var(--planning-v2-rail-top-px,4.5rem)] z-30 bottom-[var(--planning-v2-action-bar-px)] pt-3 -translate-x-[102%] pointer-events-none")
              }
            >
              {renderLinkedSitesRailContent()}
            </aside>
          ) : null}
          <PlanningV2SitePaperHeader
            siteId={siteId}
            site={site}
            siteLoading={siteLoading}
            readOnly={siteIsArchived}
          />
          <Suspense
            fallback={
              <div className="mb-4 h-10 w-full animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" aria-hidden />
            }
          >
            <PlanningV2WeekNavigation siteId={siteId} weekStart={weekStart} />
          </Suspense>
          <PlanningWorkersSection
            siteId={siteId}
            site={site}
            weekStart={weekStart}
            workers={workers}
            rows={workerRowsForTable}
            availabilityOverlays={availabilityOverlays}
            workersLoading={workersLoading}
            onWorkersChanged={refreshWorkersAndGrid}
            workersNameDraggable={
              manualEditable && pullsModeStationIdx === null && shiftHoursModeStationIdx === null
            }
            onWorkerNameDragPreview={setManualDragWorkerName}
            readOnly={siteIsArchived}
          />
          {!visualizationOpen ? renderPlanningVisualizationContent() : null}
          <PlanningV2OptionalMessages siteId={siteId} weekStart={weekStart} readOnly={siteIsArchived} />
          <PlanningV2PlanExportButtons
            siteId={siteId}
            site={site}
            weekStart={weekStart}
            workers={workers}
            assignments={plan.displayAssignments}
            pulls={plan.displayPulls}
            assignmentVariants={plan.assignmentVariants}
            onOpenVisualization={() => setVisualizationOpen(true)}
          />
        </PlanningV2MainPaper>
        {hasLinkedSitesRail ? (
          <aside className="hidden lg:absolute lg:right-[calc(100%+1rem)] lg:top-0 lg:flex lg:h-[calc(100dvh-var(--planning-v2-rail-top-px)-var(--planning-v2-action-bar-px)-0.75rem)] lg:min-h-0 lg:w-[20rem] lg:flex-col lg:overflow-hidden lg:rounded-2xl lg:border lg:border-zinc-200 lg:bg-white lg:p-3 lg:shadow-sm dark:lg:border-zinc-800 dark:lg:bg-zinc-950">
            {renderLinkedSitesRailContent()}
          </aside>
        ) : null}
        </div>
        <PlanningV2ActionBar
          siteId={siteId}
          weekStart={weekStart}
          weekPlan={weekPlan}
          effectiveAssignments={plan.displayAssignments}
          linkedSites={linkedSites}
          readOnly={siteIsArchived}
          editingSaved={editingSaved}
          onEditingSavedChange={setEditingSaved}
          onCancelSavedEdit={async () => {
            setPullsModeStationIdx(null);
            setShiftHoursModeStationIdx(null);
            await plan.cancelSavedEditing();
          }}
          reloadWeekPlan={reloadWeekPlan}
          generationRunning={plan.generationRunning}
          onRequestGenerate={plan.startGeneration}
          onStopGeneration={plan.stopGeneration}
          autoPullsLimit={plan.autoPullsLimit}
          onAutoPullsLimitChange={plan.setAutoPullsLimit}
          autoPullsEnabled={plan.autoPullsEnabled}
          isManual={plan.isManual}
          onIsManualChange={(next) => {
            plan.setIsManual(next);
            if (!next) {
              setPullsModeStationIdx(null);
              setShiftHoursModeStationIdx(null);
            }
          }}
          onEnterManualWithGridReset={plan.enterManualWithGridReset}
          onSavePlan={handleSavePlan}
          onDraftClear={plan.clearDraft}
          draftActive={plan.draftActive}
          alternativeCount={visibleAlternativeIndices.length}
          selectedAlternativeIndex={Math.max(0, selectedVisibleAlternativeIndex)}
          selectedAlternativeDisplayIndex={effectiveAlternativeIndex}
          onRequestMoreAlternatives={plan.startMoreAlternatives}
          moreAlternativesAvailable={plan.moreAlternativesAvailable}
          alternativesEnabled={alternativesUiEnabled}
          alternativesFiltered={summaryFilterState.hasActiveFilters}
          alternativesTotalCount={plan.alternativeCount}
          onSelectedAlternativeChange={(visibleIndex) => {
            const target = visibleAlternativeIndices[visibleIndex];
            if (typeof target !== "number") return;
            plan.setSelectedAlternativeIndex(target);
          }}
        />
      </PlanningV2LayoutShell>
      {siteLoading || workersLoading || weekPlanLoading ? (
        <div className="fixed inset-0 z-50 flex h-[100lvh] min-h-[100lvh] w-screen items-center justify-center overflow-x-hidden overscroll-none bg-white/70 backdrop-blur-md md:h-screen-mobile md:min-h-screen-mobile dark:bg-zinc-950/70 dark:backdrop-blur-md">
          <LoadingAnimation size={96} />
        </div>
      ) : null}
      {visualizationOpen ? (
        <div
          className={
            "fixed inset-0 z-[80] overflow-hidden bg-zinc-950/40 backdrop-blur-[2px] transition-opacity duration-300 ease-out motion-reduce:transition-none dark:bg-black/60 " +
            (fullscreenReveal ? "opacity-100" : "opacity-0")
          }
          aria-modal="true"
          role="dialog"
          aria-labelledby="planning-v2-fs-title"
        >
          <div
            className={
              "flex h-full flex-col overflow-hidden bg-[#fafafa] transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none dark:bg-zinc-950 " +
              (fullscreenReveal ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0")
            }
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 md:px-6">
              <div className="min-w-0">
                <div id="planning-v2-fs-title" className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                  תצוגת מסך מלא
                </div>
                <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                  כמו קובץ ה-HTML מייצוא CSV — גריד צבעוני וסיכום משמרות
                </div>
              </div>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 shadow-sm hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                onClick={() => setVisualizationOpen(false)}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
                סגור
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-3 py-4 md:px-6">
              <div className="mx-auto flex h-full min-h-0 w-full max-w-[1800px] flex-col">
                <PlanningV2FullscreenVisualization
                  siteId={siteId}
                  site={site}
                  weekStart={weekStart}
                  workers={workers}
                  assignments={plan.displayAssignments}
                  pulls={plan.displayPulls}
                  assignmentVariants={plan.assignmentVariants}
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <PlanningV2ManualConfirmDialog
        open={!!manualConfirm}
        title={manualConfirm?.title ?? ""}
        body={manualConfirm?.body ?? ""}
        onConfirm={() => {
          const r = manualConfirm?.resolve;
          setManualConfirm(null);
          r?.(true);
        }}
        onCancel={() => {
          const r = manualConfirm?.resolve;
          setManualConfirm(null);
          r?.(false);
        }}
      />
      {pullScopeDialog ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
            <div className="text-base font-semibold">
              {pullScopeDialog.kind === "guard_hours"
                ? "שינוי שעות באתרים מקושרים"
                : "משיכות באתרים מקושרים"}
            </div>
            <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              {pullScopeDialog.kind === "guard_hours"
                ? pullScopeDialog.mode === "remove"
                  ? "באיזה היקף למחוק את שינוי השעות?"
                  : "באיזה היקף לשמור את שינוי השעות?"
                : pullScopeDialog.mode === "remove"
                ? "באיזה היקף למחוק את המשיכה?"
                : "באיזה היקף לשמור את המשיכה?"}
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => {
                  pullScopeDialog.resolve(null);
                  setPullScopeDialog(null);
                }}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => {
                  pullScopeDialog.resolve("current_only");
                  setPullScopeDialog(null);
                }}
              >
                לאתר הזה בלבד
              </button>
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-3 py-2 text-sm text-white hover:bg-[#0092c6]"
                onClick={() => {
                  pullScopeDialog.resolve("all_sites");
                  setPullScopeDialog(null);
                }}
              >
                לכל האתרים המקושרים
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PlanningV2Page() {
  const router = useRouter();
  const params = useParams();
  const siteId = params?.id != null ? String(params.id) : "";

  useEffect(() => {
    fetchMe().then((me) => {
      if (!me) return router.replace("/login/director");
      if (me.role !== "director") return router.replace("/worker");
    });
  }, [router]);

  if (!siteId) {
    return (
      <div className="min-h-screen bg-zinc-50 p-6 dark:bg-zinc-950" dir="rtl">
        <div className="mx-auto max-w-lg rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="mb-4 text-zinc-800 dark:text-zinc-100">לא נמצא מזהה אתר בכתובת.</p>
          <Link
            href="/director"
            className="inline-flex rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            חזרה לדף המנהל
          </Link>
        </div>
      </div>
    );
  }

  return <PlanningWeekShell siteId={siteId} />;
}

/** מפתח URL (?week=) + אתר — איפוס מצב עריכה בעת החלפת שבוע בלי useEffect. */
function PlanningWeekShell({ siteId }: { siteId: string }) {
  const searchParams = useSearchParams();
  const weekQ = searchParams.get("week") || "default";
  return <PlanningV2PageInner key={`${siteId}-${weekQ}`} siteId={siteId} />;
}

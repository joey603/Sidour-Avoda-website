"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
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
import { PlanningV2ActionBar } from "./planning-v2-action-bar";
import { PlanningV2StationWeekGrid } from "./stations/planning-v2-station-week-grid";
import { PlanningV2WeekNavigation } from "./planning-v2-week-navigation";
import { PlanningWorkersSection } from "./workers/planning-workers-section";
import { usePlanningV2LinkedSites } from "./hooks/use-planning-v2-linked-sites";
import { usePlanningV2PlanController } from "./hooks/use-planning-v2-plan-controller";
import { assignmentsNonEmpty } from "./lib/assignments-empty";
import { buildWorkerNameColorMap, workerNameChipColor } from "./lib/worker-name-chip-color";
import { analyzeManualSlotDrop, type ManualDropFlags } from "./lib/planning-v2-manual-full-drop";
import type { ManualDragSource } from "./lib/planning-v2-manual-drop";
import { PlanningV2ManualConfirmDialog } from "./planning-v2-manual-confirm-dialog";
import type { PlanningV2PullEntry, PlanningV2PullsMap } from "./types";
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
  const { linkedSites } = usePlanningV2LinkedSites(siteId, weekStart);
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
  const [manualConfirm, setManualConfirm] = useState<{
    title: string;
    body: string;
    resolve: (v: boolean) => void;
  } | null>(null);
  const [manualDragWorkerName, setManualDragWorkerName] = useState<string | null>(null);
  const [showLinkedSitesRail, setShowLinkedSitesRail] = useState(false);
  const [summaryFilterState, setSummaryFilterState] = useState<{
    indices: number[];
    hasActiveFilters: boolean;
  }>({ indices: [], hasActiveFilters: false });
  const [pullScopeDialog, setPullScopeDialog] = useState<{
    mode: "upsert" | "remove";
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

  /** Recalculer la barre « אתרים מקושרים » quand sessionStorage (linked plans) change — le useMemo lit la mémoire sans que les autres deps bougent (ex. pendant SSE). */
  const [linkedPlansMemoryTick, setLinkedPlansMemoryTick] = useState(0);
  useEffect(() => {
    if (linkedSites.length <= 1) return;
    const bump = () => setLinkedPlansMemoryTick((n) => n + 1);
    window.addEventListener("linked-plans-memory-updated", bump as EventListener);
    return () => window.removeEventListener("linked-plans-memory-updated", bump as EventListener);
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

  /** Plan « officiel » (מנהל / משותף) — pas une טיוטת auto seule (pas d’encadré vert / pas de blocage génération). */
  const isSavedMode =
    assignmentsNonEmpty(weekPlan?.assignments ?? null) &&
    (weekPlan?.sourceScope === "director" || weekPlan?.sourceScope === "shared");
  // Multi-site: en mode manuel on autorise l'édition directe du plan affiché (même issu d'une génération auto),
  // les confirmations de contraintes restent gérées par analyzeManualSlotDrop dans handleManualSlotDrop.
  const manualEditable = plan.isManual && (!isSavedMode || editingSaved || linkedSites.length > 1);

  const handleResetStation = (stationIdx: number) => {
    plan.resetManualStation(stationIdx);
    setPullsModeStationIdx((p) => (p === stationIdx ? null : p));
  };

  const waitManualConfirm = useCallback((title: string, body: string) => {
    return new Promise<boolean>((resolve) => {
      setManualConfirm({ title, body, resolve });
    });
  }, []);

  const availabilityByWorkerName = useMemo(() => {
    const o: Record<string, Record<string, string[]>> = {};
    for (const r of workerRowsForTable) {
      const nm = String(r.name || "").trim();
      if (nm) o[nm] = r.availability || {};
    }
    return o;
  }, [workerRowsForTable]);

  const assignmentHighlightBase = useMemo(() => plan.getLatestAssignmentBase(), [plan.displayAssignments, plan.getLatestAssignmentBase]);
  const workerColorMap = useMemo(() => {
    const names = workers.map((w) => String(w.name || "").trim()).filter(Boolean);
    return buildWorkerNameColorMap(names);
  }, [workers]);

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
        });
        if (r.action === "block") {
          toast.error("לא ניתן לשבץ", { description: r.message });
          return;
        }
        if (r.action === "apply") {
          plan.commitDraftAssignments(r.next);
          return;
        }
        if (r.action === "confirm_availability") {
          const ok = await waitManualConfirm(
            "זמינות",
            `לעובד "${r.workerName}" אין זמינות למשמרת זו. להקצות בכל זאת?`,
          );
          if (!ok) return;
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
      }
      toast.error("שגיאה", { description: "יותר מדי שלבי אישור — נסה שוב." });
    },
    [site, siteId, weekStart, workers, availabilityByWorkerName, plan, waitManualConfirm],
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

  const savedHighlight = useMemo(
    () =>
      assignmentsNonEmpty(weekPlan?.assignments ?? null) &&
      !editingSaved &&
      (weekPlan?.sourceScope === "director" || weekPlan?.sourceScope === "shared"),
    [weekPlan?.assignments, weekPlan?.sourceScope, editingSaved],
  );

  const visibleAlternativeIndices = useMemo(() => {
    if (!summaryFilterState.hasActiveFilters) {
      return Array.from({ length: Math.max(0, plan.alternativeCount) }, (_, i) => i);
    }
    return summaryFilterState.indices;
  }, [summaryFilterState, plan.alternativeCount]);

  const selectedVisibleAlternativeIndex = useMemo(() => {
    return visibleAlternativeIndices.indexOf(plan.selectedAlternativeIndex);
  }, [visibleAlternativeIndices, plan.selectedAlternativeIndex]);

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

    const rowsForSite = (sid: number): Array<{ dayKey: string; shiftName: string; stationLabel: string; workers: string[] }> => {
      if (multiNames.size === 0) return [];
      const sitePlan = plansBySite[String(sid)] as LinkedSitePlan | undefined;
      if (!sitePlan) return [];
      const asg = resolveAssignmentsForAlternative(sitePlan, plan.selectedAlternativeIndex) || {};
      const rows: Array<{ dayKey: string; shiftName: string; stationLabel: string; workers: string[] }> = [];
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
            rows.push({
              dayKey,
              shiftName,
              stationLabel: `עמדה ${stationIdx + 1}`,
              workers: matched,
            });
          });
        }
      }
      return rows;
    };

    const out = otherSiteIds.map((sid) => ({
      siteId: sid,
      siteName: linkedById.get(sid) || `אתר ${sid}`,
      rows: rowsForSite(sid),
    }));
    return out.sort((a, b) => a.siteName.localeCompare(b.siteName));
  }, [
    linkedSites,
    weekStart,
    workers,
    siteId,
    plan.selectedAlternativeIndex,
    plan.alternativeCount,
    linkedPlansMemoryTick,
  ]);

  const refreshWorkersAndGrid = () => {
    void reloadWorkers();
    void reloadWeeklyAvailability();
    void reloadWeekPlan();
  };

  const handleSavePlan = async (publishToWorkers: boolean) => {
    await plan.savePlan(publishToWorkers);
    setEditingSaved(false);
  };

  return (
    <div
      className="min-h-screen px-3 py-6 pb-56 sm:px-4 lg:px-4 md:pb-40 [&_button]:touch-manipulation [&_button]:select-none"
      dir="rtl"
    >
      <PlanningV2LayoutShell>
        <PlanningV2Header siteId={siteId} />
        <PlanningV2MainPaper editingSaved={editingSaved} savedHighlight={savedHighlight}>
          {linkedSites.length > 1 ? (
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
              className="absolute -left-3 top-24 z-30 inline-flex h-9 w-9 items-center justify-center rounded-full border border-zinc-300 bg-white shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
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
          {linkedSites.length > 1 ? (
            <aside
              className={
                "absolute left-0 top-0 z-20 h-full w-[20rem] max-w-[85vw] rounded-l-2xl border-r border-zinc-200 bg-white/95 p-3 shadow-xl backdrop-blur-sm transition-transform duration-300 dark:border-zinc-800 dark:bg-zinc-950/95 " +
                (showLinkedSitesRail ? "translate-x-0" : "-translate-x-[102%]")
              }
            >
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">אתרים מקושרים</div>
                <span className="rounded-md border border-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                  חלופה {plan.selectedAlternativeIndex + 1}
                </span>
              </div>
              <div className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                מוצגים רק עובדים רב-אתריים בעמדות של החלופה הנוכחית.
              </div>
              <div className="max-h-[calc(100%-3.5rem)] space-y-2 overflow-y-auto pr-1">
                {linkedSitesRailData.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-zinc-300 p-2 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                    אין אתרים מקושרים נוספים להצגה.
                  </div>
                ) : (
                  linkedSitesRailData.map((siteBlock) => (
                    <div key={siteBlock.siteId} className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{siteBlock.siteName}</div>
                          <div className="mt-0.5 text-[10px] text-orange-600 dark:text-orange-400">
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
                                                          className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px]"
                                                          style={{
                                                            backgroundColor: col.bg,
                                                            borderColor: col.border,
                                                            color: col.text,
                                                          }}
                                                        >
                                                          {nm}
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
            </aside>
          ) : null}
          <PlanningV2SitePaperHeader siteId={siteId} site={site} siteLoading={siteLoading} />
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
            workersLoading={workersLoading}
            onWorkersChanged={refreshWorkersAndGrid}
            workersNameDraggable={manualEditable && pullsModeStationIdx === null}
            onWorkerNameDragPreview={setManualDragWorkerName}
          />
          <PlanningV2StationWeekGrid
            site={site}
            siteId={siteId}
            weekStart={weekStart}
            workers={workers}
            assignments={plan.displayAssignments}
            assignmentHighlightBase={assignmentHighlightBase}
            pulls={plan.displayPulls}
            draftFixedAssignmentsSnapshot={plan.draftFixedAssignmentsSnapshot}
            isSavedMode={isSavedMode}
            editingSaved={editingSaved}
            loading={weekPlanLoading}
            isManual={plan.isManual}
            manualEditable={manualEditable}
            pullsModeStationIdx={pullsModeStationIdx}
            draggingWorkerName={manualDragWorkerName}
            onDraggingWorkerChange={setManualDragWorkerName}
            availabilityByWorkerName={availabilityByWorkerName}
            onTogglePullsModeStation={(idx) => setPullsModeStationIdx((prev) => (prev === idx ? null : idx))}
            onResetStation={handleResetStation}
            onManualSlotDragOutside={handleManualSlotDragOutside}
            onManualSlotDrop={handleManualSlotDrop}
            onUpsertPull={handleUpsertPull}
            onRemovePull={handleRemovePull}
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
            selectedAlternativeIndex={plan.selectedAlternativeIndex}
            onSelectedAlternativeChange={plan.setSelectedAlternativeIndex}
            onFilteredAlternativesChange={setSummaryFilterState}
            loading={weekPlanLoading}
          />
          <PlanningV2OptionalMessages siteId={siteId} weekStart={weekStart} />
        </PlanningV2MainPaper>
        <PlanningV2ActionBar
          siteId={siteId}
          weekStart={weekStart}
          weekPlan={weekPlan}
          effectiveAssignments={plan.displayAssignments}
          linkedSites={linkedSites}
          editingSaved={editingSaved}
          onEditingSavedChange={setEditingSaved}
          onCancelSavedEdit={async () => {
            setPullsModeStationIdx(null);
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
          onIsManualChange={plan.setIsManual}
          onEnterManualWithGridReset={plan.enterManualWithGridReset}
          onSavePlan={handleSavePlan}
          onDraftClear={plan.clearDraft}
          draftActive={plan.draftActive}
          alternativeCount={visibleAlternativeIndices.length}
          selectedAlternativeIndex={Math.max(0, selectedVisibleAlternativeIndex)}
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
            <div className="text-base font-semibold">משיכות באתרים מקושרים</div>
            <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              {pullScopeDialog.mode === "remove"
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

"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { getRequiredFor } from "../lib/station-grid-helpers";
import {
  readLinkedPlansFromMemory,
  resolveAssignmentsForAlternative,
  resolvePullsForAlternative,
  saveLinkedPlansToMemory,
  type LinkedSitePlan,
} from "../lib/multi-site-linked-memory";
import { normWorkerName, planningV2PullEntryIsReal } from "../lib/planning-v2-worker-name";
import type { PlanningV2PullEntry, PlanningV2PullsMap, SiteSummary } from "../types";

type AssignmentsMap = Record<string, Record<string, string[][]>>;

type PullScopeDialog = {
  mode: "upsert" | "remove";
  kind?: "pull" | "guard_hours";
  resolve: (scope: "current_only" | "all_sites" | null) => void;
} | null;

type PullsEditingPlanSlice = {
  displayPulls: PlanningV2PullsMap | null | undefined;
  getLatestAssignmentBase: () => AssignmentsMap;
  commitDraftAssignments: (assignments: AssignmentsMap) => void;
  commitDraftPulls: (pulls: PlanningV2PullsMap) => void;
  draftActive: boolean;
};

type UsePlanningV2PullsEditingArgs = {
  plan: PullsEditingPlanSlice;
  site: SiteSummary | null;
  linkedSitesLength: number;
  weekStart: Date;
};

export function usePlanningV2PullsEditing({
  plan,
  site,
  linkedSitesLength,
  weekStart,
}: UsePlanningV2PullsEditingArgs) {
  const [pullScopeDialog, setPullScopeDialog] = useState<PullScopeDialog>(null);

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
      if (normWorkerName(beforeName) === normWorkerName(afterName)) {
        toast.error("לא ניתן ליצור משיכות", { description: "בחר שני עובדים שונים" });
        return false;
      }

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

      const stCfg = (site?.config?.stations as Record<string, unknown>[] | undefined)?.[stationIdx];
      const required = getRequiredFor(stCfg, shiftName, dayKey);
      const maxNamesAllowed = Number(required || 0) + (oldEntry ? others.length + 1 : others.length + 1);
      if (nextNames.length > maxNamesAllowed) {
        toast.error("לא ניתן ליצור משיכות", { description: "אין מספיק מקום בעמדה" });
        return false;
      }

      const nextAssignments = JSON.parse(JSON.stringify(baseAssignments)) as AssignmentsMap;
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
      if (linkedSitesLength <= 1) {
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
              {}) as AssignmentsMap;
            const curPulls = (resolvePullsForAlternative(planForSite, activeIdx) || {}) as PlanningV2PullsMap;
            const asg = JSON.parse(JSON.stringify(curAssignments)) as AssignmentsMap;
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
    [plan, site, linkedSitesLength, weekStart],
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

      const nextAssignments = JSON.parse(JSON.stringify(baseAssignments)) as AssignmentsMap;
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
      if (linkedSitesLength <= 1) {
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
              {}) as AssignmentsMap;
            const curPulls = (resolvePullsForAlternative(planForSite, activeIdx) || {}) as PlanningV2PullsMap;
            const asg = JSON.parse(JSON.stringify(curAssignments)) as AssignmentsMap;
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
    [plan, linkedSitesLength, weekStart],
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
        // Sans draft actif (plan sauvegardé affiché), on doit activer le brouillon
        // pour que pullVariants utilise draftPulls et que les horaires restent visibles + sauvegardables.
        if (!plan.draftActive) {
          plan.commitDraftAssignments(plan.getLatestAssignmentBase());
        }
        plan.commitDraftPulls(nextPulls);
      };

      if (linkedSitesLength <= 1) {
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
    [plan, linkedSitesLength, weekStart],
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
        // Sans draft actif (plan sauvegardé affiché), on doit activer le brouillon
        // pour que pullVariants utilise draftPulls et que la suppression reste visible + sauvegardable.
        if (!plan.draftActive) {
          plan.commitDraftAssignments(plan.getLatestAssignmentBase());
        }
        plan.commitDraftPulls(nextPulls);
      };

      if (linkedSitesLength <= 1) {
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
    [plan, linkedSitesLength, weekStart],
  );

  return {
    pullScopeDialog,
    setPullScopeDialog,
    handleUpsertPull,
    handleRemovePull,
    handleUpsertGuardDisplay,
    handleRemoveGuardDisplay,
  };
}

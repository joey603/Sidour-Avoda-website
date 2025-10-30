"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { fetchMe } from "@/lib/auth";
import { toast } from "sonner";

export default function PlanningPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [site, setSite] = useState<any>(null);
  type WorkerAvailability = Record<string, string[]>; // key: day key (sun..sat) -> enabled shift names
  type Worker = {
    id: number;
    name: string;
    maxShifts: number;
    roles: string[];
    availability: WorkerAvailability;
  };
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [newWorkerName, setNewWorkerName] = useState("");
  const [newWorkerMax, setNewWorkerMax] = useState<number>(5);
  const [newWorkerRoles, setNewWorkerRoles] = useState<string[]>([]);
  const [newWorkerAvailability, setNewWorkerAvailability] = useState<WorkerAvailability>({
    sun: [],
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
  });
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingWorkerId, setEditingWorkerId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [hiddenWorkerIds, setHiddenWorkerIds] = useState<number[]>([]);
  const [weekStart, setWeekStart] = useState<Date>(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = today.getDay(); // 0 = Sunday
    const startThisWeek = new Date(today);
    startThisWeek.setDate(today.getDate() - day);
    const nextWeek = new Date(startThisWeek);
    nextWeek.setDate(startThisWeek.getDate() + 7); // semaine prochaine par défaut
    return nextWeek;
  });

  // IA planning result
  const [aiLoading, setAiLoading] = useState(false);
  type AIPlan = {
    days: string[];
    shifts: string[];
    stations: string[];
    assignments: Record<string, Record<string, string[][]>>;
    alternatives?: Record<string, Record<string, string[][]>>[];
    status: string;
    objective: number;
  };
  const [aiPlan, setAiPlan] = useState<AIPlan | null>(null);
  const [altIndex, setAltIndex] = useState<number>(0);
  const baseAssignmentsRef = useRef<Record<string, Record<string, string[][]>> | null>(null);
  const prevAltCountRef = useRef<number>(0);

  // Logs de debug pour l'état du bouton
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log("[BTN] aiLoading:", aiLoading);
  }, [aiLoading]);

  // Log centralisé: chaque fois que le nombre de חלופות change
  useEffect(() => {
    const count = aiPlan?.alternatives?.length || 0;
    if (count !== prevAltCountRef.current) {
      // eslint-disable-next-line no-console
      console.log("[ALT][OBS] alternatives updated", { count, status: aiPlan?.status, aiLoading });
      prevAltCountRef.current = count;
    }
  }, [aiPlan?.alternatives?.length, aiPlan?.status, aiLoading]);

  // Log quand le statut passe à DONE (fin de diffusion)
  useEffect(() => {
    if (aiPlan?.status === "DONE") {
      const count = aiPlan?.alternatives?.length || 0;
      // eslint-disable-next-line no-console
      console.log("[ALT][OBS] DONE broadcast", { count, status: aiPlan?.status });
    }
  }, [aiPlan?.status]);

  // Mode manuel (drag & drop)
  const [isManual, setIsManual] = useState(false);
  type AssignmentsMap = Record<string, Record<string, string[][]>>;
  const [manualAssignments, setManualAssignments] = useState<AssignmentsMap | null>(null);
  // Role hints per slot in manual mode (preserved from auto)
  type RoleHintsMap = Record<string, Record<string, (string | null)[][]>>;
  const [manualRoleHints, setManualRoleHints] = useState<RoleHintsMap | null>(null);
  const [hoverSlotKey, setHoverSlotKey] = useState<string | null>(null);
  const lastDropRef = useRef<{ key: string; ts: number } | null>(null);
  const lastConflictConfirmRef = useRef<{ key: string; ts: number } | null>(null);

  // Helpers: day order and shift kind
  const dayOrder = ["sun","mon","tue","wed","thu","fri","sat"] as const;
  const prevDayKeyOf = (key: string) => dayOrder[(dayOrder.indexOf(key as any) + 6) % 7];
  const nextDayKeyOf = (key: string) => dayOrder[(dayOrder.indexOf(key as any) + 1) % 7];
  function detectShiftKind(sn: string): "morning" | "noon" | "night" | "other" {
    const s = String(sn || "");
    if (/בוקר|^0?6|06-14/i.test(s)) return "morning";
    if (/צהר(יים|י)ם?|14-22|^1?4/i.test(s)) return "noon";
    if (/לילה|22-06|^2?2|night/i.test(s)) return "night";
    return "other";
  }

  // Worker role check usable outside of render helpers
  const normLocal = (n: string) => (n || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  function workerHasRole(workerName: string, roleName: string): boolean {
    const w = workers.find((x) => (x.name || "").trim() === (workerName || "").trim());
    if (!w) return false;
    const target = normLocal(roleName);
    return (w.roles || []).some((r) => normLocal(String(r)) === target);
  }

  function onWorkerDragStart(e: React.DragEvent, workerName: string) {
    try {
      e.dataTransfer.setData("text/plain", workerName);
      e.dataTransfer.effectAllowed = "copy";
    } catch {}
    // debug
    try { console.log("[DND] dragstart worker:", workerName); } catch {}
  }

  // Slot-level DnD only in manual mode; no cell-level drop
  function onSlotDragOver(e: React.DragEvent) {
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "copy"; } catch {}
  }

  function dropIntoSlot(
    dayKey: string,
    shiftName: string,
    stationIndex: number,
    slotIndex: number,
    workerName: string,
    expectedRoleFromUI?: string | null,
    prechecked?: boolean
  ) {
    const trimmed = (workerName || "").trim();
    if (!trimmed) return;
    setManualAssignments((prev) => {
      const stationsCount = (site?.config?.stations || []).length || 0;
      const ensureBase = (base?: AssignmentsMap | null): AssignmentsMap => {
        const next: AssignmentsMap = base ? JSON.parse(JSON.stringify(base)) : ({} as any);
        if (!next[dayKey]) next[dayKey] = {} as any;
        if (!next[dayKey][shiftName]) next[dayKey][shiftName] = Array.from({ length: stationsCount }, () => []);
        if ((next[dayKey][shiftName] as any[]).length !== stationsCount) {
          next[dayKey][shiftName] = Array.from({ length: stationsCount }, (_, i) => (next[dayKey][shiftName][i] || []));
        }
        return next;
      };
      const base = ensureBase(prev);
      const beforeArr: string[] = Array.from(base[dayKey][shiftName][stationIndex] || []);

      // --- role context (station requirements and hints) ---
      const stCfg = (site?.config?.stations || [])[stationIndex] || null;
      const roleReq: Record<string, number> = (() => {
        const out: Record<string, number> = {};
        if (!stCfg) return out;
        const push = (name?: string, count?: number, enabled?: boolean) => {
          const rn = (name || "").trim();
          const c = Number(count || 0);
          if (!rn || !enabled || c <= 0) return; out[rn] = (out[rn] || 0) + c;
        };
        if (stCfg.perDayCustom) {
          const dcfg = stCfg.dayOverrides?.[dayKey];
          if (!dcfg || dcfg.active === false) return out;
          if (stCfg.uniformRoles) {
            for (const r of (stCfg.roles || [])) push(r?.name, r?.count, r?.enabled);
          } else {
            const sh = (dcfg.shifts || []).find((x: any) => x?.name === shiftName);
            for (const r of ((sh?.roles as any[]) || [])) push(r?.name, r?.count, r?.enabled);
          }
          return out;
        }
        if (stCfg.uniformRoles) {
          for (const r of (stCfg.roles || [])) push(r?.name, r?.count, r?.enabled);
        } else {
          const sh = (stCfg.shifts || []).find((x: any) => x?.name === shiftName);
          for (const r of ((sh?.roles as any[]) || [])) push(r?.name, r?.count, r?.enabled);
        }
        return out;
      })();
      const norm = (n: string) => (n || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
      const findAssignedRole = (nm: string): string | null => {
        const w = workers.find((x) => (x.name || "").trim() === (nm || "").trim());
        if (!w) return null;
        const roles = Object.keys(roleReq);
        for (const rName of roles) {
          if ((w.roles || []).some((r) => norm(String(r)) === norm(rName))) return rName;
        }
        return null;
      };
      const currentAssignedPerRole = new Map<string, number>();
      beforeArr.forEach((nm) => {
        const r = findAssignedRole(nm);
        if (!r) return;
        currentAssignedPerRole.set(r, (currentAssignedPerRole.get(r) || 0) + 1);
      });
      const roleHints: string[] = [];
      Object.entries(roleReq).forEach(([rName, rCount]) => {
        const have = currentAssignedPerRole.get(rName) || 0;
        const deficit = Math.max(0, (rCount || 0) - have);
        for (let i = 0; i < deficit; i++) roleHints.push(rName);
      });
      const slotMetaBefore = beforeArr.map((nm, i) => ({ idx: i, nm, assignedRole: findAssignedRole(nm), roleHint: roleHints[i] || null }));
      try {
        console.log("[DND] dropIntoSlot BEFORE:", { dayKey, shiftName, stationIndex, slotIndex, workerName: trimmed });
        console.log("[DND] roleReq:", Object.entries(roleReq));
        console.log("[DND] slotMetaBefore:", slotMetaBefore.map(x => ({ idx: x.idx, nm: x.nm, assignedRole: x.assignedRole, roleHint: x.roleHint })));
        console.table(slotMetaBefore.map(x => ({ idx: x.idx, nm: x.nm, assignedRole: x.assignedRole || "—", roleHint: x.roleHint || "—" })));
      } catch {}
      const arr: string[] = Array.from(beforeArr);
      // Remove existing occurrence in this cell to avoid duplicates
      const filtered = arr.filter((x) => (x || "").trim() !== trimmed);
      // Role validation: if the slot expects a role and the worker has roles, ensure match or confirm
      const worker = workers.find((w) => (w.name || "").trim() === trimmed);
      const workerRoles: string[] = Array.isArray(worker?.roles) ? worker!.roles : [];
      const hasWorkerRoles = workerRoles.length > 0;
      const slotHintComputed: string | null = roleHints[slotIndex] || null;
      const slotExpectedRole = (expectedRoleFromUI || slotHintComputed || "").trim() || null;
      if (!prechecked && slotExpectedRole) {
        const match = workerRoles.some((r) => norm(String(r)) === norm(slotExpectedRole as string));
        if (!match) {
          try { console.log("[DND] role mismatch (computed)", { worker: trimmed, workerRoles, slotExpectedRole }); } catch {}
          const ok = typeof window !== "undefined" && window.confirm && window.confirm(`לעובד "${trimmed}" אין את התפקיד "${slotExpectedRole}" בתא זה. להקצות בכל זאת?`);
          if (!ok) {
            try { console.log("[DND] assignment cancelled by user"); } catch {}
            return prev;
          }
        }
      }
      // Other constraints confirmations
      const conflicts: string[] = [];
      try {
        const isNight = detectShiftKind(shiftName) === "night";
        if (isNight) {
          // count night assignments for this worker across manualAssignments + this one
          let nightCount = 0;
          const dayKeysAll = Object.keys(manualAssignments || {});
          for (const dKey of dayKeysAll) {
            const shiftsMap = (manualAssignments as any)?.[dKey] || {};
            for (const sn of Object.keys(shiftsMap)) {
              if (detectShiftKind(sn) !== "night") continue;
              const perStation: string[][] = shiftsMap[sn] || [];
              for (const namesHere of perStation) if ((namesHere || []).some((nm) => (nm || "").trim() === trimmed)) nightCount++;
            }
          }
          // if not already counted in this exact target cell, account for the new drop
          const alreadyHere = beforeArr.some((nm, i) => i === slotIndex ? nm === trimmed : false);
          if (!alreadyHere) nightCount += 1;
          if (nightCount > 3) conflicts.push("יותר מ־3 לילות בשבוע");
        }
        // same day+shift elsewhere
        const perStationSame: string[][] = ((manualAssignments as any)?.[dayKey]?.[shiftName] || []) as any;
        let existsElsewhere = false;
        perStationSame.forEach((namesArr: string[], sIdx: number) => {
          if (sIdx === stationIndex) return;
          if ((namesArr || []).some((nm) => (nm || "").trim() === trimmed)) existsElsewhere = true;
        });
        if (existsElsewhere) conflicts.push("אותו עובד כבר שובץ במשמרת זו בעמדה אחרת");
        // adjacent shifts (including day boundary)
        const kind = detectShiftKind(shiftName);
        const prevCheck = () => {
          if (kind === "morning") {
            const prevDay = prevDayKeyOf(dayKey);
            const perStationPrevNight = ((manualAssignments as any)?.[prevDay]?.[Object.keys(((manualAssignments as any)?.[prevDay]||{})).find((sn) => detectShiftKind(sn) === "night") || "__none__"] || []) as any;
            return perStationPrevNight.some((arr: string[]) => (arr || []).some((nm) => (nm || "").trim() === trimmed));
          }
          if (kind === "noon") {
            const perStationPrevMorning = ((manualAssignments as any)?.[dayKey]?.[Object.keys(((manualAssignments as any)?.[dayKey]||{})).find((sn) => detectShiftKind(sn) === "morning") || "__none__"] || []) as any;
            return perStationPrevMorning.some((arr: string[]) => (arr || []).some((nm) => (nm || "").trim() === trimmed));
          }
          if (kind === "night") {
            const perStationPrevNoon = ((manualAssignments as any)?.[dayKey]?.[Object.keys(((manualAssignments as any)?.[dayKey]||{})).find((sn) => detectShiftKind(sn) === "noon") || "__none__"] || []) as any;
            return perStationPrevNoon.some((arr: string[]) => (arr || []).some((nm) => (nm || "").trim() === trimmed));
          }
          return false;
        };
        const nextCheck = () => {
          if (kind === "morning") {
            const perStationNextNoon = ((manualAssignments as any)?.[dayKey]?.[Object.keys(((manualAssignments as any)?.[dayKey]||{})).find((sn) => detectShiftKind(sn) === "noon") || "__none__"] || []) as any;
            return perStationNextNoon.some((arr: string[]) => (arr || []).some((nm) => (nm || "").trim() === trimmed));
          }
          if (kind === "noon") {
            const perStationNextNight = ((manualAssignments as any)?.[dayKey]?.[Object.keys(((manualAssignments as any)?.[dayKey]||{})).find((sn) => detectShiftKind(sn) === "night") || "__none__"] || []) as any;
            return perStationNextNight.some((arr: string[]) => (arr || []).some((nm) => (nm || "").trim() === trimmed));
          }
          if (kind === "night") {
            const nextDay = nextDayKeyOf(dayKey);
            const perStationNextMorning = ((manualAssignments as any)?.[nextDay]?.[Object.keys(((manualAssignments as any)?.[nextDay]||{})).find((sn) => detectShiftKind(sn) === "morning") || "__none__"] || []) as any;
            return perStationNextMorning.some((arr: string[]) => (arr || []).some((nm) => (nm || "").trim() === trimmed));
          }
          return false;
        };
        if (prevCheck() || nextCheck()) conflicts.push("אין משמרות צמודות (כולל חציית יום)");
      } catch {}
      if (conflicts.length > 0) {
        const conflictKey = `${dayKey}|${shiftName}|${stationIndex}|${slotIndex}|${trimmed}`;
        const last = lastConflictConfirmRef.current;
        if (!(last && last.key === conflictKey && Date.now() - last.ts < 1500)) {
          const msg = `שיבוץ עלול להפר חוקים:\n- ${conflicts.join("\n- ")}.\nלהקצות בכל זאת?`;
          const ok = typeof window !== "undefined" && window.confirm && window.confirm(msg);
          if (!ok) return prev;
          lastConflictConfirmRef.current = { key: conflictKey, ts: Date.now() };
        }
      }
      while (filtered.length <= slotIndex) filtered.push("");
      filtered[slotIndex] = trimmed;
      base[dayKey][shiftName][stationIndex] = filtered;
      // Update manualRoleHints according to expected role from UI
      try {
        if (typeof expectedRoleFromUI !== "undefined") {
          setManualRoleHints((prevHints) => {
            const stationsCount2 = (site?.config?.stations || []).length || 0;
            const ensureHints = (h?: RoleHintsMap | null): RoleHintsMap => {
              const nextH: RoleHintsMap = h ? JSON.parse(JSON.stringify(h)) : ({} as any);
              if (!nextH[dayKey]) nextH[dayKey] = {} as any;
              if (!nextH[dayKey][shiftName]) nextH[dayKey][shiftName] = Array.from({ length: stationsCount2 }, () => []);
              if ((nextH[dayKey][shiftName] as any[]).length !== stationsCount2) {
                nextH[dayKey][shiftName] = Array.from({ length: stationsCount2 }, (_, i) => (nextH[dayKey][shiftName][i] || []));
              }
              return nextH;
            };
            const nh = ensureHints(prevHints);
            const arrHints: (string | null)[] = Array.from(nh[dayKey][shiftName][stationIndex] || []);
            while (arrHints.length <= slotIndex) arrHints.push(null);
            const roleToSet = expectedRoleFromUI && workerHasRole(trimmed, expectedRoleFromUI) ? expectedRoleFromUI : null;
            arrHints[slotIndex] = roleToSet as any;
            nh[dayKey][shiftName][stationIndex] = arrHints;
            return nh;
          });
        }
      } catch {}
      const afterArr: string[] = Array.from(base[dayKey][shiftName][stationIndex] || []);
      const currentAssignedPerRoleAfter = new Map<string, number>();
      afterArr.forEach((nm) => {
        const r = findAssignedRole(nm);
        if (!r) return;
        currentAssignedPerRoleAfter.set(r, (currentAssignedPerRoleAfter.get(r) || 0) + 1);
      });
      const roleHintsAfter: string[] = [];
      Object.entries(roleReq).forEach(([rName, rCount]) => {
        const have = currentAssignedPerRoleAfter.get(rName) || 0;
        const deficit = Math.max(0, (rCount || 0) - have);
        for (let i = 0; i < deficit; i++) roleHintsAfter.push(rName);
      });
      const slotMetaAfter = afterArr.map((nm, i) => ({ idx: i, nm, assignedRole: findAssignedRole(nm), roleHint: roleHintsAfter[i] || null }));
      try {
        console.log("[DND] dropIntoSlot AFTER:", { afterArr });
        console.log("[DND] slotMetaAfter:", slotMetaAfter.map(x => ({ idx: x.idx, nm: x.nm, assignedRole: x.assignedRole, roleHint: x.roleHint })));
        console.table(slotMetaAfter.map(x => ({ idx: x.idx, nm: x.nm, assignedRole: x.assignedRole || "—", roleHint: x.roleHint || "—" })));
      } catch {}
      return { ...base };
    });
  }

  function onCellDrop(e: React.DragEvent, dayKey: string, shiftName: string, stationIndex: number) {
    e.preventDefault();
    const name = (() => {
      try { return e.dataTransfer.getData("text/plain"); } catch { return ""; }
    })();
    const trimmed = (name || "").trim();
    if (!trimmed) return;
    setManualAssignments((prev) => {
      const stationsCount = (site?.config?.stations || []).length || 0;
      const ensureBase = (base?: AssignmentsMap | null): AssignmentsMap => {
        const next: AssignmentsMap = base ? JSON.parse(JSON.stringify(base)) : {} as any;
        if (!next[dayKey]) next[dayKey] = {} as any;
        if (!next[dayKey][shiftName]) next[dayKey][shiftName] = Array.from({ length: stationsCount }, () => []);
        // ensure length
        if (next[dayKey][shiftName].length !== stationsCount) {
          next[dayKey][shiftName] = Array.from({ length: stationsCount }, (_, i) => (next[dayKey][shiftName][i] || []));
        }
        return next;
      };
      const base = ensureBase(prev);
      const cell = base[dayKey][shiftName][stationIndex] || [];
      if (!cell.includes(trimmed)) {
        base[dayKey][shiftName][stationIndex] = [...cell, trimmed];
      }
      return { ...base };
    });
  }

  function onSlotDrop(
    e: React.DragEvent,
    dayKey: string,
    shiftName: string,
    stationIndex: number,
    slotIndex: number
  ) {
    e.preventDefault();
    e.stopPropagation();
    const name = (() => {
      try { return e.dataTransfer.getData("text/plain"); } catch { return ""; }
    })();
    try { console.log("[DND] onSlotDrop", { dayKey, shiftName, stationIndex, slotIndex, name }); } catch {}
    lastDropRef.current = { key: `${dayKey}|${shiftName}|${stationIndex}|${slotIndex}`, ts: Date.now() };
    const roleHintAttr = (e.currentTarget as HTMLElement | null)?.getAttribute?.("data-rolehint") || null;
    // Pre-check mismatch before state update for reliable popup
    if (roleHintAttr) {
      const worker = workers.find((w) => (w.name || "").trim() === (name || "").trim());
      const workerRoles: string[] = Array.isArray(worker?.roles) ? worker!.roles : [];
      const match = workerRoles.some((r) => (r || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") === (roleHintAttr || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " "));
      if (!match) {
        const ok = typeof window !== "undefined" && window.confirm && window.confirm(`לעובד "${name}" אין את התפקיד "${roleHintAttr}" בתא זה. להקצות בכל זאת?`);
        if (!ok) {
          try { console.log("[DND] precheck: cancelled"); } catch {}
          setHoverSlotKey(null);
          return;
        }
      }
    }
    dropIntoSlot(dayKey, shiftName, stationIndex, slotIndex, name, roleHintAttr, true);
    setHoverSlotKey(null);
  }

  function onCellContainerDrop(
    e: React.DragEvent,
    dayKey: string,
    shiftName: string,
    stationIndex: number
  ) {
    if (!isManual) return;
    e.preventDefault();
    e.stopPropagation();
    // If a child slot handled the drop recently for the same target, ignore container drop
    const ld = lastDropRef.current;
    // If the event target is within a slot, ignore (child handles)
    const isInsideSlot = (e.target as HTMLElement | null)?.closest?.('[data-slot="1"]');
    if (isInsideSlot) {
      try { console.log("[DND] container drop ignored: inside slot target"); } catch {}
      return;
    }
    let targetDay = dayKey;
    let targetShift = shiftName;
    let targetStation = stationIndex;
    let targetSlot = -1;
    // Prefer hovered slot if still set
    if (hoverSlotKey) {
      const [dKey, sName, stIdxStr, slotIdxStr] = hoverSlotKey.split("|");
      const stIdx = Number(stIdxStr);
      const slotIdx = Number(slotIdxStr);
      if (dKey === dayKey && sName === shiftName && stIdx === stationIndex && Number.isFinite(slotIdx)) {
        targetSlot = slotIdx;
      }
    }
    // Fallback: find closest slot under pointer
    if (targetSlot < 0 && typeof document !== "undefined") {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const slotEl = el?.closest?.('[data-slot="1"]') as HTMLElement | null;
      if (slotEl) {
        const dkey = slotEl.getAttribute("data-dkey") || dayKey;
        const sname = slotEl.getAttribute("data-sname") || shiftName;
        const stidx = Number(slotEl.getAttribute("data-stidx") || stationIndex);
        const sidx = Number(slotEl.getAttribute("data-slotidx") || -1);
        if (dkey === dayKey && sname === shiftName && stidx === stationIndex && Number.isFinite(sidx)) {
          targetSlot = sidx;
        }
      }
    }
    // After we know the precise target slot, check recent slot drop exact-key guard
    if (ld) {
      const targetKey = `${dayKey}|${shiftName}|${stationIndex}|${targetSlot}`;
      if (ld.key === targetKey && Date.now() - ld.ts < 1000) { // 1s guard
        try { console.log("[DND] container drop ignored due to recent slot drop (exact key)", ld); } catch {}
        return;
      }
    }
    try { console.log("[DND] onCellContainerDrop", { dayKey, shiftName, stationIndex, hoverSlotKey, resolvedTargetSlot: targetSlot }); } catch {}
    if (targetSlot < 0) return;
    const name = (() => { try { return e.dataTransfer.getData("text/plain"); } catch { return ""; } })();
    let expectedRole: string | null = null;
    if (typeof document !== "undefined") {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const slotEl = el?.closest?.('[data-slot="1"]') as HTMLElement | null;
      expectedRole = (slotEl?.getAttribute?.("data-rolehint") || null);
    }
    // Pre-check mismatch
    if (expectedRole) {
      const worker = workers.find((w) => (w.name || "").trim() === (name || "").trim());
      const workerRoles: string[] = Array.isArray(worker?.roles) ? worker!.roles : [];
      const match = workerRoles.some((r) => (r || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") === (expectedRole || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " "));
      if (!match) {
        const ok = typeof window !== "undefined" && window.confirm && window.confirm(`לעובד "${name}" אין את התפקיד "${expectedRole}" בתא זה. להקצות בכל זאת?`);
        if (!ok) {
          setHoverSlotKey(null);
          return;
        }
      }
    }
    try { console.log("[DND] onCellContainerDrop applying", { targetDay, targetShift, targetStation, targetSlot, name, expectedRole }); } catch {}
    dropIntoSlot(targetDay, targetShift, targetStation, targetSlot, name, expectedRole, true);
    setHoverSlotKey(null);
  }

  // Construire un mapping nom -> couleur distincte (éviter rouge/vert), stable et réparti (golden angle)
  const nameToColor = useMemo(() => {
    const set = new Set<string>();
    // depuis la liste des workers
    for (const w of workers) {
      const nm = (w.name || "").trim();
      if (nm) set.add(nm);
    }
    // depuis le plan IA courant
    if (aiPlan && aiPlan.assignments) {
      for (const day of Object.keys(aiPlan.assignments)) {
        const shiftsMap = (aiPlan.assignments as any)[day] || {};
        for (const sh of Object.keys(shiftsMap)) {
          const perStation: string[][] = shiftsMap[sh] || [];
          for (const arr of perStation) {
            for (const nm of arr || []) {
              const v = (nm || "").trim();
              if (v) set.add(v);
            }
          }
        }
      }
    }
    const names = Array.from(set).sort((a, b) => a.localeCompare(b));
    const GOLDEN = 137.508;
    function shiftForbidden(h: number) {
      // éviter rouge ~[350..360)∪[0..20], vert ~[100..150]
      if (h < 20 || h >= 350) h = (h + 30) % 360;
      if (h >= 100 && h <= 150) h = (h + 40) % 360;
      return h;
    }
    const map = new Map<string, { bg: string; border: string; text: string }>();
    names.forEach((nm, i) => {
      let h = (i * GOLDEN) % 360;
      h = shiftForbidden(h);
      // alterner saturation/luminosité pour plus de séparation perceptuelle
      const L = [88, 84, 80][i % 3];
      const Sbg = [85, 80, 75][(i >> 1) % 3];
      const bg = `hsl(${h} ${Sbg}% ${L}%)`;
      const border = `hsl(${h} 60% ${Math.max(65, L - 10)}%)`;
      const text = `#1f2937`;
      map.set(nm, { bg, border, text });
    });
    return map;
  }, [workers, aiPlan]);

  // Couleur stable par employé (palette sans rouge/vert) pour éviter confusion avec l'état שיבוצים
  function colorForName(name: string): { bg: string; border: string; text: string } {
    const preset = nameToColor.get(name);
    if (preset) return preset;
    const s = name || "";
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash) + s.charCodeAt(i);
      hash |= 0;
    }
    // Hues autorisées (éviter rouge ~0 et vert ~120)
    const allowedHues = [20, 30, 40, 50, 200, 210, 220, 230, 260, 270, 280, 290, 300, 310];
    const idx = Math.abs(hash) % allowedHues.length;
    const hue = allowedHues[idx];
    // Légère variation de luminosité/saturation pour augmenter la distinction
    const lightVariants = [88, 84, 80] as const;
    const satVariants = [85, 80, 75] as const;
    const vIdx = Math.abs((hash >> 3)) % lightVariants.length;
    const L = lightVariants[vIdx];
    const Sbg = satVariants[vIdx];
    const Sborder = 60;
    const bg = `hsl(${hue} ${Sbg}% ${L}%)`;
    const border = `hsl(${hue} ${Sborder}% ${Math.max(65, L - 10)}%)`;
    const text = `#1f2937`;
    return { bg, border, text };
  }

  // Couleurs par תפקיד (rôle) – mapping stable basé sur la config du site et les rôles des employés
  const roleColorMap = useMemo(() => {
    const set = new Set<string>();
    // depuis config des stations
    for (const st of (site?.config?.stations || [])) {
      for (const r of (st?.roles || [])) {
        const nm = (r?.name || "").trim();
        if (nm) set.add(nm);
      }
      for (const sh of (st?.shifts || [])) {
        for (const r of (sh?.roles || [])) {
          const nm = (r?.name || "").trim();
          if (nm) set.add(nm);
        }
      }
    }
    // depuis les employés
    for (const w of workers) {
      for (const nm of (w.roles || [])) {
        const v = (nm || "").trim();
        if (v) set.add(v);
      }
    }
    const roles = Array.from(set).sort((a, b) => a.localeCompare(b));
    const GOLDEN = 137.508;
    const map = new Map<string, { border: string; text: string }>();
    roles.forEach((nm, i) => {
      let h = (i * GOLDEN) % 360;
      // éviter zones trop proches du vert des statuts
      if (h >= 100 && h <= 150) h = (h + 40) % 360;
      const border = `hsl(${h} 70% 40%)`;
      const text = `hsl(${h} 60% 30%)`;
      map.set(nm, { border, text });
    });
    return map;
  }, [site, workers]);

  function colorForRole(roleName: string): { border: string; text: string } {
    return roleColorMap.get(roleName) || { border: "#64748b", text: "#334155" };
  }

  function addDays(base: Date, days: number): Date {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
  }

  function formatHebDate(d: Date): string {
    return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  useEffect(() => {
    // Debug: workers/hiddenIds
    // eslint-disable-next-line no-console
    console.log("[Planning] workers state:", workers);
  }, [workers]);
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log("[Planning] hiddenWorkerIds:", hiddenWorkerIds);
  }, [hiddenWorkerIds]);

  // Référentiels communs (utilisés par la liste et la modale)
  const dayDefs = [
    { key: "sun", label: "א'" },
    { key: "mon", label: "ב'" },
    { key: "tue", label: "ג'" },
    { key: "wed", label: "ד'" },
    { key: "thu", label: "ה'" },
    { key: "fri", label: "ו'" },
    { key: "sat", label: "ש'" },
  ];

  const allShiftNames: string[] = Array.from(
    new Set(
      (site?.config?.stations || [])
        .flatMap((st: any) => (st?.shifts || [])
          .filter((sh: any) => sh?.enabled)
          .map((sh: any) => sh?.name))
        .filter(Boolean)
    )
  );

  // Initialiser/vider les affectations manuelles lors du changement de mode
  useEffect(() => {
    if (!isManual) {
      setManualAssignments(null);
      return;
    }
    const stationsCount = (site?.config?.stations || []).length || 0;
    if (stationsCount <= 0) return;
    const dayKeys = ["sun","mon","tue","wed","thu","fri","sat"];
    const base: AssignmentsMap = {} as any;
    const hintsBase: RoleHintsMap = {} as any;
    const getRequiredForLocal = (st: any, shiftName: string, dayKey: string): number => {
      if (!st) return 0;
      if (st.perDayCustom) {
        const dayCfg = st.dayOverrides?.[dayKey];
        if (!dayCfg || dayCfg.active === false) return 0;
        if (st.uniformRoles) return Number(st.workers || 0);
        const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
        if (!sh || !sh.enabled) return 0;
        return Number(sh.workers || 0);
      }
      if (st.days && st.days[dayKey] === false) return 0;
      if (st.uniformRoles) return Number(st.workers || 0);
      const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
      if (!sh || !sh.enabled) return 0;
      return Number(sh.workers || 0);
    };
    for (const d of dayKeys) {
      base[d] = {} as any;
      // compute shift names locally to avoid init order issues
      const shiftNamesLocal: string[] = Array.from(
        new Set(
          (site?.config?.stations || [])
            .flatMap((st: any) => (st?.shifts || [])
              .filter((sh: any) => sh?.enabled)
              .map((sh: any) => sh?.name))
            .filter(Boolean)
        )
      );
      for (const sn of shiftNamesLocal) {
        const fromAI = (aiPlan?.assignments as any)?.[d]?.[sn] || [];
        const stationArr: string[][] = [];
        const stationHintsArr: (string | null)[][] = [];
        for (let i = 0; i < stationsCount; i++) {
          const namesOriginal = Array.from((fromAI[i] || []) as string[]);
          const stCfg = (site?.config?.stations || [])[i] || null;
          const req = getRequiredForLocal(stCfg, sn, d);
          // role requirements map
          const reqMap: Record<string, number> = (() => {
            const out: Record<string, number> = {};
            const push = (name?: string, count?: number, enabled?: boolean) => {
              const rn = (name || "").trim();
              const c = Number(count || 0);
              if (!rn || !enabled || c <= 0) return; out[rn] = (out[rn] || 0) + c;
            };
            const st = stCfg;
            if (!st) return out;
            if (st.perDayCustom) {
              const dayCfg = st.dayOverrides?.[d];
              if (!dayCfg || dayCfg.active === false) return out;
              if (st.uniformRoles) { for (const r of (st.roles || [])) push(r?.name, r?.count, r?.enabled); }
              else { const sh = (dayCfg.shifts || []).find((x: any) => x?.name === sn); for (const r of ((sh?.roles as any[]) || [])) push(r?.name, r?.count, r?.enabled); }
              return out;
            }
            if (st.uniformRoles) { for (const r of (st.roles || [])) push(r?.name, r?.count, r?.enabled); }
            else { const sh = (st.shifts || []).find((x: any) => x?.name === sn); for (const r of ((sh?.roles as any[]) || [])) push(r?.name, r?.count, r?.enabled); }
            return out;
          })();
          // Créer un plan de slots avec positions fixes pour les rôles (comme en mode automatique)
          type SlotType = { roleHint: string | null, workerName: string | null };
          const fixedSlots: SlotType[] = [];
          
          // Créer un slot pour chaque rôle requis (dans l'ordre des rôles)
          Object.entries(reqMap).forEach(([rName, rCount]) => {
            for (let i = 0; i < (rCount || 0); i++) {
              fixedSlots.push({ roleHint: rName, workerName: null });
            }
          });
          const totalRoleSlots = fixedSlots.length;
          
          // Ajouter les slots sans rôle pour les assignations restantes
          const remainingRequired = Math.max(0, req - totalRoleSlots);
          for (let i = 0; i < remainingRequired; i++) {
            fixedSlots.push({ roleHint: null, workerName: null });
          }
          
          // Remplir les slots avec les assignations existantes
          const usedSlots = new Set<number>();
          const assignedWithoutRole: string[] = [];
          
          // Déterminer quels noms ont un rôle
          const roles = Object.keys(reqMap);
          const namesWithRole: { nm: string; role: string | null }[] = namesOriginal.map((nm) => {
            let matched: string | null = null;
            for (const rName of roles) { if (workerHasRole(nm, rName)) { matched = rName; break; } }
            return { nm, role: matched };
          });
          
          // D'abord remplir les slots de rôle avec les travailleurs qui ont ce rôle
          namesWithRole.forEach(({ nm, role }) => {
            if (role) {
              // Trouver le premier slot vide pour ce rôle
              for (let j = 0; j < totalRoleSlots; j++) {
                if (usedSlots.has(j)) continue;
                if (fixedSlots[j].roleHint === role) {
                  fixedSlots[j].workerName = nm;
                  usedSlots.add(j);
                  break;
                }
              }
            } else {
              assignedWithoutRole.push(nm);
            }
          });
          
          // Remplir les slots sans rôle avec les travailleurs restants
          let neutralSlotIdx = totalRoleSlots;
          assignedWithoutRole.forEach((nm) => {
            if (neutralSlotIdx < fixedSlots.length) {
              fixedSlots[neutralSlotIdx].workerName = nm;
              neutralSlotIdx++;
            }
          });
          
          // Construire le tableau selon l'ordre fixe
          const cell = fixedSlots.map(slot => slot.workerName || "");
          stationArr.push(cell);
          
          // Construire les hints alignés avec les slots fixes
          const hints = fixedSlots.map(slot => slot.roleHint);
          stationHintsArr.push(hints);
        }
        base[d][sn] = stationArr;
        hintsBase[d] = hintsBase[d] || ({} as any);
        hintsBase[d][sn] = stationHintsArr as any;
      }
    }
    setManualAssignments(base);
    setManualRoleHints(hintsBase);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManual, site?.config?.stations, aiPlan?.assignments]);

  const allRoleNames: string[] = Array.from(
    new Set(
      (site?.config?.stations || [])
        .flatMap((st: any) => (st?.roles || []).map((r: any) => r?.name))
        .filter(Boolean)
    )
  );

  function toggleNewAvailability(dayKey: string, shift: string) {
    setNewWorkerAvailability((prev) => {
      const cur = prev[dayKey] || [];
      return {
        ...prev,
        [dayKey]: cur.includes(shift) ? cur.filter((s) => s !== shift) : [...cur, shift],
      };
    });
  }

  useEffect(() => {
    (async () => {
      const me = await fetchMe();
      if (!me) return router.replace("/login");
      if (me.role !== "director") return router.replace("/worker");
      try {
        const data = await apiFetch(`/director/sites/${params.id}`, {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        });
        setSite(data);
      } catch (e: any) {
        // Fallback: tenter via la liste si la lecture directe 404 juste après création
        try {
          const list = await apiFetch<any[]>(`/director/sites/`, {
            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
            cache: "no-store" as any,
          });
          const found = list.find((s: any) => String(s.id) === String(params.id));
          if (found) setSite(found);
          else setError("אתר לא נמצא");
        } catch (err) {
          setError("שגיאה בטעינת אתר");
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [params.id, router]);

  async function loadWorkers() {
    try {
      // eslint-disable-next-line no-console
      console.log("[Planning] loadWorkers: fetching...");
      const list = await apiFetch<any[]>(`/director/sites/${params.id}/workers`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        cache: "no-store" as any,
      });
      // eslint-disable-next-line no-console
      console.log("[Planning] loadWorkers: fetched", list);
      const mapped: Worker[] = (list || []).map((w: any) => ({
        id: w.id,
        name: w.name,
        maxShifts: w.max_shifts ?? w.maxShifts ?? 0,
        roles: Array.isArray(w.roles) ? w.roles : [],
        availability: w.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
      }));
      // eslint-disable-next-line no-console
      console.log("[Planning] loadWorkers: mapped", mapped);
      setWorkers(mapped);
    } catch (e: any) {
      toast.error("שגיאה בטעינת עובדים", { description: e?.message || "נסה שוב מאוחר יותר." });
    }
  }

  useEffect(() => {
    loadWorkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <h1 className="text-2xl font-semibold">יצירת תכנון משמרות</h1>
        {loading ? (
          <p>טוען...</p>
        ) : error ? (
          <p className="text-red-600">{error}</p>
        ) : (
          <div className="rounded-2xl border p-4 dark:border-zinc-800 space-y-6">
            <div className="mb-2 relative">
              <div className="text-sm text-zinc-500">אתר</div>
              <div className="text-lg font-medium">{site?.name}</div>
              <button
                type="button"
                onClick={() => router.push(`/director/sites/${site?.id}/edit`)}
                className="absolute top-0 left-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75Z"/></svg>
                עדכן הגדרות
              </button>
            </div>

            {/* Tableau travailleurs */}
            <section className="space-y-3">
              <h2 className="text-lg font-semibold text-center">עובדים</h2>
              {(() => {
                const dayDefs = [
                  { key: "sun", label: "א'" },
                  { key: "mon", label: "ב'" },
                  { key: "tue", label: "ג'" },
                  { key: "wed", label: "ד'" },
                  { key: "thu", label: "ה'" },
                  { key: "fri", label: "ו'" },
                  { key: "sat", label: "ש'" },
                ];
                const allShiftNames: string[] = Array.from(
                  new Set(
                    (site?.config?.stations || [])
                      .flatMap((st: any) => (st?.shifts || [])
                        .filter((sh: any) => sh?.enabled)
                        .map((sh: any) => sh?.name))
                      .filter(Boolean)
                  )
                );
                const allRoleNames: string[] = Array.from(
                  new Set(
                    (site?.config?.stations || [])
                      .flatMap((st: any) => (st?.roles || []).map((r: any) => r?.name))
                      .filter(Boolean)
                  )
                );

                function toggleNewAvailability(dayKey: string, shift: string) {
                  setNewWorkerAvailability((prev) => {
                    const cur = prev[dayKey] || [];
                    return {
                      ...prev,
                      [dayKey]: cur.includes(shift)
                        ? cur.filter((s) => s !== shift)
                        : [...cur, shift],
                    };
                  });
                }

                return (
                  <div className="rounded-md border p-3 space-y-3 dark:border-zinc-700">
                    <div className="flex items-center justify-between">
                      <div className="text-sm text-zinc-500">רשימת עובדים</div>
                      <button
                        type="button"
                        onClick={() => {
                          // reset form for add
                          setEditingWorkerId(null);
                          setNewWorkerName("");
                          setNewWorkerMax(5);
                          setNewWorkerRoles([]);
                          setNewWorkerAvailability({ sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });
                          setIsAddModalOpen(true);
                        }}
                        className="inline-flex items-center gap-2 rounded-md border border-green-600 px-3 py-2 text-sm text-green-600 hover:bg-green-50 dark:border-green-500 dark:text-green-400 dark:hover:bg-green-900/30"
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>
                        הוסף עובד
                      </button>
                    </div>
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm">
                          <thead>
                            <tr className="border-b dark:border-zinc-800">
                              <th className="px-3 py-2 text-right">שם</th>
                              <th className="px-3 py-2 text-right">מקס' משמרות</th>
                              <th className="px-3 py-2 text-right">תפקידים</th>
                              <th className="px-3 py-2 text-right">זמינות</th>
                              <th className="px-3 py-2"></th>
                            </tr>
                          </thead>
                          <tbody>
                          {workers.filter((w) => !hiddenWorkerIds.includes(w.id)).length > 0 ? (
                            workers.filter((w) => !hiddenWorkerIds.includes(w.id)).map((w) => (
                              <tr key={w.id} className="border-b last:border-0 dark:border-zinc-800">
                                <td className="px-3 py-2">{w.name}</td>
                                <td className="px-3 py-2">{w.maxShifts}</td>
                                <td className="px-3 py-2">{w.roles.join(", ") || "—"}</td>
                                <td className="px-3 py-2">
                                  {dayDefs.map((d, i) => (
                                    <span key={d.key} className="inline-block ltr:mr-2 rtl:ml-2 text-zinc-600 dark:text-zinc-300">
                                      {d.label}:{" "}
                                      {(w.availability[d.key] || []).join("/") || "—"}
                                      {i < dayDefs.length - 1 ? "  " : ""}
                                    </span>
                                  ))}
                                </td>
                                <td className="px-3 py-2 text-left">
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingWorkerId(w.id);
                                        // eslint-disable-next-line no-console
                                        console.log("[Planning] edit worker", w);
                                        setNewWorkerName(w.name);
                                        setNewWorkerMax(w.maxShifts);
                                        setNewWorkerRoles([...w.roles]);
                                        setNewWorkerAvailability({ ...w.availability });
                                        setIsAddModalOpen(true);
                                      }}
                                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                                    >
                                      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75Z"/></svg>
                                      ערוך
                                    </button>
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        // eslint-disable-next-line no-console
                                        console.log("[Planning] delete click worker", w.id, w.name);
                                        if (!confirm(`למחוק את ${w.name}?`)) return;
                                        setDeletingId(w.id);
                                        setHiddenWorkerIds((prev) => (prev.includes(w.id) ? prev : [...prev, w.id]));
                                        const previousWorkers = workers;
                                        // Retrait immédiat (optimiste)
                                        setWorkers((prev) => prev.filter((x) => x.id !== w.id));
                                        try {
                                          // eslint-disable-next-line no-console
                                          console.log("[Planning] DELETE /workers/", w.id);
                                          await apiFetch(`/director/sites/${params.id}/workers/${w.id}`, {
                                            method: "DELETE",
                                            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                                          });
                                          toast.success("העובד נמחק בהצלחה");
                                          // Rechargement avec retries pour éviter la réapparition (latence DB)
                                          for (let i = 0; i < 3; i++) {
                                            try {
                                              // eslint-disable-next-line no-console
                                              console.log(`[Planning] reload workers attempt ${i + 1}`);
                                              const list = await apiFetch<any[]>(`/director/sites/${params.id}/workers`, {
                                                headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                                                cache: "no-store" as any,
                                              });
                                              // eslint-disable-next-line no-console
                                              console.log("[Planning] reloaded list:", list);
                                              const contains = (list || []).some((it: any) => Number(it?.id) === Number(w.id));
                                              // eslint-disable-next-line no-console
                                              console.log("[Planning] contains deleted?", contains);
                                              if (!contains) {
                                                const mapped: Worker[] = (list || []).map((rw: any) => ({
                                                  id: rw.id,
                                                  name: rw.name,
                                                  maxShifts: rw.max_shifts ?? rw.maxShifts ?? 0,
                                                  roles: Array.isArray(rw.roles) ? rw.roles : [],
                                                  availability: rw.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
                                                }));
                                                setWorkers(mapped);
                                                setHiddenWorkerIds((prev) => prev.filter((id) => id !== w.id));
                                                break;
                                              }
                                              await new Promise((r) => setTimeout(r, 250));
                                            } catch {}
                                          }
                                          // Si, malgré tout, le backend renvoie encore l'élément, on le masque côté UI
                                          setHiddenWorkerIds((prev) => prev.filter((id) => id !== w.id));
                                        } catch (e: any) {
                                          // eslint-disable-next-line no-console
                                          console.log("[Planning] DELETE failed", e);
                                          // Vérifier l'état réel côté serveur: si l'élément n'existe plus, considérer la suppression comme réussie
                                          try {
                                            const list = await apiFetch<any[]>(`/director/sites/${params.id}/workers`, {
                                              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                                              cache: "no-store" as any,
                                            });
                                            const stillThere = (list || []).some((it: any) => Number(it?.id) === Number(w.id));
                                            // eslint-disable-next-line no-console
                                            console.log("[Planning] verify after failed DELETE, stillThere=", stillThere);
                                            if (!stillThere) {
                                              toast.success("העובד נמחק בהצלחה");
                                              setHiddenWorkerIds((prev) => prev.filter((id) => id !== w.id));
                                              return;
                                            }
                                          } catch (verifyErr) {
                                            // eslint-disable-next-line no-console
                                            console.log("[Planning] verify after delete error failed", verifyErr);
                                          }
                                          // Rollback si réellement non supprimé
                                          setWorkers(previousWorkers);
                                          toast.error("שגיאה במחיקה", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
                                        } finally {
                                          // eslint-disable-next-line no-console
                                          console.log("[Planning] delete done", w.id);
                                          setDeletingId(null);
                                        }
                                      }}
                                      disabled={deletingId === w.id}
                                      className="inline-flex items-center gap-1 rounded-md border border-red-600 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/40"
                                    >
                                      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden><path d="M6 7h12v2H6Zm2 4h8l-1 9H9ZM9 4h6v2H9Z"/></svg>
                                      מחק
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan={5} className="px-3 py-6 text-center text-zinc-500">אין עובדים</td>
                            </tr>
                          )}
                          </tbody>
                        </table>
                      </div>
                  </div>
                );
              })()}
            </section>
            {/* removed global summary here, kept only below the grids */}

            {/* Modal d'ajout d'employé */}
            {isAddModalOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                <div className="w-full max-w-3xl rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="relative mb-3 flex items-center justify-center">
                    <h3 className="text-lg font-semibold text-center">{editingWorkerId ? "עריכת עובד" : "הוספת עובד"}</h3>
                    <button
                      type="button"
                      onClick={() => setIsAddModalOpen(false)}
                      className="absolute right-2 top-1.5 rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-4 justify-items-center text-center">
                    <div>
                      <label className="block text-sm font-semibold">שם</label>
                      <input
                        type="text"
                        value={newWorkerName}
                        onChange={(e) => setNewWorkerName(e.target.value)}
                        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold">מקס' משמרות בשבוע</label>
                      <input
                        type="number"
                        min={0}
                        value={newWorkerMax}
                        onChange={(e) => setNewWorkerMax(Math.max(0, parseInt(e.target.value || "0", 10)))}
                        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <div className="block text-sm font-semibold mb-1">תפקידים</div>
                      <div className="flex flex-wrap justify-center gap-2 text-sm">
                        {allRoleNames.length === 0 ? (
                          <span className="text-zinc-500">אין תפקידים מוגדרים</span>
                        ) : (
                          allRoleNames.map((rn) => (
                            <label key={rn} className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={newWorkerRoles.includes(rn)}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setNewWorkerRoles((prev) => (checked ? [...prev, rn] : prev.filter((x) => x !== rn)));
                                }}
                              />
                              {rn}
                            </label>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 text-center">
                    <div className="block text-sm font-semibold mb-1">זמינות לפי יום/משמרת</div>
                    <div className="space-y-2">
                      {(() => {
                        const morningName = allShiftNames.find((sn) => /בוקר|^0?6|06-14/i.test(sn || ""));
                        const noonName = allShiftNames.find((sn) => /צהריים|14-22|^1?4/i.test(sn || ""));
                        const nightName = allShiftNames.find((sn) => /לילה|22-06|^2?2|night/i.test(sn || ""));
                        function isAllSelected(shiftName?: string) {
                          if (!shiftName) return false;
                          return dayDefs.every((d) => (newWorkerAvailability[d.key] || []).includes(shiftName));
                        }
                        function toggleAll(shiftName?: string, checked?: boolean) {
                          if (!shiftName) return;
                          setNewWorkerAvailability((prev) => {
                            const next: WorkerAvailability = { ...prev } as any;
                            for (const d of dayDefs) {
                              const cur = new Set(next[d.key] || []);
                              if (checked) {
                                cur.add(shiftName);
                              } else {
                                cur.delete(shiftName);
                              }
                              next[d.key] = Array.from(cur);
                            }
                            return next;
                          });
                        }
                        const morningAll = isAllSelected(morningName);
                        const noonAll = isAllSelected(noonName);
                        const nightAll = isAllSelected(nightName);
                        return (
                          <div className="mb-2 flex flex-wrap items-center justify-center gap-4 text-sm">
                            <label className="inline-flex items-center gap-2 opacity-100">
                              <input
                                type="checkbox"
                                disabled={!morningName}
                                checked={!!morningName && morningAll}
                                onChange={(e) => toggleAll(morningName, e.target.checked)}
                              />
                              כל הבוקר
                            </label>
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                disabled={!noonName}
                                checked={!!noonName && noonAll}
                                onChange={(e) => toggleAll(noonName, e.target.checked)}
                              />
                              כל הצהריים
                            </label>
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                disabled={!nightName}
                                checked={!!nightName && nightAll}
                                onChange={(e) => toggleAll(nightName, e.target.checked)}
                              />
                              כל הלילה
                            </label>
                          </div>
                        );
                      })()}
                      {dayDefs.map((d) => (
                        <div key={d.key} className="flex flex-wrap items-center justify-center gap-3 text-sm">
                          <div className="w-10 text-zinc-600 dark:text-zinc-300">{d.label}</div>
                          {allShiftNames.length === 0 ? (
                            <span className="text-zinc-500">אין משמרות פעילות</span>
                          ) : (
                            allShiftNames.map((sn) => (
                              <label key={sn} className="inline-flex items-center gap-1">
                                <input
                                  type="checkbox"
                                  checked={(newWorkerAvailability[d.key] || []).includes(sn)}
                                  onChange={() => toggleNewAvailability(d.key, sn)}
                                />
                                {sn}
                              </label>
                            ))
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsAddModalOpen(false)}
                      className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                      ביטול
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const trimmed = newWorkerName.trim();
                        if (!trimmed) return;
                        const DUP_MSG = "שם עובד כבר קיים באתר";
                        // eslint-disable-next-line no-console
                        console.log("[Workers] save clicked", { editingWorkerId, trimmed });
                        // Pré-vérification côté client pour éviter un aller-retour inutile
                        if (!editingWorkerId) {
                          // eslint-disable-next-line no-console
                          console.log("[Workers] checking duplicate (create)", { trimmed, workers });
                          if (workers.some((w) => (w.name || "").trim().toLowerCase() === trimmed.toLowerCase())) {
                            // eslint-disable-next-line no-console
                            console.log("[Workers] duplicate detected (create)");
                            toast.info(DUP_MSG);
                            return;
                          }
                        } else {
                          // eslint-disable-next-line no-console
                          console.log("[Workers] checking duplicate (update)", { editingWorkerId, trimmed, workers });
                          if (workers.some((w) => w.id !== editingWorkerId && (w.name || "").trim().toLowerCase() === trimmed.toLowerCase())) {
                            // eslint-disable-next-line no-console
                            console.log("[Workers] duplicate detected (update)");
                            toast.info(DUP_MSG);
                            return;
                          }
                        }
                        try {
                          if (editingWorkerId) {
                            // eslint-disable-next-line no-console
                            console.log("[Workers] calling API (PUT)");
                            const updated = await apiFetch<any>(`/director/sites/${params.id}/workers/${editingWorkerId}`, {
                              method: "PUT",
                              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                              body: JSON.stringify({
                                name: trimmed,
                                max_shifts: newWorkerMax,
                                roles: newWorkerRoles,
                                availability: newWorkerAvailability,
                              }),
                            });
                            // eslint-disable-next-line no-console
                            console.log("[Workers] API ok (PUT)", updated);
                            const mapped: Worker = {
                              id: updated.id,
                              name: updated.name,
                              maxShifts: updated.max_shifts ?? updated.maxShifts ?? 0,
                              roles: Array.isArray(updated.roles) ? updated.roles : [],
                              availability: updated.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
                            };
                            setWorkers((prev) => prev.map((x) => (x.id === editingWorkerId ? mapped : x)));
                            toast.success("עובד עודכן בהצלחה!");
                          } else {
                            // eslint-disable-next-line no-console
                            console.log("[Workers] calling API (POST)");
                            const created = await apiFetch<any>(`/director/sites/${params.id}/workers`, {
                              method: "POST",
                              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                              body: JSON.stringify({
                                name: trimmed,
                                max_shifts: newWorkerMax,
                                roles: newWorkerRoles,
                                availability: newWorkerAvailability,
                              }),
                            });
                            // eslint-disable-next-line no-console
                            console.log("[Workers] API ok (POST)", created);
                            const mapped: Worker = {
                              id: created.id,
                              name: created.name,
                              maxShifts: created.max_shifts ?? created.maxShifts ?? 0,
                              roles: Array.isArray(created.roles) ? created.roles : [],
                              availability: created.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
                            };
                            setWorkers((prev) => [...prev, mapped]);
                            toast.success("עובד נוסף בהצלחה!");
                          }
                          setEditingWorkerId(null);
                          setNewWorkerName("");
                          setNewWorkerMax(5);
                          setNewWorkerRoles([]);
                          setNewWorkerAvailability({ sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });
                          setIsAddModalOpen(false);
                        } catch (e: any) {
                          const msg = String(e?.message || "");
                          // eslint-disable-next-line no-console
                          console.log("[Workers] save error", { status: e?.status, message: msg, raw: e });
                          if ((e?.status === 400 && msg.includes(DUP_MSG)) || msg.includes(DUP_MSG)) {
                            // eslint-disable-next-line no-console
                            console.log("[Workers] duplicate detected (backend)");
                            toast.info(DUP_MSG);
                            return;
                          }
                          toast.error("שמירה נכשלה", { description: msg || "נסה שוב מאוחר יותר." });
                        }
                      }}
                      className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6]"
                    >
                      שמור
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Grilles hebdomadaires par עמדה */}
            <section className="space-y-4">
              <h2 className="text-lg font-semibold text-center">
                גריד שבועי לפי עמדה
              </h2>
              <div className="flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsManual(false)}
                  className={
                    "inline-flex items-center rounded-md border px-3 py-1 text-sm " +
                    (isManual ? "opacity-60 dark:border-zinc-700" : "bg-[#00A8E0] text-white border-[#00A8E0]")
                  }
                >
                  אוטומטי
                </button>
                <button
                  type="button"
                  onClick={() => setIsManual(true)}
                  className={
                    "inline-flex items-center rounded-md border px-3 py-1 text-sm " +
                    (isManual ? "bg-[#00A8E0] text-white border-[#00A8E0]" : "dark:border-zinc-700")
                  }
                >
                  ידני
                </button>
              </div>
              <div className="flex items-center justify-between gap-3 text-sm text-zinc-600 dark:text-zinc-300">
                <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label="שבוע קודם"
                  onClick={() => setWeekStart((prev) => addDays(prev, -7))}
                  className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
                </button>
                <span>
                  {(() => {
                    const end = addDays(weekStart, 6);
                    return `שבוע: ${formatHebDate(weekStart)} — ${formatHebDate(end)}`;
                  })()}
                </span>
                <button
                  type="button"
                  aria-label="שבוע הבא"
                  onClick={() => setWeekStart((prev) => addDays(prev, 7))}
                  className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (isManual) {
                      setManualAssignments(null);
                      setManualRoleHints(null);
                    } else {
                      setAiPlan(null);
                    }
                  }}
                  className="inline-flex items-center rounded-md border border-red-300 px-3 py-1 text-sm text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
                >
                  איפוס
                </button>
              </div>
              {(() => {
                const dayCols = [
                  { key: "sun", label: "א'" },
                  { key: "mon", label: "ב'" },
                  { key: "tue", label: "ג'" },
                  { key: "wed", label: "ד'" },
                  { key: "thu", label: "ה'" },
                  { key: "fri", label: "ו'" },
                  { key: "sat", label: "ש'" },
                ];
                function getRequiredFor(st: any, shiftName: string, dayKey: string): number {
                  if (!st) return 0;
                  // Mode personnalisation par jour
                  if (st.perDayCustom) {
                    const dayCfg = st.dayOverrides?.[dayKey];
                    if (!dayCfg || dayCfg.active === false) return 0;
                    if (st.uniformRoles) {
                      // En mode uniforme, le nombre d'employés requis est celui défini pour l'עמדה
                      return Number(st.workers || 0);
                    }
                    const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
                    if (!sh || !sh.enabled) return 0;
                    return Number(sh.workers || 0);
                  }
                  // Mode global (pas par jour)
                  if (st.days && st.days[dayKey] === false) return 0;
                  if (st.uniformRoles) {
                    return Number(st.workers || 0);
                  }
                  const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
                  if (!sh || !sh.enabled) return 0;
                  return Number(sh.workers || 0);
                }
                function isDayActive(st: any, dayKey: string): boolean {
                  if (!st) return false;
                  if (st.perDayCustom) {
                    const dayCfg = st.dayOverrides?.[dayKey];
                    return !!(dayCfg && dayCfg.active);
                  }
                  if (st.days && Object.prototype.hasOwnProperty.call(st.days, dayKey)) {
                    return st.days[dayKey] !== false;
                  }
                  return true; // par défaut actif si non précisé
                }
                const shiftNamesAll: string[] = Array.from(
                  new Set(
                    (site?.config?.stations || [])
                      .flatMap((st: any) => (st?.shifts || [])
                        .filter((sh: any) => sh?.enabled)
                        .map((sh: any) => sh?.name))
                      .filter(Boolean)
                  )
                );
                function hoursOf(sn: string): string | null {
                  const s = String(sn || "");
                  // direct numeric pattern like 06-14 or 14:22
                  const m = s.match(/(\d{1,2})\s*[-:–]\s*(\d{1,2})/);
                  if (m) {
                    const a = m[1].padStart(2, "0");
                    const b = m[2].padStart(2, "0");
                    return `${a}–${b}`;
                  }
                  // Hebrew/english names
                  if (/בוקר/i.test(s)) return "06–14";
                  if (/צהר(יים|י)ם?/i.test(s)) return "14–22";
                  if (/לילה|night/i.test(s)) return "22–06";
                  return null;
                }
                function hoursFromConfig(station: any, shiftName: string): string | null {
                  if (!station) return null;
                  function fmt(start?: string, end?: string): string | null {
                    if (!start || !end) return null;
                    return `${start}–${end}`;
                  }
                  if (station.perDayCustom && station.dayOverrides) {
                    const order = ["sun","mon","tue","wed","thu","fri","sat"];
                    for (const key of order) {
                      const dcfg = station.dayOverrides?.[key];
                      if (!dcfg || dcfg.active === false) continue;
                      const sh = (dcfg.shifts || []).find((x: any) => x?.name === shiftName);
                      const f = fmt(sh?.start, sh?.end);
                      if (f) return f;
                    }
                  }
                  const base = (station.shifts || []).find((x: any) => x?.name === shiftName);
                  return fmt(base?.start, base?.end);
                }
                function roleRequirements(st: any, shiftName: string, dayKey: string): Record<string, number> {
                  const out: Record<string, number> = {};
                  if (!st) return out;
                  const pushRole = (name?: string, count?: number, enabled?: boolean) => {
                    const rn = (name || "").trim();
                    const c = Number(count || 0);
                    if (!rn || !enabled || c <= 0) return;
                    out[rn] = (out[rn] || 0) + c;
                  };
                  if (st.perDayCustom) {
                    const dayCfg = st.dayOverrides?.[dayKey];
                    if (!dayCfg || dayCfg.active === false) return out;
                    if (st.uniformRoles) {
                      for (const r of (st.roles || [])) pushRole(r?.name, r?.count, r?.enabled);
                    } else {
                      const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
                      for (const r of ((sh?.roles as any[]) || [])) pushRole(r?.name, r?.count, r?.enabled);
                    }
                    return out;
                  }
                  // global mode
                  if (st.uniformRoles) {
                    for (const r of (st.roles || [])) pushRole(r?.name, r?.count, r?.enabled);
                  } else {
                    const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
                    for (const r of ((sh?.roles as any[]) || [])) pushRole(r?.name, r?.count, r?.enabled);
                  }
                  return out;
                }
                // Normalisation robuste des libellés de rôle pour éviter les mismatches (casse/espaces/forme)
                function normRole(n: string): string {
                  return (n || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
                }
                function nameHasRole(name: string, roleName: string): boolean {
                  const w = workers.find((x) => (x.name || "").trim() === (name || "").trim());
                  if (!w) return false;
                  const target = normRole(roleName);
                  return (w.roles || []).some((r) => normRole(String(r)) === target);
                }
                function assignRoles(assignedNames: string[], st: any, shiftName: string, dayKey: string): Map<string, string | null> {
                  const req = roleRequirements(st, shiftName, dayKey);
                  const res = new Map<string, string | null>();
                  const used = new Set<number>();
                  // prefill null
                  assignedNames.forEach((nm) => res.set(nm, null));
                  // greedy fill per role
                  for (const [rName, rCount] of Object.entries(req)) {
                    let left = rCount;
                    if (left <= 0) continue;
                    for (let i = 0; i < assignedNames.length && left > 0; i++) {
                      if (used.has(i)) continue;
                      const nm = assignedNames[i];
                      if (!nameHasRole(nm, rName)) continue;
                      res.set(nm, rName);
                      used.add(i);
                      left--;
                    }
                  }
                  return res;
                }
                return (
                  <div className="space-y-6">
                    {(site?.config?.stations || []).map((st: any, idx: number) => (
                      <div key={idx} className="rounded-xl border p-3 dark:border-zinc-800">
                        <div className="mb-2 flex items-center justify-between">
                          <div className="text-base font-medium">{st.name}</div>
                          <button
                            type="button"
                            onClick={() => {
                              if (isManual) {
                                setManualAssignments((prev) => {
                                  if (!prev) return prev;
                                  const base = JSON.parse(JSON.stringify(prev));
                                  const dayKeys = ["sun","mon","tue","wed","thu","fri","sat"];
                                  const shiftNames = Array.from(
                                    new Set(
                                      (site?.config?.stations || [])
                                        .flatMap((station: any) => (station?.shifts || [])
                                          .filter((sh: any) => sh?.enabled)
                                          .map((sh: any) => sh?.name))
                                        .filter(Boolean)
                                    )
                                  );
                                  for (const d of dayKeys) {
                                    const dayData: any = (base as any)[d];
                                    if (!dayData) continue;
                                    for (const sn of shiftNames) {
                                      // @ts-ignore
                                      const shiftData: any = dayData[sn];
                                      if (!shiftData) continue;
                                      const arr = shiftData as any;
                                      if (Array.isArray(arr) && Array.isArray(arr[idx])) {
                                        arr[idx] = [];
                                      }
                                    }
                                  }
                                  return base;
                                });
                                setManualRoleHints((prevHints) => {
                                  if (!prevHints) return prevHints;
                                  const base = JSON.parse(JSON.stringify(prevHints));
                                  const dayKeys = ["sun","mon","tue","wed","thu","fri","sat"];
                                  const shiftNames = Array.from(
                                    new Set(
                                      (site?.config?.stations || [])
                                        .flatMap((station: any) => (station?.shifts || [])
                                          .filter((sh: any) => sh?.enabled)
                                          .map((sh: any) => sh?.name))
                                        .filter(Boolean)
                                    )
                                  );
                                  for (const d of dayKeys) {
                                    const dayData: any = (base as any)[d];
                                    if (!dayData) continue;
                                    for (const sn of shiftNames) {
                                      // @ts-ignore
                                      const shiftData: any = dayData[sn];
                                      if (!shiftData) continue;
                                      const arr = shiftData as any;
                                      if (Array.isArray(arr) && Array.isArray(arr[idx])) {
                                        arr[idx] = [];
                                      }
                                    }
                                  }
                                  return base;
                                });
                              } else {
                                setAiPlan((prev) => {
                                  if (!prev || !prev.assignments) return prev;
                                  const base = JSON.parse(JSON.stringify(prev));
                                  const dayKeys = ["sun","mon","tue","wed","thu","fri","sat"];
                                  const shiftNames = Array.from(
                                    new Set(
                                      (site?.config?.stations || [])
                                        .flatMap((station: any) => (station?.shifts || [])
                                          .filter((sh: any) => sh?.enabled)
                                          .map((sh: any) => sh?.name))
                                        .filter(Boolean)
                                    )
                                  );
                                  for (const d of dayKeys) {
                                    const dayData: any = base.assignments[d];
                                    if (!dayData) continue;
                                    for (const sn of shiftNames) {
                                      // @ts-ignore
                                      const shiftData: any = (dayData as any)[sn];
                                      if (!shiftData) continue;
                                      const arr = shiftData as any;
                                      if (Array.isArray(arr) && Array.isArray(arr[idx])) {
                                        arr[idx] = [];
                                      }
                                    }
                                  }
                                  return base;
                                });
                              }
                            }}
                            className="inline-flex items-center rounded-md border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
                          >
                            איפוס עמדה
                          </button>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full border-collapse text-sm table-fixed">
                            <thead>
                              <tr className="border-b dark:border-zinc-800">
                                <th className="px-2 py-2 text-right align-bottom w-28">משמרת</th>
                                {dayCols.map((d, i) => {
                                  const date = addDays(weekStart, i);
                                  return (
                                    <th key={d.key} className="px-2 py-2 text-center align-bottom">
                                      <div className="flex flex-col items-center leading-tight">
                                        <span className="text-xs text-zinc-500">{formatHebDate(date)}</span>
                                        <span className="mt-0.5">{d.label}</span>
                                      </div>
                                    </th>
                                  );
                                })}
                              </tr>
                            </thead>
                            <tbody>
                              {shiftNamesAll.map((sn) => {
                                const stationShift = (st.shifts || []).find((x: any) => x?.name === sn);
                                const enabled = !!stationShift?.enabled;
                                return (
                                  <tr key={sn} className="border-b last:border-0 dark:border-zinc-800">
                                <td className="px-2 py-2 w-28">
                                  <div className="flex flex-col items-start">
                                    {(() => {
                                      const h = hoursFromConfig(st, sn) || hoursOf(sn);
                                      return h ? (
                                        <div className="text-[10px] leading-none text-zinc-500 mb-0.5">{h}</div>
                                      ) : null;
                                    })()}
                                    <div className="font-medium">{sn}</div>
                                  </div>
                                </td>
                                    {dayCols.map((d) => {
                                      const required = getRequiredFor(st, sn, d.key);
                                      const assignedNames: string[] = (() => {
                                        if (isManual) {
                                          const cell = (manualAssignments as any)?.[d.key]?.[sn]?.[idx];
                                          return Array.isArray(cell) ? cell : [];
                                        }
                                        if (!aiPlan) return [];
                                        const cell = aiPlan.assignments?.[d.key]?.[sn]?.[idx];
                                        if (!cell) return [];
                                        return cell;
                                      })();
                                      const roleMap = assignRoles(assignedNames, st, sn, d.key);
                                      const assignedCount = isManual ? (assignedNames.filter(Boolean).length) : assignedNames.length;
                                      const activeDay = isDayActive(st, d.key);
                                      return (
                                        <td
                                          key={d.key}
                                          className={
                                            "px-2 py-2 text-center " +
                                            (enabled ? "" : "text-zinc-400 ") +
                                            (!activeDay ? "bg-zinc-100 text-zinc-400 dark:bg-zinc-900/40 " : "")
                                          }
                                        >
                                        {enabled ? (
                                            <div
                                              className="flex flex-col items-center"
                                              onDragOver={isManual ? (e) => { e.preventDefault(); try { (e as any).dataTransfer.dropEffect = "copy"; } catch {} } : undefined}
                                              onDrop={isManual ? (e) => onCellContainerDrop(e, d.key, sn, idx) : undefined}
                                            >
                                              {required > 0 ? (
                                                <div className="mb-1 flex flex-col items-center gap-1 min-w-full">
                                                  {isManual ? (
                                                    <div className="flex flex-col items-center gap-1 w-full px-2 py-1">
                                                  {(() => {
                                                    const reqRoles = roleRequirements(st, sn, d.key);
                                                        // Count only roles actually matched by slot hint and worker capability
                                                    const assignedPerRole = new Map<string, number>();
                                                        // We'll construct roleHints after seeing how many are already fulfilled
                                                        // First pass: determine which assigned names satisfy a hinted role
                                                        // roleHints will be filled by remaining deficits below
                                                        const roleHints: string[] = [];
                                                        // Compute deficits based on current satisfied roles
                                                        assignedNames.forEach((nm, i) => {
                                                          const hint = roleHints[i];
                                                          // roleHints not yet filled; we need to compute satisfied counts against reqRoles; use worker capability and station reqRoles keys
                                                          const workerHasRole = (rName: string) => nameHasRole(nm, rName);
                                                          // If there is an existing hint array not built yet, skip; instead, we consider only explicit matching when hint exists; since not built yet, we can't rely.
                                                        });
                                                        // Build role hints list by deficits relative to satisfied counts
                                                        const satisfiedPerRole = new Map<string, number>();
                                                        // satisfiedPerRole: count matches at slots that explicitly carry that role hint and worker can fill it
                                                        // Since we haven't built slot hints yet at this point, we consider current assigned names contribute nothing to satisfied; hints will represent deficits entirely.
                                                    Object.entries(reqRoles).forEach(([rName, rCount]) => {
                                                          const have = satisfiedPerRole.get(rName) || 0;
                                                      const deficit = Math.max(0, (rCount || 0) - have);
                                                          for (let i = 0; i < deficit; i++) roleHints.push(rName);
                                                        });
                                                        const slots = Math.max(required, assignedNames.length, roleHints.length, 1);
                                                        return Array.from({ length: slots }).map((_, slotIdx) => {
                                                          const nm = assignedNames[slotIdx];
                                                          if (nm) {
                                                            const c = colorForName(nm);
                                                            const hintedStored = ((manualRoleHints as any)?.[d.key]?.[sn]?.[idx]?.[slotIdx] ?? null) as (string | null);
                                                            const hinted = (hintedStored ?? roleHints[slotIdx] ?? null) as (string | null);
                                                            const rn = hinted && nameHasRole(nm, hinted) ? hinted : null;
                                                            const rc = rn ? colorForRole(rn) : null;
                                                            return (
                                                              <div
                                                                key={"slot-nm-wrapper-" + slotIdx}
                                                                className="w-full flex justify-center py-0.5"
                                                                onDragEnter={(e) => {
                                                                  e.preventDefault();
                                                                  e.stopPropagation();
                                                                  setHoverSlotKey(`${d.key}|${sn}|${idx}|${slotIdx}`);
                                                                }}
                                                                onDragLeave={(e) => {
                                                                  const rect = e.currentTarget.getBoundingClientRect();
                                                                  const x = e.clientX;
                                                                  const y = e.clientY;
                                                                  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
                                                                    setHoverSlotKey((k) => (k === `${d.key}|${sn}|${idx}|${slotIdx}` ? null : k));
                                                                  }
                                                                }}
                                                                onDragOver={onSlotDragOver}
                                                                onDrop={(e) => onSlotDrop(e, d.key, sn, idx, slotIdx)}
                                                                data-slot="1"
                                                                data-dkey={d.key}
                                                                data-sname={sn}
                                                                data-stidx={idx}
                                                                data-slotidx={slotIdx}
                                                              >
                      <span
                                                                  key={"slot-nm-" + slotIdx}
                                                                  className={
                                                                    "inline-flex h-9 min-w-[4rem] max-w-[6rem] items-center rounded-full border px-3 py-1 shadow-sm gap-2 select-none transition-transform " +
                                                                    (hoverSlotKey === `${d.key}|${sn}|${idx}|${slotIdx}` ? "scale-110 ring-2 ring-[#00A8E0]" : "")
                                                                  }
                                                                  style={{ backgroundColor: c.bg, borderColor: (rc?.border || c.border), color: c.text }}
                                                                  draggable
                                                                  onDragStart={(e) => onWorkerDragStart(e, nm)}
                                                                  data-slot="1"
                                                                  data-dkey={d.key}
                                                                  data-sname={sn}
                                                                  data-stidx={idx}
                                                                  data-slotidx={slotIdx}
                                                                >
                                                                  <span className="flex flex-col items-center leading-tight">
                                                                    {rn ? (
                                                                      <span className="text-[10px] font-medium text-zinc-700 dark:text-zinc-300 max-w-[6rem] truncate mb-0.5">{rn}</span>
                                                                    ) : null}
                                                                    <span className="text-sm">{nm}</span>
                                                                  </span>
                                                                  <button
                                                                    type="button"
                                                                    aria-label="הסר"
                                                                    title="הסר"
                                                                    onClick={(e) => {
                                                                      e.stopPropagation();
                                                                      setManualAssignments((prev) => {
                                                                        if (!prev) return prev;
                                                                        const base = JSON.parse(JSON.stringify(prev));
                                                                        const arr: string[] = base[d.key]?.[sn]?.[idx] || [];
                                                                        base[d.key] = base[d.key] || {};
                                                                        base[d.key][sn] = base[d.key][sn] || [];
                                                                        base[d.key][sn][idx] = (arr as string[]).map((x: string, i: number) => (i === slotIdx ? "" : x)).filter(Boolean);
                                                                        return base;
                                                                      });
                                                                    }}
                                                                    className="inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs hover:bg-white/50 dark:hover:bg-zinc-800/60"
                                                                    style={{ borderColor: (rc?.border || c.border), color: c.text }}
                                                                  >
                                                                    ×
                                                                  </button>
                                                                </span>
                                                              </div>
                                                            );
                                                          }
                                                          const hint = ((manualRoleHints as any)?.[d.key]?.[sn]?.[idx]?.[slotIdx] ?? roleHints[slotIdx] ?? null) as (string | null);
                                                          if (hint) {
                                                            const rc = colorForRole(hint);
                                                            return (
                                                              <div
                                                                key={"slot-hint-wrapper-" + slotIdx}
                                                                className="w-full flex justify-center py-0.5"
                                                                onDragEnter={(e) => {
                                                                  e.preventDefault();
                                                                  e.stopPropagation();
                                                                  setHoverSlotKey(`${d.key}|${sn}|${idx}|${slotIdx}`);
                                                                }}
                                                                onDragLeave={(e) => {
                                                                  const rect = e.currentTarget.getBoundingClientRect();
                                                                  const x = e.clientX;
                                                                  const y = e.clientY;
                                                                  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
                                                                    setHoverSlotKey((k) => (k === `${d.key}|${sn}|${idx}|${slotIdx}` ? null : k));
                                                                  }
                                                                }}
                                                                onDragOver={onSlotDragOver}
                                                                onDrop={(e) => onSlotDrop(e, d.key, sn, idx, slotIdx)}
                                                                data-slot="1"
                                                                data-dkey={d.key}
                                                                data-sname={sn}
                                                                data-stidx={idx}
                                                                data-slotidx={slotIdx}
                                                                data-rolehint={hint}
                                                              >
                                                                <span
                                                                  className={
                                                                    "inline-flex h-9 min-w-[4rem] max-w-[6rem] flex-col items-center justify-center rounded-full border px-3 py-1 bg-white dark:bg-zinc-900 transition-transform cursor-pointer " +
                                                                    (hoverSlotKey === `${d.key}|${sn}|${idx}|${slotIdx}` ? "scale-110 ring-2 ring-[#00A8E0]" : "")
                                                                  }
                                                                  style={{ borderColor: rc.border }}
                      >
                                                                  <span className="text-[10px] font-medium" style={{ color: rc.text }}>{hint}</span>
                        <span className="text-xs leading-none text-zinc-400 dark:text-zinc-400">—</span>
                      </span>
                                                              </div>
                    );
                  }
                                                          return (
                                                              <div
                                                                key={"slot-empty-wrapper-" + slotIdx}
                                                                className="w-full flex justify-center py-0.5"
                                                                onDragEnter={(e) => {
                                                                  e.preventDefault();
                                                                  e.stopPropagation();
                                                                  setHoverSlotKey(`${d.key}|${sn}|${idx}|${slotIdx}`);
                                                                }}
                                                                onDragLeave={(e) => {
                                                                  const rect = e.currentTarget.getBoundingClientRect();
                                                                  const x = e.clientX;
                                                                  const y = e.clientY;
                                                                  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
                                                                    setHoverSlotKey((k) => (k === `${d.key}|${sn}|${idx}|${slotIdx}` ? null : k));
                                                                  }
                                                                }}
                                                                onDragOver={onSlotDragOver}
                                                                onDrop={(e) => onSlotDrop(e, d.key, sn, idx, slotIdx)}
                                                                data-slot="1"
                                                                data-dkey={d.key}
                                                                data-sname={sn}
                                                                data-stidx={idx}
                                                                data-slotidx={slotIdx}
                                                              >
                                                      <span
                                                                  key={"slot-empty-" + slotIdx}
                                                                  className={
                                                                    "inline-flex h-9 min-w-[4rem] max-w-[6rem] items-center justify-center rounded-full border px-3 py-1 text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700 transition-transform cursor-pointer " +
                                                                    (hoverSlotKey === `${d.key}|${sn}|${idx}|${slotIdx}` ? "scale-110 ring-2 ring-[#00A8E0]" : "")
                                                                  }
                                                      >
                                                        —
                                                      </span>
                                                              </div>
                                                          );
                                                        });
                                                      })()}
                                                    </div>
                                                  ) : (
                                                    (() => {
                                                      const reqRoles = roleRequirements(st, sn, d.key);
                                                      // Créer un plan de slots avec positions fixes pour les rôles
                                                      // Chaque rôle requis a un slot fixe, même s'il est vide
                                                      type SlotType = { type: 'assigned' | 'role-empty' | 'neutral-empty', name?: string, role?: string | null, roleHint?: string };
                                                      const slots: SlotType[] = [];
                                                      
                                                      // Créer un slot pour chaque rôle requis (dans l'ordre des rôles)
                                                      Object.entries(reqRoles).forEach(([rName, rCount]) => {
                                                        for (let i = 0; i < (rCount || 0); i++) {
                                                          slots.push({ type: 'role-empty', roleHint: rName });
                                                        }
                                                      });
                                                      
                                                      // Compter les assignations par rôle
                                                      const assignedPerRole = new Map<string, number>();
                                                      roleMap.forEach((rName) => {
                                                        if (!rName) return;
                                                        assignedPerRole.set(rName, (assignedPerRole.get(rName) || 0) + 1);
                                                      });
                                                      
                                                      // Remplir les slots de rôle avec les assignations correspondantes
                                                      const usedSlots = new Set<number>();
                                                      const assignedWithoutRole: Array<{ name: string, index: number }> = [];
                                                      
                                                      // D'abord remplir les slots de rôle avec les assignations qui ont ce rôle
                                                      assignedNames.forEach((nm, i) => {
                                                        if (!nm) return;
                                                        const assignedRole = roleMap.get(nm) || null;
                                                        if (assignedRole) {
                                                          // Trouver le premier slot vide pour ce rôle
                                                          for (let j = 0; j < slots.length; j++) {
                                                            if (usedSlots.has(j)) continue;
                                                            if (slots[j].roleHint === assignedRole) {
                                                              slots[j] = { type: 'assigned', name: nm, role: assignedRole };
                                                              usedSlots.add(j);
                                                              assignedPerRole.set(assignedRole, (assignedPerRole.get(assignedRole) || 0) - 1);
                                                              break;
                                                            }
                                                          }
                                                        } else {
                                                          assignedWithoutRole.push({ name: nm, index: i });
                                                        }
                                                      });
                                                      
                                                      // Ajouter les slots sans rôle pour les assignations restantes
                                                      const totalRoleSlots = slots.length;
                                                      const remainingRequired = Math.max(0, required - totalRoleSlots);
                                                      for (let i = 0; i < remainingRequired; i++) {
                                                        slots.push({ type: 'neutral-empty' });
                                                      }
                                                      
                                                      // Remplir les slots sans rôle avec les assignations restantes
                                                      let neutralSlotIdx = totalRoleSlots;
                                                      assignedWithoutRole.forEach(({ name }) => {
                                                        if (neutralSlotIdx < slots.length) {
                                                          slots[neutralSlotIdx] = { type: 'assigned', name: name, role: null };
                                                          neutralSlotIdx++;
                                                        }
                                                      });
                                                      
                                                      const renderChip = (nm: string, i: number, rn: string | null) => {
                                                          const c = colorForName(nm);
                                                          const rc = rn ? colorForRole(rn) : null;
                                                          return (
                                                            <div
                                                              key={"chip-wrapper-" + i}
                                                              className="w-full flex justify-center py-0.5"
                                                            >
                                                            <span
                                                              key={"nm-" + i}
                                                                className="inline-flex h-9 min-w-[4rem] max-w-[6rem] items-center rounded-full border px-3 py-1 shadow-sm gap-2"
                                                              style={{ backgroundColor: c.bg, borderColor: (rc?.border || c.border), color: c.text }}
                                                            >
                                                              <span className="flex flex-col items-center leading-tight">
                                                                {rn ? (
                                                                  <span className="text-[10px] font-medium text-zinc-700 dark:text-zinc-300 max-w-[6rem] truncate mb-0.5">{rn}</span>
                                                                ) : null}
                                                                <span className="text-sm">{nm}</span>
                                                              </span>
                                                            </span>
                                                            </div>
                                                          );
                                                      };
                                                      
                                                      return (
                                                        <div className="flex flex-col items-center gap-1 w-full px-2 py-1">
                                                          {slots.map((slot, idx) => {
                                                            if (slot.type === 'assigned' && slot.name) {
                                                              return renderChip(slot.name, idx, slot.role ?? null);
                                                            } else if (slot.type === 'role-empty' && slot.roleHint) {
                                                              const c = colorForRole(slot.roleHint);
                                                              return (
                                                                <div
                                                                  key={`roleph-wrapper-${slot.roleHint}-${idx}`}
                                                                  className="w-full flex justify-center py-0.5"
                                                                >
                                                                  <span
                                                                    key={`roleph-${slot.roleHint}-${idx}`}
                                                                    className="inline-flex h-9 min-w-[4rem] max-w-[6rem] flex-col items-center justify-center rounded-full border px-3 py-1 bg-white dark:bg-zinc-900"
                                                                    style={{ borderColor: c.border }}
                                                                  >
                                                                    <span className="text-[10px] font-medium" style={{ color: c.text }}>{slot.roleHint}</span>
                                                                    <span className="text-xs leading-none text-zinc-400 dark:text-zinc-400">—</span>
                                                                  </span>
                                                                </div>
                                                              );
                                                            } else {
                                                              return (
                                                                <div
                                                                  key={"empty-wrapper-" + idx}
                                                                  className="w-full flex justify-center py-0.5"
                                                                >
                                                                  <span
                                                                    key={"empty-" + idx}
                                                                    className="inline-flex h-9 min-w-[4rem] max-w-[6rem] items-center justify-center rounded-full border px-3 py-1 text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700"
                                                                  >
                                                                    —
                                                                  </span>
                                                                </div>
                                                              );
                                                            }
                                                          })}
                                                        </div>
                                                    );
                                                    })()
                                                  )}
                                                </div>
                                              ) : null}
                                              <span
                                                className={
                                                "text-xs " + (
                                                    assignedCount < required
                                                    ? "text-red-600 dark:text-red-400"
                                                      : (required > 0 && assignedCount >= required
                                                        ? "text-green-600 dark:text-green-400"
                                                        : "")
                                                )
                                                }
                                              >
                                                {"שיבוצים: "}{assignedCount}
                                              </span>
                                              <span className="text-xs text-zinc-500">נדרש: {required}</span>
                                          </div>
                                        ) : (
                                          <span className="text-xs">לא פעיל</span>
                                        )}
                                      </td>
                                      );
                                    })}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {isManual && (
                          <div className="mt-3">
                            <div className="mb-1 text-xs text-zinc-600 dark:text-zinc-300 text-center">גרור/י עובד אל תא השיבוץ</div>
                            <div className="flex flex-wrap items-center justify-center gap-2">
                              {workers.filter((w) => !hiddenWorkerIds.includes(w.id)).map((w) => {
                                const c = colorForName(w.name);
                                return (
                                  <span
                                    key={w.id}
                                    draggable
                                    onDragStart={(e) => onWorkerDragStart(e, w.name)}
                                    className="inline-flex items-center rounded-full border px-3 py-1 text-sm shadow-sm select-none cursor-grab active:cursor-grabbing"
                                    style={{ backgroundColor: c.bg, borderColor: c.border, color: c.text }}
                                  >
                                    {w.name}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        )}
                    {/* per-station summary removed; replaced by global summary below */}
                      </div>
                    ))}
                  </div>
                );
              })()}
              {aiPlan && !isManual && (
                <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
                  <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">סיכום שיבוצים לעמדה (כל העמדות)</div>
                  {(() => {
                    const counts = new Map<string, number>();
                    const days = Object.keys(aiPlan.assignments || {});
                    for (const dKey of days) {
                      const shiftsMap = (aiPlan.assignments as any)[dKey] || {};
                      for (const sn of Object.keys(shiftsMap)) {
                        const perStation: string[][] = shiftsMap[sn] || [];
                        for (const namesHere of perStation) {
                          for (const nm of (namesHere || [])) {
                            counts.set(nm, (counts.get(nm) || 0) + 1);
                          }
                        }
                      }
                    }
                  // Totaux globaux: נדרש (required) et שיבוצים (assignés)
                  const stationsCfgAll: any[] = (site?.config?.stations || []) as any[];
                  function requiredForSummary(st: any, shiftName: string, dayKey: string): number {
                    if (!st) return 0;
                    if (st.perDayCustom) {
                      const dayCfg = st.dayOverrides?.[dayKey];
                      if (!dayCfg || dayCfg.active === false) return 0;
                      if (st.uniformRoles) return Number(st.workers || 0);
                      const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
                      if (!sh || !sh.enabled) return 0;
                      return Number(sh.workers || 0);
                    }
                    if (st.days && st.days[dayKey] === false) return 0;
                    if (st.uniformRoles) return Number(st.workers || 0);
                    const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
                    if (!sh || !sh.enabled) return 0;
                    return Number(sh.workers || 0);
                  }
                  let totalRequired = 0;
                  for (const dKey of days) {
                    const shiftsMap = (aiPlan.assignments as any)[dKey] || {};
                    for (const sn of Object.keys(shiftsMap)) {
                      for (let tIdx = 0; tIdx < stationsCfgAll.length; tIdx++) {
                        totalRequired += requiredForSummary(stationsCfgAll[tIdx], sn, dKey);
                      }
                    }
                  }
                  const totalAssigned = Array.from(counts.values()).reduce((a, b) => a + b, 0);
                    // Compléter avec tous les travailleurs (compte 0 si non assigné)
                    workers.forEach((w) => {
                      if (!counts.has(w.name)) counts.set(w.name, 0);
                    });
                    // Ordre stable: suivre l'ordre d'apparition dans la liste 'workers'
                    const order = new Map<string, number>();
                    workers.forEach((w, i) => order.set(w.name, i));
                    const items = Array.from(counts.entries())
                      .sort((a, b) => {
                        const ia = order.has(a[0]) ? (order.get(a[0]) as number) : Number.MAX_SAFE_INTEGER;
                        const ib = order.has(b[0]) ? (order.get(b[0]) as number) : Number.MAX_SAFE_INTEGER;
                        if (ia !== ib) return ia - ib;
                        return a[0].localeCompare(b[0]);
                      });
                    if (workers.length === 0) {
                      return <div className="text-sm text-zinc-500">אין שיבוצים</div>;
                    }
                    return (
                      <>
                        <div className="mb-2 flex items-center justify-end gap-6 text-sm">
                          <div>סה"כ נדרש: <span className="font-medium">{totalRequired}</span></div>
                          <div>סה"כ שיבוצים: <span className="font-medium">{totalAssigned}</span></div>
                        </div>
                        <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm table-fixed">
                          <thead>
                            <tr className="border-b dark:border-zinc-800">
                              <th className="px-2 py-2 text-right w-64">עובד</th>
                              <th className="px-2 py-2 text-right w-28">מס' משמרות</th>
                            </tr>
                          </thead>
                          <tbody>
                            {items.map(([nm, c]) => {
                              const col = colorForName(nm);
                              return (
                                <tr key={nm} className="border-b last:border-0 dark:border-zinc-800">
                                  <td className="px-2 py-2 w-64">
                                    <span className="inline-flex items-center rounded-full border px-3 py-1 text-sm shadow-sm" style={{ backgroundColor: col.bg, borderColor: col.border, color: col.text }}>
                                      {nm}
                                    </span>
                                  </td>
                                  <td className="px-2 py-2 w-28">{c}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        {(() => {
                          // Récap par תפקיד
                          const roleTotals = new Map<string, number>();
                          const stationsCfg: any[] = (site?.config?.stations || []) as any[];
                          const getStationCfg = (tIdx: number) => stationsCfg[tIdx] || null;
                          const dayKeys = Object.keys(aiPlan.assignments || {});
                          function roleRequirementsLocal(st: any, shiftName: string, dayKey: string): Record<string, number> {
                            const out: Record<string, number> = {};
                            const push = (name?: string, count?: number, enabled?: boolean) => {
                              const rn = (name || "").trim();
                              const c = Number(count || 0);
                              if (!rn || !enabled || c <= 0) return; out[rn] = (out[rn] || 0) + c;
                            };
                            if (!st) return out;
                            if (st.perDayCustom) {
                              const dayCfg = st.dayOverrides?.[dayKey];
                              if (!dayCfg || dayCfg.active === false) return out;
                              if (st.uniformRoles) {
                                for (const r of (st.roles || [])) push(r?.name, r?.count, r?.enabled);
                              } else {
                                const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
                                for (const r of ((sh?.roles as any[]) || [])) push(r?.name, r?.count, r?.enabled);
                              }
                              return out;
                            }
                            if (st.uniformRoles) {
                              for (const r of (st.roles || [])) push(r?.name, r?.count, r?.enabled);
                            } else {
                              const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
                              for (const r of ((sh?.roles as any[]) || [])) push(r?.name, r?.count, r?.enabled);
                            }
                            return out;
                          }
                          function assignRolesLocal(assignedNames: string[], st: any, shiftName: string, dayKey: string): Map<string, string | null> {
                            const req = roleRequirementsLocal(st, shiftName, dayKey);
                            const res = new Map<string, string | null>();
                            const used = new Set<number>();
                            assignedNames.forEach((nm) => res.set(nm, null));
                            for (const [rName, rCount] of Object.entries(req)) {
                              let left = rCount;
                              if (left <= 0) continue;
                              for (let i = 0; i < assignedNames.length && left > 0; i++) {
                                if (used.has(i)) continue;
                                const nm = assignedNames[i];
                                const w = workers.find((x) => (x.name || "").trim() === (nm || "").trim());
                                const has = !!w && (w.roles || []).includes(rName);
                                if (!has) continue;
                                res.set(nm, rName);
                                used.add(i);
                                left--;
                              }
                            }
                            return res;
                          }
                          // parcours des cellules
                          dayKeys.forEach((dKey) => {
                            const shiftsMap = (aiPlan.assignments as any)[dKey] || {};
                            for (const sn of Object.keys(shiftsMap)) {
                              const perStation: string[][] = shiftsMap[sn] || [];
                              perStation.forEach((namesHere, tIdx) => {
                                const stCfg = getStationCfg(tIdx);
                                const m = assignRolesLocal(namesHere || [], stCfg, sn, dKey);
                                m.forEach((rName) => {
                                  if (!rName) return;
                                  roleTotals.set(rName, (roleTotals.get(rName) || 0) + 1);
                                });
                              });
                            }
                          });
                          // Compléter avec tous les rôles connus (même si 0 assignation)
                          for (const rName of Array.from(roleColorMap.keys())) {
                            if (!roleTotals.has(rName)) roleTotals.set(rName, 0);
                          }
                          // S'il n'y a aucun rôle défini globalement, ne rien afficher
                          if (roleTotals.size === 0 && roleColorMap.size === 0) return null;
                          const rows = Array.from(roleTotals.entries()).sort((a, b) => a[0].localeCompare(b[0]));
                          return (
                            <div className="mt-4 overflow-x-auto">
                              <table className="w-full border-collapse text-sm table-fixed">
                                <thead>
                                  <tr className="border-b dark:border-zinc-800">
                                    <th className="px-2 py-2 text-right w-64">תפקיד</th>
                                    <th className="px-2 py-2 text-right w-28">סה"כ שיבוצים</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {rows.map(([rName, cnt]) => {
                                    const rc = colorForRole(rName);
                                    return (
                                      <tr key={rName} className="border-b last:border-0 dark:border-zinc-800">
                                        <td className="px-2 py-2 w-64">
                                          <span className="inline-flex items-center rounded-full border bg-white px-3 py-1 text-sm shadow-sm" style={{ borderColor: rc.border, color: rc.text }}>
                                            {rName}
                                          </span>
                                        </td>
                                        <td className="px-2 py-2 w-28">{cnt}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          );
                        })()}
                      </div>
                      </>
                    );
                  })()}
                </div>
              )}
              {isManual && manualAssignments && (
                <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
                  <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">סיכום שיבוצים לעמדה (כל העמדות)</div>
                  {(() => {
                    // Build counts from manualAssignments
                    const counts = new Map<string, number>();
                    const days = Object.keys(manualAssignments || {});
                    for (const dKey of days) {
                      const shiftsMap = (manualAssignments as any)[dKey] || {};
                      for (const sn of Object.keys(shiftsMap)) {
                        const perStation: string[][] = shiftsMap[sn] || [];
                        for (const namesHere of perStation) {
                          for (const nm of (namesHere || [])) {
                            if (!nm) continue;
                            counts.set(nm, (counts.get(nm) || 0) + 1);
                          }
                        }
                      }
                    }
                    // Include all workers with 0
                    workers.forEach((w) => { if (!counts.has(w.name)) counts.set(w.name, 0); });
                    const order = new Map<string, number>();
                    workers.forEach((w, i) => order.set(w.name, i));
                    const items = Array.from(counts.entries()).sort((a, b) => {
                      const ia = order.has(a[0]) ? (order.get(a[0]) as number) : Number.MAX_SAFE_INTEGER;
                      const ib = order.has(b[0]) ? (order.get(b[0]) as number) : Number.MAX_SAFE_INTEGER;
                      if (ia !== ib) return ia - ib;
                      return a[0].localeCompare(b[0]);
                    });
                    // Compute totals required from site config as in AI summary
                    const stationsCfgAll: any[] = (site?.config?.stations || []) as any[];
                    function requiredForSummary(st: any, shiftName: string, dayKey: string): number {
                      if (!st) return 0;
                      if (st.perDayCustom) {
                        const dayCfg = st.dayOverrides?.[dayKey];
                        if (!dayCfg || dayCfg.active === false) return 0;
                        if (st.uniformRoles) return Number(st.workers || 0);
                        const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
                        if (!sh || !sh.enabled) return 0;
                        return Number(sh.workers || 0);
                      }
                      if (st.days && st.days[dayKey] === false) return 0;
                      if (st.uniformRoles) return Number(st.workers || 0);
                      const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
                      if (!sh || !sh.enabled) return 0;
                      return Number(sh.workers || 0);
                    }
                    let totalRequired = 0;
                    for (const dKey of days) {
                      const shiftsMap = (manualAssignments as any)[dKey] || {};
                      for (const sn of Object.keys(shiftsMap)) {
                        for (let tIdx = 0; tIdx < stationsCfgAll.length; tIdx++) {
                          totalRequired += requiredForSummary(stationsCfgAll[tIdx], sn, dKey);
                        }
                      }
                    }
                    const totalAssigned = Array.from(counts.values()).reduce((a, b) => a + b, 0);
                    return (
                      <>
                        <div className="mb-2 flex items-center justify-end gap-6 text-sm">
                          <div>סה"כ נדרש: <span className="font-medium">{totalRequired}</span></div>
                          <div>סה"כ שיבוצים: <span className="font-medium">{totalAssigned}</span></div>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full border-collapse text-sm table-fixed">
                            <thead>
                              <tr className="border-b dark:border-zinc-800">
                                <th className="px-2 py-2 text-right w-64">עובד</th>
                                <th className="px-2 py-2 text-right w-28">מס' משמרות</th>
                              </tr>
                            </thead>
                            <tbody>
                              {items.map(([nm, c]) => {
                                const col = colorForName(nm);
                                return (
                                  <tr key={nm} className="border-b last:border-0 dark:border-zinc-800">
                                    <td className="px-2 py-2 w-64">
                                      <span className="inline-flex items-center rounded-full border px-3 py-1 text-sm shadow-sm" style={{ backgroundColor: col.bg, borderColor: col.border, color: col.text }}>
                                        {nm}
                                      </span>
                                    </td>
                                    <td className="px-2 py-2 w-28">{c}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}
              {!isManual && (
              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={async () => {
                    let stopped = false;
                    try {
                      // eslint-disable-next-line no-console
                      console.log("[BTN] click start");
                      setAiLoading(true);
                      setAiPlan(null);
                      baseAssignmentsRef.current = null;
                      setAltIndex(0);
                      const controller = new AbortController();
                      const timeoutId = setTimeout(() => {
                        try { controller.abort(); } catch {}
                        setAiLoading(false);
                      }, 120000);
                      // Inactivité: si aucune frame reçue pendant X ms, terminer proprement
                      let idleId: any = 0;
                      const armIdle = () => {
                        if (idleId) clearTimeout(idleId);
                        idleId = setTimeout(async () => {
                          // eslint-disable-next-line no-console
                          console.log("[AI][SSE] idle timeout → finalize");
                          setAiPlan((prev) => (prev ? { ...prev, status: "DONE" } : prev));
                          setAiLoading(false);
                          try { await reader.cancel?.(); } catch {}
                          try { controller.abort(); } catch {}
                          stopped = true;
                          toast.success("התכנון הושלם");
                        }, 3000); // 3s d'inactivité
                      };
                      const resp = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/director/sites/${params.id}/ai-generate/stream`, {
                        method: "POST",
                        headers: {
                          Authorization: `Bearer ${localStorage.getItem("access_token")}`,
                          Accept: "text/event-stream",
                          "Content-Type": "application/json",
                        },
                        body: JSON.stringify({ num_alternatives: 500 }),
                        signal: controller.signal,
                      });
                      if (!resp.ok || !resp.body) {
                        // eslint-disable-next-line no-console
                        console.log("[BTN] bad response", resp.status);
                        throw new Error(`HTTP ${resp.status}`);
                      }
                      const reader = resp.body.getReader();
                      const decoder = new TextDecoder("utf-8");
                      let buffer = "";
                      // eslint-disable-next-line no-constant-condition
                      while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        let idx;
                        while ((idx = buffer.indexOf("\n\n")) !== -1) {
                          const frame = buffer.slice(0, idx).trim();
                          buffer = buffer.slice(idx + 2);
                          if (!frame.startsWith("data:")) continue;
                          try {
                            const jsonStr = frame.replace(/^data:\s*/, "");
                            const evt = JSON.parse(jsonStr);
                            if (evt?.type === "base") {
                              setAiPlan({
                                days: evt.days,
                                shifts: evt.shifts,
                                stations: evt.stations,
                                assignments: evt.assignments,
                                alternatives: [],
                                status: "STREAMING",
                                objective: 0,
                              } as any);
                              baseAssignmentsRef.current = evt.assignments;
                              toast.success("תכנון בסיסי מוכן");
                              armIdle();
                            } else if (evt?.type === "alternative") {
                              armIdle();
                              setAiPlan((prev) => {
                                if (!prev) return prev;
                                const alts = Array.isArray(prev.alternatives) ? prev.alternatives : [];
                                const next = { ...prev, alternatives: [...alts, evt.assignments] } as any;
                                // eslint-disable-next-line no-console
                                console.log("[AI][SSE] alternatives count:", next.alternatives.length);
                                return next;
                              });
                            } else if (evt?.type === "status") {
                              // eslint-disable-next-line no-console
                              console.log("[AI][SSE] status", evt);
                              setAiLoading(false);
                              try { await reader.cancel(); } catch {}
                              clearTimeout(timeoutId);
                              stopped = true;
                              break;
                            } else if (evt?.type === "done") {
                              // eslint-disable-next-line no-console
                              console.log("[AI][SSE] done");
                              try { await reader.cancel(); } catch {}
                              clearTimeout(timeoutId);
                              stopped = true;
                              setAiLoading(false);
                              setAiPlan((prev) => (prev ? { ...prev, status: "DONE" } : prev));
                              toast.success("התכנון הושלם");
                              break;
                            }
                          } catch (e) {
                            // eslint-disable-next-line no-console
                            console.log("[AI][SSE] parse error", e);
                          }
                        }
                        if (stopped) break;
                      }
                      clearTimeout(timeoutId);
                      if (idleId) clearTimeout(idleId);
                    } catch (e: any) {
                      // eslint-disable-next-line no-console
                      console.log("[BTN] error", e);
                      const msg = String(e?.message || e || "");
                      // Ne pas alerter si on a volontairement stoppé/annulé (AbortError)
                      if (stopped || e?.name === "AbortError" || /aborted/i.test(msg)) {
                        // eslint-disable-next-line no-console
                        console.log("[BTN] fetch aborted/ended gracefully, no toast");
                      } else {
                        toast.error("יצירת תכנון נכשלה", { description: msg || "נסה שוב מאוחר יותר." });
                      }
                    } finally {
                      // eslint-disable-next-line no-console
                      console.log("[BTN] finally set loading false");
                      setAiLoading(false);
                    }
                  }}
                  className="inline-flex items-center rounded-md bg-[#00A8E0] px-6 py-2 text-white hover:bg-[#0092c6] disabled:opacity-60"
                  disabled={aiLoading}
                >
                  {aiLoading ? "יוצר..." : "יצירת תכנון"}
                </button>
                {aiPlan && (
                  <div className="mt-3 flex items-center justify-center gap-2 text-sm">
                    {(() => {
                      const alts = aiPlan?.alternatives || [];
                      const total = 1 + (alts?.length || 0);
                      return (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              const next = (altIndex + 1) % total;
                              setAltIndex(next);
                              if (next === 0) {
                                setAiPlan((prev) => (prev ? { ...prev, assignments: baseAssignmentsRef.current || prev.assignments } : prev));
                              } else {
                                const alt = alts[next - 1];
                                setAiPlan((prev) => (prev ? { ...prev, assignments: alt } : prev));
                              }
                            }}
                            disabled={total <= 1}
                            className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          >
                            חלופה →
                          </button>
                          <span>
                            {altIndex + 1} / {total}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const next = (altIndex - 1 + total) % total;
                              setAltIndex(next);
                              if (next === 0) {
                                setAiPlan((prev) => (prev ? { ...prev, assignments: baseAssignmentsRef.current || prev.assignments } : prev));
                              } else {
                                const alt = alts[next - 1];
                                setAiPlan((prev) => (prev ? { ...prev, assignments: alt } : prev));
                              }
                            }}
                            disabled={total <= 1}
                            className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          >
                            ← חלופה
                          </button>
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}



import type { PlanningWorker, SiteSummary } from "../types";
import type { ManualDragSource } from "./planning-v2-manual-drop";
import {
  readLinkedPlansFromMemory,
  resolveAssignmentsForAlternative,
} from "./multi-site-linked-memory";

const DAY_ORDER = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export function detectShiftKind(sn: string): "morning" | "noon" | "night" | "other" {
  const s = String(sn || "");
  if (/בוקר|^0?6|06-14/i.test(s)) return "morning";
  if (/צהר(יים|י)ם?|14-22|^1?4/i.test(s)) return "noon";
  if (/לילה|22-06|^2?2|night/i.test(s)) return "night";
  return "other";
}

export function prevDayKeyOf(key: string): string {
  return DAY_ORDER[(DAY_ORDER.indexOf(key as (typeof DAY_ORDER)[number]) + 6) % 7];
}

export function nextDayKeyOf(key: string): string {
  return DAY_ORDER[(DAY_ORDER.indexOf(key as (typeof DAY_ORDER)[number]) + 1) % 7];
}

function normLocal(n: string): string {
  return String(n || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function workerHasRole(workers: PlanningWorker[], workerName: string, roleName: string): boolean {
  const w = workers.find((x) => (x.name || "").trim() === (workerName || "").trim());
  if (!w) return false;
  const target = normLocal(roleName);
  return (w.roles || []).some((r) => normLocal(String(r)) === target);
}

export function roleRequirementsForStation(st: any, shiftName: string, dayKey: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!st) return out;
  const pushRole = (name?: string, count?: number, enabled?: boolean) => {
    const rn = String(name || "").trim();
    const c = Number(count || 0);
    if (!rn || !enabled || c <= 0) return;
    out[rn] = (out[rn] || 0) + c;
  };
  if (st.perDayCustom) {
    const dayCfg = st.dayOverrides?.[dayKey];
    if (!dayCfg || dayCfg.active === false) return out;
    if (st.uniformRoles) {
      for (const r of st.roles || []) pushRole(r?.name, r?.count, r?.enabled);
    } else {
      const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
      for (const r of (sh?.roles as any[]) || []) pushRole(r?.name, r?.count, r?.enabled);
    }
    return out;
  }
  if (st.uniformRoles) {
    for (const r of st.roles || []) pushRole(r?.name, r?.count, r?.enabled);
  } else {
    const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
    for (const r of (sh?.roles as any[]) || []) pushRole(r?.name, r?.count, r?.enabled);
  }
  return out;
}

function findAssignedRole(
  workers: PlanningWorker[],
  roleReq: Record<string, number>,
  nm: string,
): string | null {
  const w = workers.find((x) => (x.name || "").trim() === (nm || "").trim());
  if (!w) return null;
  const roles = Object.keys(roleReq);
  for (const rName of roles) {
    if ((w.roles || []).some((r) => normLocal(String(r)) === normLocal(rName))) return rName;
  }
  return null;
}

export function computeRoleHintsForCell(
  workers: PlanningWorker[],
  stCfg: any,
  shiftName: string,
  dayKey: string,
  beforeArr: string[],
): string[] {
  const roleReq = roleRequirementsForStation(stCfg, shiftName, dayKey);
  const currentAssignedPerRole = new Map<string, number>();
  beforeArr.forEach((nm) => {
    const r = findAssignedRole(workers, roleReq, nm);
    if (!r) return;
    currentAssignedPerRole.set(r, (currentAssignedPerRole.get(r) || 0) + 1);
  });
  const roleHints: string[] = [];
  Object.entries(roleReq).forEach(([rName, rCount]) => {
    const have = currentAssignedPerRole.get(rName) || 0;
    const deficit = Math.max(0, (rCount || 0) - have);
    for (let i = 0; i < deficit; i++) roleHints.push(rName);
  });
  return roleHints;
}

function isMorning(n?: string) {
  return !!n && (/בוקר/.test(n) || /^0?6/.test(n) || /06-14/i.test(n));
}
function isNoon(n?: string) {
  return !!n && (/צהר/.test(n) || /^1?4/.test(n) || /14-22/i.test(n));
}
function isNight(n?: string) {
  return !!n && (/לילה/.test(n) || /night/i.test(n) || /^2?2/.test(n) || /22-06/i.test(n));
}

export function matchesShift(target: string, list: string[]): boolean {
  if (list.includes(target)) return true;
  if (isMorning(target) && list.some(isMorning)) return true;
  if (isNoon(target) && list.some(isNoon)) return true;
  if (isNight(target) && list.some(isNight)) return true;
  return false;
}

function normName(s: unknown): string {
  return String(s || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

function ensureShiftRow(
  next: Record<string, Record<string, string[][]>>,
  dayKey: string,
  shiftName: string,
  stationsCount: number,
): void {
  if (!next[dayKey]) next[dayKey] = {};
  if (!next[dayKey][shiftName]) next[dayKey][shiftName] = Array.from({ length: stationsCount }, () => []);
  const row = next[dayKey][shiftName];
  if (row.length !== stationsCount) {
    next[dayKey][shiftName] = Array.from({ length: stationsCount }, (_, i) => row[i] || []);
  }
}

/** Mutation pure (זמינות / confirmations gérées en amont). */
export function mutateManualSlotAssignment(
  baseInput: Record<string, Record<string, string[][]>>,
  args: {
    stationsCount: number;
    dayKey: string;
    shiftName: string;
    stationIndex: number;
    slotIndex: number;
    workerName: string;
    dragSource: ManualDragSource | null;
  },
): Record<string, Record<string, string[][]>> {
  const trimmed = String(args.workerName || "").trim();
  const next: Record<string, Record<string, string[][]>> = JSON.parse(JSON.stringify(baseInput || {}));
  const { dayKey, shiftName, stationIndex, slotIndex, stationsCount, dragSource } = args;

  ensureShiftRow(next, dayKey, shiftName, stationsCount);

  const beforeArr: string[] = Array.from(next[dayKey][shiftName][stationIndex] || []);
  const nextTarget = Array.from(beforeArr as string[]);
  while (nextTarget.length <= slotIndex) nextTarget.push("");
  const nt = normName(trimmed);
  for (let i = 0; i < nextTarget.length; i++) {
    if (normName(nextTarget[i]) === nt) nextTarget[i] = "";
  }
  nextTarget[slotIndex] = trimmed;
  next[dayKey][shiftName][stationIndex] = nextTarget;

  const isMoveFromSlot = !!(dragSource && normName(dragSource.workerName) === nt);
  if (isMoveFromSlot && dragSource) {
    try {
      const sameCell =
        dragSource.dayKey === dayKey &&
        dragSource.shiftName === shiftName &&
        Number(dragSource.stationIndex) === Number(stationIndex);
      if (!sameCell || Number(dragSource.slotIndex) !== Number(slotIndex)) {
        ensureShiftRow(next, dragSource.dayKey, dragSource.shiftName, stationsCount);
        const srcArr: string[] = Array.from(next[dragSource.dayKey][dragSource.shiftName][dragSource.stationIndex] || []);
        while (srcArr.length <= dragSource.slotIndex) srcArr.push("");
        srcArr[dragSource.slotIndex] = "";
        next[dragSource.dayKey][dragSource.shiftName][dragSource.stationIndex] = srcArr;
      }
    } catch {
      /* ignore */
    }
  }
  return next;
}

function findShiftNameByKind(assignments: Record<string, Record<string, string[][]>>, dayKey: string, kind: "morning" | "noon" | "night"): string | null {
  const shiftsMap = assignments?.[dayKey] || {};
  const sn = Object.keys(shiftsMap).find((x) => detectShiftKind(x) === kind);
  return sn || null;
}

function hasWorkerInShiftColumn(
  assignments: Record<string, Record<string, string[][]>>,
  dayKey: string,
  shiftName: string | null,
  workerTrimmed: string,
): boolean {
  if (!shiftName) return false;
  const perStation: string[][] = assignments?.[dayKey]?.[shiftName] || [];
  const t = normName(workerTrimmed);
  return perStation.some((arr) => (arr || []).some((nm) => normName(nm) === t));
}

function isWorkerAlreadyAssignedInShift(
  assignments: Record<string, Record<string, string[][]>>,
  dayKey: string,
  shiftName: string,
  workerName: string,
): boolean {
  const t = normName(workerName);
  if (!t) return false;
  const perStation: string[][] = (assignments?.[dayKey]?.[shiftName] || []) as string[][];
  for (const arr of perStation) {
    if ((arr || []).some((nm) => normName(nm) === t)) return true;
  }
  return false;
}

export function collectManualRuleViolations(
  assignments: Record<string, Record<string, string[][]>>,
  workerName: string,
  dayKey: string,
  shiftName: string,
  stationIndex: number,
): string[] {
  const trimmed = String(workerName || "").trim();
  const conflicts: string[] = [];
  const t = normName(trimmed);
  if (!t) return conflicts;

  try {
    if (detectShiftKind(shiftName) === "night") {
      let nightCount = 0;
      for (const dKey of Object.keys(assignments || {})) {
        const shiftsMap = assignments[dKey] || {};
        for (const sn of Object.keys(shiftsMap)) {
          if (detectShiftKind(sn) !== "night") continue;
          const perStation: string[][] = shiftsMap[sn] || [];
          for (const namesHere of perStation) {
            if ((namesHere || []).some((nm) => normName(nm) === t)) nightCount++;
          }
        }
      }
      if (nightCount > 3) conflicts.push("יותר מ־3 לילות בשבוע");
    }

    const perStationSame: string[][] = (assignments?.[dayKey]?.[shiftName] || []) as string[][];
    let existsElsewhere = false;
    perStationSame.forEach((namesArr: string[], sIdx: number) => {
      if (sIdx === stationIndex) return;
      if ((namesArr || []).some((nm) => normName(nm) === t)) existsElsewhere = true;
    });
    if (existsElsewhere) conflicts.push("אותו עובד כבר שובץ במשמרת זו בעמדה אחרת");

    const kind = detectShiftKind(shiftName);
    const prevCheck = () => {
      if (kind === "morning") {
        const prevDay = prevDayKeyOf(dayKey);
        const sn = findShiftNameByKind(assignments, prevDay, "night");
        return hasWorkerInShiftColumn(assignments, prevDay, sn, trimmed);
      }
      if (kind === "noon") {
        const sn = findShiftNameByKind(assignments, dayKey, "morning");
        return hasWorkerInShiftColumn(assignments, dayKey, sn, trimmed);
      }
      if (kind === "night") {
        const sn = findShiftNameByKind(assignments, dayKey, "noon");
        return hasWorkerInShiftColumn(assignments, dayKey, sn, trimmed);
      }
      return false;
    };
    const nextCheck = () => {
      if (kind === "morning") {
        const sn = findShiftNameByKind(assignments, dayKey, "noon");
        return hasWorkerInShiftColumn(assignments, dayKey, sn, trimmed);
      }
      if (kind === "noon") {
        const sn = findShiftNameByKind(assignments, dayKey, "night");
        return hasWorkerInShiftColumn(assignments, dayKey, sn, trimmed);
      }
      if (kind === "night") {
        const nextDay = nextDayKeyOf(dayKey);
        const sn = findShiftNameByKind(assignments, nextDay, "morning");
        return hasWorkerInShiftColumn(assignments, nextDay, sn, trimmed);
      }
      return false;
    };
    if (prevCheck() || nextCheck()) conflicts.push("אין משמרות צמודות (כולל חציית יום)");
  } catch {
    /* ignore */
  }
  return conflicts;
}

function hasWorkerAssignmentOnOtherLinkedSite(
  currentSiteId: string,
  weekStart: Date,
  workers: PlanningWorker[],
  workerName: string,
  dayKey: string,
  shiftName: string,
  mode: "same" | "kind",
): boolean {
  const trimmed = String(workerName || "").trim();
  if (!trimmed) return false;
  const worker = workers.find((w) => (w.name || "").trim() === trimmed);
  const linkedSiteIds = Array.isArray(worker?.linkedSiteIds)
    ? (worker.linkedSiteIds as number[]).map((id: number) => Number(id)).filter(Number.isFinite)
    : [];
  if (linkedSiteIds.length <= 1) return false;
  const linkedMemory = readLinkedPlansFromMemory(weekStart);
  const activeAltIndex = Number(linkedMemory?.activeAltIndex || 0);
  const targetKind = detectShiftKind(shiftName);
  for (const linkedSiteId of linkedSiteIds) {
    if (String(linkedSiteId) === String(currentSiteId)) continue;
    const plan = linkedMemory?.plansBySite?.[String(linkedSiteId)];
    const asg = plan ? resolveAssignmentsForAlternative(plan, activeAltIndex) : null;
    const shiftsMap = asg?.[dayKey] || {};
    for (const candidateShiftName of Object.keys(shiftsMap)) {
      const matches =
        mode === "same"
          ? candidateShiftName === shiftName
          : targetKind === "other"
            ? candidateShiftName === shiftName
            : detectShiftKind(candidateShiftName) === targetKind;
      if (!matches) continue;
      const perStation = (shiftsMap as Record<string, string[][]>)[candidateShiftName] || [];
      if (perStation.some((namesHere) => (namesHere || []).some((nm) => String(nm || "").trim() === trimmed))) {
        return true;
      }
    }
  }
  return false;
}

/** זמינות (כולל התאמת סוג משמרת) — כמו `isWorkerAvailableForSlot` ב-planning. */
export function isWorkerAvailableForSlot(
  workers: PlanningWorker[],
  availabilityByWorkerName: Record<string, Record<string, string[]>>,
  workerName: string,
  dayKey: string,
  shiftName: string,
): boolean {
  const trimmed = String(workerName || "").trim();
  if (!trimmed) return false;
  const w = workers.find((x) => (x.name || "").trim() === trimmed);
  const effAvail =
    (availabilityByWorkerName[trimmed] as Record<string, string[]> | undefined) ||
    ((w?.availability || {}) as Record<string, string[]>);
  const dayList = (Array.isArray(effAvail?.[dayKey]) ? effAvail[dayKey] : []) as string[];
  if (dayList.includes(shiftName)) return true;
  const targetKind = detectShiftKind(shiftName);
  if (targetKind === "other") return false;
  return dayList.some((sn) => detectShiftKind(String(sn || "")) === targetKind);
}

/**
 * Indique si la case peut recevoir l’עובד (contours verts au survol pendant le drag) — aligné sur `canHighlightDropTarget`.
 */
export function canHighlightManualDropTarget(ctx: {
  assignments: Record<string, Record<string, string[][]>>;
  siteId: string;
  weekStart: Date;
  workers: PlanningWorker[];
  availabilityByWorkerName: Record<string, Record<string, string[]>>;
  workerName: string;
  dayKey: string;
  shiftName: string;
  stationIndex: number;
  roleHint?: string | null;
  dragSource?: ManualDragSource | null;
}): boolean {
  const trimmed = String(ctx.workerName || "").trim();
  if (!trimmed) return false;
  if (!isWorkerAvailableForSlot(ctx.workers, ctx.availabilityByWorkerName, trimmed, ctx.dayKey, ctx.shiftName)) {
    return false;
  }
  if (ctx.roleHint && !workerHasRole(ctx.workers, trimmed, ctx.roleHint)) return false;
  if (getLinkedSiteConflictReason(ctx.siteId, ctx.weekStart, ctx.workers, trimmed, ctx.dayKey, ctx.shiftName)) {
    return false;
  }
  // Pendant un déplacement slot->slot, l’état actuel contient encore la cellule source.
  // Pour l’aperçu vert, on évite les faux négatifs (ex: ancienne cellule) et on garde
  // les validations strictes au moment du drop via analyzeManualSlotDrop.
  if (ctx.dragSource && String(ctx.dragSource.workerName || "").trim() === trimmed) {
    return true;
  }
  if (isWorkerAlreadyAssignedInShift(ctx.assignments, ctx.dayKey, ctx.shiftName, trimmed)) {
    return false;
  }
  try {
    const perStationSame: string[][] = (ctx.assignments?.[ctx.dayKey]?.[ctx.shiftName] || []) as string[][];
    let existsElsewhere = false;
    perStationSame.forEach((namesArr, sIdx) => {
      if (sIdx === ctx.stationIndex) return;
      if ((namesArr || []).some((nm) => String(nm || "").trim() === trimmed)) existsElsewhere = true;
    });
    if (existsElsewhere) return false;
  } catch {
    /* ignore */
  }
  try {
    if (detectShiftKind(ctx.shiftName) === "night") {
      let nightCount = 0;
      for (const dKey of Object.keys(ctx.assignments || {})) {
        const shiftsMap = ctx.assignments[dKey] || {};
        for (const sn of Object.keys(shiftsMap)) {
          if (detectShiftKind(sn) !== "night") continue;
          const perStation: string[][] = shiftsMap[sn] || [];
          for (const namesHere of perStation) {
            if ((namesHere || []).some((nm) => String(nm || "").trim() === trimmed)) nightCount++;
          }
        }
      }
      if (nightCount + 1 > 3) return false;
    }
  } catch {
    /* ignore */
  }
  try {
    const kind = detectShiftKind(ctx.shiftName);
    const hasInShift = (dKey: string, kindWanted: "morning" | "noon" | "night") => {
      const shiftsMap = ctx.assignments?.[dKey] || {};
      const sn = Object.keys(shiftsMap).find((x) => detectShiftKind(x) === kindWanted);
      if (!sn) return false;
      const perStation: string[][] = shiftsMap[sn] || [];
      return perStation.some((arr: string[]) => (arr || []).some((nm) => String(nm || "").trim() === trimmed));
    };
    const prevCheck = () => {
      if (kind === "morning") return hasInShift(prevDayKeyOf(ctx.dayKey), "night");
      if (kind === "noon") return hasInShift(ctx.dayKey, "morning");
      if (kind === "night") return hasInShift(ctx.dayKey, "noon");
      return false;
    };
    const nextCheck = () => {
      if (kind === "morning") return hasInShift(ctx.dayKey, "noon");
      if (kind === "noon") return hasInShift(ctx.dayKey, "night");
      if (kind === "night") return hasInShift(nextDayKeyOf(ctx.dayKey), "morning");
      return false;
    };
    if (prevCheck() || nextCheck()) return false;
  } catch {
    /* ignore */
  }
  return true;
}

export function getLinkedSiteConflictReason(
  currentSiteId: string,
  weekStart: Date,
  workers: PlanningWorker[],
  workerName: string,
  dayKey: string,
  shiftName: string,
): string | null {
  const trimmed = String(workerName || "").trim();
  if (!trimmed) return null;
  if (hasWorkerAssignmentOnOtherLinkedSite(currentSiteId, weekStart, workers, trimmed, dayKey, shiftName, "kind")) {
    return "העובד כבר משובץ במשמרת חופפת באתר מקושר.";
  }
  const kind = detectShiftKind(shiftName);
  if (kind === "morning" && hasWorkerAssignmentOnOtherLinkedSite(currentSiteId, weekStart, workers, trimmed, prevDayKeyOf(dayKey), "night", "kind")) {
    return "העובד כבר משובץ בלילה קודם באתר מקושר.";
  }
  if (kind === "noon" && hasWorkerAssignmentOnOtherLinkedSite(currentSiteId, weekStart, workers, trimmed, dayKey, "morning", "kind")) {
    return "העובד כבר משובץ בבוקר באותו יום באתר מקושר.";
  }
  if (kind === "night" && hasWorkerAssignmentOnOtherLinkedSite(currentSiteId, weekStart, workers, trimmed, dayKey, "noon", "kind")) {
    return "העובד כבר משובץ בצהריים באותו יום באתר מקושר.";
  }
  if (kind === "night" && hasWorkerAssignmentOnOtherLinkedSite(currentSiteId, weekStart, workers, trimmed, nextDayKeyOf(dayKey), "morning", "kind")) {
    return "העובד כבר משובץ בבוקר שלמחרת באתר מקושר.";
  }
  return null;
}

export type ManualDropFlags = {
  forceAvailability?: boolean;
  forceRole?: boolean;
  forceRules?: boolean;
};

export type ManualSlotDropAnalysis =
  | { action: "apply"; next: Record<string, Record<string, string[][]>> }
  | { action: "block"; message: string }
  | { action: "confirm_availability"; workerName: string; dayKey: string; shiftName: string }
  | { action: "confirm_role"; workerName: string; roleName: string }
  | { action: "confirm_rules"; lines: string[] };

export function analyzeManualSlotDrop(ctx: {
  site: SiteSummary | null;
  siteId: string;
  weekStart: Date;
  workers: PlanningWorker[];
  availabilityByWorkerName: Record<string, Record<string, string[]>>;
  base: Record<string, Record<string, string[][]>>;
  dayKey: string;
  shiftName: string;
  stationIndex: number;
  slotIndex: number;
  workerName: string;
  dragSource: ManualDragSource | null;
  flags: ManualDropFlags;
}): ManualSlotDropAnalysis {
  const trimmed = String(ctx.workerName || "").trim();
  if (!trimmed) return { action: "block", message: "לא נבחר עובד" };

  const stationsCount = (ctx.site?.config?.stations as unknown[] | undefined)?.length || 0;
  if (!stationsCount) return { action: "block", message: "אין עמדות" };

  const linked = getLinkedSiteConflictReason(ctx.siteId, ctx.weekStart, ctx.workers, trimmed, ctx.dayKey, ctx.shiftName);
  if (linked) return { action: "block", message: linked };

  const isMoveFromSameWorker = !!(
    ctx.dragSource &&
    normName(ctx.dragSource.workerName) === normName(trimmed)
  );
  if (
    !isMoveFromSameWorker &&
    isWorkerAlreadyAssignedInShift(ctx.base, ctx.dayKey, ctx.shiftName, trimmed)
  ) {
    return { action: "block", message: "העובד כבר משובץ במשמרת זו ולא ניתן לשבץ אותו שוב." };
  }

  const w = ctx.workers.find((x) => (x.name || "").trim() === trimmed);
  const effAvail =
    (ctx.availabilityByWorkerName[trimmed] as Record<string, string[]> | undefined) ||
    ((w?.availability || {}) as Record<string, string[]>);
  const dayList = (effAvail?.[ctx.dayKey] || []) as string[];
  const allowed = matchesShift(ctx.shiftName, dayList);
  if (!allowed && !ctx.flags.forceAvailability) {
    return {
      action: "confirm_availability",
      workerName: trimmed,
      dayKey: ctx.dayKey,
      shiftName: ctx.shiftName,
    };
  }

  const stCfg = (ctx.site?.config?.stations as any[])?.[ctx.stationIndex] || null;
  const beforeArr: string[] = Array.from(ctx.base[ctx.dayKey]?.[ctx.shiftName]?.[ctx.stationIndex] || []);
  const roleReqForCell = roleRequirementsForStation(stCfg, ctx.shiftName, ctx.dayKey);
  const requiredRoleNames = Object.keys(roleReqForCell).filter((rn) => Number(roleReqForCell[rn] || 0) > 0);
  const roleHints = computeRoleHintsForCell(ctx.workers, stCfg, ctx.shiftName, ctx.dayKey, beforeArr);
  const slotWorkerName = String(beforeArr[ctx.slotIndex] || "").trim();
  const slotWorkerAssignedRole = slotWorkerName
    ? findAssignedRole(ctx.workers, roleReqForCell, slotWorkerName)
    : null;
  // Priorité:
  // 1) besoin explicite sur le slot (trou à combler),
  // 2) rôle du worker déjà présent dans ce slot (cas déplacement/remplacement),
  // 3) sinon null.
  const slotExpectedRole =
    (roleHints[ctx.slotIndex] || "").trim() ||
    String(slotWorkerAssignedRole || "").trim() ||
    null;
  if (!ctx.flags.forceRole) {
    const workerRoles: string[] = Array.isArray(w?.roles) ? w.roles : [];
    if (slotExpectedRole) {
      const match = workerRoles.some((r) => normLocal(String(r)) === normLocal(slotExpectedRole));
      if (!match) {
        return { action: "confirm_role", workerName: trimmed, roleName: slotExpectedRole };
      }
    } else if (requiredRoleNames.length > 0) {
      // Même sans hint de slot précis, si la case exige des rôles et que l'עובד n'en a aucun, demander confirmation.
      const hasAnyRequiredRole = requiredRoleNames.some((reqRole) =>
        workerRoles.some((r) => normLocal(String(r)) === normLocal(reqRole)),
      );
      if (!hasAnyRequiredRole) {
        return { action: "confirm_role", workerName: trimmed, roleName: requiredRoleNames.join(" / ") };
      }
    }
  }

  const next = mutateManualSlotAssignment(ctx.base, {
    stationsCount,
    dayKey: ctx.dayKey,
    shiftName: ctx.shiftName,
    stationIndex: ctx.stationIndex,
    slotIndex: ctx.slotIndex,
    workerName: trimmed,
    dragSource: ctx.dragSource,
  });

  if (!ctx.flags.forceRules) {
    const conflicts = collectManualRuleViolations(next, trimmed, ctx.dayKey, ctx.shiftName, ctx.stationIndex);
    if (conflicts.length > 0) {
      return { action: "confirm_rules", lines: conflicts };
    }
  }

  return { action: "apply", next };
}

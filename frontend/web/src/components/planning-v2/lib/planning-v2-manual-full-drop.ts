import type { PlanningV2PullEntry, PlanningV2PullsMap, PlanningWorker, SiteSummary } from "../types";
import { resolveMaxShifts } from "@/lib/max-shifts";
import { workerAdjustedWeeklyTotalAcrossLinkedSites } from "./assignments-summary-math";
import type { ManualDragSource } from "./planning-v2-manual-drop";
import {
  collectManualRuleViolations,
  detectShiftKind,
  getManualShiftConflictReason,
  isWorkerAlreadyAssignedInShift,
} from "./planning-v2-manual-conflicts";

export {
  buildLinkedSiteForbiddenSlotKeySet,
  buildManualDropForbiddenSlotKeySet,
  collectManualRuleViolations,
  detectShiftKind,
  getLinkedSiteConflictCellLabel,
  getLinkedSiteConflictReason,
  getManualShiftConflictReason,
  isLinkedSiteExactAssignmentConflictCell,
  linkedForbiddenSlotsFromAssignment,
  listCurrentSiteShiftAssignmentsForWorker,
  listWorkerLinkedAssignmentsOnOtherSites,
  listWorkerLinkedShiftAssignmentsOnOtherSites,
  nextDayKeyOf,
  prevDayKeyOf,
  type WorkerLinkedAssignmentOnOtherSite,
} from "./planning-v2-manual-conflicts";


function normLocal(n: string): string {
  return String(n || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normName(s: unknown): string {
  return String(s || "")
    .normalize("NFKC")
    .trim()
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
    /** Après remplacement משיכה : une seule case avec l'עובד (pas les 2 bulles משיכה). */
    replacePullCell?: boolean;
  },
): Record<string, Record<string, string[][]>> {
  const trimmed = String(args.workerName || "").trim();
  const next: Record<string, Record<string, string[][]>> = JSON.parse(JSON.stringify(baseInput || {}));
  const { dayKey, shiftName, stationIndex, slotIndex, stationsCount, dragSource, replacePullCell } = args;

  ensureShiftRow(next, dayKey, shiftName, stationsCount);

  const nt = normName(trimmed);
  if (replacePullCell) {
    next[dayKey][shiftName][stationIndex] = [trimmed];
  } else {
    const beforeArr: string[] = Array.from(next[dayKey][shiftName][stationIndex] || []);
    const nextTarget = Array.from(beforeArr as string[]);
    while (nextTarget.length <= slotIndex) nextTarget.push("");
    for (let i = 0; i < nextTarget.length; i++) {
      if (normName(nextTarget[i]) === nt) nextTarget[i] = "";
    }
    nextTarget[slotIndex] = trimmed;
    next[dayKey][shiftName][stationIndex] = nextTarget;
  }

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


/** Restriction עמדות (מודל זמינות — מפתח `_stations`). */
export function isWorkerAllowedOnStation(
  effAvail: Record<string, string[]> | undefined,
  stationIndex: number,
  stationsCount: number,
): boolean {
  if (stationsCount <= 1) return true;
  const meta = (effAvail as { _stations?: string[] } | undefined)?._stations;
  if (!meta || !Array.isArray(meta) || meta.length === 0) return true;
  const allowed = new Set(meta.map((x) => parseInt(String(x), 10)).filter((n) => Number.isFinite(n)));
  return allowed.has(stationIndex);
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
  stationsCount: number;
  roleHint?: string | null;
  dragSource?: ManualDragSource | null;
}): boolean {
  const trimmed = String(ctx.workerName || "").trim();
  if (!trimmed) return false;
  if (!isWorkerAvailableForSlot(ctx.workers, ctx.availabilityByWorkerName, trimmed, ctx.dayKey, ctx.shiftName)) {
    return false;
  }
  const effAvail =
    (ctx.availabilityByWorkerName[trimmed] as Record<string, string[]> | undefined) ||
    ((ctx.workers.find((x) => (x.name || "").trim() === trimmed)?.availability || {}) as Record<string, string[]>);
  if (!isWorkerAllowedOnStation(effAvail, ctx.stationIndex, ctx.stationsCount)) {
    return false;
  }
  if (ctx.roleHint && !workerHasRole(ctx.workers, trimmed, ctx.roleHint)) return false;
  if (
    getManualShiftConflictReason(
      ctx.assignments,
      ctx.siteId,
      ctx.weekStart,
      ctx.workers,
      trimmed,
      ctx.dayKey,
      ctx.shiftName,
      ctx.dragSource,
    )
  ) {
    return false;
  }
  if (isWorkerAlreadyAssignedInShift(ctx.assignments, ctx.dayKey, ctx.shiftName, trimmed, ctx.dragSource)) {
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
  return true;
}


export type ManualDropFlags = {
  forceAvailability?: boolean;
  forceRole?: boolean;
  forceRules?: boolean;
  forceMaxShifts?: boolean;
  forceReplacePull?: boolean;
};

export type ManualSlotDropAnalysis =
  | { action: "apply"; next: Record<string, Record<string, string[][]>> }
  | { action: "block"; message: string }
  | { action: "confirm_availability"; workerName: string; dayKey: string; shiftName: string }
  | { action: "confirm_role"; workerName: string; roleName: string }
  | { action: "confirm_rules"; lines: string[] }
  | { action: "confirm_max_shifts"; maxShifts: number; total: number }
  | { action: "confirm_replace_pull"; workerName: string };

function isRealPullEntry(entry: unknown): boolean {
  const e = entry as PlanningV2PullEntry | undefined;
  return !!String(e?.before?.name || "").trim() && !!String(e?.after?.name || "").trim();
}

/** משיכות complètes dans une cellule (jour + משמרת + עמדה). */
export function pullEntriesInCell(
  pulls: PlanningV2PullsMap | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIndex: number,
): Array<{ key: string; entry: PlanningV2PullEntry }> {
  if (!pulls) return [];
  const prefix = `${dayKey}|${shiftName}|${stationIndex}|`;
  return Object.entries(pulls)
    .filter(([k, v]) => String(k).startsWith(prefix) && isRealPullEntry(v))
    .map(([key, entry]) => ({ key, entry: entry as PlanningV2PullEntry }));
}

const PULL_EDIT_ONLY_VIA_POPUP_MSG = "שינוי משיכה אפשרי רק דרך חלון המשיכות.";

export type WorkerPullScope = {
  /** Limite à une עמדה (index). */
  stationIndex?: number;
  /** Limite au jour de la cellule concernée (sinon toute la semaine). */
  dayKey?: string;
  /** Limite à la משמרת de la cellule concernée. */
  shiftName?: string;
};

/** L’עובד participe à une משיכה (before/after), éventuellement limité à une cellule jour/משמרת/עמדה. */
export function workerParticipatesInPull(
  pulls: PlanningV2PullsMap | null | undefined,
  workerName: string,
  scope?: number | WorkerPullScope,
): boolean {
  const nm = normName(workerName);
  if (!nm || !pulls) return false;
  const opts: WorkerPullScope =
    typeof scope === "number" ? { stationIndex: scope } : scope || {};
  for (const [k, v] of Object.entries(pulls)) {
    if (!isRealPullEntry(v)) continue;
    const parts = String(k || "").split("|");
    if (opts.stationIndex != null && Number(parts[2]) !== Number(opts.stationIndex)) continue;
    if (opts.dayKey != null && String(parts[0] || "") !== String(opts.dayKey)) continue;
    if (opts.shiftName != null && String(parts[1] || "") !== String(opts.shiftName)) continue;
    const e = v as PlanningV2PullEntry;
    if (normName(String(e?.before?.name || "")) === nm) return true;
    if (normName(String(e?.after?.name || "")) === nm) return true;
  }
  return false;
}

export function pullEditOnlyViaPopupMessage(): string {
  return PULL_EDIT_ONLY_VIA_POPUP_MSG;
}

/** Supprime les משיכות d'une cellule et retire les noms before/after des שיבוצים. */
export function stripPullsFromCellForReplacement(
  base: Record<string, Record<string, string[][]>>,
  pulls: PlanningV2PullsMap,
  dayKey: string,
  shiftName: string,
  stationIndex: number,
): { nextBase: Record<string, Record<string, string[][]>>; nextPulls: PlanningV2PullsMap } {
  const nextPulls = JSON.parse(JSON.stringify(pulls || {})) as PlanningV2PullsMap;
  const entries = pullEntriesInCell(nextPulls, dayKey, shiftName, stationIndex);
  for (const { key } of entries) {
    delete nextPulls[key];
  }

  const nextBase = JSON.parse(JSON.stringify(base || {})) as Record<string, Record<string, string[][]>>;
  nextBase[dayKey] = nextBase[dayKey] || {};
  nextBase[dayKey][shiftName] = Array.isArray(nextBase[dayKey][shiftName]) ? nextBase[dayKey][shiftName] : [];
  while (nextBase[dayKey][shiftName].length <= stationIndex) nextBase[dayKey][shiftName].push([]);
  // Remplacement משיכה → une seule personne : on vide la cellule (les noms before/after ne restent pas).
  nextBase[dayKey][shiftName][stationIndex] = [];
  return { nextBase, nextPulls };
}

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
  /** משיכות du site courant — pour le comptage max משמרות (comme le סיכום). */
  pulls?: PlanningV2PullsMap | null;
  /** Nombre d'אירועים déjà comptés comme gardes pour cet עובד (semaine). */
  eventAssignmentCount?: number;
}): ManualSlotDropAnalysis {
  const trimmed = String(ctx.workerName || "").trim();
  if (!trimmed) return { action: "block", message: "לא נבחר עובד" };

  const stationsCount = (ctx.site?.config?.stations as unknown[] | undefined)?.length || 0;
  if (!stationsCount) return { action: "block", message: "אין עמדות" };

  const shiftConflict = getManualShiftConflictReason(
    ctx.base,
    ctx.siteId,
    ctx.weekStart,
    ctx.workers,
    trimmed,
    ctx.dayKey,
    ctx.shiftName,
    ctx.dragSource,
  );
  if (shiftConflict && !ctx.flags.forceRules) {
    return { action: "block", message: shiftConflict };
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

  if (
    !isWorkerAllowedOnStation(effAvail as Record<string, string[]>, ctx.stationIndex, stationsCount) &&
    !ctx.flags.forceAvailability
  ) {
    return {
      action: "block",
      message: "העובד לא מוגדר לעמדה זו (עמדות מורשות בהגדרת הזמינות).",
    };
  }

  const pullEntries = pullEntriesInCell(ctx.pulls, ctx.dayKey, ctx.shiftName, ctx.stationIndex);
  if (pullEntries.length > 0) {
    return { action: "block", message: PULL_EDIT_ONLY_VIA_POPUP_MSG };
  }
  if (
    ctx.dragSource &&
    workerParticipatesInPull(ctx.pulls, ctx.dragSource.workerName, {
      dayKey: ctx.dragSource.dayKey,
      shiftName: ctx.dragSource.shiftName,
      stationIndex: ctx.dragSource.stationIndex,
    })
  ) {
    return { action: "block", message: PULL_EDIT_ONLY_VIA_POPUP_MSG };
  }
  const targetSlotWorker = String(
    (ctx.base[ctx.dayKey]?.[ctx.shiftName]?.[ctx.stationIndex] || [])[ctx.slotIndex] || "",
  ).trim();
  if (
    targetSlotWorker &&
    workerParticipatesInPull(ctx.pulls, targetSlotWorker, {
      dayKey: ctx.dayKey,
      shiftName: ctx.shiftName,
      stationIndex: ctx.stationIndex,
    })
  ) {
    return { action: "block", message: PULL_EDIT_ONLY_VIA_POPUP_MSG };
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
    replacePullCell: !!ctx.flags.forceReplacePull,
  });

  if (!ctx.flags.forceRules) {
    const conflicts = collectManualRuleViolations(next, trimmed, ctx.dayKey, ctx.shiftName, ctx.stationIndex);
    if (conflicts.length > 0) {
      return { action: "confirm_rules", lines: conflicts };
    }
  }

  if (!ctx.flags.forceMaxShifts && w) {
    const maxShifts = resolveMaxShifts(
      (w as unknown as { max_shifts?: number }).max_shifts,
      w.maxShifts,
    );
    if (Number.isFinite(maxShifts) && maxShifts > 0) {
      const total = workerAdjustedWeeklyTotalAcrossLinkedSites(
        ctx.workers,
        trimmed,
        ctx.siteId,
        ctx.weekStart,
        next,
        ctx.pulls ?? null,
        ctx.eventAssignmentCount,
      );
      if (total > Math.trunc(maxShifts)) {
        console.warn("[planning-v2][multi-site][max-shifts][manual-drop] assignment exceeds worker max_shifts", {
          siteId: String(ctx.siteId),
          weekIso: ctx.weekStart.toISOString().slice(0, 10),
          workerName: trimmed,
          total,
          maxShifts: Math.trunc(maxShifts),
          linkedSiteIds: Array.isArray(w.linkedSiteIds) ? w.linkedSiteIds : [],
          dayKey: ctx.dayKey,
          shiftName: ctx.shiftName,
          stationIndex: ctx.stationIndex,
        });
        return { action: "confirm_max_shifts", maxShifts: Math.trunc(maxShifts), total };
      }
    }
  }

  return { action: "apply", next };
}

import type { PlanningWorker } from "../types";
import type { ManualDragSource } from "./planning-v2-manual-drop";
import {
  readLinkedPlansFromMemory,
  resolveAssignmentsForSharedAlternative,
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

function normName(s: unknown): string {
  return String(s || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
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

export function isWorkerAlreadyAssignedInShift(
  assignments: Record<string, Record<string, string[][]>>,
  dayKey: string,
  shiftName: string,
  workerName: string,
  dragSource?: ManualDragSource | null,
): boolean {
  const t = normName(workerName);
  if (!t) return false;
  const perStation: string[][] = (assignments?.[dayKey]?.[shiftName] || []) as string[][];
  for (let sIdx = 0; sIdx < perStation.length; sIdx++) {
    const names = perStation[sIdx] || [];
    for (let slotIdx = 0; slotIdx < names.length; slotIdx++) {
      if (normName(names[slotIdx]) !== t) continue;
      if (
        dragSource &&
        normName(dragSource.workerName) === t &&
        dragSource.dayKey === dayKey &&
        dragSource.shiftName === shiftName &&
        Number(dragSource.stationIndex) === sIdx &&
        Number(dragSource.slotIndex) === slotIdx
      ) {
        continue;
      }
      return true;
    }
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

type LinkedShiftKind = "morning" | "noon" | "night";

type LinkedShiftSlot = { dayKey: string; kind: LinkedShiftKind };

export type WorkerLinkedAssignmentOnOtherSite = {
  siteId: string;
  siteName: string | null;
  dayKey: string;
  kind: LinkedShiftKind;
  shiftName: string;
};

function linkedSiteNameForWorker(workers: PlanningWorker[], workerName: string, siteId: string): string | null {
  const trimmed = String(workerName || "").trim();
  if (!trimmed) return null;
  const worker = workers.find((w) => (w.name || "").trim() === trimmed);
  const ids = Array.isArray(worker?.linkedSiteIds) ? (worker.linkedSiteIds as number[]) : [];
  const names = Array.isArray(worker?.linkedSiteNames) ? (worker.linkedSiteNames as string[]) : [];
  const idx = ids.findIndex((id) => String(id) === String(siteId));
  if (idx < 0) return null;
  const name = String(names[idx] || "").trim();
  return name || null;
}

/** Cases interdites sur le site courant quand l’עובד est déjà שובץ sur un site lié (dayKey, kind). */
export function linkedForbiddenSlotsFromAssignment(dayKey: string, kind: LinkedShiftKind): LinkedShiftSlot[] {
  const slots: LinkedShiftSlot[] = [{ dayKey, kind }];
  if (kind === "morning") {
    slots.push({ dayKey: prevDayKeyOf(dayKey), kind: "night" });
    slots.push({ dayKey, kind: "noon" });
  } else if (kind === "noon") {
    slots.push({ dayKey, kind: "morning" });
    slots.push({ dayKey, kind: "night" });
  } else if (kind === "night") {
    slots.push({ dayKey, kind: "noon" });
    slots.push({ dayKey: nextDayKeyOf(dayKey), kind: "morning" });
  }
  return slots;
}

function linkedSiteIdsForWorker(workers: PlanningWorker[], workerName: string): number[] {
  const trimmed = String(workerName || "").trim();
  if (!trimmed) return [];
  const worker = workers.find((w) => (w.name || "").trim() === trimmed);
  return Array.isArray(worker?.linkedSiteIds)
    ? (worker.linkedSiteIds as number[]).map((id: number) => Number(id)).filter(Number.isFinite)
    : [];
}

/** Toutes les משמרות (jour + type) où l’עובד est שובץ sur les autres sites liés. */
export function listWorkerLinkedAssignmentsOnOtherSites(
  currentSiteId: string,
  weekStart: Date,
  workers: PlanningWorker[],
  workerName: string,
): WorkerLinkedAssignmentOnOtherSite[] {
  const trimmed = String(workerName || "").trim();
  if (!trimmed) return [];
  const linkedSiteIds = linkedSiteIdsForWorker(workers, trimmed);
  if (linkedSiteIds.length <= 1) return [];
  const linkedMemory = readLinkedPlansFromMemory(weekStart);
  const activeAltIndex = Number(linkedMemory?.activeAltIndex || 0);
  const out: WorkerLinkedAssignmentOnOtherSite[] = [];
  const seen = new Set<string>();

  for (const linkedSiteId of linkedSiteIds) {
    if (String(linkedSiteId) === String(currentSiteId)) continue;
    const siteKey = String(linkedSiteId);
    const plan = linkedMemory?.plansBySite?.[siteKey];
    const asg = plan ? resolveAssignmentsForSharedAlternative(plan, activeAltIndex) : null;
    if (!asg || typeof asg !== "object") continue;
    const siteName = linkedSiteNameForWorker(workers, trimmed, siteKey);
    for (const assignmentDayKey of Object.keys(asg)) {
      const shiftsMap = asg[assignmentDayKey] || {};
      for (const candidateShiftName of Object.keys(shiftsMap)) {
        const kind = detectShiftKind(candidateShiftName);
        if (kind === "other") continue;
        const perStation = (shiftsMap as Record<string, string[][]>)[candidateShiftName] || [];
        const assigned = perStation.some((namesHere) =>
          (namesHere || []).some((nm) => String(nm || "").trim() === trimmed),
        );
        if (!assigned) continue;
        const key = `${siteKey}|${assignmentDayKey}|${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          siteId: siteKey,
          siteName,
          dayKey: assignmentDayKey,
          kind,
          shiftName: candidateShiftName,
        });
      }
    }
  }
  return out;
}

export function listWorkerLinkedShiftAssignmentsOnOtherSites(
  currentSiteId: string,
  weekStart: Date,
  workers: PlanningWorker[],
  workerName: string,
): LinkedShiftSlot[] {
  return listWorkerLinkedAssignmentsOnOtherSites(currentSiteId, weekStart, workers, workerName).map(
    ({ dayKey, kind }) => ({ dayKey, kind }),
  );
}

/** Clés `${dayKey}|${kind}` interdites pour le drag manuel (sites liés + site courant, gardes adjacentes). */
export function listCurrentSiteShiftAssignmentsForWorker(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  workerName: string,
  dragSource?: ManualDragSource | null,
): LinkedShiftSlot[] {
  const trimmed = String(workerName || "").trim();
  if (!trimmed || !assignments || typeof assignments !== "object") return [];
  const t = normName(trimmed);
  const out: LinkedShiftSlot[] = [];
  const seen = new Set<string>();
  for (const dayKey of Object.keys(assignments)) {
    const shiftsMap = assignments[dayKey] || {};
    for (const shiftName of Object.keys(shiftsMap)) {
      const kind = detectShiftKind(shiftName);
      if (kind === "other") continue;
      const perStation = (shiftsMap as Record<string, string[][]>)[shiftName] || [];
      let assigned = false;
      for (let sIdx = 0; sIdx < perStation.length; sIdx++) {
        const names = perStation[sIdx] || [];
        for (let slotIdx = 0; slotIdx < names.length; slotIdx++) {
          if (normName(names[slotIdx]) !== t) continue;
          if (
            dragSource &&
            normName(dragSource.workerName) === t &&
            dragSource.dayKey === dayKey &&
            dragSource.shiftName === shiftName &&
            Number(dragSource.stationIndex) === sIdx &&
            Number(dragSource.slotIndex) === slotIdx
          ) {
            continue;
          }
          assigned = true;
          break;
        }
        if (assigned) break;
      }
      if (!assigned) continue;
      const key = `${dayKey}|${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ dayKey, kind });
    }
  }
  return out;
}

export function buildManualDropForbiddenSlotKeySet(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  currentSiteId: string,
  weekStart: Date,
  workers: PlanningWorker[],
  workerName: string,
  dragSource?: ManualDragSource | null,
): Set<string> {
  const keys = new Set<string>();
  const addFromSlots = (slots: LinkedShiftSlot[]) => {
    for (const assignment of slots) {
      for (const forbidden of linkedForbiddenSlotsFromAssignment(assignment.dayKey, assignment.kind)) {
        keys.add(`${forbidden.dayKey}|${forbidden.kind}`);
      }
    }
  };
  addFromSlots(
    listWorkerLinkedShiftAssignmentsOnOtherSites(currentSiteId, weekStart, workers, workerName),
  );
  addFromSlots(listCurrentSiteShiftAssignmentsForWorker(assignments, workerName, dragSource));
  return keys;
}

/** Clés `${dayKey}|${kind}` interdites pour le drag manuel multi-site (garde + gardes adjacentes). */
export function buildLinkedSiteForbiddenSlotKeySet(
  currentSiteId: string,
  weekStart: Date,
  workers: PlanningWorker[],
  workerName: string,
): Set<string> {
  return buildManualDropForbiddenSlotKeySet(undefined, currentSiteId, weekStart, workers, workerName);
}

function linkedSiteConflictMessage(
  targetDayKey: string,
  targetKind: LinkedShiftKind,
  otherDayKey: string,
  otherKind: LinkedShiftKind,
): string {
  if (targetDayKey === otherDayKey && targetKind === otherKind) {
    return "העובד כבר משובץ במשמרת חופפת באתר מקושר.";
  }
  if (targetKind === "morning" && otherKind === "night" && targetDayKey === nextDayKeyOf(otherDayKey)) {
    return "העובד כבר משובץ בלילה קודם באתר מקושר.";
  }
  if (targetKind === "noon" && otherKind === "morning" && targetDayKey === otherDayKey) {
    return "העובד כבר משובץ בבוקר באותו יום באתר מקושר.";
  }
  if (targetKind === "morning" && otherKind === "noon" && targetDayKey === otherDayKey) {
    return "העובד כבר משובץ בצהריים באותו יום באתר מקושר.";
  }
  if (targetKind === "night" && otherKind === "noon" && targetDayKey === otherDayKey) {
    return "העובד כבר משובץ בצהריים באותו יום באתר מקושר.";
  }
  if (targetKind === "noon" && otherKind === "night" && targetDayKey === otherDayKey) {
    return "העובד כבר משובץ בלילה באותו יום באתר מקושר.";
  }
  if (targetKind === "night" && otherKind === "morning" && targetDayKey === prevDayKeyOf(otherDayKey)) {
    return "העובד כבר משובץ בבוקר שלמחרת באתר מקושר.";
  }
  return "העובד כבר משובץ במשמרת סמוכה באתר מקושר.";
}

const SAME_SITE_ADJACENT_MSG = "אין משמרות צמודות (כולל חציית יום)";

/** Conflit garde (site courant + sites liés) — même logique partout, avec exclusion de la source en déplacement. */
export function getManualShiftConflictReason(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  currentSiteId: string,
  weekStart: Date,
  workers: PlanningWorker[],
  workerName: string,
  dayKey: string,
  shiftName: string,
  dragSource?: ManualDragSource | null,
): string | null {
  const trimmed = String(workerName || "").trim();
  if (!trimmed) return null;
  const kind = detectShiftKind(shiftName);
  if (kind === "other") {
    if (hasWorkerAssignmentOnOtherLinkedSite(currentSiteId, weekStart, workers, trimmed, dayKey, shiftName, "same")) {
      return "העובד כבר משובץ במשמרת חופפת באתר מקושר.";
    }
    if (isWorkerAlreadyAssignedInShift(assignments || {}, dayKey, shiftName, trimmed, dragSource)) {
      return "העובד כבר משובץ במשמרת זו ולא ניתן לשבץ אותו שוב.";
    }
    return null;
  }
  const targetKey = `${dayKey}|${kind}`;
  const forbiddenKeys = buildManualDropForbiddenSlotKeySet(
    assignments,
    currentSiteId,
    weekStart,
    workers,
    trimmed,
    dragSource,
  );
  if (!forbiddenKeys.has(targetKey)) return null;
  for (const other of listWorkerLinkedAssignmentsOnOtherSites(
    currentSiteId,
    weekStart,
    workers,
    trimmed,
  )) {
    for (const forbidden of linkedForbiddenSlotsFromAssignment(other.dayKey, other.kind)) {
      if (`${forbidden.dayKey}|${forbidden.kind}` !== targetKey) continue;
      return linkedSiteConflictMessage(dayKey, kind, other.dayKey, other.kind);
    }
  }
  for (const current of listCurrentSiteShiftAssignmentsForWorker(assignments, trimmed, dragSource)) {
    for (const forbidden of linkedForbiddenSlotsFromAssignment(current.dayKey, current.kind)) {
      if (`${forbidden.dayKey}|${forbidden.kind}` !== targetKey) continue;
      return SAME_SITE_ADJACENT_MSG;
    }
  }
  return SAME_SITE_ADJACENT_MSG;
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
  const linkedSiteIds = linkedSiteIdsForWorker(workers, trimmed);
  if (linkedSiteIds.length <= 1) return false;
  const linkedMemory = readLinkedPlansFromMemory(weekStart);
  const activeAltIndex = Number(linkedMemory?.activeAltIndex || 0);
  const targetKind = detectShiftKind(shiftName);
  for (const linkedSiteId of linkedSiteIds) {
    if (String(linkedSiteId) === String(currentSiteId)) continue;
    const plan = linkedMemory?.plansBySite?.[String(linkedSiteId)];
    const asg = plan ? resolveAssignmentsForSharedAlternative(plan, activeAltIndex) : null;
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

/** « משובץ » uniquement sur la garde exacte déjà occupée sur un autre site lié (pas les gardes adjacentes). */
export function isLinkedSiteExactAssignmentConflictCell(
  currentSiteId: string,
  weekStart: Date,
  workers: PlanningWorker[],
  workerName: string,
  dayKey: string,
  shiftName: string,
): boolean {
  const trimmed = String(workerName || "").trim();
  if (!trimmed) return false;
  const kind = detectShiftKind(shiftName);
  if (kind === "other") {
    return hasWorkerAssignmentOnOtherLinkedSite(
      currentSiteId,
      weekStart,
      workers,
      trimmed,
      dayKey,
      shiftName,
      "same",
    );
  }
  const targetKey = `${dayKey}|${kind}`;
  return listWorkerLinkedAssignmentsOnOtherSites(currentSiteId, weekStart, workers, trimmed).some(
    (other) => `${other.dayKey}|${other.kind}` === targetKey,
  );
}

/** Libellé court (hébreu) à afficher dans la cellule rouge pendant le drag — garde exacte seulement. */
export function getLinkedSiteConflictCellLabel(
  currentSiteId: string,
  weekStart: Date,
  workers: PlanningWorker[],
  workerName: string,
  dayKey: string,
  shiftName: string,
): string | null {
  return isLinkedSiteExactAssignmentConflictCell(
    currentSiteId,
    weekStart,
    workers,
    workerName,
    dayKey,
    shiftName,
  )
    ? "משובץ"
    : null;
}

export function getLinkedSiteConflictReason(
  currentSiteId: string,
  weekStart: Date,
  workers: PlanningWorker[],
  workerName: string,
  dayKey: string,
  shiftName: string,
  assignments?: Record<string, Record<string, string[][]>> | null,
  dragSource?: ManualDragSource | null,
): string | null {
  return getManualShiftConflictReason(
    assignments,
    currentSiteId,
    weekStart,
    workers,
    workerName,
    dayKey,
    shiftName,
    dragSource,
  );
}


import type { PlanningV2PullEntry, PlanningV2PullsMap } from "../types";
import { planningV2PullEntryIsReal } from "./planning-v2-worker-name";

export type AssignmentsMap = Record<string, Record<string, string[][]>>;

export type ManualSlotTarget = {
  dayKey: string;
  shiftName: string;
  stationIndex: number;
  slotIndex: number;
};

export type ManualSlotUpsertInput = ManualSlotTarget & {
  workerName?: string | null;
  roleName?: string | null;
  start?: string | null;
  end?: string | null;
};

export type ManualSlotMutationResult = {
  assignments: AssignmentsMap;
  pulls: PlanningV2PullsMap;
  slotIndex: number;
  key: string;
};

export function manualSlotKey(
  dayKey: string,
  shiftName: string,
  stationIndex: number,
  slotIndex: number,
): string {
  return `${dayKey}|${shiftName}|${stationIndex}|${slotIndex}`;
}

export function parseManualSlotKey(key: string): ManualSlotTarget | null {
  const parts = String(key || "").split("|");
  if (parts.length < 4) return null;
  const dayKey = String(parts[0] || "").trim();
  const shiftName = String(parts[1] || "").trim();
  const stationIndex = Number(parts[2]);
  const slotIndex = Number(parts[3]);
  if (!dayKey || !shiftName) return null;
  if (!Number.isFinite(stationIndex) || stationIndex < 0) return null;
  if (!Number.isFinite(slotIndex) || slotIndex < 0) return null;
  return { dayKey, shiftName, stationIndex, slotIndex };
}

export function isManualSlotPullEntry(entry: PlanningV2PullEntry | null | undefined): boolean {
  if (!entry || typeof entry !== "object") return false;
  return entry.manualSlot === true || (typeof entry.manualSlot === "object" && entry.manualSlot != null);
}

export function manualSlotRoleName(entry: PlanningV2PullEntry | null | undefined): string | null {
  if (!isManualSlotPullEntry(entry)) return null;
  if (entry?.manualSlot && typeof entry.manualSlot === "object") {
    const rn = String(entry.manualSlot.roleName || "").trim();
    return rn || null;
  }
  const legacy = String(entry?.roleName || "").trim();
  return legacy || null;
}

/** Slot ajouté au-delà de la capacité config, ou marqué explicitement manualSlot. */
export function isManualExtraSlot(
  pulls: PlanningV2PullsMap | Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIndex: number,
  slotIndex: number,
  required: number,
): boolean {
  const key = manualSlotKey(dayKey, shiftName, stationIndex, slotIndex);
  const entry = pulls?.[key] as PlanningV2PullEntry | undefined;
  if (isManualSlotPullEntry(entry)) return true;
  if (planningV2PullEntryIsReal(entry)) return false;
  return slotIndex >= Math.max(0, Number(required || 0));
}

/** Nombre de slots requis pour couvrir les postes שיבוץ d’une cellule (index max + 1). */
export function manualSlotSpanInCell(
  pulls: PlanningV2PullsMap | Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIndex: number,
): number {
  if (!pulls) return 0;
  const prefix = `${dayKey}|${shiftName}|${stationIndex}|`;
  let span = 0;
  for (const [key, entry] of Object.entries(pulls)) {
    if (!String(key).startsWith(prefix)) continue;
    if (!isManualSlotPullEntry(entry as PlanningV2PullEntry)) continue;
    const parsed = parseManualSlotKey(key);
    if (!parsed) continue;
    span = Math.max(span, parsed.slotIndex + 1);
  }
  return span;
}

export type ExportCellSlot = {
  name: string;
  slotIndex: number;
  manual: boolean;
  roleName: string | null;
  start: string;
  end: string;
};

/**
 * Slots à exporter pour une cellule garde : affectations réelles (index d’origine conservé)
 * plus les postes שיבוץ, y compris vacants.
 */
export function buildExportCellSlots(
  assignments: AssignmentsMap | null | undefined,
  pulls: PlanningV2PullsMap | Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIndex: number,
): ExportCellSlot[] {
  const cell = assignments?.[dayKey]?.[shiftName]?.[stationIndex];
  const names = Array.isArray(cell) ? (cell as unknown[]).map((x) => String(x ?? "").trim()) : [];
  const span = Math.max(names.length, manualSlotSpanInCell(pulls, dayKey, shiftName, stationIndex));
  const out: ExportCellSlot[] = [];
  for (let i = 0; i < span; i++) {
    const entry = pulls?.[manualSlotKey(dayKey, shiftName, stationIndex, i)] as
      | PlanningV2PullEntry
      | undefined;
    const manual = isManualSlotPullEntry(entry);
    const name = names[i] || "";
    if (!name && !manual) continue;
    out.push({
      name,
      slotIndex: i,
      manual,
      roleName: manual ? manualSlotRoleName(entry) : null,
      start: String(entry?.guardDisplay?.start || "").trim(),
      end: String(entry?.guardDisplay?.end || "").trim(),
    });
  }
  return out;
}

function cloneAssignments(assignments: AssignmentsMap | null | undefined): AssignmentsMap {
  return JSON.parse(JSON.stringify(assignments || {})) as AssignmentsMap;
}

function clonePulls(pulls: PlanningV2PullsMap | null | undefined): PlanningV2PullsMap {
  return JSON.parse(JSON.stringify(pulls || {})) as PlanningV2PullsMap;
}

function ensureStationRow(
  assignments: AssignmentsMap,
  dayKey: string,
  shiftName: string,
  stationIndex: number,
): string[] {
  if (!assignments[dayKey]) assignments[dayKey] = {};
  if (!Array.isArray(assignments[dayKey][shiftName])) assignments[dayKey][shiftName] = [];
  const rows = assignments[dayKey][shiftName];
  while (rows.length <= stationIndex) rows.push([]);
  const cell = Array.isArray(rows[stationIndex]) ? [...(rows[stationIndex] as string[])] : [];
  rows[stationIndex] = cell;
  return cell;
}

function buildManualPullEntry(input: {
  roleName?: string | null;
  start?: string | null;
  end?: string | null;
  existing?: PlanningV2PullEntry | null;
}): PlanningV2PullEntry {
  const roleName = String(input.roleName || "").trim() || null;
  const start = String(input.start || "").trim();
  const end = String(input.end || "").trim();
  const next: PlanningV2PullEntry = {
    ...(input.existing && typeof input.existing === "object" ? input.existing : {}),
    manualSlot: roleName ? { roleName } : {},
  };
  // Ne pas conserver une vraie משיכה sur un poste שיבוץ.
  delete next.before;
  delete next.after;
  delete next.roleName;
  if (start && end) next.guardDisplay = { start, end };
  else delete next.guardDisplay;
  return next;
}

function reindexPullKeysAfterRemoval(
  pulls: PlanningV2PullsMap,
  dayKey: string,
  shiftName: string,
  stationIndex: number,
  removedSlotIndex: number,
): PlanningV2PullsMap {
  const prefix = `${dayKey}|${shiftName}|${stationIndex}|`;
  const next: PlanningV2PullsMap = {};
  for (const [key, entry] of Object.entries(pulls)) {
    if (!String(key).startsWith(prefix)) {
      next[key] = entry;
      continue;
    }
    const parsed = parseManualSlotKey(key);
    if (!parsed) {
      next[key] = entry;
      continue;
    }
    if (parsed.slotIndex === removedSlotIndex) continue;
    if (parsed.slotIndex > removedSlotIndex) {
      next[manualSlotKey(dayKey, shiftName, stationIndex, parsed.slotIndex - 1)] = entry;
    } else {
      next[key] = entry;
    }
  }
  return next;
}

/** Ajoute un poste parallèle (vacant ou avec עובד) à la fin de la cellule. */
export function appendManualSlot(
  assignments: AssignmentsMap | null | undefined,
  pulls: PlanningV2PullsMap | null | undefined,
  input: Omit<ManualSlotUpsertInput, "slotIndex"> & { slotIndex?: number },
): ManualSlotMutationResult {
  const nextAssignments = cloneAssignments(assignments);
  const nextPulls = clonePulls(pulls);
  const cell = ensureStationRow(nextAssignments, input.dayKey, input.shiftName, input.stationIndex);
  const slotIndex =
    input.slotIndex != null && Number.isFinite(input.slotIndex) && input.slotIndex >= 0
      ? Math.trunc(input.slotIndex)
      : cell.length;
  while (cell.length <= slotIndex) cell.push("");
  cell[slotIndex] = String(input.workerName || "").trim();
  nextAssignments[input.dayKey][input.shiftName][input.stationIndex] = cell;
  const key = manualSlotKey(input.dayKey, input.shiftName, input.stationIndex, slotIndex);
  nextPulls[key] = buildManualPullEntry({
    roleName: input.roleName,
    start: input.start,
    end: input.end,
    existing: nextPulls[key],
  });
  return { assignments: nextAssignments, pulls: nextPulls, slotIndex, key };
}

/** Met à jour un poste שיבוץ existant (nom / rôle / heures). */
export function updateManualSlot(
  assignments: AssignmentsMap | null | undefined,
  pulls: PlanningV2PullsMap | null | undefined,
  input: ManualSlotUpsertInput,
): ManualSlotMutationResult {
  const nextAssignments = cloneAssignments(assignments);
  const nextPulls = clonePulls(pulls);
  const cell = ensureStationRow(nextAssignments, input.dayKey, input.shiftName, input.stationIndex);
  while (cell.length <= input.slotIndex) cell.push("");
  cell[input.slotIndex] = String(input.workerName || "").trim();
  nextAssignments[input.dayKey][input.shiftName][input.stationIndex] = cell;
  const key = manualSlotKey(input.dayKey, input.shiftName, input.stationIndex, input.slotIndex);
  nextPulls[key] = buildManualPullEntry({
    roleName: input.roleName,
    start: input.start,
    end: input.end,
    existing: nextPulls[key],
  });
  return { assignments: nextAssignments, pulls: nextPulls, slotIndex: input.slotIndex, key };
}

/** Supprime un poste שיבוץ et réindexe les clés pulls de la cellule. */
export function removeManualSlot(
  assignments: AssignmentsMap | null | undefined,
  pulls: PlanningV2PullsMap | null | undefined,
  target: ManualSlotTarget,
): ManualSlotMutationResult {
  const nextAssignments = cloneAssignments(assignments);
  const cell = ensureStationRow(nextAssignments, target.dayKey, target.shiftName, target.stationIndex);
  if (target.slotIndex < cell.length) {
    cell.splice(target.slotIndex, 1);
  }
  nextAssignments[target.dayKey][target.shiftName][target.stationIndex] = cell;
  const nextPulls = reindexPullKeysAfterRemoval(
    clonePulls(pulls),
    target.dayKey,
    target.shiftName,
    target.stationIndex,
    target.slotIndex,
  );
  return {
    assignments: nextAssignments,
    pulls: nextPulls,
    slotIndex: target.slotIndex,
    key: manualSlotKey(target.dayKey, target.shiftName, target.stationIndex, target.slotIndex),
  };
}

export function listRolesForStationShift(
  station: Record<string, unknown> | null | undefined,
  shiftName: string,
  dayKey: string,
): string[] {
  const out: string[] = [];
  const push = (name: unknown, enabled: unknown) => {
    const nm = String(name || "").trim();
    if (!nm || enabled === false) return;
    if (!out.includes(nm)) out.push(nm);
  };
  const st = station || {};
  const dayOverrides = (st.dayOverrides || {}) as Record<string, { shifts?: unknown[] }>;
  const dayCfg = dayOverrides[dayKey];
  const dayShifts = Array.isArray(dayCfg?.shifts) ? dayCfg.shifts : [];
  const dayShift = dayShifts.find((sh) => String((sh as { name?: string })?.name || "") === shiftName) as
    | { roles?: unknown[] }
    | undefined;
  if (dayShift && Array.isArray(dayShift.roles)) {
    for (const r of dayShift.roles) {
      const role = r as { name?: string; enabled?: boolean };
      push(role?.name, role?.enabled !== false);
    }
  }
  const shifts = Array.isArray(st.shifts) ? (st.shifts as Array<{ name?: string; roles?: unknown[] }>) : [];
  const shift = shifts.find((sh) => String(sh?.name || "") === shiftName);
  if (shift && Array.isArray(shift.roles)) {
    for (const r of shift.roles) {
      const role = r as { name?: string; enabled?: boolean };
      push(role?.name, role?.enabled !== false);
    }
  }
  if (Array.isArray(st.roles)) {
    for (const r of st.roles as Array<{ name?: string; enabled?: boolean }>) {
      push(r?.name, r?.enabled !== false);
    }
  }
  return out;
}

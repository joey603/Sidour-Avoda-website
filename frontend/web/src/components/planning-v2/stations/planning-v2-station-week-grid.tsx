"use client";

import { useMemo, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import type { PlanningV2PullEntry, PlanningWorker, SiteSummary } from "../types";
import { addDays, formatHebDate } from "../lib/week";
import { assignmentsNonEmpty } from "../lib/assignments-empty";
import type { ManualDragSource } from "../lib/planning-v2-manual-drop";
import {
  canHighlightManualDropTarget,
  getLinkedSiteConflictReason,
  workerHasRole,
} from "../lib/planning-v2-manual-full-drop";
import {
  alignNamesToRoleSlots,
  buildPullRoleMapForCell,
  computeRoleDisplayForCell,
  resolvePullRoleNameForWorker,
} from "../lib/planning-v2-slot-role-display";
import { PlanningV2ManualWorkerPalette } from "../planning-v2-manual-worker-palette";
import {
  DAY_COLS,
  getRequiredFor,
  hoursFromConfig,
  hoursOf,
  isDayActive,
  planningCellNames,
  shiftNamesFromSite,
  stationHasIsolatedHole,
} from "../lib/station-grid-helpers";
import {
  buildDistinctWorkerColorMap,
  buildPlanningRoleColorMapFromSite,
  planningColorForRoleChip,
  workerNameChipColor,
} from "../lib/worker-name-chip-color";
import TimePicker from "@/components/time-picker";

type PlanningV2StationWeekGridProps = {
  site: SiteSummary | null;
  siteId?: string;
  weekStart: Date;
  workers?: PlanningWorker[];
  assignments: Record<string, Record<string, string[][]>> | null | undefined;
  /** חלופות — כמו `aiPlan.alternatives` ב-planning : couleurs stables par travailleur sur toutes les variantes. */
  assignmentVariants?: Array<Record<string, Record<string, string[][]>>> | null;
  /** מפת שיבוצים כמו `getLatestAssignmentBase` — להדגשת יעד גרירה תואמת ל-analyzeManualSlotDrop */
  assignmentHighlightBase?: Record<string, Record<string, string[][]>> | null;
  pulls?: Record<string, unknown> | null;
  draftFixedAssignmentsSnapshot?: Record<string, Record<string, string[][]>> | null;
  isSavedMode?: boolean;
  editingSaved?: boolean;
  loading?: boolean;
  isManual?: boolean;
  manualEditable?: boolean;
  pullsModeStationIdx?: number | null;
  onTogglePullsModeStation?: (stationIdx: number) => void;
  onResetStation?: (stationIdx: number) => void;
  draggingWorkerName?: string | null;
  onDraggingWorkerChange?: (workerName: string | null) => void;
  availabilityByWorkerName?: Record<string, Record<string, string[]>>;
  availabilityOverlays?: Record<string, Record<string, string[]>>;
  onManualSlotDragOutside?: (dragSource: ManualDragSource) => void | Promise<void>;
  onUpsertPull?: (key: string, entry: PlanningV2PullEntry) => boolean | void | Promise<boolean | void>;
  onRemovePull?: (key: string) => void | boolean | Promise<boolean | void>;
  onManualSlotDrop?: (p: {
    dayKey: string;
    shiftName: string;
    stationIndex: number;
    slotIndex: number;
    workerName: string;
    dragSource: ManualDragSource | null;
  }) => void | Promise<void>;
  /** Surbrillance globale (ex. clic sur l’עובד dans סיכום שיבוצים). */
  summaryHighlightWorkerName?: string | null;
};

function normName(s: unknown): string {
  return String(s || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

function draftFixedCellNamesInRow(row: unknown): string[] {
  if (!Array.isArray(row)) return [];
  const out: string[] = [];
  for (const cell of row) {
    if (Array.isArray(cell)) {
      for (const inner of cell) {
        const n = normName(inner);
        if (n) out.push(n);
      }
    } else {
      const n = normName(cell);
      if (n) out.push(n);
    }
  }
  return out;
}

function isWorkerInDraftFixedSnapshot(
  snap: Record<string, Record<string, string[][]>> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  workerName: string,
): boolean {
  if (!snap) return false;
  const row = snap[dayKey]?.[shiftName]?.[stationIdx];
  const names = draftFixedCellNamesInRow(row);
  const n = normName(workerName);
  if (!n) return false;
  return names.includes(n);
}

function shouldShowDraftFixedPinForWorker(
  snap: Record<string, Record<string, string[][]>> | null | undefined,
  isSavedMode: boolean,
  editingSaved: boolean,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  workerName: string,
  cellAssignedNames: string[],
): boolean {
  if (!snap || (isSavedMode && !editingSaved)) return false;
  const snapNames = draftFixedCellNamesInRow(snap[dayKey]?.[shiftName]?.[stationIdx]);
  if (!snapNames.length) return false;
  // Affichage robuste du cadenas: dès que le worker fait partie du snapshot fixe de la cellule.
  // Le planning classique garde aussi ce comportement visuel après génération autour des fixes.
  return isWorkerInDraftFixedSnapshot(snap, dayKey, shiftName, stationIdx, workerName);
}

function truncateMobile6(value: unknown): string {
  const s = String(value ?? "");
  const chars = Array.from(s);
  return chars.length > 6 ? chars.slice(0, 4).join("") + "…" : s;
}

function isRtlName(s: string): boolean {
  return /[\u0590-\u05FF]/.test(String(s || ""));
}

function expandedKeyFor(
  dayKey: string,
  shiftName: string,
  stationIndex: number,
  slotIndex: number,
  token: string,
): string {
  return `${dayKey}|${shiftName}|${stationIndex}|${slotIndex}|${token}`;
}

/** Plage horaire משיכה pour ce nom dans la cellule (affichage lecture seule). */
function pullTimeRangeForName(
  pulls: Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  workerName: string,
): string | null {
  if (!pulls) return null;
  const prefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  const nm = normName(workerName);
  for (const [k, v] of Object.entries(pulls)) {
    if (!String(k).startsWith(prefix)) continue;
    const e = v as {
      before?: { name?: string; start?: string; end?: string };
      after?: { name?: string; start?: string; end?: string };
    };
    if (normName(e?.before?.name) === nm) {
      const s = String(e?.before?.start || "").trim();
      const en = String(e?.before?.end || "").trim();
      if (s && en) return `${s}–${en}`;
    }
    if (normName(e?.after?.name) === nm) {
      const s = String(e?.after?.start || "").trim();
      const en = String(e?.after?.end || "").trim();
      if (s && en) return `${s}–${en}`;
    }
  }
  return null;
}

/** Nombre de משיכות dans la cellule (même préfixe que le planning). */
function countPullEntriesInCell(
  pulls: Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
): number {
  if (!pulls) return 0;
  const prefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  let n = 0;
  for (const k of Object.keys(pulls)) {
    if (String(k).startsWith(prefix)) n++;
  }
  return n;
}

/**
 * Tableau de slots (ordre préservé) + injection des noms משיכה dans les trous,
 * comme `cellRaw` dans le planning — base pour N sous-slots et comptage שיבוצים.
 */
function mergeCellRawWithPulls(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
): string[] {
  const cell = assignments?.[dayKey]?.[shiftName]?.[stationIdx];
  const baseArr: string[] = Array.isArray(cell)
    ? (cell as unknown[]).map((x) => String(x ?? ""))
    : [];
  const cellPrefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  const have = new Set(baseArr.map((x) => normName(x)).filter(Boolean));
  const normSlot = (s: unknown) => String(s ?? "");
  const addInto = (name: string) => {
    const n = normName(name);
    if (!n || have.has(n)) return;
    const emptyIdx = baseArr.findIndex((x) => !normName(x));
    if (emptyIdx >= 0) baseArr[emptyIdx] = normSlot(name);
    else baseArr.push(normSlot(name));
    have.add(n);
  };
  try {
    if (pulls) {
      Object.entries(pulls).forEach(([k, entry]) => {
        if (!String(k).startsWith(cellPrefix)) return;
        const e = entry as { before?: { name?: string }; after?: { name?: string } };
        const b = String(e?.before?.name || "").trim();
        const a = String(e?.after?.name || "").trim();
        if (b) addInto(b);
        if (a) addInto(a);
      });
    }
  } catch {
    /* ignore */
  }
  return baseArr;
}

function pullRingClass(
  pulls: Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  workerName: string,
): string {
  if (!pulls) return "";
  const prefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  const nm = normName(workerName);
  if (!nm) return "";
  for (const [k, v] of Object.entries(pulls)) {
    if (!String(k).startsWith(prefix)) continue;
    const e = v as { before?: { name?: string }; after?: { name?: string } };
    if (normName(e?.before?.name) === nm || normName(e?.after?.name) === nm) {
      return " ring-2 ring-orange-400";
    }
  }
  return "";
}

function parseHoursRange(range: string | null): { start: string; end: string } | null {
  const raw = String(range || "").trim();
  if (!raw) return null;
  const m = raw.match(/^\s*(\d{1,2})\s*[:\-]\s*(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*[:\-]\s*(\d{1,2})\s*$/);
  if (!m) return null;
  const h1 = Math.min(23, Math.max(0, Number(m[1])));
  const m1 = Math.min(59, Math.max(0, Number(m[2])));
  const h2 = Math.min(23, Math.max(0, Number(m[3])));
  const m2 = Math.min(59, Math.max(0, Number(m[4])));
  const pad = (n: number) => String(n).padStart(2, "0");
  return { start: `${pad(h1)}:${pad(m1)}`, end: `${pad(h2)}:${pad(m2)}` };
}

function splitRangeForPulls(start: string, end: string): { before: { start: string; end: string }; after: { start: string; end: string } } {
  const parseMin = (t: string): number => {
    const [h, m] = String(t || "00:00").split(":").map((x) => Number(x || 0));
    return ((h % 24) * 60 + (m % 60) + 1440) % 1440;
  };
  const fmt = (n: number): string => {
    const x = ((Math.round(n) % 1440) + 1440) % 1440;
    const h = Math.floor(x / 60);
    const m = x % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };
  const s = parseMin(start);
  const eRaw = parseMin(end);
  const e = eRaw <= s ? eRaw + 1440 : eRaw;
  const mid = s + (e - s) / 2;
  return {
    before: { start: fmt(s), end: fmt(mid) },
    after: { start: fmt(mid), end: fmt(e) },
  };
}

/**
 * Aligné sur `pullHighlightKindByName` du planning : anneau orange sur le trou + le `before` (garde précédente) + le `after` (garde suivante).
 */
function buildPullHighlightKindByNormName(
  pulls: Record<string, unknown> | null | undefined,
  shiftNamesAll: string[],
  dayIdx: number,
  dayKey: string,
  shiftName: string,
  stationIndex: number,
): Map<string, "cell" | "before" | "after"> {
  const out = new Map<string, "cell" | "before" | "after">();
  if (!pulls) return out;
  const shiftsCount = shiftNamesAll.length;
  const shiftIdx = shiftNamesAll.indexOf(shiftName);
  if (shiftIdx < 0) return out;

  const sameCoord = (a: { dayIdx: number; shiftIdx: number } | null, bDayIdx: number, bShiftIdx: number) =>
    !!a && a.dayIdx === bDayIdx && a.shiftIdx === bShiftIdx;

  for (const [pullKey, entryAny] of Object.entries(pulls)) {
    const parts = String(pullKey || "").split("|");
    if (parts.length < 4) continue;
    const pullDayKey = parts[0];
    const pullShiftName = parts[1];
    if (Number(parts[2]) !== Number(stationIndex)) continue;

    const pullDayIdx = DAY_COLS.findIndex((c) => c.key === pullDayKey);
    const pullShiftIdx = shiftNamesAll.indexOf(pullShiftName);
    if (pullDayIdx < 0 || pullShiftIdx < 0) continue;

    const pullPrevCoord =
      pullDayIdx === 0 && pullShiftIdx === 0
        ? null
        : pullShiftIdx === 0
          ? { dayIdx: pullDayIdx - 1, shiftIdx: shiftsCount - 1 }
          : { dayIdx: pullDayIdx, shiftIdx: pullShiftIdx - 1 };
    const pullNextCoord =
      pullDayIdx === DAY_COLS.length - 1 && pullShiftIdx === shiftsCount - 1
        ? null
        : pullShiftIdx === shiftsCount - 1
          ? { dayIdx: pullDayIdx + 1, shiftIdx: 0 }
          : { dayIdx: pullDayIdx, shiftIdx: pullShiftIdx + 1 };

    const entry = entryAny as { before?: { name?: string }; after?: { name?: string } };
    const beforeName = normName(entry?.before?.name || "");
    const afterName = normName(entry?.after?.name || "");

    if (pullDayKey === dayKey && pullShiftName === shiftName) {
      if (beforeName) out.set(beforeName, "cell");
      if (afterName) out.set(afterName, "cell");
      continue;
    }
    if (beforeName && sameCoord(pullPrevCoord, dayIdx, shiftIdx)) {
      out.set(beforeName, "before");
    }
    if (afterName && sameCoord(pullNextCoord, dayIdx, shiftIdx)) {
      out.set(afterName, "after");
    }
  }
  return out;
}

/**
 * גריד שבועי לפי עמדה — structure / tailles / couleurs alignées sur le planning (+ עריכה ידנית / DnD).
 */
export function PlanningV2StationWeekGrid({
  site,
  siteId = "",
  weekStart,
  workers = [],
  assignments,
  assignmentVariants = null,
  assignmentHighlightBase = null,
  pulls,
  draftFixedAssignmentsSnapshot = null,
  isSavedMode = false,
  editingSaved = false,
  loading,
  isManual = false,
  manualEditable = false,
  pullsModeStationIdx = null,
  draggingWorkerName = null,
  onDraggingWorkerChange,
  availabilityByWorkerName = {},
  availabilityOverlays = {},
  onManualSlotDragOutside,
  onUpsertPull,
  onRemovePull,
  onTogglePullsModeStation,
  onResetStation,
  onManualSlotDrop,
  summaryHighlightWorkerName = null,
}: PlanningV2StationWeekGridProps) {
  const [expandedSlotKey, setExpandedSlotKey] = useState<string | null>(null);
  const [hoverSlotKey, setHoverSlotKey] = useState<string | null>(null);
  const [pullsEditor, setPullsEditor] = useState<null | {
    key: string;
    dayKey: string;
    shiftName: string;
    stationIdx: number;
    required: number;
    shiftStart: string;
    shiftEnd: string;
    roleName?: string | null;
    beforeOptions: string[];
    afterOptions: string[];
    beforeName: string;
    afterName: string;
    beforeStart: string;
    beforeEnd: string;
    afterStart: string;
    afterEnd: string;
  }>(null);
  const dragSourceRef = useRef<ManualDragSource | null>(null);
  const didDropRef = useRef(false);
  const stations = (Array.isArray(site?.config?.stations) ? site?.config?.stations : []) as Record<
    string,
    unknown
  >[];
  const shiftNamesAll = shiftNamesFromSite(site);
  const summaryHighlightNorm = summaryHighlightWorkerName ? normName(summaryHighlightWorkerName) : "";
  const nameColorMap = useMemo(() => {
    const bundles = [assignments, ...(assignmentVariants ?? [])].filter(
      (x): x is Record<string, Record<string, string[][]>> => !!x && typeof x === "object",
    );
    return buildDistinctWorkerColorMap(workers || [], bundles);
  }, [workers, assignments, assignmentVariants]);

  /** Même `roleColorMap` / `colorForRole` que la page planning classique */
  const roleColorMapPlanning = useMemo(
    () => buildPlanningRoleColorMapFromSite(site, workers || []),
    [site, workers],
  );
  const availabilityOverlayByNormName = useMemo(() => {
    const out: Record<string, Record<string, Set<string>>> = {};
    for (const [workerName, byDay] of Object.entries(availabilityOverlays || {})) {
      const key = normName(workerName);
      if (!key) continue;
      const nextByDay: Record<string, Set<string>> = {};
      for (const [dayKey, shifts] of Object.entries(byDay || {})) {
        nextByDay[dayKey] = new Set((shifts || []).map((s) => String(s || "").trim()).filter(Boolean));
      }
      out[key] = nextByDay;
    }
    return out;
  }, [availabilityOverlays]);

  const onWorkerDragStart = (e: DragEvent, workerName: string) => {
    dragSourceRef.current = null;
    didDropRef.current = false;
    const el = e.currentTarget as HTMLElement;
    const dayKey = el?.getAttribute?.("data-dkey") || "";
    const shiftName = el?.getAttribute?.("data-sname") || "";
    const stationIndex = Number(el?.getAttribute?.("data-stidx") || NaN);
    const slotIndex = Number(el?.getAttribute?.("data-slotidx") || NaN);
    const isFromSlot = !!(dayKey && shiftName && Number.isFinite(stationIndex) && Number.isFinite(slotIndex));
    try {
      e.dataTransfer.setData("text/plain", workerName);
      e.dataTransfer.effectAllowed = manualEditable && isFromSlot ? "move" : "copy";
    } catch {
      /* ignore */
    }
    const nm = (workerName || "").trim();
    if (dayKey && shiftName && Number.isFinite(stationIndex) && Number.isFinite(slotIndex) && nm) {
      const srcPayload: ManualDragSource = { dayKey, shiftName, stationIndex, slotIndex, workerName: nm };
      dragSourceRef.current = srcPayload;
      try {
        e.dataTransfer.setData("application/x-planning-v2-drag-source", JSON.stringify(srcPayload));
      } catch {
        /* ignore */
      }
    }
    if (manualEditable && nm) onDraggingWorkerChange?.(nm);
  };

  const onSlotDragOver = (e: DragEvent) => {
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = dragSourceRef.current ? "move" : "copy";
    } catch {
      /* ignore */
    }
  };

  const onSlotDrop = (
    e: DragEvent,
    dayKey: string,
    shiftName: string,
    stationIndex: number,
    slotIndex: number,
  ) => {
    e.preventDefault();
    let name = "";
    let sourceFromData: ManualDragSource | null = null;
    try {
      name = e.dataTransfer.getData("text/plain");
      const srcRaw = e.dataTransfer.getData("application/x-planning-v2-drag-source");
      if (srcRaw) {
        const parsed = JSON.parse(srcRaw) as Partial<ManualDragSource>;
        if (
          parsed &&
          typeof parsed.dayKey === "string" &&
          typeof parsed.shiftName === "string" &&
          Number.isFinite(Number(parsed.stationIndex)) &&
          Number.isFinite(Number(parsed.slotIndex)) &&
          typeof parsed.workerName === "string"
        ) {
          sourceFromData = {
            dayKey: parsed.dayKey,
            shiftName: parsed.shiftName,
            stationIndex: Number(parsed.stationIndex),
            slotIndex: Number(parsed.slotIndex),
            workerName: parsed.workerName,
          };
        }
      }
    } catch {
      /* ignore */
    }
    const trimmed = name.trim();
    if (!trimmed || !onManualSlotDrop) return;
    const src = sourceFromData || dragSourceRef.current;
    didDropRef.current = true;
    setHoverSlotKey(null);
    onDraggingWorkerChange?.(null);
    void Promise.resolve(
      onManualSlotDrop({
        dayKey,
        shiftName,
        stationIndex,
        slotIndex,
        workerName: trimmed,
        dragSource: src,
      }),
    ).finally(() => {
      dragSourceRef.current = null;
    });
  };

  const onChipDragEnd = () => {
    const src = dragSourceRef.current;
    const shouldClearFromSource =
      manualEditable &&
      !!src &&
      !didDropRef.current &&
      typeof onManualSlotDragOutside === "function";
    dragSourceRef.current = null;
    didDropRef.current = false;
    setHoverSlotKey(null);
    onDraggingWorkerChange?.(null);
    if (shouldClearFromSource && src) {
      void Promise.resolve(onManualSlotDragOutside(src));
    }
  };

  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);

  if (loading) {
    return (
      <section className="space-y-4">
        <h2 className="text-center text-lg font-semibold">גריד שבועי לפי עמדה</h2>
        <div className="py-10 text-center text-sm text-zinc-500">טוען גריד…</div>
      </section>
    );
  }

  if (stations.length === 0) {
    return (
      <section className="space-y-4">
        <h2 className="text-center text-lg font-semibold">גריד שבועי לפי עמדה</h2>
        <p className="text-center text-sm text-zinc-500">אין עמדות מוגדרות בהגדרות האתר.</p>
      </section>
    );
  }

  const assignmentsSafe: Record<string, Record<string, string[][]>> =
    assignments && typeof assignments === "object" ? assignments : {};
  const highlightMap: Record<string, Record<string, string[][]>> =
    assignmentHighlightBase != null && typeof assignmentHighlightBase === "object"
      ? assignmentHighlightBase
      : assignmentsSafe;

  return (
    <section className="space-y-4">
      <h2 className="text-center text-lg font-semibold">גריד שבועי לפי עמדה</h2>

      <div className="space-y-6">
        {stations.map((st, idx: number) => (
          <div
            key={idx}
            className={
              "rounded-xl border border-zinc-200 p-3 dark:border-zinc-800 " +
              (pullsModeStationIdx === idx ? "ring-2 ring-orange-400 ring-offset-2 ring-offset-white dark:ring-offset-zinc-950" : "")
            }
          >
            <div className="mb-2 flex items-center justify-between">
              <div className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {String((st as { name?: unknown }).name || "") || `עמדה ${idx + 1}`}
              </div>
              <div className="flex items-center gap-1">
                {isManual && manualEditable && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        if (isSavedMode && !editingSaved) return;
                        if (pullsModeStationIdx === idx) {
                          onTogglePullsModeStation?.(idx);
                          return;
                        }
                        if (!assignmentsNonEmpty(assignmentsSafe)) {
                          toast.error("אין תכנון פעיל", {
                            description: "צור תכנון כדי להשתמש במשיכות",
                          });
                          return;
                        }
                        if (!stationHasIsolatedHole(site, assignmentsSafe, idx)) {
                          toast("אין חורים בעמדה זו", {
                            description: "לא נמצאה משמרת ריקה בין שתי משמרות",
                          });
                          return;
                        }
                        onTogglePullsModeStation?.(idx);
                      }}
                      disabled={isSavedMode && !editingSaved}
                      className={
                        "inline-flex items-center rounded-md border px-2 py-1 text-xs " +
                        (isSavedMode && !editingSaved
                          ? "cursor-not-allowed border-zinc-200 text-zinc-400 opacity-60 dark:border-zinc-700 dark:text-zinc-600"
                          : pullsModeStationIdx === idx
                            ? "border-orange-500 bg-orange-500 text-white hover:bg-orange-600 dark:border-orange-600 dark:bg-orange-600 dark:hover:bg-orange-700"
                            : "border-orange-400 text-orange-600 hover:bg-orange-50 dark:border-orange-700 dark:text-orange-400 dark:hover:bg-orange-900/20")
                      }
                    >
                      משיכות
                    </button>
                    <button
                      type="button"
                      onClick={() => onResetStation?.(idx)}
                      disabled={isSavedMode && !editingSaved}
                      className={
                        "inline-flex items-center rounded-md border px-2 py-1 text-xs " +
                        (isSavedMode && !editingSaved
                          ? "cursor-not-allowed border-zinc-200 text-zinc-400 opacity-60 dark:border-zinc-700 dark:text-zinc-600"
                          : "border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20")
                      }
                    >
                      איפוס עמדה
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="max-h-[24rem] overflow-y-auto overflow-x-hidden md:overflow-x-auto">
              <table className="w-full table-fixed border-collapse text-[8px] md:text-sm">
                <thead>
                  <tr className="border-b dark:border-zinc-800">
                    <th className="w-10 px-0 py-0.5 text-right align-bottom md:w-28 md:px-2 md:py-2 text-[8px] md:text-sm">
                      משמרת
                    </th>
                    {DAY_COLS.map((d, i) => {
                      const date = addDays(weekStart, i);
                      return (
                        <th key={d.key} className="px-0.5 py-0.5 text-center align-bottom md:px-2 md:py-2">
                          <div className="flex min-w-0 flex-col items-center leading-tight">
                            <span className="max-w-full truncate whitespace-nowrap text-[5px] text-zinc-500 md:text-xs">
                              {formatHebDate(date)}
                            </span>
                            <span className="mt-0.5 text-[8px] md:text-sm">{d.label}</span>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    if (shiftNamesAll.length === 0) {
                      return (
                        <tr>
                          <td colSpan={8} className="py-4 text-center text-xs text-zinc-500">
                            אין משמרות פעילות לעמדה זו
                          </td>
                        </tr>
                      );
                    }
                    return shiftNamesAll.map((sn) => {
                      const stationShift = ((st.shifts as unknown[]) || []).find(
                        (x) => (x as { name?: string })?.name === sn,
                      ) as { name?: string; enabled?: boolean } | undefined;
                      const shiftRowEnabled = !!stationShift?.enabled;
                      return (
                      <tr key={sn} className="border-b last:border-0 dark:border-zinc-800">
                        <td className="w-10 px-0 py-0.5 md:w-28 md:px-2 md:py-2">
                          <div className="flex min-w-0 flex-col items-start">
                            {(() => {
                              const h = hoursFromConfig(st, sn) || hoursOf(sn);
                              return h ? (
                                <div className="mb-0.5 text-[7px] leading-none text-zinc-500 md:text-[10px]" dir="ltr">
                                  {(() => {
                                    const s = String(h || "").trim();
                                    const parts = s.split(/[-–—]/).map((x) => x.trim()).filter(Boolean);
                                    if (parts.length >= 2) {
                                      return (
                                        <span className="flex flex-col">
                                          <span>{parts[0]}</span>
                                          <span>{parts[1]}</span>
                                        </span>
                                      );
                                    }
                                    return s;
                                  })()}
                                </div>
                              ) : null;
                            })()}
                            <div className="whitespace-normal break-words text-[6px] font-medium leading-tight md:text-sm">
                              {sn}
                            </div>
                          </div>
                        </td>
                        {DAY_COLS.map((d, dayIdx) => {
                          const required = getRequiredFor(st, sn, d.key);
                          const activeDay = isDayActive(st, d.key);
                          const dateCell = addDays(weekStart, dayIdx);
                          const isPastDay = dateCell < today0;
                          const pullsActiveHere = pullsModeStationIdx === idx;
                          const dndHere =
                            manualEditable &&
                            typeof onManualSlotDrop === "function" &&
                            pullsModeStationIdx !== idx;
                          const cellRaw = mergeCellRawWithPulls(
                            assignmentsSafe,
                            pulls || null,
                            d.key,
                            sn,
                            idx,
                          );
                          const assignedNamesNonEmpty = cellRaw
                            .map((x) => String(x || "").trim())
                            .filter(Boolean);
                          const showCell = activeDay && required > 0;
                          const pullsInCell = countPullEntriesInCell(pulls || null, d.key, sn, idx);
                          const assignedCount = Math.max(0, assignedNamesNonEmpty.length - pullsInCell);
                          const pullRoleMap = buildPullRoleMapForCell(pulls || null, d.key, sn, idx);
                          const baseRoleDisplay = computeRoleDisplayForCell(
                            workers,
                            st,
                            sn,
                            d.key,
                            cellRaw,
                            pullRoleMap,
                          );
                          const { roleHints } = baseRoleDisplay;
                          const displayCellRaw =
                            manualEditable ? cellRaw : alignNamesToRoleSlots(workers, cellRaw, roleHints);
                          const alignedRoleDisplay =
                            manualEditable || displayCellRaw === cellRaw
                              ? null
                              : computeRoleDisplayForCell(workers, st, sn, d.key, displayCellRaw, pullRoleMap);
                          const roleHintsExtended = alignedRoleDisplay?.roleHintsExtended ?? baseRoleDisplay.roleHintsExtended;
                          const roleForSlot = alignedRoleDisplay?.roleForSlot ?? baseRoleDisplay.roleForSlot;
                          const roleForName = alignedRoleDisplay?.roleForName ?? baseRoleDisplay.roleForName;
                          const slotCount = Math.max(
                            required + pullsInCell,
                            assignedNamesNonEmpty.length,
                            cellRaw.length,
                            displayCellRaw.length,
                            roleHints.length,
                            1,
                          );
                          const dragNm = (draggingWorkerName || "").trim();
                          const prevRef =
                            dayIdx === 0 && shiftNamesAll.indexOf(sn) === 0
                              ? null
                              : shiftNamesAll.indexOf(sn) === 0
                                ? { dayIdx: dayIdx - 1, shiftIdx: shiftNamesAll.length - 1 }
                                : { dayIdx, shiftIdx: shiftNamesAll.indexOf(sn) - 1 };
                          const nextRef =
                            dayIdx === DAY_COLS.length - 1 &&
                            shiftNamesAll.indexOf(sn) === shiftNamesAll.length - 1
                              ? null
                              : shiftNamesAll.indexOf(sn) === shiftNamesAll.length - 1
                                ? { dayIdx: dayIdx + 1, shiftIdx: 0 }
                                : { dayIdx, shiftIdx: shiftNamesAll.indexOf(sn) + 1 };
                          const isPullable =
                            required > 0 &&
                            activeDay &&
                            assignedNamesNonEmpty.length === 0 &&
                            !!prevRef &&
                            !!nextRef &&
                            (() => {
                              const prevDayKey = DAY_COLS[prevRef.dayIdx]?.key;
                              const nextDayKey = DAY_COLS[nextRef.dayIdx]?.key;
                              const prevShift = shiftNamesAll[prevRef.shiftIdx];
                              const nextShift = shiftNamesAll[nextRef.shiftIdx];
                              const prevNames = planningCellNames(assignmentsSafe?.[prevDayKey]?.[prevShift]?.[idx]);
                              const nextNames = planningCellNames(assignmentsSafe?.[nextDayKey]?.[nextShift]?.[idx]);
                              return prevNames.length > 0 && nextNames.length > 0;
                            })();
                          const pullHighlightByNormName = buildPullHighlightKindByNormName(
                            pulls || null,
                            shiftNamesAll,
                            dayIdx,
                            d.key,
                            sn,
                            idx,
                          );
                          const slotCanHighlight = (roleHint: string | null) =>
                            !!dragNm &&
                            dndHere &&
                            !availabilityOverlayByNormName[normName(dragNm)]?.[d.key]?.has(String(sn || "").trim()) &&
                            !getLinkedSiteConflictReason(siteId || "", weekStart, workers, dragNm, d.key, sn) &&
                            canHighlightManualDropTarget({
                              assignments: highlightMap,
                              siteId,
                              weekStart,
                              workers,
                              availabilityByWorkerName,
                              workerName: dragNm,
                              dayKey: d.key,
                              shiftName: sn,
                              stationIndex: idx,
                              roleHint,
                              dragSource: dragSourceRef.current,
                            });
                          const linkedConflictReason =
                            dragNm && dndHere
                              ? getLinkedSiteConflictReason(siteId || "", weekStart, workers, dragNm, d.key, sn)
                              : null;
                          const hasLinkedConflict = !!linkedConflictReason;

                          return (
                            <td
                              key={d.key}
                              className={
                                "px-2 py-2 text-center " +
                                (shiftRowEnabled ? "" : "text-zinc-400 ") +
                                (!activeDay ? "bg-zinc-100 text-zinc-400 dark:bg-zinc-900/40 " : "") +
                                (isPastDay ? " bg-zinc-100 dark:bg-zinc-900/40 " : "")
                              }
                            >
                              {shiftRowEnabled ? (
                                <div className="flex flex-col items-center rounded-md">
                                  {showCell ? (
                                <div className="mb-1 flex min-w-full flex-col items-center gap-1">
                                  {Array.from({ length: slotCount }).map((_, slotIdx) => {
                                    const nm = String(displayCellRaw[slotIdx] || "").trim();
                                    if (!nm) {
                                      const slotHoverKey = `${d.key}|${sn}|${idx}|${slotIdx}`;
                                      const isSlotHovered = hoverSlotKey === slotHoverKey;
                                      const emptyHintStr = String(roleHintsExtended[slotIdx] || "").trim();
                                      const emptyOk = slotCanHighlight(emptyHintStr || null);
                                      const erc = emptyHintStr
                                        ? planningColorForRoleChip(emptyHintStr, roleColorMapPlanning)
                                        : null;
                                      return (
                                        <div
                                          key={`empty-${d.key}-${sn}-${idx}-${slotIdx}`}
                                          className={
                                            "group/slot w-full flex justify-center py-0.5 " +
                                            (dndHere && dragNm && isSlotHovered
                                              ? "relative z-50 scale-[1.15] origin-center will-change-transform transition-transform duration-150 ease-out"
                                              : "")
                                          }
                                          onDragEnter={
                                            dndHere
                                              ? (e) => {
                                                  e.preventDefault();
                                                  e.stopPropagation();
                                                  setHoverSlotKey(slotHoverKey);
                                                }
                                              : undefined
                                          }
                                          onDragLeave={
                                            dndHere
                                              ? (e) => {
                                                  const rect = e.currentTarget.getBoundingClientRect();
                                                  const x = e.clientX;
                                                  const y = e.clientY;
                                                  if (
                                                    x < rect.left ||
                                                    x > rect.right ||
                                                    y < rect.top ||
                                                    y > rect.bottom
                                                  ) {
                                                    setHoverSlotKey((k) => (k === slotHoverKey ? null : k));
                                                  }
                                                }
                                              : undefined
                                          }
                                          onDragOver={
                                            dndHere
                                              ? (e) => {
                                                  onSlotDragOver(e);
                                                  if (dragNm) setHoverSlotKey(slotHoverKey);
                                                }
                                              : undefined
                                          }
                                          onDrop={dndHere ? (e) => onSlotDrop(e, d.key, sn, idx, slotIdx) : undefined}
                                          data-slot={dndHere ? "1" : undefined}
                                          data-dkey={d.key}
                                          data-sname={sn}
                                          data-stidx={idx}
                                          data-slotidx={slotIdx}
                                          data-rolehint={emptyHintStr || undefined}
                                        >
                                          <span
                                            aria-hidden
                                            className={
                                              "inline-flex min-h-6 min-w-[2.15rem] w-auto max-w-[6rem] flex-col items-center justify-center overflow-hidden rounded-full border px-1 py-0.5 text-[8px] transition-[max-width,transform] duration-200 ease-out md:min-h-9 md:w-full md:max-w-[6rem] md:px-3 md:py-1 md:text-xs md:group-hover/slot:max-w-[18rem] md:group-focus-within/slot:max-w-[18rem] " +
                                              (emptyHintStr
                                                ? erc && pullsActiveHere && isPullable
                                                  ? " border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900 "
                                                  : " bg-white dark:bg-zinc-900 "
                                                : " border-zinc-200 bg-zinc-100 text-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 ") +
                                              (pullsActiveHere && isPullable ? " ring-2 ring-orange-400 cursor-pointer" : "") +
                                              (!dragNm && isSlotHovered ? "scale-110 ring-2 ring-[#00A8E0]" : "") +
                                              (dragNm && emptyOk && !isSlotHovered ? " ring-2 ring-green-500" : "") +
                                              (dragNm && hasLinkedConflict && !isSlotHovered ? " ring-2 ring-red-500" : "") +
                                              (dragNm && emptyOk && isSlotHovered
                                                ? " [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22),0_0_0_2px_rgb(34_197_94)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38),0_0_0_2px_rgb(34_197_94)]"
                                                : "") +
                                              (dragNm && hasLinkedConflict && isSlotHovered
                                                ? "ring-2 ring-red-500 cursor-not-allowed [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38)]"
                                                : "") +
                                              (dragNm && !emptyOk && isSlotHovered
                                                ? "ring-2 ring-[#00A8E0] cursor-not-allowed [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38)]"
                                                : "")
                                            }
                                            style={
                                              erc && !(pullsActiveHere && isPullable)
                                                ? { borderColor: erc.border }
                                                : undefined
                                            }
                                            onClick={() => {
                                              if (!pullsActiveHere || !isPullable) return;
                                              const used = new Set<string>();
                                              const prefix = `${d.key}|${sn}|${idx}|`;
                                              Object.entries(pulls || {}).forEach(([k, v]) => {
                                                if (!String(k).startsWith(prefix)) return;
                                                const e = v as { before?: { name?: string }; after?: { name?: string } };
                                                const b = String(e?.before?.name || "").trim();
                                                const a = String(e?.after?.name || "").trim();
                                                if (b) used.add(b);
                                                if (a) used.add(a);
                                              });
                                              const prevDayKey = DAY_COLS[prevRef!.dayIdx].key;
                                              const nextDayKey = DAY_COLS[nextRef!.dayIdx].key;
                                              const prevShift = shiftNamesAll[prevRef!.shiftIdx];
                                              const nextShift = shiftNamesAll[nextRef!.shiftIdx];
                                              const beforeOptions = planningCellNames(
                                                assignmentsSafe?.[prevDayKey]?.[prevShift]?.[idx],
                                              ).filter((x) => !used.has(x));
                                              const afterOptions = planningCellNames(
                                                assignmentsSafe?.[nextDayKey]?.[nextShift]?.[idx],
                                              ).filter((x) => !used.has(x));
                                              const beforeName = String(beforeOptions[0] || "").trim();
                                              const afterName = String(afterOptions[0] || "").trim();
                                              if (!beforeName || !afterName) {
                                                toast.error("לא ניתן ליצור משיכות", { description: "אין עובדים זמינים לפני/אחרי" });
                                                return;
                                              }
                                              const hours = hoursFromConfig(st, sn) || hoursOf(sn);
                                              const parsed = parseHoursRange(hours);
                                              const split = parsed
                                                ? splitRangeForPulls(parsed.start, parsed.end)
                                                : splitRangeForPulls("00:00", "00:00");
                                              setPullsEditor({
                                                key: `${d.key}|${sn}|${idx}|${slotIdx}`,
                                                dayKey: d.key,
                                                shiftName: sn,
                                                stationIdx: idx,
                                                required,
                                                shiftStart: parsed?.start || "00:00",
                                                shiftEnd: parsed?.end || "23:59",
                                                roleName: null,
                                                beforeOptions,
                                                afterOptions,
                                                beforeName,
                                                afterName,
                                                beforeStart: split.before.start,
                                                beforeEnd: split.before.end,
                                                afterStart: split.after.start,
                                                afterEnd: split.after.end,
                                              });
                                            }}
                                          >
                                            {emptyHintStr ? (
                                              <>
                                                <span
                                                  className="max-w-full truncate px-0.5 text-center text-[6px] font-semibold leading-tight md:text-[9px]"
                                                  style={{ color: erc?.text }}
                                                >
                                                  {emptyHintStr}
                                                </span>
                                                <span className="text-[8px] leading-none text-zinc-400 md:text-xs dark:text-zinc-400">
                                                  —
                                                </span>
                                              </>
                                            ) : (
                                              <>
                                                <span className="text-[7px] font-medium opacity-0 md:text-[10px]">
                                                  —
                                                </span>
                                                <span className="text-[8px] leading-none text-zinc-400 md:text-xs dark:text-zinc-400">
                                                  —
                                                </span>
                                              </>
                                            )}
                                          </span>
                                        </div>
                                      );
                                    }
                                    const c = workerNameChipColor(nm, nameColorMap);
                                    const nmTrim = String(nm || "").trim();
                                    /** Comme la page planning (`rn` puis `pullRoleName`) : map משיחה avec validation rôle, puis attribution besoins, puis roleName sur l’entrée משיחה. */
                                    const pullRnMap = pullRoleMap.get(nmTrim) || null;
                                    const slotExpectedRole = String(
                                      roleForSlot[slotIdx] || roleHintsExtended[slotIdx] || roleHints[slotIdx] || "",
                                    ).trim();
                                    const slotRoleFromCell =
                                      slotExpectedRole && workerHasRole(workers, nmTrim, slotExpectedRole)
                                        ? slotExpectedRole
                                        : null;
                                    const rn =
                                      (pullRnMap && workerHasRole(workers, nmTrim, pullRnMap) ? pullRnMap : null) ||
                                      slotRoleFromCell ||
                                      (roleForName.get(nmTrim) ?? null);
                                    const pullRoleName = resolvePullRoleNameForWorker(
                                      pulls || null,
                                      d.key,
                                      sn,
                                      idx,
                                      nm,
                                    );
                                    const roleToShow = slotExpectedRole || rn || pullRoleName || null;
                                    const rcRole = roleToShow
                                      ? planningColorForRoleChip(roleToShow, roleColorMapPlanning)
                                      : null;
                                    const ring = pullRingClass(pulls || null, d.key, sn, idx, nm);
                                    const nmKey = normName(nm);
                                    const pullRel = pullHighlightByNormName.get(nmKey);
                                    const pullAdjacentRing =
                                      pullRel === "before" || pullRel === "after" ? " ring-2 ring-orange-400" : "";
                                    const pullOrangeOutline =
                                      ring.trim().length > 0 || pullAdjacentRing.trim().length > 0;
                                    const expKey = expandedKeyFor(
                                      d.key,
                                      sn,
                                      idx,
                                      slotIdx,
                                      nmKey || `slot-${slotIdx}`,
                                    );
                                    const pullTime = pullTimeRangeForName(
                                      pulls || null,
                                      d.key,
                                      sn,
                                      idx,
                                      nm,
                                    );
                                    const showDraftFixedPin = shouldShowDraftFixedPinForWorker(
                                      draftFixedAssignmentsSnapshot,
                                      isSavedMode,
                                      editingSaved,
                                      d.key,
                                      sn,
                                      idx,
                                      nm,
                                      assignedNamesNonEmpty,
                                    );
                                    const slotHoverKey = `${d.key}|${sn}|${idx}|${slotIdx}`;
                                    const isSlotHovered = hoverSlotKey === slotHoverKey;
                                    const fillHint = (roleHintsExtended[slotIdx] ?? null) as string | null;
                                    const fillOk = slotCanHighlight(fillHint);
                                    const slotPullKey = `${d.key}|${sn}|${idx}|${slotIdx}`;
                                    const pullsMap = (pulls as Record<string, PlanningV2PullEntry> | null | undefined) || {};
                                    let resolvedPullKey = "";
                                    let existingPull = pullsMap[slotPullKey];
                                    if (existingPull) {
                                      resolvedPullKey = slotPullKey;
                                    } else {
                                      const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                      for (const [k, entry] of Object.entries(pullsMap)) {
                                        if (!String(k).startsWith(cellPrefix)) continue;
                                        const b = String(entry?.before?.name || "").trim();
                                        const a = String(entry?.after?.name || "").trim();
                                        if (b === nm || a === nm) {
                                          resolvedPullKey = String(k);
                                          existingPull = entry;
                                          break;
                                        }
                                      }
                                    }
                                    const hasPullOnSlot =
                                      !!String(existingPull?.before?.name || "").trim() ||
                                      !!String(existingPull?.after?.name || "").trim();
                                    const summaryPickActive =
                                      !!summaryHighlightNorm && !!nmKey && nmKey === summaryHighlightNorm;
                                    return (
                                      <div
                                        key={`${d.key}-${sn}-${idx}-slot-${slotIdx}-${nmKey}`}
                                        className={
                                          "group/slot relative flex w-full justify-center py-0.5 " +
                                          (dndHere && dragNm && isSlotHovered
                                            ? "z-50 scale-[1.15] origin-center will-change-transform transition-transform duration-150 ease-out"
                                            : "") +
                                          (summaryPickActive
                                            ? " z-[25] rounded-full transition-shadow duration-200"
                                            : "")
                                        }
                                        onDragEnter={
                                          dndHere
                                            ? (e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                setHoverSlotKey(slotHoverKey);
                                              }
                                            : undefined
                                        }
                                        onDragLeave={
                                          dndHere
                                            ? (e) => {
                                                const rect = e.currentTarget.getBoundingClientRect();
                                                const x = e.clientX;
                                                const y = e.clientY;
                                                if (
                                                  x < rect.left ||
                                                  x > rect.right ||
                                                  y < rect.top ||
                                                  y > rect.bottom
                                                ) {
                                                  setHoverSlotKey((k) => (k === slotHoverKey ? null : k));
                                                }
                                              }
                                            : undefined
                                        }
                                        onDragOver={
                                          dndHere
                                            ? (e) => {
                                                onSlotDragOver(e);
                                                if (dragNm) setHoverSlotKey(slotHoverKey);
                                              }
                                            : undefined
                                        }
                                        onDrop={dndHere ? (e) => onSlotDrop(e, d.key, sn, idx, slotIdx) : undefined}
                                        data-slot={dndHere ? "1" : undefined}
                                        data-dkey={d.key}
                                        data-sname={sn}
                                        data-stidx={idx}
                                        data-slotidx={slotIdx}
                                        data-rolehint={fillHint || undefined}
                                      >
                                        <span
                                          tabIndex={0}
                                          data-dkey={d.key}
                                          data-sname={sn}
                                          data-stidx={idx}
                                          data-slotidx={slotIdx}
                                          draggable={dndHere}
                                          onDragStart={(e) => dndHere && onWorkerDragStart(e, nm)}
                                          onDragEnd={onChipDragEnd}
                                          className={
                                            "relative inline-flex min-h-6 w-auto max-w-[6rem] min-w-0 select-none flex-col items-center overflow-hidden rounded-full border px-1 py-0.5 shadow-sm transition-[max-width,transform] duration-200 ease-out md:min-h-9 md:w-full md:max-w-[6rem] md:px-3 md:py-1 md:group-hover/slot:max-w-[18rem] md:group-hover/slot:z-30 md:focus:max-w-[18rem] md:focus:z-30 focus:outline-none " +
                                            (dndHere ? "cursor-grab active:cursor-grabbing " : "cursor-default ") +
                                            (expandedSlotKey === expKey
                                              ? " z-30 w-[18rem] max-w-[18rem]"
                                              : "") +
                                            ring +
                                            pullAdjacentRing +
                                            (hasPullOnSlot ? " cursor-pointer" : "") +
                                            (((!dragNm && isSlotHovered) || summaryPickActive)
                                              ? " z-[40] scale-110 ring-2 ring-[#00A8E0] " +
                                                (summaryPickActive
                                                  ? "ring-offset-1 ring-offset-white dark:ring-offset-zinc-950 "
                                                  : "")
                                              : "") +
                                            (dragNm && fillOk && !isSlotHovered ? " ring-2 ring-green-500" : "") +
                                            (dragNm && hasLinkedConflict && !isSlotHovered ? " ring-2 ring-red-500" : "") +
                                            (dragNm && fillOk && isSlotHovered
                                              ? " [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22),0_0_0_2px_rgb(34_197_94)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38),0_0_0_2px_rgb(34_197_94)]"
                                              : "") +
                                            (dragNm && hasLinkedConflict && isSlotHovered
                                              ? " ring-2 ring-red-500 cursor-not-allowed [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38)]"
                                              : "") +
                                            (dragNm && !fillOk && isSlotHovered
                                              ? "ring-2 ring-[#00A8E0] cursor-not-allowed [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38)]"
                                              : "")
                                          }
                                          style={{
                                            backgroundColor: c.bg,
                                            borderColor:
                                              pullOrangeOutline
                                                ? c.border
                                                : rcRole
                                                  ? rcRole.border
                                                  : c.border,
                                            color: c.text,
                                          }}
                                          title={nm}
                                          onPointerDown={() => setExpandedSlotKey(expKey)}
                                          onPointerEnter={(e) => {
                                            if (e.pointerType === "mouse") setExpandedSlotKey(expKey);
                                          }}
                                          onPointerLeave={(e) => {
                                            if (e.pointerType === "mouse") {
                                              setExpandedSlotKey((k) => (k === expKey ? null : k));
                                            }
                                          }}
                                          onFocus={() => setExpandedSlotKey(expKey)}
                                          onBlur={() =>
                                            setExpandedSlotKey((k) => (k === expKey ? null : k))
                                          }
                                          onClick={() => {
                                            if (!hasPullOnSlot) return;
                                            const used = new Set<string>();
                                            const prefix = `${d.key}|${sn}|${idx}|`;
                                            Object.entries(pulls || {}).forEach(([k, v]) => {
                                              if (!String(k).startsWith(prefix) || String(k) === resolvedPullKey) return;
                                              const e = v as { before?: { name?: string }; after?: { name?: string } };
                                              const b = String(e?.before?.name || "").trim();
                                              const a = String(e?.after?.name || "").trim();
                                              if (b) used.add(b);
                                              if (a) used.add(a);
                                            });
                                            const beforeName = String(existingPull?.before?.name || "").trim();
                                            const afterName = String(existingPull?.after?.name || "").trim();
                                            const prevDayKey = prevRef ? DAY_COLS[prevRef.dayIdx].key : "";
                                            const nextDayKey = nextRef ? DAY_COLS[nextRef.dayIdx].key : "";
                                            const prevShift = prevRef ? shiftNamesAll[prevRef.shiftIdx] : "";
                                            const nextShift = nextRef ? shiftNamesAll[nextRef.shiftIdx] : "";
                                            let beforeOptions = prevRef
                                              ? planningCellNames(assignmentsSafe?.[prevDayKey]?.[prevShift]?.[idx]).filter((x) => !used.has(x))
                                              : [];
                                            let afterOptions = nextRef
                                              ? planningCellNames(assignmentsSafe?.[nextDayKey]?.[nextShift]?.[idx]).filter((x) => !used.has(x))
                                              : [];
                                            if (beforeName && !beforeOptions.includes(beforeName)) beforeOptions = [beforeName, ...beforeOptions];
                                            if (afterName && !afterOptions.includes(afterName)) afterOptions = [afterName, ...afterOptions];
                                            const hours = hoursFromConfig(st, sn) || hoursOf(sn);
                                            const parsed = parseHoursRange(hours);
                                            setPullsEditor({
                                              key: resolvedPullKey || slotPullKey,
                                              dayKey: d.key,
                                              shiftName: sn,
                                              stationIdx: idx,
                                              required,
                                              shiftStart: parsed?.start || "00:00",
                                              shiftEnd: parsed?.end || "23:59",
                                              roleName: null,
                                              beforeOptions,
                                              afterOptions,
                                              beforeName: beforeName || String(beforeOptions[0] || "").trim(),
                                              afterName: afterName || String(afterOptions[0] || "").trim(),
                                              beforeStart: String(existingPull?.before?.start || "00:00"),
                                              beforeEnd: String(existingPull?.before?.end || "00:00"),
                                              afterStart: String(existingPull?.after?.start || "00:00"),
                                              afterEnd: String(existingPull?.after?.end || "00:00"),
                                            });
                                          }}
                                        >
                                          <span className="flex w-full min-w-0 flex-1 flex-col items-center overflow-hidden text-center leading-tight">
                                            {roleToShow && rcRole ? (
                                              <span
                                                className="mb-0.5 max-w-full truncate text-[5px] font-semibold leading-tight opacity-95 md:text-[8px]"
                                                dir="rtl"
                                                style={{ color: rcRole.text }}
                                              >
                                                {roleToShow}
                                              </span>
                                            ) : null}
                                            <span
                                              className="flex w-full min-w-0 max-w-full items-center justify-center gap-0.5 leading-tight"
                                              dir={isRtlName(nm) ? "rtl" : "ltr"}
                                            >
                                              {showDraftFixedPin ? (
                                                <svg
                                                  viewBox="0 0 24 24"
                                                  className="pointer-events-none h-2.5 w-2.5 shrink-0 text-black md:h-3 md:w-3"
                                                  fill="currentColor"
                                                  aria-hidden
                                                >
                                                  <title>שיבוץ קבוע</title>
                                                  <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
                                                </svg>
                                              ) : null}
                                              <span className="md:hidden">
                                                {expandedSlotKey === expKey ? (
                                                  <span className="whitespace-nowrap text-[7px]">{nm}</span>
                                                ) : (
                                                  <span className="text-[7px]">{truncateMobile6(nm)}</span>
                                                )}
                                              </span>
                                              <span className="hidden max-w-full truncate text-[8px] md:block md:text-sm">
                                                {nm}
                                              </span>
                                            </span>
                                            {pullTime ? (
                                              <span
                                                dir="ltr"
                                                className="mt-0.5 max-w-full truncate text-[6px] leading-tight text-zinc-800/85 dark:text-zinc-200/85 md:text-[10px]"
                                              >
                                                {pullTime}
                                              </span>
                                            ) : null}
                                          </span>
                                        </span>
                                      </div>
                                    );
                                  })}
                                  <div className="mt-0.5 flex w-full min-w-0 flex-col items-center gap-0.5 leading-tight max-md:max-w-[5.5rem] md:max-w-none md:mt-1 md:gap-1">
                                    <span
                                      className={
                                        "flex w-full items-center justify-center gap-0.5 whitespace-nowrap text-[7px] md:text-[10px] " +
                                        (assignedCount < required
                                          ? "text-red-600 dark:text-red-400"
                                          : required > 0 && assignedCount >= required
                                            ? "text-green-600 dark:text-green-400"
                                            : "")
                                      }
                                    >
                                      <span>שיבוצים:</span>
                                      <span className="font-medium tabular-nums">{assignedCount}</span>
                                    </span>
                                    <span className="flex w-full items-center justify-center gap-0.5 whitespace-nowrap text-[7px] text-zinc-500 md:text-[10px]">
                                      <span>נדרש:</span>
                                      <span className="font-medium tabular-nums text-zinc-600 dark:text-zinc-400">
                                        {required}
                                      </span>
                                    </span>
                                  </div>
                                </div>
                                  ) : (
                                    <span className="text-[9px] md:text-xs">לא פעיל</span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-[9px] md:text-xs">לא פעיל</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
      {manualEditable && workers.length > 0 ? (
        <PlanningV2ManualWorkerPalette
          workers={workers}
          nameColorMap={nameColorMap}
          onDragPreviewStart={(name) => onDraggingWorkerChange?.(name)}
          onDragPreviewEnd={() => onDraggingWorkerChange?.(null)}
        />
      ) : null}
      {pullsEditor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setPullsEditor(null)}>
          <div
            className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-semibold">משיכות</div>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => setPullsEditor(null)}
                aria-label="סגור"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
              </button>
            </div>
            <div className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
              {(() => {
                const dayLabels: Record<string, string> = {
                  sun: "א'",
                  mon: "ב'",
                  tue: "ג'",
                  wed: "ד'",
                  thu: "ה'",
                  fri: "ו'",
                  sat: "ש'",
                };
                const dayLabel = dayLabels[pullsEditor.dayKey] || pullsEditor.dayKey;
                return `${dayLabel} • ${pullsEditor.shiftName} • עמדה ${pullsEditor.stationIdx + 1}`;
              })()}
            </div>
            {pullsEditor.roleName ? (
              <div className="mb-3 text-xs text-zinc-500">
                תפקיד: <span className="font-medium text-zinc-700 dark:text-zinc-200">{pullsEditor.roleName}</span>
              </div>
            ) : null}
            <div className="space-y-3">
              <div className="rounded-md border p-3 dark:border-zinc-700">
                <div className="mb-2 text-sm font-medium">{pullsEditor.beforeName}</div>
                {(pullsEditor.beforeOptions || []).length > 1 && (
                  <div className="mb-3">
                    <div className="mb-1 text-xs text-zinc-500">בחר עובד (לפני)</div>
                    <select
                      value={pullsEditor.beforeName}
                      onChange={(e) => setPullsEditor((p) => (p ? { ...p, beforeName: e.target.value } : p))}
                      size={Math.min(4, Math.max(2, (pullsEditor.beforeOptions || []).length))}
                      className="w-full overflow-y-auto rounded-md border bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      {(pullsEditor.beforeOptions || []).map((nm) => (
                        <option key={nm} value={nm}>
                          {nm}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-zinc-500">
                    התחלה
                    <TimePicker
                      value={pullsEditor.beforeStart}
                      onChange={(v) => setPullsEditor((p) => (p ? { ...p, beforeStart: v } : p))}
                      className="mt-1 h-9 w-full rounded-md border px-3 text-sm dark:border-zinc-700 bg-white dark:bg-zinc-900"
                      dir="ltr"
                    />
                  </label>
                  <label className="text-xs text-zinc-500">
                    סיום
                    <TimePicker
                      value={pullsEditor.beforeEnd}
                      onChange={(v) => setPullsEditor((p) => (p ? { ...p, beforeEnd: v } : p))}
                      className="mt-1 h-9 w-full rounded-md border px-3 text-sm dark:border-zinc-700 bg-white dark:bg-zinc-900"
                      dir="ltr"
                    />
                  </label>
                </div>
              </div>
              <div className="rounded-md border p-3 dark:border-zinc-700">
                <div className="mb-2 text-sm font-medium">{pullsEditor.afterName}</div>
                {(pullsEditor.afterOptions || []).length > 1 && (
                  <div className="mb-3">
                    <div className="mb-1 text-xs text-zinc-500">בחר עובד (אחרי)</div>
                    <select
                      value={pullsEditor.afterName}
                      onChange={(e) => setPullsEditor((p) => (p ? { ...p, afterName: e.target.value } : p))}
                      size={Math.min(4, Math.max(2, (pullsEditor.afterOptions || []).length))}
                      className="w-full overflow-y-auto rounded-md border bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      {(pullsEditor.afterOptions || []).map((nm) => (
                        <option key={nm} value={nm}>
                          {nm}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-zinc-500">
                    התחלה
                    <TimePicker
                      value={pullsEditor.afterStart}
                      onChange={(v) => setPullsEditor((p) => (p ? { ...p, afterStart: v } : p))}
                      className="mt-1 h-9 w-full rounded-md border px-3 text-sm dark:border-zinc-700 bg-white dark:bg-zinc-900"
                      dir="ltr"
                    />
                  </label>
                  <label className="text-xs text-zinc-500">
                    סיום
                    <TimePicker
                      value={pullsEditor.afterEnd}
                      onChange={(v) => setPullsEditor((p) => (p ? { ...p, afterEnd: v } : p))}
                      className="mt-1 h-9 w-full rounded-md border px-3 text-sm dark:border-zinc-700 bg-white dark:bg-zinc-900"
                      dir="ltr"
                    />
                  </label>
                </div>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-60"
                onClick={async () => {
                  const res = await onRemovePull?.(pullsEditor.key);
                  if (res !== false) setPullsEditor(null);
                }}
              >
                מחק
              </button>
              <button
                type="button"
                className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => setPullsEditor(null)}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6]"
                onClick={async () => {
                  const beforeName = String(pullsEditor.beforeName || "").trim();
                  const afterName = String(pullsEditor.afterName || "").trim();
                  if (!beforeName || !afterName) {
                    toast.error("לא ניתן ליצור משיכות", { description: "יש לבחור שני עובדים" });
                    return;
                  }
                  const toMinutesLocal = (t: string): number | null => {
                    const m = String(t || "").trim().match(/^(\d{1,2}):(\d{2})$/);
                    if (!m) return null;
                    const hh = Number(m[1]);
                    const mm = Number(m[2]);
                    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
                    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
                    return hh * 60 + mm;
                  };
                  const s0 = toMinutesLocal(pullsEditor.shiftStart);
                  const e0 = toMinutesLocal(pullsEditor.shiftEnd);
                  const bS0 = toMinutesLocal(pullsEditor.beforeStart);
                  const bE0 = toMinutesLocal(pullsEditor.beforeEnd);
                  const aS0 = toMinutesLocal(pullsEditor.afterStart);
                  const aE0 = toMinutesLocal(pullsEditor.afterEnd);
                  if ([s0, e0, bS0, bE0, aS0, aE0].some((x) => x == null)) {
                    toast.error("שעות לא תקינות", { description: "פורמט השעה חייב להיות HH:MM" });
                    return;
                  }
                  const s = s0 as number;
                  let e = e0 as number;
                  const crossesMidnight = e <= s;
                  if (crossesMidnight) e += 24 * 60;
                  const abs = (m: number) => (crossesMidnight && m < s ? m + 24 * 60 : m);
                  const within = (m: number) => {
                    const am = abs(m);
                    return am >= s && am <= e;
                  };
                  const okRange = (startM: number, endM: number) =>
                    within(startM) && within(endM) && abs(startM) <= abs(endM);
                  if (!okRange(bS0 as number, bE0 as number) || !okRange(aS0 as number, aE0 as number)) {
                    toast.error("שעות לא תקינות", { description: "השעות חייבות להיות בתוך טווח המשמרת" });
                    return;
                  }
                  const maxEach = 4 * 60;
                  const durBefore = abs(bE0 as number) - abs(bS0 as number);
                  const durAfter = abs(aE0 as number) - abs(aS0 as number);
                  if (durBefore > maxEach || durAfter > maxEach) {
                    toast.error("שעות לא תקינות", { description: "מקסימום 4 שעות לכל עובד במשיכה" });
                    return;
                  }
                  if (beforeName === afterName) {
                    toast.error("שעות לא תקינות", { description: "בחר שני עובדים שונים" });
                    return;
                  }
                  if (!pullsEditor.required || pullsEditor.required <= 0) {
                    toast.error("לא ניתן ליצור משיכות", { description: "המשמרת לא פעילה / לא נדרש" });
                    return;
                  }
                  const res = await onUpsertPull?.(pullsEditor.key, {
                    before: { name: beforeName, start: pullsEditor.beforeStart, end: pullsEditor.beforeEnd },
                    after: { name: afterName, start: pullsEditor.afterStart, end: pullsEditor.afterEnd },
                  });
                  if (res !== false) setPullsEditor(null);
                }}
              >
                שמירה
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

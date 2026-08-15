"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { toast } from "sonner";
import type { PlanningV2PullEntry, PlanningWorker, SiteSummary } from "../types";
import { addDays, formatHebDate } from "../lib/week";
import { assignmentsNonEmpty } from "../lib/assignments-empty";
import type { ManualDragSource } from "../lib/planning-v2-manual-drop";
import {
  canHighlightManualDropTarget,
  getLinkedSiteConflictCellLabel,
  getManualShiftConflictReason,
  pullEditOnlyViaPopupMessage,
  pullEntriesInCell,
  workerHasRole,
  workerParticipatesInPull,
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
  isShiftEnabledForStation,
  planningCellNames,
  normPullWorkerName,
  pullSlotsAllowDistinctWorkers,
  shiftNamesFromSite,
  stationHasIsolatedHole,
} from "../lib/station-grid-helpers";
import {
  buildDistinctWorkerColorMap,
  buildPlanningRoleColorMapFromSite,
  planningColorForRoleChip,
  workerNameChipColor,
} from "../lib/worker-name-chip-color";
import {
  buildPullHighlightKindByNormName,
  pullHighlightRingClass,
} from "../lib/planning-v2-pull-slot-display";
import {
  blockSavedViewPullBubble,
  countPullEntriesInCell,
  expandedKeyFor,
  guardDisplayTimeForSlot,
  isRealPullEntry,
  isRtlName,
  mergeCellRawWithPulls,
  normName,
  parseHoursRange,
  pullTimeRangeForName,
  shouldShowDraftFixedPinForWorker,
  splitRangeForPulls,
  truncateMobile6,
} from "../lib/planning-v2-station-week-grid-utils";
import { usePlanningV2StationGridZoom } from "../hooks/use-planning-v2-station-grid-zoom";
import { usePlanningV2StationGridManualDrag } from "../hooks/use-planning-v2-station-grid-manual-drag";
import {
  PlanningV2StationPullsEditorModal,
  type PlanningV2StationPullsEditorState,
} from "./planning-v2-station-pulls-editor-modal";
import {
  PlanningV2StationShiftHoursEditorModal,
  type PlanningV2StationShiftHoursEditorState,
} from "./planning-v2-station-shift-hours-editor-modal";
import {
  PlanningV2StationManualSlotEditorModal,
  type PlanningV2ManualSlotSavePayload,
  type PlanningV2StationManualSlotEditorState,
} from "./planning-v2-station-manual-slot-editor-modal";
import {
  isManualExtraSlot,
  isManualSlotPullEntry,
  listRolesForStationShift,
  manualSlotKey,
  manualSlotRoleName,
  manualSlotSpanInCell,
} from "../lib/planning-v2-manual-slot";

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
  /** Mode שינוי שעות — clic sur une cellule occupée pour fixer arrivée / fin d’affichage (rouge). */
  shiftHoursModeStationIdx?: number | null;
  onToggleShiftHoursModeStation?: (stationIdx: number) => void;
  onUpsertGuardDisplay?: (key: string, start: string, end: string) => boolean | void | Promise<boolean | void>;
  onRemoveGuardDisplay?: (key: string) => boolean | void | Promise<boolean | void>;
  /** Mode שיבוץ — clic sur une garde pour ajouter / éditer un poste parallèle. */
  manualAssignmentModeStationIdx?: number | null;
  onToggleManualAssignmentModeStation?: (stationIdx: number) => void;
  onUpsertManualAssignmentSlot?: (
    payload: PlanningV2ManualSlotSavePayload,
  ) => boolean | void | Promise<boolean | void>;
  onRemoveManualAssignmentSlot?: (payload: {
    dayKey: string;
    shiftName: string;
    stationIndex: number;
    slotIndex: number;
  }) => boolean | void | Promise<boolean | void>;
  onResetStation?: (stationIdx: number) => void;
  draggingWorkerName?: string | null;
  selectedWorkerSource?: ManualDragSource | null;
  onDraggingWorkerChange?: (workerName: string | null) => void;
  onWorkerSelectToggle?: (workerName: string, source?: ManualDragSource | null) => void;
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
  shiftHoursModeStationIdx = null,
  manualAssignmentModeStationIdx = null,
  draggingWorkerName = null,
  selectedWorkerSource = null,
  onDraggingWorkerChange,
  onWorkerSelectToggle,
  availabilityByWorkerName = {},
  availabilityOverlays = {},
  onManualSlotDragOutside,
  onUpsertPull,
  onRemovePull,
  onUpsertGuardDisplay,
  onRemoveGuardDisplay,
  onUpsertManualAssignmentSlot,
  onRemoveManualAssignmentSlot,
  onTogglePullsModeStation,
  onToggleShiftHoursModeStation,
  onToggleManualAssignmentModeStation,
  onResetStation,
  onManualSlotDrop,
  summaryHighlightWorkerName = null,
}: PlanningV2StationWeekGridProps) {
  const [expandedSlotKey, setExpandedSlotKey] = useState<string | null>(null);
  const [hoverSlotKey, setHoverSlotKey] = useState<string | null>(null);
  const [pullsEditor, setPullsEditor] = useState<PlanningV2StationPullsEditorState | null>(null);
  const [shiftHoursEditor, setShiftHoursEditor] = useState<PlanningV2StationShiftHoursEditorState | null>(null);
  const [shiftHoursOorConfirm, setShiftHoursOorConfirm] = useState(false);
  const [manualSlotEditor, setManualSlotEditor] = useState<PlanningV2StationManualSlotEditorState | null>(null);
  const [manualSlotOorConfirm, setManualSlotOorConfirm] = useState(false);
  const {
    MIN_STATION_GRID_ZOOM,
    MAX_STATION_GRID_ZOOM,
    STATION_GRID_ZOOM_STEP,
    stationZoomBaseSizeByIdx,
    stationGridScrollRefByIdx,
    getStationZoom,
    adjustStationZoom,
  } = usePlanningV2StationGridZoom();
  const {
    dragSourceRef,
    onWorkerDragStart,
    onSlotDragOver,
    onSlotDrop,
    trySlotClickAssign,
    onChipDragEnd,
  } = usePlanningV2StationGridManualDrag({
    manualEditable,
    draggingWorkerName,
    selectedWorkerSource,
    assignments,
    pulls,
    onManualSlotDrop,
    onManualSlotDragOutside,
    onDraggingWorkerChange,
    setHoverSlotKey,
  });

  useEffect(() => {
    if (!shiftHoursEditor) setShiftHoursOorConfirm(false);
  }, [shiftHoursEditor]);

  useEffect(() => {
    if (!manualSlotEditor) setManualSlotOorConfirm(false);
  }, [manualSlotEditor]);

  useEffect(() => {
    if (manualAssignmentModeStationIdx == null) setManualSlotEditor(null);
  }, [manualAssignmentModeStationIdx]);

  // Quitter le mode משיכה → fermer la modale (mais autoriser l'ouverture hors mode, en manuel).
  const prevPullsModeStationIdxRef = useRef(pullsModeStationIdx);
  useEffect(() => {
    const prev = prevPullsModeStationIdxRef.current;
    prevPullsModeStationIdxRef.current = pullsModeStationIdx;
    if (prev != null && pullsModeStationIdx == null) setPullsEditor(null);
  }, [pullsModeStationIdx]);
  useEffect(() => {
    if (isSavedMode && !editingSaved) setPullsEditor(null);
  }, [isSavedMode, editingSaved]);
  useEffect(() => {
    if (shiftHoursModeStationIdx == null) setShiftHoursEditor(null);
  }, [shiftHoursModeStationIdx]);
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
        {stations.map((st, idx: number) => {
          const stationZoom = getStationZoom(idx);
          const isZoomedIn = stationZoom > MIN_STATION_GRID_ZOOM;
          const zoomBase = stationZoomBaseSizeByIdx[idx];
          return (
          <div
            key={idx}
            className={
              "overflow-hidden rounded-xl border border-zinc-200 p-3 pb-3 dark:border-zinc-800 " +
              (pullsModeStationIdx === idx
                ? "ring-1 ring-orange-400 ring-offset-1 ring-offset-white dark:ring-offset-zinc-950"
                : shiftHoursModeStationIdx === idx
                  ? "ring-1 ring-yellow-500 ring-offset-1 ring-offset-white dark:ring-offset-zinc-950"
                  : manualAssignmentModeStationIdx === idx
                    ? "ring-1 ring-teal-500 ring-offset-1 ring-offset-white dark:ring-offset-zinc-950"
                    : "")
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
                        onToggleManualAssignmentModeStation?.(idx);
                      }}
                      disabled={isSavedMode && !editingSaved}
                      className={
                        "inline-flex items-center rounded-md border px-2 py-1 text-xs " +
                        (isSavedMode && !editingSaved
                          ? "cursor-not-allowed border-zinc-200 text-zinc-400 opacity-60 dark:border-zinc-700 dark:text-zinc-600"
                          : manualAssignmentModeStationIdx === idx
                            ? "border-teal-600 bg-teal-600 text-white hover:bg-teal-700 dark:border-teal-600 dark:bg-teal-600 dark:hover:bg-teal-700"
                            : "border-teal-400 text-teal-600 hover:bg-teal-50 dark:border-teal-700 dark:text-teal-400 dark:hover:bg-teal-900/20")
                      }
                    >
                      שיבוץ
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (isSavedMode && !editingSaved) return;
                        if (shiftHoursModeStationIdx === idx) {
                          onToggleShiftHoursModeStation?.(idx);
                          return;
                        }
                        if (!assignmentsNonEmpty(assignmentsSafe)) {
                          toast.error("אין תכנון פעיל", {
                            description: "צור תכנון כדי לשנות שעות בתצוגה",
                          });
                          return;
                        }
                        onToggleShiftHoursModeStation?.(idx);
                      }}
                      disabled={isSavedMode && !editingSaved}
                      className={
                        "inline-flex items-center rounded-md border px-2 py-1 text-xs " +
                        (isSavedMode && !editingSaved
                          ? "cursor-not-allowed border-zinc-200 text-zinc-400 opacity-60 dark:border-zinc-700 dark:text-zinc-600"
                          : shiftHoursModeStationIdx === idx
                            ? "border-yellow-500 bg-yellow-500 text-white hover:bg-yellow-600 dark:border-yellow-600 dark:bg-yellow-600 dark:hover:bg-yellow-700"
                            : "border-yellow-400 text-yellow-600 hover:bg-yellow-50 dark:border-yellow-700 dark:text-yellow-400 dark:hover:bg-yellow-900/20")
                      }
                    >
                      שינוי שעות
                    </button>
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
            {(() => {
              return (
            <div className="relative w-full min-w-0">
              {/*
                Au repos : hauteur = contenu (boutons juste sous la grille).
                En zoom : hauteur figée à la taille initiale → paper stable, scroll interne.
              */}
              <div
                ref={(el) => {
                  stationGridScrollRefByIdx.current[idx] = el;
                }}
                className={
                  "w-full min-w-0 overflow-x-auto overflow-y-auto pb-1 " +
                  (isZoomedIn ? "" : "max-h-[min(32rem,70vh)]")
                }
                style={
                  isZoomedIn && zoomBase?.height
                    ? { height: `${zoomBase.height}px`, maxHeight: `${zoomBase.height}px` }
                    : undefined
                }
              >
                <div
                  className={isZoomedIn ? "box-border inline-block" : "w-full"}
                  style={
                    isZoomedIn
                      ? ({
                          zoom: stationZoom,
                          WebkitZoom: stationZoom,
                          width: zoomBase?.width ? `${zoomBase.width}px` : "100%",
                          minWidth: zoomBase?.width ? `${zoomBase.width}px` : "100%",
                        } as CSSProperties)
                      : undefined
                  }
                >
              <table className="w-full table-fixed border-collapse text-[8px] md:text-sm">
                <thead>
                  <tr className="border-b dark:border-zinc-800">
                    <th className="sticky top-0 z-30 w-10 bg-white px-0 py-0.5 text-right align-bottom text-[8px] shadow-[0_1px_0_0_rgb(228_228_231)] md:w-28 md:px-2 md:py-2 md:text-sm dark:bg-zinc-950 dark:shadow-[0_1px_0_0_rgb(39_39_42)]">
                      משמרת
                    </th>
                    {DAY_COLS.map((d, i) => {
                      const date = addDays(weekStart, i);
                      return (
                        <th
                          key={d.key}
                          className="sticky top-0 z-30 bg-white px-0.5 py-0.5 text-center align-bottom shadow-[0_1px_0_0_rgb(228_228_231)] md:px-2 md:py-2 dark:bg-zinc-950 dark:shadow-[0_1px_0_0_rgb(39_39_42)]"
                        >
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
                      const shiftRowEnabled = isShiftEnabledForStation(st, sn);
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
                          const shiftHoursActiveHere = shiftHoursModeStationIdx === idx;
                          const manualSlotActiveHere = manualAssignmentModeStationIdx === idx;
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
                          const cellLockedByPull = pullsInCell > 0;
                          // Drag autorisé même en mode משיכה / שינוי שעות (le drag désactive le mode),
                          // sauf vers une cellule déjà en משיכה (édition uniquement via popup).
                          const dndHere =
                            manualEditable &&
                            typeof onManualSlotDrop === "function" &&
                            !cellLockedByPull;
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
                            manualEditable
                              ? cellRaw
                              : alignNamesToRoleSlots(workers, cellRaw, roleHints, baseRoleDisplay.roleForSlot);
                          const alignedRoleDisplay =
                            manualEditable || displayCellRaw === cellRaw
                              ? null
                              : computeRoleDisplayForCell(workers, st, sn, d.key, displayCellRaw, pullRoleMap);
                          const roleHintsExtended = alignedRoleDisplay?.roleHintsExtended ?? baseRoleDisplay.roleHintsExtended;
                          const roleForSlot = alignedRoleDisplay?.roleForSlot ?? baseRoleDisplay.roleForSlot;
                          const roleForName = alignedRoleDisplay?.roleForName ?? baseRoleDisplay.roleForName;
                          const openManualSlotEditor = (slotIdx: number | null) => {
                            const hoursStr = hoursFromConfig(st, sn) || hoursOf(sn);
                            const parsedHours = parseHoursRange(hoursStr);
                            const shiftStart = parsedHours?.start || "00:00";
                            const shiftEnd = parsedHours?.end || "23:59";
                            const roleOptions = listRolesForStationShift(
                              st as Record<string, unknown>,
                              sn,
                              d.key,
                            );
                            const workerOptions = workers
                              .map((w) => String(w?.name || "").trim())
                              .filter(Boolean);
                            const editing = slotIdx != null;
                            const createSlotIdx = Math.max(
                              required + pullsInCell,
                              cellRaw.length,
                              manualSlotSpanInCell(pulls || null, d.key, sn, idx),
                            );
                            const entry = editing
                              ? ((pulls || {}) as Record<string, PlanningV2PullEntry>)[
                                  manualSlotKey(d.key, sn, idx, slotIdx)
                                ]
                              : undefined;
                            const existingRole = editing ? manualSlotRoleName(entry) : null;
                            setManualSlotEditor({
                              mode: editing ? "edit" : "create",
                              key: manualSlotKey(d.key, sn, idx, editing ? slotIdx : createSlotIdx),
                              dayKey: d.key,
                              shiftName: sn,
                              stationIdx: idx,
                              slotIdx: editing ? slotIdx : createSlotIdx,
                              workerName: editing ? String(cellRaw[slotIdx] || "").trim() : "",
                              roleName: existingRole || "",
                              start: String(entry?.guardDisplay?.start || shiftStart),
                              end: String(entry?.guardDisplay?.end || shiftEnd),
                              shiftStart,
                              shiftEnd,
                              roleOptions,
                              workerOptions,
                            });
                          };
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
                              return pullSlotsAllowDistinctWorkers(
                                assignmentsSafe?.[prevDayKey]?.[prevShift]?.[idx],
                                assignmentsSafe?.[nextDayKey]?.[nextShift]?.[idx],
                              );
                            })();
                          const pullHighlightByNormName = buildPullHighlightKindByNormName(
                            pulls || null,
                            shiftNamesAll,
                            dayIdx,
                            d.key,
                            sn,
                            idx,
                          );
                          const manualDragSource = dragSourceRef.current ?? selectedWorkerSource ?? null;
                          const dropConflictReason =
                            dragNm && dndHere
                              ? getManualShiftConflictReason(
                                  highlightMap,
                                  siteId || "",
                                  weekStart,
                                  workers,
                                  dragNm,
                                  d.key,
                                  sn,
                                  manualDragSource,
                                )
                              : null;
                          const hasDropConflict = !!dropConflictReason;
                          const slotCanHighlight = (roleHint: string | null) =>
                            !!dragNm &&
                            dndHere &&
                            !availabilityOverlayByNormName[normName(dragNm)]?.[d.key]?.has(String(sn || "").trim()) &&
                            !dropConflictReason &&
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
                              stationsCount: stations.length,
                              roleHint,
                              dragSource: manualDragSource,
                            });
                          const linkedConflictCellLabel =
                            dragNm && dndHere
                              ? getLinkedSiteConflictCellLabel(
                                  siteId || "",
                                  weekStart,
                                  workers,
                                  dragNm,
                                  d.key,
                                  sn,
                                )
                              : null;

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
                                <div
                                  className={
                                    "flex flex-col items-center rounded-md " +
                                    (manualSlotActiveHere && showCell ? "cursor-pointer ring-1 ring-teal-400" : "")
                                  }
                                  onClick={() => {
                                    if (!manualSlotActiveHere || !showCell) return;
                                    openManualSlotEditor(null);
                                  }}
                                >
                                  {showCell ? (
                                <div className="mb-1 flex min-w-full flex-col items-center gap-1">
                                  {Array.from({ length: slotCount }).map((_, slotIdx) => {
                                    const nm = String(displayCellRaw[slotIdx] || "").trim();
                                    const isManualSlotHere = isManualExtraSlot(
                                      pulls || null,
                                      d.key,
                                      sn,
                                      idx,
                                      slotIdx,
                                      required + pullsInCell,
                                    );
                                    const manualSlotClick = (e: { stopPropagation: () => void }) => {
                                      if (!manualSlotActiveHere) return false;
                                      e.stopPropagation();
                                      openManualSlotEditor(isManualSlotHere ? slotIdx : null);
                                      return true;
                                    };
                                    if (!nm) {
                                      const slotHoverKey = `${d.key}|${sn}|${idx}|${slotIdx}`;
                                      const isSlotHovered = hoverSlotKey === slotHoverKey;
                                      const emptyHintStr = String(roleHintsExtended[slotIdx] || "").trim();
                                      const emptyOk = slotCanHighlight(emptyHintStr || null);
                                      const erc = emptyHintStr
                                        ? planningColorForRoleChip(emptyHintStr, roleColorMapPlanning)
                                        : null;
                                      const manualEmptyEntry = isManualSlotHere
                                        ? ((pulls || {}) as Record<string, PlanningV2PullEntry>)[
                                            manualSlotKey(d.key, sn, idx, slotIdx)
                                          ]
                                        : undefined;
                                      const manualEmptyIsTagged = isManualSlotPullEntry(manualEmptyEntry);
                                      const manualEmptyRole = manualSlotRoleName(manualEmptyEntry);
                                      const manualEmptyStart = String(manualEmptyEntry?.guardDisplay?.start || "").trim();
                                      const manualEmptyEnd = String(manualEmptyEntry?.guardDisplay?.end || "").trim();
                                      const manualEmptyHours =
                                        manualEmptyStart && manualEmptyEnd
                                          ? `${manualEmptyStart}–${manualEmptyEnd}`
                                          : "";
                                      return (
                                        <div
                                          key={`empty-${d.key}-${sn}-${idx}-${slotIdx}`}
                                          className={
                                            "group/slot w-full flex justify-center py-0.5 " +
                                            (dndHere && dragNm && isSlotHovered
                                              ? "relative z-50 scale-[1.15] origin-center will-change-transform transition-transform duration-150 ease-out"
                                              : "") +
                                            (dndHere && dragNm && !pullsActiveHere && !shiftHoursActiveHere
                                              ? " cursor-pointer"
                                              : "")
                                          }
                                          onClick={(e) => {
                                            if (manualSlotClick(e)) return;
                                            if (pullsActiveHere || shiftHoursActiveHere) return;
                                            if (cellLockedByPull) {
                                              toast.error("לא ניתן לשבץ", {
                                                description: pullEditOnlyViaPopupMessage(),
                                              });
                                              return;
                                            }
                                            trySlotClickAssign(d.key, sn, idx, slotIdx);
                                          }}
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
                                                : linkedConflictCellLabel
                                                  ? " border-red-300 bg-red-50 text-red-700 dark:border-red-600 dark:bg-red-950/40 dark:text-red-300 "
                                                  : " border-zinc-200 bg-zinc-100 text-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 ") +
                                              (pullsActiveHere && isPullable ? " ring-1 ring-orange-400 cursor-pointer" : "") +
                                              (manualEmptyIsTagged ? " ring-1 ring-teal-500 " : "") +
                                              (!dragNm && isSlotHovered ? "scale-110 ring-2 ring-[#00A8E0]" : "") +
                                              (dragNm && emptyOk && !isSlotHovered ? " ring-2 ring-green-500" : "") +
                                              (dragNm && hasDropConflict && !isSlotHovered ? " ring-2 ring-red-500" : "") +
                                              (dragNm && emptyOk && isSlotHovered
                                                ? " [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22),0_0_0_2px_rgb(34_197_94)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38),0_0_0_2px_rgb(34_197_94)]"
                                                : "") +
                                              (dragNm && hasDropConflict && isSlotHovered
                                                ? "ring-2 ring-red-500 cursor-not-allowed [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38)]"
                                                : "") +
                                              (dragNm && !emptyOk && !hasDropConflict && isSlotHovered
                                                ? "ring-2 ring-[#00A8E0] cursor-not-allowed [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38)]"
                                                : "")
                                            }
                                            style={
                                              erc && !(pullsActiveHere && isPullable)
                                                ? { borderColor: erc.border }
                                                : undefined
                                            }
                                            title={dropConflictReason || undefined}
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
                                            {manualEmptyIsTagged ? (
                                              <>
                                                {manualEmptyRole ? (
                                                  <span className="max-w-full truncate px-0.5 text-center text-[6px] font-semibold leading-tight text-teal-700 md:text-[9px] dark:text-teal-300">
                                                    {manualEmptyRole}
                                                  </span>
                                                ) : null}
                                                <span
                                                  className="text-[7px] font-semibold leading-none text-red-600 md:text-[10px] dark:text-red-400"
                                                  dir="ltr"
                                                >
                                                  {manualEmptyHours || "—"}
                                                </span>
                                              </>
                                            ) : emptyHintStr ? (
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
                                            ) : linkedConflictCellLabel ? (
                                              <span className="max-w-full truncate px-0.5 text-center text-[7px] font-semibold leading-tight md:text-[10px]">
                                                {linkedConflictCellLabel}
                                              </span>
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
                                    const manualSlotRoleHere = isManualSlotHere
                                      ? manualSlotRoleName(
                                          ((pulls || {}) as Record<string, PlanningV2PullEntry>)[
                                            manualSlotKey(d.key, sn, idx, slotIdx)
                                          ],
                                        )
                                      : null;
                                    const roleToShow =
                                      manualSlotRoleHere || slotExpectedRole || rn || pullRoleName || null;
                                    const rcRole = roleToShow
                                      ? planningColorForRoleChip(roleToShow, roleColorMapPlanning)
                                      : null;
                                    const nmKey = normName(nm);
                                    const summaryPickActive =
                                      !!summaryHighlightNorm && !!nmKey && nmKey === summaryHighlightNorm;
                                    const pullRel = pullHighlightByNormName.get(normPullWorkerName(nm));
                                    const pullHighlightRing = pullHighlightRingClass(pullRel);
                                    const pullOrangeOutline =
                                      !summaryPickActive && pullHighlightRing.trim().length > 0;
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
                                    const guardTimeStr = guardDisplayTimeForSlot(
                                      pulls || null,
                                      d.key,
                                      sn,
                                      idx,
                                      slotIdx,
                                    );
                                    const hasGuardDisplayOnSlot = !!guardTimeStr;
                                    const redTimeLine = guardTimeStr || pullTime;
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
                                    // Clic sur bulle orange adjacente (before/after) hors cellule trou.
                                    if (!existingPull && pullRel) {
                                      for (const [k, entry] of Object.entries(pullsMap)) {
                                        const parts = String(k || "").split("|");
                                        if (parts.length < 4 || Number(parts[2]) !== Number(idx)) continue;
                                        if (!isRealPullEntry(entry)) continue;
                                        const b = String(entry?.before?.name || "").trim();
                                        const a = String(entry?.after?.name || "").trim();
                                        if (pullRel === "before" && b === nm) {
                                          resolvedPullKey = String(k);
                                          existingPull = entry;
                                          break;
                                        }
                                        if (pullRel === "after" && a === nm) {
                                          resolvedPullKey = String(k);
                                          existingPull = entry;
                                          break;
                                        }
                                        if (pullRel === "cell" && (b === nm || a === nm)) {
                                          resolvedPullKey = String(k);
                                          existingPull = entry;
                                          break;
                                        }
                                      }
                                    }
                                    const hasPullOnSlot =
                                      !!String(existingPull?.before?.name || "").trim() ||
                                      !!String(existingPull?.after?.name || "").trim();
                                    const blockPullBubble = blockSavedViewPullBubble(
                                      isSavedMode,
                                      editingSaved,
                                      pulls || null,
                                      d.key,
                                      sn,
                                      idx,
                                      nm,
                                    );
                                    const activeNm = (draggingWorkerName || "").trim();
                                    const isWorkerSelectedHere =
                                      !!activeNm &&
                                      normName(activeNm) === nmKey &&
                                      !!selectedWorkerSource &&
                                      selectedWorkerSource.dayKey === d.key &&
                                      selectedWorkerSource.shiftName === sn &&
                                      selectedWorkerSource.stationIndex === idx &&
                                      selectedWorkerSource.slotIndex === slotIdx;
                                    return (
                                      <div
                                        key={`${d.key}-${sn}-${idx}-slot-${slotIdx}-${nmKey}`}
                                        className={
                                          "group/slot relative flex w-full justify-center py-0.5 " +
                                          (dndHere && dragNm && isSlotHovered
                                            ? "z-50 scale-[1.15] origin-center will-change-transform transition-transform duration-150 ease-out"
                                            : "") +
                                          (summaryPickActive
                                            ? " z-20 rounded-full transition-shadow duration-200"
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
                                          tabIndex={blockPullBubble ? -1 : 0}
                                          data-manual-worker-select="1"
                                          data-dkey={d.key}
                                          data-sname={sn}
                                          data-stidx={idx}
                                          data-slotidx={slotIdx}
                                          draggable={dndHere && !hasPullOnSlot && !pullRel}
                                          onDragStart={(e) => {
                                            if (!dndHere || hasPullOnSlot || pullRel) {
                                              e.preventDefault();
                                              if (hasPullOnSlot || pullRel) {
                                                toast.error("לא ניתן לשבץ", {
                                                  description: pullEditOnlyViaPopupMessage(),
                                                });
                                              }
                                              return;
                                            }
                                            onWorkerDragStart(e, nm);
                                          }}
                                          onDragEnd={onChipDragEnd}
                                          className={
                                            "relative inline-flex min-h-6 w-auto max-w-[6rem] min-w-0 select-none flex-col items-center overflow-hidden rounded-full border px-1 py-0.5 shadow-sm transition-[max-width,transform] duration-200 ease-out md:min-h-9 md:w-full md:max-w-[6rem] md:px-3 md:py-1 md:group-hover/slot:max-w-[18rem] md:group-hover/slot:z-30 md:focus:max-w-[18rem] md:focus:z-30 focus:outline-none " +
                                            (dndHere && !hasPullOnSlot && !pullRel
                                              ? "cursor-grab active:cursor-grabbing "
                                              : "cursor-default ") +
                                            (manualEditable && !pullsActiveHere && !shiftHoursActiveHere
                                              ? "cursor-pointer "
                                              : "") +
                                            (isWorkerSelectedHere
                                              ? " ring-2 ring-[#00A8E0] ring-offset-1 ring-offset-white dark:ring-offset-zinc-950 "
                                              : "") +
                                            (expandedSlotKey === expKey
                                              ? " z-30 w-[18rem] max-w-[18rem]"
                                              : "") +
                                            (summaryPickActive ? "" : pullHighlightRing) +
                                            ((hasPullOnSlot || hasGuardDisplayOnSlot || shiftHoursActiveHere) &&
                                            !blockPullBubble
                                              ? " cursor-pointer"
                                              : "") +
                                            (isManualSlotHere && !summaryPickActive ? " ring-1 ring-teal-500" : "") +
                                            ((hasGuardDisplayOnSlot || shiftHoursActiveHere) &&
                                            !summaryPickActive &&
                                            !isManualSlotHere
                                              ? " ring-1 ring-yellow-500"
                                              : "") +
                                            ((!dragNm && isSlotHovered && !summaryPickActive
                                              ? " z-[40] scale-110 ring-2 ring-[#00A8E0] "
                                              : "") ||
                                              (summaryPickActive
                                                ? " relative z-[21] scale-110 ring-2 ring-[#00A8E0] ring-offset-2 ring-offset-white dark:ring-offset-zinc-950 "
                                                : "")) +
                                            (dragNm && fillOk && !isSlotHovered ? " ring-2 ring-green-500" : "") +
                                            (dragNm && hasDropConflict && !isSlotHovered ? " ring-2 ring-red-500" : "") +
                                            (dragNm && fillOk && isSlotHovered
                                              ? " [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22),0_0_0_2px_rgb(34_197_94)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38),0_0_0_2px_rgb(34_197_94)]"
                                              : "") +
                                            (dragNm && hasDropConflict && isSlotHovered
                                              ? " ring-2 ring-red-500 cursor-not-allowed [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38)]"
                                              : "") +
                                            (dragNm && !fillOk && !hasDropConflict && isSlotHovered
                                              ? "ring-2 ring-[#00A8E0] cursor-not-allowed [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38)]"
                                              : "")
                                          }
                                          style={{
                                            backgroundColor: c.bg,
                                            borderColor:
                                              pullOrangeOutline
                                                ? "rgb(251 146 60)"
                                                : rcRole
                                                  ? rcRole.border
                                                  : c.border,
                                            color: c.text,
                                          }}
                                          title={nm}
                                          onPointerDown={() => {
                                            if (blockPullBubble) return;
                                            setExpandedSlotKey(expKey);
                                          }}
                                          onPointerEnter={(e) => {
                                            if (blockPullBubble) return;
                                            if (e.pointerType === "mouse") setExpandedSlotKey(expKey);
                                          }}
                                          onPointerLeave={(e) => {
                                            if (blockPullBubble) return;
                                            if (e.pointerType === "mouse") {
                                              setExpandedSlotKey((k) => (k === expKey ? null : k));
                                            }
                                          }}
                                          onFocus={() => {
                                            if (blockPullBubble) return;
                                            setExpandedSlotKey(expKey);
                                          }}
                                          onBlur={() =>
                                            setExpandedSlotKey((k) => (k === expKey ? null : k))
                                          }
                                          onClick={(e) => {
                                            if (manualSlotClick(e)) return;
                                            if (blockPullBubble) return;
                                            if (
                                              nmTrim &&
                                              onUpsertGuardDisplay &&
                                              !isManualSlotHere &&
                                              (shiftHoursActiveHere || hasGuardDisplayOnSlot)
                                            ) {
                                              const hours = hoursFromConfig(st, sn) || hoursOf(sn);
                                              const parsed = parseHoursRange(hours);
                                              const gd = pullsMap[slotPullKey]?.guardDisplay;
                                              setShiftHoursEditor({
                                                key: slotPullKey,
                                                dayKey: d.key,
                                                shiftName: sn,
                                                stationIdx: idx,
                                                slotIdx,
                                                workerName: nmTrim,
                                                start: String(gd?.start || parsed?.start || "00:00"),
                                                end: String(gd?.end || parsed?.end || "23:59"),
                                                shiftStart: parsed?.start || "00:00",
                                                shiftEnd: parsed?.end || "23:59",
                                              });
                                              return;
                                            }
                                            // משיכה déjà affectée : ouvrir la popup même hors mode משיכות
                                            // (manuel ou automatique ; bloqué seulement en שמור sans עריכה via blockPullBubble).
                                            if (hasPullOnSlot && !shiftHoursActiveHere) {
                                              e.stopPropagation();
                                              const pullKey = resolvedPullKey || slotPullKey;
                                              const pullParts = String(pullKey).split("|");
                                              const holeDayKey = String(pullParts[0] || d.key);
                                              const holeShiftName = String(pullParts[1] || sn);
                                              const holeStationIdx = Number(pullParts[2]);
                                              const holeStIdx = Number.isFinite(holeStationIdx) ? holeStationIdx : idx;
                                              const holeDayIdx = DAY_COLS.findIndex((c) => c.key === holeDayKey);
                                              const holeShiftIdx = shiftNamesAll.indexOf(holeShiftName);
                                              const holePrevRef =
                                                holeDayIdx < 0 || holeShiftIdx < 0
                                                  ? null
                                                  : holeDayIdx === 0 && holeShiftIdx === 0
                                                    ? null
                                                    : holeShiftIdx === 0
                                                      ? { dayIdx: holeDayIdx - 1, shiftIdx: shiftNamesAll.length - 1 }
                                                      : { dayIdx: holeDayIdx, shiftIdx: holeShiftIdx - 1 };
                                              const holeNextRef =
                                                holeDayIdx < 0 || holeShiftIdx < 0
                                                  ? null
                                                  : holeDayIdx === DAY_COLS.length - 1 &&
                                                      holeShiftIdx === shiftNamesAll.length - 1
                                                    ? null
                                                    : holeShiftIdx === shiftNamesAll.length - 1
                                                      ? { dayIdx: holeDayIdx + 1, shiftIdx: 0 }
                                                      : { dayIdx: holeDayIdx, shiftIdx: holeShiftIdx + 1 };
                                              const used = new Set<string>();
                                              const prefix = `${holeDayKey}|${holeShiftName}|${holeStIdx}|`;
                                              Object.entries(pulls || {}).forEach(([k, v]) => {
                                                if (!String(k).startsWith(prefix) || String(k) === pullKey) return;
                                                const pe = v as { before?: { name?: string }; after?: { name?: string } };
                                                const b = String(pe?.before?.name || "").trim();
                                                const a = String(pe?.after?.name || "").trim();
                                                if (b) used.add(b);
                                                if (a) used.add(a);
                                              });
                                              const beforeName = String(existingPull?.before?.name || "").trim();
                                              const afterName = String(existingPull?.after?.name || "").trim();
                                              const prevDayKey = holePrevRef ? DAY_COLS[holePrevRef.dayIdx].key : "";
                                              const nextDayKey = holeNextRef ? DAY_COLS[holeNextRef.dayIdx].key : "";
                                              const prevShift = holePrevRef ? shiftNamesAll[holePrevRef.shiftIdx] : "";
                                              const nextShift = holeNextRef ? shiftNamesAll[holeNextRef.shiftIdx] : "";
                                              let beforeOptions = holePrevRef
                                                ? planningCellNames(assignmentsSafe?.[prevDayKey]?.[prevShift]?.[holeStIdx]).filter((x) => !used.has(x))
                                                : [];
                                              let afterOptions = holeNextRef
                                                ? planningCellNames(assignmentsSafe?.[nextDayKey]?.[nextShift]?.[holeStIdx]).filter((x) => !used.has(x))
                                                : [];
                                              if (beforeName && !beforeOptions.includes(beforeName)) beforeOptions = [beforeName, ...beforeOptions];
                                              if (afterName && !afterOptions.includes(afterName)) afterOptions = [afterName, ...afterOptions];
                                              const holeSt = stations[holeStIdx] || st;
                                              const hours = hoursFromConfig(holeSt, holeShiftName) || hoursOf(holeShiftName);
                                              const parsed = parseHoursRange(hours);
                                              const holeRequired = getRequiredFor(holeSt, holeShiftName, holeDayKey);
                                              setPullsEditor({
                                                key: pullKey,
                                                dayKey: holeDayKey,
                                                shiftName: holeShiftName,
                                                stationIdx: holeStIdx,
                                                required: holeRequired,
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
                                              return;
                                            }
                                            if (
                                              manualEditable &&
                                              !pullsActiveHere &&
                                              !shiftHoursActiveHere
                                            ) {
                                              const activeNmLocal = (draggingWorkerName || "").trim();
                                              if (activeNmLocal && normName(activeNmLocal) !== nmKey) {
                                                trySlotClickAssign(d.key, sn, idx, slotIdx);
                                                return;
                                              }
                                              if (onWorkerSelectToggle) {
                                                e.stopPropagation();
                                                onWorkerSelectToggle(nmTrim, {
                                                  dayKey: d.key,
                                                  shiftName: sn,
                                                  stationIndex: idx,
                                                  slotIndex: slotIdx,
                                                  workerName: nmTrim,
                                                });
                                                return;
                                              }
                                            }
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
                                            {redTimeLine ? (
                                              <span
                                                dir="ltr"
                                                className="mt-0.5 max-w-full truncate text-[6px] font-medium leading-tight text-red-600 dark:text-red-400 md:text-[10px]"
                                              >
                                                {redTimeLine}
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
              <div className="mt-1.5 flex shrink-0 items-center justify-start">
                <div className="flex items-center overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
                  <button
                    type="button"
                    onClick={() => adjustStationZoom(idx, -STATION_GRID_ZOOM_STEP)}
                    disabled={stationZoom <= MIN_STATION_GRID_ZOOM}
                    className="inline-flex h-10 w-10 items-center justify-center text-xl font-semibold leading-none text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    aria-label="הקטנת תצוגת הגריד"
                    title="הקטנה"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    onClick={() => adjustStationZoom(idx, STATION_GRID_ZOOM_STEP)}
                    disabled={stationZoom >= MAX_STATION_GRID_ZOOM}
                    className="inline-flex h-10 w-10 items-center justify-center border-l border-zinc-200 text-xl font-semibold leading-none text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    aria-label="הגדלת תצוגת הגריד"
                    title="הגדלה"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>
              );
            })()}
          </div>
          );
        })}
      </div>
      {manualEditable && workers.length > 0 ? (
        <PlanningV2ManualWorkerPalette
          workers={workers}
          nameColorMap={nameColorMap}
          selectedWorkerName={draggingWorkerName}
          selectedWorkerFromGrid={!!selectedWorkerSource}
          onWorkerSelectToggle={onWorkerSelectToggle}
          onDragPreviewStart={(name) => onDraggingWorkerChange?.(name)}
          onDragPreviewEnd={() => onDraggingWorkerChange?.(null)}
        />
      ) : null}
      {pullsEditor ? (
        <PlanningV2StationPullsEditorModal
          editor={pullsEditor}
          onClose={() => setPullsEditor(null)}
          setEditor={setPullsEditor}
          onRemovePull={onRemovePull}
          onUpsertPull={onUpsertPull}
        />
      ) : null}
      {shiftHoursEditor ? (
        <PlanningV2StationShiftHoursEditorModal
          editor={shiftHoursEditor}
          oorConfirm={shiftHoursOorConfirm}
          onClose={() => setShiftHoursEditor(null)}
          setEditor={setShiftHoursEditor}
          setOorConfirm={setShiftHoursOorConfirm}
          onRemoveGuardDisplay={onRemoveGuardDisplay}
          onUpsertGuardDisplay={onUpsertGuardDisplay}
        />
      ) : null}
      {manualSlotEditor ? (
        <PlanningV2StationManualSlotEditorModal
          editor={manualSlotEditor}
          oorConfirm={manualSlotOorConfirm}
          onClose={() => setManualSlotEditor(null)}
          setEditor={setManualSlotEditor}
          setOorConfirm={setManualSlotOorConfirm}
          onSave={onUpsertManualAssignmentSlot}
          onRemove={onRemoveManualAssignmentSlot}
        />
      ) : null}
    </section>
  );
}

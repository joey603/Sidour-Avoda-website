"use client";

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import {
  isShiftLockedByEvent,
  locksForWorkerName,
} from "../lib/event-availability-locks";
import {
  analyzeManualSlotDrop,
  pullEditOnlyViaPopupMessage,
  workerParticipatesInPull,
  type ManualDropFlags,
} from "../lib/planning-v2-manual-full-drop";
import type { ManualDragSource } from "../lib/planning-v2-manual-drop";
import { normWorkerName } from "../lib/planning-v2-worker-name";
import type { PlanningV2PullsMap, PlanningWorker, SiteSummary, WorkerAvailability } from "../types";

type AssignmentsMap = Record<string, Record<string, string[][]>>;
type AvailabilityOverlays = Record<string, Record<string, string[]>>;

type ManualEditingPlanSlice = {
  displayPulls: PlanningV2PullsMap | null | undefined;
  getLatestAssignmentBase: () => AssignmentsMap;
  commitDraftAssignments: (assignments: AssignmentsMap) => void;
};

type ManualConfirmState = {
  title: string;
  body: string;
  resolve: (v: boolean) => void;
} | null;

type UsePlanningV2ManualEditingArgs = {
  site: SiteSummary | null;
  siteId: string;
  weekStart: Date;
  workers: PlanningWorker[];
  workerRowsForTable: Array<PlanningWorker & { availability: WorkerAvailability }>;
  availabilityByWorkerName: Record<string, WorkerAvailability>;
  eventLocksByWorkerId: Record<number, Record<string, string[]>>;
  eventAssignmentCountsByName: Map<string, number>;
  manualEditable: boolean;
  plan: ManualEditingPlanSlice;
  setAvailabilityOverlays: Dispatch<SetStateAction<AvailabilityOverlays>>;
  setPullsModeStationIdx: Dispatch<SetStateAction<number | null>>;
  setShiftHoursModeStationIdx: Dispatch<SetStateAction<number | null>>;
};

export function usePlanningV2ManualEditing({
  site,
  siteId,
  weekStart,
  workers,
  workerRowsForTable,
  availabilityByWorkerName,
  eventLocksByWorkerId,
  eventAssignmentCountsByName,
  manualEditable,
  plan,
  setAvailabilityOverlays,
  setPullsModeStationIdx,
  setShiftHoursModeStationIdx,
}: UsePlanningV2ManualEditingArgs) {
  const [manualConfirm, setManualConfirm] = useState<ManualConfirmState>(null);
  const [manualDragWorkerName, setManualDragWorkerName] = useState<string | null>(null);
  const [manualSelectSource, setManualSelectSource] = useState<ManualDragSource | null>(null);

  const resetManualSelection = useCallback(() => {
    setManualDragWorkerName(null);
    setManualSelectSource(null);
  }, []);

  useEffect(() => {
    resetManualSelection();
  }, [weekStart, resetManualSelection]);

  /** Début de drag / sélection עובד → quitter משיכה / שינוי שעות. */
  const handleDraggingWorkerChange = useCallback((workerName: string | null) => {
    if (workerName) {
      setPullsModeStationIdx(null);
      setShiftHoursModeStationIdx(null);
    }
    setManualDragWorkerName(workerName);
    if (!workerName) setManualSelectSource(null);
  }, [setPullsModeStationIdx, setShiftHoursModeStationIdx]);

  const handleWorkerSelectToggle = useCallback(
    (workerName: string, source: ManualDragSource | null = null) => {
      const nm = String(workerName || "").trim();
      if (!nm) return;
      const nameMatch =
        !!manualDragWorkerName && normWorkerName(manualDragWorkerName) === normWorkerName(nm);
      const sourceMatch =
        !source && !manualSelectSource
          ? true
          : !!source &&
            !!manualSelectSource &&
            source.dayKey === manualSelectSource.dayKey &&
            source.shiftName === manualSelectSource.shiftName &&
            source.stationIndex === manualSelectSource.stationIndex &&
            source.slotIndex === manualSelectSource.slotIndex;
      if (nameMatch && sourceMatch) {
        resetManualSelection();
        return;
      }
      setPullsModeStationIdx(null);
      setShiftHoursModeStationIdx(null);
      setManualDragWorkerName(nm);
      setManualSelectSource(source);
    },
    [
      manualDragWorkerName,
      manualSelectSource,
      resetManualSelection,
      setPullsModeStationIdx,
      setShiftHoursModeStationIdx,
    ],
  );

  /** Désélectionner l’עובד actif au clic hors grille / palette / noms. */
  useEffect(() => {
    if (!manualEditable || !manualDragWorkerName) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest("[data-manual-worker-select]")) return;
      if (t.closest('[data-slot="1"]')) return;
      if (t.closest('[role="dialog"]')) return;
      resetManualSelection();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [manualEditable, manualDragWorkerName, resetManualSelection]);

  const waitManualConfirm = useCallback((title: string, body: string) => {
    return new Promise<boolean>((resolve) => {
      setManualConfirm({ title, body, resolve });
    });
  }, []);

  const handleManualSlotDrop = useCallback(
    async (p: {
      dayKey: string;
      shiftName: string;
      stationIndex: number;
      slotIndex: number;
      workerName: string;
      dragSource: ManualDragSource | null;
    }) => {
      if (
        isShiftLockedByEvent(
          locksForWorkerName(eventLocksByWorkerId, workers, p.workerName),
          p.dayKey,
          p.shiftName,
        )
      ) {
        toast.error("לא ניתן לשבץ", { description: "העובד משובץ לאירוע בזמן זה (לא ניתן לשינוי)." });
        return;
      }
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
          eventAssignmentCount: eventAssignmentCountsByName.get(String(p.workerName || "").trim()) || 0,
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
                const srcNext = JSON.parse(JSON.stringify(nextAssignments)) as AssignmentsMap;
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
          if (p.dragSource) {
            setManualSelectSource({
              dayKey: p.dayKey,
              shiftName: p.shiftName,
              stationIndex: p.stationIndex,
              slotIndex: flags.forceReplacePull ? 0 : p.slotIndex,
              workerName: p.workerName,
            });
          }
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
        if (r.action === "confirm_replace_pull") {
          toast.error("לא ניתן לשבץ", { description: pullEditOnlyViaPopupMessage() });
          return;
        }
      }
      toast.error("שגיאה", { description: "יותר מדי שלבי אישור — נסה שוב." });
    },
    [
      site,
      siteId,
      weekStart,
      workers,
      availabilityByWorkerName,
      plan,
      waitManualConfirm,
      workerRowsForTable,
      eventLocksByWorkerId,
      eventAssignmentCountsByName,
      setAvailabilityOverlays,
    ],
  );

  const handleManualSlotDragOutside = useCallback(
    (dragSource: ManualDragSource) => {
      const src = dragSource;
      if (!src) return;
      if (
        workerParticipatesInPull(plan.displayPulls ?? null, src.workerName, {
          dayKey: src.dayKey,
          shiftName: src.shiftName,
          stationIndex: src.stationIndex,
        })
      ) {
        toast.error("לא ניתן לשבץ", { description: pullEditOnlyViaPopupMessage() });
        return;
      }
      const base = plan.getLatestAssignmentBase();
      const row = base[src.dayKey]?.[src.shiftName]?.[src.stationIndex];
      if (!Array.isArray(row)) return;
      const next = JSON.parse(JSON.stringify(base)) as AssignmentsMap;
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

  return {
    manualConfirm,
    setManualConfirm,
    manualDragWorkerName,
    manualSelectSource,
    resetManualSelection,
    handleDraggingWorkerChange,
    handleWorkerSelectToggle,
    waitManualConfirm,
    handleManualSlotDrop,
    handleManualSlotDragOutside,
  };
}

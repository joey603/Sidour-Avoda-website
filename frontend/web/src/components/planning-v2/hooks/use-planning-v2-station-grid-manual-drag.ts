import { useRef, type Dispatch, type DragEvent, type SetStateAction } from "react";
import { toast } from "sonner";
import type { PlanningV2PullEntry } from "../types";
import type { ManualDragSource } from "../lib/planning-v2-manual-drop";
import {
  pullEditOnlyViaPopupMessage,
  pullEntriesInCell,
  workerParticipatesInPull,
} from "../lib/planning-v2-manual-full-drop";

type ManualSlotDropArgs = {
  dayKey: string;
  shiftName: string;
  stationIndex: number;
  slotIndex: number;
  workerName: string;
  dragSource: ManualDragSource | null;
};

type UsePlanningV2StationGridManualDragParams = {
  manualEditable: boolean;
  draggingWorkerName?: string | null;
  selectedWorkerSource?: ManualDragSource | null;
  assignments: Record<string, Record<string, string[][]>> | null | undefined;
  pulls?: Record<string, unknown> | null;
  onManualSlotDrop?: (args: ManualSlotDropArgs) => void | Promise<void>;
  onManualSlotDragOutside?: (source: ManualDragSource) => void | Promise<void>;
  onDraggingWorkerChange?: (name: string | null) => void;
  setHoverSlotKey: Dispatch<SetStateAction<string | null>>;
};

export function usePlanningV2StationGridManualDrag({
  manualEditable,
  draggingWorkerName,
  selectedWorkerSource,
  assignments,
  pulls,
  onManualSlotDrop,
  onManualSlotDragOutside,
  onDraggingWorkerChange,
  setHoverSlotKey,
}: UsePlanningV2StationGridManualDragParams) {
  const dragSourceRef = useRef<ManualDragSource | null>(null);
  const didDropRef = useRef(false);

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

  const rejectPullBlockedDrop = () => {
    didDropRef.current = true;
    setHoverSlotKey(null);
    onDraggingWorkerChange?.(null);
    dragSourceRef.current = null;
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
    const pullsMap = (pulls as Record<string, PlanningV2PullEntry> | null | undefined) || null;
    if (pullEntriesInCell(pullsMap, dayKey, shiftName, stationIndex).length > 0) {
      toast.error("לא ניתן לשבץ", { description: pullEditOnlyViaPopupMessage() });
      rejectPullBlockedDrop();
      return;
    }
    const targetNm = String(
      (assignments && typeof assignments === "object"
        ? assignments?.[dayKey]?.[shiftName]?.[stationIndex]?.[slotIndex]
        : "") || "",
    ).trim();
    if (
      (src &&
        workerParticipatesInPull(pullsMap, src.workerName, {
          dayKey: src.dayKey,
          shiftName: src.shiftName,
          stationIndex: src.stationIndex,
        })) ||
      (targetNm &&
        workerParticipatesInPull(pullsMap, targetNm, {
          dayKey,
          shiftName,
          stationIndex,
        }))
    ) {
      toast.error("לא ניתן לשבץ", { description: pullEditOnlyViaPopupMessage() });
      rejectPullBlockedDrop();
      return;
    }
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

  const trySlotClickAssign = (
    dayKey: string,
    shiftName: string,
    stationIndex: number,
    slotIndex: number,
  ) => {
    const dragNm = (draggingWorkerName || "").trim();
    if (!dragNm || !manualEditable || !onManualSlotDrop) return;
    const pullsMap = (pulls as Record<string, PlanningV2PullEntry> | null | undefined) || null;
    if (pullEntriesInCell(pullsMap, dayKey, shiftName, stationIndex).length > 0) {
      toast.error("לא ניתן לשבץ", { description: pullEditOnlyViaPopupMessage() });
      return;
    }
    const targetNm = String(
      (assignments && typeof assignments === "object"
        ? assignments?.[dayKey]?.[shiftName]?.[stationIndex]?.[slotIndex]
        : "") || "",
    ).trim();
    if (
      targetNm &&
      workerParticipatesInPull(pullsMap, targetNm, {
        dayKey,
        shiftName,
        stationIndex,
      })
    ) {
      toast.error("לא ניתן לשבץ", { description: pullEditOnlyViaPopupMessage() });
      return;
    }
    void Promise.resolve(
      onManualSlotDrop({
        dayKey,
        shiftName,
        stationIndex,
        slotIndex,
        workerName: dragNm,
        dragSource: selectedWorkerSource || null,
      }),
    );
  };

  const onChipDragEnd = () => {
    const src = dragSourceRef.current;
    const shouldClearFromSource =
      manualEditable &&
      !!src &&
      !didDropRef.current &&
      typeof onManualSlotDragOutside === "function" &&
      !workerParticipatesInPull(
        (pulls as Record<string, PlanningV2PullEntry> | null | undefined) || null,
        src.workerName,
        {
          dayKey: src.dayKey,
          shiftName: src.shiftName,
          stationIndex: src.stationIndex,
        },
      );
    dragSourceRef.current = null;
    didDropRef.current = false;
    setHoverSlotKey(null);
    onDraggingWorkerChange?.(null);
    if (shouldClearFromSource && src) {
      void Promise.resolve(onManualSlotDragOutside(src));
    }
  };

  return {
    dragSourceRef,
    onWorkerDragStart,
    onSlotDragOver,
    onSlotDrop,
    trySlotClickAssign,
    onChipDragEnd,
  };
}

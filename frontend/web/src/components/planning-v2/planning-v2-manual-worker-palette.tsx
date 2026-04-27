"use client";

import type { PlanningWorker } from "./types";
import { buildWorkerNameColorMap, workerNameChipColor } from "./lib/worker-name-chip-color";

type PlanningV2ManualWorkerPaletteProps = {
  workers: PlanningWorker[];
  /** כמו ב-planning: לא להציג ממתינים לאישור */
  hidePendingApproval?: boolean;
  /** נקרא בעת גרירה מהפלטה — להדגשת יעדי שיבוץ בגריד */
  onDragPreviewStart?: (workerName: string) => void;
  onDragPreviewEnd?: () => void;
};

export function PlanningV2ManualWorkerPalette({
  workers,
  hidePendingApproval = true,
  onDragPreviewStart,
  onDragPreviewEnd,
}: PlanningV2ManualWorkerPaletteProps) {
  const list = workers.filter((w) => {
    if (hidePendingApproval && w.pendingApproval) return false;
    return String(w.name || "").trim().length > 0;
  });
  const nameColorMap = buildWorkerNameColorMap(list.map((w) => String(w.name || "").trim()).filter(Boolean));

  return (
    <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50/80 p-3 dark:border-zinc-700 dark:bg-zinc-900/40">
      <div className="mb-2 text-center text-xs text-zinc-600 dark:text-zinc-300">גרור/י עובד אל תא השיבוץ</div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {list.map((w) => {
          const c = workerNameChipColor(w.name, nameColorMap);
          return (
            <span
              key={w.id}
              draggable
              onDragStart={(e) => {
                try {
                  e.dataTransfer.setData("text/plain", w.name);
                  e.dataTransfer.effectAllowed = "copy";
                } catch {
                  /* ignore */
                }
                onDragPreviewStart?.(String(w.name || "").trim());
              }}
              onDragEnd={() => onDragPreviewEnd?.()}
              className="inline-flex cursor-grab select-none items-center rounded-full border px-3 py-1 text-sm shadow-sm active:cursor-grabbing"
              style={{ backgroundColor: c.bg, borderColor: c.border, color: c.text }}
            >
              {w.name}
            </span>
          );
        })}
      </div>
    </div>
  );
}

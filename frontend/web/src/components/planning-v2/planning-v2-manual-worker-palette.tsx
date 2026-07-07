"use client";

import type { PlanningWorker } from "./types";
import { buildWorkerNameColorMap, workerNameChipColor } from "./lib/worker-name-chip-color";

type PlanningV2ManualWorkerPaletteProps = {
  workers: PlanningWorker[];
  /** Si fournie (ex. grille), même couleurs que les cellules — sinon hash par nom. */
  nameColorMap?: Map<string, { bg: string; border: string; text: string }> | null;
  /** כמו ב-planning: לא להציג ממתינים לאישור */
  hidePendingApproval?: boolean;
  selectedWorkerName?: string | null;
  selectedWorkerFromGrid?: boolean;
  onWorkerSelectToggle?: (workerName: string) => void;
  /** נקרא בעת גרירה מהפלטה — להדגשת יעדי שיבוץ בגריד */
  onDragPreviewStart?: (workerName: string) => void;
  onDragPreviewEnd?: () => void;
};

function normWorkerName(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

export function PlanningV2ManualWorkerPalette({
  workers,
  nameColorMap: nameColorMapProp,
  hidePendingApproval = true,
  selectedWorkerName = null,
  selectedWorkerFromGrid = false,
  onWorkerSelectToggle,
  onDragPreviewStart,
  onDragPreviewEnd,
}: PlanningV2ManualWorkerPaletteProps) {
  const list = workers.filter((w) => {
    if (hidePendingApproval && w.pendingApproval) return false;
    return String(w.name || "").trim().length > 0;
  });
  const nameColorMap =
    nameColorMapProp ??
    buildWorkerNameColorMap(list.map((w) => String(w.name || "").trim()).filter(Boolean));

  return (
    <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50/80 p-3 dark:border-zinc-700 dark:bg-zinc-900/40">
      <div className="mb-2 text-center text-xs text-zinc-600 dark:text-zinc-300">
        לחץ/י על עובד ואז על תא שיבוץ (או גרור/י)
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {list.map((w) => {
          const c = workerNameChipColor(w.name, nameColorMap);
          const isSelected =
            !!selectedWorkerName &&
            !selectedWorkerFromGrid &&
            normWorkerName(selectedWorkerName) === normWorkerName(w.name);
          return (
            <button
              key={w.id}
              type="button"
              data-manual-worker-select="1"
              draggable
              onClick={() => onWorkerSelectToggle?.(String(w.name || "").trim())}
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
              className={
                "inline-flex cursor-pointer select-none items-center rounded-full border px-3 py-1 text-sm shadow-sm transition active:cursor-grabbing " +
                (isSelected
                  ? "ring-2 ring-[#00A8E0] ring-offset-2 ring-offset-zinc-50 dark:ring-offset-zinc-900"
                  : "")
              }
              style={{ backgroundColor: c.bg, borderColor: c.border, color: c.text }}
            >
              {w.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

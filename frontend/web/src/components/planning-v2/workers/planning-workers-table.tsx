import type { PlanningWorker } from "../types";
import { DAY_DEFS, displayShiftOrderIndex, isRtlName } from "../lib/display";

type Row = PlanningWorker & { availability: PlanningWorker["availability"] };

type PlanningWorkersTableProps = {
  rows: Row[];
  enabledRoleNames: Set<string>;
  /** Overlays rouges (écart grille vs זמינות) — vide sur planning v2 tant que pas de grille. */
  availabilityOverlays?: Record<string, Record<string, string[]>>;
  onRowClick?: (row: Row) => void;
  workerNameDraggable?: boolean;
  /** מצב ידני: עדכון שם העובד הנגרר להדגשת יעדים בגריד */
  onWorkerNameDragPreview?: (workerName: string | null) => void;
};

export function PlanningWorkersTable({
  rows,
  enabledRoleNames,
  availabilityOverlays = {},
  onRowClick,
  workerNameDraggable = false,
  onWorkerNameDragPreview,
}: PlanningWorkersTableProps) {
  return (
    <div className="max-h-[26rem] overflow-y-auto overflow-x-hidden md:overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-[10px] md:text-sm">
        <thead>
          <tr className="border-b dark:border-zinc-800">
            <th className="w-20 px-1 py-1 text-center text-[10px] md:w-40 md:px-3 md:py-2 md:text-sm">שם</th>
            <th className="w-12 px-0.5 py-1 text-center text-[10px] md:w-auto md:px-3 md:py-2 md:text-sm">מקס&apos;</th>
            <th className="w-16 px-0.5 py-1 text-center text-[10px] md:w-auto md:px-3 md:py-2 md:text-sm">תפקידים</th>
            <th className="w-20 px-0.5 py-1 text-center text-[10px] md:w-auto md:px-3 md:py-2 md:text-sm">זמינות</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-3 py-6 text-center text-zinc-500">
                אין עובדים
              </td>
            </tr>
          ) : (
            rows.map((w) => (
              <tr
                key={w.id}
                onClick={onRowClick ? () => onRowClick(w) : undefined}
                className={`border-b last:border-0 dark:border-zinc-800 ${
                  onRowClick ? "cursor-pointer" : ""
                } ${
                  w.pendingApproval
                    ? "bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/30 dark:hover:bg-blue-900/40"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-800"
                }`}
              >
                <td className="w-20 overflow-hidden px-1 py-1 text-center md:w-40 md:px-3 md:py-2">
                  <span
                    className={
                      "block w-full truncate text-center text-[10px] md:text-sm " +
                      (workerNameDraggable ? "cursor-grab touch-none active:cursor-grabbing" : "")
                    }
                    dir={isRtlName(w.name) ? "rtl" : "ltr"}
                    title={w.name}
                    draggable={workerNameDraggable}
                    onDragStart={(e) => {
                      if (!workerNameDraggable) return;
                      e.stopPropagation();
                      try {
                        e.dataTransfer.setData("text/plain", w.name);
                        e.dataTransfer.effectAllowed = "copy";
                      } catch {
                        /* ignore */
                      }
                      onWorkerNameDragPreview?.(String(w.name || "").trim() || null);
                    }}
                    onDragEnd={() => {
                      if (!workerNameDraggable) return;
                      onWorkerNameDragPreview?.(null);
                    }}
                  >
                    {w.name}
                  </span>
                  {w.pendingApproval && (
                    <span className="mt-1 inline-block rounded-full bg-blue-600/10 px-2 py-0.5 text-[9px] text-blue-700 md:text-[10px] dark:text-blue-300">
                      ממתין לאישור
                    </span>
                  )}
                  {(w.linkedSiteIds?.length ?? 0) > 1 ? (
                    <span className="mt-1 inline-block rounded-full border border-violet-300 bg-violet-50 px-2 py-0.5 text-[9px] text-violet-800 md:text-[10px] dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300">
                      מולטי אתרים
                    </span>
                  ) : null}
                </td>
                <td className="px-0.5 py-1 text-center text-[10px] md:px-3 md:py-2 md:text-sm">{w.maxShifts}</td>
                <td className="whitespace-normal break-words px-0.5 py-1 text-center text-[10px] md:px-3 md:py-2 md:text-sm">
                  {w.roles.filter((rn) => enabledRoleNames.has(String(rn || "").trim())).join(",") || "—"}
                </td>
                <td className="whitespace-normal break-words px-0.5 py-1 text-center text-[10px] md:px-3 md:py-2 md:text-sm">
                  {DAY_DEFS.map((d, i) => {
                    const baseRaw = (w.availability[d.key] || []) as string[];
                    const base = [...baseRaw].sort((a, b) => displayShiftOrderIndex(a) - displayShiftOrderIndex(b));
                    const extra = ((availabilityOverlays[w.name]?.[d.key]) || [])
                      .filter((sn) => !baseRaw.includes(sn))
                      .sort((a, b) => displayShiftOrderIndex(a) - displayShiftOrderIndex(b));
                    return (
                      <span
                        key={d.key}
                        className="block text-zinc-600 md:inline-block ltr:mr-0.5 md:ltr:mr-2 rtl:ml-0.5 md:rtl:ml-2 dark:text-zinc-300"
                      >
                        <span className="font-semibold">{d.label}</span>:
                        {base.length > 0 ? base.join("/") : "—"}
                        {extra.length > 0 && (
                          <>
                            {base.length > 0 ? "/" : ""}
                            {extra.map((sn, idx) => (
                              <span key={sn + idx} className="text-red-600 dark:text-red-400">
                                {sn}
                                {idx < extra.length - 1 ? "/" : ""}
                              </span>
                            ))}
                          </>
                        )}
                        {i < DAY_DEFS.length - 1 ? " " : ""}
                      </span>
                    );
                  })}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

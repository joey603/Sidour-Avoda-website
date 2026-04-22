"use client";

type LinkedAvailabilityConfirmDialogProps = {
  open: boolean;
  siteNames: string[];
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

export function LinkedAvailabilityConfirmDialog({
  open,
  siteNames,
  onCancel,
  onConfirm,
}: LinkedAvailabilityConfirmDialogProps) {
  if (!open || siteNames.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 text-center shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-3 text-sm">
          {`העובד משויך גם לאתרים נוספים: ${siteNames.join(", ")}.`}
          <br />
          הזמינות תתעדכן אוטומטית גם באתרים המקושרים.
        </div>
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            onClick={() => onCancel()}
          >
            ביטול
          </button>
          <button
            type="button"
            className="rounded-md bg-[#00A8E0] px-3 py-1 text-sm text-white hover:bg-[#0092c6]"
            onClick={() => void onConfirm()}
          >
            כן
          </button>
        </div>
      </div>
    </div>
  );
}

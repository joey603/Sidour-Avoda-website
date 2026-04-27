"use client";

type PlanningV2ManualConfirmDialogProps = {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function PlanningV2ManualConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "המשך",
  cancelLabel = "ביטול",
  onConfirm,
  onCancel,
}: PlanningV2ManualConfirmDialogProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="manual-confirm-title"
    >
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
        <h2 id="manual-confirm-title" className="mb-2 text-center text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {title}
        </h2>
        <p className="mb-4 whitespace-pre-line text-center text-sm text-zinc-700 dark:text-zinc-300">{body}</p>
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6]"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

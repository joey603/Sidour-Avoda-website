"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type LinkedAvailabilityConfirmDialogProps = {
  open: boolean;
  siteNames: string[];
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

/** Au-dessus de WorkerEditModal (z-[10000]) et des autres overlays planning. */
const DIALOG_Z = "z-[11000]";

export function LinkedAvailabilityConfirmDialog({
  open,
  siteNames,
  onCancel,
  onConfirm,
}: LinkedAvailabilityConfirmDialogProps) {
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalEl(typeof document !== "undefined" ? document.body : null);
  }, []);

  if (!open || siteNames.length === 0 || !portalEl) return null;

  return createPortal(
    <div
      className={`fixed inset-0 ${DIALOG_Z} flex min-h-[100dvh] w-screen items-center justify-center bg-black/40 p-4`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="linked-availability-confirm-title"
    >
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 text-center shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
        <div id="linked-availability-confirm-title" className="mb-3 text-sm">
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
    </div>,
    portalEl,
  );
}

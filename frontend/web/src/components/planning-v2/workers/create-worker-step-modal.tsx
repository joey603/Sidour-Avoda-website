"use client";

import { useEffect, useState } from "react";

type CreateWorkerStepModalProps = {
  open: boolean;
  onClose: () => void;
  /** Fermer la modale création et ouvrir le sélecteur d’employés existants (comme le planning). */
  onOpenExistingPicker: () => void;
  initialName?: string;
  initialPhone?: string;
  onContinue: (name: string, phoneDigits: string) => Promise<void>;
};

/**
 * Première étape « הוסף עובד » — identique au planning : יצירת עובד חדש (שם + טלפון) puis המשך vers l’éditeur complet.
 */
export function CreateWorkerStepModal({
  open,
  onClose,
  onOpenExistingPicker,
  initialName = "",
  initialPhone = "",
  onContinue,
}: CreateWorkerStepModalProps) {
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState(initialPhone);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setPhone(initialPhone);
      setSaving(false);
    }
  }, [open, initialName, initialPhone]);

  if (!open) return null;

  const digits = String(phone || "").replace(/\D/g, "").slice(0, 10);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
        <div className="relative mb-3 flex items-center justify-center">
          <h3 className="text-center text-lg font-semibold">יצירת עובד חדש</h3>
          <button
            type="button"
            onClick={() => onClose()}
            className="absolute right-2 top-1.5 rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            ✕
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-semibold">שם העובד</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              placeholder="הזן שם"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-semibold">מספר טלפון</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              placeholder="הזן מספר טלפון"
            />
            {!!phone && digits.length !== 10 ? (
              <div className="mt-1 text-xs text-red-600">מספר טלפון חייב להכיל בדיוק 10 ספרות</div>
            ) : null}
          </div>
        </div>
        <div className="mt-4">
          <button
            type="button"
            onClick={() => onOpenExistingPicker()}
            className="w-full rounded-md border border-[#00A8E0] px-4 py-2 text-sm font-medium text-[#00A8E0] hover:bg-sky-50 dark:border-sky-700 dark:text-sky-300 dark:hover:bg-sky-950/30"
          >
            הוסף עובד קיים
          </button>
        </div>
        <div className="mt-4 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => onClose()}
            className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            ביטול
          </button>
          <button
            type="button"
            disabled={saving || !name.trim() || digits.length !== 10}
            onClick={async () => {
              const trimmedName = name.trim();
              if (!trimmedName || digits.length !== 10) {
                return;
              }
              setSaving(true);
              try {
                await onContinue(trimmedName, digits);
              } finally {
                setSaving(false);
              }
            }}
            className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "ממשיך..." : "המשך"}
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { clearAllPlanningSessionCaches } from "@/lib/planning-session-cache";
import { toast } from "sonner";
import type { SiteSummary } from "./types";

async function copyTextWithFallback(value: string): Promise<boolean> {
  const text = String(value || "");
  if (!text) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof document !== "undefined") {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const success = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (success) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

type PlanningV2SitePaperHeaderProps = {
  siteId: string;
  /** Données site chargées par le parent (évite un double fetch). */
  site: SiteSummary | null;
  siteLoading: boolean;
};

/** Bloc « אתר » + nom + לינק לעובד / הגדרות — aligné sur `planning/[id]`. */
export function PlanningV2SitePaperHeader({ siteId, site, siteLoading }: PlanningV2SitePaperHeaderProps) {
  const router = useRouter();
  const idNum = Number(siteId);
  const idValid = Number.isFinite(idNum) && idNum > 0;

  const [workerInviteLinkLoading, setWorkerInviteLinkLoading] = useState(false);
  const [workerInviteLinkDialog, setWorkerInviteLinkDialog] = useState<string | null>(null);

  return (
    <>
      <div className="relative mb-2">
        <div className="text-sm text-zinc-500">אתר</div>
        <div className="text-lg font-medium">{siteLoading ? "…" : site?.name ?? (idValid ? "—" : "—")}</div>
        <div className="absolute left-0 top-0 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={async () => {
              if (!idValid) return;
              try {
                setWorkerInviteLinkLoading(true);
                const result = await apiFetch<{ invite_path: string }>(`/director/sites/${siteId}/worker-invite`, {
                  headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                });
                const absoluteUrl =
                  typeof window !== "undefined" ? `${window.location.origin}${result.invite_path}` : result.invite_path;
                const copied = await copyTextWithFallback(absoluteUrl);
                if (copied) {
                  toast.success("לינק ההרשמה הועתק");
                } else {
                  setWorkerInviteLinkDialog(absoluteUrl);
                }
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : "נסה שוב מאוחר יותר.";
                toast.error("לא ניתן היה ליצור לינק הזמנה", { description: msg });
              } finally {
                setWorkerInviteLinkLoading(false);
              }
            }}
            disabled={workerInviteLinkLoading || !idValid}
            className="inline-flex items-center gap-1.5 rounded-lg border border-sky-300 bg-gradient-to-b from-sky-50 to-sky-100/80 px-3 py-2 text-sm font-medium text-sky-900 shadow-sm transition hover:border-sky-400 hover:from-sky-100 hover:to-sky-100 disabled:opacity-60 dark:border-sky-700 dark:from-sky-950/50 dark:to-sky-950/30 dark:text-sky-100 dark:hover:border-sky-600 dark:hover:from-sky-900/60"
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              className="shrink-0 text-sky-700 dark:text-sky-300"
              fill="currentColor"
              aria-hidden
            >
              <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z" />
            </svg>
            {workerInviteLinkLoading ? "מציאת לינק..." : "לינק לעובד"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (site?.id != null) {
                clearAllPlanningSessionCaches();
                router.push(`/director/sites/${site.id}/edit`);
              }
            }}
            disabled={!site?.id}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 shadow-sm transition hover:border-zinc-400 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-500 dark:hover:bg-zinc-800"
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              className="shrink-0 text-zinc-600 dark:text-zinc-400"
              fill="currentColor"
              aria-hidden
            >
              <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.07.63-.07.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
            </svg>
            הגדרות
          </button>
        </div>
      </div>

      {workerInviteLinkDialog ? (
        <div className="fixed inset-0 z-[84] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-2xl border bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
            <div className="space-y-2 text-center">
              <h3 className="text-lg font-semibold">העתק את הלינק לעובד</h3>
              <p className="text-sm text-zinc-500">אפשר להעתיק את הלינק ולשלוח אותו לעובד</p>
            </div>
            <div className="mt-4 break-all rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-950">
              {workerInviteLinkDialog}
            </div>
            <div className="mt-5 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setWorkerInviteLinkDialog(null)}
                className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                סגור
              </button>
              <button
                type="button"
                onClick={async () => {
                  const copied = await copyTextWithFallback(workerInviteLinkDialog || "");
                  if (copied) toast.success("הלינק הועתק");
                  else toast.error("לא ניתן להעתיק את הלינק אוטומטית");
                }}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
              >
                העתק
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

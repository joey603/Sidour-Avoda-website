"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import LoadingAnimation from "@/components/loading-animation";
import { fetchMe } from "@/lib/auth";
import { apiFetch } from "@/lib/api";

type WorkerInviteMeta = {
  site_id: number;
  site_name: string;
  director_name: string;
};

export default function WorkerInvitePage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = String(params?.token || "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteMeta, setInviteMeta] = useState<WorkerInviteMeta | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<WorkerInviteMeta>(`/public/sites/invitations/${encodeURIComponent(token)}`);
        if (cancelled) return;
        setInviteMeta(data);
        const me = await fetchMe();
        if (cancelled) return;
        if (me?.role === "worker") {
          await apiFetch("/public/sites/invitations/claim", {
            method: "POST",
            body: JSON.stringify({ token }),
          });
          router.replace("/worker/availability");
          return;
        }
      } catch (e: any) {
        if (cancelled) return;
        setError(String(e?.message || "Lien d'invitation invalide"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, token]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <LoadingAnimation size={80} />
      </div>
    );
  }

  if (error || !inviteMeta) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h1 className="text-xl font-semibold">הזמנה לא תקינה</h1>
          <p className="mt-3 text-sm text-red-600">{error || "לא ניתן לפתוח את ההזמנה."}</p>
        </div>
      </div>
    );
  }

  const loginHref = `/login/worker?returnUrl=${encodeURIComponent("/worker/availability")}`;
  const registerHref = `/register/worker?inviteToken=${encodeURIComponent(token)}`;

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold">הזמנה לעובד</h1>
          <p className="text-sm text-zinc-500">
            {inviteMeta.director_name} הזמין אותך להצטרף לאתר {inviteMeta.site_name}
          </p>
        </div>

        <div className="mt-6 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <div>אתר: {inviteMeta.site_name}</div>
        </div>

        <div className="mt-6 flex flex-col gap-3">
          <Link
            href={registerHref}
            className="inline-flex items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            הגדרת סיסמה והפעלת חשבון
          </Link>
          <Link
            href={loginHref}
            className="inline-flex items-center justify-center rounded-md border border-zinc-300 px-4 py-2 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            כבר יש לי חשבון
          </Link>
        </div>
      </div>
    </div>
  );
}

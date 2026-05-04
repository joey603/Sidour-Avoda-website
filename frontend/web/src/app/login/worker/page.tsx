"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiFetch, apiFetchWithRetry } from "@/lib/api";
import { fetchMe, logout } from "@/lib/auth";
import LoadingAnimation from "@/components/loading-animation";

type WorkerInviteMeta = {
  site_id: number;
  site_name: string;
  director_name: string;
};

function WorkerLoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [inviteMeta, setInviteMeta] = useState<WorkerInviteMeta | null>(null);
  const inviteToken = searchParams?.get("inviteToken");
  const prefilledPhone = searchParams?.get("phone");

  function safeWorkerReturnUrl(raw: string | null): string | null {
    const s = String(raw || "").trim();
    if (!s) return null;
    if (s.startsWith("/login")) return null;
    // Autoriser worker dashboard + la page publique de registration worker
    if (s.startsWith("/worker") || s.startsWith("/public/workers")) return s;
    return null;
  }

  const returnUrl = searchParams?.get("returnUrl");
  const existingTarget = useMemo(() => safeWorkerReturnUrl(returnUrl) || "/worker", [returnUrl]);
  const didAutoRedirect = useRef(false);

  useEffect(() => {
    if (!prefilledPhone) return;
    setPhone(prefilledPhone);
  }, [prefilledPhone]);

  useEffect(() => {
    let cancelled = false;
    if (!inviteToken) {
      setInviteMeta(null);
      return;
    }
    (async () => {
      try {
        const data = await apiFetch<WorkerInviteMeta>(`/public/sites/invitations/${encodeURIComponent(inviteToken)}`);
        if (cancelled) return;
        setInviteMeta(data);
      } catch {
        if (cancelled) return;
        setError("Lien d'invitation invalide ou expiré.");
        setInviteMeta(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await fetchMe();
      if (cancelled) return;
      if (me?.role === "worker" && !didAutoRedirect.current) {
        didAutoRedirect.current = true;
        router.replace(existingTarget);
        return;
      }
      if (me?.role === "director") {
        setError("אתה מחובר כמנהל. כדי להתחבר כעובד, התנתק קודם.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [existingTarget, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus(null);
    setLoading(true);
    try {
      await apiFetchWithRetry<{ access_token: string }>(
        "/auth/worker-login",
        {
          method: "POST",
          body: JSON.stringify({ phone, password }),
        },
        {
          timeoutMs: 15_000,
          maxTotalMs: 90_000,
          onRetry: ({ attempt }) => {
            setStatus(`השרת מתעורר... ניסיון ${attempt}`);
          },
        },
      );
      const me = await fetchMe();
      if (me?.role !== "worker") {
        await logout();
        setError("חשבון זה אינו לעובד. נא להתחבר כעובד.");
        return;
      }
      const target = safeWorkerReturnUrl(searchParams?.get("returnUrl")) || "/worker";
      router.replace(target);
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (msg.toLowerCase().includes("timeout")) {
        setError("השרת לא זמין כרגע. נסו שוב בעוד רגע.");
      } else {
        setError("שגיאת התחברות. בדקו את מספר הטלפון והסיסמה.");
      }
    } finally {
      setLoading(false);
      setStatus(null);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4">
          <h1 className="text-2xl font-semibold">התחברות עובד</h1>
          {inviteMeta && (
            <p className="mt-2 text-sm text-zinc-500">
              הזמנה לאתר {inviteMeta.site_name}
            </p>
          )}
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="worker-phone" className="block text-sm">מספר טלפון</label>
            <input
              id="worker-phone"
              dir="ltr"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              required
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="worker-password" className="block text-sm">סיסמה</label>
            <input
              id="worker-password"
              dir="ltr"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              required
              minLength={8}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {status && !error && <p className="text-sm text-zinc-500">{status}</p>}
          <button
            type="submit"
            disabled={loading}
            className="inline-flex w-full items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {loading ? "מתחבר..." : "התחבר"}
          </button>
          {inviteToken && (
            <p className="text-center text-sm text-zinc-500">
              אין לך חשבון עדיין?{" "}
              <Link
                href={`/register/worker?inviteToken=${encodeURIComponent(inviteToken)}`}
                className="underline underline-offset-2"
              >
                הפעלת חשבון והגדרת סיסמה
              </Link>
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

export default function WorkerLoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center p-6"><LoadingAnimation size={80} /></div>}>
      <WorkerLoginInner />
    </Suspense>
  );
}


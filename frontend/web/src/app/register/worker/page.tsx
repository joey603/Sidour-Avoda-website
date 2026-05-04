"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import LoadingAnimation from "@/components/loading-animation";
import { apiFetch } from "@/lib/api";

type WorkerInviteMeta = {
  site_id: number;
  site_name: string;
  director_name: string;
};

type WorkerInviteRegistrationOut = {
  ok: boolean;
  already_exists: boolean;
  site_id: number;
  site_name: string;
  phone: string;
};

function WorkerRegisterPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inviteToken = String(searchParams?.get("inviteToken") || "");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteMeta, setInviteMeta] = useState<WorkerInviteMeta | null>(null);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!inviteToken) {
      setError("יש צורך בלינק הזמנה תקף כדי להירשם.");
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const data = await apiFetch<WorkerInviteMeta>(`/public/sites/invitations/${encodeURIComponent(inviteToken)}`);
        if (cancelled) return;
        setInviteMeta(data);
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
  }, [inviteToken]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    if (password !== passwordConfirm) {
      setError("הסיסמאות אינן תואמות.");
      setSubmitting(false);
      return;
    }
    try {
      const result = await apiFetch<WorkerInviteRegistrationOut>("/public/sites/invitations/register", {
        method: "POST",
        body: JSON.stringify({
          token: inviteToken,
          full_name: fullName,
          phone,
          password,
        }),
      });
      const target = `/login/worker?phone=${encodeURIComponent(result.phone)}&returnUrl=${encodeURIComponent("/worker/availability")}`;
      router.replace(target);
    } catch (e: any) {
      setError(String(e?.message || "הרשמה נכשלה"));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <LoadingAnimation size={80} />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 space-y-2 text-center">
          <h1 className="text-2xl font-semibold">הרשמת עובד</h1>
          {inviteMeta && (
            <p className="text-sm text-zinc-500">
              הרשמה לאתר {inviteMeta.site_name}
            </p>
          )}
        </div>

        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="worker-register-full-name" className="block text-sm">שם פרטי ושם משפחה</label>
            <input
              id="worker-register-full-name"
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              required
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="worker-register-phone" className="block text-sm">מספר טלפון</label>
            <input
              id="worker-register-phone"
              type="tel"
              dir="ltr"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              required
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="worker-register-password" className="block text-sm">סיסמה</label>
            <input
              id="worker-register-password"
              type="password"
              dir="ltr"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              required
              minLength={8}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="worker-register-password-confirm" className="block text-sm">אישור סיסמה</label>
            <input
              id="worker-register-password-confirm"
              type="password"
              dir="ltr"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              required
              minLength={8}
            />
          </div>
          <button
            type="submit"
            disabled={submitting || !inviteToken}
            className="inline-flex w-full items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {submitting ? "מפעיל חשבון..." : "הגדר סיסמה והמשך"}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-zinc-500">
          כבר הופעל לך חשבון?{" "}
          <Link
            href={`/login/worker?inviteToken=${encodeURIComponent(inviteToken)}&returnUrl=${encodeURIComponent("/worker/availability")}`}
            className="underline underline-offset-2"
          >
            התחבר כאן
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function WorkerRegisterPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center p-6">
          <LoadingAnimation size={80} />
        </div>
      }
    >
      <WorkerRegisterPageContent />
    </Suspense>
  );
}

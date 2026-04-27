"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiFetch, apiFetchWithRetry } from "@/lib/api";
import { fetchMe, getRoleFromToken, isTokenExpired, setToken, getToken, clearToken } from "@/lib/auth";
import LoadingAnimation from "@/components/loading-animation";

type WorkerInviteMeta = {
  site_id: number;
  site_name: string;
  director_name: string;
  director_code: string;
};

function WorkerLoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
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
  const decodedRole = getRoleFromToken(getToken());
  const existingTarget = useMemo(() => safeWorkerReturnUrl(returnUrl) || "/worker", [returnUrl]);
  const [validatedRole, setValidatedRole] = useState<"worker" | "director" | null>(null);
  const didAutoRedirect = useRef(false);

  useEffect(() => {
    // IMPORTANT: ne pas auto-rediriger depuis la page de login (évite les boucles / clignotements).
    // Exception: si un directeur arrive ici via /public/workers, on nettoie le token pour permettre la connexion worker.
    if (decodedRole === "director" && (returnUrl?.includes("/public/workers") || !!inviteToken)) {
      clearToken();
      setError(null);
      return;
    }
    if (decodedRole === "director") {
      setError("אתה מחובר כמנהל. כדי להתחבר כעובד, התחבר עם פרטי עובד.");
    }
  }, [decodedRole, inviteToken, returnUrl]);

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
        if (data.director_code) setCode((prev) => prev || data.director_code);
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
    const token = getToken();
    if (!token) {
      setValidatedRole(null);
      return;
    }
    if (isTokenExpired(token)) {
      clearToken();
      setValidatedRole(null);
      return;
    }
    (async () => {
      const me = await fetchMe();
      if (cancelled) return;
      setValidatedRole(me?.role || null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (didAutoRedirect.current) return;
    if (validatedRole !== "worker") return;
    didAutoRedirect.current = true;
    (async () => {
      try {
        if (inviteToken) {
          const token = getToken();
          if (token) {
            await apiFetch("/public/sites/invitations/claim", {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
              body: JSON.stringify({ token: inviteToken }),
            });
          }
        }
      } catch {
        // Ignorer pour ne pas bloquer l'accès worker si le claim a déjà été fait.
      } finally {
    router.replace(existingTarget);
      }
    })();
  }, [existingTarget, inviteToken, router, validatedRole]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus(null);
    setLoading(true);
    try {
      const prevToken = getToken();
      const data = await apiFetchWithRetry<{ access_token: string }>(
        "/auth/worker-login",
        {
          method: "POST",
          body: JSON.stringify({ code, phone, invite_token: inviteToken || undefined }),
        },
        {
          timeoutMs: 15_000,
          maxTotalMs: 90_000,
          onRetry: ({ attempt }) => {
            setStatus(`השרת מתעורר... ניסיון ${attempt}`);
          },
        },
      );
      setToken(data.access_token);
      const role = getRoleFromToken(data.access_token);
      if (role !== "worker") {
        setError("חשבון זה אינו לעובד. נא להתחבר כעובד.");
        // Restaurer le token précédent (ex: directeur déjà connecté), sinon nettoyer
        if (prevToken) setToken(prevToken);
        else clearToken();
        return;
      }
      const target = safeWorkerReturnUrl(searchParams?.get("returnUrl")) || "/worker";
      router.replace(target);
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (msg.toLowerCase().includes("timeout")) {
        setError("השרת לא זמין כרגע. נסו שוב בעוד רגע.");
      } else {
        setError("שגיאת התחברות. בדקו את הקוד ומספר הטלפון.");
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
            <label className="block text-sm">קוד מנהל</label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              required
            />
          </div>
          <div className="space-y-2">
            <label className="block text-sm">מספר טלפון</label>
            <input
              dir="ltr"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              required
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
                הרשמה לעובד
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


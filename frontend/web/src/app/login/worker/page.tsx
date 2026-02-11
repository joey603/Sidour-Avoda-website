"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetchWithRetry } from "@/lib/api";
import { fetchMe, setToken, getToken, clearToken } from "@/lib/auth";
import LoadingAnimation from "@/components/loading-animation";

function WorkerLoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const returnUrl = searchParams?.get("returnUrl");
    
    const token = getToken();
    if (token) {
      fetchMe().then((me) => {
        if (!me) return;
        if (me.role !== "worker") {
          // Si l'utilisateur est un directeur, déconnecter pour permettre la connexion avec un compte worker
          if (returnUrl?.includes("/public/workers")) {
            clearToken();
            return;
          }
          // IMPORTANT: ne pas rediriger vers le menu directeur.
          // On reste sur cette page pour laisser l'utilisateur corriger sa connexion.
          setError("אתה מחובר כמנהל. כדי להתחבר כעובד, התחבר עם פרטי עובד.");
          return;
        }
        // Si le returnUrl nécessite un worker et que l'utilisateur est un worker, rediriger
        if (returnUrl?.includes("/public/workers")) {
          router.replace(returnUrl);
        } else {
          router.replace(returnUrl || "/worker");
        }
      });
    }
  }, [router, searchParams]);

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
          body: JSON.stringify({ code, phone }),
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
      const me = await fetchMe();
      if (me) {
        if (me.role !== "worker") {
          setError("חשבון זה אינו לעובד. נא להתחבר כעובד.");
          // Restaurer le token précédent (ex: directeur déjà connecté), sinon nettoyer
          if (prevToken) setToken(prevToken);
          else clearToken();
          setLoading(false);
          return;
        }
        const returnUrl = searchParams?.get("returnUrl");
        if (returnUrl?.includes("/public/workers")) {
          router.replace(returnUrl);
        } else {
          router.replace(returnUrl || "/worker");
        }
      }
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


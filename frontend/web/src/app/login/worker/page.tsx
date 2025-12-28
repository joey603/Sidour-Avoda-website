"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { fetchMe, setToken, getToken, clearToken } from "@/lib/auth";

function WorkerLoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
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
          router.replace("/login/director");
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
    setLoading(true);
    try {
      const data = await apiFetch<{ access_token: string }>("/auth/worker-login", {
        method: "POST",
        body: JSON.stringify({ name, phone }),
      });
      setToken(data.access_token);
      const me = await fetchMe();
      if (me) {
        if (me.role !== "worker") {
          setError("חשבון זה אינו לעובד. נא להתחבר כעובד.");
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
      setError("שגיאת התחברות. בדקו את השם ומספר הטלפון.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">התחברות עובד</h1>
          <button
            type="button"
            onClick={() => {
              const returnUrl = searchParams?.get("returnUrl");
              const directorUrl = returnUrl 
                ? `/login/director?returnUrl=${encodeURIComponent(returnUrl)}`
                : "/login/director";
              router.push(directorUrl);
            }}
            className="text-sm text-blue-600 hover:underline"
          >
            התחברות מנהל
          </button>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="block text-sm">שם</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
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
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center p-6"><p className="text-lg">טוען...</p></div>}>
      <WorkerLoginInner />
    </Suspense>
  );
}


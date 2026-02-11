"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiFetchWithRetry } from "@/lib/api";
import { fetchMe, getRoleFromToken, isTokenExpired, setToken, getToken, clearToken } from "@/lib/auth";
import LoadingAnimation from "@/components/loading-animation";

function DirectorLoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function safeDirectorReturnUrl(raw: string | null): string | null {
    const s = String(raw || "").trim();
    if (!s) return null;
    // Empêcher les boucles / écrans de login
    if (s.startsWith("/login")) return null;
    // Interdire les pages worker-only
    if (s.startsWith("/worker") || s.startsWith("/public/workers")) return null;
    // Autoriser uniquement l'espace directeur
    if (s.startsWith("/director")) return s;
    return null;
  }

  // Ne pas auto-rediriger depuis la page de login (évite les boucles).
  // On redirige seulement si /me confirme que le token est valide (avec garde-fou anti-boucle).
  const [validatedRole, setValidatedRole] = useState<"worker" | "director" | null>(null);
  const didAutoRedirect = useRef(false);

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

  const existingTarget = useMemo(() => {
    const returnUrl = safeDirectorReturnUrl(searchParams?.get("returnUrl"));
    return returnUrl || "/director";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    if (didAutoRedirect.current) return;
    if (validatedRole !== "director") return;
    didAutoRedirect.current = true;
    router.replace(existingTarget);
  }, [existingTarget, router, validatedRole]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus(null);
    setLoading(true);
    try {
      const prevToken = getToken();
      const data = await apiFetchWithRetry<{ access_token: string }>(
        "/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ email, password }),
        },
        {
          timeoutMs: 15_000,
          maxTotalMs: 90_000,
          onRetry: ({ attempt }) => {
            // Render free: réveil du serveur. Garder les identifiants dans les champs.
            setStatus(`השרת מתעורר... ניסיון ${attempt}`);
          },
        },
      );
      setToken(data.access_token);
      const role = getRoleFromToken(data.access_token);
      if (role !== "director") {
        setError("חשבון זה אינו למנהל. נא להתחבר כמנהל.");
        // Restaurer le token précédent (ex: worker déjà connecté), sinon nettoyer
        if (prevToken) setToken(prevToken);
        else clearToken();
        return;
      }
      const returnUrl = safeDirectorReturnUrl(searchParams?.get("returnUrl"));
      router.replace(returnUrl || "/director");
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (msg.toLowerCase().includes("timeout")) {
        setError("השרת לא זמין כרגע. נסו שוב בעוד רגע.");
      } else {
        setError("שגיאת התחברות. בדקו את הפרטים.");
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
          <h1 className="text-2xl font-semibold">התחברות מנהל</h1>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="block text-sm">אימייל</label>
            <input
              dir="ltr"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              required
            />
          </div>
          <div className="space-y-2">
            <label className="block text-sm">סיסמה</label>
            <input
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
          {error && (
            <div className="text-sm">
              <Link className="underline decoration-dotted text-zinc-700 dark:text-zinc-200" href="/login/worker">
                מעבר להתחברות עובד
              </Link>
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="inline-flex w-full items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {loading ? "מתחבר..." : "התחבר"}
          </button>
        </form>
        {/* Inscription désactivée: seuls les directeurs créent les comptes */}
      </div>
    </div>
  );
}

export default function DirectorLoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center p-6"><LoadingAnimation size={80} /></div>}>
      <DirectorLoginInner />
    </Suspense>
  );
}


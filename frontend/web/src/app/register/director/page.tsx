"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";

function DirectorRegisterInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiFetch("/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, full_name: fullName, password, role: "director" }),
      });
      const returnUrl = searchParams?.get("returnUrl");
      if (returnUrl) {
        router.replace(`/login/director?returnUrl=${encodeURIComponent(returnUrl)}`);
      } else {
        router.replace("/login/director");
      }
    } catch (err: any) {
      setError("שגיאת הרשמה. יתכן והאימייל כבר בשימוש.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">הרשמה מנהל</h1>
          <button
            type="button"
            onClick={() => {
              const returnUrl = searchParams?.get("returnUrl");
              const workerUrl = returnUrl 
                ? `/register/worker?returnUrl=${encodeURIComponent(returnUrl)}`
                : "/register/worker";
              router.push(workerUrl);
            }}
            className="text-sm text-blue-600 hover:underline"
          >
            הרשמה עובד
          </button>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="block text-sm">שם מלא</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              required
            />
          </div>
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
          <button
            type="submit"
            disabled={loading}
            className="inline-flex w-full items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {loading ? "נרשם..." : "הרשמה"}
          </button>
        </form>
        <div className="mt-4 text-sm">
          כבר יש לכם חשבון? {" "}
          <button
            onClick={() => {
              const returnUrl = searchParams?.get("returnUrl");
              const loginUrl = returnUrl 
                ? `/login/director?returnUrl=${encodeURIComponent(returnUrl)}`
                : "/login/director";
              router.push(loginUrl);
            }}
            className="text-blue-600 hover:underline"
          >
            התחברו
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DirectorRegisterPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center p-6"><p className="text-lg">טוען...</p></div>}>
      <DirectorRegisterInner />
    </Suspense>
  );
}


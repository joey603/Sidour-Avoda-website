"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { fetchMe, setToken, getToken } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (token) {
      fetchMe().then((me) => {
        if (!me) return;
        router.replace(me.role === "director" ? "/director" : "/worker");
      });
    }
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await apiFetch<{ access_token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setToken(data.access_token);
      const me = await fetchMe();
      router.replace(me?.role === "director" ? "/director" : "/worker");
    } catch (err: any) {
      setError("שגיאת התחברות. בדקו את הפרטים.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="mb-6 text-2xl font-semibold">התחברות</h1>
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
          <button
            type="submit"
            disabled={loading}
            className="inline-flex w-full items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {loading ? "מתחבר..." : "התחבר"}
          </button>
        </form>
        <div className="mt-4 text-sm">
          אין לכם חשבון?{" "}
          <button
            onClick={() => router.push("/register")}
            className="text-blue-600 hover:underline"
          >
            הרשמה
          </button>
        </div>
      </div>
    </div>
  );
}



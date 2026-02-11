"use client";

import { apiFetchWithRetry } from "./api";

const TOKEN_KEY = "access_token";

export function setToken(token: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(TOKEN_KEY, token);
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
}

export async function fetchMe() {
  const token = getToken();
  if (!token) return null;
  try {
    return await apiFetchWithRetry<{ id: number; email: string; role: "worker" | "director"; full_name: string; director_code?: string | null; directorCode?: string | null }>(
      "/me",
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      } as any,
      {
        // Render free wake: /me peut échouer 30-60s après login
        timeoutMs: 12_000,
        maxTotalMs: 60_000,
      },
    );
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg.includes("401")) {
      // token invalide/expiré → forcer reconnexion
      clearToken();
      return null;
    }
    return null;
  }
}



"use client";

import { apiFetchWithRetry } from "./api";

const TOKEN_KEY = "access_token";

type Role = "worker" | "director";

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

function decodeJwtPayload(token: string | null): Record<string, unknown> | null {
  try {
    const t = String(token || "").trim();
    if (!t) return null;
    const parts = t.split(".");
    if (parts.length < 2) return null;
    const payloadB64 = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const json = atob(payloadB64);
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function getRoleFromToken(token: string | null): Role | null {
  const payload = decodeJwtPayload(token);
  const role = String(payload?.role || "").trim();
  return role === "worker" || role === "director" ? (role as Role) : null;
}

export function isTokenExpired(token: string | null, skewSeconds = 30): boolean {
  const payload = decodeJwtPayload(token);
  const expRaw = payload?.exp;
  const expSeconds = typeof expRaw === "number" ? expRaw : Number(expRaw);
  if (!Number.isFinite(expSeconds)) return false; // pas de exp → on ne suppose pas expiré
  const nowSeconds = Date.now() / 1000;
  return nowSeconds >= expSeconds - skewSeconds;
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



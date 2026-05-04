"use client";

import { apiFetch, apiFetchWithRetry } from "./api";

const TOKEN_KEY = "access_token";

type Role = "worker" | "director";

export type AuthMe = {
  id: number;
  email: string | null;
  role: Role;
  full_name: string;
  director_code?: string | null;
  directorCode?: string | null;
};

export const AUTH_SESSION_CHANGED_EVENT = "auth-session-changed";

export function notifyAuthSessionChanged() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(AUTH_SESSION_CHANGED_EVENT));
  } catch {
    // ignore
  }
}

export function setToken(_token: string) {
  if (typeof window === "undefined") return;
  // Compat legacy: on ne persiste plus le JWT côté navigateur.
  localStorage.removeItem(TOKEN_KEY);
  notifyAuthSessionChanged();
}

export function getToken(): string | null {
  return null;
}

export function clearToken() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  notifyAuthSessionChanged();
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
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  const role = String(payload?.role || "").trim();
  return role === "worker" || role === "director" ? (role as Role) : null;
}

export function isTokenExpired(token: string | null, skewSeconds = 30): boolean {
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  const expRaw = payload?.exp;
  const expSeconds = typeof expRaw === "number" ? expRaw : Number(expRaw);
  if (!Number.isFinite(expSeconds)) return false; // pas de exp → on ne suppose pas expiré
  const nowSeconds = Date.now() / 1000;
  return nowSeconds >= expSeconds - skewSeconds;
}

export async function fetchMe(): Promise<AuthMe | null> {
  try {
    return await apiFetchWithRetry<AuthMe>(
      "/me",
      {
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

export async function logout() {
  try {
    await apiFetch("/auth/logout", {
      method: "POST",
    });
  } catch {
    // ignore: le cookie peut déjà être expiré côté serveur
  } finally {
    clearToken();
  }
}



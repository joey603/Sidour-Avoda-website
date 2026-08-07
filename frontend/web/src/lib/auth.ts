"use client";

import { apiFetch, apiFetchWithRetry } from "./api";

/** Clé legacy — plus utilisée pour l’auth (cookie HttpOnly). Conservée pour nettoyer d’anciens restes. */
const LEGACY_TOKEN_KEY = "access_token";
const ME_SESSION_KEY = "sidour_me_cache_v1";
/** Cache court : TopNav + pages partagent le même /me sans refetch. */
const ME_CACHE_TTL_MS = 90_000;

type Role = "worker" | "director";

export type AuthMe = {
  id: number;
  email: string | null;
  role: Role;
  full_name: string;
  phone?: string | null;
  director_code?: string | null;
  directorCode?: string | null;
};

type MeCacheEntry = {
  me: AuthMe;
  at: number;
};

export const AUTH_SESSION_CHANGED_EVENT = "auth-session-changed";

let memoryMeCache: MeCacheEntry | null = null;
let meInFlight: Promise<AuthMe | null> | null = null;
let meBackgroundRefresh: Promise<AuthMe | null> | null = null;

export function notifyAuthSessionChanged() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(AUTH_SESSION_CHANGED_EVENT));
  } catch {
    // ignore
  }
}

function readSessionMeCache(): MeCacheEntry | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(ME_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { me?: AuthMe; at?: number };
    if (!parsed?.me || typeof parsed.me !== "object") return null;
    const role = String(parsed.me.role || "");
    if (role !== "worker" && role !== "director") return null;
    const at = Number(parsed.at || 0);
    if (!Number.isFinite(at) || at <= 0) return null;
    return { me: parsed.me, at };
  } catch {
    return null;
  }
}

function writeSessionMeCache(entry: MeCacheEntry | null) {
  if (typeof window === "undefined") return;
  try {
    if (!entry) {
      sessionStorage.removeItem(ME_SESSION_KEY);
      return;
    }
    sessionStorage.setItem(ME_SESSION_KEY, JSON.stringify(entry));
  } catch {
    // ignore
  }
}

function setMeCache(me: AuthMe | null) {
  if (!me) {
    memoryMeCache = null;
    writeSessionMeCache(null);
    return;
  }
  const entry = { me, at: Date.now() };
  memoryMeCache = entry;
  writeSessionMeCache(entry);
}

function getFreshCachedMe(now = Date.now()): AuthMe | null {
  if (memoryMeCache && now - memoryMeCache.at < ME_CACHE_TTL_MS) {
    return memoryMeCache.me;
  }
  const session = readSessionMeCache();
  if (session && now - session.at < ME_CACHE_TTL_MS) {
    memoryMeCache = session;
    return session.me;
  }
  return null;
}

/** Lecture synchrone du cache (UI instantanée si déjà connecté dans l’onglet). */
export function peekCachedMe(): AuthMe | null {
  if (memoryMeCache) return memoryMeCache.me;
  const session = readSessionMeCache();
  if (session) {
    memoryMeCache = session;
    return session.me;
  }
  return null;
}

function clearMeCache() {
  memoryMeCache = null;
  meInFlight = null;
  meBackgroundRefresh = null;
  writeSessionMeCache(null);
}

/** @deprecated Auth = cookie HttpOnly via apiFetch(credentials: include). Ne persiste plus de JWT. */
export function setToken(_token: string) {
  clearToken();
}

/** @deprecated Toujours null — la session vit dans le cookie, pas dans localStorage. */
export function getToken(): string | null {
  return null;
}

/** Efface d’éventuels restes localStorage + notifie l’UI (après logout / 401). */
export function clearToken() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    // ignore
  }
  clearMeCache();
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

/** @deprecated Préférer fetchMe() — plus de JWT côté client. */
export function getRoleFromToken(token: string | null): Role | null {
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  const role = String(payload?.role || "").trim();
  return role === "worker" || role === "director" ? (role as Role) : null;
}

/** @deprecated Préférer fetchMe() — plus de JWT côté client. */
export function isTokenExpired(token: string | null, skewSeconds = 30): boolean {
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  const expRaw = payload?.exp;
  const expSeconds = typeof expRaw === "number" ? expRaw : Number(expRaw);
  if (!Number.isFinite(expSeconds)) return false;
  const nowSeconds = Date.now() / 1000;
  return nowSeconds >= expSeconds - skewSeconds;
}

async function fetchMeFromNetwork(opts?: { soft?: boolean }): Promise<AuthMe | null> {
  try {
    return await apiFetchWithRetry<AuthMe>(
      "/me",
      {
        cache: "no-store",
      } as RequestInit,
      opts?.soft
        ? {
            // Revalidation douce : pas besoin d’attendre un wake Render 60s.
            timeoutMs: 8_000,
            maxTotalMs: 12_000,
          }
        : {
            // Premier contact / login : Render free wake peut prendre 30-60s.
            timeoutMs: 12_000,
            maxTotalMs: 60_000,
          },
    );
  } catch (e: unknown) {
    const msg = String((e as Error)?.message || "");
    if (msg.includes("401")) {
      clearToken();
      return null;
    }
    return null;
  }
}

function refreshMeInBackground() {
  if (meBackgroundRefresh || meInFlight) return;
  meBackgroundRefresh = (async () => {
    const me = await fetchMeFromNetwork({ soft: true });
    if (me) setMeCache(me);
    else if (me === null) {
      // soft null sans 401 (réseau) : garder le cache existant
    }
    return me;
  })().finally(() => {
    meBackgroundRefresh = null;
  });
}

/**
 * Session courante via cookie HttpOnly.
 * - Cache mémoire + sessionStorage (TTL) pour TopNav / pages sans refetch.
 * - Déduplique les appels /me en vol.
 * - `force: true` après login pour ignorer le cache.
 */
export async function fetchMe(opts?: { force?: boolean }): Promise<AuthMe | null> {
  if (!opts?.force) {
    const cached = getFreshCachedMe();
    if (cached) {
      refreshMeInBackground();
      return cached;
    }
    if (meInFlight) return meInFlight;
  }

  const request = (async () => {
    const me = await fetchMeFromNetwork({ soft: false });
    if (me) setMeCache(me);
    else if (opts?.force) setMeCache(null);
    return me;
  })();

  if (!opts?.force) {
    meInFlight = request.finally(() => {
      if (meInFlight === request) meInFlight = null;
    });
    return meInFlight;
  }

  return request;
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

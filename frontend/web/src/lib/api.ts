export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
import { clearToken } from "./auth";

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type") && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const contentType = res.headers.get("content-type");
    let message = `HTTP ${res.status}`;
    if (contentType && contentType.includes("application/json")) {
      try {
        const data = await res.json();
        if (typeof data?.detail === "string") message = data.detail;
        else if (data) message = JSON.stringify(data);
      } catch {
        // ignore
      }
    } else {
      try {
        const text = await res.text();
        if (text) message = text;
      } catch {
        // ignore
      }
    }
    // Redirection globale si non autorisé
    if (res.status === 401) {
      try { clearToken(); } catch {}
      // IMPORTANT:
      // - Ne pas rediriger lors des endpoints d'auth (login) : on veut afficher l'erreur sur place.
      // - Sinon, rediriger vers la page de login adaptée (worker vs director) selon l'URL courante.
      if (typeof window !== "undefined") {
        const p = String(path || "");
        const isAuthEndpoint = p.startsWith("/auth/");
        if (!isAuthEndpoint) {
          try {
            const cur = window.location.pathname + window.location.search;
            const isWorkerArea =
              window.location.pathname.startsWith("/worker") ||
              window.location.pathname.startsWith("/login/worker") ||
              window.location.pathname.startsWith("/register/worker") ||
              window.location.pathname.startsWith("/public/workers");
            const target = isWorkerArea
              ? `/login/worker?returnUrl=${encodeURIComponent(cur)}`
              : `/login/director?returnUrl=${encodeURIComponent(cur)}`;
            window.location.href = target;
          } catch {
        try { window.location.href = "/login/director"; } catch {}
          }
        }
      }
    }
    const err: any = new Error(message);
    err.status = res.status;
    throw err;
  }
  const contentType = res.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as T;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export type ApiFetchRetryState = {
  attempt: number;
  elapsedMs: number;
  nextDelayMs: number;
  message: string;
};

export type ApiFetchRetryOptions = {
  /** Timeout par tentative (ms). */
  timeoutMs?: number;
  /** Durée max totale de retry (ms). */
  maxTotalMs?: number;
  /** Délai initial (ms). */
  initialDelayMs?: number;
  /** Délai max (ms). */
  maxDelayMs?: number;
  /** Callback UI (ex: afficher "serveur en réveil"). */
  onRetry?: (state: ApiFetchRetryState) => void;
};

function isRetryableError(err: any): boolean {
  const name = String(err?.name || "");
  if (name === "AbortError") return true;
  const status = Number(err?.status || 0);
  if (status === 502 || status === 503 || status === 504) return true;
  // Erreurs réseau (fetch) => TypeError sans status
  if (!status && err && (err instanceof TypeError || String(err?.message || "").toLowerCase().includes("failed to fetch"))) return true;
  return false;
}

/**
 * Utile pour Render (free) qui "dort": on timeout + retry jusqu'à ce que le serveur soit réveillé,
 * sans forcer l'utilisateur à recharger la page / retaper ses identifiants.
 */
export async function apiFetchWithRetry<T>(
  path: string,
  options: RequestInit = {},
  retry: ApiFetchRetryOptions = {},
): Promise<T> {
  const timeoutMs = Math.max(1_000, Number(retry.timeoutMs ?? 15_000));
  const maxTotalMs = Math.max(timeoutMs, Number(retry.maxTotalMs ?? 90_000));
  let delayMs = Math.max(200, Number(retry.initialDelayMs ?? 1_000));
  const maxDelayMs = Math.max(delayMs, Number(retry.maxDelayMs ?? 8_000));
  const started = Date.now();
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    const elapsedMs = Date.now() - started;
    if (elapsedMs > maxTotalMs) {
      const e: any = new Error("Timeout: serveur indisponible");
      e.status = 0;
      throw e;
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => {
      try {
        ctrl.abort();
      } catch {}
    }, timeoutMs);
    try {
      return await apiFetch<T>(path, { ...options, signal: ctrl.signal });
    } catch (err: any) {
      if (!isRetryableError(err)) throw err;
      const nextDelayMs = Math.min(maxDelayMs, delayMs);
      retry.onRetry?.({
        attempt,
        elapsedMs,
        nextDelayMs,
        message: "Serveur en cours de démarrage…",
      });
      // backoff (avec léger jitter)
      const jitter = Math.floor(Math.random() * 250);
      await sleep(nextDelayMs + jitter);
      delayMs = Math.min(maxDelayMs, Math.floor(delayMs * 1.7));
    } finally {
      clearTimeout(t);
    }
  }
}



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



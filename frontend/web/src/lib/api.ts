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
      if (typeof window !== "undefined") {
        try { window.location.href = "/login"; } catch {}
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
  // @ts-expect-error allow text responses
  return (await res.text()) as T;
}



"use client";

import { useEffect } from "react";

const TOKEN_KEY = "access_token";
const SESSION_VERSION_KEY = "sidour_session_version";
const SESSION_VERSION = process.env.NEXT_PUBLIC_SESSION_VERSION || "2026-04-23-1";

export default function AuthSessionVersionGuard() {
  useEffect(() => {
    try {
      const previousVersion = localStorage.getItem(SESSION_VERSION_KEY);
      if (previousVersion !== SESSION_VERSION) {
        // Nettoyage legacy: l'auth ne persiste plus le JWT côté navigateur.
        localStorage.removeItem(TOKEN_KEY);
        localStorage.setItem(SESSION_VERSION_KEY, SESSION_VERSION);
      }
    } catch {
      // Ignore storage errors (private mode, blocked storage, etc.)
    }
  }, []);

  return null;
}


"use client";

import { useEffect } from "react";
import { clearAllPlanningSessionCaches } from "@/lib/planning-session-cache";

/** Sur pagehide (fermeture onglet / nav pleine page), purge les caches session planning. */
export function usePlanningV2SessionLifecycle() {
  useEffect(() => {
    const onPageHide = (e: PageTransitionEvent) => {
      if (e.persisted) return;
      clearAllPlanningSessionCaches();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);
}

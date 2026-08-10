"use client";

import { Suspense } from "react";
import LoadingAnimation, { LoadingOverlay } from "@/components/loading-animation";
import { PlanningV2Page } from "@/components/planning-v2/planning-v2-page";

/**
 * URL canonique du planning directeur : `/director/planning/[id]` (implémentation v2).
 *
 * Alias historiques (même page) : `/director/planning-v2/[id]`, `/director/planning-modular/[id]`.
 */
export default function DirectorPlanningSitePage() {
  return (
    <Suspense
      fallback={<LoadingOverlay />}
    >
      <PlanningV2Page />
    </Suspense>
  );
}

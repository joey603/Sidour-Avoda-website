"use client";

import { Suspense } from "react";
import LoadingAnimation, { LoadingOverlay } from "@/components/loading-animation";
import { PlanningV2Page } from "@/components/planning-v2/planning-v2-page";

/**
 * Route publique : Planning v2 uniquement.
 *
 * L’ancienne page planning complète n’a pas été supprimée du dépôt : elle reste dans
 * `planning-legacy-page.tsx` comme fichier de référence / archive (non utilisée par le site).
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

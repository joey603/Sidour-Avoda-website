"use client";

import { Suspense } from "react";
import { PlanningV2Page } from "@/components/planning-v2/planning-v2-page";

function PlanningFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6 text-zinc-600 dark:text-zinc-400" dir="rtl">
      טוען…
    </div>
  );
}

/** Planning principal : UI v2. L’ancienne implémentation est conservée dans `planning-legacy-page.tsx`. */
export default function DirectorPlanningSitePage() {
  return (
    <Suspense fallback={<PlanningFallback />}>
      <PlanningV2Page />
    </Suspense>
  );
}

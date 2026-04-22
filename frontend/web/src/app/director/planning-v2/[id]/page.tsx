"use client";

import { Suspense } from "react";
import { PlanningV2Page } from "@/components/planning-v2/planning-v2-page";

function PlanningV2Fallback() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6 text-zinc-600 dark:text-zinc-400" dir="rtl">
      טוען…
    </div>
  );
}

export default function PlanningV2IdPage() {
  return (
    <Suspense fallback={<PlanningV2Fallback />}>
      <PlanningV2Page />
    </Suspense>
  );
}

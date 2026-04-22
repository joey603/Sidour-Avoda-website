import type { ReactNode } from "react";

type PlanningV2LayoutShellProps = {
  children: ReactNode;
};

/** Même largeur et espacement que le conteneur principal de `planning/[id]` (avant le bloc `rounded-2xl border`). */
export function PlanningV2LayoutShell({ children }: PlanningV2LayoutShellProps) {
  return (
    <div className="mx-auto w-full max-w-none space-y-6 rounded-xl md:max-w-5xl lg:max-w-6xl">{children}</div>
  );
}

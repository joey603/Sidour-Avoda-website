import type { ReactNode } from "react";

type PlanningV2MainPaperProps = {
  children: ReactNode;
  /** מצב עריכה — טבעת כחולה כמו ב-planning הישן */
  editingSaved?: boolean;
  /** תכנון שמור — טבעת ירוקה */
  savedHighlight?: boolean;
};

/**
 * Bloc principal bordé — équivalent à
 * `relative w-full rounded-2xl border p-4 dark:border-zinc-800 space-y-6` sur la page planning d’origine.
 */
export function PlanningV2MainPaper({ children, editingSaved, savedHighlight }: PlanningV2MainPaperProps) {
  const ring =
    editingSaved
      ? "ring-2 ring-[#00A8E0] ring-offset-4 ring-offset-white dark:ring-offset-zinc-950"
      : savedHighlight
        ? "ring-2 ring-green-500 ring-offset-4 ring-offset-white dark:ring-offset-zinc-950"
        : "";

  return (
    <div
      className={
        "relative w-full space-y-6 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950 " +
        ring
      }
    >
      {children}
    </div>
  );
}

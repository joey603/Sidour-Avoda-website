import Link from "next/link";

type PlanningV2HeaderProps = {
  siteId: string;
};

export function PlanningV2Header({ siteId }: PlanningV2HeaderProps) {
  return (
    <header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">תכנון משמרות</h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">מבנה מחודש (בפיתוח)</p>
        </div>
        <span className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 font-mono text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          אתר #{siteId}
        </span>
        <nav className="flex flex-wrap items-center gap-2">
          <Link
            href="/director/sites"
            aria-label="רשימת אתרים"
            title="רשימת אתרים"
            className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white p-2 text-zinc-800 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden>
              <path d="M14 6l-6 6 6 6V6z" />
            </svg>
          </Link>
        </nav>
      </div>
    </header>
  );
}

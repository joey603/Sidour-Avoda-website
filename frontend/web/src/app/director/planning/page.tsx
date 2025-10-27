"use client";

import Link from "next/link";

export default function PlanningIndex() {
  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-2xl font-semibold">יצירת תכנון משמרות</h1>
        <div className="rounded-2xl border p-4 dark:border-zinc-800">
          <p className="mb-4">לא נמצא מזהה אתר. נא לחזור לדף המנהל ולבחור אתר.</p>
          <Link
            href="/director"
            className="inline-flex rounded-md border px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            חזרה לדף המנהל
          </Link>
        </div>
      </div>
    </div>
  );
}



"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

function LoginInner() {
  const searchParams = useSearchParams();
  const returnUrl = searchParams?.get("returnUrl") || "";
  const directorHref = returnUrl ? `/login/director?returnUrl=${encodeURIComponent(returnUrl)}` : "/login/director";
  const workerHref = returnUrl ? `/login/worker?returnUrl=${encodeURIComponent(returnUrl)}` : "/login/worker";

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">התחברות</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">בחר סוג משתמש</p>
        </div>
        <div className="grid grid-cols-1 gap-3">
          <Link
            href={directorHref}
            className="rounded-xl border p-4 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <div className="font-semibold">מנהל</div>
            <div className="text-sm text-zinc-600 dark:text-zinc-300">התחברות עם אימייל וסיסמה</div>
          </Link>
          <Link
            href={workerHref}
            className="rounded-xl border p-4 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <div className="font-semibold">עובד</div>
            <div className="text-sm text-zinc-600 dark:text-zinc-300">התחברות עם קוד מנהל ומספר טלפון</div>
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><p>מעביר...</p></div>}>
      <LoginInner />
    </Suspense>
  );
}



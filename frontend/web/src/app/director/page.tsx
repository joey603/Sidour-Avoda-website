"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import LoadingAnimation from "@/components/loading-animation";

export default function DirectorDashboard() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState<string>("");
  const [directorCode, setDirectorCode] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const me = await fetchMe();
        if (!me) {
          if (!cancelled) router.replace("/login/director");
          return;
        }
        if (me.role !== "director") {
          if (!cancelled) router.replace("/worker");
          return;
        }
        if (!cancelled) {
          setName(me.full_name);
          setDirectorCode(String((me as any)?.director_code || (me as any)?.directorCode || ""));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex min-h-[100lvh] w-full max-w-[100vw] items-center justify-center overflow-x-hidden overscroll-none bg-white/70 backdrop-blur-md md:min-h-screen-mobile dark:bg-zinc-950/70 dark:backdrop-blur-md">
        <LoadingAnimation size={96} />
      </div>
    );
  }

  return (
    <div className="relative min-h-screen p-6 flex items-center justify-center">
      <div className="text-center space-y-3">
        <h1 className="text-2xl font-semibold">
          ברוך הבא{name ? ", " : ""}<span className="font-bold" style={{ color: '#00A8E0' }}>{name}</span>
        </h1>
        {directorCode ? (
          <div className="text-sm text-zinc-600 dark:text-zinc-300">
            קוד מנהל: <span className="font-semibold text-zinc-900 dark:text-zinc-100" dir="ltr">{directorCode}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}



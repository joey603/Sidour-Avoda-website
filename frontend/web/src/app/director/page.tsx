"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";

export default function DirectorDashboard() {
  const router = useRouter();
  const [name, setName] = useState<string>("");
  const [directorCode, setDirectorCode] = useState<string>("");

  useEffect(() => {
    (async () => {
      const me = await fetchMe();
      if (!me) return router.replace("/login/director");
      if (me.role !== "director") return router.replace("/worker");
      setName(me.full_name);
      setDirectorCode(String((me as any)?.director_code || (me as any)?.directorCode || ""));
    })();
  }, [router]);

  return (
    <div className="min-h-screen p-6 flex items-center justify-center">
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



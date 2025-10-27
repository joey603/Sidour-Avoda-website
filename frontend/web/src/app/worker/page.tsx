"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchMe, clearToken } from "@/lib/auth";

export default function WorkerDashboard() {
  const router = useRouter();
  const [name, setName] = useState<string>("");
  useEffect(() => {
    fetchMe().then((me) => {
      if (!me) return router.replace("/login");
      if (me.role !== "worker") return router.replace("/director");
      setName(me.full_name);
    });
  }, [router]);

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">ברוך הבא, <span className="font-bold" style={{ color: '#00A8E0' }}>{name}</span></h1>
        </header>
        <div className="rounded-xl border p-4 dark:border-zinc-800">
          <p>כאן יוצג לוח המשמרות שלך.</p>
        </div>
      </div>
    </div>
  );
}



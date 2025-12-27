"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";

export default function DirectorDashboard() {
  const router = useRouter();
  const [name, setName] = useState<string>("");

  useEffect(() => {
    (async () => {
      const me = await fetchMe();
      if (!me) return router.replace("/login/director");
      if (me.role !== "director") return router.replace("/worker");
      setName(me.full_name);
    })();
  }, [router]);

  return (
    <div className="min-h-screen p-6 flex items-center justify-center">
      <h1 className="text-2xl font-semibold text-center">
        ברוך הבא{name ? ", " : ""}<span className="font-bold" style={{ color: '#00A8E0' }}>{name}</span>
      </h1>
    </div>
  );
}



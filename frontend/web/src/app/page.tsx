"use client";
import { useEffect, useState } from "react";
import { fetchMe } from "@/lib/auth";

export default function Home() {
  const [name, setName] = useState<string>("");
  const [role, setRole] = useState<"worker" | "director" | "">("");
  const [directorCode, setDirectorCode] = useState<string>("");

  useEffect(() => {
    (async () => {
      try {
        const me = await fetchMe();
        if (me?.full_name) setName(me.full_name);
        if (me?.role) setRole(me.role);
        if (me?.role === "director" && me?.director_code) setDirectorCode(String(me.director_code));
      } catch {
        // ignore
      }
    })();
  }, []);

  return (
    <div className="min-h-screen p-6 flex items-center justify-center">
      <div className="text-center space-y-3">
        <h1 className="text-2xl font-semibold">
        ברוך הבא{ name ? ", " : "" }<span className="font-bold" style={{ color: '#00A8E0' }}>{name}</span>
      </h1>
        {role === "director" && directorCode ? (
          <div className="text-sm text-zinc-600 dark:text-zinc-300">
            קוד מנהל: <span className="font-semibold text-zinc-900 dark:text-zinc-100" dir="ltr">{directorCode}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

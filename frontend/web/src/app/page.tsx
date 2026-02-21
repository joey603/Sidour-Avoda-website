"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchMe, getToken } from "@/lib/auth";

export default function Home() {
  const router = useRouter();
  const [name, setName] = useState<string>("");
  const [role, setRole] = useState<"worker" | "director" | "">("");
  const [directorCode, setDirectorCode] = useState<string>("");

  useEffect(() => {
    const token = getToken();
    const target = `/login?returnUrl=${encodeURIComponent("/")}`;

    // Si pas connecté: rediriger vers login (le login gère le wakeup du serveur).
    if (!token) {
      router.replace(target);
      return;
    }

    (async () => {
      try {
        const me = await fetchMe();
        if (!me) {
          router.replace(target);
          return;
        }
        if (me?.full_name) setName(me.full_name);
        if (me?.role) setRole(me.role);
        if (me?.role === "director" && me?.director_code) setDirectorCode(String(me.director_code));
      } catch {
        router.replace(target);
      }
    })();
  }, [router]);

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

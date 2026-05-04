"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import LoadingAnimation from "@/components/loading-animation";

export default function Home() {
  const router = useRouter();
  const [bootstrapping, setBootstrapping] = useState(true);
  const [name, setName] = useState<string>("");
  const [role, setRole] = useState<"worker" | "director" | "">("");
  const [directorCode, setDirectorCode] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    const target = `/login?returnUrl=${encodeURIComponent("/")}`;

    (async () => {
      try {
        const me = await fetchMe();
        if (!me) {
          router.replace(target);
          return;
        }
        if (!cancelled) {
          if (me?.full_name) setName(me.full_name);
          if (me?.role) setRole(me.role);
          if (me?.role === "director" && me?.director_code) setDirectorCode(String(me.director_code));
          setBootstrapping(false);
        }
      } catch {
        router.replace(target);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (bootstrapping) {
    return (
      <div className="fixed inset-0 z-50 flex min-h-[100lvh] w-full max-w-[100vw] items-center justify-center overflow-x-hidden overscroll-none bg-white/70 backdrop-blur-md md:min-h-screen-mobile dark:bg-zinc-950/70 dark:backdrop-blur-md">
        <LoadingAnimation size={96} />
      </div>
    );
  }

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

"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { fetchMe, clearToken } from "@/lib/auth";
// Remplace Image optimisé pour éviter erreurs avec PNG locaux non valides
import Link from "next/link";

type Role = "worker" | "director";

export default function TopNav() {
  const router = useRouter();
  const pathname = usePathname();
  const [userRole, setUserRole] = useState<Role | null>(null);
  const isAuthPage = (pathname || "").startsWith("/login") || (pathname || "").startsWith("/register");

  useEffect(() => {
    fetchMe().then((me) => {
      if (me) setUserRole(me.role);
    });
  }, []);

  // Recharger le rôle utilisateur à chaque changement de page (ex: après login -> /director)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await fetchMe();
        if (cancelled) return;
        if (me) {
          setUserRole(me.role);
        } else {
          setUserRole(null);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const baseBtn =
    "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm transition-colors border";
  const activeClasses =
    "bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100";
  const inactiveClasses =
    "bg-white text-zinc-800 border-zinc-300 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-200 dark:border-zinc-700 dark:hover:bg-zinc-800";

  return (
    <div className="w-full border-b bg-white/80 backdrop-blur dark:bg-zinc-900/80">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 py-3 pr-3 pl-0">
        <div className="flex items-center gap-2">
          {!isAuthPage && (
            <>
              {userRole === "director" ? (
                <>
                  <Link
                    href="/"
                    className={`${baseBtn} ${["/", "/director"].includes(pathname || "") ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
                    aria-label="בית"
                    aria-current={["/", "/director"].includes(pathname || "") ? "page" : undefined}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true" className="ml-1">
                      <path d="M12 3l9 8h-3v10h-5v-6H11v6H6V11H3Z"/>
                    </svg>
                    בית
                  </Link>
                  <Link
                    href="/director/sites"
                    className={`${baseBtn} ${pathname === "/director/sites" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
                    aria-label="רשימת אתרים"
                    aria-current={pathname === "/director/sites" ? "page" : undefined}
                  >
                    רשימת אתרים
                  </Link>
                  <Link
                    href="/director/workers"
                    className={`${baseBtn} ${pathname === "/director/workers" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
                    aria-label="רשימת עובדים"
                    aria-current={pathname === "/director/workers" ? "page" : undefined}
                  >
                    רשימת עובדים
                  </Link>
                </>
              ) : userRole === "worker" ? (
                <>
                  <Link
                    href="/worker"
                    className={`${baseBtn} ${pathname === "/worker" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
                    aria-label="בית"
                    aria-current={pathname === "/worker" ? "page" : undefined}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true" className="ml-1">
                      <path d="M12 3l9 8h-3v10h-5v-6H11v6H6V11H3Z"/>
                    </svg>
                    בית
                  </Link>
                  <Link
                    href="/worker/availability"
                    className={`${baseBtn} ${pathname === "/worker/availability" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
                    aria-label="זמינות"
                    aria-current={pathname === "/worker/availability" ? "page" : undefined}
                  >
                    זמינות
                  </Link>
                  <Link
                    href="/worker/history"
                    className={`${baseBtn} ${pathname === "/worker/history" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
                    aria-label="היסטוריה"
                    aria-current={pathname === "/worker/history" ? "page" : undefined}
                  >
                    היסטוריה
                  </Link>
                </>
              ) : (
                <Link
                  href="/"
                  className={`${baseBtn} ${pathname === "/" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
                  aria-label="בית"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true" className="ml-1">
                    <path d="M12 3l9 8h-3v10h-5v-6H11v6H6V11H3Z"/>
                  </svg>
                  בית
                </Link>
              )}
            </>
          )}
          {userRole && (
            <button
              type="button"
              onClick={() => {
                clearToken();
                setUserRole(null);
                router.replace(userRole === "director" ? "/login/director" : "/login/worker");
              }}
              className={`${baseBtn} ${inactiveClasses} hover:bg-red-100 dark:hover:bg-red-900 hover:text-red-800 dark:hover:text-red-200 hover:border-red-200 dark:hover:border-red-800`}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true" className="ml-1">
                <path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5v-2H5V5h5Zm9.71 8.29-4-4-1.42 1.42L16.59 11H9v2h7.59l-2.3 2.29 1.42 1.42 4-4a1 1 0 0 0 0-1.42Z"/>
              </svg>
              התנתק
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2" aria-label="G1 home">
            <img src="/g1-logo.png" alt="G1" width={48} height={48} style={{ display: "block" }} />
          </Link>
        </div>
      </div>
    </div>
  );
}



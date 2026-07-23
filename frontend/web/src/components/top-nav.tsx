"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { AUTH_SESSION_CHANGED_EVENT, fetchMe, logout } from "@/lib/auth";
import {
  clearPlanningCreatPlanSessionStorageOnLogout,
  clearPlanningLocalStorageOnLogout,
  ensurePlanningWeeklyCachePurgeScheduled,
} from "@/lib/planning-session-cache";
// Remplace Image optimisé pour éviter erreurs avec PNG locaux non valides
import Link from "next/link";

type Role = "worker" | "director";

function isStandaloneApp() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export default function TopNav() {
  const router = useRouter();
  const pathname = usePathname();
  const [userRole, setUserRole] = useState<Role | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isAuthPage = (pathname || "").startsWith("/login") || (pathname || "").startsWith("/register");
  const isHomePage = pathname === "/";
  const isProtectedPage =
    (pathname || "").startsWith("/director") ||
    (pathname || "").startsWith("/worker");
  const [returnUrl, setReturnUrl] = useState<string>("");
  useEffect(() => {
    // Eviter useSearchParams() ici (cause CSR bailout sur /_not-found lors du build).
    try {
      if (typeof window === "undefined") return;
      const ru = new URLSearchParams(window.location.search).get("returnUrl") || "";
      setReturnUrl(ru);
    } catch {
      setReturnUrl("");
    }
  }, [pathname]);
  const authReturnQuery = useMemo(() => (returnUrl ? `?returnUrl=${encodeURIComponent(returnUrl)}` : ""), [returnUrl]);

  useEffect(() => {
    let cancelled = false;
    async function refreshAuthState() {
      setAuthChecked(false);
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
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    }

    void refreshAuthState();
    const onAuthChanged = () => {
      void refreshAuthState();
    };
    if (typeof window !== "undefined") {
      window.addEventListener(AUTH_SESSION_CHANGED_EVENT, onAuthChanged);
    }
    return () => {
      cancelled = true;
      if (typeof window !== "undefined") {
        window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, onAuthChanged);
      }
    };
  }, []);

  // Redirection globale: si pas connecté, renvoyer vers login automatiquement
  useEffect(() => {
    if (!authChecked) return;
    if (isAuthPage) return;
    if (!isProtectedPage) return;
    if (userRole) return;
    if (typeof window === "undefined") return;

    const cur = window.location.pathname + window.location.search;
    const isWorkerArea =
      (pathname || "").startsWith("/worker") ||
      (pathname || "").startsWith("/public/workers");
    const target = isWorkerArea
      ? `/login/worker?returnUrl=${encodeURIComponent(cur)}`
      : `/login/director?returnUrl=${encodeURIComponent(cur)}`;
    router.replace(target);
  }, [authChecked, isAuthPage, isProtectedPage, pathname, router, userRole]);

  // En mode app native, ouvrir le tableau de bord directeur par défaut (sauf clic logo → /?landing=1).
  useEffect(() => {
    if (!authChecked) return;
    if (!isHomePage) return;
    if (userRole !== "director") return;
    if (!isStandaloneApp()) return;
    if (typeof window !== "undefined") {
      if (new URLSearchParams(window.location.search).get("landing") === "1") return;
    }
    router.replace("/director");
  }, [authChecked, isHomePage, router, userRole]);

  const logoHref = userRole ? "/?landing=1" : "/";

  const baseBtn =
    "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm transition-colors border";
  const baseBtnMobile =
    "inline-flex items-center justify-center rounded-md px-4 py-3 text-base transition-colors border w-full";
  const inactiveClasses =
    "bg-white text-zinc-800 border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900";

  const handleLinkClick = () => {
    setMobileMenuOpen(false);
  };

  // Fermer le menu mobile quand on change de page
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  // Purge hebdo (après samedi 23:59 local) des caches session planning — une fois par onglet.
  useEffect(() => {
    ensurePlanningWeeklyCachePurgeScheduled();
  }, []);

  const showLoginButtons = isAuthPage || (isHomePage && !userRole);
  const homeHref =
    userRole === "director" ? "/director" : userRole === "worker" ? "/worker" : "/";

  // Navigation buttons component pour mobile (drawer)
  const renderNavButtonsMobile = () => {
    if (showLoginButtons) {
      return (
        <>
          <Link
            href={`/login/worker${authReturnQuery}`}
            onClick={handleLinkClick}
            className={`${baseBtnMobile} ${(pathname || "").startsWith("/login/worker") ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
            aria-label="התחברות עובד"
            aria-current={(pathname || "").startsWith("/login/worker") ? "page" : undefined}
          >
            התחברות עובד
          </Link>
          <Link
            href={`/login/director${authReturnQuery}`}
            onClick={handleLinkClick}
            className={`${baseBtnMobile} ${(pathname || "").startsWith("/login/director") ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
            aria-label="התחברות מנהל"
            aria-current={(pathname || "").startsWith("/login/director") ? "page" : undefined}
          >
            התחברות מנהל
          </Link>
        </>
      );
    }

    if (userRole === "director") {
      return (
        <>
          <Link
            href="/director"
            onClick={handleLinkClick}
            className={`${baseBtnMobile} ${pathname === "/director" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
            aria-label="בית"
            aria-current={pathname === "/director" ? "page" : undefined}
          >
            בית
          </Link>
          <Link
            href="/director/sites"
            onClick={handleLinkClick}
            className={`${baseBtnMobile} ${pathname === "/director/sites" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
            aria-label="רשימת אתרים"
            aria-current={pathname === "/director/sites" ? "page" : undefined}
          >
            רשימת אתרים
          </Link>
          <Link
            href="/director/workers"
            onClick={handleLinkClick}
            className={`${baseBtnMobile} ${pathname === "/director/workers" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
            aria-label="רשימת עובדים"
            aria-current={pathname === "/director/workers" ? "page" : undefined}
          >
            רשימת עובדים
          </Link>
        </>
      );
    }

    if (userRole === "worker") {
      return (
        <>
          <Link
            href="/worker"
            onClick={handleLinkClick}
            className={`${baseBtnMobile} ${pathname === "/worker" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
            aria-label="בית"
            aria-current={pathname === "/worker" ? "page" : undefined}
          >
            בית
          </Link>
          <Link
            href="/worker/availability"
            onClick={handleLinkClick}
            className={`${baseBtnMobile} ${pathname === "/worker/availability" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
            aria-label="זמינות"
            aria-current={pathname === "/worker/availability" ? "page" : undefined}
          >
            זמינות
          </Link>
          <Link
            href="/worker/history"
            onClick={handleLinkClick}
            className={`${baseBtnMobile} ${pathname === "/worker/history" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
            aria-label="היסטוריה"
            aria-current={pathname === "/worker/history" ? "page" : undefined}
          >
            היסטוריה
          </Link>
        </>
      );
    }

    return (
      <Link
        href="/"
        onClick={handleLinkClick}
        className={`${baseBtnMobile} ${pathname === "/" ? "liquid-glass-btn text-zinc-900" : inactiveClasses}`}
        aria-label="בית"
      >
        בית
      </Link>
    );
  };

  // Navigation buttons component (réutilisable pour desktop)
  const renderNavButtons = () => {
    if (showLoginButtons) {
  return (
        <>
          <Link
            href={`/login/worker${authReturnQuery}`}
            onClick={handleLinkClick}
            className={`${baseBtn} ${(pathname || "").startsWith("/login/worker") ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
            aria-label="התחברות עובד"
            aria-current={(pathname || "").startsWith("/login/worker") ? "page" : undefined}
          >
            התחברות עובד
          </Link>
          <Link
            href={`/login/director${authReturnQuery}`}
            onClick={handleLinkClick}
            className={`${baseBtn} ${(pathname || "").startsWith("/login/director") ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
            aria-label="התחברות מנהל"
            aria-current={(pathname || "").startsWith("/login/director") ? "page" : undefined}
          >
            התחברות מנהל
          </Link>
        </>
      );
    }

    if (userRole === "director") {
      return (
                <>
                  <Link
                    href="/director"
                    onClick={handleLinkClick}
                    className={`${baseBtn} ${pathname === "/director" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
                    aria-label="בית"
                    aria-current={pathname === "/director" ? "page" : undefined}
                  >
                    בית
                  </Link>
                  <Link
                    href="/director/sites"
            onClick={handleLinkClick}
                    className={`${baseBtn} ${pathname === "/director/sites" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
                    aria-label="רשימת אתרים"
                    aria-current={pathname === "/director/sites" ? "page" : undefined}
                  >
                    רשימת אתרים
                  </Link>
                  <Link
                    href="/director/workers"
            onClick={handleLinkClick}
                    className={`${baseBtn} ${pathname === "/director/workers" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
                    aria-label="רשימת עובדים"
                    aria-current={pathname === "/director/workers" ? "page" : undefined}
                  >
                    רשימת עובדים
                  </Link>
                </>
      );
    }

    if (userRole === "worker") {
      return (
                <>
                  <Link
                    href="/worker"
            onClick={handleLinkClick}
                    className={`${baseBtn} ${pathname === "/worker" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
                    aria-label="בית"
                    aria-current={pathname === "/worker" ? "page" : undefined}
                  >
                    בית
                  </Link>
                  <Link
                    href="/worker/availability"
            onClick={handleLinkClick}
                    className={`${baseBtn} ${pathname === "/worker/availability" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
                    aria-label="זמינות"
                    aria-current={pathname === "/worker/availability" ? "page" : undefined}
                  >
                    זמינות
                  </Link>
                  <Link
                    href="/worker/history"
            onClick={handleLinkClick}
                    className={`${baseBtn} ${pathname === "/worker/history" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
                    aria-label="היסטוריה"
                    aria-current={pathname === "/worker/history" ? "page" : undefined}
                  >
                    היסטוריה
                  </Link>
                </>
      );
    }

    return (
                <Link
                  href="/"
        onClick={handleLinkClick}
                  className={`${baseBtn} ${pathname === "/" ? "liquid-glass-btn text-zinc-900" : inactiveClasses}`}
                  aria-label="בית"
                >
                  בית
                </Link>
    );
  };

  return (
    <>
      <div
        id="app-top-nav"
        className="sticky top-0 z-[40] w-full border-b border-zinc-200 bg-white pt-[env(safe-area-inset-top,0px)] dark:border-zinc-800 dark:bg-zinc-950"
      >
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 py-3 pr-3 pl-0">
          <div className="flex items-center gap-2">
            {/* Bouton hamburger (mobile uniquement) */}
            <button
              type="button"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden inline-flex items-center justify-center rounded-md p-2 text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900"
              aria-label="תפריט"
              aria-expanded={mobileMenuOpen}
            >
              {mobileMenuOpen ? (
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="12" x2="21" y2="12"/>
                  <line x1="3" y1="6" x2="21" y2="6"/>
                  <line x1="3" y1="18" x2="21" y2="18"/>
                </svg>
              )}
            </button>

            {/* Navigation buttons (desktop uniquement) */}
            <div className="hidden md:flex items-center gap-2">
              {renderNavButtons()}
          {userRole && (
            <>
            <Link
              href="/settings"
              onClick={handleLinkClick}
              className={`${baseBtn} ${pathname === "/settings" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
            >
              הגדרות
            </Link>
            <button
              type="button"
              onClick={async () => {
                clearPlanningCreatPlanSessionStorageOnLogout();
                clearPlanningLocalStorageOnLogout();
                await logout();
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
            </>
          )}
            </div>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={logoHref}
            className="group relative inline-flex items-center pb-1"
            aria-label="G1 home"
          >
            <img
              src="/g1-logo-nav.png"
              alt="G1"
              width={48}
              height={48}
              className="block transition-transform duration-200 ease-out group-hover:scale-105"
            />
            <span
              className="pointer-events-none absolute bottom-0 left-1/2 h-0.5 w-[90%] -translate-x-1/2 scale-x-0 rounded-full bg-[#00A8E0] transition-transform duration-200 ease-out group-hover:scale-x-100"
              aria-hidden
            />
          </Link>
        </div>
      </div>
    </div>

      {/* Overlay sombre (mobile) */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Drawer mobile (panneau latéral) */}
      <div
        className={`fixed top-0 right-0 h-full w-64 bg-white dark:bg-zinc-900 shadow-xl z-50 transform transition-transform duration-300 ease-in-out md:hidden ${
          mobileMenuOpen ? "translate-x-0" : "translate-x-full"
        }`}
        dir="rtl"
      >
        <div className="flex flex-col h-full">
          {/* Header du drawer avec bouton fermer */}
          <div className="flex items-center justify-between p-4 border-b dark:border-zinc-800">
            <h2 className="text-lg font-semibold">תפריט</h2>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="inline-flex items-center justify-center rounded-md p-2 text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
              aria-label="סגור תפריט"
            >
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          {/* Contenu du drawer avec les boutons de navigation */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {renderNavButtonsMobile()}
            {userRole && (
              <>
              <Link
                href="/settings"
                onClick={handleLinkClick}
                className={`${baseBtnMobile} ${pathname === "/settings" ? "bg-[#00A8E0] text-white border-[#00A8E0]" : inactiveClasses}`}
              >
                הגדרות
              </Link>
              <button
                type="button"
                onClick={async () => {
                  clearPlanningCreatPlanSessionStorageOnLogout();
                  clearPlanningLocalStorageOnLogout();
                  await logout();
                  setUserRole(null);
                  setMobileMenuOpen(false);
                  router.replace(userRole === "director" ? "/login/director" : "/login/worker");
                }}
                className={`${baseBtnMobile} ${inactiveClasses} hover:bg-red-100 dark:hover:bg-red-900 hover:text-red-800 dark:hover:text-red-200 hover:border-red-200 dark:hover:border-red-800`}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" className="ml-2">
                  <path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5v-2H5V5h5Zm9.71 8.29-4-4-1.42 1.42L16.59 11H9v2h7.59l-2.3 2.29 1.42 1.42 4-4a1 1 0 0 0 0-1.42Z"/>
                </svg>
                התנתק
              </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}



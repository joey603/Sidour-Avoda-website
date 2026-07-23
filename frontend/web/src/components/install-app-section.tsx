"use client";

import { useEffect, useRef, useState } from "react";
import { isNativeShellApp } from "@/lib/native-shell";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function useReveal(delay = 0) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ob = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setTimeout(() => setVisible(true), delay);
          ob.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, [delay]);
  return { ref, visible };
}

const PLATFORMS = [
  {
    id: "iphone",
    title: "iPhone / iPad",
    badge: "Safari",
    steps: [
      "פתח את האתר ב־Safari",
      "לחץ על שיתוף (האייקון □↑ בתחתית או למעלה)",
      "בחר «הוסף למסך הבית» ואשר",
    ],
    note: "נפתח במסך מלא עם אייקון — בלי App Store",
  },
  {
    id: "android",
    title: "Android",
    badge: "Chrome",
    steps: [
      "פתח את האתר ב־Chrome",
      "לחץ על התפריט ⋮",
      "בחר «התקן אפליקציה» או «הוסף למסך הבית»",
    ],
    note: "אייקון על המסך הראשי, חוויית אפליקציה מלאה",
  },
  {
    id: "desktop",
    title: "מחשב (Windows / Mac)",
    badge: "Chrome · Edge",
    steps: [
      "פתח את האתר ב־Chrome או Edge",
      "לחץ על אייקון ההתקנה בסרגל הכתובת (⊕ / מחשב)",
      "או דרך התפריט: «התקן את גי וואן…»",
    ],
    note: "חלון ייעודי בלי סרגל דפדפן — כמו אפליקציית שולחן עבודה",
  },
] as const;

/**
 * Section landing : installer la PWA (mobile + desktop) depuis le site.
 * Masquée si déjà en mode app (standalone / Capacitor / Tauri).
 */
export default function InstallAppSection() {
  const { ref, visible } = useReveal(40);
  const [hidden, setHidden] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (isNativeShellApp()) {
      setHidden(true);
      return;
    }

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferredPrompt(null);
      setHidden(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (hidden) return null;

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    setInstalling(true);
    try {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      setDeferredPrompt(null);
    } catch {
      // ignore
    } finally {
      setInstalling(false);
    }
  };

  return (
    <section
      ref={ref}
      id="install-app"
      dir="rtl"
      className="landing-safe-insets relative px-4 py-16 sm:px-6 sm:py-20"
      aria-labelledby="install-app-title"
    >
      <div
        className="mx-auto max-w-5xl text-center"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? "translateY(0)" : "translateY(18px)",
          transition: "opacity 0.55s ease, transform 0.55s ease",
        }}
      >
        <p className="text-sm font-medium tracking-wide text-[#00A8E0]">התקנה מהאתר</p>
        <h2
          id="install-app-title"
          className="mt-2 text-3xl font-bold text-zinc-900 sm:text-4xl"
        >
          הוסף למסך הבית
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm text-zinc-500 md:text-base">
          התקן את{" "}
          <span className="font-semibold text-zinc-700">גי וואן</span> ישירות מהאתר —
          אייקון, מסך מלא, בלי App Store או Google Play. עובד בטלפון ובמחשב.
        </p>

        {deferredPrompt ? (
          <button
            type="button"
            onClick={() => void handleInstallClick()}
            disabled={installing}
            className="mt-7 inline-flex items-center gap-2 rounded-xl px-8 py-3.5 text-sm font-semibold text-white shadow-lg transition-transform hover:scale-105 disabled:opacity-70"
            style={{
              background: "linear-gradient(135deg, #00A8E0 0%, #0284c7 100%)",
              boxShadow: "0 0 28px rgba(0,168,224,0.3)",
            }}
          >
            {installing ? "מתקין…" : "התקן עכשיו"}
          </button>
        ) : null}
      </div>

      <div
        className="mx-auto mt-10 grid max-w-5xl gap-6 md:grid-cols-3"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? "translateY(0)" : "translateY(14px)",
          transition: "opacity 0.55s ease 0.1s, transform 0.55s ease 0.1s",
        }}
      >
        {PLATFORMS.map((platform) => (
          <article
            key={platform.id}
            className="rounded-2xl border border-zinc-200/80 bg-white/70 p-5 text-right backdrop-blur-sm sm:p-6"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-lg font-bold text-zinc-900">{platform.title}</h3>
              <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500">
                {platform.badge}
              </span>
            </div>
            <ol className="mt-4 space-y-2.5 text-sm text-zinc-600">
              {platform.steps.map((step, i) => (
                <li key={step} className="flex gap-2.5">
                  <span
                    className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                    style={{ background: "#00A8E0" }}
                    aria-hidden
                  >
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-xs leading-relaxed text-zinc-400">{platform.note}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

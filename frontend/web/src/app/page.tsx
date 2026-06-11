"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import LoadingAnimation from "@/components/loading-animation";
import { AnimatedHeroTitle } from "@/components/ui/animated-hero";
import { SplineScene } from "@/components/ui/splite";
import { ScrollGooeyText } from "@/components/ui/gooey-text-morphing";
import {
  useScroll,
  useTransform,
  useMotionValueEvent,
  motion,
  type MotionValue,
} from "framer-motion";

/* ─── Scroll-reveal hook ─────────────────────────────────────────── */
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
      { threshold: 0.1 },
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, [delay]);
  return { ref, visible };
}

/* ─── Feature card data ──────────────────────────────────────────── */
const FEATURES = [
  {
    color: "blue",
    title: "תכנון AI חכם",
    desc: "מנוע אופטימיזציה מבוסס OR-Tools CP-SAT שמחשב את שיבוץ המשמרות האופטימלי תוך שניות, תוך התחשבות בכל האילוצים והזמינויות",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6">
        <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
      </svg>
    ),
  },
  {
    color: "indigo",
    title: "ניהול רב-אתרי",
    desc: "נהל מספר אתרים ותחנות ממקום אחד עם מבט מלא על כל הצוותים",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
      </svg>
    ),
  },
  {
    color: "green",
    title: "ניהול עובדים",
    desc: "הוסף עובדים, הגדר תפקידים ועקוב אחר זמינות שבועית בקלות",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6">
        <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
      </svg>
    ),
  },
  {
    color: "amber",
    title: "עדכונים בזמן אמת",
    desc: "כל שינוי בסידור מתעדכן מיידית לכלל העובדים דרך Server-Sent Events",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6">
        <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
      </svg>
    ),
  },
  {
    color: "purple",
    title: "הרשאות מבוססות תפקיד",
    desc: "הפרדה מלאה בין הרשאות מנהל לעובד עם JWT וגישה מאובטחת",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6">
        <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" />
      </svg>
    ),
  },
  {
    color: "rose",
    title: "לוח תכנון שבועי",
    desc: "תצוגת לוח שנה אינטראקטיבי עם גרירה ושחרור, פילטרים ועריכה מהירה",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6">
        <path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z" />
      </svg>
    ),
  },
] as const;


/* ─── Root page — auth-gate then landing ────────────────────────── */
export default function Home() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await fetchMe();
        if (cancelled) return;
        if (me?.role === "director") {
          router.replace("/director");
          return;
        }
        if (me?.role === "worker") {
          router.replace("/worker");
          return;
        }
      } catch {
        /* not authenticated — show landing page */
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (checking) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/70 backdrop-blur-md dark:bg-zinc-950/70">
        <LoadingAnimation size={96} />
      </div>
    );
  }

  return <LandingPage />;
}

/* ─── Features (scroll cinématique unifié) ───────────────────────── */

type FeatureItem = {
  title: string;
  desc: string;
  media: string;
  mediaType: "image" | "video";
};

const FEATURE_ITEMS: FeatureItem[] = [
  {
    title: "ניהול רב-אתרי",
    desc: "נהל מספר אתרים ותחנות ממקום אחד עם מבט מלא על כל הצוותים",
    media: "/rav-atariim-sites-list.png",
    mediaType: "image",
  },
  {
    title: "תפקידים ושיבוצים",
    desc: "הגדר תפקידים לכל עובד, צפה בזמינות ושבץ אוטומטית לפי תפקיד בכל משמרת",
    media: "/tafkidim-planning.png",
    mediaType: "image",
  },
  {
    title: "תפריט עובד",
    desc: "ממשק פשוט לעובדים — זמינות שבועית, היסטוריה ועדכונים בזמן אמת",
    media: "/worker-availability-menu.png",
    mediaType: "image",
  },
];

const FEATURES_SCROLL_START = 0.38;

function featureSegmentBounds(index: number, total: number) {
  const span = (1 - FEATURES_SCROLL_START) / total;
  const start = FEATURES_SCROLL_START + index * span;
  const end = start + span;
  const entrance = span * 0.38;
  const exit = index < total - 1 ? span * 0.18 : 0;
  return { start, end, entrance, exit };
}

function FeatureSlidePanel({
  item,
  scrollYProgress,
  index,
  total,
}: {
  item: FeatureItem;
  scrollYProgress: MotionValue<number>;
  index: number;
  total: number;
}) {
  const { start, end, entrance, exit } = featureSegmentBounds(index, total);
  const enterEnd = start + entrance;
  const exitStart = end - exit;

  const opacity = useTransform(
    scrollYProgress,
    exit > 0 ? [start, enterEnd, exitStart, end] : [start, enterEnd, 1, 1],
    exit > 0 ? [0, 1, 1, 0] : [0, 1, 1, 1],
  );
  const textX = useTransform(scrollYProgress, [start, enterEnd], [140, 0]);
  const imageX = useTransform(scrollYProgress, [start, enterEnd], [-140, 0]);
  const descOp = useTransform(scrollYProgress, [start + entrance * 0.45, enterEnd], [0, 1]);

  return (
    <motion.div
      className="pointer-events-none absolute inset-0 flex items-center bg-white"
      style={{ opacity }}
      dir="rtl"
    >
      <div className="flex h-full w-full items-center pt-[var(--app-top-nav-height)]">
        <motion.div className="flex w-1/2 flex-col items-end px-8 md:px-16" style={{ x: textX }}>
          <h2 className="text-3xl font-bold text-zinc-900 md:text-4xl lg:text-5xl">{item.title}</h2>
          <motion.p
            className="mt-2 max-w-md text-right text-sm text-zinc-500 md:text-base"
            style={{ opacity: descOp }}
          >
            {item.desc}
          </motion.p>
        </motion.div>
        <motion.div className="flex h-full w-1/2 items-center px-6 py-16" style={{ x: imageX }}>
          <div className="flex h-[65vh] w-full items-center justify-center overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 shadow-sm">
            {item.mediaType === "video" ? (
              <video src={item.media} autoPlay muted loop playsInline className="h-full w-full object-cover" />
            ) : (
              <img src={item.media} alt={item.title} className="h-full w-full object-contain object-top bg-white" />
            )}
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}

/* ─── Hero + features — scroll sticky unifié ───────────────────── */
function HeroScrollSection({
  titleComponent,
  videoSrc,
}: {
  titleComponent: React.ReactNode;
  videoSrc: string;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Force le chargement complet de la vidéo dès le montage
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const init = () => { video.currentTime = 0; };

    // Déclenche le chargement si pas encore commencé
    if (video.readyState === 0) video.load();
    else init();

    video.addEventListener("loadedmetadata", init);
    video.addEventListener("loadeddata", init);
    video.addEventListener("canplaythrough", init);

    return () => {
      video.removeEventListener("loadedmetadata", init);
      video.removeEventListener("loadeddata", init);
      video.removeEventListener("canplaythrough", init);
    };
  }, []);

  const { scrollYProgress } = useScroll({ target: outerRef });

  // ── Phase 1 : rotation entrée ───────────────────────────────────
  const rotateX  = useTransform(scrollYProgress, [0, 0.07], [35, 0]);
  const scaleIn  = useTransform(scrollYProgress, [0, 0.07], isMobile ? [0.92, 1] : [1.08, 1]);

  // ── Phase 2 : lecture vidéo ─────────────────────────────────────
  const VIDEO_START = 0.05;
  const VIDEO_END   = 0.14;
  useMotionValueEvent(scrollYProgress, "change", (latest) => {
    const video = videoRef.current;
    if (!video || !video.duration || isNaN(video.duration)) return;
    if (latest < VIDEO_START) {
      video.currentTime = 0;
    } else if (latest <= VIDEO_END) {
      const progress = (latest - VIDEO_START) / (VIDEO_END - VIDEO_START);
      video.currentTime = Math.min(progress * video.duration, video.duration);
    }
    // après VIDEO_END : vidéo reste à la dernière frame
  });

  // ── Phase 3 : sortie carte ────────────────────────────────────────
  const cardExitScale = useTransform(scrollYProgress, [0.16, 0.24], [1, 0]);
  const cardOpacity   = useTransform(scrollYProgress, [0.20, 0.24], [1, 0]);

  // ── ScrollGooeyText ─────────────────────────────────────────────
  const gooeyOp       = useTransform(scrollYProgress, [0.24, 0.27, 0.35, 0.38], [0, 1, 1, 0]);
  const gooeyProgress = useTransform(scrollYProgress, [0.25, 0.36], [0, 1]);

  return (
    <div
      ref={outerRef}
      style={{
        height: "950vh",
        background: "#ffffff",
      }}
    >
      {/* Fond blanc — sans blobs */}

      {/* Titre en flux normal — espace sous la navbar */}
      <div className="relative z-10 flex flex-col items-center gap-2 px-6 pb-8 pt-10 text-center md:pt-14">
        {titleComponent}
      </div>

      {/* Sticky : toute la cinématique */}
      <div
        className="sticky top-0 z-10 overflow-hidden"
        style={{ height: "100dvh", perspective: "1200px", background: "#fff" }}
      >
        {/* Carte vidéo — combine rotateX (entrée) + rotateY/scale/x (sortie) */}
        <motion.div
          style={{
            rotateX,
            scale: scaleIn,
            scaleX: cardExitScale,
            scaleY: cardExitScale,
            opacity: cardOpacity,
            boxShadow: "0 0 #0000004d, 0 9px 20px #0000004a, 0 37px 37px #00000042, 0 84px 50px #00000026",
          }}
          className="absolute inset-x-3 inset-y-[3%] rounded-[14px] border-4 border-[#6C6C6C] bg-[#222222] p-1 shadow-2xl md:inset-y-8 md:inset-x-32 md:rounded-[28px] md:p-3"
        >
          <div className="h-full w-full overflow-hidden rounded-2xl bg-zinc-900">
            <video
              ref={videoRef}
              className="h-full w-full rounded-2xl object-contain scale-110 md:scale-100"
              muted
              playsInline
              preload="auto"
              // Réinitialise currentTime dès que la vidéo est prête
              onLoadedMetadata={(e) => { e.currentTarget.currentTime = 0; }}
              onLoadedData={(e) => { e.currentTarget.currentTime = 0; }}
              onCanPlay={(e) => { e.currentTarget.currentTime = 0; }}
              onCanPlayThrough={(e) => { e.currentTarget.currentTime = 0; }}
              // Retry si erreur de chargement
              onError={(e) => {
                const v = e.currentTarget;
                setTimeout(() => { v.load(); }, 1000);
              }}
            >
              <source src={videoSrc} type="video/mp4" />
              <source src={videoSrc} type="video/quicktime" />
            </video>
          </div>
        </motion.div>

        {/* GooeyText — morphe entre les 3 stats pendant la sortie de la carte */}
        <motion.div
          style={{ opacity: gooeyOp as unknown as number }}
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3"
        >
          <ScrollGooeyText
            texts={["100%", "30שנ׳", "0 קונפליקטים"]}
            labels={["אוטומציה בתכנון", "זמן יצירת סידור", "שגיאות שיבוץ"]}
            scrollProgress={gooeyProgress}
            className="w-full"
            textClassName="text-7xl font-black md:text-8xl gooey-gradient"
            labelClassName="text-xl font-semibold text-zinc-600"
          />
        </motion.div>

        {/* Features — enchaînement fluide après les stats */}
        {FEATURE_ITEMS.map((item, index) => (
          <FeatureSlidePanel
            key={item.title}
            item={item}
            scrollYProgress={scrollYProgress}
            index={index}
            total={FEATURE_ITEMS.length}
          />
        ))}
      </div>
    </div>
  );
}

/* ─── CTA sticky cinématique ─────────────────────────────────────── */
function CtaSection() {
  const outerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: outerRef });

  const titleLX  = useTransform(scrollYProgress, [0.03, 0.12], [-100, 0]);
  const titleRX  = useTransform(scrollYProgress, [0.03, 0.12], [100, 0]);
  const titleOp  = useTransform(scrollYProgress, [0.03, 0.12], [0, 1]);
  const descX    = useTransform(scrollYProgress, [0.10, 0.18], [-80, 0]);
  const descOp   = useTransform(scrollYProgress, [0.10, 0.18], [0, 1]);
  const btn1X    = useTransform(scrollYProgress, [0.16, 0.24], [100, 0]);
  const btn1Op   = useTransform(scrollYProgress, [0.16, 0.24], [0, 1]);
  const btn2X    = useTransform(scrollYProgress, [0.22, 0.30], [-100, 0]);
  const btn2Op   = useTransform(scrollYProgress, [0.22, 0.30], [0, 1]);
  const trustOp  = useTransform(scrollYProgress, [0.28, 0.36], [0, 1]);

  return (
    <div ref={outerRef} style={{ height: "500vh" }}>
      <section
        className="sticky top-0 flex h-screen items-center justify-center overflow-hidden bg-zinc-50"
        style={{ paddingTop: "var(--app-top-nav-height)" }}
      >
        <div className="mx-auto max-w-2xl px-6 text-center">
          {/* Titre — deux moitiés des côtés */}
          <div className="flex flex-wrap items-baseline justify-center gap-x-3">
            <motion.span style={{ x: titleLX, opacity: titleOp }}
              className="text-4xl font-bold text-zinc-900 sm:text-5xl">מוכן</motion.span>
            <motion.span style={{ x: titleRX, opacity: titleOp }}
              className="text-4xl font-bold text-zinc-900 sm:text-5xl">להתחיל?</motion.span>
          </div>

          {/* Description de gauche */}
          <motion.p style={{ x: descX, opacity: descOp }}
            className="mt-4 text-lg text-zinc-500">
            נהל את הצוות שלך בצורה חכמה יותר — תן ל-AI לבנות את הסידור בשבילך
          </motion.p>

          {/* Boutons des côtés opposés */}
          <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
            <motion.div style={{ x: btn1X, opacity: btn1Op }}>
              <Link
                href="/login/director"
                className="group relative inline-flex items-center gap-2 overflow-hidden rounded-xl px-9 py-4 text-base font-semibold text-white shadow-xl transition-transform duration-200 hover:scale-105"
                style={{ background: "linear-gradient(135deg, #00A8E0 0%, #0284c7 100%)", boxShadow: "0 0 40px rgba(0,168,224,0.35)" }}
              >
                <span aria-hidden className="absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ background: "linear-gradient(135deg, #0284c7 0%, #00A8E0 100%)" }} />
                <span className="relative">כניסת מנהל</span>
                <svg viewBox="0 0 20 20" fill="currentColor" className="relative h-4 w-4 rotate-180">
                  <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clipRule="evenodd" />
                </svg>
              </Link>
            </motion.div>

            <motion.div style={{ x: btn2X, opacity: btn2Op }}>
              <Link
                href="/register/director"
                className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 bg-white px-9 py-4 text-base font-semibold text-zinc-700 transition-all hover:bg-zinc-50 hover:scale-105"
              >
                הרשמה חינמית
              </Link>
            </motion.div>
          </div>

          <motion.p style={{ opacity: trustOp }} className="mt-6 text-sm text-zinc-400">
            גישה מיידית · ללא כרטיס אשראי · בעברית מלאה
          </motion.p>
        </div>
      </section>
    </div>
  );
}

/* ─── Landing page ───────────────────────────────────────────────── */
function LandingPage() {
  const hero = useReveal(0);

  return (
    <div dir="rtl">
      {/* ══ HERO — vidéo synchronisée au scroll ══════════════════════ */}
      <section className="relative">

        <HeroScrollSection
          videoSrc="/enregistrement-ecran-2026-06-03.mov"
          titleComponent={
            <div ref={hero.ref} className="flex flex-col items-center gap-1.5">
              <h1
                className="max-w-2xl text-3xl font-bold leading-tight text-zinc-900 sm:text-4xl md:text-5xl"
                style={{
                  opacity: hero.visible ? 1 : 0,
                  transform: hero.visible ? "translateY(0)" : "translateY(24px)",
                  transition: "opacity 0.7s ease 0.2s, transform 0.7s ease 0.2s",
                }}
              >
                <AnimatedHeroTitle
                  prefix="סידור עבודה"
                  words={["חכם", "מהיר", "אוטומטי", "מדויק", "פשוט"]}
                  interval={2000}
                />
              </h1>

              <p
                className="max-w-xl text-sm text-zinc-500 md:text-base"
                style={{
                  opacity: hero.visible ? 1 : 0,
                  transform: hero.visible ? "translateY(0)" : "translateY(24px)",
                  transition: "opacity 0.7s ease 0.35s, transform 0.7s ease 0.35s",
                }}
              >
                פלטפורמה מקצועית לשיבוץ משמרות, ניהול עובדים ותכנון שבועי —
                ה-AI עושה את העבודה הקשה בשבילך
              </p>

              <div
                className="flex flex-row gap-3"
                style={{
                  opacity: hero.visible ? 1 : 0,
                  transform: hero.visible ? "translateY(0)" : "translateY(20px)",
                  transition: "opacity 0.7s ease 0.5s, transform 0.7s ease 0.5s",
                }}
              >
                <Link
                  href="/login/director"
                  className="group relative inline-flex items-center gap-2 overflow-hidden rounded-xl px-6 py-2.5 text-sm font-semibold text-white shadow-lg transition-transform duration-200 hover:scale-105 active:scale-100"
                  style={{
                    background: "linear-gradient(135deg, #00A8E0 0%, #0284c7 100%)",
                    boxShadow: "0 0 24px rgba(0,168,224,0.35)",
                  }}
                >
                  <span aria-hidden className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100" style={{ background: "linear-gradient(135deg, #0284c7 0%, #00A8E0 100%)" }} />
                  <span className="relative">כניסת מנהל</span>
                </Link>
                <Link
                  href="/login/worker"
                  className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 bg-white px-6 py-2.5 text-sm font-semibold text-zinc-700 transition-all duration-200 hover:bg-zinc-50 hover:scale-105 active:scale-100"
                >
                  כניסת עובד
                </Link>
              </div>
            </div>
          }
        />

      </section>


      {/* ══ CTA — sticky cinématique ══════════════════════════════════ */}
      <CtaSection />

      {/* ══ FOOTER ════════════════════════════════════════════════════ */}
      <footer className="border-t border-zinc-200 bg-white px-6 py-8 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <img src="/g1-logo.png" alt="G1" width={32} height={32} />
            <span className="font-semibold text-zinc-700 dark:text-zinc-200">
              G1 Sidour Avoda
            </span>
          </div>
          <p className="text-sm text-zinc-400">© 2025 G1 · סידור עבודה חכם</p>
          <div className="flex gap-5 text-sm">
            <Link
              href="/login/director"
              className="text-zinc-400 transition-colors hover:text-[#00A8E0]"
            >
              מנהלים
            </Link>
            <Link
              href="/login/worker"
              className="text-zinc-400 transition-colors hover:text-[#00A8E0]"
            >
              עובדים
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import LoadingAnimation from "@/components/loading-animation";
import { AnimatedHeroTitle } from "@/components/ui/animated-hero";
import { Glow } from "@/components/ui/glow";
import { TextExpandSection } from "@/components/ui/scroll-expansion-hero";
import { SplineScene } from "@/components/ui/splite";
import { Spotlight } from "@/components/ui/spotlight";
import {
  useScroll,
  useTransform,
  useMotionValueEvent,
  motion,
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

/* ─── Animated number ticker (21st.dev style) ───────────────────── */
function NumberTicker({
  value,
  suffix = "",
}: {
  value: number;
  suffix?: string;
}) {
  const [display, setDisplay] = useState(0);
  const elRef = useRef<HTMLSpanElement>(null);
  const fired = useRef(false);
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const ob = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && !fired.current) {
          fired.current = true;
          const start = performance.now();
          const dur = 2000;
          const tick = (now: number) => {
            const t = Math.min((now - start) / dur, 1);
            const eased = 1 - (1 - t) ** 3;
            setDisplay(Math.round(eased * value));
            if (t < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      },
      { threshold: 0.5 },
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, [value]);
  return (
    <span ref={elRef}>
      {display}
      {suffix ? (suffix.startsWith(" ") ? suffix : ` ${suffix}`) : null}
    </span>
  );
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

type FeatureColor = (typeof FEATURES)[number]["color"];

const COLOR_STYLES: Record<
  FeatureColor,
  { border: string; icon: string; glow: string }
> = {
  blue: {
    border: "border-[#00A8E0]/20",
    icon: "bg-[#00A8E0]/10 text-[#00A8E0]",
    glow: "rgba(0,168,224,0.08)",
  },
  indigo: {
    border: "border-indigo-200 dark:border-indigo-800",
    icon: "bg-indigo-100 text-indigo-600 dark:bg-indigo-900/60 dark:text-indigo-400",
    glow: "rgba(99,102,241,0.08)",
  },
  green: {
    border: "border-emerald-200 dark:border-emerald-800",
    icon: "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/60 dark:text-emerald-400",
    glow: "rgba(16,185,129,0.08)",
  },
  amber: {
    border: "border-amber-200 dark:border-amber-800",
    icon: "bg-amber-100 text-amber-600 dark:bg-amber-900/60 dark:text-amber-400",
    glow: "rgba(245,158,11,0.08)",
  },
  purple: {
    border: "border-purple-200 dark:border-purple-800",
    icon: "bg-purple-100 text-purple-600 dark:bg-purple-900/60 dark:text-purple-400",
    glow: "rgba(147,51,234,0.08)",
  },
  rose: {
    border: "border-rose-200 dark:border-rose-800",
    icon: "bg-rose-100 text-rose-600 dark:bg-rose-900/60 dark:text-rose-400",
    glow: "rgba(244,63,94,0.08)",
  },
};

const STEPS = [
  {
    num: "01",
    emoji: "👤",
    title: "הרשמת מנהל",
    desc: "צור חשבון מנהל, הוסף את האתרים, התחנות וקבוצות המשמרות שלך",
  },
  {
    num: "02",
    emoji: "👥",
    title: "רישום עובדים",
    desc: "העובדים נרשמים עם קוד האתר ומסמנים את הזמינות השבועית שלהם",
  },
  {
    num: "03",
    emoji: "✨",
    title: "AI מייצר את הסידור",
    desc: 'לחץ "יצור תוכנית" וה-AI יבנה את שיבוץ המשמרות האופטימלי תוך שניות',
  },
];

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

/* ─── Hero + transition sortie vidéo ────────────────────────────── */
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

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.currentTime = 0;
  }, []);

  const { scrollYProgress } = useScroll({ target: outerRef });

  // ── Phase 1 : rotation entrée (0–18%) ──────────────────────────
  const rotateX  = useTransform(scrollYProgress, [0, 0.18], [35, 0]);
  const scaleIn  = useTransform(scrollYProgress, [0, 0.18], isMobile ? [0.92, 1] : [1.08, 1]);
  const translate = useTransform(scrollYProgress, [0, 0.18], [0, -50]);

  // ── Phase 2 : lecture vidéo (18–72%) ───────────────────────────
  const VIDEO_START = 0.18;
  const VIDEO_END   = 0.72;
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

  // ── Phase 3 : sortie (72–96%) — carte tourne sur elle-même + recule ─
  // Tourne jusqu'à 360° (droit), puis continue de reculer jusqu'à disparition
  const cardExitScale = useTransform(scrollYProgress, [0.72, 0.93], [1, 0]);
  const cardOpacity   = useTransform(scrollYProgress, [0.80, 0.93], [1, 0]);

  // ── Stats : entrent en alternance pendant la sortie de la carte ──
  const s1X  = useTransform(scrollYProgress, [0.73, 0.91], ["90vw",  "18vw"]);
  const s1Op = useTransform(scrollYProgress, [0.73, 0.89], [0, 1]);
  const s2X  = useTransform(scrollYProgress, [0.77, 0.94], ["-90vw", "-32vw"]);
  const s2Op = useTransform(scrollYProgress, [0.77, 0.92], [0, 1]);
  const s3X  = useTransform(scrollYProgress, [0.81, 0.97], ["90vw",  "18vw"]);
  const s3Op = useTransform(scrollYProgress, [0.81, 0.96], [0, 1]);
  const borderCol  = useTransform(s3Op, [0, 1], ["rgba(0,0,0,0)", "rgba(0,0,0,0.08)"]);
  const statsExitOp = useTransform(scrollYProgress, [0.96, 1.0], [1, 0]);

  return (
    <div
      ref={outerRef}
      style={{
        height: "950vh",
        background: "#ffffff",
      }}
    >
      {/* Fond blanc — sans blobs */}

      {/* Titre en flux normal */}
      <div className="relative z-10 flex flex-col items-center gap-2 px-6 py-8 text-center">
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
              onLoadedMetadata={(e) => { e.currentTarget.currentTime = 0; }}
              onLoadedData={(e) => { e.currentTarget.currentTime = 0; }}
              onCanPlay={(e) => { e.currentTarget.currentTime = 0; }}
            >
              <source src={videoSrc} type="video/mp4" />
            </video>
          </div>
        </motion.div>

        {/* Stats qui entrent en alternance gauche/droite */}
        {/* Wrapper : fondu de sortie groupé après apparition du 3ème */}
        <motion.div style={{ opacity: statsExitOp }} className="pointer-events-none absolute inset-0">
          {[
            { xMv: s1X, opMv: s1Op, value: "100%",         label: "אוטומציה בתכנון", desc: "ה-AI מטפל בכל השיבוצים",       num: "01", top: "22%" },
            { xMv: s2X, opMv: s2Op, value: "30שנ׳",        label: "זמן יצירת סידור", desc: "מהיר פי 100 מתכנון ידני",      num: "02", top: "45%" },
            { xMv: s3X, opMv: s3Op, value: "0 קונפליקטים", label: "שגיאות שיבוץ",   desc: "אלגוריתם אופטימיזציה מדויק",  num: "03", top: "68%" },
          ].map((s) => (
            <motion.div
              key={s.num}
              dir="rtl"
              style={{
                x: s.xMv,
                opacity: s.opMv,
                position: "absolute",
                top: s.top,
                left: "50%",
                translateX: "-50%",
                borderBottomColor: borderCol,
                borderBottomWidth: "1px",
                borderBottomStyle: "solid",
              }}
              className="flex w-[min(90vw,36rem)] items-baseline justify-between gap-4 py-4"
            >
              <div
                className="text-4xl font-black tabular-nums md:text-5xl flex-shrink-0"
                style={{
                  background: "linear-gradient(135deg, #00A8E0, #7dd3fc)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                }}
              >
                {s.value}
              </div>
              <div className="flex-1 text-right">
                <div className="text-base font-semibold text-zinc-900">{s.label}</div>
                <div className="mt-0.5 text-xs text-zinc-400">{s.desc}</div>
              </div>
              <span className="text-xs font-mono text-zinc-300 flex-shrink-0">{s.num}</span>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </div>
  );
}


/* ─── Features + robot Spline qui regarde les features ──────────── */
function FeaturesWithRobot() {
  const splineContainerRef = useRef<HTMLDivElement>(null);

  // Spline écoute mousemove + pointermove sur document — on dispatch aux coords réelles de la feature
  const dispatchAt = (x: number, y: number) => {
    const opts = { clientX: x, clientY: y, bubbles: true, cancelable: true };
    document.dispatchEvent(new MouseEvent("mousemove", opts));
    document.dispatchEvent(new PointerEvent("pointermove", opts));
  };

  const lookCenter = () => {
    const container = splineContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    dispatchAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  return (
    <section className="relative overflow-hidden bg-white py-20 px-6">
      <div className="relative z-10 mx-auto max-w-6xl">
        <motion.div
          className="mb-16 text-center"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7 }}
        >
          <p className="text-sm font-bold uppercase tracking-widest text-[#00A8E0]">יכולות</p>
          <h2 className="mt-3 text-4xl font-bold text-zinc-900 sm:text-5xl">הכל במקום אחד</h2>
          <p className="mx-auto mt-4 max-w-lg text-zinc-500">
            כלי ניהול מקצועיים שמחברים בין מנהלים, עובדים וה-AI לסידור עבודה חלק ויעיל
          </p>
        </motion.div>

        <div className="flex flex-col gap-12 lg:flex-row lg:items-center lg:gap-16">
          {/* Robot Spline */}
          <motion.div
            ref={splineContainerRef}
            className="flex-shrink-0 lg:w-[420px] h-[380px] lg:h-[520px] rounded-2xl overflow-hidden"
            style={{ border: "1px solid rgba(0,0,0,0.08)", background: "#0a0f1e" }}
            initial={{ opacity: 0, x: -40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.8, type: "spring", stiffness: 60 }}
          >
            <SplineScene
              scene="https://prod.spline.design/kZDDjO5HuC9GJUM2/scene.splinecode"
              className="w-full h-full"
            />
          </motion.div>

          {/* Liste des features */}
          <motion.div
            className="flex-1 divide-y divide-zinc-100"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.1 }}
            variants={{ visible: { transition: { staggerChildren: 0.09 } } }}
          >
            {FEATURES.map((f, i) => (
              <motion.div
                key={f.title}
                variants={{
                  hidden: { opacity: 0, x: 40 },
                  visible: { opacity: 1, x: 0, transition: { type: "spring", stiffness: 60, damping: 14 } },
                }}
                whileHover={{ x: -6, transition: { type: "spring", stiffness: 300 } }}
                onMouseEnter={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  dispatchAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
                }}
                onMouseLeave={lookCenter}
                className="flex items-start gap-5 py-5 cursor-default"
                dir="rtl"
              >
                <span className="mt-0.5 text-xl flex-shrink-0">{f.icon}</span>
                <div className="flex-1">
                  <h3 className="text-base font-bold text-zinc-900">{f.title}</h3>
                  <p className="mt-0.5 text-sm leading-relaxed text-zinc-500">{f.desc}</p>
                </div>
                <span className="text-xs font-mono text-zinc-300 flex-shrink-0">
                  {String(i + 1).padStart(2, "0")}
                </span>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </div>
    </section>
  );
}

/* ─── Landing page ───────────────────────────────────────────────── */
function LandingPage() {
  const hero = useReveal(0);
  const stats = useReveal(80);
  const feat = useReveal(0);
  const how = useReveal(0);
  const cta = useReveal(0);

  return (
    <div dir="rtl">
      {/* ══ HERO — vidéo synchronisée au scroll ══════════════════════ */}
      <section className="relative">

        <HeroScrollSection
          videoSrc="/enregistrement-ecran-2026-06-03.mov"
          titleComponent={
            <div ref={hero.ref} className="flex flex-col items-center gap-1.5">
              <img
                src="/g1-logo.png"
                alt="G1"
                width={48}
                height={48}
                style={{
                  opacity: hero.visible ? 1 : 0,
                  transform: hero.visible ? "scale(1)" : "scale(0.75)",
                  transition: "opacity 0.7s ease 0.1s, transform 0.7s ease 0.1s",
                }}
              />

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
                  suffix="לעסק שלך"
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


      {/* ══ FEATURES — robot Spline + liste ══════════════════════════ */}
      <FeaturesWithRobot />


      {/* ══ CTA ═══════════════════════════════════════════════════════ */}
      <section className="relative overflow-hidden bg-zinc-50 py-24 px-6">
        <div
          ref={cta.ref}
          className="relative z-10 mx-auto max-w-2xl text-center"
          style={{
            opacity: cta.visible ? 1 : 0,
            transform: cta.visible ? "translateY(0)" : "translateY(30px)",
            transition: "opacity 0.7s ease, transform 0.7s ease",
          }}
        >
          <h2 className="text-3xl font-bold text-zinc-900 sm:text-4xl">
            מוכן להתחיל?
          </h2>
          <p className="mt-4 text-lg text-zinc-500">
            נהל את הצוות שלך בצורה חכמה יותר — תן ל-AI לבנות את הסידור בשבילך
          </p>

          <div className="mt-9 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <Link
              href="/login/director"
              className="group relative inline-flex items-center gap-2 overflow-hidden rounded-xl px-9 py-4 text-base font-semibold text-white shadow-xl transition-transform duration-200 hover:scale-105 active:scale-100"
              style={{
                background: "linear-gradient(135deg, #00A8E0 0%, #0284c7 100%)",
                boxShadow: "0 0 48px rgba(0,168,224,0.4)",
              }}
            >
              <span
                aria-hidden
                className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                style={{
                  background:
                    "linear-gradient(135deg, #0284c7 0%, #00A8E0 100%)",
                }}
              />
              <span className="relative">כניסת מנהל</span>
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                className="relative h-4 w-4 rotate-180"
              >
                <path
                  fillRule="evenodd"
                  d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z"
                  clipRule="evenodd"
                />
              </svg>
            </Link>

            <Link
              href="/register/director"
              className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 bg-white px-9 py-4 text-base font-semibold text-zinc-700 transition-all duration-200 hover:bg-zinc-50 hover:scale-105 active:scale-100"
            >
              הרשמה חינמית
            </Link>
          </div>

          <p className="mt-6 text-sm text-zinc-400">
            גישה מיידית · ללא כרטיס אשראי · בעברית מלאה
          </p>
        </div>
      </section>

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

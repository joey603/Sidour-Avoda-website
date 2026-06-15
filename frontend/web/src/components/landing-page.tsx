"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import Image from "next/image";
import Link from "next/link";
import { AnimatedHeroTitle } from "@/components/ui/animated-hero";
import { ScrollGooeyText } from "@/components/ui/gooey-text-morphing";
import {
  useScroll,
  useTransform,
  useMotionValueEvent,
  motion,
  type MotionValue,
} from "framer-motion";
/* ─── Scroll progress (métriques cachées, sans layout thrash) ───── */
function useSectionScrollProgress(outerRef: RefObject<HTMLDivElement | null>) {
  const { scrollY } = useScroll();
  const metricsRef = useRef({ top: 0, length: 1 });

  const refresh = useCallback(() => {
    const el = outerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    metricsRef.current = {
      top: window.scrollY + rect.top,
      length: Math.max(el.offsetHeight - window.innerHeight, 1),
    };
  }, [outerRef]);

  useLayoutEffect(() => {
    refresh();
    window.addEventListener("resize", refresh, { passive: true });
    const ro = new ResizeObserver(refresh);
    const el = outerRef.current;
    if (el) ro.observe(el);
    return () => {
      window.removeEventListener("resize", refresh);
      ro.disconnect();
    };
  }, [refresh, outerRef]);

  return useTransform(scrollY, (v) => {
    const { top, length } = metricsRef.current;
    return Math.min(Math.max((v - top) / length, 0), 1);
  });
}

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
/* ─── Features (scroll cinématique unifié) — moved below for split ─ */

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
    media: "/rav-atariim-sites-list.webp",
    mediaType: "image",
  },
  {
    title: "תפקידים ושיבוצים",
    desc: "הגדר תפקידים לכל עובד, צפה בזמינות ושבץ אוטומטית לפי תפקיד בכל משמרת",
    media: "/tafkidim-planning.webp",
    mediaType: "image",
  },
  {
    title: "תפריט עובד",
    desc: "ממשק פשוט לעובדים — זמינות שבועית, היסטוריה ועדכונים בזמן אמת",
    media: "/worker-availability-menu.webp",
    mediaType: "image",
  },
];

const FEATURES_SCROLL_START = 0.43;

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
      className="landing-motion-layer pointer-events-none absolute inset-0 flex items-center bg-white"
      style={{ opacity }}
      dir="rtl"
    >
      <div className="flex h-full w-full flex-col items-center justify-center gap-6 px-5 pt-[var(--app-top-nav-height)] md:flex-row md:gap-0 md:px-0">
        <motion.div
          className="flex w-full flex-col items-center text-center md:w-1/2 md:items-end md:px-16 md:text-right"
          style={{ x: textX }}
        >
          <span
            dir="ltr"
            className="mb-3 inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700"
          >
            {String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
          </span>
          <h2 className="text-2xl font-bold text-zinc-900 sm:text-3xl md:text-4xl lg:text-5xl">{item.title}</h2>
          <motion.p
            className="mt-2 max-w-md text-center text-sm text-zinc-500 md:text-right md:text-base"
            style={{ opacity: descOp }}
          >
            {item.desc}
          </motion.p>
        </motion.div>
        <motion.div className="flex w-full items-center md:h-full md:w-1/2 md:px-6 md:py-16" style={{ x: imageX }}>
          <div className="relative flex h-[38vh] w-full items-center justify-center overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 shadow-md sm:h-[48vh] md:h-[65vh]">
            {item.mediaType === "video" ? (
              <video src={item.media} autoPlay muted loop playsInline className="h-full w-full object-cover" />
            ) : (
              <Image
                src={item.media}
                alt={item.title}
                fill
                sizes="(max-width: 768px) 100vw, 45vw"
                className="bg-white object-contain object-top"
                loading="lazy"
              />
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
  const [shouldLoadVideo, setShouldLoadVideo] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const ob = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShouldLoadVideo(true);
          ob.disconnect();
        }
      },
      { rootMargin: "120px" },
    );
    ob.observe(outer);
    return () => ob.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldLoadVideo) return;
    const video = videoRef.current;
    if (!video) return;

    const init = () => { video.currentTime = 0; };

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
  }, [shouldLoadVideo]);

  const { scrollYProgress } = useScroll({ target: outerRef });

  // ── Phase 1 : rotation entrée ───────────────────────────────────
  const rotateX  = useTransform(scrollYProgress, [0, 0.07], [35, 0]);
  const scaleIn  = useTransform(scrollYProgress, [0, 0.07], isMobile ? [0.92, 1] : [1.08, 1]);

  // ── Phase 2 : lecture vidéo ─────────────────────────────────────
  const VIDEO_START = 0.05;
  const VIDEO_END   = 0.14;
  const VIDEO_PAUSE_END = 0.19;
  const videoRafRef = useRef<number | null>(null);
  const videoTargetRef = useRef(0);

  useMotionValueEvent(scrollYProgress, "change", (latest) => {
    const video = videoRef.current;
    if (!video || !video.duration || isNaN(video.duration)) return;

    if (latest < VIDEO_START) {
      videoTargetRef.current = 0;
    } else if (latest <= VIDEO_END) {
      const progress = (latest - VIDEO_START) / (VIDEO_END - VIDEO_START);
      videoTargetRef.current = Math.min(progress * video.duration, video.duration);
    } else if (latest < VIDEO_PAUSE_END) {
      videoTargetRef.current = video.duration;
    } else {
      return;
    }

    if (videoRafRef.current != null) return;
    videoRafRef.current = requestAnimationFrame(() => {
      videoRafRef.current = null;
      const v = videoRef.current;
      if (!v) return;
      const target = videoTargetRef.current;
      if (Math.abs(v.currentTime - target) > 0.04) {
        v.currentTime = target;
      }
    });
  });

  // Pause scroll à la fin de la vidéo : bloque jusqu'au prochain scroll vers le bas
  const pauseUnlockedRef = useRef(false);
  const pauseScrollYRef = useRef(0);

  useEffect(() => {
    const outer = outerRef.current;
    if (!outer || isMobile) return;

    const refreshPauseY = () => {
      const rect = outer.getBoundingClientRect();
      const scrollable = Math.max(outer.offsetHeight - window.innerHeight, 1);
      pauseScrollYRef.current = window.scrollY + rect.top + VIDEO_END * scrollable;
    };

    refreshPauseY();
    window.addEventListener("resize", refreshPauseY, { passive: true });
    const ro = new ResizeObserver(refreshPauseY);
    ro.observe(outer);

    const clampToPause = () => {
      const pauseY = pauseScrollYRef.current;
      if (window.scrollY > pauseY + 1) {
        window.scrollTo({ top: pauseY, behavior: "auto" });
      }
    };

    const onScroll = () => {
      const pauseY = pauseScrollYRef.current;

      if (window.scrollY < pauseY - 40) {
        pauseUnlockedRef.current = false;
        return;
      }

      if (!pauseUnlockedRef.current && window.scrollY > pauseY + 1) {
        clampToPause();
      }
    };

    const onWheel = (e: WheelEvent) => {
      const pauseY = pauseScrollYRef.current;
      const y = window.scrollY;

      if (y < pauseY - 40) {
        pauseUnlockedRef.current = false;
        return;
      }

      if (!pauseUnlockedRef.current && y >= pauseY - 8 && e.deltaY > 0) {
        if (Math.abs(y - pauseY) > 2) {
          window.scrollTo({ top: pauseY, behavior: "auto" });
        }
        e.preventDefault();
        pauseUnlockedRef.current = true;
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("resize", refreshPauseY);
      ro.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onWheel);
      if (videoRafRef.current != null) {
        cancelAnimationFrame(videoRafRef.current);
      }
    };
  }, [isMobile]);

  // ── Phase 3 : la carte remonte avec le scroll (après la pause) ───
  const CARD_SCROLL_END = 0.29;
  const cardY = useTransform(
    scrollYProgress,
    [VIDEO_PAUSE_END, CARD_SCROLL_END],
    ["0vh", "-105vh"],
  );

  // ── ScrollGooeyText — démarre quand l'écran a quitté le viewport ─
  const gooeyOp       = useTransform(scrollYProgress, [CARD_SCROLL_END, CARD_SCROLL_END + 0.03, CARD_SCROLL_END + 0.11, CARD_SCROLL_END + 0.14], [0, 1, 1, 0]);
  const gooeyProgress = useTransform(scrollYProgress, [CARD_SCROLL_END + 0.01, CARD_SCROLL_END + 0.12], [0, 1]);

  return (
    <div
      ref={outerRef}
      className="relative"
      style={{
        height: "1000vh",
        background: "#ffffff",
      }}
    >
      {/* Halo doux derrière le hero */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[70vh]"
        style={{ background: "radial-gradient(ellipse 70% 50% at 50% 0%, rgba(0,168,224,0.10), transparent 65%)" }}
      />

      {/* Titre en flux normal — espace sous la navbar */}
      <div className="relative z-10 flex flex-col items-center gap-2 px-6 pb-8 pt-10 text-center md:pt-14">
        {titleComponent}
      </div>

      {/* Sticky : toute la cinématique */}
      <div
        className="sticky top-0 z-10 overflow-hidden"
        style={{ height: "100dvh", perspective: "1200px", background: "#fff", transform: "translateZ(0)" }}
      >
        {/* Carte vidéo — rotateX/scale à l'entrée, remonte hors écran après la vidéo */}
        <motion.div
          style={{
            rotateX,
            scale: scaleIn,
            y: cardY,
            boxShadow: "0 0 #0000004d, 0 9px 20px #0000004a, 0 37px 37px #00000042, 0 84px 50px #00000026",
          }}
          className="landing-motion-layer landing-motion-3d absolute inset-x-3 inset-y-[3%] z-20 rounded-[14px] border-4 border-[#6C6C6C] bg-[#222222] p-1 shadow-2xl md:inset-y-8 md:inset-x-32 md:rounded-[28px] md:p-3"
        >
          <div className="h-full w-full overflow-hidden rounded-2xl bg-zinc-900">
            <video
              ref={videoRef}
              className="h-full w-full rounded-2xl object-contain scale-110 md:scale-100"
              muted
              playsInline
              preload={shouldLoadVideo ? "metadata" : "none"}
              onLoadedMetadata={(e) => { e.currentTarget.currentTime = 0; }}
              onLoadedData={(e) => { e.currentTarget.currentTime = 0; }}
              onCanPlay={(e) => { e.currentTarget.currentTime = 0; }}
              onCanPlayThrough={(e) => { e.currentTarget.currentTime = 0; }}
              onError={(e) => {
                const v = e.currentTarget;
                setTimeout(() => { v.load(); }, 1000);
              }}
            >
              {shouldLoadVideo && (
                <source src={videoSrc} type="video/quicktime" />
              )}
            </video>
          </div>
        </motion.div>

        {/* GooeyText — démarre une fois la carte vidéo hors écran */}
        <motion.div
          style={{ opacity: gooeyOp as unknown as number }}
          className="landing-motion-layer pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3"
        >
          <ScrollGooeyText
            texts={["100%", "30שנ׳", "0 קונפליקטים"]}
            labels={["אוטומציה בתכנון", "זמן יצירת סידור", "שגיאות שיבוץ"]}
            scrollProgress={gooeyProgress}
            className="w-full px-4"
            textClassName="text-4xl font-black sm:text-6xl md:text-8xl gooey-gradient"
            labelClassName="text-base font-semibold text-zinc-600 md:text-xl"
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

/* ─── Grille de fonctionnalités (responsive, reveal en cascade) ──── */
const FEATURE_CHIP_STYLES: Record<string, string> = {
  blue: "bg-sky-50 text-sky-600 ring-sky-100",
  indigo: "bg-indigo-50 text-indigo-600 ring-indigo-100",
  green: "bg-emerald-50 text-emerald-600 ring-emerald-100",
  amber: "bg-amber-50 text-amber-600 ring-amber-100",
  purple: "bg-purple-50 text-purple-600 ring-purple-100",
  rose: "bg-rose-50 text-rose-600 ring-rose-100",
};

function FeatureGridCard({
  feature,
  index,
  scrollYProgress,
  cardsStart,
  cardSpan,
}: {
  feature: (typeof FEATURES)[number];
  index: number;
  scrollYProgress: MotionValue<number>;
  cardsStart: number;
  cardSpan: number;
}) {
  const start = cardsStart + index * cardSpan;
  const enterEnd = start + cardSpan * 0.7;

  const opacity = useTransform(scrollYProgress, [start, enterEnd], [0, 1]);
  const x = useTransform(scrollYProgress, [start, enterEnd], [100, 0]);
  const y = useTransform(scrollYProgress, [start, enterEnd], [28, 0]);

  return (
    <motion.div className="landing-motion-layer" style={{ opacity, x, y }}>
      <div className="group flex h-full flex-col items-center rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-sky-200 hover:shadow-lg">
        <div
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ring-1 sm:h-14 sm:w-14 ${FEATURE_CHIP_STYLES[feature.color] ?? FEATURE_CHIP_STYLES.blue}`}
        >
          {feature.icon}
        </div>
        <h3 className="mt-4 text-lg font-bold text-zinc-900 sm:text-xl">{feature.title}</h3>
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-zinc-500">{feature.desc}</p>
      </div>
    </motion.div>
  );
}

function FeaturesGridSection() {
  const outerRef = useRef<HTMLDivElement>(null);
  const scrollYProgress = useSectionScrollProgress(outerRef);

  const badgeOp = useTransform(scrollYProgress, [0.02, 0.07], [0, 1]);
  const titleX = useTransform(scrollYProgress, [0.04, 0.13], [140, 0]);
  const titleOp = useTransform(scrollYProgress, [0.04, 0.13], [0, 1]);
  const descX = useTransform(scrollYProgress, [0.09, 0.17], [-100, 0]);
  const descOp = useTransform(scrollYProgress, [0.09, 0.17], [0, 1]);

  const cardsStart = 0.2;
  const cardsEnd = 0.95;
  const cardSpan = (cardsEnd - cardsStart) / FEATURES.length;

  return (
    <div ref={outerRef} style={{ height: "520vh" }}>
      <section
        className="sticky top-0 min-h-screen overflow-x-hidden bg-gradient-to-b from-white via-sky-50/40 to-white py-10 md:flex md:h-screen md:items-center md:overflow-hidden md:py-0"
        style={{ paddingTop: "var(--app-top-nav-height)" }}
        dir="rtl"
      >
        <div className="mx-auto w-full max-w-5xl px-5 md:px-6">
          <div className="text-center">
            <motion.span
              style={{ opacity: badgeOp }}
              className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-4 py-1.5 text-xs font-semibold text-sky-700"
            >
              למה G1?
            </motion.span>
            <motion.h2
              style={{ x: titleX, opacity: titleOp }}
              className="landing-motion-layer mt-4 text-3xl font-bold text-zinc-900 sm:text-4xl"
            >
              כל מה שצריך לניהול משמרות
            </motion.h2>
            <motion.p
              style={{ x: descX, opacity: descOp }}
              className="landing-motion-layer mx-auto mt-3 max-w-xl text-sm text-zinc-500 md:text-base"
            >
              מהאלגוריתם ועד הממשק — הכל בנוי כדי לחסוך לך זמן ולמנוע טעויות שיבוץ
            </motion.p>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
            {FEATURES.map((feature, index) => (
              <FeatureGridCard
                key={feature.title}
                feature={feature}
                index={index}
                scrollYProgress={scrollYProgress}
                cardsStart={cardsStart}
                cardSpan={cardSpan}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

/* ─── CTA sticky cinématique ─────────────────────────────────────── */
function CtaSection() {
  const outerRef = useRef<HTMLDivElement>(null);
  const scrollYProgress = useSectionScrollProgress(outerRef);

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
    <div ref={outerRef} style={{ height: "300vh" }}>
      <section
        className="sticky top-0 flex h-screen items-center justify-center overflow-hidden bg-white"
        style={{ paddingTop: "var(--app-top-nav-height)" }}
      >
        <div className="relative mx-auto max-w-2xl px-6 text-center">
          {/* Titre — deux moitiés des côtés */}
          <div className="flex flex-wrap items-baseline justify-center gap-x-3">
            <motion.span style={{ x: titleLX, opacity: titleOp }}
              className="landing-motion-layer text-4xl font-bold text-zinc-900 sm:text-5xl">מוכן</motion.span>
            <motion.span style={{ x: titleRX, opacity: titleOp }}
              className="landing-motion-layer text-4xl font-bold text-zinc-900 sm:text-5xl">להתחיל?</motion.span>
          </div>

          {/* Description de gauche */}
          <motion.p style={{ x: descX, opacity: descOp }}
            className="landing-motion-layer mt-4 text-lg text-zinc-500">
            נהל את הצוות שלך בצורה חכמה יותר — תן ל-AI לבנות את הסידור בשבילך
          </motion.p>

          {/* Boutons des côtés opposés */}
          <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
            <motion.div className="landing-motion-layer" style={{ x: btn1X, opacity: btn1Op }}>
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

            <motion.div className="landing-motion-layer" style={{ x: btn2X, opacity: btn2Op }}>
              <Link
                href="/login/worker"
                className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 bg-white px-9 py-4 text-base font-semibold text-zinc-700 transition-all hover:bg-zinc-50 hover:scale-105"
              >
                כניסת עובד
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
export default function LandingPage() {
  const hero = useReveal(0);

  return (
    <div dir="rtl" className="landing-page">
      {/* ══ HERO — vidéo synchronisée au scroll ══════════════════════ */}
      <section className="relative">

        <HeroScrollSection
          videoSrc="/enregistrement-ecran-2026-06-03.mov"
          titleComponent={
            <div ref={hero.ref} className="flex flex-col items-center gap-2">
              <span
                className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-4 py-1.5 text-xs font-semibold text-sky-700"
                style={{
                  opacity: hero.visible ? 1 : 0,
                  transform: hero.visible ? "translateY(0)" : "translateY(16px)",
                  transition: "opacity 0.7s ease 0.05s, transform 0.7s ease 0.05s",
                }}
              >
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
                </span>
                מופעל על ידי AI
              </span>
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
                className="mt-1 flex flex-row flex-wrap items-center justify-center gap-3"
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

      {/* ══ FEATURES — grille responsive ══════════════════════════════ */}
      <FeaturesGridSection />

      {/* ══ CTA — sticky cinématique ══════════════════════════════════ */}
      <CtaSection />
    </div>
  );
}

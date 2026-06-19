"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { AnimatedHeroTitle } from "@/components/ui/animated-hero";
import { ScrollGooeyText } from "@/components/ui/gooey-text-morphing";
import { ElectricStatsCables } from "@/components/ui/electric-top-light";
import {
  useScroll,
  useTransform,
  useMotionValueEvent,
  motion,
  type MotionValue,
} from "framer-motion";

/* ─── Client / viewport (évite les sauts SSR → prod) ───────────── */
function useClientReady() {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => setReady(true), []);
  return ready;
}

function useLandingViewportRef() {
  const viewportRef = useRef({ isMobile: false, height: 800 });

  useLayoutEffect(() => {
    const sync = () => {
      viewportRef.current = {
        isMobile: window.innerWidth <= 768,
        height: window.innerHeight,
      };
    };
    sync();
    window.addEventListener("resize", sync, { passive: true });
    return () => window.removeEventListener("resize", sync);
  }, []);

  return viewportRef;
}

function lerpRange(
  value: number,
  [inMin, inMax]: [number, number],
  [outMin, outMax]: [number, number],
) {
  if (inMax === inMin) return outMax;
  const t = Math.min(Math.max((value - inMin) / (inMax - inMin), 0), 1);
  return outMin + (outMax - outMin) * t;
}

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

/* Réapparaît / disparaît selon le scroll (mobile) */
function useScrollReveal(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ob = new IntersectionObserver(
      ([e]) => setVisible(e.isIntersecting),
      { threshold },
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, [threshold]);
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


/* ─── Root page — landing publique (logo G1) ─────────────────────── */
export default function Home() {
  return <LandingPage />;
}

/* ─── Features (scroll cinématique unifié) ───────────────────────── */

type FeatureItem = {
  title: string;
  desc: string;
  media: string;
  mediaType: "image" | "video";
  layoutFlipped?: boolean;
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
    layoutFlipped: true,
  },
  {
    title: "תפריט עובד",
    desc: "ממשק פשוט לעובדים — זמינות שבועית, היסטוריה ועדכונים בזמן אמת",
    media: "/worker-availability-menu.png",
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
  const flipped = item.layoutFlipped ?? false;
  const textX = useTransform(scrollYProgress, [start, enterEnd], flipped ? [-140, 0] : [140, 0]);
  const imageX = useTransform(scrollYProgress, [start, enterEnd], flipped ? [140, 0] : [-140, 0]);
  const descOp = useTransform(scrollYProgress, [start + entrance * 0.45, enterEnd], [0, 1]);

  return (
    <motion.div
      className="landing-motion-layer pointer-events-none absolute inset-0 flex items-center bg-transparent"
      style={{ opacity }}
      dir={flipped ? "ltr" : "rtl"}
    >
      <div className="flex h-full w-full max-h-full flex-col items-center justify-center gap-1 px-2 py-2 max-md:justify-start max-md:pb-[max(0.5rem,env(safe-area-inset-bottom))] max-md:pt-2 md:flex-row md:items-center md:gap-0 md:px-0 md:py-0 md:pt-[var(--app-top-nav-height)]">
        <motion.div
          dir={flipped ? "rtl" : undefined}
          className={
            flipped
              ? "order-1 flex w-full shrink-0 flex-col items-center text-center max-md:px-1 md:order-none md:w-[40%] md:items-start md:ps-10 md:pe-20 md:text-right"
              : "order-1 flex w-full shrink-0 flex-col items-center text-center max-md:px-1 md:order-none md:w-[40%] md:items-start md:ps-20 md:pe-10 md:text-right"
          }
          style={{ x: textX }}
        >
          <h2 className="text-lg font-bold text-zinc-900 sm:text-2xl md:text-4xl lg:text-5xl">{item.title}</h2>
          <motion.p
            className="mt-0.5 max-w-md text-center text-xs leading-snug text-zinc-500 sm:mt-1 sm:text-sm md:mt-2 md:text-right md:text-base"
            style={{ opacity: descOp }}
          >
            {item.desc}
          </motion.p>
        </motion.div>
        <motion.div
          className={
            flipped
              ? "order-2 flex w-full min-h-0 max-md:flex-1 max-md:items-stretch md:order-none md:h-full md:w-[60%] md:flex-none md:items-center md:ps-8 md:pe-4 md:py-8"
              : "order-2 flex w-full min-h-0 max-md:flex-1 max-md:items-stretch md:order-none md:h-full md:w-[60%] md:flex-none md:items-center md:pe-8 md:ps-4 md:py-8"
          }
          style={{ x: imageX }}
        >
          <div className="flex h-full min-h-[min(58svh,28rem)] w-full max-w-full items-center justify-center overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 shadow-md sm:min-h-[min(60svh,30rem)] md:h-[73vh] md:min-h-0">
            {item.mediaType === "video" ? (
              <video src={item.media} autoPlay muted loop playsInline className="h-full w-full object-cover" />
            ) : (
              <img src={item.media} alt={item.title} className="h-full w-full bg-white object-contain object-center md:object-top" />
            )}
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}

/* ─── Hero + features — scroll sticky unifié ───────────────────── */
function HeroScrollSection({
  videoMp4Src,
  videoMovSrc,
  videoIntroReady = false,
}: {
  videoMp4Src: string;
  videoMovSrc: string;
  videoIntroReady?: boolean;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoResetDoneRef = useRef(false);
  const videoScrubReadyRef = useRef(false);
  const VIDEO_OFFSET_SEC = 1;
  const viewportRef = useLandingViewportRef();

  // Initialise une seule fois : Chrome peut relancer canplay/canplaythrough pendant les seeks.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const markScrubReady = () => {
      if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        videoScrubReadyRef.current = true;
      }
    };

    const init = () => {
      if (!videoResetDoneRef.current && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        video.currentTime = VIDEO_OFFSET_SEC;
        video.pause();
        videoResetDoneRef.current = true;
      }
      markScrubReady();
    };

    // Déclenche le chargement si pas encore commencé
    video.preload = "auto";
    if (video.readyState === 0) video.load();
    else init();

    video.addEventListener("loadedmetadata", init);
    video.addEventListener("loadeddata", markScrubReady);
    video.addEventListener("canplaythrough", markScrubReady);

    return () => {
      video.removeEventListener("loadedmetadata", init);
      video.removeEventListener("loadeddata", markScrubReady);
      video.removeEventListener("canplaythrough", markScrubReady);
    };
  }, []);

  const { scrollYProgress } = useScroll({ target: outerRef });

  // ── Phase 1 : rotation entrée ───────────────────────────────────
  const rotateX = useTransform(scrollYProgress, (v) => {
    const start = viewportRef.current.isMobile ? 16 : 35;
    return lerpRange(v, [0, 0.07], [start, 0]);
  });
  const scaleIn = useTransform(scrollYProgress, (v) => {
    const start = viewportRef.current.isMobile ? 0.96 : 1.08;
    return lerpRange(v, [0, 0.07], [start, 1]);
  });

  // ── Phase 2 : lecture vidéo ─────────────────────────────────────
  const VIDEO_START = 0.05;
  const VIDEO_END   = 0.14;
  const VIDEO_PAUSE_END = 0.19;
  const videoRafRef = useRef<number | null>(null);
  const videoTargetRef = useRef(VIDEO_OFFSET_SEC);

  useMotionValueEvent(scrollYProgress, "change", (latest) => {
    const video = videoRef.current;
    if (!video || !videoScrubReadyRef.current || !video.duration || isNaN(video.duration)) return;

    const playable = Math.max(video.duration - VIDEO_OFFSET_SEC, 0.01);

    if (latest < VIDEO_START) {
      videoTargetRef.current = VIDEO_OFFSET_SEC;
    } else if (latest <= VIDEO_END) {
      const progress = (latest - VIDEO_START) / (VIDEO_END - VIDEO_START);
      videoTargetRef.current = Math.min(VIDEO_OFFSET_SEC + progress * playable, video.duration);
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
      if (Math.abs(v.currentTime - target) > 0.1) {
        v.currentTime = target;
      }
    });
  });

  // Pause scroll à la fin de la vidéo : bloque jusqu'au prochain scroll vers le bas
  const pauseUnlockedRef = useRef(false);
  const pauseScrollYRef = useRef(0);
  const pauseClampRafRef = useRef<number | null>(null);

  useEffect(() => {
    const outer = outerRef.current;
    if (!outer || viewportRef.current.isMobile) return;

    const refreshPauseY = () => {
      const rect = outer.getBoundingClientRect();
      const scrollable = Math.max(outer.offsetHeight - window.innerHeight, 1);
      pauseScrollYRef.current = window.scrollY + rect.top + VIDEO_END * scrollable;
    };

    refreshPauseY();
    window.addEventListener("resize", refreshPauseY, { passive: true });
    const ro = new ResizeObserver(refreshPauseY);
    ro.observe(outer);

    const snapToPause = () => {
      const pauseY = pauseScrollYRef.current;
      if (Math.abs(window.scrollY - pauseY) <= 3) return;
      if (pauseClampRafRef.current != null) return;
      pauseClampRafRef.current = requestAnimationFrame(() => {
        pauseClampRafRef.current = null;
        window.scrollTo({ top: pauseScrollYRef.current, behavior: "auto" });
      });
    };

    const onWheel = (e: WheelEvent) => {
      const pauseY = pauseScrollYRef.current;
      const y = window.scrollY;

      if (y < pauseY - 40) {
        pauseUnlockedRef.current = false;
        return;
      }

      if (!pauseUnlockedRef.current && y >= pauseY - 8 && e.deltaY > 0) {
        e.preventDefault();
        snapToPause();
        pauseUnlockedRef.current = true;
      }
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("resize", refreshPauseY);
      ro.disconnect();
      window.removeEventListener("wheel", onWheel);
      if (pauseClampRafRef.current != null) {
        cancelAnimationFrame(pauseClampRafRef.current);
      }
      if (videoRafRef.current != null) {
        cancelAnimationFrame(videoRafRef.current);
      }
    };
  }, [viewportRef]);

  // ── Phase 3 : la carte remonte avec le scroll (après la pause) ───
  const CARD_SCROLL_END = 0.29;
  const cardY = useTransform(scrollYProgress, (v) =>
    lerpRange(v, [VIDEO_PAUSE_END, CARD_SCROLL_END], [0, -viewportRef.current.height * 1.05]),
  );

  // ── ScrollGooeyText — démarre quand l'écran a quitté le viewport ─
  const GOOEY_END = CARD_SCROLL_END + 0.18;
  const gooeyOp       = useTransform(scrollYProgress, [CARD_SCROLL_END, CARD_SCROLL_END + 0.03, GOOEY_END - 0.04, GOOEY_END], [0, 1, 1, 0]);
  const gooeyProgress = useTransform(scrollYProgress, [CARD_SCROLL_END + 0.01, GOOEY_END], [0, 1]);

  return (
    <div
      ref={outerRef}
      className="relative"
      style={{
        height: "1000vh",
      }}
    >
      {/* Sticky : toute la cinématique */}
      <div
        className="landing-sticky-viewport landing-sticky-shell landing-safe-insets relative sticky top-0 z-10 overflow-hidden"
      >
        {/* Carte vidéo — rotateX/scale à l'entrée, remonte hors écran après la vidéo */}
        <motion.div
          initial={false}
          animate={{ opacity: videoIntroReady ? 1 : 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
          style={{
            rotateX,
            scale: scaleIn,
            transformPerspective: 1200,
            pointerEvents: videoIntroReady ? "auto" : "none",
          }}
          className="landing-motion-layer landing-motion-3d absolute inset-x-2 inset-y-[3%] z-20 max-md:inset-y-[4%] md:inset-y-8 md:inset-x-32"
        >
          <motion.div
            style={{
              y: cardY,
              boxShadow: "0 0 #0000004d, 0 9px 20px #0000004a, 0 37px 37px #00000042, 0 84px 50px #00000026",
            }}
            className="h-full w-full rounded-[14px] border-4 border-[#6C6C6C] bg-[#222222] p-1 shadow-2xl md:rounded-[28px] md:p-3"
          >
          <div className="h-full w-full overflow-hidden rounded-2xl bg-zinc-900">
            <video
              ref={videoRef}
              className="h-full w-full rounded-2xl object-contain md:scale-100"
              muted
              playsInline
              preload="auto"
              crossOrigin="anonymous"
              // Retry si erreur de chargement
              onError={(e) => {
                const v = e.currentTarget;
                setTimeout(() => { v.load(); }, 1000);
              }}
            >
              <source src={videoMp4Src} type="video/mp4" />
              <source src={videoMovSrc} type="video/quicktime" />
            </video>
          </div>
          </motion.div>
        </motion.div>

        {/* GooeyText — démarre une fois la carte vidéo hors écran */}
        <motion.div
          style={{ opacity: gooeyOp as unknown as number }}
          className="landing-motion-layer pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-2 py-6"
        >
          <div className="landing-stats-top-halo pointer-events-none absolute inset-x-0 top-0 z-0" aria-hidden />
          <ElectricStatsCables
            color="#00A8E0"
            className="relative z-[1] w-full max-w-xl"
            scrollProgress={gooeyProgress}
            holdRatio={0.65}
            finalHoldRatio={0.35}
          >
            <ScrollGooeyText
              texts={["100%", "30שנ׳", "0 קונפליקטים"]}
              labels={["אוטומציה בתכנון", "זמן יצירת סידור", "שגיאות שיבוץ"]}
              scrollProgress={gooeyProgress}
              holdRatio={0.65}
              finalHoldRatio={0.35}
              className="w-full px-4"
              textClassName="text-3xl font-black leading-none sm:text-5xl md:text-7xl gooey-gradient"
              labelClassName="text-base font-semibold text-zinc-600 md:text-xl"
            />
          </ElectricStatsCables>
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

/* ─── Fond seamless landing (dégradé + lueurs sur toute la page) ─── */
function LandingPageBackdrop() {
  return (
    <div className="landing-page-backdrop" aria-hidden>
      <div className="landing-page-backdrop-gradient" />
      <div className="landing-page-glows">
        <span className="landing-glow-orb landing-glow-orb--p1" />
        <span className="landing-glow-orb landing-glow-orb--p2" />
        <span className="landing-glow-orb landing-glow-orb--p3" />
        <span className="landing-glow-orb landing-glow-orb--p4" />
        <span className="landing-glow-orb landing-glow-orb--p5" />
        <span className="landing-glow-orb landing-glow-orb--p6" />
        <span className="landing-glow-orb landing-glow-orb--p7" />
        <span className="landing-glow-orb landing-glow-orb--p8" />
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
  cardsEnd,
  cardSpan,
}: {
  feature: (typeof FEATURES)[number];
  index: number;
  scrollYProgress: MotionValue<number>;
  cardsStart: number;
  cardsEnd: number;
  cardSpan: number;
}) {
  const start = cardsStart + index * cardSpan;
  const enterEnd = start + cardSpan * 0.65;
  const isLast = index === FEATURES.length - 1;
  const opacityEnd = isLast ? Math.min(enterEnd + cardSpan * 0.12, cardsEnd) : enterEnd;

  const opacity = useTransform(
    scrollYProgress,
    isLast ? [start, enterEnd, opacityEnd] : [start, enterEnd],
    isLast ? [0, 1, 1] : [0, 1],
  );
  const x = useTransform(scrollYProgress, [start, enterEnd], [100, 0]);
  const y = useTransform(scrollYProgress, [start, enterEnd], [28, 0]);

  return (
    <motion.div className="landing-motion-layer" style={{ opacity, x, y }}>
      <FeatureGridCardContent feature={feature} />
    </motion.div>
  );
}

function FeatureGridCardContent({
  feature,
}: {
  feature: (typeof FEATURES)[number];
}) {
  return (
    <div className="group flex h-full flex-col items-center rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-sky-200 hover:shadow-lg">
      <div
        className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-xl ring-1 sm:h-16 sm:w-16 ${FEATURE_CHIP_STYLES[feature.color] ?? FEATURE_CHIP_STYLES.blue}`}
      >
        {feature.icon}
      </div>
      <h3 className="mt-4 text-lg font-bold text-zinc-900 sm:text-xl">{feature.title}</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-zinc-500">{feature.desc}</p>
    </div>
  );
}

function FeatureGridCardMobile({
  feature,
}: {
  feature: (typeof FEATURES)[number];
}) {
  const { ref, visible } = useScrollReveal(0.2);
  return (
    <div
      ref={ref}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(20px)",
        transition: "opacity 0.55s ease, transform 0.55s ease",
      }}
    >
      <FeatureGridCardContent feature={feature} />
    </div>
  );
}

function FeaturesGridSectionMobile() {
  const title = useScrollReveal(0.25);
  const desc = useScrollReveal(0.2);

  return (
    <section
      className="landing-safe-insets relative flex justify-center px-4 py-14 sm:px-5 sm:py-16"
      style={{ paddingTop: "calc(var(--app-top-nav-height) + 1rem)" }}
      dir="rtl"
    >
      <div className="relative z-[1] mx-auto flex w-full max-w-lg flex-col items-center">
        <div className="flex w-full flex-col items-center text-center">
          <h2
            ref={title.ref}
            className="w-full text-center text-2xl font-bold text-zinc-900 sm:text-3xl"
            style={{
              opacity: title.visible ? 1 : 0,
              transform: title.visible ? "translateY(0)" : "translateY(20px)",
              transition: "opacity 0.6s ease, transform 0.6s ease",
            }}
          >
            כל מה שצריך לניהול משמרות
          </h2>
          <p
            ref={desc.ref}
            className="mt-3 w-full max-w-sm text-center text-sm leading-relaxed text-zinc-500"
            style={{
              opacity: desc.visible ? 1 : 0,
              transform: desc.visible ? "translateY(0)" : "translateY(16px)",
              transition: "opacity 0.6s ease, transform 0.6s ease",
            }}
          >
            מהאלגוריתם ועד הממשק — הכל בנוי כדי לחסוך לך זמן ולמנוע טעויות שיבוץ
          </p>
        </div>

        <div className="mt-10 grid w-full grid-cols-1 gap-4">
          {FEATURES.map((feature, index) => (
            <FeatureGridCardMobile key={feature.title} feature={feature} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeaturesGridSectionDesktop() {
  const outerRef = useRef<HTMLDivElement>(null);
  const scrollYProgress = useSectionScrollProgress(outerRef);

  const titleX = useTransform(scrollYProgress, [0.04, 0.13], [140, 0]);
  const titleOp = useTransform(scrollYProgress, [0.04, 0.13], [0, 1]);
  const descX = useTransform(scrollYProgress, [0.09, 0.17], [-100, 0]);
  const descOp = useTransform(scrollYProgress, [0.09, 0.17], [0, 1]);

  const cardsStart = 0.2;
  const cardsEnd = 0.76;
  const cardSpan = (cardsEnd - cardsStart) / FEATURES.length;

  return (
    <div ref={outerRef} style={{ height: "620vh" }}>
      <section
        className="sticky top-0 landing-sticky-viewport landing-sticky-shell relative flex items-center overflow-hidden py-0"
        style={{ paddingTop: "var(--app-top-nav-height)" }}
        dir="rtl"
      >
        <div className="relative z-[1] mx-auto w-full max-w-5xl px-6">
          <div className="text-center">
            <motion.h2
              style={{ x: titleX, opacity: titleOp }}
              className="landing-motion-layer text-3xl font-bold text-zinc-900 sm:text-4xl"
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

          <div className="mt-10 grid grid-cols-2 gap-5 lg:grid-cols-3">
            {FEATURES.map((feature, index) => (
              <FeatureGridCard
                key={feature.title}
                feature={feature}
                index={index}
                scrollYProgress={scrollYProgress}
                cardsStart={cardsStart}
                cardsEnd={cardsEnd}
                cardSpan={cardSpan}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function FeaturesGridSection() {
  const [variant, setVariant] = useState<"pending" | "mobile" | "desktop">("pending");

  useLayoutEffect(() => {
    setVariant(window.innerWidth < 768 ? "mobile" : "desktop");
  }, []);

  if (variant === "pending") {
    return <div className="landing-safe-insets min-h-[50vh]" aria-hidden />;
  }
  if (variant === "mobile") return <FeaturesGridSectionMobile />;
  return <FeaturesGridSectionDesktop />;
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
        className="landing-sticky-viewport landing-sticky-shell landing-safe-insets relative sticky top-0 flex items-center justify-center overflow-hidden pb-[max(0.75rem,env(safe-area-inset-bottom))] max-md:px-4"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
      >
        <div className="relative z-[1] mx-auto max-w-2xl px-6 text-center">
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
function LandingPage() {
  const clientReady = useClientReady();
  const hero = useReveal(0);
  const [videoIntroReady, setVideoIntroReady] = useState(false);

  useEffect(() => {
    if (!hero.visible) return;
    const timer = window.setTimeout(() => setVideoIntroReady(true), 650);
    return () => window.clearTimeout(timer);
  }, [hero.visible]);

  return (
    <div dir="rtl" className="landing-page">
      <LandingPageBackdrop />
      <div className="relative z-[1]">
      {/* ══ HERO — titre + vidéo scroll ═══════════════════════════════ */}
      <section className="relative">
        <div className={`landing-hero-stage${videoIntroReady ? " landing-hero-stage--compact" : ""}`}>
          <div className="landing-hero-top relative">
            <div className="landing-hero-header landing-safe-insets relative flex w-full flex-col items-center gap-2 px-4 pb-6 text-center sm:px-6 sm:pb-8">
              <div ref={hero.ref} className="flex flex-col items-center gap-2">
            <h1
              className="max-w-2xl text-2xl font-bold leading-tight text-zinc-900 sm:text-4xl md:text-5xl"
              style={{
                opacity: hero.visible ? 1 : 0,
                transform: hero.visible ? "translateY(0)" : "translateY(24px)",
                transition: "opacity 0.45s ease, transform 0.45s ease",
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
                transition: "opacity 0.45s ease 0.08s, transform 0.45s ease 0.08s",
              }}
            >
              פלטפורמה מקצועית לשיבוץ משמרות, ניהול עובדים ותכנון שבועי —
              ה-AI עושה את העבודה הקשה בשבילך
            </p>

            <div
              className="mt-1 flex flex-row flex-wrap items-center justify-center gap-2 sm:gap-3"
              style={{
                opacity: hero.visible ? 1 : 0,
                transform: hero.visible ? "translateY(0)" : "translateY(20px)",
                transition: "opacity 0.45s ease 0.16s, transform 0.45s ease 0.16s",
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
        </div>
        </div>
        </div>

        {clientReady ? (
          <HeroScrollSection
            videoMp4Src="/enregistrement-ecran-2026-06-03-chrome.mp4"
            videoMovSrc="/enregistrement-ecran-2026-06-03.mov"
            videoIntroReady={videoIntroReady}
          />
        ) : (
          <div className="landing-hero-scroll-spacer" aria-hidden />
        )}

      </section>

      {/* ══ FEATURES — grille responsive ══════════════════════════════ */}
      {clientReady ? <FeaturesGridSection /> : null}

      {/* ══ CTA — sticky cinématique ══════════════════════════════════ */}
      {clientReady ? <CtaSection /> : null}
      </div>
    </div>
  );
}

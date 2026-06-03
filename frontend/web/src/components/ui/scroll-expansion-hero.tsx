'use client';

import { useEffect, useRef, useState, ReactNode } from 'react';
import { motion } from 'framer-motion';

interface TextExpandSectionProps {
  /** המילה הראשונה — תוזזה שמאלה בגלילה */
  firstWord: string;
  /** שאר הכותרת — תוזזת ימינה בגלילה */
  restOfTitle: string;
  /** טקסט קטן מעל הכותרת */
  label?: string;
  /** תוכן שמופיע אחרי שהכותרת נפתחת לגמרי */
  children?: ReactNode;
}

export function TextExpandSection({
  firstWord,
  restOfTitle,
  label,
  children,
}: TextExpandSectionProps) {
  const [scrollProgress, setScrollProgress] = useState(0);
  const [showContent, setShowContent] = useState(false);
  const [fullyExpanded, setFullyExpanded] = useState(false);
  const [touchStartY, setTouchStartY] = useState(0);
  const [isMobile, setIsMobile] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    const handleWheel = (e: Event) => {
      const we = e as globalThis.WheelEvent;
      if (fullyExpanded && we.deltaY < 0 && window.scrollY <= 5) {
        setFullyExpanded(false);
        we.preventDefault();
      } else if (!fullyExpanded) {
        we.preventDefault();
        const delta = we.deltaY * 0.001;
        setScrollProgress(prev => {
          const next = Math.min(Math.max(prev + delta, 0), 1);
          if (next >= 1) { setFullyExpanded(true); setShowContent(true); }
          else if (next < 0.7) setShowContent(false);
          return next;
        });
      }
    };

    const handleTouchStart = (e: Event) => {
      setTouchStartY((e as TouchEvent).touches[0].clientY);
    };

    const handleTouchMove = (e: Event) => {
      const te = e as TouchEvent;
      if (!touchStartY) return;
      const deltaY = touchStartY - te.touches[0].clientY;
      if (fullyExpanded && deltaY < -20 && window.scrollY <= 5) {
        setFullyExpanded(false);
        te.preventDefault();
      } else if (!fullyExpanded) {
        te.preventDefault();
        const factor = deltaY < 0 ? 0.008 : 0.005;
        setScrollProgress(prev => {
          const next = Math.min(Math.max(prev + deltaY * factor, 0), 1);
          if (next >= 1) { setFullyExpanded(true); setShowContent(true); }
          else if (next < 0.7) setShowContent(false);
          return next;
        });
        setTouchStartY(te.touches[0].clientY);
      }
    };

    const handleScroll = () => { if (!fullyExpanded) window.scrollTo(0, 0); };

    window.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('scroll', handleScroll);
    window.addEventListener('touchstart', handleTouchStart, { passive: false });
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', () => setTouchStartY(0));

    return () => {
      window.removeEventListener('wheel', handleWheel);
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
    };
  }, [scrollProgress, fullyExpanded, touchStartY]);

  const spread = scrollProgress * (isMobile ? 35 : 45);

  return (
    <div ref={sectionRef}>
      <section
        className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden"
        style={{ background: 'linear-gradient(135deg, #080d1a 0%, #0b1628 55%, #07111f 100%)' }}
      >
        {/* Glow */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(ellipse 70% 50% at 50% 50%, rgba(0,168,224,0.12) 0%, transparent 70%)' }}
        />

        {/* Label */}
        {label && (
          <motion.p
            className="relative z-10 mb-6 text-sm font-bold uppercase tracking-widest text-[#00A8E0]"
            animate={{ opacity: 1 - scrollProgress * 2 }}
          >
            {label}
          </motion.p>
        )}

        {/* Texte qui s'écarte */}
        <div className="relative z-10 flex flex-col items-center gap-2 select-none">
          <div
            className="text-5xl font-black text-white sm:text-6xl md:text-7xl"
            style={{ transform: `translateX(-${spread}vw)`, transition: 'none' }}
          >
            {firstWord}
          </div>
          <div
            className="text-5xl font-black text-center sm:text-6xl md:text-7xl"
            style={{
              transform: `translateX(${spread}vw)`,
              transition: 'none',
              background: 'linear-gradient(135deg, #00A8E0, #7dd3fc)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            {restOfTitle}
          </div>
        </div>

        {/* Scroll hint */}
        <motion.div
          className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 text-white/30 text-xs"
          animate={{ opacity: scrollProgress > 0.1 ? 0 : 1, y: scrollProgress > 0.1 ? 10 : 0 }}
          transition={{ duration: 0.3 }}
        >
          <span>גלול למטה</span>
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 animate-bounce">
            <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
          </svg>
        </motion.div>
      </section>

      {/* Contenu révélé après expansion complète */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: showContent ? 1 : 0 }}
        transition={{ duration: 0.6 }}
      >
        {children}
      </motion.div>
    </div>
  );
}

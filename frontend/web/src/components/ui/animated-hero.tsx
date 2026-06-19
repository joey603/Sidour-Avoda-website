"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";

interface AnimatedHeroTitleProps {
  /** טקסט קבוע לפני המילה המתחלפת */
  prefix: string;
  /** טקסט קבוע אחרי המילה המתחלפת */
  suffix?: string;
  /** רשימת המילים / ביטויים המתחלפים */
  words: string[];
  /** מרווח בין החלפות (ms) */
  interval?: number;
  className?: string;
}

export function AnimatedHeroTitle({
  prefix,
  suffix,
  words,
  interval = 2200,
  className = "",
}: AnimatedHeroTitleProps) {
  const [index, setIndex] = useState(0);
  const titles = useMemo(() => words, [words]);

  useEffect(() => {
    const id = setTimeout(() => {
      setIndex((prev) => (prev === titles.length - 1 ? 0 : prev + 1));
    }, interval);
    return () => clearTimeout(id);
  }, [index, titles, interval]);

  return (
    <span className={className}>
      {prefix}{" "}
      <span className="relative inline-flex justify-center overflow-hidden">
        {/* espace réservé pour la largeur */}
        <span className="invisible font-bold">
          {titles.reduce((a, b) => (a.length > b.length ? a : b))}
        </span>
        {titles.map((word, i) => (
          <motion.span
            key={word}
            className="absolute font-bold"
            style={{
              background:
                "linear-gradient(135deg, #00A8E0 0%, #93c5fd 50%, #00A8E0 100%)",
              backgroundSize: "200% 200%",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              animation: "g1Shimmer 3.5s linear infinite",
            }}
            initial={{ opacity: 0, y: -40 }}
            animate={
              index === i
                ? { opacity: 1, y: 0 }
                : { opacity: 0, y: index > i ? -40 : 40 }
            }
            transition={{ type: "tween", ease: [0.22, 1, 0.36, 1], duration: 0.42 }}
          >
            {word}
          </motion.span>
        ))}
      </span>
      {suffix && <> {suffix}</>}
    </span>
  );
}

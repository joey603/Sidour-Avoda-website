"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { MotionValue, useMotionValueEvent } from "framer-motion";

interface GooeyTextProps {
  texts: string[];
  morphTime?: number;
  cooldownTime?: number;
  className?: string;
  textClassName?: string;
}

/** Version automatique (cycle temporel) */
export function GooeyText({
  texts,
  morphTime = 1,
  cooldownTime = 0.25,
  className,
  textClassName,
}: GooeyTextProps) {
  const text1Ref = React.useRef<HTMLSpanElement>(null);
  const text2Ref = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    let textIndex = texts.length - 1;
    let time = new Date();
    let morph = 0;
    let cooldown = cooldownTime;
    let rafId: number;

    const setMorph = (fraction: number) => {
      if (!text1Ref.current || !text2Ref.current) return;
      text2Ref.current.style.filter = `blur(${Math.min(8 / fraction - 8, 100)}px)`;
      text2Ref.current.style.opacity = `${Math.pow(fraction, 0.4) * 100}%`;
      const f2 = 1 - fraction;
      text1Ref.current.style.filter = `blur(${Math.min(8 / f2 - 8, 100)}px)`;
      text1Ref.current.style.opacity = `${Math.pow(f2, 0.4) * 100}%`;
    };

    const doCooldown = () => {
      morph = 0;
      if (!text1Ref.current || !text2Ref.current) return;
      text2Ref.current.style.filter = "";
      text2Ref.current.style.opacity = "100%";
      text1Ref.current.style.filter = "";
      text1Ref.current.style.opacity = "0%";
    };

    const doMorph = () => {
      morph -= cooldown;
      cooldown = 0;
      let fraction = morph / morphTime;
      if (fraction > 1) { cooldown = cooldownTime; fraction = 1; }
      setMorph(fraction);
    };

    const animate = () => {
      rafId = requestAnimationFrame(animate);
      const newTime = new Date();
      const shouldIncrementIndex = cooldown > 0;
      const dt = (newTime.getTime() - time.getTime()) / 1000;
      time = newTime;
      cooldown -= dt;
      if (cooldown <= 0) {
        if (shouldIncrementIndex) {
          textIndex = (textIndex + 1) % texts.length;
          if (text1Ref.current && text2Ref.current) {
            text1Ref.current.textContent = texts[textIndex % texts.length];
            text2Ref.current.textContent = texts[(textIndex + 1) % texts.length];
          }
        }
        doMorph();
      } else {
        doCooldown();
      }
    };

    animate();
    return () => cancelAnimationFrame(rafId);
  }, [texts, morphTime, cooldownTime]);

  return (
    <div className={cn("relative", className)}>
      <svg className="absolute h-0 w-0" aria-hidden="true" focusable="false">
        <defs>
          <filter id="gooey-threshold">
            <feColorMatrix in="SourceGraphic" type="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 255 -140" />
          </filter>
        </defs>
      </svg>
      <div className="flex items-center justify-center" style={{ filter: "url(#gooey-threshold)" }}>
        <span ref={text1Ref} className={cn("absolute inline-block select-none text-center", textClassName)} />
        <span ref={text2Ref} className={cn("absolute inline-block select-none text-center", textClassName)} />
      </div>
    </div>
  );
}

interface ScrollGooeyTextProps {
  texts: string[];
  scrollProgress: MotionValue<number>;
  className?: string;
  textClassName?: string;
  labelClassName?: string;
  labels?: string[];
  /** 0–1 : fraction de chaque segment passée à afficher le texte statique avant de muter (défaut 0.6) */
  holdRatio?: number;
}

/** Version pilotée par le scroll — pas d'animation automatique */
export function ScrollGooeyText({
  texts,
  scrollProgress,
  className,
  textClassName,
  labelClassName,
  labels,
  holdRatio = 0.65,
}: ScrollGooeyTextProps) {
  const text1Ref = React.useRef<HTMLSpanElement>(null);
  const text2Ref = React.useRef<HTMLSpanElement>(null);
  const label1Ref = React.useRef<HTMLSpanElement>(null);
  const label2Ref = React.useRef<HTMLSpanElement>(null);

  // Initialise les textes
  React.useEffect(() => {
    if (text1Ref.current) text1Ref.current.textContent = texts[0];
    if (text2Ref.current) text2Ref.current.textContent = texts[1] ?? texts[0];
    if (label1Ref.current && labels) label1Ref.current.textContent = labels[0];
    if (label2Ref.current && labels) label2Ref.current.textContent = labels[1] ?? labels?.[0] ?? "";
  }, [texts, labels]);

  useMotionValueEvent(scrollProgress, "change", (latest) => {
    const n = texts.length;
    const transitions = n - 1;
    const segLen = 1 / transitions;
    const seg = Math.min(Math.floor(latest / segLen), transitions - 1);
    const rawFrac = (latest - seg * segLen) / segLen; // 0→1 brut dans le segment

    // holdRatio = portion statique, (1-holdRatio) = portion de morph
    const morphStart = holdRatio;
    const frac = rawFrac < morphStart
      ? 0                                               // texte statique
      : (rawFrac - morphStart) / (1 - morphStart);     // morph 0→1

    const idx1 = Math.min(seg, n - 1);
    const idx2 = Math.min(seg + 1, n - 1);

    if (text1Ref.current) text1Ref.current.textContent = texts[idx1];
    if (text2Ref.current) text2Ref.current.textContent = texts[idx2];
    if (label1Ref.current && labels) label1Ref.current.textContent = labels[idx1] ?? "";
    if (label2Ref.current && labels) label2Ref.current.textContent = labels[idx2] ?? "";

    // Applique l'effet gooey
    const applyMorph = (f: number) => {
      if (!text1Ref.current || !text2Ref.current) return;
      if (f <= 0) {
        text1Ref.current.style.filter = ""; text1Ref.current.style.opacity = "0%";
        text2Ref.current.style.filter = ""; text2Ref.current.style.opacity = "100%";
        if (label1Ref.current) { label1Ref.current.style.filter = ""; label1Ref.current.style.opacity = "100%"; }
        if (label2Ref.current) { label2Ref.current.style.filter = ""; label2Ref.current.style.opacity = "0%"; }
        return;
      }
      const inv = 1 - f;
      text2Ref.current.style.filter = `blur(${Math.min(8 / f - 8, 100)}px)`;
      text2Ref.current.style.opacity = `${Math.pow(f, 0.4) * 100}%`;
      text1Ref.current.style.filter = `blur(${Math.min(8 / inv - 8, 100)}px)`;
      text1Ref.current.style.opacity = `${Math.pow(inv, 0.4) * 100}%`;
      // Labels : crossfade simple sans blur pour rester nets
      if (label1Ref.current) {
        label1Ref.current.style.filter = "";
        label1Ref.current.style.opacity = `${(1 - f) * 100}%`;
      }
      if (label2Ref.current) {
        label2Ref.current.style.filter = "";
        label2Ref.current.style.opacity = `${f * 100}%`;
      }
    };

    // Dernière position : reste sur le dernier texte
    if (latest >= 1) {
      if (text1Ref.current) text1Ref.current.textContent = texts[n - 1];
      if (text2Ref.current) text2Ref.current.textContent = texts[n - 1];
      if (label1Ref.current && labels) label1Ref.current.textContent = labels[n - 1] ?? "";
      if (label2Ref.current && labels) label2Ref.current.textContent = labels[n - 1] ?? "";
      applyMorph(0);
    } else {
      applyMorph(Math.min(Math.max(frac, 0.001), 0.999));
    }
  });

  return (
    <div className={cn("relative flex flex-col items-center gap-4", className)}>
      <svg className="absolute h-0 w-0" aria-hidden="true" focusable="false">
        <defs>
          <filter id="scroll-gooey">
            <feColorMatrix in="SourceGraphic" type="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 255 -140" />
          </filter>
        </defs>
      </svg>

      {/* Nombre */}
      <div className="relative flex h-24 w-full items-center justify-center"
        style={{ filter: "url(#scroll-gooey)" }}>
        <span ref={text1Ref} className={cn("absolute inline-block select-none text-center", textClassName)} />
        <span ref={text2Ref} className={cn("absolute inline-block select-none text-center", textClassName)} />
      </div>

      {/* Label */}
      {labels && (
        <div className="relative flex h-8 w-full items-center justify-center">
          <span ref={label1Ref} className={cn("absolute inline-block select-none text-center", labelClassName)} />
          <span ref={label2Ref} className={cn("absolute inline-block select-none text-center", labelClassName)} />
        </div>
      )}
    </div>
  );
}

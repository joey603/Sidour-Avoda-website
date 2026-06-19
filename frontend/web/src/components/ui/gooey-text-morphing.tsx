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

export type GooeyScrollState =
  | { mode: "final-hold"; index: number }
  | { mode: "hold"; index: number }
  | { mode: "morph"; indexFrom: number; indexTo: number; frac: number };

/** Résout l'état d'affichage à partir du scroll (partagé avec ElectricStatsCables). */
export function resolveGooeyScrollState(
  latest: number,
  statCount: number,
  holdRatio: number,
  finalHoldRatio: number,
): GooeyScrollState {
  const activeRange = 1 - finalHoldRatio;

  if (latest >= activeRange) {
    return { mode: "final-hold", index: statCount - 1 };
  }

  const normalized = latest / activeRange;
  const transitions = statCount - 1;
  const segLen = 1 / transitions;
  const seg = Math.min(Math.floor(normalized / segLen), transitions - 1);
  const rawFrac = (normalized - seg * segLen) / segLen;

  if (rawFrac < holdRatio) {
    return { mode: "hold", index: seg };
  }

  const frac = (rawFrac - holdRatio) / (1 - holdRatio);
  return {
    mode: "morph",
    indexFrom: seg,
    indexTo: Math.min(seg + 1, statCount - 1),
    frac: Math.min(Math.max(frac, 0.001), 0.999),
  };
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
  /** 0–1 : portion finale du scroll réservée à la dernière stat (défaut 0.35) */
  finalHoldRatio?: number;
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
  finalHoldRatio = 0.35,
}: ScrollGooeyTextProps) {
  const text1Ref = React.useRef<HTMLSpanElement>(null);
  const text2Ref = React.useRef<HTMLSpanElement>(null);
  const label1Ref = React.useRef<HTMLSpanElement>(null);
  const label2Ref = React.useRef<HTMLSpanElement>(null);
  const lastStaticIndexRef = React.useRef<number | null>(null);
  const lastMorphPairRef = React.useRef("");

  // Initialise les textes
  React.useEffect(() => {
    if (text1Ref.current) text1Ref.current.textContent = texts[0];
    if (text2Ref.current) text2Ref.current.textContent = texts[1] ?? texts[0];
    if (label1Ref.current && labels) label1Ref.current.textContent = labels[0];
    if (label2Ref.current && labels) label2Ref.current.textContent = labels[1] ?? labels?.[0] ?? "";
    lastStaticIndexRef.current = null;
    lastMorphPairRef.current = "";
  }, [texts, labels]);

  useMotionValueEvent(scrollProgress, "change", (latest) => {
    const state = resolveGooeyScrollState(latest, texts.length, holdRatio, finalHoldRatio);

    const showStatic = (idx: number) => {
      if (lastStaticIndexRef.current === idx) return;
      lastStaticIndexRef.current = idx;
      lastMorphPairRef.current = "";
      if (text1Ref.current) {
        text1Ref.current.textContent = texts[idx];
        text1Ref.current.style.filter = "";
        text1Ref.current.style.opacity = "100%";
      }
      if (text2Ref.current) {
        text2Ref.current.textContent = texts[idx];
        text2Ref.current.style.filter = "";
        text2Ref.current.style.opacity = "0%";
      }
      if (label1Ref.current && labels) {
        label1Ref.current.textContent = labels[idx] ?? "";
        label1Ref.current.style.filter = "";
        label1Ref.current.style.opacity = "100%";
      }
      if (label2Ref.current && labels) {
        label2Ref.current.textContent = labels[idx] ?? "";
        label2Ref.current.style.filter = "";
        label2Ref.current.style.opacity = "0%";
      }
    };

    const applyMorph = (idx1: number, idx2: number, f: number) => {
      if (!text1Ref.current || !text2Ref.current) return;
      const pair = `${idx1}:${idx2}`;
      if (lastMorphPairRef.current !== pair) {
        lastMorphPairRef.current = pair;
        lastStaticIndexRef.current = null;
        text1Ref.current.textContent = texts[idx1];
        text2Ref.current.textContent = texts[idx2];
        if (label1Ref.current && labels) label1Ref.current.textContent = labels[idx1] ?? "";
        if (label2Ref.current && labels) label2Ref.current.textContent = labels[idx2] ?? "";
      }

      const inv = 1 - f;
      text2Ref.current.style.filter = `blur(${Math.min(8 / f - 8, 100)}px)`;
      text2Ref.current.style.opacity = `${Math.pow(f, 0.4) * 100}%`;
      text1Ref.current.style.filter = `blur(${Math.min(8 / inv - 8, 100)}px)`;
      text1Ref.current.style.opacity = `${Math.pow(inv, 0.4) * 100}%`;
      if (label1Ref.current) {
        label1Ref.current.style.filter = "";
        label1Ref.current.style.opacity = `${inv * 100}%`;
      }
      if (label2Ref.current) {
        label2Ref.current.style.filter = "";
        label2Ref.current.style.opacity = `${f * 100}%`;
      }
    };

    if (state.mode === "final-hold" || state.mode === "hold") {
      showStatic(state.index);
      return;
    }

    applyMorph(state.indexFrom, state.indexTo, state.frac);
  });

  return (
    <div className={cn("relative flex flex-col items-center gap-6", className)}>
      <svg className="absolute h-0 w-0" aria-hidden="true" focusable="false">
        <defs>
          <filter id="scroll-gooey">
            <feColorMatrix in="SourceGraphic" type="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 255 -140" />
          </filter>
        </defs>
      </svg>

      {/* Nombre */}
      <div
        className="relative flex min-h-[5.5rem] w-full items-center justify-center sm:min-h-[7rem] md:min-h-[9rem]"
        style={{ filter: "url(#scroll-gooey)" }}
      >
        <span
          ref={text1Ref}
          className={cn(
            "absolute inset-x-0 top-1/2 inline-block -translate-y-1/2 select-none text-center leading-none",
            textClassName,
          )}
        />
        <span
          ref={text2Ref}
          className={cn(
            "absolute inset-x-0 top-1/2 inline-block -translate-y-1/2 select-none text-center leading-none",
            textClassName,
          )}
        />
      </div>

      {/* Label */}
      {labels && (
        <div className="relative flex min-h-10 w-full shrink-0 items-center justify-center">
          <span ref={label1Ref} className={cn("absolute inset-x-0 inline-block select-none text-center", labelClassName)} />
          <span ref={label2Ref} className={cn("absolute inset-x-0 inline-block select-none text-center", labelClassName)} />
        </div>
      )}
    </div>
  );
}

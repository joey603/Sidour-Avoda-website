"use client";

import { useId, useState, type ReactNode } from "react";
import { type MotionValue, useMotionValueEvent } from "framer-motion";
import { resolveGooeyScrollState } from "@/components/ui/gooey-text-morphing";
import { cn } from "@/lib/utils";

const CABLE_PATH =
  "M 69 49.8 h -30 q -3 0 -3 -3 v -13 q 0 -3 -3 -3 h -23 q -3 0 -3 -3 v -13 q 0 -3 -3 -3 h -30";

/** 100% → haut, 30 שנ׳ → bas, 0 קונפליקטים → haut */
const CABLE_BY_STAT_INDEX = ["top", "bottom", "top"] as const;

function getDominantStatIndex(
  progress: number,
  statCount: number,
  holdRatio: number,
  finalHoldRatio: number,
) {
  const state = resolveGooeyScrollState(progress, statCount, holdRatio, finalHoldRatio);
  if (state.mode === "final-hold" || state.mode === "hold") return state.index;
  return state.frac < 0.5 ? state.indexFrom : state.indexTo;
}

function ElectricCableLight({
  color,
  position,
  duration,
  visible,
}: {
  color: string;
  position: "top" | "bottom";
  duration: number;
  visible: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const maskId = `etl-mask-${position}-${uid}`;
  const gradId = `etl-grad-${position}-${uid}`;

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 flex h-16 w-full justify-center transition-opacity duration-300 sm:h-20",
        position === "top" ? "bottom-full" : "top-full scale-y-[-1]",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <svg
        className="h-full w-[min(100%,220px)]"
        viewBox="0 0 80 50"
        fill="none"
        preserveAspectRatio="xMidYMid meet"
      >
        <g mask={`url(#${maskId})`}>
          <circle
            className={visible ? "electric-top-light-dot" : undefined}
            style={{ animationDuration: `${duration}s` }}
            cx="0"
            cy="0"
            r="10"
            fill={`url(#${gradId})`}
          />
        </g>
        <defs>
          <mask id={maskId}>
            <path d={CABLE_PATH} strokeWidth="0.6" stroke="white" fill="none" />
          </mask>
          <radialGradient id={gradId} fx="0.5" fy="0.5">
            <stop offset="0%" stopColor={color} />
            <stop offset="35%" stopColor={color} stopOpacity="0.85" />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>
        </defs>
      </svg>
    </div>
  );
}

type ElectricStatsCablesProps = {
  children: ReactNode;
  scrollProgress: MotionValue<number>;
  statCount?: number;
  holdRatio?: number;
  finalHoldRatio?: number;
  color?: string;
  className?: string;
  duration?: number;
};

/** Câble unique synchronisé avec la stat Gooey affichée. */
export function ElectricStatsCables({
  children,
  scrollProgress,
  statCount = 3,
  holdRatio = 0.65,
  finalHoldRatio = 0.35,
  color = "#00A8E0",
  className,
  duration = 2.2,
}: ElectricStatsCablesProps) {
  const [cablePosition, setCablePosition] = useState<"top" | "bottom">("top");

  useMotionValueEvent(scrollProgress, "change", (latest) => {
    const idx = getDominantStatIndex(latest, statCount, holdRatio, finalHoldRatio);
    setCablePosition(CABLE_BY_STAT_INDEX[idx] ?? "top");
  });

  return (
    <div className={cn("relative inline-flex flex-col items-center", className)}>
      <ElectricCableLight
        color={color}
        position="top"
        duration={duration}
        visible={cablePosition === "top"}
      />
      {children}
      <ElectricCableLight
        color={color}
        position="bottom"
        duration={duration}
        visible={cablePosition === "bottom"}
      />
    </div>
  );
}

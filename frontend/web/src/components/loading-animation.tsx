"use client";

import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import animationData from "@/assets/material-wave-loading.json";

// Import dynamique pour éviter les problèmes SSR
const Lottie = dynamic(() => import("lottie-react"), { ssr: false });

interface LoadingAnimationProps {
  className?: string;
  size?: number;
}

export default function LoadingAnimation({ className = "", size = 64 }: LoadingAnimationProps) {
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <Lottie animationData={animationData} loop={true} style={{ width: size, height: size }} />
    </div>
  );
}

interface LoadingOverlayProps {
  size?: number;
}

/** Surcouverture haute : status bar / encoche iOS quand le fixed est décalé. */
const OVERLAY_TOP_OVERSCAN_PX = 80;

/**
 * Aligne l’overlay sur le visualViewport et sur-étend vers le haut
 * pour éviter une bande non floutée (Safari / PWA plein écran).
 */
function useVisualViewportOverlayStyle(enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el || typeof window === "undefined") return;

    const sync = () => {
      const vv = window.visualViewport;
      const topPad = OVERLAY_TOP_OVERSCAN_PX;
      const bottomPad = OVERLAY_TOP_OVERSCAN_PX;

      if (!vv) {
        el.style.top = `-${topPad}px`;
        el.style.left = "0px";
        el.style.width = "100vw";
        el.style.height = `calc(100dvh + ${topPad + bottomPad}px)`;
        return;
      }

      el.style.top = `${vv.offsetTop - topPad}px`;
      el.style.left = `${vv.offsetLeft}px`;
      el.style.width = `${vv.width}px`;
      el.style.height = `${vv.height + topPad + bottomPad}px`;
    };

    sync();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", sync);
    vv?.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    return () => {
      vv?.removeEventListener("resize", sync);
      vv?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
    };
  }, [enabled]);

  return ref;
}

/** Overlay plein écran (flou + opacité) avec animation centrée — fiable en PWA / mode standalone. */
export function LoadingOverlay({ size = 96 }: LoadingOverlayProps) {
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const overlayRef = useVisualViewportOverlayStyle(!!portalTarget);

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  const overlay = (
    <div
      ref={overlayRef}
      className="app-loading-overlay"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="app-loading-overlay__content">
        <LoadingAnimation size={size} />
      </div>
    </div>
  );

  if (portalTarget) {
    return createPortal(overlay, portalTarget);
  }

  return overlay;
}

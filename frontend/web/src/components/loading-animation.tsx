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

/**
 * Couvre la zone status bar iPhone (batterie / Dynamic Island) au-dessus de la navbar,
 * et centre l’animation sur le viewport visible.
 */
function useStatusBarCoverOverlayStyle(enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el || typeof window === "undefined") return;

    const readSafeTop = () => {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none;";
      document.body.appendChild(probe);
      const h = probe.getBoundingClientRect().height || 0;
      probe.remove();
      // iPhone 16 / Pro : ~47–59px ; fallback généreux si env() = 0 au 1er paint
      return Math.max(h, 59);
    };

    const sync = () => {
      const vv = window.visualViewport;
      const safeTop = readSafeTop();
      const topPad = Math.max(safeTop + 24, 80);
      const bottomPad = Math.max(40, 24);
      const layoutW = Math.max(
        window.innerWidth || 0,
        document.documentElement?.clientWidth || 0,
        vv?.width || 0,
      );
      // Hauteur visible (écran utile) pour centrer le spinner
      const viewH = Math.max(
        window.innerHeight || 0,
        document.documentElement?.clientHeight || 0,
        vv?.height || 0,
      );

      // Overlay commence AU-DESSUS du status bar et descend sous le bas
      el.style.top = `${-topPad}px`;
      el.style.left = "0px";
      el.style.right = "0px";
      el.style.bottom = "auto";
      el.style.width = `${layoutW}px`;
      el.style.maxWidth = "none";
      el.style.height = `${viewH + topPad + bottomPad}px`;
      el.style.minHeight = `${viewH + topPad + bottomPad}px`;
      // Zone de centrage = viewport visible (sous le pad haut)
      el.style.setProperty("--loading-content-top", `${topPad}px`);
      el.style.setProperty("--loading-content-height", `${viewH}px`);
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

/** Overlay plein écran opaque + animation centrée — couvre status bar iPhone 16. */
export function LoadingOverlay({ size = 96 }: LoadingOverlayProps) {
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const overlayRef = useStatusBarCoverOverlayStyle(!!portalTarget);

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

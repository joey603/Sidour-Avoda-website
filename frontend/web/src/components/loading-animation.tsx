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

/** Aligne l’overlay sur le viewport (y compris zone sous Dynamic Island avec black-translucent). */
function useFullViewportOverlayStyle(enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el || typeof window === "undefined") return;

    const sync = () => {
      const vv = window.visualViewport;
      const w = Math.max(
        window.innerWidth || 0,
        document.documentElement?.clientWidth || 0,
        vv?.width || 0,
      );
      const h = Math.max(
        window.innerHeight || 0,
        document.documentElement?.clientHeight || 0,
        vv?.height || 0,
      );

      el.style.top = "0px";
      el.style.left = "0px";
      el.style.right = "0px";
      el.style.bottom = "0px";
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.minHeight = `${h}px`;
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

/** Overlay plein écran opaque — fond blanc sous la Dynamic Island sans déborder sur la navbar. */
export function LoadingOverlay({ size = 96 }: LoadingOverlayProps) {
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const overlayRef = useFullViewportOverlayStyle(!!portalTarget);

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

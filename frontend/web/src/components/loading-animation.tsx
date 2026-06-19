"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
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

/** Overlay plein écran (flou + opacité) avec animation centrée — fiable en PWA / mode standalone. */
export function LoadingOverlay({ size = 96 }: LoadingOverlayProps) {
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  const overlay = (
    <div className="app-loading-overlay" role="status" aria-live="polite" aria-busy="true">
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

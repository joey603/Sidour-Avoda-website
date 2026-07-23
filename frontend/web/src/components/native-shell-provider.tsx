"use client";

import { useEffect } from "react";
import { applyNativeShellDataset } from "@/lib/native-shell";

/**
 * Marque <html data-native-shell> quand l’app tourne en PWA / Capacitor / Tauri
 * pour que le CSS safe-area s’applique comme en mode standalone.
 */
export default function NativeShellProvider() {
  useEffect(() => {
    applyNativeShellDataset();

    const mqStandalone = window.matchMedia("(display-mode: standalone)");
    const mqFullscreen = window.matchMedia("(display-mode: fullscreen)");
    const onChange = () => applyNativeShellDataset();

    mqStandalone.addEventListener?.("change", onChange);
    mqFullscreen.addEventListener?.("change", onChange);
    // Capacitor injecte parfois le bridge après le premier paint
    const t = window.setTimeout(onChange, 0);

    return () => {
      window.clearTimeout(t);
      mqStandalone.removeEventListener?.("change", onChange);
      mqFullscreen.removeEventListener?.("change", onChange);
    };
  }, []);

  return null;
}

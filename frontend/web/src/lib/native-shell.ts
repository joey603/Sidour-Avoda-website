/**
 * Détection PWA / Capacitor / Tauri pour safe-area et comportements « app ».
 */

export type NativeShellKind = "pwa" | "capacitor" | "tauri" | null;

type CapacitorBridge = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
};

type TauriBridge = {
  core?: unknown;
};

declare global {
  interface Window {
    Capacitor?: CapacitorBridge;
    __TAURI__?: TauriBridge;
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isCapacitorNative(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.Capacitor?.isNativePlatform?.() === true) return true;
  } catch {
    // ignore
  }
  // Fallback WebView remote (bridge parfois retardé)
  return /Capacitor/i.test(window.navigator.userAgent || "");
}

export function isTauriNative(): boolean {
  if (typeof window === "undefined") return false;
  if (window.__TAURI__ || window.__TAURI_INTERNALS__) return true;
  return /Tauri/i.test(window.navigator.userAgent || "");
}

export function isPwaStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** PWA, Capacitor ou Tauri — même traitement safe-area / redirection home. */
export function isNativeShellApp(): boolean {
  return isPwaStandalone() || isCapacitorNative() || isTauriNative();
}

export function getNativeShellKind(): NativeShellKind {
  if (isCapacitorNative()) return "capacitor";
  if (isTauriNative()) return "tauri";
  if (isPwaStandalone()) return "pwa";
  return null;
}

/** Applique data-native-shell / data-native-shell-kind sur <html>. */
export function applyNativeShellDataset(root: HTMLElement = document.documentElement): NativeShellKind {
  const kind = getNativeShellKind();
  if (kind) {
    root.dataset.nativeShell = "1";
    root.dataset.nativeShellKind = kind;
  } else {
    delete root.dataset.nativeShell;
    delete root.dataset.nativeShellKind;
  }
  return kind;
}

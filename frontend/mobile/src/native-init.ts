import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";
import { Capacitor } from "@capacitor/core";

/**
 * Point d’entrée optionnel si tu bundles du JS local dans www/.
 * En mode remote (server.url), le frontend Next gère le shell via détection native.
 */
export async function initNativeShell(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    await StatusBar.setStyle({ style: Style.Dark });
    if (Capacitor.getPlatform() === "android") {
      await StatusBar.setBackgroundColor({ color: "#ffffff" });
    }
  } catch {
    // StatusBar indisponible sur certaines plateformes / simulateurs
  }

  try {
    await SplashScreen.hide();
  } catch {
    // ignore
  }
}

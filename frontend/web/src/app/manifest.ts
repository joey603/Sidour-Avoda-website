import type { MetadataRoute } from "next";

const PWA_ICON_VERSION = "1";

/** Manifeste web — ouverture « Ajouter à l’écran d’accueil » en mode standalone (sans Safari). */
export default function manifest(): MetadataRoute.Manifest {
  const v = `?v=${PWA_ICON_VERSION}`;
  return {
    id: "/",
    name: "גי וואן - סידור עבודה",
    short_name: "גי וואן",
    description: "סידור עבודה לארגונים",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    lang: "he",
    dir: "rtl",
    icons: [
      {
        src: `/favicon-32x32.png${v}`,
        sizes: "32x32",
        type: "image/png",
      },
      {
        src: `/apple-touch-icon.png${v}`,
        sizes: "180x180",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `/g1-logo.png${v}`,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `/g1-logo.png${v}`,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

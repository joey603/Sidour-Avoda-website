import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // IMPORTANT: ne pas mettre un chemin absolu local ici (ça casse les builds Vercel/CI).
  // Laisser Next.js choisir le root correctement en fonction de l'environnement.
  images: {
    formats: ["image/avif", "image/webp"],
  },
  experimental: {
    optimizePackageImports: ["framer-motion", "lucide-react"],
  },
  async headers() {
    return [
      {
        source: "/enregistrement-ecran-2026-06-03-chrome.mp4",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/enregistrement-ecran-2026-06-03.mov",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

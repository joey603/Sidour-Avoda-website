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
};

export default nextConfig;

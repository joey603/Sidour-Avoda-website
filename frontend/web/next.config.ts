import type { NextConfig } from "next";

const backendApiOrigin = String(process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000")
  .trim()
  .replace(/\/$/, "");

const nextConfig: NextConfig = {
  // IMPORTANT: ne pas mettre un chemin absolu local ici (ça casse les builds Vercel/CI).
  // Laisser Next.js choisir le root correctement en fonction de l'environnement.
  async rewrites() {
    return [
      { source: "/api-proxy/me", destination: `${backendApiOrigin}/me` },
      { source: "/api-proxy/health", destination: `${backendApiOrigin}/health` },
      { source: "/api-proxy/auth/:path*", destination: `${backendApiOrigin}/auth/:path*` },
      { source: "/api-proxy/director/:path*", destination: `${backendApiOrigin}/director/:path*` },
      { source: "/api-proxy/public/:path*", destination: `${backendApiOrigin}/public/:path*` },
      { source: "/api-proxy/worker/:path*", destination: `${backendApiOrigin}/worker/:path*` },
    ];
  },
};

export default nextConfig;

import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";
import AuthSessionVersionGuard from "@/components/auth-session-version-guard";
import TopNav from "@/components/top-nav";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
  adjustFontFallback: true,
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

const FAVICON_VERSION = "11";

export const metadata: Metadata = {
  title: "גי וואן - סידור עבודה",
  description: "סידור עבודה לארגונים",
  applicationName: "גי וואן",
  appleWebApp: {
    capable: true,
    title: "גי וואן",
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: `/favicon.ico?v=${FAVICON_VERSION}`, sizes: "any" },
      { url: `/favicon-16x16.png?v=${FAVICON_VERSION}`, type: "image/png", sizes: "16x16" },
      { url: `/favicon-32x32.png?v=${FAVICON_VERSION}`, type: "image/png", sizes: "32x32" },
    ],
    apple: [
      { url: `/apple-touch-icon.png?v=${FAVICON_VERSION}`, sizes: "180x180", type: "image/png" },
      { url: `/apple-touch-icon-precomposed.png?v=${FAVICON_VERSION}`, sizes: "180x180", type: "image/png" },
    ],
    shortcut: `/favicon.ico?v=${FAVICON_VERSION}`,
  },
};

/** Plein écran fiable sur iPhone (encoches, barre d’URL) pour overlays + backdrop-blur */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <AuthSessionVersionGuard />
        <TopNav />
        {children}
        <Analytics />
        <Toaster richColors closeButton position="top-center" />
      </body>
    </html>
  );
}

"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    // Rediriger vers la page de login directeur par défaut
    const returnUrl = searchParams?.get("returnUrl");
    if (returnUrl?.includes("/public/workers")) {
      router.replace(`/login/worker?returnUrl=${encodeURIComponent(returnUrl)}`);
    } else {
      router.replace(returnUrl ? `/login/director?returnUrl=${encodeURIComponent(returnUrl)}` : "/login/director");
    }
  }, [router, searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <p>מעביר...</p>
    </div>
  );
}



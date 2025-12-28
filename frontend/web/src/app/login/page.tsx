"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginInner() {
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

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><p>מעביר...</p></div>}>
      <LoginInner />
    </Suspense>
  );
}



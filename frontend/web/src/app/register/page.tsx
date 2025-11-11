"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function RegisterPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    // Rediriger vers la page de register directeur par défaut
    const returnUrl = searchParams?.get("returnUrl");
    const roleParam = searchParams?.get("role");
    if (roleParam === "worker" || returnUrl?.includes("/public/workers")) {
      router.replace(returnUrl ? `/register/worker?returnUrl=${encodeURIComponent(returnUrl)}` : "/register/worker");
    } else {
      router.replace(returnUrl ? `/register/director?returnUrl=${encodeURIComponent(returnUrl)}` : "/register/director");
    }
  }, [router, searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <p>מעביר...</p>
    </div>
  );
}



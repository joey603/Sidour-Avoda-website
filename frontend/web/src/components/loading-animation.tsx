"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

// Import dynamique pour éviter les problèmes SSR
const Lottie = dynamic(() => import("lottie-react"), { ssr: false });

interface LoadingAnimationProps {
  className?: string;
  size?: number;
}

export default function LoadingAnimation({ className = "", size = 64 }: LoadingAnimationProps) {
  const [animationData, setAnimationData] = useState<any>(null);

  useEffect(() => {
    // Charger le JSON depuis public/
    fetch("/Material wave loading.json")
      .then((res) => res.json())
      .then((data) => setAnimationData(data))
      .catch((err) => console.error("Erreur chargement animation:", err));
  }, []);

  if (!animationData) {
    return <div className={`flex items-center justify-center ${className}`}>טוען...</div>;
  }

  return (
    <div className={`flex items-center justify-center ${className}`}>
      <Lottie
        animationData={animationData}
        loop={true}
        style={{ width: size, height: size }}
      />
    </div>
  );
}

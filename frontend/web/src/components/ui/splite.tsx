'use client';

// Spline désactivé — incompatible React 19 (e.useCache)
// Composant placeholder pour éviter les erreurs d'import

interface SplineSceneProps {
  scene: string;
  className?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onLoad?: (app: any) => void;
}

export function SplineScene({ className }: SplineSceneProps) {
  return (
    <div
      className={className}
      style={{
        background: "linear-gradient(135deg, #0a0f1e 0%, #0b1628 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <RobotPlaceholder />
    </div>
  );
}

function RobotPlaceholder() {
  return (
    <div style={{ textAlign: "center", color: "rgba(0,168,224,0.6)" }}>
      <svg
        viewBox="0 0 120 160"
        width="120"
        height="160"
        style={{ animation: "g1Float 4s ease-in-out infinite" }}
      >
        {/* Tête */}
        <rect x="30" y="10" width="60" height="50" rx="12" fill="#00A8E0" opacity="0.9" />
        {/* Yeux */}
        <circle cx="45" cy="32" r="8" fill="#fff" />
        <circle cx="75" cy="32" r="8" fill="#fff" />
        <circle cx="47" cy="34" r="4" fill="#0a0f1e" />
        <circle cx="77" cy="34" r="4" fill="#0a0f1e" />
        {/* Antenne */}
        <rect x="57" y="0" width="6" height="12" rx="3" fill="#00A8E0" />
        <circle cx="60" cy="0" r="5" fill="#7dd3fc" style={{ animation: "g1Pulse 2s infinite" }} />
        {/* Corps */}
        <rect x="25" y="68" width="70" height="55" rx="10" fill="#0284c7" opacity="0.8" />
        {/* Boutons corps */}
        <circle cx="50" cy="88" r="6" fill="#00A8E0" />
        <circle cx="70" cy="88" r="6" fill="#00A8E0" />
        <rect x="40" y="102" width="40" height="8" rx="4" fill="#00A8E0" opacity="0.6" />
        {/* Bras gauche */}
        <rect x="5" y="68" width="18" height="45" rx="9" fill="#0284c7" opacity="0.7" />
        {/* Bras droit */}
        <rect x="97" y="68" width="18" height="45" rx="9" fill="#0284c7" opacity="0.7" />
        {/* Jambes */}
        <rect x="35" y="128" width="20" height="30" rx="8" fill="#0284c7" opacity="0.8" />
        <rect x="65" y="128" width="20" height="30" rx="8" fill="#0284c7" opacity="0.8" />
      </svg>
    </div>
  );
}

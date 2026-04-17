import type { ReactNode } from "react";

const base = "h-3 w-3 shrink-0 opacity-90";

function Svg({ children, className = base }: { children: ReactNode; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      {children}
    </svg>
  );
}

/** ממתין לאישור — horloge (en attente) */
export function SiteBadgeIconPendingApproval({ className = base }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
    </Svg>
  );
}

/** ממתין לשמירה — disquette / document */
export function SiteBadgeIconSavePending({ className = base }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M17 3H5a2 2 0 00-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z" />
    </Svg>
  );
}

/** משיכות — flèches d’échange */
export function SiteBadgeIconPulls({ className = base }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M6.99 11L3 15l3.99 4v-3H17v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z" />
    </Svg>
  );
}

/** שינויים / הרצה מחדש — synchronisation */
export function SiteBadgeIconChanges({ className = base }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
    </Svg>
  );
}

/** נשמר (מנהל) — coche */
export function SiteBadgeIconSavedDirector({ className = base }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
    </Svg>
  );
}

/** נשמר ונשלח — envoi */
export function SiteBadgeIconPublished({ className = base }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </Svg>
  );
}

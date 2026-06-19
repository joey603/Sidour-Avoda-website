"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fetchMe } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import LoadingAnimation, { LoadingOverlay } from "@/components/loading-animation";

interface Site {
  id: number;
  name: string;
  workers_count: number;
  pending_workers_count?: number;
  next_week_saved_plan_status?: {
    exists?: boolean;
    scope?: "auto" | "director" | "shared" | null;
    complete?: boolean | null;
    assigned_count?: number;
    required_count?: number;
  } | null;
}

function isSaved(site: Site): boolean {
  const scope = site.next_week_saved_plan_status?.scope;
  return scope === "director" || scope === "shared";
}

function isPublished(site: Site): boolean {
  return site.next_week_saved_plan_status?.scope === "shared";
}

type CardProps = {
  label: string;
  value: string | number;
  sub?: string;
  color: "blue" | "green" | "amber" | "red" | "zinc";
  icon: React.ReactNode;
  href?: string;
};

const colorMap = {
  blue:  { card: "border-[#00A8E0]/30 bg-[#00A8E0]/5",  icon: "bg-[#00A8E0]/10 text-[#00A8E0]",  value: "text-[#00A8E0]" },
  green: { card: "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40", icon: "bg-emerald-100 text-emerald-600 dark:bg-emerald-900 dark:text-emerald-400", value: "text-emerald-600 dark:text-emerald-400" },
  amber: { card: "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40",         icon: "bg-amber-100 text-amber-600 dark:bg-amber-900 dark:text-amber-400",         value: "text-amber-600 dark:text-amber-400" },
  red:   { card: "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/40",                 icon: "bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-400",                 value: "text-red-600 dark:text-red-400" },
  zinc:  { card: "border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/40",             icon: "bg-zinc-100 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400",             value: "text-zinc-700 dark:text-zinc-200" },
};

function StatCard({ label, value, sub, color, icon, href }: CardProps) {
  const c = colorMap[color];
  const inner = (
    <div className={`flex items-start gap-4 rounded-xl border p-5 transition-shadow hover:shadow-md ${c.card}`}>
      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${c.icon}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{label}</p>
        <p className={`mt-0.5 text-3xl font-bold tabular-nums ${c.value}`}>{value}</p>
        {sub && <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{sub}</p>}
      </div>
    </div>
  );
  if (href) {
    return <Link href={href} className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00A8E0] rounded-xl">{inner}</Link>;
  }
  return inner;
}

export default function DirectorDashboard() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [directorCode, setDirectorCode] = useState("");
  const [sites, setSites] = useState<Site[]>([]);
  const [sitesLoading, setSitesLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await fetchMe();
        if (!me) { router.replace("/login/director"); return; }
        if (me.role !== "director") { router.replace("/worker"); return; }
        if (!cancelled) {
          setName(me.full_name);
          setDirectorCode(String((me as Record<string, unknown>)?.director_code ?? ""));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setSitesLoading(true);
      try {
        const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
        const data = await apiFetch<Site[]>("/director/sites/", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store" as RequestCache,
        });
        if (!cancelled) setSites(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setSites([]);
      } finally {
        if (!cancelled) setSitesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <LoadingOverlay size={96} />;
  }

  const totalSites = sites.length;
  const totalPending = sites.reduce((s, site) => s + (site.pending_workers_count ?? 0), 0);
  const savedSites = sites.filter(isSaved).length;
  const publishedSites = sites.filter(isPublished).length;
  const unsavedSites = totalSites - savedSites;

  const planningColor: CardProps["color"] =
    totalSites === 0 ? "zinc"
    : savedSites === totalSites ? "green"
    : savedSites > 0 ? "amber"
    : "red";

  const planningValue = sitesLoading ? "…" : totalSites === 0 ? "—" : `${savedSites}/${totalSites}`;
  const planningSub = sitesLoading
    ? undefined
    : totalSites === 0
    ? "אין אתרים"
    : savedSites === totalSites
    ? publishedSites === totalSites
      ? "כל האתרים נשלחו לעובדים"
      : "כל האתרים שמורים"
    : unsavedSites === totalSites
    ? "אף אתר לא תוכנן"
    : `${unsavedSites} אתר${unsavedSites > 1 ? "ים" : ""} ללא תכנון`;

  return (
    <div className="mx-auto max-w-3xl px-4 py-10" dir="rtl">

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          ברוך הבא{name ? ", " : ""}
          <span style={{ color: "#00A8E0" }}>{name}</span>
        </h1>
        {directorCode ? (
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            קוד מנהל:{" "}
            <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-200" dir="ltr">
              {directorCode}
            </span>
          </p>
        ) : null}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">

        {/* Sites */}
        <StatCard
          label="אתרים פעילים"
          value={sitesLoading ? "…" : totalSites}
          sub={sitesLoading ? undefined : totalSites === 0 ? "צור אתר ראשון" : `${sites.reduce((s, site) => s + (site.workers_count ?? 0), 0)} עובדים בסה״כ`}
          color="blue"
          href="/director/sites"
          icon={
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden>
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
            </svg>
          }
        />

        {/* Workers en attente */}
        <StatCard
          label="ממתינים לאישור"
          value={sitesLoading ? "…" : totalPending}
          sub={
            sitesLoading ? undefined
            : totalPending === 0 ? "אין עובדים ממתינים"
            : `${totalPending} עובד${totalPending > 1 ? "ים" : ""} חד${totalPending > 1 ? "שים" : "ש"} ממתינ${totalPending > 1 ? "ים" : ""}`
          }
          color={totalPending > 0 ? "amber" : "zinc"}
          href={totalPending > 0 ? "/director/sites" : undefined}
          icon={
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden>
              <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>
            </svg>
          }
        />

        {/* Planning semaine prochaine */}
        <StatCard
          label="תכנון שבוע הבא"
          value={planningValue}
          sub={planningSub}
          color={planningColor}
          href={totalSites > 0 ? "/director/sites" : undefined}
          icon={
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden>
              <path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7z"/>
            </svg>
          }
        />

        {/* Workers */}
        <StatCard
          label="רשימת עובדים"
          value={sitesLoading ? "…" : sites.reduce((s, site) => s + (site.workers_count ?? 0), 0)}
          sub="כלל העובדים הרשומים"
          color="zinc"
          href="/director/workers"
          icon={
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden>
              <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
            </svg>
          }
        />
      </div>

      {/* Liens rapides */}
      {totalSites > 0 && !sitesLoading && (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
            מעבר מהיר
          </h2>
          <div className="flex flex-wrap gap-2">
            {sites.slice(0, 5).map((site) => (
              <Link
                key={site.id}
                href={`/director/planning-v2/${site.id}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:border-[#00A8E0]/50 hover:bg-[#00A8E0]/5 hover:text-[#00A8E0] transition-colors dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:border-[#00A8E0]/50 dark:hover:bg-[#00A8E0]/10"
              >
                {isPublished(site) && (
                  <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" aria-hidden />
                )}
                {isSaved(site) && !isPublished(site) && (
                  <span className="h-2 w-2 rounded-full bg-amber-400 shrink-0" aria-hidden />
                )}
                {!isSaved(site) && (
                  <span className="h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-600 shrink-0" aria-hidden />
                )}
                {site.name}
              </Link>
            ))}
            {sites.length > 5 && (
              <Link
                href="/director/sites"
                className="inline-flex items-center rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-sm text-zinc-400 hover:border-zinc-400 hover:text-zinc-600 transition-colors dark:border-zinc-600 dark:text-zinc-500 dark:hover:border-zinc-500"
              >
                + {sites.length - 5} נוספים
              </Link>
            )}
          </div>
          <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-600">
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" /> נשלח לעובדים</span>
            {"  ·  "}
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400 inline-block" /> שמור למנהל</span>
            {"  ·  "}
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-600 inline-block" /> לא תוכנן</span>
          </p>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState, Fragment } from "react";
import { useParams, useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import { apiFetch } from "@/lib/api";

interface Worker {
  id: number;
  site_id: number;
  name: string;
  max_shifts: number;
  roles: string[];
  availability: Record<string, string[]>;
}

interface Site { id: number; name: string; config?: any }

const dayLabels: Record<string, string> = {
  sun: "ראשון",
  mon: "שני",
  tue: "שלישי",
  wed: "רביעי",
  thu: "חמישי",
  fri: "שישי",
  sat: "שבת",
};

export default function WorkerDetailsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [worker, setWorker] = useState<Worker | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteConfig, setSiteConfig] = useState<any | null>(null);
  const [weekStart, setWeekStart] = useState<Date>(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = today.getDay();
    const startThisWeek = new Date(today);
    startThisWeek.setDate(today.getDate() - day);
    const nextWeek = new Date(startThisWeek);
    nextWeek.setDate(startThisWeek.getDate() + 7);
    return nextWeek;
  });
  const [weekPlan, setWeekPlan] = useState<null | {
    assignments: Record<string, Record<string, string[][]>>;
    isManual: boolean;
    workers?: Array<{ id: number; name: string; max_shifts?: number; roles?: string[]; availability?: Record<string, string[]> }>;
  }>(null);

  function addDays(d: Date, days: number): Date {
    const n = new Date(d);
    n.setDate(n.getDate() + days);
    return n;
  }

  function formatHebDate(d: Date): string {
    return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  useEffect(() => {
    (async () => {
      const me = await fetchMe();
      if (!me) return router.replace("/login");
      if (me.role !== "director") return router.replace("/worker");
      try {
        const [workers, sitesList] = await Promise.all([
          apiFetch<Worker[]>("/director/sites/all-workers", {
            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
            cache: "no-store" as any,
          }),
          apiFetch<Site[]>("/director/sites/", {
            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
            cache: "no-store" as any,
          }),
        ]);
        setSites(sitesList || []);
        const found = (workers || []).find((w) => String(w.id) === String(params.id));
        if (!found) {
          setError("עובד לא נמצא");
        }
        setWorker(found || null);
      } catch (e: any) {
        setError("שגיאה בטעינת עובד");
      } finally {
        setLoading(false);
      }
    })();
  }, [params.id, router]);

  useEffect(() => {
    (async () => {
      if (!worker) return;
      try {
        const site = await apiFetch<any>(`/director/sites/${worker.site_id}`, {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          cache: "no-store" as any,
        });
        setSiteConfig(site?.config || null);
      } catch {
        setSiteConfig(null);
      }
      // Load saved plan from localStorage for this site + current week
      const start = new Date(weekStart);
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      const key = `plan_${worker.site_id}_${iso(start)}`;
      try {
        // reset before fetching to avoid showing previous week's plan
        setWeekPlan(null);
        const raw = typeof window !== "undefined" ? localStorage.getItem(key) : null;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.assignments) {
            setWeekPlan({ assignments: parsed.assignments, isManual: !!parsed.isManual, workers: Array.isArray(parsed.workers) ? parsed.workers : undefined });
          }
        } else {
          setWeekPlan(null);
        }
      } catch {
        setWeekPlan(null);
      }
    })();
  }, [worker, weekStart]);

  const effectiveWorker = useMemo(() => {
    if (!worker) return null;
    const snap = weekPlan?.workers?.find((w: any) => String(w.id) === String(worker.id));
    if (snap) {
      return {
        id: worker.id,
        site_id: worker.site_id,
        name: String((snap as any).name ?? worker.name),
        max_shifts: typeof (snap as any).max_shifts === "number" ? (snap as any).max_shifts : worker.max_shifts,
        roles: Array.isArray((snap as any).roles) ? (snap as any).roles : worker.roles,
        availability: (snap as any).availability || worker.availability,
      } as Worker;
    }
    return worker;
  }, [weekPlan?.workers, worker]);

  const siteName = useMemo(() => {
    if (!worker) return "";
    const s = sites.find((x) => x.id === worker.site_id);
    return s?.name || `אתר #${worker.site_id}`;
  }, [sites, worker]);

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">עריכת עובד</h1>
          <div className="flex-1 flex items-center justify-center gap-2">
            <button
              onClick={() => setWeekStart((prev) => addDays(prev, +7))}
              className="inline-flex items-center rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              aria-label="שבוע הבא"
              title="שבוע הבא"
            >
              →
            </button>
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
              {(() => {
                const end = addDays(weekStart, 6);
                return `${formatHebDate(weekStart)} — ${formatHebDate(end)}`;
              })()}
            </span>
            <button
              onClick={() => setWeekStart((prev) => addDays(prev, -7))}
              className="inline-flex items-center rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              aria-label="שבוע קודם"
              title="שבוע קודם"
            >
              ←
            </button>
          </div>
          <button
            onClick={() => router.back()}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            aria-label="חזרה"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
              <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
            </svg>
            חזרה
          </button>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {loading ? (
          <p>טוען...</p>
        ) : worker ? (
          <div className="space-y-6">
            <section className="rounded-xl border p-4 dark:border-zinc-800">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <div className="text-sm text-zinc-500">שם עובד</div>
                  <div className="text-base font-medium">{effectiveWorker?.name}</div>
                </div>
                <div>
                  <div className="text-sm text-zinc-500">אתר</div>
                  <div className="text-base font-medium">{siteName}</div>
                </div>
                <div>
                  <div className="text-sm text-zinc-500">משמרות מקסימליות</div>
                  <div className="text-base font-medium">{effectiveWorker?.max_shifts}</div>
                </div>
                <div>
                  <div className="text-sm text-zinc-500">תפקידים</div>
                  <div className="text-base font-medium">{effectiveWorker?.roles && effectiveWorker.roles.length ? effectiveWorker.roles.join(", ") : "—"}</div>
                </div>
              </div>
            </section>

            {/* Grille hebdomadaire avec surlignage du travailleur */}
            <section className="rounded-xl border p-4 dark:border-zinc-800">
              <h2 className="mb-3 text-lg font-semibold">שיבוצים לשבוע הנוכחי</h2>
              {!siteConfig || !weekPlan ? (
                <p className="text-sm text-zinc-500">אין נתוני תכנון שמורים לשבוע זה.</p>
              ) : (
                <div className="overflow-x-auto">
                  <div className="min-w-[720px] space-y-3">
                    {(siteConfig?.stations || []).map((st: any, stationIndex: number) => (
                      <div key={stationIndex} className="rounded-md border p-3 dark:border-zinc-700">
                        <div className="mb-2 font-medium">{st?.name || `עמדה ${stationIndex+1}`}</div>
                        <div className="grid grid-cols-8 gap-2">
                          <div />
                          {(["sun","mon","tue","wed","thu","fri","sat"]).map((dk) => (
                            <div key={dk} className="text-center text-xs text-zinc-500">{dayLabels[dk]}</div>
                          ))}
                          {(st?.shifts || []).filter((sh: any) => sh?.enabled).map((sh: any, sIdx: number) => (
                            <Fragment key={`row-${stationIndex}-${sIdx}`}>
                              <div className="text-xs font-medium flex items-center">{sh?.name}</div>
                              {(["sun","mon","tue","wed","thu","fri","sat"]).map((dk) => {
                                const names: string[] = (weekPlan.assignments?.[dk]?.[sh?.name]?.[stationIndex] || []) as any;
                                return (
                                  <div key={`cell-${stationIndex}-${sIdx}-${dk}`} className="rounded-md border p-1 min-h-10 dark:border-zinc-700">
                                    <div className="flex flex-col gap-1">
                                      {(names || []).length === 0 ? (
                                        <span className="text-xs text-zinc-400">—</span>
                                      ) : (
                                        names.map((nm, i) => (
                                          <span
                                            key={i}
                                            className={`text-xs inline-flex items-center rounded px-1 ${nm === worker.name ? "bg-green-500 text-white" : "text-zinc-700 dark:text-zinc-200"}`}
                                          >
                                            {nm || ""}
                                          </span>
                                        ))
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </Fragment>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {/* Tableau des demandes */}
            <section className="rounded-xl border p-4 dark:border-zinc-800">
              <h2 className="mb-3 text-lg font-semibold">בקשות העובד</h2>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b dark:border-zinc-800">
                      <th className="px-2 py-2 text-right">שם</th>
                      <th className="px-2 py-2 text-right">מקס' משמרות</th>
                      <th className="px-2 py-2 text-right">תפקידים</th>
                      <th className="px-2 py-2 text-right">זמינות</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b dark:border-zinc-800">
                      <td className="px-2 py-2">{effectiveWorker?.name}</td>
                      <td className="px-2 py-2">{effectiveWorker?.max_shifts}</td>
                      <td className="px-2 py-2">{effectiveWorker?.roles?.length ? effectiveWorker.roles.join(", ") : "—"}</td>
                      <td className="px-2 py-2">
                        {Object.keys(dayLabels).map((dk) => (
                          <span key={dk} className="inline-flex items-center gap-1 mr-2 mb-1">
                            <span className="text-xs text-zinc-500">{dayLabels[dk]}:</span>
                            <span className="text-xs">{(effectiveWorker?.availability?.[dk] || []).join(" | ") || "—"}</span>
                          </span>
                        ))}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => router.push(`/director/sites/${worker.site_id}/edit`)}
                className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                ערוך באתר
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

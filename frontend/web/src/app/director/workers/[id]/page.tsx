"use client";

import { useEffect, useMemo, useRef, useState, Fragment, useCallback } from "react";
import type { ReactElement } from "react";
import { useParams, useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import LoadingAnimation from "@/components/loading-animation";
import { toast } from "sonner";
import { getRequiredFor } from "@/components/planning-v2/lib/station-grid-helpers";

interface Worker {
  id: number;
  site_id: number;
  name: string;
  max_shifts: number;
  roles: string[];
  availability: Record<string, string[]>;
  phone?: string | null;
  site_name?: string | null;
  site_deleted?: boolean;
  removed_from_week_iso?: string | null;
  removed_by_planning?: boolean;
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

const isRtlName = (s: string) => /[\u0590-\u05FF]/.test(String(s || "")); // hébreu

export default function WorkerDetailsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [worker, setWorker] = useState<Worker | null>(null);
  const [allWorkers, setAllWorkers] = useState<Worker[]>([]);
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
    pulls?: Record<string, { before: { name: string; start: string; end: string }; after: { name: string; start: string; end: string } }>;
  }>(null);
  const [weekPlanLoading, setWeekPlanLoading] = useState(false);
  const weekPlanFetchGenRef = useRef(0);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => new Date(weekStart.getFullYear(), weekStart.getMonth(), 1));
  const [isEditingIdentity, setIsEditingIdentity] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [deletingWorker, setDeletingWorker] = useState(false);
  const normalizePhoneDigits = (value: string | null | undefined) => String(value || "").replace(/\D/g, "");

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
      if (!me) return router.replace("/login/director");
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
        setAllWorkers(workers || []);
        // eslint-disable-next-line no-console
        console.log("[WorkerDetails] All workers from API:", workers);
        const found = (workers || []).find((w) => String(w.id) === String(params.id));
        if (!found) {
          setError("עובד לא נמצא");
        }
        // eslint-disable-next-line no-console
        console.log("[WorkerDetails] Found worker:", found, "phone field:", found?.phone);
        setWorker(found || null);
      } catch (e: any) {
        setError("שגיאה בטעינת עובד");
      } finally {
        setLoading(false);
      }
    })();
  }, [params.id, router]);

  useEffect(() => {
    if (!worker) return;

    const gen = ++weekPlanFetchGenRef.current;
    // Loader et reset du plan tout de suite, avant tout await (évite la latence au changement de semaine)
    setWeekPlan(null);
    setWeekPlanLoading(true);

    (async () => {
      try {
        const site = await apiFetch<any>(`/director/sites/${worker.site_id}`, {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          cache: "no-store" as any,
        });
        if (gen !== weekPlanFetchGenRef.current) return;
        setSiteConfig(site?.config || null);
      } catch {
        if (gen !== weekPlanFetchGenRef.current) return;
        setSiteConfig(null);
      }

      const start = new Date(weekStart);
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

      function weekPlanFromApiPayload(raw: Record<string, unknown> | null | undefined) {
        if (!raw || typeof raw !== "object" || raw.assignments == null) return null;
        return {
          assignments: raw.assignments as Record<string, Record<string, string[][]>>,
          isManual: !!raw.isManual,
          workers: Array.isArray(raw.workers) ? raw.workers : undefined,
          pulls: raw.pulls && typeof raw.pulls === "object" ? (raw.pulls as Record<string, unknown>) : undefined,
        };
      }

      try {
        const wk = iso(start);
        const siteId = worker.site_id;
        const authOpts = {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          cache: "no-store" as const,
        };
        /** שיבוצים : רק תכנון שפורסם לעובדים (scope=shared), לא טיוטת מנהל / auto */
        const sharedKey = `plan_shared_${worker.site_id}_${iso(start)}`;
        let fromShared: Record<string, unknown> | null = null;
        try {
          fromShared = await apiFetch<Record<string, unknown>>(
            `/director/sites/${siteId}/week-plan?week=${encodeURIComponent(wk)}&scope=shared`,
            authOpts as any,
          );
        } catch {
          fromShared = null;
        }
        if (gen !== weekPlanFetchGenRef.current) return;

        const picked = weekPlanFromApiPayload(fromShared);

        if (picked) {
          try {
            localStorage.setItem(sharedKey, JSON.stringify({ ...picked, pulls: picked.pulls ?? {} }));
          } catch {
            /* ignore */
          }
          setWeekPlan(picked);
          return;
        }

        try {
          const fromPublic = await apiFetch<any>(`/public/sites/${siteId}/week-plan?week=${encodeURIComponent(wk)}`, {
            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
            cache: "no-store" as any,
          });
          if (gen !== weekPlanFetchGenRef.current) return;
          const publicPlan = weekPlanFromApiPayload(fromPublic);
          if (publicPlan) {
            try {
              localStorage.setItem(sharedKey, JSON.stringify({ ...publicPlan, pulls: publicPlan.pulls ?? {} }));
            } catch {
              /* ignore */
            }
            setWeekPlan(publicPlan);
            return;
          }
        } catch {
          /* pas de fallback brouillon */
        }
        if (gen !== weekPlanFetchGenRef.current) return;
        const raw = typeof window !== "undefined" ? localStorage.getItem(sharedKey) : null;
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.assignments) {
              setWeekPlan({
                assignments: parsed.assignments,
                isManual: !!parsed.isManual,
                workers: Array.isArray(parsed.workers) ? parsed.workers : undefined,
                pulls: (parsed && parsed.pulls && typeof parsed.pulls === "object") ? parsed.pulls : undefined,
              });
              return;
            }
          } catch {
            /* ignore */
          }
        }
        if (gen !== weekPlanFetchGenRef.current) return;
        setWeekPlan(null);
      } catch {
        if (gen !== weekPlanFetchGenRef.current) return;
        setWeekPlan(null);
      } finally {
        if (gen === weekPlanFetchGenRef.current) {
        setWeekPlanLoading(false);
        }
      }
    })();
  }, [worker, weekStart]);

  // Synchroniser le mois du calendrier avec la semaine sélectionnée
  useEffect(() => {
    if (!isCalendarOpen) {
      setCalendarMonth(new Date(weekStart.getFullYear(), weekStart.getMonth(), 1));
    }
  }, [weekStart, isCalendarOpen]);

  /** Profil « מערכת » (DB / all-workers) — pour בקשות העובד, לא מטעות טיוטת שבוע בתכנון השמור. */
  const workerSystemProfile = useMemo(() => {
    if (!worker) return null;
    return {
      name: String(worker.name || ""),
      max_shifts: worker.max_shifts,
      roles: Array.isArray(worker.roles) ? worker.roles : [],
      availability: worker.availability && typeof worker.availability === "object" ? worker.availability : {},
    };
  }, [worker]);

  const effectiveWorker = useMemo(() => {
    if (!worker) return null;
    // eslint-disable-next-line no-console
    console.log("[WorkerDetails] effectiveWorker - worker:", worker, "phone:", worker.phone);
    const snap = weekPlan?.workers?.find((w: any) => String(w.id) === String(worker.id));
    if (snap) {
      const snapRoles = (snap as any).roles;
      const snapAvail = (snap as any).availability;
      const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
      const snapRolesUsable = Array.isArray(snapRoles) && snapRoles.length > 0;
      const snapAvailUsable =
        snapAvail &&
        typeof snapAvail === "object" &&
        DAY_KEYS.some((k) => Array.isArray((snapAvail as Record<string, unknown>)[k]) && ((snapAvail as Record<string, string[]>)[k] || []).length > 0);

      return {
        id: worker.id,
        site_id: worker.site_id,
        // IMPORTANT: toujours afficher l'identité depuis la DB (sinon un plan sauvegardé peut réafficher l'ancien nom)
        name: String(worker.name),
        max_shifts: typeof (snap as any).max_shifts === "number" ? (snap as any).max_shifts : worker.max_shifts,
        roles: snapRolesUsable ? snapRoles : worker.roles,
        availability: snapAvailUsable ? snapAvail : worker.availability,
        phone: worker.phone, // Toujours utiliser le phone du worker actuel, pas celui sauvegardé
      } as Worker;
    }
    return worker;
  }, [weekPlan?.workers, worker]);

  useEffect(() => {
    if (!worker) return;
    setEditName(worker.name || "");
    setEditPhone(worker.phone || "");
  }, [worker]);

  const workerSiteLabel = useCallback((w: Worker) => {
    const fromApi = String(w.site_name || "").trim();
    if (fromApi) return fromApi;
    const s = sites.find((x) => x.id === w.site_id);
    return s?.name || `אתר #${w.site_id}`;
  }, [sites]);

  const siteName = useMemo(() => {
    if (!worker) return "";
    return workerSiteLabel(worker);
  }, [worker, workerSiteLabel]);

  const workerSiteEntries = useMemo(() => {
    if (!worker) return [];
    const normalizedPhone = normalizePhoneDigits(worker.phone);
    const matches = (allWorkers || []).filter((entry) => {
      if (normalizedPhone) return normalizePhoneDigits(entry.phone) === normalizedPhone;
      return Number(entry.id) === Number(worker.id);
    });
    const uniqueBySite = new Map<number, Worker>();
    matches.forEach((entry) => {
      if (!uniqueBySite.has(Number(entry.site_id))) uniqueBySite.set(Number(entry.site_id), entry);
    });
    return Array.from(uniqueBySite.values()).sort((a, b) => {
      const rank = (entry: Worker) => {
        if (entry.site_deleted) return 2;
        if (entry.removed_by_planning) return 1;
        return 0;
      };
      const da = rank(a);
      const db = rank(b);
      if (da !== db) return da - db;
      return workerSiteLabel(a).localeCompare(workerSiteLabel(b), "he");
    });
  }, [allWorkers, worker, workerSiteLabel]);

  const weekRangeLabel = useMemo(() => {
    const end = addDays(weekStart, 6);
    return `${formatHebDate(weekStart)} — ${formatHebDate(end)}`;
  }, [weekStart]);

  const backButton = (
    <button
      type="button"
      onClick={() => router.back()}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
      aria-label="חזרה"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
        <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
      </svg>
      חזרה
    </button>
  );

  const weekNavRow = (
    <>
      <button
        type="button"
        onClick={() => setWeekStart((prev) => addDays(prev, -7))}
        className="inline-flex shrink-0 items-center rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        aria-label="שבוע קודם"
        title="שבוע קודם"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
          <path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" />
        </svg>
      </button>
      <span className="min-w-0 shrink text-center text-xs font-medium text-zinc-700 whitespace-nowrap sm:text-sm dark:text-zinc-200">
        {weekRangeLabel}
      </span>
      <button
        type="button"
        onClick={() => setWeekStart((prev) => addDays(prev, +7))}
        className="inline-flex shrink-0 items-center rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        aria-label="שבוע הבא"
        title="שבוע הבא"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
          <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => setIsCalendarOpen(true)}
        className="inline-flex shrink-0 items-center rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        aria-label="בחר שבוע מלוח שנה"
        title="בחר שבוע מלוח שנה"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
          <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z" />
          <path d="M7 14h5v5H7z" />
        </svg>
      </button>
    </>
  );

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        {/* Titre + retour sur une ligne ; date et navigation semaine sur la ligne suivante (tous écrans) */}
        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <h1 className="min-w-0 truncate text-xl font-semibold">עריכת עובד</h1>
            {backButton}
          </div>
          <div className="flex min-w-0 w-full items-center justify-center gap-3 px-1 sm:px-2">
            {weekNavRow}
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {loading ? (
          <LoadingAnimation className="py-8" size={80} />
        ) : worker ? (
          <>
            {worker.site_deleted ? (
              <div
                className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
                role="status"
              >
                האתר «{workerSiteLabel(worker)}» אינו ברשימה הפעילה (ארכיון). ההיסטוריה והתכנון השמור עדיין זמינים לצפייה.
              </div>
            ) : null}
            {workerSiteEntries.length > 1 ? (
              <div className="rounded-xl border p-4 dark:border-zinc-800">
                <label className="mb-2 block text-sm font-medium">בחר אתר</label>
                <select
                  value={worker.site_id}
                  onChange={(e) => {
                    const selectedEntry = workerSiteEntries.find((entry) => Number(entry.site_id) === Number(e.target.value));
                    if (!selectedEntry || Number(selectedEntry.id) === Number(worker.id)) return;
                    router.push(`/director/workers/${selectedEntry.id}`);
                  }}
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
                >
                  {workerSiteEntries.map((entry) => (
                    <option key={entry.id} value={entry.site_id}>
                      {workerSiteLabel(entry)}
                      {entry.site_deleted ? " (ארכיון)" : entry.removed_by_planning ? " (הוסר מהאתר)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {weekPlanLoading ? (
              <div className="fixed inset-0 z-50 flex min-h-[100lvh] w-full max-w-[100vw] items-center justify-center overflow-x-hidden overscroll-none bg-white/70 backdrop-blur-md md:min-h-screen-mobile dark:bg-zinc-950/70 dark:backdrop-blur-md">
                <LoadingAnimation size={96} />
              </div>
            ) : null}
            {isCalendarOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setIsCalendarOpen(false)}>
                <div className="bg-white dark:bg-zinc-900 rounded-lg p-6 shadow-xl max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold">בחר שבוע</h3>
                    <button
                      type="button"
                      onClick={() => setIsCalendarOpen(false)}
                      className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                        <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                      </svg>
                    </button>
                  </div>
                  <div className="mb-4 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => {
                        const nextMonth = new Date(calendarMonth);
                        nextMonth.setMonth(nextMonth.getMonth() + 1);
                        setCalendarMonth(nextMonth);
                      }}
                      className="p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded"
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                        <path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/>
                      </svg>
                    </button>
                    <span className="text-lg font-medium">
                      {new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric" }).format(calendarMonth)}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const prevMonth = new Date(calendarMonth);
                        prevMonth.setMonth(prevMonth.getMonth() - 1);
                        setCalendarMonth(prevMonth);
                      }}
                      className="p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded"
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                        <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
                      </svg>
                    </button>
                  </div>
                  <div className="grid grid-cols-7 gap-1 mb-2">
                    {["א", "ב", "ג", "ד", "ה", "ו", "ש"].map((day) => (
                      <div key={day} className="text-center text-sm font-medium text-zinc-600 dark:text-zinc-400 p-2">
                        {day}
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-1">
                    {(() => {
                      const year = calendarMonth.getFullYear();
                      const month = calendarMonth.getMonth();
                      const firstDay = new Date(year, month, 1);
                      const startDate = new Date(firstDay);
                      startDate.setDate(startDate.getDate() - firstDay.getDay()); // Start from Sunday
                      const days: ReactElement[] = [];
                      const today = new Date();
                      today.setHours(0, 0, 0, 0);
                      
                      // Helper function to check if worker is assigned on a date
                      const isWorkerAssignedOnDate = (date: Date): boolean => {
                        if (!worker || typeof window === "undefined") return false;
                        const weekStartForDate = new Date(date);
                        weekStartForDate.setDate(date.getDate() - date.getDay()); // Sunday
                        const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
                        const key = `plan_${worker.site_id}_${iso(weekStartForDate)}`;
                        const raw = localStorage.getItem(key);
                        if (!raw) return false;
                        try {
                          const parsed = JSON.parse(raw);
                          if (!parsed || !parsed.assignments) return false;
                          const assignments = parsed.assignments;
                          const dayKey = ["sun","mon","tue","wed","thu","fri","sat"][date.getDay()];
                          if (!assignments[dayKey]) return false;
                          // Check all shifts and stations
                          for (const shiftName of Object.keys(assignments[dayKey])) {
                            const perStation = assignments[dayKey][shiftName] || [];
                            for (const stationAssignments of perStation) {
                              if (Array.isArray(stationAssignments) && stationAssignments.includes(worker.name)) {
                                return true;
                              }
                            }
                          }
                          return false;
                        } catch {
                          return false;
                        }
                      };
                      
                      for (let i = 0; i < 42; i++) {
                        const date = new Date(startDate);
                        date.setDate(date.getDate() + i);
                        const isCurrentMonth = date.getMonth() === month;
                        const isToday = date.getTime() === today.getTime();
                        const isWeekStart = date.getDay() === 0; // Sunday
                        
                        // Check if this date is in the current week
                        const weekStartForDate = new Date(date);
                        weekStartForDate.setDate(date.getDate() - date.getDay());
                        const isCurrentWeek = weekStartForDate.getTime() === weekStart.getTime();
                        
                        // Check if worker is assigned on this date
                        const isAssigned = isWorkerAssignedOnDate(date);
                        
                        days.push(
                          <button
                            key={i}
                            type="button"
                            onClick={() => {
                              // Calculer le début de la semaine pour cette date
                              const selectedWeekStart = new Date(date);
                              selectedWeekStart.setDate(date.getDate() - date.getDay()); // Dimanche
                              setWeekStart(selectedWeekStart);
                              setCalendarMonth(new Date(year, month, 1));
                              setIsCalendarOpen(false);
                            }}
                            className={`
                              p-2 text-sm rounded flex flex-col items-center relative
                              ${!isCurrentMonth ? "text-zinc-300 dark:text-zinc-600" : ""}
                              ${isToday ? "bg-[#00A8E0] text-white font-semibold" : ""}
                              ${isCurrentWeek && isCurrentMonth && !isToday ? "bg-[#00A8E0]/20 border border-[#00A8E0]" : ""}
                              ${isWeekStart && isCurrentMonth ? "font-semibold" : ""}
                              hover:bg-zinc-100 dark:hover:bg-zinc-800
                              ${isCurrentMonth && !isToday && !isCurrentWeek ? "text-zinc-700 dark:text-zinc-300" : ""}
                            `}
                          >
                            <span>{date.getDate()}</span>
                            {isAssigned && (
                              <span className="absolute bottom-0.5 w-1 h-1 rounded-full bg-red-500"></span>
                            )}
                          </button>
                        );
                      }
                      return days;
                    })()}
                  </div>
                </div>
              </div>
            )}
            <div
              className="w-full rounded-2xl border border-zinc-200/90 bg-white p-5 shadow-[0_4px_24px_-4px_rgba(0,0,0,0.08)] dark:border-zinc-700 dark:bg-zinc-950/70 dark:shadow-[0_4px_24px_-4px_rgba(0,0,0,0.45)] sm:p-6 md:p-7"
            >
            <div className="space-y-6">
            <section
              dir="rtl"
              className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40"
            >
              <div className="flex items-center justify-between gap-3 border-b border-[#B3ECFF] bg-[#E6F7FF] px-4 py-3 dark:border-cyan-800/70 dark:bg-cyan-950/45">
                <h2 className="text-base font-semibold text-[#004B63] dark:text-cyan-100">פרטי עובד</h2>
                {!isEditingIdentity ? (
                  <button
                    type="button"
                    onClick={() => {
                      setIsEditingIdentity(true);
                      setEditName(effectiveWorker?.name || "");
                      setEditPhone(effectiveWorker?.phone || "");
                    }}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#B3ECFF] bg-white/95 px-3 py-1.5 text-sm font-medium text-[#006C8A] shadow-sm hover:bg-white dark:border-cyan-700 dark:bg-cyan-900/60 dark:text-cyan-100 dark:hover:bg-cyan-900/80"
                    aria-label="ערוך פרטי עובד"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                      <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75Z" />
                    </svg>
                    עריכה
                  </button>
                ) : (
                  <span className="text-xs font-medium text-[#006C8A]/90 dark:text-cyan-200/90">מצב עריכה</span>
                )}
              </div>

              <div className="space-y-0 divide-y divide-zinc-200/90 dark:divide-zinc-800">
                {/* שם — שורה מלאה */}
                <div className="bg-white px-4 py-4 dark:bg-zinc-950/30">
                  <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">שם עובד</div>
                  <div className="mt-1.5 min-h-[2rem]">
                    {isEditingIdentity ? (
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-10 w-full rounded-lg border border-zinc-300 bg-white px-3 text-base focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-600 dark:bg-zinc-900"
                      />
                    ) : (
                      <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{effectiveWorker?.name}</p>
                    )}
                  </div>
                </div>

                {/* אתר | טלפון — שתי עמודות */}
                <div className="grid grid-cols-1 gap-0 sm:grid-cols-2 sm:divide-x sm:divide-zinc-200/90 dark:sm:divide-zinc-800">
                  <div className="bg-white px-4 py-4 dark:bg-zinc-950/30">
                    <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">אתר</div>
                    <p className="mt-1.5 text-base font-medium text-zinc-900 dark:text-zinc-100">{siteName}</p>
                </div>
                  <div className="bg-white px-4 py-4 dark:bg-zinc-950/30">
                    <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">מספר טלפון</div>
                    <div className="mt-1.5">
                    {isEditingIdentity ? (
                      <input
                        value={editPhone}
                        onChange={(e) => setEditPhone(e.target.value)}
                          dir="ltr"
                          className="h-10 w-full rounded-lg border border-zinc-300 bg-white px-3 text-base focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-600 dark:bg-zinc-900"
                        />
                      ) : (
                        <p className="text-base font-medium tabular-nums text-zinc-900 dark:text-zinc-100" dir="ltr">
                          {effectiveWorker?.phone || "—"}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* תפקידים — שורה מלאה, תגיות */}
                <div className="bg-white px-4 py-4 dark:bg-zinc-950/30">
                  <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">תפקידים</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {effectiveWorker?.roles && effectiveWorker.roles.length ? (
                      effectiveWorker.roles.map((role) => (
                        <span
                          key={role}
                          className="inline-flex items-center rounded-full border border-[#00A8E0]/35 bg-[#00A8E0]/10 px-3 py-1 text-sm font-medium text-[#006a8a] dark:border-[#00A8E0]/40 dark:bg-[#00A8E0]/15 dark:text-[#7dd3ea]"
                        >
                          {role}
                        </span>
                      ))
                    ) : (
                      <span className="text-sm text-zinc-400">—</span>
                    )}
                  </div>
                </div>
              </div>
              {isEditingIdentity && (
                <div className="flex items-center justify-end gap-2 border-t border-zinc-200/90 bg-zinc-50/90 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/50">
                  <button
                    type="button"
                    onClick={() => {
                      setIsEditingIdentity(false);
                      setEditName(worker?.name || "");
                      setEditPhone(worker?.phone || "");
                    }}
                    className="rounded-lg border border-zinc-300 px-4 py-2 text-sm hover:bg-white dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    disabled={savingIdentity}
                  >
                    ביטול
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!worker) return;
                      const name = editName.trim();
                      const phone = editPhone.trim();
                      if (!name) return;
                      setSavingIdentity(true);
                      try {
                        const updated = await apiFetch<Worker>(`/director/sites/${worker.site_id}/workers/${worker.id}`, {
                          method: "PUT",
                          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                          body: JSON.stringify({
                            name,
                            phone,
                            max_shifts: worker.max_shifts,
                            roles: worker.roles || [],
                            // ne pas envoyer availability/answers pour éviter tout overwrite
                          }),
                        });
                        setWorker(updated as any);
                        setIsEditingIdentity(false);
                      } catch (e: any) {
                        setError(String(e?.message || "שגיאה בעדכון עובד"));
                      } finally {
                        setSavingIdentity(false);
                      }
                    }}
                    className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6] disabled:opacity-60"
                    disabled={savingIdentity}
                  >
                    שמור
                  </button>
                </div>
              )}
              <div className="border-t border-zinc-200/90 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950/30">
                <button
                  type="button"
                  disabled={!worker || isEditingIdentity || deletingWorker}
                  onClick={async () => {
                    if (!worker) return;
                    const confirmed = window.confirm(
                      `למחוק את ${worker.name} מהאתר? ההסרה תחול מהשבוע הנוכחי והלאה; שבועות קודמים נשארים בתכנון השמור.`,
                    );
                    if (!confirmed) return;
                    setDeletingWorker(true);
                    try {
                      await apiFetch(`/director/sites/${worker.site_id}/workers/${worker.id}`, {
                        method: "DELETE",
                        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                      });
                      toast.success("העובד הוסר מהאתר");
                      router.push("/director/workers");
                    } catch (e: any) {
                      toast.error("שגיאה במחיקה", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
                    } finally {
                      setDeletingWorker(false);
                    }
                  }}
                  className="inline-flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-800 shadow-sm hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200 dark:hover:bg-red-950/70"
                >
                  {deletingWorker ? (
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-red-600 border-t-transparent dark:border-red-300" />
                  ) : (
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
                      <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                    </svg>
                  )}
                  מחק עובד
                </button>
              </div>
            </section>

            {/* Grille hebdomadaire avec surlignage du travailleur */}
            <section
              dir="rtl"
              className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950/60"
            >
              <div className="border-b border-[#B3ECFF] bg-[#E6F7FF] px-4 py-3 dark:border-cyan-800/70 dark:bg-cyan-950/45">
                <h2 className="text-base font-semibold text-[#004B63] dark:text-cyan-100">שיבוצים לשבוע הנוכחי</h2>
                <p className="mt-0.5 text-xs font-medium text-[#006C8A] dark:text-cyan-200/95">
                  לפי התכנון שפורסם לעובדים לאתר, לשבוע שנבחר למעלה (לא כולל טיוטת מנהל או AI)
                </p>
              </div>
              {!siteConfig || !weekPlan ? (
                <div className="bg-white px-4 py-8 text-center dark:bg-zinc-950/60">
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    אין תכנון שפורסם לעובדים לשבוע זה.
                  </p>
                </div>
              ) : (
                <div className="space-y-4 bg-white p-4 dark:bg-zinc-950/60">
                  {(siteConfig?.stations || []).map((st: any, stationIndex: number) => (
                    <div
                      key={stationIndex}
                      className="overflow-hidden rounded-xl border border-zinc-200/90 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950/40"
                    >
                      <div className="border-b border-[#00A8E0]/25 bg-gradient-to-l from-[#00A8E0]/12 to-transparent px-4 py-2.5 dark:from-[#00A8E0]/20 dark:to-transparent">
                        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                          {st?.name || `עמדה ${stationIndex + 1}`}
                        </span>
                      </div>
                <div className="overflow-x-auto">
                        <div className="min-w-[720px] p-3">
                          <div className="grid grid-cols-8 gap-px overflow-hidden rounded-lg border border-zinc-200 bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-700">
                            <div className="min-h-[2.75rem] bg-zinc-100 dark:bg-zinc-900/90" />
                            {(["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const).map((dk) => (
                              <div
                                key={dk}
                                className={
                                  "flex min-h-[2.75rem] items-center justify-center bg-zinc-100 px-1 py-2 text-center text-[11px] font-semibold leading-tight text-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-200 sm:text-xs " +
                                  (dk === "sun" || dk === "sat" ? "bg-amber-50/90 text-amber-950 dark:bg-amber-950/35 dark:text-amber-100" : "")
                                }
                              >
                                {dayLabels[dk]}
                              </div>
                          ))}
                          {(st?.shifts || []).filter((sh: any) => sh?.enabled).map((sh: any, sIdx: number) => (
                            <Fragment key={`row-${stationIndex}-${sIdx}`}>
                              <div className="flex min-h-[3.25rem] items-center bg-zinc-50 px-2 py-2 text-xs font-semibold text-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-100 sm:text-[13px]">
                                {sh?.name}
                              </div>
                              {(["sun","mon","tue","wed","thu","fri","sat"]).map((dk) => {
                                const names: string[] = (weekPlan.assignments?.[dk]?.[sh?.name]?.[stationIndex] || []) as any;
                                const pulls = (weekPlan as any)?.pulls || {};
                                const cleanNames = (names || []).map(String).map((x) => x.trim()).filter(Boolean);
                                /** Comme worker/history + planning : pas le seul `sh.workers` (ignore יום כבוי / per-day). */
                                const required = getRequiredFor(st, String(sh?.name || ""), dk);
                                const cellPrefix = `${dk}|${sh?.name}|${stationIndex}|`;
                                const pullsCount = Object.keys(pulls || {}).filter((k) => String(k).startsWith(cellPrefix)).length;
                                /** Pas de placeholder « — » si la case est vraiment inactive et sans שיבוץ ni משיכה. */
                                const minSlots =
                                  cleanNames.length === 0 && required === 0 && pullsCount === 0 ? 0 : 1;
                                const slotCount = Math.max(required + pullsCount, cleanNames.length, minSlots);
                                return (
                                  <div
                                    key={`cell-${stationIndex}-${sIdx}-${dk}`}
                                    className={
                                      "min-h-[3.25rem] bg-white p-1.5 dark:bg-zinc-950/50 " +
                                      (dk === "sun" || dk === "sat" ? "bg-amber-50/40 dark:bg-amber-950/15 " : "") +
                                      (cleanNames.length === 0
                                        ? "border border-dashed border-zinc-200 dark:border-zinc-700"
                                        : "border border-zinc-100 dark:border-zinc-800")
                                    }
                                  >
                                    <div className="flex flex-col gap-1">
                                      {Array.from({ length: slotCount }).map((_, slotIdx) => {
                                        const nm = cleanNames[slotIdx];
                                        if (!nm) {
                                          return (
                                            <span
                                              key={`empty-${slotIdx}`}
                                              className="inline-flex h-7 min-w-[2rem] items-center justify-center rounded-md border border-dashed border-zinc-200 bg-zinc-50/80 px-2 text-[11px] text-zinc-400 dark:border-zinc-600 dark:bg-zinc-900/60"
                                            >
                                              —
                                            </span>
                                          );
                                        }
                                        const match = Object.entries(pulls || {}).find(([k, entry]) => {
                                          if (!String(k).startsWith(cellPrefix)) return false;
                                          const e: any = entry;
                                          return e?.before?.name === nm || e?.after?.name === nm;
                                        });
                                        const pullTxt = match
                                          ? (((match as any)[1]?.before?.name === nm)
                                            ? `${(match as any)[1].before.start}-${(match as any)[1].before.end}`
                                            : `${(match as any)[1].after.start}-${(match as any)[1].after.end}`)
                                          : null;
                                        const baseHours =
                                          (sh?.start && sh?.end)
                                            ? `${String(sh.start)}-${String(sh.end)}`
                                            : null;
                                        const myHours = pullTxt || baseHours;
                                        const isTargetWorker = nm === worker?.name;
                                        return (
                                          <span
                                            key={`nm-${nm}-${slotIdx}`}
                                            className={
                                              "group relative inline-flex min-h-[1.75rem] w-full flex-col items-stretch justify-center rounded-md px-1.5 py-1 text-xs shadow-sm " +
                                              (isTargetWorker
                                                ? "bg-emerald-600 text-white ring-1 ring-emerald-700/30 "
                                                : "border border-zinc-200 bg-white text-zinc-800 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 ") +
                                              ((pullTxt && isTargetWorker) ? "ring-2 ring-orange-400 " : "")
                                            }
                                          >
                                            <span
                                              className={"w-full max-w-full truncate " + (isRtlName(nm) ? "text-right" : "text-left")}
                                              dir={isRtlName(nm) ? "rtl" : "ltr"}
                                          >
                                              {nm}
                                            </span>
                                            {isTargetWorker && myHours ? (
                                              <span dir="ltr" className="text-[10px] leading-tight opacity-90 truncate max-w-full" title={myHours}>
                                                {myHours}
                                              </span>
                                            ) : null}

                                            {/* Expansion animée au survol (comme historique) */}
                                            <span
                                              aria-hidden
                                              className="pointer-events-none absolute inset-x-0 top-0.1 z-50 flex justify-center opacity-0 scale-95 group-hover:opacity-100 group-hover:scale-100 transition-all duration-200 ease-out"
                                            >
                                              <span
                                                className={
                                                  "inline-flex flex-col items-center rounded-md px-2 py-1 shadow-lg " +
                                                  (isTargetWorker
                                                    ? "bg-emerald-600 text-white "
                                                    : "border border-zinc-400 text-zinc-800 dark:border-zinc-600 dark:text-zinc-200 bg-white dark:bg-zinc-900 ") +
                                                  ((pullTxt && isTargetWorker) ? "ring-2 ring-orange-400 " : "")
                                                }
                                              >
                                                <span
                                                  className={"whitespace-nowrap leading-tight " + (isRtlName(nm) ? "text-right" : "text-left")}
                                                  dir={isRtlName(nm) ? "rtl" : "ltr"}
                                          >
                                                  {nm}
                                                </span>
                                                {(isTargetWorker && myHours) ? (
                                                  <span dir="ltr" className="text-[10px] leading-tight opacity-90 whitespace-nowrap">
                                                    {myHours}
                                                  </span>
                                                ) : (pullTxt ? (
                                                  <span dir="ltr" className="text-[10px] leading-tight opacity-90 whitespace-nowrap">
                                                    {pullTxt}
                                                  </span>
                                                ) : null)}
                                              </span>
                                            </span>
                                          </span>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })}
                            </Fragment>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                </div>
              )}
            </section>

            {/* Synthèse disponibilité / fiche travailleur */}
            <section
              dir="rtl"
              className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950/60"
            >
              <div className="border-b border-[#B3ECFF] bg-[#E6F7FF] px-4 py-3 dark:border-cyan-800/70 dark:bg-cyan-950/45">
                <h2 className="text-base font-semibold text-[#004B63] dark:text-cyan-100">בקשות העובד</h2>
                <p className="mt-0.5 text-xs font-medium text-[#006C8A] dark:text-cyan-200/95">נתונים מהגדרת העובד במערכת (לא לפי שבוע)</p>
              </div>
              <div className="space-y-4 bg-white p-4 dark:bg-zinc-950/60">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border border-zinc-200/90 bg-white px-3 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/50">
                    <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">שם</div>
                    <div className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{workerSystemProfile?.name}</div>
                  </div>
                  <div className="rounded-lg border border-zinc-200/90 bg-white px-3 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/50">
                    <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">מקס&apos; משמרות</div>
                    <div className="mt-1 text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                      {workerSystemProfile?.max_shifts ?? "—"}
                    </div>
                  </div>
                  <div className="rounded-lg border border-zinc-200/90 bg-white px-3 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/50 sm:col-span-1">
                    <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">תפקידים</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {workerSystemProfile?.roles?.length ? (
                        workerSystemProfile.roles.map((role) => (
                          <span
                            key={role}
                            className="inline-flex rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-800 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
                          >
                            {role}
                          </span>
                        ))
                      ) : (
                        <span className="text-sm text-zinc-400">—</span>
                      )}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-xs font-semibold text-[#004B63] dark:text-cyan-100">זמינות לפי יום</div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                    {Object.keys(dayLabels).map((dk) => {
                      const slots = (workerSystemProfile?.availability?.[dk] || []) as string[];
                      const has = slots.length > 0;
                      return (
                        <div
                          key={dk}
                          className="rounded-lg border border-zinc-200/90 bg-white px-2.5 py-2 text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-950/50"
                        >
                          <div className="font-semibold text-[#004B63] dark:text-cyan-100">{dayLabels[dk]}</div>
                          <div
                            className={
                              "mt-1.5 min-h-[1.25rem] text-[11px] leading-snug " +
                              (has
                                ? "font-medium text-[#006C8A] dark:text-cyan-200"
                                : "text-[#006C8A]/55 dark:text-cyan-300/70")
                            }
                          >
                            {has ? slots.join(" · ") : "—"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </section>

            </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

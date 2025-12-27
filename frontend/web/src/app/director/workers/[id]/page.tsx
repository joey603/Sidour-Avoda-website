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
  phone?: string | null;
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
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => new Date(weekStart.getFullYear(), weekStart.getMonth(), 1));
  const [isEditingIdentity, setIsEditingIdentity] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [savingIdentity, setSavingIdentity] = useState(false);

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

  // Synchroniser le mois du calendrier avec la semaine sélectionnée
  useEffect(() => {
    if (!isCalendarOpen) {
      setCalendarMonth(new Date(weekStart.getFullYear(), weekStart.getMonth(), 1));
    }
  }, [weekStart, isCalendarOpen]);

  const effectiveWorker = useMemo(() => {
    if (!worker) return null;
    // eslint-disable-next-line no-console
    console.log("[WorkerDetails] effectiveWorker - worker:", worker, "phone:", worker.phone);
    const snap = weekPlan?.workers?.find((w: any) => String(w.id) === String(worker.id));
    if (snap) {
      return {
        id: worker.id,
        site_id: worker.site_id,
        // IMPORTANT: toujours afficher l'identité depuis la DB (sinon un plan sauvegardé peut réafficher l'ancien nom)
        name: String(worker.name),
        max_shifts: typeof (snap as any).max_shifts === "number" ? (snap as any).max_shifts : worker.max_shifts,
        roles: Array.isArray((snap as any).roles) ? (snap as any).roles : worker.roles,
        availability: (snap as any).availability || worker.availability,
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
            <button
              onClick={() => setIsCalendarOpen(true)}
              className="inline-flex items-center rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              aria-label="בחר שבוע מלוח שנה"
              title="בחר שבוע מלוח שנה"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
                <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z"/>
                <path d="M7 14h5v5H7z"/>
              </svg>
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
          <>
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
                      const days: JSX.Element[] = [];
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
            <div className="space-y-6">
            <section className="rounded-xl border p-4 dark:border-zinc-800">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <div className="text-sm text-zinc-500">שם עובד</div>
                  <div className="flex items-center gap-2">
                    {isEditingIdentity ? (
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-9 w-full rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-700 bg-white dark:bg-zinc-900"
                      />
                    ) : (
                      <div className="text-base font-medium">{effectiveWorker?.name}</div>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditingIdentity(true);
                        setEditName(effectiveWorker?.name || "");
                        setEditPhone(effectiveWorker?.phone || "");
                      }}
                      className="inline-flex items-center rounded-md border px-2 py-2 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      aria-label="ערוך שם עובד"
                      title="ערוך"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75Z"/>
                      </svg>
                    </button>
                  </div>
                </div>
                <div>
                  <div className="text-sm text-zinc-500">אתר</div>
                  <div className="text-base font-medium">{siteName}</div>
                </div>
                <div>
                  <div className="text-sm text-zinc-500">מספר טלפון</div>
                  <div className="flex items-center gap-2">
                    {isEditingIdentity ? (
                      <input
                        value={editPhone}
                        onChange={(e) => setEditPhone(e.target.value)}
                        className="h-9 w-full rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-700 bg-white dark:bg-zinc-900"
                      />
                    ) : (
                      <div className="text-base font-medium">{effectiveWorker?.phone || "—"}</div>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditingIdentity(true);
                        setEditName(effectiveWorker?.name || "");
                        setEditPhone(effectiveWorker?.phone || "");
                      }}
                      className="inline-flex items-center rounded-md border px-2 py-2 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      aria-label="ערוך מספר טלפון"
                      title="ערוך"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75Z"/>
                      </svg>
                    </button>
                  </div>
                </div>
                <div>
                  <div className="text-sm text-zinc-500">תפקידים</div>
                  <div className="text-base font-medium">{effectiveWorker?.roles && effectiveWorker.roles.length ? effectiveWorker.roles.join(", ") : "—"}</div>
                </div>
              </div>
              {isEditingIdentity && (
                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsEditingIdentity(false);
                      setEditName(worker?.name || "");
                      setEditPhone(worker?.phone || "");
                    }}
                    className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
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
          </>
        ) : null}
      </div>
    </div>
  );
}

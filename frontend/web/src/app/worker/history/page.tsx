"use client";

import { useEffect, useState, useMemo, Fragment } from "react";
import type { ReactElement } from "react";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import LoadingAnimation from "@/components/loading-animation";

interface Site {
  id: number;
  name: string;
  config?: any;
}

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

export default function WorkerHistoryPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [weekPlanLoading, setWeekPlanLoading] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const [siteConfig, setSiteConfig] = useState<any | null>(null);
  const [weekStart, setWeekStart] = useState<Date>(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = today.getDay();
    const startThisWeek = new Date(today);
    startThisWeek.setDate(today.getDate() - day);
    return startThisWeek;
  });
  const [weekPlan, setWeekPlan] = useState<null | {
    assignments: Record<string, Record<string, string[][]>>;
    isManual: boolean;
    workers?: Array<{ id: number; name: string; max_shifts?: number; roles?: string[]; availability?: Record<string, string[]> }>;
    pulls?: Record<string, { before: { name: string; start: string; end: string }; after: { name: string; start: string; end: string } }>;
  }>(null);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => new Date(weekStart.getFullYear(), weekStart.getMonth(), 1));
  const [workerName, setWorkerName] = useState<string>("");
  const [workerId, setWorkerId] = useState<number | null>(null);
  const [workerData, setWorkerData] = useState<{
    max_shifts?: number;
    roles?: string[];
    availability?: Record<string, string[]>;
  } | null>(null);

  // Nombre de עובדים requis (comme sur le planning directeur)
  function getRequiredFor(st: any, shiftName: string, dayKey: string): number {
    if (!st) return 0;
    if (st.perDayCustom) {
      const dayCfg = st.dayOverrides?.[dayKey];
      if (!dayCfg || dayCfg.active === false) return 0;
      if (st.uniformRoles) return Number(st.workers || 0);
      const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
      if (!sh || !sh.enabled) return 0;
      return Number(sh.workers || 0);
    }
    if (st.days && st.days[dayKey] === false) return 0;
    if (st.uniformRoles) return Number(st.workers || 0);
    const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
    if (!sh || !sh.enabled) return 0;
    return Number(sh.workers || 0);
  }

  // Fonction pour obtenir la clé de semaine (comme dans רישום זמינות)
  function getWeekKey(siteId: number, date: Date, wid?: number | null): string {
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const suffix = wid ? `_w${wid}` : "";
    return `worker_avail_${siteId}_${iso(date)}${suffix}`;
  }

  // Calculer la semaine prochaine (dimanche prochain à samedi prochain)
  function calculateNextWeek() {
    const today = new Date();
    const currentDay = today.getDay(); // 0 = dimanche, 6 = samedi
    const daysUntilNextSunday = currentDay === 0 ? 7 : 7 - currentDay;
    
    const nextSunday = new Date(today);
    nextSunday.setDate(today.getDate() + daysUntilNextSunday);
    nextSunday.setHours(0, 0, 0, 0);
    
    return nextSunday;
  }

  // Fonction pour charger les זמינות depuis localStorage
  function loadAvailabilityFromStorage(siteId: number, weekDate: Date) {
    const keyNew = getWeekKey(siteId, weekDate, workerId);
    const keyOld = getWeekKey(siteId, weekDate);
    try {
      const saved = localStorage.getItem(keyNew) ?? localStorage.getItem(keyOld);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          // Si c'est un objet avec availability et maxShifts
          if (parsed.availability && typeof parsed.availability === 'object') {
            return {
              availability: parsed.availability,
              max_shifts: typeof parsed.maxShifts === 'number' && parsed.maxShifts >= 1 && parsed.maxShifts <= 6 ? parsed.maxShifts : undefined,
            };
          } else {
            // Sinon, c'est directement l'objet availability
            return {
              availability: parsed,
            };
          }
        }
      }
    } catch (e) {
      // Ignorer les erreurs de parsing
    }
    return null;
  }

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
      if (!me) return router.replace("/login/worker");
      if (me.role !== "worker") return router.replace("/director");
      setWorkerName(me.full_name || "");
      setWorkerId(typeof (me as any).id === "number" ? (me as any).id : null);
      
      try {
        // Charger les sites où le travailleur est enregistré
        const sitesList = await apiFetch<Array<{ id: number; name: string }>>("/public/sites/worker-sites", {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        });
        setSites(sitesList || []);
        
        // Si un seul site, le sélectionner automatiquement
        if (sitesList && sitesList.length === 1) {
          setSelectedSiteId(sitesList[0].id);
          await loadSiteInfo(sitesList[0].id);
        }
      } catch (e: any) {
        console.error("Error loading sites:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  async function loadSiteInfo(siteId: number, targetWeek?: Date) {
    const weekToUse = targetWeek || weekStart;
    try {
      // Charger la config complète du site
      const site = await apiFetch<{ id: number; name: string; config: any }>(`/public/sites/${siteId}/config`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
      });
      setSiteConfig(site?.config || null);
      
      // Charger les données du worker depuis le serveur (source de vérité)
      try {
        const workerInfo = await apiFetch<{
          id: number;
          name: string;
          max_shifts: number;
          roles: string[];
          availability: Record<string, string[]>;
          answers: { general?: Record<string, any>; perDay?: Record<string, any> } | Record<string, any>;
        }>(`/public/sites/${siteId}/worker-availability`, {
          headers: { 
            Authorization: `Bearer ${localStorage.getItem("access_token")}`,
          },
        });
        
        if (workerInfo) {
          // Utiliser les זמינות depuis le serveur (source de vérité)
          // Note: les זמינות de la base de données sont pour la semaine prochaine uniquement
          const nextWeekStart = calculateNextWeek();
          const isNextWeek = weekToUse.getTime() === nextWeekStart.getTime();
          const finalAvailability = (isNextWeek ? workerInfo.availability : {}) || {};
          const finalMaxShifts = workerInfo.max_shifts;
          
          setWorkerData({
            max_shifts: finalMaxShifts,
            roles: workerInfo.roles || [],
            availability: finalAvailability,
          });
        }
      } catch (e2: any) {
        // Si le serveur échoue, essayer de charger depuis localStorage comme fallback
        console.warn("Erreur lors du chargement depuis le serveur, tentative avec localStorage:", e2);
        const storedData = loadAvailabilityFromStorage(siteId, weekToUse);
        if (storedData) {
          setWorkerData({
            max_shifts: storedData.max_shifts,
            roles: [],
            availability: storedData.availability || {},
          });
        }
      }
    } catch (e: any) {
      console.error("Error loading site info:", e);
    }
  }

  useEffect(() => {
    if (selectedSiteId) {
      loadSiteInfo(selectedSiteId);
    }
  }, [selectedSiteId]);

  // Recharger les זמינות quand la semaine change
  useEffect(() => {
    if (!selectedSiteId || !workerName) return;
    
    // Recharger depuis le serveur (source de vérité)
      loadSiteInfo(selectedSiteId, weekStart);
  }, [weekStart, selectedSiteId, workerName]);

  useEffect(() => {
    if (!selectedSiteId) return;
    
    // Charger le plan sauvegardé pour cette semaine
    const start = new Date(weekStart);
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const key = `plan_${selectedSiteId}_${iso(start)}`;
    (async () => {
      setWeekPlanLoading(true);
      try {
        const wk = iso(start);
        const fromApi = await apiFetch<any>(`/public/sites/${selectedSiteId}/week-plan?week=${encodeURIComponent(wk)}`, {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          cache: "no-store" as any,
        });
        if (fromApi && typeof fromApi === "object" && fromApi.assignments) {
          try { localStorage.setItem(key, JSON.stringify(fromApi)); } catch {}
          setWeekPlan({
            assignments: fromApi.assignments,
            isManual: !!fromApi.isManual,
            workers: Array.isArray(fromApi.workers) ? fromApi.workers : undefined,
            pulls: (fromApi && fromApi.pulls && typeof fromApi.pulls === "object") ? fromApi.pulls : undefined,
          });
          return;
        }
      } catch {}
      // Fallback localStorage
      try {
        const raw = typeof window !== "undefined" ? localStorage.getItem(key) : null;
        if (raw) {
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
        }
      } catch {}
      setWeekPlan(null);
      setWeekPlanLoading(false);
      return;
    })().finally(() => {
      setWeekPlanLoading(false);
    })();
  }, [selectedSiteId, weekStart]);

  // Synchroniser le mois du calendrier avec la semaine sélectionnée
  useEffect(() => {
    if (!isCalendarOpen) {
      setCalendarMonth(new Date(weekStart.getFullYear(), weekStart.getMonth(), 1));
    }
  }, [weekStart, isCalendarOpen]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingAnimation size={80} />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">היסטוריה</h1>
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
        </div>
        {weekPlanLoading && (
          <LoadingAnimation className="py-2" size={48} />
        )}

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
                  startDate.setDate(startDate.getDate() - firstDay.getDay());
                  const days: ReactElement[] = [];
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  
                  for (let i = 0; i < 42; i++) {
                    const date = new Date(startDate);
                    date.setDate(date.getDate() + i);
                    const isCurrentMonth = date.getMonth() === month;
                    const isToday = date.getTime() === today.getTime();
                    const isWeekStart = date.getDay() === 0;
                    
                    const weekStartForDate = new Date(date);
                    weekStartForDate.setDate(date.getDate() - date.getDay());
                    const isCurrentWeek = weekStartForDate.getTime() === weekStart.getTime();
                    
                    days.push(
                      <button
                        key={i}
                        type="button"
                        onClick={() => {
                          const selectedWeekStart = new Date(date);
                          selectedWeekStart.setDate(date.getDate() - date.getDay());
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
                      </button>
                    );
                  }
                  return days;
                })()}
              </div>
            </div>
          </div>
        )}

        {sites.length > 1 && (
          <div className="rounded-xl border p-4 dark:border-zinc-800">
            <label className="block text-sm font-medium mb-2">בחר אתר</label>
            <select
              value={selectedSiteId || ""}
              onChange={(e) => setSelectedSiteId(Number(e.target.value) || null)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
            >
              <option value="">בחר אתר</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {selectedSiteId ? (
          <>
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
                                const pulls = (weekPlan as any)?.pulls || {};
                                const cleanNames = (names || []).map(String).map((x) => x.trim()).filter(Boolean);
                                const required = getRequiredFor(st, sh?.name, dk);
                                const cellPrefix = `${dk}|${sh?.name}|${stationIndex}|`;
                                const pullsCount = Object.keys(pulls || {}).filter((k) => String(k).startsWith(cellPrefix)).length;
                                const slotCount = Math.max(required + pullsCount, cleanNames.length, 1);
                                return (
                                  <div
                                    key={`cell-${stationIndex}-${sIdx}-${dk}`}
                                    className={
                                      "rounded-md border p-1 min-h-10 dark:border-zinc-700 " +
                                      (cleanNames.length === 0 ? "bg-zinc-100 dark:bg-zinc-900/40" : "")
                                    }
                                  >
                                    <div className="flex flex-col gap-1">
                                      {Array.from({ length: slotCount }).map((_, slotIdx) => {
                                        const nm = cleanNames[slotIdx];
                                        if (!nm) {
                                          return (
                                            <span
                                              key={`empty-${slotIdx}`}
                                              className="inline-flex h-6 items-center justify-center rounded-full border px-2 text-xs text-zinc-500 bg-white dark:bg-zinc-900 dark:border-zinc-700"
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
                                        return (
                                          <span
                                            key={`nm-${nm}-${slotIdx}`}
                                            className={
                                              "group relative text-xs inline-flex flex-col items-center rounded px-1 " +
                                              (nm === workerName
                                                ? "bg-green-500 text-white "
                                                : "border border-zinc-400 text-zinc-800 dark:border-zinc-600 dark:text-zinc-200 ") +
                                              ((pullTxt && nm === workerName) ? "ring-2 ring-orange-400 " : "")
                                            }
                                          >
                                            <span
                                              className={"w-full max-w-full truncate " + (isRtlName(nm) ? "text-right" : "text-left")}
                                              dir={isRtlName(nm) ? "rtl" : "ltr"}
                                            >
                                              {nm}
                                            </span>
                                            {nm === workerName && myHours ? (
                                              <span dir="ltr" className="text-[10px] leading-tight opacity-90 truncate max-w-full" title={myHours}>{myHours}</span>
                                            ) : (
                                              pullTxt ? <span dir="ltr" className="text-[10px] leading-tight opacity-90 truncate max-w-full" title={pullTxt}>{pullTxt}</span> : null
                                            )}

                                            {/* Expansion animée au survol (menu worker) */}
                                            <span
                                              aria-hidden
                                              className="pointer-events-none absolute inset-x-0 top-0.1 z-50 flex justify-center opacity-0 scale-95 group-hover:opacity-100 group-hover:scale-100 transition-all duration-200 ease-out"
                                            >
                                              <span
                                                className={
                                                  "inline-flex flex-col items-center rounded px-2 py-1 shadow-lg " +
                                                  (nm === workerName
                                                    ? "bg-green-500 text-white "
                                                    : "border border-zinc-400 text-zinc-800 dark:border-zinc-600 dark:text-zinc-200 bg-white dark:bg-zinc-900 ") +
                                                  ((pullTxt && nm === workerName) ? "ring-2 ring-orange-400 " : "")
                                                }
                                              >
                                                <span
                                                  className={"whitespace-nowrap leading-tight " + (isRtlName(nm) ? "text-right" : "text-left")}
                                                  dir={isRtlName(nm) ? "rtl" : "ltr"}
                                          >
                                                  {nm}
                                                </span>
                                                {(nm === workerName && myHours) ? (
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
                    ))}
                  </div>
                </div>
              )}
            </section>

            {/* Tableau des demandes */}
            <section className="rounded-xl border p-4 dark:border-zinc-800">
              <h2 className="mb-3 text-lg font-semibold">בקשות העובד</h2>
              {workerData ? (
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
                        <td className="px-2 py-2">{workerName}</td>
                        <td className="px-2 py-2">{workerData.max_shifts || "—"}</td>
                        <td className="px-2 py-2">{workerData.roles?.length ? workerData.roles.join(", ") : "—"}</td>
                        <td className="px-2 py-2">
                          {Object.keys(dayLabels).map((dk) => (
                            <span key={dk} className="inline-flex items-center gap-1 mr-2 mb-1">
                              <span className="text-xs text-zinc-500">{dayLabels[dk]}:</span>
                              <span className="text-xs">{(workerData.availability?.[dk] || []).join(" | ") || "—"}</span>
                            </span>
                          ))}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <LoadingAnimation className="py-4" size={50} />
              )}
            </section>
          </>
        ) : (
          <div className="rounded-xl border p-4 dark:border-zinc-800">
            <p className="text-sm text-zinc-500">
              {sites.length === 0 ? "אין אתרים זמינים" : "נא לבחור אתר"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

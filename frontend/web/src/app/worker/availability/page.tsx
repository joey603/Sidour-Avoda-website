"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import LoadingAnimation from "@/components/loading-animation";

type WorkerAvailability = Record<string, string[]>; // key: day key (sun..sat) -> enabled shift names
type QuestionType = "text" | "dropdown" | "yesno" | "slider";
type SiteQuestion = {
  id: string;
  label: string;
  type: QuestionType;
  perDay?: boolean;
  options?: string[];
  slider?: { min: number; max: number; step: number };
};

export default function WorkerAvailabilityPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [sites, setSites] = useState<Array<{ id: number; name: string }>>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const [siteName, setSiteName] = useState<string>("");
  const [shifts, setShifts] = useState<string[]>([]);
  const [siteQuestions, setSiteQuestions] = useState<SiteQuestion[]>([]);
  const [answersGeneral, setAnswersGeneral] = useState<Record<string, any>>({});
  const [answersPerDay, setAnswersPerDay] = useState<Record<string, Record<string, any>>>({});
  const [availability, setAvailability] = useState<WorkerAvailability>({
    sun: [],
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
  });
  const [success, setSuccess] = useState(false);
  const [workerName, setWorkerName] = useState<string>("");
  const [workerId, setWorkerId] = useState<number | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [hasBeenSaved, setHasBeenSaved] = useState(false); // Pour savoir si on a déjà sauvegardé
  const [nextWeekStart, setNextWeekStart] = useState<Date | null>(null);
  const [nextWeekEnd, setNextWeekEnd] = useState<Date | null>(null);
  const [maxShifts, setMaxShifts] = useState<number>(5);

  // Calculer la semaine prochaine (dimanche prochain à samedi prochain)
  function calculateNextWeek() {
    const today = new Date();
    const currentDay = today.getDay(); // 0 = dimanche, 6 = samedi
    const daysUntilNextSunday = currentDay === 0 ? 7 : 7 - currentDay; // Si c'est dimanche, prendre le dimanche suivant
    
    const nextSunday = new Date(today);
    nextSunday.setDate(today.getDate() + daysUntilNextSunday);
    nextSunday.setHours(0, 0, 0, 0);
    
    const nextSaturday = new Date(nextSunday);
    nextSaturday.setDate(nextSunday.getDate() + 6);
    nextSaturday.setHours(23, 59, 59, 999);
    
    return { start: nextSunday, end: nextSaturday };
  }

  // Fonction pour obtenir la clé de semaine
  function getWeekKey(siteId: number, date: Date, wid?: number | null): string {
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const suffix = wid ? `_w${wid}` : "";
    return `worker_avail_${siteId}_${iso(date)}${suffix}`;
  }

  // Fonction pour obtenir la clé de semaine au format ISO (pour le backend)
  function getWeekKeyISO(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  }

  // Charger les זמינות depuis le serveur (source de vérité)
  async function loadWorkerAvailabilityFromServer(siteId: number) {
    if (!nextWeekStart) return;
    try {
      const weekKeyISO = getWeekKeyISO(nextWeekStart);
      const workerData = await apiFetch<{
        id: number;
        name: string;
        max_shifts: number;
        roles: string[];
        availability: Record<string, string[]>;
        answers: { general?: Record<string, any>; perDay?: Record<string, any> } | Record<string, any>;
      }>(`/public/sites/${siteId}/worker-availability?week_key=${encodeURIComponent(weekKeyISO)}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
      });

      if (workerData) {
        // Charger les זמינות depuis le serveur
        if (workerData.availability && typeof workerData.availability === 'object') {
          setAvailability(workerData.availability);
        }
        if (typeof workerData.max_shifts === 'number' && workerData.max_shifts >= 1 && workerData.max_shifts <= 6) {
          setMaxShifts(workerData.max_shifts);
        }
        
        // Gérer les réponses aux questions
        if (workerData.answers && typeof workerData.answers === "object") {
          // Nouveau format: {general, perDay}
          if ("general" in workerData.answers || "perDay" in workerData.answers) {
            setAnswersGeneral((workerData.answers as any).general && typeof (workerData.answers as any).general === "object" ? (workerData.answers as any).general : {});
            setAnswersPerDay((workerData.answers as any).perDay && typeof (workerData.answers as any).perDay === "object" ? (workerData.answers as any).perDay : {});
          } else {
            // Ancien format: answers = {qid: value}
            setAnswersGeneral(workerData.answers);
            setAnswersPerDay({});
          }
        }

        // Si des données existent, marquer comme édité et sauvegardé
        const hasData = Object.keys(workerData.availability || {}).length > 0 || 
                       Object.keys(workerData.answers || {}).length > 0;
        if (hasData) {
          setIsEditing(true);
          setSuccess(true);
          setHasBeenSaved(true);
        }

        // Mettre à jour le cache localStorage (optionnel, pour performance)
        const keyNew = getWeekKey(siteId, nextWeekStart, workerId);
        localStorage.setItem(keyNew, JSON.stringify({
          availability: workerData.availability || {},
          maxShifts: workerData.max_shifts,
          answers: workerData.answers || {},
        }));
      }
    } catch (e: any) {
      // Si le serveur échoue, essayer de charger depuis localStorage comme fallback
      console.warn("Erreur lors du chargement depuis le serveur, tentative avec localStorage:", e);
      loadSavedAvailabilityFromLocalStorage(siteId);
    }
  }

  // Charger depuis localStorage (fallback uniquement)
  function loadSavedAvailabilityFromLocalStorage(siteId: number) {
    if (!nextWeekStart) return;
    const keyNew = getWeekKey(siteId, nextWeekStart, workerId);
    const keyOld = getWeekKey(siteId, nextWeekStart);
    try {
      const saved = localStorage.getItem(keyNew) ?? localStorage.getItem(keyOld);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          // Si c'est un objet avec availability et maxShifts
          if (parsed.availability && typeof parsed.availability === 'object') {
            setAvailability(parsed.availability);
            if (typeof parsed.maxShifts === 'number' && parsed.maxShifts >= 1 && parsed.maxShifts <= 6) {
              setMaxShifts(parsed.maxShifts);
            }
            if (parsed.answers && typeof parsed.answers === "object") {
              // Nouveau format: {general, perDay}
              if ("general" in parsed.answers || "perDay" in parsed.answers) {
                setAnswersGeneral((parsed.answers as any).general && typeof (parsed.answers as any).general === "object" ? (parsed.answers as any).general : {});
                setAnswersPerDay((parsed.answers as any).perDay && typeof (parsed.answers as any).perDay === "object" ? (parsed.answers as any).perDay : {});
              } else {
                // Ancien format: answers = {qid: value}
                setAnswersGeneral(parsed.answers);
                setAnswersPerDay({});
              }
            }
          } else {
            // Sinon, c'est directement l'objet availability
            setAvailability(parsed);
          }
          setIsEditing(true);
          setSuccess(true);
          setHasBeenSaved(true);
        }
      }
    } catch (e) {
      // Ignorer les erreurs de parsing
    }
  }

  useEffect(() => {
    const { start, end } = calculateNextWeek();
    setNextWeekStart(start);
    setNextWeekEnd(end);
  }, []);

  // Charger l'état sauvegardé quand nextWeekStart et selectedSiteId sont disponibles
  useEffect(() => {
    if (selectedSiteId && nextWeekStart) {
      loadWorkerAvailabilityFromServer(selectedSiteId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSiteId, nextWeekStart, workerId]);

  useEffect(() => {
    async function loadSites() {
      const me = await fetchMe();
      if (!me) {
        router.replace("/login/worker");
        return;
      }
      if (me.role !== "worker") {
        router.replace("/director");
        return;
      }

      setWorkerName(me.full_name || "");
      setWorkerId(typeof (me as any).id === "number" ? (me as any).id : null);

      try {
        const sitesList = await apiFetch<Array<{ id: number; name: string }>>("/public/sites/worker-sites", {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        });
        setSites(sitesList || []);
        
        // Si un seul site, le sélectionner automatiquement
        if (sitesList && sitesList.length === 1) {
          setSelectedSiteId(sitesList[0].id);
          loadSiteInfo(sitesList[0].id);
        }
      } catch (e: any) {
        toast.error("שגיאה בטעינת אתרים", { description: e?.message || "נסה שוב מאוחר יותר." });
      } finally {
        setLoading(false);
      }
    }
    loadSites();
  }, [router]);

  async function loadSiteInfo(siteId: number) {
    try {
      const info = await apiFetch<{ id: number; name: string; shifts: string[]; questions?: SiteQuestion[] }>(`/public/sites/${siteId}/info`);
      setSiteName(info.name || "");
      setShifts(info.shifts || ["06-14", "14-22", "22-06"]);
      setSiteQuestions(Array.isArray(info.questions) ? info.questions : []);
      // Charger les זמינות depuis le serveur (source de vérité)
      await loadWorkerAvailabilityFromServer(siteId);
    } catch (e: any) {
      toast.error("שגיאה בטעינת פרטי האתר", { description: e?.message || "נסה שוב מאוחר יותר." });
    }
  }


  function handleSiteSelect(siteId: number) {
    setSelectedSiteId(siteId);
    setSuccess(false);
    setIsEditing(false);
    setHasBeenSaved(false);
    setMaxShifts(5);
    setAnswersGeneral({});
    setAnswersPerDay({});
    setSiteQuestions([]);
    setAvailability({
      sun: [],
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
    });
    loadSiteInfo(siteId);
  }

  const dayDefs = [
    { key: "sun", label: "א'" },
    { key: "mon", label: "ב'" },
    { key: "tue", label: "ג'" },
    { key: "wed", label: "ד'" },
    { key: "thu", label: "ה'" },
    { key: "fri", label: "ו'" },
    { key: "sat", label: "ש'" },
  ];

  function toggleAvailability(dayKey: string, shiftName: string) {
    setAvailability((prev) => {
      const dayShifts = prev[dayKey] || [];
      const hasShift = dayShifts.includes(shiftName);
      return {
        ...prev,
        [dayKey]: hasShift ? dayShifts.filter((s) => s !== shiftName) : [...dayShifts, shiftName],
      };
    });
  }

  // Trier les shifts dans l'ordre : matin, midi, nuit
  function sortShifts(shifts: string[]): string[] {
    const shiftOrder: Record<string, number> = {
      morning: 1,
      matin: 1,
      בוקר: 1,
      midi: 2,
      צהריים: 2,
      noon: 2,
      nuit: 3,
      לילה: 3,
      night: 3,
    };
    
    return [...shifts].sort((a, b) => {
      // Extraire le numéro de début pour les shifts au format "06-14", "14-22", "22-06"
      const getShiftType = (shift: string): number => {
        const lower = shift.toLowerCase();
        // Vérifier les mots-clés
        for (const [key, order] of Object.entries(shiftOrder)) {
          if (lower.includes(key)) {
            return order;
          }
        }
        // Vérifier le format numérique
        const match = shift.match(/^(\d+)/);
        if (match) {
          const hour = parseInt(match[1], 10);
          if (hour >= 6 && hour < 14) return 1; // matin
          if (hour >= 14 && hour < 22) return 2; // midi
          if (hour >= 22 || hour < 6) return 3; // nuit
        }
        return 999; // autres shifts à la fin
      };
      
      return getShiftType(a) - getShiftType(b);
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedSiteId) {
      toast.error("נא לבחור אתר");
      return;
    }
    if (!workerName.trim()) {
      toast.error("נא להזין שם");
      return;
    }
    if (!nextWeekStart) {
      toast.error("שגיאה בחישוב השבוע");
      return;
    }
    // Valider les réponses aux questions (si configurées)
    const qs = (siteQuestions || []).filter((q) => (q?.label || "").trim());
    const generalQs = qs.filter((q) => !q.perDay);
    const perDayQs = qs.filter((q) => !!q.perDay);
    const missingGeneral = generalQs.filter((q) => {
      const v = (answersGeneral || {})[q.id];
      if (q.type === "yesno") return !(v === true || v === false);
      if (q.type === "slider") return typeof v !== "number";
      return !String(v || "").trim();
    });
    const missingPerDay = perDayQs.filter((q) => {
      const per = (answersPerDay || {})[q.id] || {};
      return dayDefs.some((d) => {
        const v = per[d.key];
        if (q.type === "yesno") return !(v === true || v === false);
        if (q.type === "slider") return typeof v !== "number";
        return !String(v || "").trim();
      });
    });
    if (missingGeneral.length > 0 || missingPerDay.length > 0) {
      toast.error("נא לענות על כל השאלות");
      return;
    }
    setSubmitting(true);
    try {
      if (!nextWeekStart) {
        toast.error("שגיאה: לא נמצא תאריך שבוע");
        setSubmitting(false);
        return;
      }
      const weekKeyISO = getWeekKeyISO(nextWeekStart);
      // IMPORTANT: send week_key as query param so backend can store answers per-week reliably
      await apiFetch(`/public/sites/${selectedSiteId}/register?week_key=${encodeURIComponent(weekKeyISO)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: workerName.trim(),
          max_shifts: maxShifts,
          roles: [],
          availability: availability,
          // Backward/forward compatible:
          // - Old backend expects answers.week_key in body (stores answers[week_key])
          // - New backend can also read week_key from query param
          answers: { week_key: weekKeyISO, general: answersGeneral, perDay: answersPerDay },
        }),
      });
      
      // Sauvegarder dans localStorage avec la clé de semaine (inclure maxShifts)
      const weekKey = getWeekKey(selectedSiteId, nextWeekStart, workerId);
      localStorage.setItem(weekKey, JSON.stringify({
        availability: availability,
        maxShifts: maxShifts,
        answers: { general: answersGeneral, perDay: answersPerDay },
      }));
      
      setSuccess(true);
      setIsEditing(true);
      setHasBeenSaved(true);
      toast.success("הזמינות נשמרה בהצלחה!");
    } catch (e: any) {
      toast.error("שגיאה בשמירה", { description: e?.message || "נסה שוב מאוחר יותר." });
    } finally {
      setSubmitting(false);
    }
  }

  function handleEdit(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    // Activer le mode édition pour permettre les modifications
    setIsEditing(false);
    setSuccess(false);
    // hasBeenSaved reste true pour savoir qu'on est en mode édition
    // Les champs seront maintenant activés car success && isEditing = false
  }

  function handleMaxShiftsChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = parseInt(e.target.value, 10);
    if (value >= 1 && value <= 6) {
      setMaxShifts(value);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingAnimation size={80} />
      </div>
    );
  }

  if (sites.length === 0) {
    return (
      <div className="min-h-screen p-6">
        <div className="mx-auto max-w-2xl">
          <h1 className="mb-6 text-2xl font-bold">רישום זמינות</h1>
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
            <div className="text-center py-8">
              <p className="text-zinc-600 dark:text-zinc-400 mb-4">אין אתרים זמינים</p>
              <p className="text-sm text-zinc-500 dark:text-zinc-500">
                עליך להירשם לאתר תחילה באמצעות הקישור שקיבלת מהמנהל
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-zinc-900 dark:to-zinc-800 p-6">
      <div className="mx-auto max-w-2xl">
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
              רישום זמינות
              {siteName && (
                <span className="block mt-2 text-lg font-semibold text-blue-600 dark:text-blue-400">
                  {siteName}
                </span>
              )}
            </h1>
            {nextWeekStart && nextWeekEnd && (
              <p className="mt-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                שבוע הבא: {nextWeekStart.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' })} - {nextWeekEnd.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' })}
              </p>
            )}
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              {siteName ? "עדכן את זמינותך השבועית" : "בחר אתר ועדכן את זמינותך השבועית"}
            </p>
          </div>

          {sites.length > 1 && (
            <div className="mb-6">
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                בחר אתר
              </label>
              <select
                value={selectedSiteId || ""}
                onChange={(e) => handleSiteSelect(Number(e.target.value))}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              >
                <option value="">-- בחר אתר --</option>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {selectedSiteId && (
            <>
              {success && isEditing && !submitting && (
                <div className="mb-4 rounded-lg bg-green-50 border border-green-200 p-4 text-center text-green-800 dark:bg-green-900/20 dark:border-green-800 dark:text-green-200">
                  ✓ הזמינות נשמרה בהצלחה לשבוע הבא!
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                    שם העובד
                  </label>
                  <input
                    type="text"
                    value={workerName}
                    readOnly
                    required
                    disabled
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 opacity-100 cursor-not-allowed"
                    placeholder="הזן את שמך"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                    מספר מקסימלי של משמרות (1-6)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="6"
                    value={maxShifts}
                    onChange={handleMaxShiftsChange}
                    disabled={submitting || (success && isEditing)}
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 disabled:opacity-60"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">
                    זמינות שבועית - {siteName}
                  </label>
                  <div className="space-y-4">
                    {dayDefs.map((day) => (
                      <div key={day.key} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
                        <div className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                          <div className="flex items-center justify-between gap-3">
                            <span>{day.label}</span>
                            {nextWeekStart && (
                              <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
                                {new Date(nextWeekStart.getTime() + dayDefs.findIndex((d) => d.key === day.key) * 24 * 60 * 60 * 1000).toLocaleDateString("he-IL")}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          {sortShifts(shifts).map((shift) => {
                            const isSelected = (availability[day.key] || []).includes(shift);
                            return (
                              <button
                                key={shift}
                                type="button"
                                onClick={() => toggleAvailability(day.key, shift)}
                                disabled={submitting || (success && isEditing)}
                                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                                  isSelected
                                    ? "bg-blue-600 text-white hover:bg-blue-700"
                                    : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                                } disabled:opacity-60 disabled:cursor-not-allowed`}
                              >
                                {shift}
                              </button>
                            );
                          })}
                        </div>

                        {/* Questions par jour */}
                        {siteQuestions.filter((q) => !!q.perDay && (q?.label || "").trim()).length > 0 && (
                          <div className="mt-3 space-y-3 border-t border-zinc-200 pt-3 dark:border-zinc-700">
                            {siteQuestions
                              .filter((q) => !!q.perDay && (q?.label || "").trim())
                              .map((q) => {
                                const dayAns = (answersPerDay?.[q.id] || {}) as Record<string, any>;
                                const value = dayAns[day.key];
                                const disabled = submitting || (success && isEditing);
                                return (
                                  <div key={`${q.id}_${day.key}`} className="space-y-2">
                                    <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                                      {q.label}
                                    </label>
                                    {q.type === "text" && (
                                      <input
                                        type="text"
                                        value={String(value || "")}
                                        onChange={(e) =>
                                          setAnswersPerDay((prev) => ({
                                            ...(prev || {}),
                                            [q.id]: { ...((prev || {})[q.id] || {}), [day.key]: e.target.value },
                                          }))
                                        }
                                        disabled={disabled}
                                        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 disabled:opacity-60"
                                      />
                                    )}
                                    {q.type === "dropdown" && (
                                      <select
                                        value={String(value || "")}
                                        onChange={(e) =>
                                          setAnswersPerDay((prev) => ({
                                            ...(prev || {}),
                                            [q.id]: { ...((prev || {})[q.id] || {}), [day.key]: e.target.value },
                                          }))
                                        }
                                        disabled={disabled}
                                        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 disabled:opacity-60"
                                      >
                                        <option value="">בחר</option>
                                        {(q.options || []).filter(Boolean).map((opt) => (
                                          <option key={opt} value={opt}>
                                            {opt}
                                          </option>
                                        ))}
                                      </select>
                                    )}
                                    {q.type === "yesno" && (
                                      <div className="flex items-center gap-4 text-sm">
                                        <label className="inline-flex items-center gap-2">
                                          <input
                                            type="radio"
                                            name={`q_${q.id}_${day.key}`}
                                            checked={value === true}
                                            onChange={() =>
                                              setAnswersPerDay((prev) => ({
                                                ...(prev || {}),
                                                [q.id]: { ...((prev || {})[q.id] || {}), [day.key]: true },
                                              }))
                                            }
                                            disabled={disabled}
                                          />
                                          כן
                                        </label>
                                        <label className="inline-flex items-center gap-2">
                                          <input
                                            type="radio"
                                            name={`q_${q.id}_${day.key}`}
                                            checked={value === false}
                                            onChange={() =>
                                              setAnswersPerDay((prev) => ({
                                                ...(prev || {}),
                                                [q.id]: { ...((prev || {})[q.id] || {}), [day.key]: false },
                                              }))
                                            }
                                            disabled={disabled}
                                          />
                                          לא
                                        </label>
                                      </div>
                                    )}
                                    {q.type === "slider" && (
                                      <div className="space-y-2">
                                        <input
                                          type="range"
                                          min={q.slider?.min ?? 0}
                                          max={q.slider?.max ?? 10}
                                          step={q.slider?.step ?? 1}
                                          value={typeof value === "number" ? value : (q.slider?.min ?? 0)}
                                          onChange={(e) =>
                                            setAnswersPerDay((prev) => ({
                                              ...(prev || {}),
                                              [q.id]: { ...((prev || {})[q.id] || {}), [day.key]: Number(e.target.value) },
                                            }))
                                          }
                                          disabled={disabled}
                                          className="w-full"
                                        />
                                        <div className="text-xs text-zinc-600 dark:text-zinc-400">
                                          ערך: {typeof value === "number" ? value : (q.slider?.min ?? 0)}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {siteQuestions.filter((q) => !q.perDay && (q?.label || "").trim()).length > 0 && (
                  <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
                    <div className="mb-3 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                      שאלות נוספות
                    </div>
                    <div className="space-y-4">
                      {siteQuestions
                        .filter((q) => !q.perDay && (q?.label || "").trim())
                        .map((q) => (
                          <div key={q.id} className="space-y-2">
                            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                              {q.label}
                            </label>

                            {q.type === "text" && (
                              <input
                                type="text"
                                value={String(answersGeneral?.[q.id] || "")}
                                onChange={(e) => setAnswersGeneral((prev) => ({ ...(prev || {}), [q.id]: e.target.value }))}
                                disabled={submitting || (success && isEditing)}
                                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 disabled:opacity-60"
                              />
                            )}

                            {q.type === "dropdown" && (
                              <select
                                value={String(answersGeneral?.[q.id] || "")}
                                onChange={(e) => setAnswersGeneral((prev) => ({ ...(prev || {}), [q.id]: e.target.value }))}
                                disabled={submitting || (success && isEditing)}
                                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 disabled:opacity-60"
                              >
                                <option value="">בחר</option>
                                {(q.options || []).filter(Boolean).map((opt) => (
                                  <option key={opt} value={opt}>
                                    {opt}
                                  </option>
                                ))}
                              </select>
                            )}

                            {q.type === "yesno" && (
                              <div className="flex items-center gap-4 text-sm">
                                <label className="inline-flex items-center gap-2">
                                  <input
                                    type="radio"
                                    name={`q_${q.id}`}
                                    checked={answersGeneral?.[q.id] === true}
                                    onChange={() => setAnswersGeneral((prev) => ({ ...(prev || {}), [q.id]: true }))}
                                    disabled={submitting || (success && isEditing)}
                                  />
                                  כן
                                </label>
                                <label className="inline-flex items-center gap-2">
                                  <input
                                    type="radio"
                                    name={`q_${q.id}`}
                                    checked={answersGeneral?.[q.id] === false}
                                    onChange={() => setAnswersGeneral((prev) => ({ ...(prev || {}), [q.id]: false }))}
                                    disabled={submitting || (success && isEditing)}
                                  />
                                  לא
                                </label>
                              </div>
                            )}

                            {q.type === "slider" && (
                              <div className="space-y-2">
                                <input
                                  type="range"
                                  min={q.slider?.min ?? 0}
                                  max={q.slider?.max ?? 10}
                                  step={q.slider?.step ?? 1}
                                  value={typeof answersGeneral?.[q.id] === "number" ? answersGeneral?.[q.id] : (q.slider?.min ?? 0)}
                                  onChange={(e) => setAnswersGeneral((prev) => ({ ...(prev || {}), [q.id]: Number(e.target.value) }))}
                                  disabled={submitting || (success && isEditing)}
                                  className="w-full"
                                />
                                <div className="text-xs text-zinc-600 dark:text-zinc-400">
                                  ערך: {typeof answersGeneral?.[q.id] === "number" ? answersGeneral?.[q.id] : (q.slider?.min ?? 0)}
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-center gap-3 pt-4">
                  {!isEditing || !success ? (
                    <button
                      type="submit"
                      disabled={submitting || !workerName.trim()}
                      className="rounded-md bg-blue-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                    >
                      {submitting ? "שומר..." : (hasBeenSaved ? "עדכן" : "שמור זמינות")}
                    </button>
                  ) : null}
                </div>
              </form>

              {isEditing && success && (
                <div className="flex items-center justify-center gap-3 pt-4">
                  <button
                    type="button"
                    onClick={handleEdit}
                    className="rounded-md bg-orange-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-orange-700 transition-colors"
                  >
                    ערוך
                  </button>
                </div>
              )}

              <div className="mt-6 text-center">
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  ניתן לעדכן את הזמינות בכל עת על ידי מילוי הטופס מחדש
                </p>
              </div>
            </>
          )}

          {!selectedSiteId && sites.length === 1 && (
            <div className="text-center py-4">
              <LoadingAnimation size={50} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

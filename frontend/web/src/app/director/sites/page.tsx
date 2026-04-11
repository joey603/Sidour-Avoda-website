"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import LoadingAnimation from "@/components/loading-animation";

interface Site {
  id: number;
  name: string;
  workers_count: number;
  pending_workers_count?: number;
  next_week_saved_plan_status?: {
    exists?: boolean;
    week_iso?: string | null;
    complete?: boolean | null;
    assigned_count?: number;
    required_count?: number;
    pulls_count?: number;
    scope?: "auto" | "director" | "shared" | null;
    requires_manual_save?: boolean;
  } | null;
  config?: {
    autoPlanningLastRun?: {
      week_iso?: string;
      ran_at?: number;
      source?: string;
      complete?: boolean;
      assigned_count?: number;
      required_count?: number;
      error?: string | null;
    };
  } | null;
}

interface AutoPlanningConfig {
  enabled: boolean;
  day_of_week: number;
  hour: number;
  minute: number;
  auto_pulls_enabled?: boolean;
  auto_save_mode?: "manual" | "director" | "shared";
  last_run_week_iso?: string | null;
  last_run_at?: number | null;
  last_error?: string | null;
  next_run_at?: number | null;
  target_week_iso?: string | null;
}

interface AutoPlanningTestResponse {
  ok: boolean;
  target_week_iso: string;
  generated_sites: number;
  errors: string[];
  config: AutoPlanningConfig;
}

const AUTO_PLANNING_DAY_OPTIONS = [
  { value: 0, label: "יום ראשון" },
  { value: 1, label: "יום שני" },
  { value: 2, label: "יום שלישי" },
  { value: 3, label: "יום רביעי" },
  { value: 4, label: "יום חמישי" },
  { value: 5, label: "יום שישי" },
  { value: 6, label: "שבת" },
];

const AUTO_PLANNING_SAVE_MODE_OPTIONS = [
  {
    value: "manual",
    label: "ידני",
    description: "ברירת מחדל. כל התכנונים נשמרים כטיוטה ומחכים ל-שמור או שמור ואשלח ידני.",
  },
  {
    value: "director",
    label: "שמור אוטומטית אם מלא",
    description: "אם תכנון של אתר מלא לחלוטין, הוא יישמר אוטומטית למנהל בלבד.",
  },
  {
    value: "shared",
    label: "שמור ואשלח אוטומטית אם מלא",
    description: "אם תכנון של אתר מלא לחלוטין, הוא יישמר ויישלח אוטומטית לעובדים.",
  },
] as const;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "");
}

function getAutoPlanningResultLabel(mode: AutoPlanningConfig["auto_save_mode"] | undefined): string {
  if (mode === "director") return "תוכניות שנשמרו אוטומטית";
  if (mode === "shared") return "תוכניות שנשמרו ונשלחו אוטומטית";
  return "טיוטות";
}

function getSiteAutoPlanningStatus(site: Site) {
  return site.next_week_saved_plan_status || null;
}

function formatIsoDateLabel(isoDate: string): string {
  const [year, month, day] = String(isoDate || "").split("-");
  if (!year || !month || !day) return isoDate;
  return `${day}/${month}/${year}`;
}

function addDaysToIsoDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  date.setDate(date.getDate() + days);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getTargetWeekIsoFromRunAt(runAtMs: number): string | null {
  const date = new Date(runAtMs);
  if (Number.isNaN(date.getTime())) return null;
  const startOfWeek = new Date(date);
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
  startOfWeek.setDate(startOfWeek.getDate() + 7);
  const y = startOfWeek.getFullYear();
  const m = String(startOfWeek.getMonth() + 1).padStart(2, "0");
  const d = String(startOfWeek.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function SitesList() {
  const router = useRouter();
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [query, setQuery] = useState<string>("");
  const [viewMode, setViewMode] = useState<"list" | "cards">("list");
  const [autoPlanningConfig, setAutoPlanningConfig] = useState<AutoPlanningConfig | null>(null);
  const [autoPlanningModalOpen, setAutoPlanningModalOpen] = useState(false);
  const [autoPlanningSaving, setAutoPlanningSaving] = useState(false);
  const [autoPlanningTesting, setAutoPlanningTesting] = useState(false);
  const [scheduledAutoPlanningRunning, setScheduledAutoPlanningRunning] = useState(false);
  const [openActionsSiteId, setOpenActionsSiteId] = useState<number | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const [autoPlanAction, setAutoPlanAction] = useState<{ siteId: number | null; publish: boolean | null }>({
    siteId: null,
    publish: null,
  });
  const [autoPlanningForm, setAutoPlanningForm] = useState({
    enabled: false,
    day_of_week: 0,
    time: "09:00",
    auto_pulls_enabled: false,
    auto_save_mode: "manual" as "manual" | "director" | "shared",
  });
  const autoPlanningControlsDisabled = !autoPlanningForm.enabled;

  useEffect(() => {
    if (openActionsSiteId === null) return;
    function onDocMouseDown(e: MouseEvent) {
      const el = actionsMenuRef.current;
      const target = e.target as Node | null;
      if (!el || !target) return;
      if (!el.contains(target)) setOpenActionsSiteId(null);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [openActionsSiteId]);

  async function fetchSites() {
    try {
      const list = await apiFetch<Site[]>("/director/sites/", {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        cache: "no-store",
      });
      setSites(list);
    } catch {
      setError("שגיאה בטעינת אתרים");
    }
  }

  async function fetchAutoPlanningConfig() {
    try {
      const config = await apiFetch<AutoPlanningConfig>("/director/sites/settings/auto-planning", {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        cache: "no-store",
      });
      setAutoPlanningConfig(config);
      setAutoPlanningForm({
        enabled: !!config.enabled,
        day_of_week: Number(config.day_of_week || 0),
        time: `${String(config.hour ?? 9).padStart(2, "0")}:${String(config.minute ?? 0).padStart(2, "0")}`,
        auto_pulls_enabled: !!config.auto_pulls_enabled,
        auto_save_mode: config.auto_save_mode || "manual",
      });
      return config;
    } catch {
      toast.error("שגיאה בטעינת תכנון אוטומטי");
      return null;
    }
  }

  useEffect(() => {
    (async () => {
      const me = await fetchMe();
      if (!me) return router.replace("/login/director");
      if (me.role !== "director") return router.replace("/worker");
      try {
        await Promise.all([fetchSites(), fetchAutoPlanningConfig()]);
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  useEffect(() => {
    if (!autoPlanningConfig?.enabled || !autoPlanningConfig?.next_run_at) {
      setScheduledAutoPlanningRunning(false);
      return;
    }

    let cancelled = false;
    let startTimeout: ReturnType<typeof setTimeout> | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    const scheduledAt = Number(autoPlanningConfig.next_run_at);
    const targetWeekIso = getTargetWeekIsoFromRunAt(scheduledAt);

    async function refreshAfterScheduledRun(attempt: number) {
      if (cancelled) return;
      try {
        const [, config] = await Promise.all([fetchSites(), fetchAutoPlanningConfig()]);
        const completedAt = typeof config?.last_run_at === "number" ? config.last_run_at : null;
        if (completedAt && completedAt >= scheduledAt) {
          if (!cancelled) setScheduledAutoPlanningRunning(false);
          return;
        }
      } catch {}

      if (attempt < 5 && !cancelled) {
        retryTimeout = setTimeout(() => {
          void refreshAfterScheduledRun(attempt + 1);
        }, 5000);
      } else if (!cancelled) {
        setScheduledAutoPlanningRunning(false);
      }
    }

    const delayMs = Math.max(0, scheduledAt - Date.now());
    startTimeout = setTimeout(() => {
      if (cancelled) return;
      setScheduledAutoPlanningRunning(true);
      toast.success("התכנון האוטומטי התחיל", {
        description: targetWeekIso ? `עבור השבוע ${targetWeekIso}` : undefined,
      });
      void refreshAfterScheduledRun(0);
    }, delayMs);

    return () => {
      cancelled = true;
      if (startTimeout) clearTimeout(startTimeout);
      if (retryTimeout) clearTimeout(retryTimeout);
    };
  }, [autoPlanningConfig?.enabled, autoPlanningConfig?.next_run_at]);

  useEffect(() => {
    if (!scheduledAutoPlanningRunning) return;
    if (!autoPlanningConfig?.enabled) {
      setScheduledAutoPlanningRunning(false);
      return;
    }
    const nextRunAt = typeof autoPlanningConfig?.next_run_at === "number" ? autoPlanningConfig.next_run_at : null;
    const lastRunAt = typeof autoPlanningConfig?.last_run_at === "number" ? autoPlanningConfig.last_run_at : null;
    if (nextRunAt && lastRunAt && lastRunAt < nextRunAt) {
      setScheduledAutoPlanningRunning(false);
    }
  }, [
    scheduledAutoPlanningRunning,
    autoPlanningConfig?.enabled,
    autoPlanningConfig?.next_run_at,
    autoPlanningConfig?.last_run_at,
  ]);

  async function onAddClick() {
    router.push("/director/sites/new");
  }

  async function onDelete(id: number) {
    if (typeof window !== "undefined") {
      const ok = window.confirm("למחוק את האתר?");
      if (!ok) return;
    }
    setDeletingId(id);
    // suppression optimiste immédiate
    setSites((prev) => prev.filter((s) => s.id !== id));
    let deleteOk = false;
    try {
      await apiFetch(`/director/sites/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
      });
      deleteOk = true;
      toast.success("האתר נמחק בהצלחה");
    } catch (e: unknown) {
      // Vérifier l'état réel: si le site n'existe plus, considérer comme succès
      try {
        const list = await apiFetch<Site[]>("/director/sites/", {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          cache: "no-store",
        });
        const stillThere = (list || []).some((s) => Number(s.id) === Number(id));
        if (!stillThere) {
          toast.success("האתר נמחק בהצלחה");
          setSites(list || []);
          deleteOk = true;
        } else {
          toast.error("שגיאה במחיקה", { description: getErrorMessage(e) });
          setSites(list || []);
        }
      } catch {
        // Impossible de vérifier: afficher erreur générique et resynchroniser
        toast.error("שגיאה במחיקה");
        await fetchSites();
      }
    } finally {
      setDeletingId(null);
    }
    // rafraîchir la liste en arrière-plan si la suppression a réussi
    if (deleteOk) {
      try { await fetchSites(); } catch { /* ignorer erreur d'actualisation */ }
    }
  }

  function openAutoPlanningModal() {
    const config = autoPlanningConfig;
    setAutoPlanningForm({
      enabled: !!config?.enabled,
      day_of_week: Number(config?.day_of_week || 0),
      time: `${String(config?.hour ?? 9).padStart(2, "0")}:${String(config?.minute ?? 0).padStart(2, "0")}`,
      auto_pulls_enabled: !!config?.auto_pulls_enabled,
      auto_save_mode: config?.auto_save_mode || "manual",
    });
    setAutoPlanningModalOpen(true);
  }

  async function onSaveAutoPlanning() {
    const match = /^(\d{2}):(\d{2})$/.exec(autoPlanningForm.time || "");
    if (!match) {
      toast.error("יש לבחור שעה תקינה");
      return;
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      toast.error("יש לבחור שעה תקינה");
      return;
    }
    setAutoPlanningSaving(true);
    try {
      const saved = await apiFetch<AutoPlanningConfig>("/director/sites/settings/auto-planning", {
        method: "PUT",
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        body: JSON.stringify({
          enabled: autoPlanningForm.enabled,
          day_of_week: autoPlanningForm.day_of_week,
          hour,
          minute,
          auto_pulls_enabled: autoPlanningForm.auto_pulls_enabled,
          auto_save_mode: autoPlanningForm.auto_save_mode,
        }),
      });
      setAutoPlanningConfig(saved);
      setAutoPlanningModalOpen(false);
      toast.success(saved.enabled ? "התכנון האוטומטי הופעל" : "התכנון האוטומטי כובה");
    } catch (e: unknown) {
      toast.error("שגיאה בשמירת תכנון אוטומטי", { description: getErrorMessage(e) });
    } finally {
      setAutoPlanningSaving(false);
    }
  }

  async function onTestAutoPlanningNow() {
    setAutoPlanningTesting(true);
    try {
      const result = await apiFetch<AutoPlanningTestResponse>("/director/sites/settings/auto-planning/test-now", {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
      });
      setAutoPlanningConfig(result.config);
      await fetchSites();
      // À la fin de la ריצה, fermer la popup pour laisser l'utilisateur voir directement la liste.
      setAutoPlanningModalOpen(false);
      const resultLabel = getAutoPlanningResultLabel(result.config.auto_save_mode);
      if (result.ok) {
        toast.success("ההרצה הידנית הושלמה בהצלחה", {
          description: `נוצרו ${result.generated_sites} ${resultLabel} לשבוע ${result.target_week_iso}`,
        });
      } else {
        toast.error("ההרצה הידנית הסתיימה עם שגיאות", {
          description: `נוצרו ${result.generated_sites} ${resultLabel}, ${result.errors.length} שגיאות`,
        });
      }
    } catch (e: unknown) {
      toast.error("שגיאה בהרצה ידנית", { description: getErrorMessage(e) });
      setAutoPlanningModalOpen(false);
    } finally {
      setAutoPlanningTesting(false);
    }
  }

  async function onPromoteAutoPlan(site: Site, publish: boolean) {
    const weekIso = site.next_week_saved_plan_status?.week_iso;
    if (!weekIso) {
      toast.error("לא נמצאה טיוטת תכנון");
      return;
    }
    setAutoPlanAction({ siteId: site.id, publish });
    try {
      await apiFetch(`/director/sites/${site.id}/week-plan/promote-auto?week=${encodeURIComponent(weekIso)}&publish=${publish ? "true" : "false"}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
      });
      setOpenActionsSiteId(null);
      await fetchSites();
      toast.success(publish ? "התכנון נשמר ונשלח" : "התכנון נשמר");
    } catch (e: unknown) {
      toast.error("שגיאה בשמירת הטיוטה", { description: getErrorMessage(e) });
    } finally {
      setAutoPlanAction({ siteId: null, publish: null });
    }
  }

  const filteredSites = useMemo(() => {
    const q = (query || "").trim().toLowerCase();
    if (!q) return sites;
    return (sites || []).filter((s) => (s?.name || "").toLowerCase().includes(q));
  }, [sites, query]);

  const autoPlanningSummary = useMemo(() => {
    if (!autoPlanningConfig?.enabled) {
      return {
        scheduleLabel: "כבוי",
        weekLabel: "",
      };
    }
    const dayLabel = AUTO_PLANNING_DAY_OPTIONS.find((option) => option.value === autoPlanningConfig.day_of_week)?.label || "יום ראשון";
    const timeLabel = `${String(autoPlanningConfig.hour ?? 9).padStart(2, "0")}:${String(autoPlanningConfig.minute ?? 0).padStart(2, "0")}`;
    const targetWeekStart = autoPlanningConfig.target_week_iso || null;
    const targetWeekEnd = targetWeekStart ? addDaysToIsoDate(targetWeekStart, 6) : null;
    const weekLabel = targetWeekStart && targetWeekEnd
      ? `${formatIsoDateLabel(targetWeekStart)} - ${formatIsoDateLabel(targetWeekEnd)}`
      : "שבוע הבא";
    return {
      scheduleLabel: `${dayLabel} ${timeLabel}`,
      weekLabel,
    };
  }, [autoPlanningConfig]);

  // Si l'auto-planning est désactivé, on n'affiche ni badges ni actions liées,
  // même si une טיוטה auto existe déjà en base.
  const showAutoPlanningSiteStatuses = !!autoPlanningConfig?.enabled;

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Carte statistiques: nombre de sites */}
        <section className="grid grid-cols-1 gap-3">
          <div className="rounded-xl border p-4 shadow-sm bg-[#E6F7FF] border-[#B3ECFF]">
            <div className="text-sm text-[#006C8A]">מספר אתרים</div>
            <div className="mt-1 text-3xl font-bold text-[#004B63]">{sites.length}</div>
          </div>
        </section>

        <div className="rounded-xl border p-4 dark:border-zinc-800">
          {/* Desktop: grid avec titre, recherche et bouton sur la même ligne */}
          <div className="mb-2 hidden md:grid grid-cols-3 items-center gap-3">
            <h2 className="text-lg font-semibold justify-self-start">רשימת אתרים</h2>
            <div className="justify-self-center w-full flex justify-center">
              <div className="relative w-56 md:w-64">
                <svg
                  className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="חיפוש אתר לפי שם"
                aria-label="חיפוש אתר"
                  className="h-9 w-full rounded-md border pl-3 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-700 bg-white dark:bg-zinc-900"
              />
              </div>
            </div>
            <div className="justify-self-end flex items-center gap-2">
              <button
                type="button"
                onClick={openAutoPlanningModal}
                className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm shadow-sm ${autoPlanningConfig?.enabled ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" : "border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200"}`}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2a1 1 0 0 1 1 1v1.07A7.002 7.002 0 0 1 19.93 11H21a1 1 0 1 1 0 2h-1.07A7.002 7.002 0 0 1 13 19.93V21a1 1 0 1 1-2 0v-1.07A7.002 7.002 0 0 1 4.07 13H3a1 1 0 1 1 0-2h1.07A7.002 7.002 0 0 1 11 4.07V3a1 1 0 0 1 1-1Zm0 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm.75 1.5a.75.75 0 0 1 .75.75v3.19l2.03 1.21a.75.75 0 1 1-.76 1.3l-2.39-1.43A.75.75 0 0 1 12 11.88V8.25a.75.75 0 0 1 .75-.75Z"/></svg>
                תכנון אוטומטי 
              </button>
              <button
                type="button"
                onClick={onAddClick}
                className="inline-flex items-center gap-2 rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm font-medium text-green-800 shadow-sm hover:bg-green-100 dark:border-green-700 dark:bg-green-950/40 dark:text-green-200 dark:hover:bg-green-900/50"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>
                הוסף אתר
              </button>
            </div>
          </div>

          {/* Mobile: titre, recherche, boutons de vue en colonne */}
          <div className="mb-2 md:hidden space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">רשימת אתרים</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={openAutoPlanningModal}
                  className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm shadow-sm ${autoPlanningConfig?.enabled ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" : "border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200"}`}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2a1 1 0 0 1 1 1v1.07A7.002 7.002 0 0 1 19.93 11H21a1 1 0 1 1 0 2h-1.07A7.002 7.002 0 0 1 13 19.93V21a1 1 0 1 1-2 0v-1.07A7.002 7.002 0 0 1 4.07 13H3a1 1 0 1 1 0-2h1.07A7.002 7.002 0 0 1 11 4.07V3a1 1 0 0 1 1-1Zm0 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm.75 1.5a.75.75 0 0 1 .75.75v3.19l2.03 1.21a.75.75 0 1 1-.76 1.3l-2.39-1.43A.75.75 0 0 1 12 11.88V8.25a.75.75 0 0 1 .75-.75Z"/></svg>
                  אוטומטי
                </button>
                <button
                  type="button"
                  onClick={onAddClick}
                  className="inline-flex items-center gap-2 rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm font-medium text-green-800 shadow-sm hover:bg-green-100 dark:border-green-700 dark:bg-green-950/40 dark:text-green-200 dark:hover:bg-green-900/50"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>
                  הוסף אתר
                </button>
              </div>
            </div>
            <div className="relative w-full">
              <svg
                className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="חיפוש אתר לפי שם"
                aria-label="חיפוש אתר"
                className="h-9 w-full rounded-md border pl-3 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-700 bg-white dark:bg-zinc-900"
              />
            </div>
            <div className="flex items-center justify-start">
              <div className="inline-flex rounded-md border shadow-sm dark:border-zinc-700 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setViewMode("list")}
                  className={`px-3 py-1.5 text-sm ${viewMode === "list" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-white text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"}`}
                  aria-label="תצוגת רשימה"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                    <path d="M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h16v2H4v-2Z"/>
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("cards")}
                  className={`px-3 py-1.5 text-sm ${viewMode === "cards" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-white text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"}`}
                  aria-label="תצוגת כרטיסים"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                    <path d="M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z"/>
                  </svg>
                </button>
              </div>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300">
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2">
                    <span>תכנון אוטומטי: {autoPlanningSummary.scheduleLabel}</span>
                    {scheduledAutoPlanningRunning ? <span className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-300"><span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />מריץ תכנון...</span> : null}
                  </span>
                  <button
                    type="button"
                    onClick={onTestAutoPlanningNow}
                    disabled={autoPlanningTesting || autoPlanningSaving || autoPlanningControlsDisabled}
                    className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-800 shadow-sm hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
                  >
                    {autoPlanningTesting ? "מריץ..." : "הרץ ידנית"}
                  </button>
                </div>
                {autoPlanningSummary.weekLabel ? <span className="text-center">{autoPlanningSummary.weekLabel}</span> : null}
              </div>
            </div>
          </div>

          {/* Desktop: boutons de vue (séparés) */}
          <div className="mb-4 hidden md:flex items-center justify-start">
            <div className="inline-flex rounded-md border shadow-sm dark:border-zinc-700 overflow-hidden">
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={`px-3 py-1.5 text-sm ${viewMode === "list" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-white text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"}`}
                aria-label="תצוגת רשימה"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h16v2H4v-2Z"/>
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("cards")}
                className={`px-3 py-1.5 text-sm ${viewMode === "cards" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-white text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"}`}
                aria-label="תצוגת כרטיסים"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z"/>
                </svg>
              </button>
            </div>
          </div>
          <div className="mb-4 hidden md:grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300">
            <div className="justify-self-start">
              <div className="inline-flex items-center gap-2">
                <span>תכנון אוטומטי: {autoPlanningSummary.scheduleLabel}</span>
                {scheduledAutoPlanningRunning ? <span className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-300"><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />מריץ תכנון...</span> : null}
              </div>
            </div>
            {autoPlanningSummary.weekLabel ? <div className="justify-self-center text-center whitespace-nowrap">{autoPlanningSummary.weekLabel}</div> : <div />}
            <div className="justify-self-end text-left">
              <button
                type="button"
                onClick={onTestAutoPlanningNow}
                disabled={autoPlanningTesting || autoPlanningSaving || autoPlanningControlsDisabled}
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-800 shadow-sm hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
              >
                {autoPlanningTesting ? "מריץ..." : "הרץ ידנית"}
              </button>
            </div>
          </div>
          {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
          {loading ? (
            <LoadingAnimation className="py-8" size={96} />
          ) : (
            <>
              {filteredSites.length === 0 ? (
                <p className="py-6 text-sm text-zinc-500">אין אתרים עדיין</p>
              ) : viewMode === "list" ? (
                <div dir="rtl" className="-mx-4 max-h-[43rem] overflow-y-auto px-4 divide-y">
                  {filteredSites.map((s) => (
                    <div key={s.id} className="flex items-center justify-between py-3">
                      <div className="flex flex-col">
                        <span className="font-medium">{s.name}</span>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-zinc-500">
                          <span>מספר עובדים: {s.workers_count}</span>
                          {(s.pending_workers_count ?? 0) > 0 ? (
                            <span className="inline-flex items-center rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-xs text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
                              {s.pending_workers_count} ממתין לאישור
                            </span>
                          ) : null}
                        </div>
                        {showAutoPlanningSiteStatuses && getSiteAutoPlanningStatus(s) ? (
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <span
                              className={`inline-flex w-fit items-center gap-2 rounded-full border px-2 py-0.5 text-xs ${
                                getSiteAutoPlanningStatus(s)?.exists
                                  ? getSiteAutoPlanningStatus(s)?.complete
                                  ? "border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300"
                                  : "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
                                  : "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                              }`}
                            >
                              <span className="font-semibold">
                                {getSiteAutoPlanningStatus(s)?.exists ? (getSiteAutoPlanningStatus(s)?.complete ? "V" : "X") : "•"}
                              </span>
                              <span>
                                {getSiteAutoPlanningStatus(s)?.exists
                                  ? `${getSiteAutoPlanningStatus(s)?.assigned_count ?? 0}/${getSiteAutoPlanningStatus(s)?.required_count ?? 0} שיבוצים`
                                  : "אין סידור שמור"}
                              </span>
                            </span>
                            {(getSiteAutoPlanningStatus(s)?.pulls_count ?? 0) > 0 ? (
                              <span className="inline-flex items-center rounded-full border border-orange-300 bg-orange-50 px-2 py-0.5 text-xs text-orange-700 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-300">
                                {getSiteAutoPlanningStatus(s)?.pulls_count} משיכות
                              </span>
                            ) : null}
                            {getSiteAutoPlanningStatus(s)?.requires_manual_save ? (
                              <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                                ממתין לשמירה
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        {showAutoPlanningSiteStatuses ? (
                          <div
                            className="relative"
                            ref={openActionsSiteId === s.id ? actionsMenuRef : null}
                          >
                            <button
                              type="button"
                              onClick={() => setOpenActionsSiteId((prev) => (prev === s.id ? null : s.id))}
                              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1 text-sm text-zinc-800 shadow-sm hover:bg-zinc-50 dark:border-zinc-600 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
                              aria-expanded={openActionsSiteId === s.id}
                              aria-haspopup="menu"
                            >
                              <svg className="h-3.5 w-3.5 shrink-0 text-zinc-600 dark:text-zinc-700" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
                                <path d="M6 8L1 3h10L6 8z" />
                              </svg>
                              פעולות
                            </button>
                            {openActionsSiteId === s.id ? (
                              <div className="absolute left-0 top-full z-20 mt-2 min-w-[180px] rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenActionsSiteId(null);
                                    router.push(`/director/planning/${s.id}`);
                                  }}
                                  className="flex w-full items-center justify-end gap-2 rounded-md px-3 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"
                                >
                                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                    <path d="M12 5c-7.63 0-10.99 6.5-11 7 .01.5 3.37 7 11 7 7.64 0 10.99-6.5 11-7-.01-.5-3.37-7-11-7zm0 12c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                                  </svg>
                                  צפה
                                </button>
                                {getSiteAutoPlanningStatus(s)?.requires_manual_save ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => void onPromoteAutoPlan(s, false)}
                                      disabled={autoPlanAction.siteId === s.id}
                                      className="flex w-full items-center justify-end rounded-md px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-60 dark:hover:bg-zinc-800"
                                    >
                                      {autoPlanAction.siteId === s.id && autoPlanAction.publish === false ? "שומר..." : "שמור"}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void onPromoteAutoPlan(s, true)}
                                      disabled={autoPlanAction.siteId === s.id}
                                      className="flex w-full items-center justify-end rounded-md px-3 py-2 text-sm text-green-700 hover:bg-green-50 disabled:opacity-60 dark:text-green-300 dark:hover:bg-green-900/30"
                                    >
                                      {autoPlanAction.siteId === s.id && autoPlanAction.publish === true ? "שומר..." : "שמור ואשלח"}
                                    </button>
                                  </>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <button
                            onClick={() => router.push(`/director/planning/${s.id}`)}
                            className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-sm shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                              <path d="M12 5c-7.63 0-10.99 6.5-11 7 .01.5 3.37 7 11 7 7.64 0 10.99-6.5 11-7-.01-.5-3.37-7-11-7zm0 12c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                            </svg>
                            צפה
                          </button>
                        )}
                        <button
                          onClick={() => onDelete(s.id)}
                          disabled={deletingId === s.id}
                          className="inline-flex items-center gap-1 rounded-md border border-red-300 px-3 py-1 text-sm text-red-700 shadow-sm hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900"
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                            <path d="M6 7h12v2H6Zm2 4h8l-1 9H9ZM9 4h6v2H9Z"/>
                          </svg>
                          {deletingId === s.id ? "מוחק..." : "מחק"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div dir="rtl" className="-mx-4 grid max-h-[32rem] grid-cols-1 gap-3 overflow-y-auto px-4 md:grid-cols-2">
                  {filteredSites.map((s) => (
                    <div key={s.id} className="rounded-xl border p-4 dark:border-zinc-800">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-base font-semibold">{s.name}</span>
                        <div className="flex flex-wrap items-center justify-end gap-2 text-sm text-zinc-500">
                          <span>{s.workers_count} עובדים</span>
                          {(s.pending_workers_count ?? 0) > 0 ? (
                            <span className="inline-flex items-center rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-xs text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
                              {s.pending_workers_count} ממתין לאישור
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {showAutoPlanningSiteStatuses && getSiteAutoPlanningStatus(s) ? (
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <div
                            className={`inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs ${
                              getSiteAutoPlanningStatus(s)?.exists
                                ? getSiteAutoPlanningStatus(s)?.complete
                                ? "border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300"
                                : "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
                                : "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                            }`}
                          >
                            <span className="font-semibold">
                              {getSiteAutoPlanningStatus(s)?.exists ? (getSiteAutoPlanningStatus(s)?.complete ? "V" : "X") : "•"}
                            </span>
                            <span>
                              {getSiteAutoPlanningStatus(s)?.exists
                                ? `${getSiteAutoPlanningStatus(s)?.assigned_count ?? 0}/${getSiteAutoPlanningStatus(s)?.required_count ?? 0} שיבוצים`
                                : "אין סידור שמור"}
                            </span>
                          </div>
                          {(getSiteAutoPlanningStatus(s)?.pulls_count ?? 0) > 0 ? (
                            <span className="inline-flex items-center rounded-full border border-orange-300 bg-orange-50 px-2 py-1 text-xs text-orange-700 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-300">
                              {getSiteAutoPlanningStatus(s)?.pulls_count} משיכות
                            </span>
                          ) : null}
                          {getSiteAutoPlanningStatus(s)?.requires_manual_save ? (
                            <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                              ממתין לשמירה
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="flex items-center gap-2">
                        {showAutoPlanningSiteStatuses ? (
                          <div
                            className="relative"
                            ref={openActionsSiteId === s.id ? actionsMenuRef : null}
                          >
                            <button
                              type="button"
                              onClick={() => setOpenActionsSiteId((prev) => (prev === s.id ? null : s.id))}
                              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1 text-sm text-zinc-800 shadow-sm hover:bg-zinc-50 dark:border-zinc-600 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
                              aria-expanded={openActionsSiteId === s.id}
                              aria-haspopup="menu"
                            >
                              <svg className="h-3.5 w-3.5 shrink-0 text-zinc-600 dark:text-zinc-700" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
                                <path d="M6 8L1 3h10L6 8z" />
                              </svg>
                              פעולות
                            </button>
                            {openActionsSiteId === s.id ? (
                              <div className="absolute left-0 top-full z-20 mt-2 min-w-[180px] rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenActionsSiteId(null);
                                    router.push(`/director/planning/${s.id}`);
                                  }}
                                  className="flex w-full items-center justify-end gap-2 rounded-md px-3 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"
                                >
                                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                    <path d="M12 5c-7.63 0-10.99 6.5-11 7 .01.5 3.37 7 11 7 7.64 0 10.99-6.5 11-7-.01-.5-3.37-7-11-7zm0 12c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                                  </svg>
                                  צפה
                                </button>
                                {getSiteAutoPlanningStatus(s)?.requires_manual_save ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => void onPromoteAutoPlan(s, false)}
                                      disabled={autoPlanAction.siteId === s.id}
                                      className="flex w-full items-center justify-end rounded-md px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-60 dark:hover:bg-zinc-800"
                                    >
                                      {autoPlanAction.siteId === s.id && autoPlanAction.publish === false ? "שומר..." : "שמור"}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void onPromoteAutoPlan(s, true)}
                                      disabled={autoPlanAction.siteId === s.id}
                                      className="flex w-full items-center justify-end rounded-md px-3 py-2 text-sm text-green-700 hover:bg-green-50 disabled:opacity-60 dark:text-green-300 dark:hover:bg-green-900/30"
                                    >
                                      {autoPlanAction.siteId === s.id && autoPlanAction.publish === true ? "שומר..." : "שמור ואשלח"}
                                    </button>
                                  </>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <button
                            onClick={() => router.push(`/director/planning/${s.id}`)}
                            className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-sm shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                              <path d="M12 5c-7.63 0-10.99 6.5-11 7 .01.5 3.37 7 11 7 7.64 0 10.99-6.5 11-7-.01-.5-3.37-7-11-7zm0 12c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                            </svg>
                            צפה
                          </button>
                        )}
                        <button
                          onClick={() => onDelete(s.id)}
                          disabled={deletingId === s.id}
                          className="inline-flex items-center gap-1 rounded-md border border-red-300 px-3 py-1 text-sm text-red-700 shadow-sm hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900"
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                            <path d="M6 7h12v2H6Zm2 4h8l-1 9H9ZM9 4h6v2H9Z"/>
                          </svg>
                          {deletingId === s.id ? "מוחק..." : "מחק"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {autoPlanningModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-3 md:items-center md:p-6" onClick={() => setAutoPlanningModalOpen(false)}>
          <div
            className="flex max-h-[88dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">תכנון אוטומטי / שבועי</h3>
                  <p className="mt-1 text-xs text-zinc-500">ההרצה יוצרת תכנון לשבוע הבא. אפשר לבחור אם להשאיר הכל ידני, או לשמור אוטומטית רק כאשר התכנון מלא.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setAutoPlanningModalOpen(false)}
                  className="rounded-md border bg-white px-2 py-1 text-sm shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
                >
                  סגור
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
              <label className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 px-3 py-3 dark:border-zinc-800">
                <div className="space-y-1">
                  <div className="text-sm font-medium">הפעל תכנון אוטומטי</div>
                  <div className="text-xs text-zinc-500">כאשר פעיל, המערכת תריץ תכנון אוטומטי לכל האתרים לשבוע הבא.</div>
                </div>
                <input
                  type="checkbox"
                  checked={autoPlanningForm.enabled}
                  onChange={(e) => setAutoPlanningForm((prev) => ({ ...prev, enabled: e.target.checked }))}
                  className="h-5 w-5 accent-sky-600"
                />
              </label>
              <label
                className={`flex items-center justify-between gap-3 rounded-xl border border-zinc-200 px-3 py-3 transition-opacity dark:border-zinc-800 ${
                  autoPlanningControlsDisabled ? "opacity-50" : ""
                }`}
              >
                <div className="space-y-1">
                  <div className="text-sm font-medium">משיכה</div>
                  <div className="text-xs text-zinc-500">אם יש חורים, המערכת תנסה להוסיף משיכות אוטומטיות לכל האתרים.</div>
                </div>
                <input
                  type="checkbox"
                  checked={autoPlanningForm.auto_pulls_enabled}
                  onChange={(e) => setAutoPlanningForm((prev) => ({ ...prev, auto_pulls_enabled: e.target.checked }))}
                  disabled={autoPlanningControlsDisabled}
                  className="h-5 w-5 accent-orange-500"
                />
              </label>
              <div className={`space-y-2 transition-opacity ${autoPlanningControlsDisabled ? "pointer-events-none opacity-50" : ""}`}>
                <div className="text-sm font-medium">אופן שמירה אוטומטית</div>
                <div className="space-y-2">
                  {AUTO_PLANNING_SAVE_MODE_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition-colors ${
                        !autoPlanningControlsDisabled && autoPlanningForm.auto_save_mode === option.value
                          ? "border-sky-300 bg-sky-50 dark:border-sky-700 dark:bg-sky-950/30"
                          : "border-zinc-200 dark:border-zinc-800"
                      }`}
                    >
                      <input
                        type="radio"
                        name="auto_save_mode"
                        value={option.value}
                        checked={autoPlanningForm.auto_save_mode === option.value}
                        onChange={() => setAutoPlanningForm((prev) => ({ ...prev, auto_save_mode: option.value }))}
                        disabled={autoPlanningControlsDisabled}
                        className="mt-1 h-4 w-4 accent-sky-600"
                      />
                      <div className="space-y-1">
                        <div className="text-sm font-medium">{option.label}</div>
                        <div className="text-xs text-zinc-500">{option.description}</div>
                      </div>
                    </label>
                  ))}
                </div>
                <div className="text-xs text-zinc-500">
                  שומר אוטומטית רק אם האתר מלא. אם נשארו חוסרים, התכנון נשאר ידני ברשימת האתרים.
                </div>
              </div>
              <label className={`block space-y-1 transition-opacity ${autoPlanningControlsDisabled ? "opacity-50" : ""}`}>
                <span className="text-sm font-medium">יום הפעלה</span>
                <select
                  value={autoPlanningForm.day_of_week}
                  onChange={(e) => setAutoPlanningForm((prev) => ({ ...prev, day_of_week: Number(e.target.value) }))}
                  disabled={autoPlanningControlsDisabled}
                  className="h-10 w-full rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-700 dark:bg-zinc-900"
                >
                  {AUTO_PLANNING_DAY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className={`block space-y-1 transition-opacity ${autoPlanningControlsDisabled ? "opacity-50" : ""}`}>
                <span className="text-sm font-medium">שעת הפעלה</span>
                <input
                  type="time"
                  step={60}
                  dir="ltr"
                  value={autoPlanningForm.time}
                  onChange={(e) => setAutoPlanningForm((prev) => ({ ...prev, time: e.target.value }))}
                  disabled={autoPlanningControlsDisabled}
                  className="h-10 w-full rounded-md border px-3 text-left text-sm [direction:ltr] focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              {autoPlanningConfig?.last_error ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                  שגיאת הרצה אחרונה: {autoPlanningConfig.last_error}
                </div>
              ) : null}
            </div>
            <div className="shrink-0 border-t border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-3 text-xs text-zinc-500">
                {autoPlanningConfig?.last_run_week_iso ? `ריצה אחרונה לשבוע ${autoPlanningConfig.last_run_week_iso}` : "טרם בוצעה ריצה אוטומטית"}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAutoPlanningModalOpen(false)}
                  disabled={autoPlanningTesting || autoPlanningSaving}
                  className="rounded-md border bg-white px-3 py-2 text-sm shadow-sm disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900"
                >
                  ביטול
                </button>
                <button
                  type="button"
                  onClick={onSaveAutoPlanning}
                  disabled={autoPlanningSaving || autoPlanningTesting}
                  className="rounded-md bg-sky-600 px-3 py-2 text-sm text-white shadow-sm hover:bg-sky-700 disabled:opacity-60"
                >
                  {autoPlanningSaving ? "שומר..." : "שמור"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


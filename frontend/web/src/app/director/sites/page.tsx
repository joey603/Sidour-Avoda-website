"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import LoadingAnimation from "@/components/loading-animation";
import TimePicker from "@/components/time-picker";
import NumberPicker from "@/components/number-picker";
import OptionListPicker from "@/components/option-list-picker";
import {
  SiteBadgeIconChanges,
  SiteBadgeIconPendingApproval,
  SiteBadgeIconPublished,
  SiteBadgeIconPulls,
  SiteBadgeIconSavePending,
  SiteBadgeIconSavedDirector,
} from "@/components/site-list-site-badges";

interface Site {
  id: number;
  name: string;
  workers_count: number;
  pending_workers_count?: number;
  /** Même groupe multi-sites (≥2) : ids triés depuis l’API ; absent ou [] si site seul. */
  linked_site_ids?: number[];
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
  pulls_limit?: number | null;
  pulls_limits_by_site?: Record<string, number> | null;
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

/** מקסימום משיכות לתכנון אוטומטי (מגבלה לכל אתר / לפי אתר) */
const AUTO_PLANNING_PULLS_MAX = 30;

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

/** סידור שמור לשבוע (מנהל או משותף עם עובדים), לא טיוטת auto בלבד */
function hasSavedWeekPlanForWeek(site: Site): boolean {
  const st = getSiteAutoPlanningStatus(site);
  return st?.scope === "director" || st?.scope === "shared";
}

/** Conservé après מחק סידור pour garder שיבוצים / משיכות visibles jusqu’à nouvel état serveur */
type PreservedWeekPlanStats = {
  assigned: number;
  required: number;
  pulls: number;
  complete?: boolean;
};

function getWeekPlanStatusDisplay(site: Site, preserved: PreservedWeekPlanStats | undefined) {
  const st = getSiteAutoPlanningStatus(site);
  const fromServer = !!st?.exists;
  if (fromServer && st) {
    return {
      assigned: st.assigned_count ?? 0,
      required: st.required_count ?? 0,
      pulls: st.pulls_count ?? 0,
      complete: !!st.complete,
      showAssignmentsLine: true,
    };
  }
  if (preserved) {
    const assigned = preserved.assigned;
    const required = preserved.required;
    const complete =
      preserved.complete !== undefined ? preserved.complete : required > 0 && assigned >= required;
    return {
      assigned,
      required,
      pulls: preserved.pulls,
      complete,
      showAssignmentsLine: true,
    };
  }
  return {
    assigned: st?.assigned_count ?? 0,
    required: st?.required_count ?? 0,
    pulls: st?.pulls_count ?? 0,
    complete: false,
    showAssignmentsLine: false,
  };
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

/** Dimanche = début de semaine ; ISO du dimanche de la semaine suivante (même règle que backend `_next_week_iso`). */
function getNextWeekIsoSundayBased(ref: Date = new Date()): string {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  const daysSinceSunday = d.getDay();
  const thisWeekSunday = new Date(d);
  thisWeekSunday.setDate(thisWeekSunday.getDate() - daysSinceSunday);
  const nextSunday = new Date(thisWeekSunday);
  nextSunday.setDate(nextSunday.getDate() + 7);
  const y = nextSunday.getFullYear();
  const m = String(nextSunday.getMonth() + 1).padStart(2, "0");
  const day = String(nextSunday.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sortedLinkedSiteIds(site: Site): number[] {
  const raw = site.linked_site_ids;
  if (!raw || !Array.isArray(raw) || raw.length < 2) return [];
  return [...raw].sort((a, b) => a - b);
}

function linkedClusterKey(site: Site): string {
  const ids = sortedLinkedSiteIds(site);
  return ids.length >= 2 ? ids.join(",") : "";
}

type SitesListMultiScope = "current_only" | "all_sites";

type SitesListMultiDialogState =
  | { kind: "promote"; site: Site; publish: boolean; scope: SitesListMultiScope }
  | { kind: "delete"; site: Site; scope: SitesListMultiScope };

function isSitesListMultiSite(site: Site): boolean {
  return sortedLinkedSiteIds(site).length >= 2;
}

function siteIdsForSitesListScope(origin: Site, scope: SitesListMultiScope): number[] {
  if (scope === "all_sites") return sortedLinkedSiteIds(origin);
  return [origin.id];
}

/** Classe les sites par groupe multi puis regroupe les lignes à afficher (1 site ou N liés). */
function groupSitesForMultiDisplay(sites: Site[]): Site[][] {
  const sorted = [...sites].sort((a, b) => {
    const ka = linkedClusterKey(a);
    const kb = linkedClusterKey(b);
    if (ka && kb) {
      if (ka !== kb) return ka.localeCompare(kb);
      return a.id - b.id;
    }
    if (ka && !kb) return -1;
    if (!ka && kb) return 1;
    return a.id - b.id;
  });
  const used = new Set<number>();
  const groups: Site[][] = [];
  for (const s of sorted) {
    if (used.has(s.id)) continue;
    const key = linkedClusterKey(s);
    if (key) {
      const members = sorted.filter((x) => linkedClusterKey(x) === key);
      members.forEach((m) => used.add(m.id));
      groups.push(members);
    } else {
      used.add(s.id);
      groups.push([s]);
    }
  }
  return groups;
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
  const AUTO_WEEKLY_WORKER_CHANGES_KEY = "auto_weekly_worker_changes_v1";
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
  const [deleteWeekPlanSiteId, setDeleteWeekPlanSiteId] = useState<number | null>(null);
  const [sitesListMultiDialog, setSitesListMultiDialog] = useState<SitesListMultiDialogState | null>(null);
  /** Après promote depuis פעולות : badge dans la liste jusqu’à nouvelle טיוטה אוטומטית */
  const [sitePromoteBadge, setSitePromoteBadge] = useState<Record<number, "saved" | "published">>({});
  /** Après מחק סידור : afficher encore שיבוצים / משיכות jusqu’à sync API */
  const [preservedWeekPlanStats, setPreservedWeekPlanStats] = useState<Record<number, PreservedWeekPlanStats>>({});
  const [autoWeeklyWorkerChangesByWeek, setAutoWeeklyWorkerChangesByWeek] = useState<Record<string, Record<string, number>>>({});
  const [autoPlanningForm, setAutoPlanningForm] = useState({
    enabled: false,
    day_of_week: 0,
    time: "09:00",
    auto_pulls_enabled: false,
    auto_save_mode: "manual" as "manual" | "director" | "shared",
    /** מגבלת משיכות: אותה לכל האתרים או לכל אתר בנפרד */
    pulls_limits_mode: "same" as "same" | "per_site",
    pulls_limit_same: 5,
    pulls_limits_by_site: {} as Record<number, number>,
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

  useEffect(() => {
    setSitePromoteBadge((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const s of sites) {
        const st = getSiteAutoPlanningStatus(s);
        if (st?.requires_manual_save && next[s.id]) {
          delete next[s.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sites]);

  useEffect(() => {
    setPreservedWeekPlanStats((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const s of sites) {
        if (getSiteAutoPlanningStatus(s)?.exists && next[s.id]) {
          delete next[s.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sites]);

  function syncAutoWeeklyWorkerChangesFromStorage() {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(AUTO_WEEKLY_WORKER_CHANGES_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      setAutoWeeklyWorkerChangesByWeek((parsed && typeof parsed === "object") ? parsed : {});
    } catch {
      setAutoWeeklyWorkerChangesByWeek({});
    }
  }

  useEffect(() => {
    syncAutoWeeklyWorkerChangesFromStorage();
    function onChangesUpdated() {
      syncAutoWeeklyWorkerChangesFromStorage();
    }
    window.addEventListener("auto-planning-worker-changes-updated", onChangesUpdated as EventListener);
    return () => {
      window.removeEventListener("auto-planning-worker-changes-updated", onChangesUpdated as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function getAutoWeeklyWorkerChangesCount(site: Site): number {
    if (!autoPlanningConfig?.enabled) return 0;
    const weekIso = getSiteAutoPlanningStatus(site)?.week_iso || site.next_week_saved_plan_status?.week_iso || "";
    if (!weekIso) return 0;
    const perWeek = autoWeeklyWorkerChangesByWeek[weekIso];
    if (!perWeek) return 0;
    return Number(perWeek[String(site.id)] || 0);
  }

  function clearAutoWeeklyWorkerChangesForWeek(weekIso: string | null | undefined) {
    const wk = String(weekIso || "").trim();
    if (!wk || typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(AUTO_WEEKLY_WORKER_CHANGES_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object" || !parsed[wk]) return;
      delete parsed[wk];
      localStorage.setItem(AUTO_WEEKLY_WORKER_CHANGES_KEY, JSON.stringify(parsed));
      setAutoWeeklyWorkerChangesByWeek(parsed);
      window.dispatchEvent(new CustomEvent("auto-planning-worker-changes-updated"));
    } catch {}
  }

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
      const defaultLim =
        config.pulls_limit != null && config.pulls_limit >= 1
          ? Math.min(AUTO_PLANNING_PULLS_MAX, config.pulls_limit)
          : 5;
      const rawBy = config.pulls_limits_by_site;
      const hasPerSite = !!rawBy && typeof rawBy === "object" && Object.keys(rawBy).length > 0;
      const bySite: Record<number, number> = {};
      if (hasPerSite && rawBy) {
        for (const [k, v] of Object.entries(rawBy)) {
          const id = Number(k);
          if (!Number.isNaN(id) && v != null && Number(v) >= 1) {
            bySite[id] = Math.min(AUTO_PLANNING_PULLS_MAX, Math.max(1, Number(v)));
          }
        }
      }
      setAutoPlanningForm({
        enabled: !!config.enabled,
        day_of_week: Number(config.day_of_week || 0),
        time: `${String(config.hour ?? 9).padStart(2, "0")}:${String(config.minute ?? 0).padStart(2, "0")}`,
        auto_pulls_enabled: !!config.auto_pulls_enabled,
        auto_save_mode: config.auto_save_mode || "manual",
        pulls_limits_mode: hasPerSite ? "per_site" : "same",
        pulls_limit_same: defaultLim,
        pulls_limits_by_site: bySite,
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
    const defaultLim =
      config?.pulls_limit != null && config.pulls_limit >= 1
        ? Math.min(AUTO_PLANNING_PULLS_MAX, config.pulls_limit)
        : 5;
    const rawBy = config?.pulls_limits_by_site;
    const hasPerSite = !!rawBy && typeof rawBy === "object" && Object.keys(rawBy).length > 0;
    const bySite: Record<number, number> = {};
    if (hasPerSite && rawBy) {
      for (const [k, v] of Object.entries(rawBy)) {
        const id = Number(k);
        if (!Number.isNaN(id) && v != null && Number(v) >= 1) {
          bySite[id] = Math.min(AUTO_PLANNING_PULLS_MAX, Math.max(1, Number(v)));
        }
      }
    }
    for (const s of sites) {
      if (bySite[s.id] == null) bySite[s.id] = defaultLim;
    }
    setAutoPlanningForm({
      enabled: !!config?.enabled,
      day_of_week: Number(config?.day_of_week || 0),
      time: `${String(config?.hour ?? 9).padStart(2, "0")}:${String(config?.minute ?? 0).padStart(2, "0")}`,
      auto_pulls_enabled: !!config?.auto_pulls_enabled,
      auto_save_mode: config?.auto_save_mode || "manual",
      pulls_limits_mode: hasPerSite ? "per_site" : "same",
      pulls_limit_same: defaultLim,
      pulls_limits_by_site: bySite,
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
      const limSame = Math.min(AUTO_PLANNING_PULLS_MAX, Math.max(1, Math.floor(Number(autoPlanningForm.pulls_limit_same) || 5)));
      let pulls_limit: number | null = null;
      let pulls_limits_by_site: Record<string, number> | null = null;
      if (autoPlanningForm.auto_pulls_enabled) {
        if (autoPlanningForm.pulls_limits_mode === "per_site") {
          pulls_limit = limSame;
          pulls_limits_by_site = {};
          for (const s of sites) {
            const v = autoPlanningForm.pulls_limits_by_site[s.id];
            const n = Math.min(AUTO_PLANNING_PULLS_MAX, Math.max(1, Math.floor(Number(v) || limSame)));
            pulls_limits_by_site[String(s.id)] = n;
          }
        } else {
          pulls_limit = limSame;
          pulls_limits_by_site = null;
        }
      }
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
          pulls_limit,
          pulls_limits_by_site,
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
      clearAutoWeeklyWorkerChangesForWeek(result.target_week_iso);
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

  function requestPromoteAutoPlan(site: Site, publish: boolean) {
    const weekIso = site.next_week_saved_plan_status?.week_iso;
    if (!weekIso) {
      toast.error("לא נמצאה טיוטת תכנון");
      return;
    }
    if (!getSiteAutoPlanningStatus(site)?.requires_manual_save) {
      toast.info("אין טיוטה לשמירה", {
        description: "הטיוטה כבר הועלתה או שאין תכנון אוטומטי לשבוע. הרץ תכנון אוטומטי ליצירת טיוטה חדשה.",
      });
      return;
    }
    if (isSitesListMultiSite(site)) {
      setOpenActionsSiteId(null);
      setSitesListMultiDialog({ kind: "promote", site, publish, scope: "current_only" });
      return;
    }
    void executePromoteAutoPlan(site, publish, "current_only");
  }

  async function executePromoteAutoPlan(origin: Site, publish: boolean, scope: SitesListMultiScope) {
    const ids = siteIdsForSitesListScope(origin, scope);
    if (!ids.length) return;
    setAutoPlanAction({ siteId: origin.id, publish });
    let done = 0;
    let skipped = 0;
    try {
      for (const id of ids) {
        const s = sites.find((x) => x.id === id);
        if (!s) {
          skipped++;
          continue;
        }
        if (!getSiteAutoPlanningStatus(s)?.requires_manual_save) {
          skipped++;
          continue;
        }
        const weekIso = getSiteAutoPlanningStatus(s)?.week_iso || origin.next_week_saved_plan_status?.week_iso;
        if (!weekIso) {
          skipped++;
          continue;
        }
        await apiFetch(`/director/sites/${s.id}/week-plan/promote-auto?week=${encodeURIComponent(weekIso)}&publish=${publish ? "true" : "false"}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        });
        setSitePromoteBadge((prev) => ({ ...prev, [s.id]: publish ? "published" : "saved" }));
        done++;
      }
      setOpenActionsSiteId(null);
      await fetchSites();
      if (done === 0) {
        toast.info("לא נשמר אף אתר", {
          description: skipped ? "לא נמצאה טיוטה ממתינה לשמירה באתרים שנבחרו." : undefined,
        });
      } else {
        toast.success(publish ? "התכנון נשמר ונשלח" : "התכנון נשמר", {
          description: scope === "all_sites" && done > 1 ? `עודכנו ${done} אתרים מקושרים.` : undefined,
        });
      }
    } catch (e: unknown) {
      const msg = getErrorMessage(e);
      const status = typeof e === "object" && e !== null && "status" in e ? (e as { status?: number }).status : undefined;
      if (status === 404 || msg.includes("לא נמצא")) {
        toast.error("אין טיוטת תכנון אוטומטית", {
          description: "הטיוטה כבר הועלתה או חסרה. הרץ תכנון אוטומטי ליצירת טיוטה חדשה.",
        });
      } else {
        toast.error("שגיאה בשמירת הטיוטה", { description: msg });
      }
    } finally {
      setAutoPlanAction({ siteId: null, publish: null });
    }
  }

  async function deleteSavedWeekPlanCore(site: Site, authHeaders: { Authorization: string }): Promise<{
    existingAuto: Record<string, unknown> | null;
    copiedSavedPlanToAuto: boolean;
  }> {
    const weekIso = site.next_week_saved_plan_status?.week_iso;
    if (!weekIso) throw new Error("לא נמצא שבוע");
    const stBefore = getSiteAutoPlanningStatus(site);
    if (stBefore?.exists) {
      setPreservedWeekPlanStats((prev) => ({
        ...prev,
        [site.id]: {
          assigned: stBefore.assigned_count ?? 0,
          required: stBefore.required_count ?? 0,
          pulls: stBefore.pulls_count ?? 0,
          complete: stBefore.complete ?? undefined,
        },
      }));
    }
    const existingAuto = await apiFetch<Record<string, unknown> | null>(
      `/director/sites/${site.id}/week-plan?week=${encodeURIComponent(weekIso)}&scope=auto`,
      { headers: authHeaders },
    );
    let copiedSavedPlanToAuto = false;
    if (existingAuto == null) {
      let dataToDraft: Record<string, unknown> | null = null;
      for (const planScope of ["shared", "director"] as const) {
        const d = await apiFetch<Record<string, unknown> | null>(
          `/director/sites/${site.id}/week-plan?week=${encodeURIComponent(weekIso)}&scope=${planScope}`,
          { headers: authHeaders },
        );
        if (d != null) {
          dataToDraft = d;
          break;
        }
      }
      if (dataToDraft != null) {
        await apiFetch(`/director/sites/${site.id}/week-plan`, {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify({ week_iso: weekIso, scope: "auto", data: dataToDraft }),
        });
        copiedSavedPlanToAuto = true;
      }
    }
    await apiFetch(`/director/sites/${site.id}/week-plan?week=${encodeURIComponent(weekIso)}&scope=director`, {
      method: "DELETE",
      headers: authHeaders,
    });
    await apiFetch(`/director/sites/${site.id}/week-plan?week=${encodeURIComponent(weekIso)}&scope=shared`, {
      method: "DELETE",
      headers: authHeaders,
    });
    return { existingAuto, copiedSavedPlanToAuto };
  }

  function requestDeleteSavedWeekPlan(site: Site) {
    if (!site.next_week_saved_plan_status?.week_iso) {
      toast.error("לא נמצא שבוע");
      return;
    }
    if (!hasSavedWeekPlanForWeek(site)) return;
    if (isSitesListMultiSite(site)) {
      setOpenActionsSiteId(null);
      setSitesListMultiDialog({ kind: "delete", site, scope: "current_only" });
      return;
    }
    void executeDeleteSavedWeekPlan(site, "current_only");
  }

  async function executeDeleteSavedWeekPlan(origin: Site, scope: SitesListMultiScope) {
    const ids = siteIdsForSitesListScope(origin, scope);
    const confirmMsg =
      scope === "all_sites"
        ? "למחוק את הסידור השמור לשבוע זה מכל האתרים המקושרים?"
        : "למחוק את הסידור השמור לשבוע זה?";
    if (!window.confirm(confirmMsg)) return;
    const token = localStorage.getItem("access_token");
    if (!token) return;
    const authHeaders = { Authorization: `Bearer ${token}` };
    setDeleteWeekPlanSiteId(origin.id);
    try {
      let lastMeta: { existingAuto: Record<string, unknown> | null; copiedSavedPlanToAuto: boolean } | null = null;
      let doneCount = 0;
      for (const id of ids) {
        const s = sites.find((x) => x.id === id);
        if (!s || !hasSavedWeekPlanForWeek(s)) continue;
        setDeleteWeekPlanSiteId(s.id);
        lastMeta = await deleteSavedWeekPlanCore(s, authHeaders);
        doneCount++;
        setSitePromoteBadge((prev) => {
          const next = { ...prev };
          delete next[s.id];
          return next;
        });
      }
      setOpenActionsSiteId(null);
      await fetchSites();
      if (doneCount === 0) {
        toast.info("לא נמחק אף אתר", { description: "לא נמצא סידור שמור באתרים שנבחרו." });
      } else {
        const batch = scope === "all_sites" && doneCount > 1;
        toast.success("הסידור השמור הוסר", {
          description: batch
            ? `הוסר מ-${doneCount} אתרים מקושרים.`
            : lastMeta?.existingAuto != null
              ? "הטיוטה (טיוטת אוטומטית) נשארה כפי שהייתה."
              : lastMeta?.copiedSavedPlanToAuto
                ? "התכנון שהיה שמור הוחזר כטיוטה (ממתין לשמירה)."
                : "השמירה הוסרה.",
        });
      }
    } catch (e: unknown) {
      toast.error("שגיאה במחיקת הסידור", { description: getErrorMessage(e) });
    } finally {
      setDeleteWeekPlanSiteId(null);
    }
  }

  const filteredSites = useMemo(() => {
    const q = (query || "").trim().toLowerCase();
    if (!q) return sites;
    return (sites || []).filter((s) => (s?.name || "").toLowerCase().includes(q));
  }, [sites, query]);

  const siteDisplayGroups = useMemo(() => groupSitesForMultiDisplay(filteredSites), [filteredSites]);

  const autoPlanningSummary = useMemo(() => {
    const cfg = autoPlanningConfig;
    const raw = (cfg?.target_week_iso ?? "").trim();
    const parsed = raw ? new Date(`${raw}T00:00:00`) : null;
    const targetWeekStart =
      raw && parsed && !Number.isNaN(parsed.getTime()) ? raw : getNextWeekIsoSundayBased();
    const targetWeekEnd = addDaysToIsoDate(targetWeekStart, 6);
    const weekLabel = `${formatIsoDateLabel(targetWeekStart)} - ${formatIsoDateLabel(targetWeekEnd)}`;
    if (!cfg?.enabled) {
      return {
        scheduleLabel: "כבוי",
        weekLabel,
      };
    }
    const dayLabel = AUTO_PLANNING_DAY_OPTIONS.find((option) => option.value === cfg.day_of_week)?.label || "יום ראשון";
    const timeLabel = `${String(cfg.hour ?? 9).padStart(2, "0")}:${String(cfg.minute ?? 0).padStart(2, "0")}`;
    return {
      scheduleLabel: `${dayLabel} ${timeLabel}`,
      weekLabel,
    };
  }, [autoPlanningConfig]);

  /** Actions פעולות (שמור / מחק סידור / etc.) : uniquement si תכנון אוטומטי activé */
  const showAutoPlanningSiteStatuses = !!autoPlanningConfig?.enabled;

  /**
   * Badges « נשמר (מנהל) » / « נשמר ונשלח » sous la ligne de statut : visibles sans auto,
   * et aussi avec תכנון אוטומטי lorsque l’enregistrement reste ידני (יצירת טיוטה + שמור / שמור ואשלח).
   * Masqués en שמירה אוטומטית (director/shared) pour éviter la redondance avec l’automatisation.
   */
  const showSavedScopeStatusBadges =
    !showAutoPlanningSiteStatuses || autoPlanningConfig?.auto_save_mode === "manual";

  /**
   * Avec תכנון אוטומטי : ligne שיבוצים / משיכות pour tout état (טיוטה, שמור, etc.).
   * Sans auto : afficher שיבוצים / משיכות seulement si סידור נשמר למנהל, נשמר ונשלח,
   * badge après promote, ou stats conservées après מחק סידור (toujours depuis une sauvegarde).
   */
  function shouldShowWeekPlanningStatusRow(site: Site): boolean {
    const st = getSiteAutoPlanningStatus(site);
    const preserved = preservedWeekPlanStats[site.id];
    if (showAutoPlanningSiteStatuses) {
      if (!st) return false;
      return true;
    }
    if (sitePromoteBadge[site.id]) return true;
    if (preserved) return true;
    if (!st) return false;
    return hasSavedWeekPlanForWeek(site);
  }

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
                className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm shadow-sm ${autoPlanningConfig?.enabled ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-900/50" : "border-amber-200/80 bg-amber-50/40 text-amber-800/75 hover:bg-amber-50/70 dark:border-amber-800/45 dark:bg-amber-950/20 dark:text-amber-200/70 dark:hover:bg-amber-950/35"}`}
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
                  className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm shadow-sm ${autoPlanningConfig?.enabled ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-900/50" : "border-amber-200/80 bg-amber-50/40 text-amber-800/75 hover:bg-amber-50/70 dark:border-amber-800/45 dark:bg-amber-950/20 dark:text-amber-200/70 dark:hover:bg-amber-950/35"}`}
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
                  {showAutoPlanningSiteStatuses ? (
                    <button
                      type="button"
                      onClick={onTestAutoPlanningNow}
                      disabled={autoPlanningTesting || autoPlanningSaving || autoPlanningControlsDisabled}
                      className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-800 shadow-sm hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
                    >
                      {autoPlanningTesting ? "מריץ..." : "הרץ ידנית"}
                    </button>
                  ) : null}
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
              {showAutoPlanningSiteStatuses ? (
                <button
                  type="button"
                  onClick={onTestAutoPlanningNow}
                  disabled={autoPlanningTesting || autoPlanningSaving || autoPlanningControlsDisabled}
                  className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-800 shadow-sm hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
                >
                  {autoPlanningTesting ? "מריץ..." : "הרץ ידנית"}
                </button>
              ) : null}
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
                <div dir="rtl" className="-mx-4 max-h-[43rem] divide-y divide-zinc-200 overflow-y-auto px-4 dark:divide-zinc-700">
                  {siteDisplayGroups.map((group) => {
                    const isMulti = group.length > 1;
                    return (
                      <div
                        key={group.map((g) => g.id).join("-")}
                        className={
                          isMulti
                            ? "my-2 rounded-xl border border-sky-300/90 shadow-sm first:mt-0 dark:border-sky-700 divide-y divide-sky-200/80 dark:divide-sky-800/50"
                            : ""
                        }
                      >
                        {group.map((s) => (
                    <div key={s.id} className={`flex items-center justify-between py-3 ${isMulti ? "px-2.5" : ""}`}>
                      <div className="flex flex-col">
                        <span className="font-medium">{s.name}</span>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-zinc-500">
                          <span>מספר עובדים: {s.workers_count}</span>
                          {(s.pending_workers_count ?? 0) > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-xs text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
                              <SiteBadgeIconPendingApproval />
                              {s.pending_workers_count} ממתין לאישור
                            </span>
                          ) : null}
                        </div>
                        {!shouldShowWeekPlanningStatusRow(s) && getSiteAutoPlanningStatus(s)?.requires_manual_save ? (
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                              <SiteBadgeIconSavePending />
                              ממתין לשמירה
                            </span>
                          </div>
                        ) : null}
                        {shouldShowWeekPlanningStatusRow(s) ? (
                          (() => {
                            const w = getWeekPlanStatusDisplay(s, preservedWeekPlanStats[s.id]);
                            return (
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <span
                              className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
                                w.showAssignmentsLine
                                  ? w.complete
                                  ? "border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300"
                                  : "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
                                  : "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                              }`}
                            >
                              <span className="font-semibold tabular-nums">
                                {w.showAssignmentsLine ? (w.complete ? "V" : "X") : "•"}
                              </span>
                              <span>
                                {w.showAssignmentsLine
                                  ? `${w.assigned}/${w.required} שיבוצים`
                                  : "אין סידור שמור"}
                              </span>
                            </span>
                            {w.pulls > 0 ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-orange-300 bg-orange-50 px-2 py-0.5 text-xs text-orange-700 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-300">
                                <SiteBadgeIconPulls />
                                {w.pulls} משיכות
                              </span>
                            ) : null}
                            {getAutoWeeklyWorkerChangesCount(s) > 0 ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-blue-300 bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
                                <SiteBadgeIconChanges />
                                {getAutoWeeklyWorkerChangesCount(s)} שינויים — נדרשת הרצה מחדש
                              </span>
                            ) : null}
                            {getSiteAutoPlanningStatus(s)?.requires_manual_save ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                                <SiteBadgeIconSavePending />
                                ממתין לשמירה
                              </span>
                            ) : null}
                            {sitePromoteBadge[s.id] === "saved" ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                                <SiteBadgeIconSavedDirector />
                                נשמר (מנהל)
                              </span>
                            ) : null}
                            {sitePromoteBadge[s.id] === "published" ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-xs text-teal-800 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300">
                                <SiteBadgeIconPublished />
                                נשמר ונשלח לעובדים
                              </span>
                            ) : null}
                            {showSavedScopeStatusBadges &&
                            !sitePromoteBadge[s.id] &&
                            getSiteAutoPlanningStatus(s)?.exists &&
                            getSiteAutoPlanningStatus(s)?.scope === "director" ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                                <SiteBadgeIconSavedDirector />
                                נשמר (מנהל)
                              </span>
                            ) : null}
                            {showSavedScopeStatusBadges &&
                            !sitePromoteBadge[s.id] &&
                            getSiteAutoPlanningStatus(s)?.exists &&
                            getSiteAutoPlanningStatus(s)?.scope === "shared" ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-xs text-teal-800 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300">
                                <SiteBadgeIconPublished />
                                נשמר ונשלח לעובדים
                              </span>
                            ) : null}
                          </div>
                            );
                          })()
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
                              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1 text-sm text-zinc-800 shadow-sm ring-1 ring-white hover:bg-zinc-50 dark:border-zinc-600 dark:bg-white dark:text-zinc-900 dark:ring-white dark:hover:bg-zinc-100"
                              aria-expanded={openActionsSiteId === s.id}
                              aria-haspopup="menu"
                            >
                              <svg className="h-3.5 w-3.5 shrink-0 text-zinc-600 dark:text-zinc-700" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
                                <path d="M6 8L1 3h10L6 8z" />
                              </svg>
                              פעולות
                            </button>
                            {openActionsSiteId === s.id ? (
                              <div className="absolute right-0 top-full z-20 mt-2 min-w-[180px] rounded-lg border border-zinc-200 bg-white p-1 text-right shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenActionsSiteId(null);
                                    router.push(`/director/planning/${s.id}`);
                                  }}
                                  className="flex w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"
                                >
                                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                    <path d="M12 5c-7.63 0-10.99 6.5-11 7 .01.5 3.37 7 11 7 7.64 0 10.99-6.5 11-7-.01-.5-3.37-7-11-7zm0 12c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                                  </svg>
                                  צפה
                                </button>
                                {showAutoPlanningSiteStatuses ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => void requestPromoteAutoPlan(s, false)}
                                      disabled={
                                        !getSiteAutoPlanningStatus(s)?.requires_manual_save ||
                                        deleteWeekPlanSiteId === s.id ||
                                        (autoPlanAction.siteId === s.id && autoPlanAction.publish === false)
                                      }
                                      title={
                                        !getSiteAutoPlanningStatus(s)?.requires_manual_save
                                          ? "אין טיוטת תכנון אוטומטית — הטיוטה כבר הועלתה או חסרה. הרץ תכנון אוטומטי ליצירת טיוטה חדשה."
                                          : undefined
                                      }
                                      className="flex w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800"
                                    >
                                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                        <path d="M17 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V7l-4-4zm-5 16a3 3 0 110-6 3 3 0 010 6zm3-10H5V5h10v4z" />
                                      </svg>
                                      {autoPlanAction.siteId === s.id && autoPlanAction.publish === false ? "שומר..." : "שמור"}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void requestPromoteAutoPlan(s, true)}
                                      disabled={
                                        !getSiteAutoPlanningStatus(s)?.requires_manual_save ||
                                        deleteWeekPlanSiteId === s.id ||
                                        (autoPlanAction.siteId === s.id && autoPlanAction.publish === true)
                                      }
                                      title={
                                        !getSiteAutoPlanningStatus(s)?.requires_manual_save
                                          ? "אין טיוטת תכנון אוטומטית — הטיוטה כבר הועלתה או חסרה. הרץ תכנון אוטומטי ליצירת טיוטה חדשה."
                                          : undefined
                                      }
                                      className="flex w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-sm text-green-700 hover:bg-green-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-green-300 dark:hover:bg-green-900/30"
                                    >
                                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                                      </svg>
                                      {autoPlanAction.siteId === s.id && autoPlanAction.publish === true ? "שומר..." : "שמור ואשלח"}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void requestDeleteSavedWeekPlan(s)}
                                      disabled={!hasSavedWeekPlanForWeek(s) || deleteWeekPlanSiteId === s.id || autoPlanAction.siteId === s.id}
                                      title={
                                        !hasSavedWeekPlanForWeek(s)
                                          ? "אין סידור שמור לשבוע הבא (רק טיוטה או ריק)"
                                          : undefined
                                      }
                                      className="flex w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-900/30"
                                    >
                                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                        <path d="M6 7h12v2H6Zm2 4h8l-1 9H9ZM9 4h6v2H9Z" />
                                      </svg>
                                      {deleteWeekPlanSiteId === s.id ? "מוחק..." : "מחק סידור"}
                                    </button>
                                  </>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                        <button
                          onClick={() => router.push(`/director/planning/${s.id}`)}
                            className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-3 py-1 text-sm text-zinc-800 shadow-sm ring-1 ring-white hover:bg-zinc-50 dark:border-zinc-600 dark:bg-white dark:text-zinc-900 dark:ring-white dark:hover:bg-zinc-100"
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
                    );
                  })}
                </div>
              ) : (
                <div dir="rtl" className="-mx-4 grid max-h-[32rem] grid-cols-1 gap-4 overflow-y-auto px-4 md:grid-cols-2">
                  {siteDisplayGroups.map((group) => {
                    const isMulti = group.length > 1;
                    return (
                      <div
                        key={group.map((g) => g.id).join("-")}
                        className={
                          isMulti
                            ? "flex flex-col gap-3 rounded-xl border-2 border-sky-300/85 p-3 shadow-sm dark:border-sky-700 md:col-span-2"
                            : "contents"
                        }
                      >
                        {group.map((s) => (
                    <div
                      key={s.id}
                      className={`rounded-xl border bg-white p-4 dark:bg-zinc-900 ${
                        isMulti ? "border-sky-300/85 dark:border-sky-700" : "border-zinc-200 dark:border-zinc-800"
                      }`}
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-base font-semibold">{s.name}</span>
                        <div className="flex flex-wrap items-center justify-end gap-2 text-sm text-zinc-500">
                          <span>{s.workers_count} עובדים</span>
                          {(s.pending_workers_count ?? 0) > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-xs text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
                              <SiteBadgeIconPendingApproval className="h-3.5 w-3.5 shrink-0 opacity-90" />
                              {s.pending_workers_count} ממתין לאישור
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {!shouldShowWeekPlanningStatusRow(s) && getSiteAutoPlanningStatus(s)?.requires_manual_save ? (
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                            <SiteBadgeIconSavePending className="h-3.5 w-3.5 shrink-0 opacity-90" />
                            ממתין לשמירה
                          </span>
                        </div>
                      ) : null}
                      {shouldShowWeekPlanningStatusRow(s) ? (
                        (() => {
                          const w = getWeekPlanStatusDisplay(s, preservedWeekPlanStats[s.id]);
                          return (
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <div
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs ${
                              w.showAssignmentsLine
                                ? w.complete
                                ? "border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300"
                                : "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
                                : "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                            }`}
                          >
                            <span className="font-semibold tabular-nums">
                              {w.showAssignmentsLine ? (w.complete ? "V" : "X") : "•"}
                            </span>
                            <span>
                              {w.showAssignmentsLine
                                ? `${w.assigned}/${w.required} שיבוצים`
                                : "אין סידור שמור"}
                            </span>
                          </div>
                          {w.pulls > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-orange-300 bg-orange-50 px-2 py-1 text-xs text-orange-700 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-300">
                              <SiteBadgeIconPulls className="h-3.5 w-3.5 shrink-0 opacity-90" />
                              {w.pulls} משיכות
                            </span>
                          ) : null}
                          {getAutoWeeklyWorkerChangesCount(s) > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-blue-300 bg-blue-50 px-2 py-1 text-xs text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
                              <SiteBadgeIconChanges className="h-3.5 w-3.5 shrink-0 opacity-90" />
                              {getAutoWeeklyWorkerChangesCount(s)} שינויים — נדרשת הרצה מחדש
                            </span>
                          ) : null}
                          {getSiteAutoPlanningStatus(s)?.requires_manual_save ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                              <SiteBadgeIconSavePending className="h-3.5 w-3.5 shrink-0 opacity-90" />
                              ממתין לשמירה
                            </span>
                          ) : null}
                          {sitePromoteBadge[s.id] === "saved" ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                              <SiteBadgeIconSavedDirector className="h-3.5 w-3.5 shrink-0 opacity-90" />
                              נשמר (מנהל)
                            </span>
                          ) : null}
                          {sitePromoteBadge[s.id] === "published" ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-teal-300 bg-teal-50 px-2 py-1 text-xs text-teal-800 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300">
                              <SiteBadgeIconPublished className="h-3.5 w-3.5 shrink-0 opacity-90" />
                              נשמר ונשלח לעובדים
                            </span>
                          ) : null}
                          {showSavedScopeStatusBadges &&
                          !sitePromoteBadge[s.id] &&
                          getSiteAutoPlanningStatus(s)?.exists &&
                          getSiteAutoPlanningStatus(s)?.scope === "director" ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                              <SiteBadgeIconSavedDirector className="h-3.5 w-3.5 shrink-0 opacity-90" />
                              נשמר (מנהל)
                            </span>
                          ) : null}
                          {showSavedScopeStatusBadges &&
                          !sitePromoteBadge[s.id] &&
                          getSiteAutoPlanningStatus(s)?.exists &&
                          getSiteAutoPlanningStatus(s)?.scope === "shared" ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-teal-300 bg-teal-50 px-2 py-1 text-xs text-teal-800 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300">
                              <SiteBadgeIconPublished className="h-3.5 w-3.5 shrink-0 opacity-90" />
                              נשמר ונשלח לעובדים
                            </span>
                          ) : null}
                        </div>
                          );
                        })()
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
                              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1 text-sm text-zinc-800 shadow-sm ring-1 ring-white hover:bg-zinc-50 dark:border-zinc-600 dark:bg-white dark:text-zinc-900 dark:ring-white dark:hover:bg-zinc-100"
                              aria-expanded={openActionsSiteId === s.id}
                              aria-haspopup="menu"
                            >
                              <svg className="h-3.5 w-3.5 shrink-0 text-zinc-600 dark:text-zinc-700" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
                                <path d="M6 8L1 3h10L6 8z" />
                              </svg>
                              פעולות
                            </button>
                            {openActionsSiteId === s.id ? (
                              <div className="absolute right-0 top-full z-20 mt-2 min-w-[180px] rounded-lg border border-zinc-200 bg-white p-1 text-right shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenActionsSiteId(null);
                                    router.push(`/director/planning/${s.id}`);
                                  }}
                                  className="flex w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"
                                >
                                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                    <path d="M12 5c-7.63 0-10.99 6.5-11 7 .01.5 3.37 7 11 7 7.64 0 10.99-6.5 11-7-.01-.5-3.37-7-11-7zm0 12c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                                  </svg>
                                  צפה
                                </button>
                                {showAutoPlanningSiteStatuses ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => void requestPromoteAutoPlan(s, false)}
                                      disabled={
                                        !getSiteAutoPlanningStatus(s)?.requires_manual_save ||
                                        deleteWeekPlanSiteId === s.id ||
                                        (autoPlanAction.siteId === s.id && autoPlanAction.publish === false)
                                      }
                                      title={
                                        !getSiteAutoPlanningStatus(s)?.requires_manual_save
                                          ? "אין טיוטת תכנון אוטומטית — הטיוטה כבר הועלתה או חסרה. הרץ תכנון אוטומטי ליצירת טיוטה חדשה."
                                          : undefined
                                      }
                                      className="flex w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800"
                                    >
                                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                        <path d="M17 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V7l-4-4zm-5 16a3 3 0 110-6 3 3 0 010 6zm3-10H5V5h10v4z" />
                                      </svg>
                                      {autoPlanAction.siteId === s.id && autoPlanAction.publish === false ? "שומר..." : "שמור"}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void requestPromoteAutoPlan(s, true)}
                                      disabled={
                                        !getSiteAutoPlanningStatus(s)?.requires_manual_save ||
                                        deleteWeekPlanSiteId === s.id ||
                                        (autoPlanAction.siteId === s.id && autoPlanAction.publish === true)
                                      }
                                      title={
                                        !getSiteAutoPlanningStatus(s)?.requires_manual_save
                                          ? "אין טיוטת תכנון אוטומטית — הטיוטה כבר הועלתה או חסרה. הרץ תכנון אוטומטי ליצירת טיוטה חדשה."
                                          : undefined
                                      }
                                      className="flex w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-sm text-green-700 hover:bg-green-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-green-300 dark:hover:bg-green-900/30"
                                    >
                                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                                      </svg>
                                      {autoPlanAction.siteId === s.id && autoPlanAction.publish === true ? "שומר..." : "שמור ואשלח"}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void requestDeleteSavedWeekPlan(s)}
                                      disabled={!hasSavedWeekPlanForWeek(s) || deleteWeekPlanSiteId === s.id || autoPlanAction.siteId === s.id}
                                      title={
                                        !hasSavedWeekPlanForWeek(s)
                                          ? "אין סידור שמור לשבוע הבא (רק טיוטה או ריק)"
                                          : undefined
                                      }
                                      className="flex w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-900/30"
                                    >
                                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                        <path d="M6 7h12v2H6Zm2 4h8l-1 9H9ZM9 4h6v2H9Z" />
                                      </svg>
                                      {deleteWeekPlanSiteId === s.id ? "מוחק..." : "מחק סידור"}
                                    </button>
                                  </>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                        <button
                          onClick={() => router.push(`/director/planning/${s.id}`)}
                            className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-3 py-1 text-sm text-zinc-800 shadow-sm ring-1 ring-white hover:bg-zinc-50 dark:border-zinc-600 dark:bg-white dark:text-zinc-900 dark:ring-white dark:hover:bg-zinc-100"
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
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {sitesListMultiDialog ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          dir="rtl"
          onClick={() => setSitesListMultiDialog(null)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-2 text-right">
              <div className="text-base font-semibold">
                {sitesListMultiDialog.kind === "delete"
                  ? "מחק סידור באתרים מקושרים"
                  : sitesListMultiDialog.publish
                    ? "שמור ואשלח באתרים מקושרים"
                    : "שמור באתרים מקושרים"}
              </div>
              <div className="text-sm text-zinc-600 dark:text-zinc-300">
                האם לבצע את הפעולה רק עבור {sitesListMultiDialog.site.name} או עבור כל האתרים המקושרים?
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                אתרים מקושרים:{" "}
                {sortedLinkedSiteIds(sitesListMultiDialog.site)
                  .map((id) => sites.find((x) => x.id === id)?.name || `#${id}`)
                  .join(", ")}
              </div>
            </div>
            <div className="mt-4 space-y-3">
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 px-3 py-3 text-right dark:border-zinc-700">
                <input
                  type="radio"
                  name="sites-list-multi-scope"
                  className="mt-1"
                  checked={sitesListMultiDialog.scope === "current_only"}
                  onChange={() =>
                    setSitesListMultiDialog((prev) => (prev ? { ...prev, scope: "current_only" } : prev))
                  }
                />
                <div className="flex-1">
                  <div className="text-sm font-medium">רק באתר הנוכחי</div>
                  <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{sitesListMultiDialog.site.name}</div>
                </div>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 px-3 py-3 text-right dark:border-zinc-700">
                <input
                  type="radio"
                  name="sites-list-multi-scope"
                  className="mt-1"
                  checked={sitesListMultiDialog.scope === "all_sites"}
                  onChange={() =>
                    setSitesListMultiDialog((prev) => (prev ? { ...prev, scope: "all_sites" } : prev))
                  }
                />
                <div className="flex-1">
                  <div className="text-sm font-medium">בכל האתרים המקושרים</div>
                  <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {sortedLinkedSiteIds(sitesListMultiDialog.site)
                      .map((id) => sites.find((x) => x.id === id)?.name || `#${id}`)
                      .join(", ")}
                  </div>
                </div>
              </label>
            </div>
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => setSitesListMultiDialog(null)}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-3 py-1 text-sm text-white hover:bg-[#0092c6]"
                onClick={() => {
                  const d = sitesListMultiDialog;
                  setSitesListMultiDialog(null);
                  if (!d) return;
                  if (d.kind === "promote") void executePromoteAutoPlan(d.site, d.publish, d.scope);
                  else void executeDeleteSavedWeekPlan(d.site, d.scope);
                }}
              >
                המשך
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
              <div
                className={`space-y-4 ${
                  autoPlanningControlsDisabled ? "pointer-events-none opacity-50" : ""
                }`}
              >
              <label className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 px-3 py-3 dark:border-zinc-800">
                <div className="space-y-1">
                  <div className="text-sm font-medium">משיכה</div>
                  <div className="text-xs text-zinc-500">אם יש חורים, המערכת תנסה להוסיף משיכות אוטומטיות לכל האתרים.</div>
                </div>
                <input
                  type="checkbox"
                  checked={autoPlanningForm.auto_pulls_enabled}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setAutoPlanningForm((prev) => {
                      if (!checked) return { ...prev, auto_pulls_enabled: false };
                      const by = { ...prev.pulls_limits_by_site };
                      const base = Math.min(AUTO_PLANNING_PULLS_MAX, Math.max(1, Math.floor(Number(prev.pulls_limit_same) || 5)));
                      for (const s of sites) {
                        if (by[s.id] == null) by[s.id] = base;
                      }
                      return { ...prev, auto_pulls_enabled: true, pulls_limit_same: base, pulls_limits_by_site: by };
                    });
                  }}
                  disabled={autoPlanningControlsDisabled}
                  className="h-5 w-5 accent-orange-500"
                />
              </label>
              {autoPlanningForm.auto_pulls_enabled ? (
                <div className="space-y-3 rounded-xl border border-orange-200 bg-orange-50/70 px-3 py-3 dark:border-orange-900 dark:bg-orange-950/25">
                  <div className="text-sm font-medium text-orange-950 dark:text-orange-100">מגבלת משיכות</div>
                  <p className="text-xs text-orange-900/85 dark:text-orange-200/90">
                    מגביל כמה משיכות אוטומטיות יתווספו לכל תכנון. אפשר אותו מספר לכל האתרים או ערך שונה לכל אתר.
                  </p>
                  <div className="space-y-3 text-sm">
                    <label className="flex w-full flex-col gap-1">
                      <span className="text-xs font-medium text-orange-900 dark:text-orange-200">סוג מגבלה</span>
                      <OptionListPicker
                        options={[
                          { value: "same", label: "אותה מגבלה לכל האתרים" },
                          { value: "per_site", label: "מגבלה נפרדת לכל אתר" },
                        ]}
                        value={autoPlanningForm.pulls_limits_mode}
                        onChange={(v) => {
                          if (v === "per_site") {
                            setAutoPlanningForm((prev) => {
                              const by = { ...prev.pulls_limits_by_site };
                              const base = Math.min(AUTO_PLANNING_PULLS_MAX, Math.max(1, Math.floor(Number(prev.pulls_limit_same) || 5)));
                              for (const s of sites) {
                                if (by[s.id] == null) by[s.id] = base;
                              }
                              return { ...prev, pulls_limits_mode: "per_site", pulls_limits_by_site: by };
                            });
                          } else {
                            setAutoPlanningForm((prev) => ({ ...prev, pulls_limits_mode: "same" }));
                          }
                        }}
                        disabled={autoPlanningControlsDisabled}
                        popupTitle="בחר סוג מגבלה"
                        className="h-10 w-full min-w-0 max-w-[17.5rem] rounded-md border border-orange-200/90 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-zinc-100 dark:border-orange-900/50 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:ring-orange-600"
                      />
                    </label>
                    {autoPlanningForm.pulls_limits_mode === "same" ? (
                      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                        <span className="font-medium">עד</span>
                        <NumberPicker
                          value={autoPlanningForm.pulls_limit_same}
                          onChange={(n) =>
                            setAutoPlanningForm((prev) => ({
                              ...prev,
                              pulls_limit_same: Math.min(AUTO_PLANNING_PULLS_MAX, Math.max(1, n)),
                            }))
                          }
                          min={1}
                          max={AUTO_PLANNING_PULLS_MAX}
                          disabled={autoPlanningControlsDisabled}
                          className="h-9 w-24 rounded-md border border-zinc-300 bg-white px-2 text-center text-sm text-zinc-900 outline-none dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
                        />
                        <span>משיכות לכל אתר</span>
                      </div>
                    ) : null}
                    {autoPlanningForm.pulls_limits_mode === "per_site" ? (
                      <div className="max-h-44 space-y-2 overflow-y-auto rounded-md border border-orange-200/80 bg-white/80 p-2 dark:border-orange-900/60 dark:bg-zinc-900/80">
                        {sites.length === 0 ? (
                          <p className="text-xs text-zinc-500">אין אתרים — הוסף אתרים כדי להגדיר מגבלות.</p>
                        ) : (
                          sites.map((s) => (
                            <div key={s.id} className="flex items-center justify-between gap-2 text-xs">
                              <span className="min-w-0 flex-1 truncate font-medium text-zinc-800 dark:text-zinc-200">{s.name}</span>
                              <div className="flex shrink-0 items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                                <span className="whitespace-nowrap">עד</span>
                                <NumberPicker
                                  value={autoPlanningForm.pulls_limits_by_site[s.id] ?? autoPlanningForm.pulls_limit_same}
                                  onChange={(n) => {
                                    const lim = Math.min(AUTO_PLANNING_PULLS_MAX, Math.max(1, n));
                                    setAutoPlanningForm((prev) => ({
                                      ...prev,
                                      pulls_limits_by_site: { ...prev.pulls_limits_by_site, [s.id]: lim },
                                    }));
                                  }}
                                  min={1}
                                  max={AUTO_PLANNING_PULLS_MAX}
                                  disabled={autoPlanningControlsDisabled}
                                  className="h-9 w-20 rounded-md border border-zinc-300 bg-white px-1.5 text-center text-sm text-zinc-900 outline-none dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
                                />
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className="space-y-2">
                <label className="flex w-full flex-col gap-1">
                  <span className="text-sm font-medium">אופן שמירה אוטומטית</span>
                  <OptionListPicker
                    options={AUTO_PLANNING_SAVE_MODE_OPTIONS.map((o) => ({
                      value: o.value,
                      label: o.label,
                      description: o.description,
                    }))}
                    value={autoPlanningForm.auto_save_mode}
                    onChange={(v) =>
                      setAutoPlanningForm((prev) => ({
                        ...prev,
                        auto_save_mode: v as "manual" | "director" | "shared",
                      }))
                    }
                    disabled={autoPlanningControlsDisabled}
                    popupTitle="בחר אופן שמירה"
                    className="h-10 w-full min-w-0 max-w-[17.5rem] rounded-md border px-3 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#00A8E0] disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-300"
                  />
                </label>
                <div className="text-xs text-zinc-500">
                  שומר אוטומטית רק אם האתר מלא. אם נשארו חוסרים, התכנון נשאר ידני ברשימת האתרים.
                </div>
              </div>
              <label className="flex w-full flex-col gap-1">
                <span className="block text-sm font-medium">יום הפעלה</span>
                <OptionListPicker
                  options={AUTO_PLANNING_DAY_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
                  value={String(autoPlanningForm.day_of_week)}
                  onChange={(v) => setAutoPlanningForm((prev) => ({ ...prev, day_of_week: Number(v) }))}
                  disabled={autoPlanningControlsDisabled}
                  popupTitle="בחר יום הפעלה"
                  className="h-10 w-full min-w-0 max-w-[17.5rem] rounded-md border px-3 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#00A8E0] disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-300"
                />
              </label>
              <label className="flex w-full flex-col gap-1">
                <span className="block text-sm font-medium">שעת הפעלה</span>
                <TimePicker
                  value={autoPlanningForm.time}
                  onChange={(v) => setAutoPlanningForm((prev) => ({ ...prev, time: v }))}
                  disabled={autoPlanningControlsDisabled}
                  className="h-10 w-full min-w-0 max-w-[17.5rem] rounded-md border px-3 text-left text-sm [direction:ltr] text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#00A8E0] disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-300"
                  dir="ltr"
                />
              </label>
              </div>
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


"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { fetchMe } from "@/lib/auth";
import { toast } from "sonner";
import TimePicker from "@/components/time-picker";
import LoadingAnimation from "@/components/loading-animation";
import NumberPicker from "@/components/number-picker";
import PullsLimitPicker from "@/components/pulls-limit-picker";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import DOMPurify from "dompurify";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Highlight from "@tiptap/extension-highlight";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";

const EMPTY_WORKER_AVAILABILITY = {
  sun: [],
  mon: [],
  tue: [],
  wed: [],
  thu: [],
  fri: [],
  sat: [],
};

const AVAILABILITY_DAY_KEYS = Object.keys(EMPTY_WORKER_AVAILABILITY) as Array<keyof typeof EMPTY_WORKER_AVAILABILITY>;

/** Copie profonde des créneaux par jour (évite les références partagées). */
function cloneWorkerAvailability(
  av: Record<string, string[]> | null | undefined,
): Record<keyof typeof EMPTY_WORKER_AVAILABILITY, string[]> {
  const base = av || EMPTY_WORKER_AVAILABILITY;
  const out = {} as Record<keyof typeof EMPTY_WORKER_AVAILABILITY, string[]>;
  for (const k of AVAILABILITY_DAY_KEYS) {
    out[k] = [...(base[k] || [])];
  }
  return out;
}

/** Vrai seulement si la grille jour / משמרת a changé (pas nom, rôles, max_shifts). */
function isAvailabilityDayShiftChanged(
  before: Record<string, string[]> | null | undefined,
  after: Record<string, string[]> | null | undefined,
) {
  try {
    const norm = (x: Record<string, string[]> | null | undefined) => {
      const b = x || EMPTY_WORKER_AVAILABILITY;
      const o: Record<string, string[]> = {};
      for (const k of AVAILABILITY_DAY_KEYS) {
        o[k] = [...(b[k] || [])].map(String).sort();
      }
      return JSON.stringify(o);
    };
    return norm(before) !== norm(after);
  } catch {
    return true;
  }
}

function normPlanningCellName(s: unknown): string {
  return String(s ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Noms contenus dans une cellule du snapshot (liste plate).
 * Tolère un niveau de tableau imbriqué si les données sont mal formées.
 */
function draftFixedCellNamesInRow(row: unknown): string[] {
  if (!Array.isArray(row)) return [];
  const out: string[] = [];
  for (const cell of row) {
    if (Array.isArray(cell)) {
      for (const inner of cell) {
        const n = normPlanningCellName(inner);
        if (n) out.push(n);
      }
    } else {
      const n = normPlanningCellName(cell);
      if (n) out.push(n);
    }
  }
  return out;
}

/** Indique si ce nom figurait dans le snapshot שיבוצים קבועים pour cette case (aligné sur le backend fixed_cells). */
function isWorkerInDraftFixedSnapshot(
  snap: Record<string, Record<string, string[][]>> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  workerName: string,
): boolean {
  if (!snap) return false;
  const row = snap[dayKey]?.[shiftName]?.[stationIdx];
  const names = draftFixedCellNamesInRow(row);
  const n = normPlanningCellName(workerName);
  if (!n) return false;
  return names.includes(n);
}

/** Affiche le pictogramme שיבוץ קבוע (cadenas) pour ce travailleur dans cette cellule. */
function shouldShowDraftFixedPinForWorker(
  snap: Record<string, Record<string, string[][]>> | null | undefined,
  isSavedMode: boolean,
  editingSaved: boolean,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  workerName: string,
  cellAssignedNames: string[],
): boolean {
  if (!snap || (isSavedMode && !editingSaved)) return false;
  const snapNames = draftFixedCellNamesInRow(snap[dayKey]?.[shiftName]?.[stationIdx]);
  if (!snapNames.length) return false;
  const dispSet = new Set(cellAssignedNames.map((x) => normPlanningCellName(x)).filter(Boolean));
  if (!snapNames.every((x) => dispSet.has(x))) return false;
  return isWorkerInDraftFixedSnapshot(snap, dayKey, shiftName, stationIdx, workerName);
}

type PlanningAssignmentsMap = Record<string, Record<string, string[][]>>;

function planningCellNames(cell: unknown): string[] {
  if (!Array.isArray(cell)) return [];
  return cell
    .map((name) => String(name ?? "").trim())
    .filter(Boolean);
}

function samePlanningCellNames(a: unknown, b: unknown): boolean {
  const aa = planningCellNames(a).map(normPlanningCellName).sort();
  const bb = planningCellNames(b).map(normPlanningCellName).sort();
  if (aa.length !== bb.length) return false;
  return aa.every((value, idx) => value === bb[idx]);
}

function buildNonEmptyPlanningAssignmentsSnapshot(
  source: PlanningAssignmentsMap | null | undefined,
): PlanningAssignmentsMap | null {
  if (!source || typeof source !== "object") return null;
  const out: PlanningAssignmentsMap = {};
  Object.keys(source).forEach((dayKey) => {
    const shiftsMap = source[dayKey];
    if (!shiftsMap || typeof shiftsMap !== "object") return;
    Object.keys(shiftsMap).forEach((shiftName) => {
      const perStation = Array.isArray(shiftsMap[shiftName]) ? shiftsMap[shiftName] : [];
      const nextStations = perStation.map((cell) => planningCellNames(cell));
      if (!nextStations.some((cell) => cell.length > 0)) return;
      out[dayKey] = out[dayKey] || {};
      out[dayKey][shiftName] = nextStations;
    });
  });
  return Object.keys(out).length > 0 ? out : null;
}

function buildChangedNonEmptyPlanningAssignmentsSnapshot(
  current: PlanningAssignmentsMap | null | undefined,
  baseline: PlanningAssignmentsMap | null | undefined,
): PlanningAssignmentsMap | null {
  if (!current || typeof current !== "object") return null;
  const out: PlanningAssignmentsMap = {};
  Object.keys(current).forEach((dayKey) => {
    const shiftsMap = current[dayKey];
    if (!shiftsMap || typeof shiftsMap !== "object") return;
    Object.keys(shiftsMap).forEach((shiftName) => {
      const currentStations = Array.isArray(shiftsMap[shiftName]) ? shiftsMap[shiftName] : [];
      const baselineStations = Array.isArray(baseline?.[dayKey]?.[shiftName]) ? (baseline?.[dayKey]?.[shiftName] as string[][]) : [];
      const maxStations = Math.max(currentStations.length, baselineStations.length);
      const nextStations: string[][] = Array.from({ length: maxStations }, (_, stationIdx) => {
        const names = planningCellNames(currentStations[stationIdx]);
        if (names.length === 0) return [];
        if (samePlanningCellNames(currentStations[stationIdx], baselineStations[stationIdx])) return [];
        return names;
      });
      if (!nextStations.some((cell) => cell.length > 0)) return;
      out[dayKey] = out[dayKey] || {};
      out[dayKey][shiftName] = nextStations;
    });
  });
  return Object.keys(out).length > 0 ? out : null;
}

export default function PlanningPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const truncateMobile6 = (value: any) => {
    const s = String(value ?? "");
    const chars = Array.from(s);
    return chars.length > 6 ? chars.slice(0, 4).join("") + "…" : s;
  };
  const truncateSummaryMobile = (value: any) => {
    const s = String(value ?? "");
    const chars = Array.from(s);
    return chars.length > 10 ? chars.slice(0, 8).join("") + "…" : s;
  };
  const copyTextWithFallback = async (value: string) => {
    const text = String(value || "");
    if (!text) return false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      if (typeof document !== "undefined") {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        textarea.style.pointerEvents = "none";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const success = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (success) return true;
      }
    } catch {}
    return false;
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [site, setSite] = useState<any>(null);
  const [workerInviteLinkLoading, setWorkerInviteLinkLoading] = useState(false);
  const [workerInviteLinkDialog, setWorkerInviteLinkDialog] = useState<string | null>(null);
  type WorkerAvailability = Record<string, string[]>; // key: day key (sun..sat) -> enabled shift names
  type Worker = {
    id: number;
    name: string;
    maxShifts: number;
    roles: string[];
    availability: WorkerAvailability;
    answers: Record<string, any>;
    phone?: string | null;
    linkedSiteIds?: number[];
    linkedSiteNames?: string[];
    pendingApproval?: boolean;
  };
  type ExistingWorkerEntry = {
    id: number;
    siteId: number;
    siteName: string;
    name: string;
    phone?: string | null;
    maxShifts: number;
    roles: string[];
    availability: WorkerAvailability;
  };
  type GroupedExistingWorker = {
    key: string;
    name: string;
    phone?: string | null;
    entries: ExistingWorkerEntry[];
  };
  const SITE_BADGE_COLORS = [
    "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
    "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300",
    "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-300",
  ];
  const normalizePhoneDigits = (value: string | null | undefined) => String(value || "").replace(/\D/g, "").trim();
  const [workers, setWorkers] = useState<Worker[]>([]);
  const workersRef = useRef<Worker[]>([]);
  useEffect(() => {
    workersRef.current = workers;
  }, [workers]);
  const [newWorkerName, setNewWorkerName] = useState("");
  const [newWorkerMax, setNewWorkerMax] = useState<number>(5);
  const [newWorkerRoles, setNewWorkerRoles] = useState<string[]>([]);
  const [newWorkerAvailability, setNewWorkerAvailability] = useState<WorkerAvailability>({ ...EMPTY_WORKER_AVAILABILITY });
  // Snapshot de la disponibilité d'origine (celle fournie par le travailleur) au moment de l'édition
  const [originalAvailability, setOriginalAvailability] = useState<WorkerAvailability | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [pendingInviteWorker, setPendingInviteWorker] = useState<Worker | null>(null);
  const [pendingInviteActionLoading, setPendingInviteActionLoading] = useState(false);
  const [isCreateUserModalOpen, setIsCreateUserModalOpen] = useState(false);
  const [isExistingWorkerModalOpen, setIsExistingWorkerModalOpen] = useState(false);
  const [existingWorkersLoading, setExistingWorkersLoading] = useState(false);
  const [existingWorkerQuery, setExistingWorkerQuery] = useState("");
  const [existingWorkerAddingKey, setExistingWorkerAddingKey] = useState<string | null>(null);
  const [existingWorkersCatalog, setExistingWorkersCatalog] = useState<ExistingWorkerEntry[]>([]);
  const [isFilterWorkersModalOpen, setIsFilterWorkersModalOpen] = useState(false);
  const [newWorkerPhone, setNewWorkerPhone] = useState("");
  const [editingWorkerId, setEditingWorkerId] = useState<number | null>(null);
  // Filtres pour les questions optionnelles
  const [questionFilters, setQuestionFilters] = useState<Record<string, any>>({});
  // Filtre pour n'afficher que les jours travaillés (si planning sauvegardé)
  const [filterByWorkDays, setFilterByWorkDays] = useState(false);
  // Visibilité des réponses par question (par défaut toutes visibles)
  const [questionVisibility, setQuestionVisibility] = useState<Record<string, boolean>>({});
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [workerModalSaving, setWorkerModalSaving] = useState(false);
  const [hiddenWorkerIds, setHiddenWorkerIds] = useState<number[]>([]);
  const [preserveLinkedAltSelection, setPreserveLinkedAltSelection] = useState(false);
  // Empêcher qu'une réponse "ancienne" (ancienne semaine) n'écrase l'état quand on navigue vite
  const loadWorkersReqIdRef = useRef(0);
  const [workersResolvedForPage, setWorkersResolvedForPage] = useState(false);
  const loadSavedPlanReqIdRef = useRef(0);
  const savedPlanBeforeEditRef = useRef<SavedWeekPlanState | null>(null);
  const currentSiteIdRef = useRef<string>(String(params.id));
  const weekStartRef = useRef<Date | null>(null);
  // Éviter de re-fetch les réponses en boucle dans le modal
  const answersRefreshKeyRef = useRef<string | null>(null);
  const weekQueryParam = searchParams.get("week");
  const weekFromQuery = useMemo(() => {
    const raw = weekQueryParam;
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    const parsed = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return null;
    parsed.setHours(0, 0, 0, 0);
    return parsed;
  }, [weekQueryParam]);
  const [weekStart, setWeekStart] = useState<Date>(() => {
    if (weekFromQuery) return weekFromQuery;
    // Calculer la semaine prochaine (identique à la page worker)
    const today = new Date();
    const currentDay = today.getDay(); // 0 = dimanche, 6 = samedi
    const daysUntilNextSunday = currentDay === 0 ? 7 : 7 - currentDay; // Si c'est dimanche, prendre le dimanche suivant
    
    const nextSunday = new Date(today);
    nextSunday.setDate(today.getDate() + daysUntilNextSunday);
    nextSunday.setHours(0, 0, 0, 0);
    
    return nextSunday;
  });
  const getExistingWorkerBadgeClassName = useCallback((siteId: number) => {
    const normalizedId = Math.abs(Number(siteId) || 0);
    return SITE_BADGE_COLORS[normalizedId % SITE_BADGE_COLORS.length];
  }, []);
  const groupedExistingWorkers = useMemo<GroupedExistingWorker[]>(() => {
    const grouped = new Map<string, GroupedExistingWorker>();
    for (const worker of existingWorkersCatalog) {
      const normalizedPhone = normalizePhoneDigits(worker.phone);
      const key = normalizedPhone ? `phone:${normalizedPhone}` : `worker:${worker.id}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.entries.push(worker);
        if (!existing.phone && worker.phone) existing.phone = worker.phone;
        continue;
      }
      grouped.set(key, {
        key,
        name: worker.name,
        phone: worker.phone ?? null,
        entries: [worker],
      });
    }
    return Array.from(grouped.values())
      .map((group) => ({
        ...group,
        entries: [...group.entries].sort((left, right) => left.siteName.localeCompare(right.siteName)),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [existingWorkersCatalog]);
  const filteredExistingWorkers = useMemo(() => {
    const query = String(existingWorkerQuery || "").trim().toLowerCase();
    if (!query) return groupedExistingWorkers;
    return groupedExistingWorkers.filter((worker) => {
      const siteNames = worker.entries.map((entry) => String(entry.siteName || "").toLowerCase());
      return (
        String(worker.name || "").toLowerCase().includes(query) ||
        String(worker.phone || "").toLowerCase().includes(query) ||
        siteNames.some((siteName) => siteName.includes(query))
      );
    });
  }, [existingWorkerQuery, groupedExistingWorkers]);
  useEffect(() => {
    currentSiteIdRef.current = String(params.id);
  }, [params.id]);

  useEffect(() => {
    weekStartRef.current = weekStart;
  }, [weekStart]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await apiFetch<any>("/director/sites/settings/auto-planning", {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        });
        if (cancelled) return;
        setAutoPlanningWeeklyEnabled(!!cfg?.enabled);
      } catch {
        if (!cancelled) setAutoPlanningWeeklyEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function bumpAutoWeeklyWorkerChanges(siteIds: number[], weekIso: string) {
    if (!autoPlanningWeeklyEnabled) return;
    if (!siteIds.length || !weekIso) return;
    try {
      const raw = localStorage.getItem(AUTO_WEEKLY_WORKER_CHANGES_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const byWeek = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, Record<string, number>>;
      const weekMap = (byWeek[weekIso] && typeof byWeek[weekIso] === "object") ? byWeek[weekIso] : {};
      const uniqueIds = Array.from(new Set(siteIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
      uniqueIds.forEach((siteId) => {
        const key = String(siteId);
        const prev = Number(weekMap[key] || 0);
        weekMap[key] = prev + 1;
      });
      byWeek[weekIso] = weekMap;
      localStorage.setItem(AUTO_WEEKLY_WORKER_CHANGES_KEY, JSON.stringify(byWeek));
      window.dispatchEvent(new CustomEvent("auto-planning-worker-changes-updated"));
    } catch {}
  }

  useEffect(() => {
    if (!weekFromQuery) return;
    if (weekStartRef.current && weekStartRef.current.getTime() === weekFromQuery.getTime()) return;
    setWeekStart(weekFromQuery);
  }, [weekFromQuery]);

  useEffect(() => {
    setDraftFixedAssignmentsSnapshot(null);
    manualModeBaseAssignmentsRef.current = null;
    pendingManualFixedAssignmentsRef.current = null;
  }, [weekStart, params.id]);

  // Quand on ouvre "עריכת עובד", s'assurer que les answers sont bien à jour (même en mode plan sauvegardé)
  useEffect(() => {
    if (!isAddModalOpen || !editingWorkerId) return;
    try {
      const wk = getWeekKeyISO(weekStart);
      const key = `${editingWorkerId}_${wk}`;
      if (answersRefreshKeyRef.current === key) return;
      const w = workers.find((x) => Number(x.id) === Number(editingWorkerId));
      const raw = (w as any)?.answers || {};
      const weekAnswers = getAnswersForWeek(raw, weekStart);
      if (weekAnswers) return;
      answersRefreshKeyRef.current = key;
      void refreshWorkersAnswersFromApi();
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAddModalOpen, editingWorkerId, weekStart]);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => new Date(weekStart.getFullYear(), weekStart.getMonth(), 1));

  // IA planning result
  const [aiLoading, setAiLoading] = useState(false);
  const [sharedGenerationRunning, setSharedGenerationRunning] = useState(false);
  const [autoPlanningWeeklyEnabled, setAutoPlanningWeeklyEnabled] = useState(false);
  type AIPlan = {
    days: string[];
    shifts: string[];
    stations: string[];
    assignments: Record<string, Record<string, string[][]>>;
    alternatives?: Record<string, Record<string, string[][]>>[];
    pulls?: Record<string, PullEntry>;
    alternativePulls?: Record<string, PullEntry>[];
    status: string;
    objective: number;
  };
  type LinkedSite = {
    id: number;
    name: string;
    assigned_count?: number;
    required_count?: number;
  };
  const sameLinkedSites = (left: LinkedSite[], right: LinkedSite[]) => {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      const a = left[i];
      const b = right[i];
      if (
        a?.id !== b?.id ||
        a?.name !== b?.name ||
        a?.assigned_count !== b?.assigned_count ||
        a?.required_count !== b?.required_count
      ) {
        return false;
      }
    }
    return true;
  };
  const updateLinkedSites = (next: LinkedSite[]) => {
    const normalized = Array.isArray(next) ? next : [];
    setLinkedSites((prev) => (sameLinkedSites(prev, normalized) ? prev : normalized));
  };
  type LinkedSitePlan = {
    site_id: number;
    site_name: string;
    days: string[];
    shifts: string[];
    stations: string[];
    assignments: Record<string, Record<string, string[][]>>;
    alternatives?: Record<string, Record<string, string[][]>>[];
    pulls?: Record<string, PullEntry>;
    alternative_pulls?: Record<string, PullEntry>[];
    status?: string;
    objective?: number;
    assigned_count?: number;
    required_count?: number;
  };
  type LinkedPlansMemory = {
    activeAltIndex: number;
    plansBySite: Record<string, LinkedSitePlan>;
  };
  type SavedWeekPlanState = {
    assignments: Record<string, Record<string, string[][]>>;
    isManual?: boolean;
    workers?: Array<{ id: number; name: string; max_shifts?: number; roles?: string[]; availability?: Record<string, string[]>; answers?: Record<string, any> }>;
    pulls?: Record<
      string,
      {
        before: { name: string; start: string; end: string };
        after: { name: string; start: string; end: string };
        roleName?: string | null;
      }
    >;
  };
  type SharedAssignmentCountFilters = Record<string, Record<string, string>>;
  type MultiSitePullsMode = "current_only" | "custom_sites";
  type MultiSitePlanAction = "edit" | "delete" | "save_director" | "save_shared";
  type MultiSitePlanActionScope = "current_only" | "all_sites";
  const [aiPlan, setAiPlan] = useState<AIPlan | null>(null);
  const [autoPullsLimit, setAutoPullsLimit] = useState<string>("");
  /** ללא = pas de משיכות ; unlimited (מקסימום) = sans plafond ; 1–10 = plafond */
  const autoPullsEnabled = autoPullsLimit !== "";
  const [linkedSites, setLinkedSites] = useState<LinkedSite[]>([]);
  const [showLinkedSitesDialog, setShowLinkedSitesDialog] = useState(false);
  const [showMultiSitePullsDialog, setShowMultiSitePullsDialog] = useState(false);
  const [multiSitePlanActionDialog, setMultiSitePlanActionDialog] = useState<null | {
    action: MultiSitePlanAction;
    scope: MultiSitePlanActionScope;
  }>(null);
  const [multiSitePullsMode, setMultiSitePullsMode] = useState<MultiSitePullsMode>("current_only");
  const [multiSitePullsLimits, setMultiSitePullsLimits] = useState<Record<string, string>>({});
  const [altIndex, setAltIndex] = useState<number>(0);
  const [sharedAssignmentCountFilters, setSharedAssignmentCountFilters] = useState<SharedAssignmentCountFilters>({});
  const baseAssignmentsRef = useRef<Record<string, Record<string, string[][]>> | null>(null);
  const prevAltCountRef = useRef<number>(0);
  const aiControllerRef = useRef<AbortController | null>(null);
  const aiTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const aiIdleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const streamPullPriorityPromotedRef = useRef(false);
  const multiSitePullsDialogBypassRef = useRef(false);
  const multiSitePullsRequestRef = useRef<Record<string, string> | null>(null);
  /** Dernières cellules « fixes » envoyées à la génération (brouillon auto) — pastilles שיבוץ קבוע */
  const [draftFixedAssignmentsSnapshot, setDraftFixedAssignmentsSnapshot] = useState<Record<
    string,
    Record<string, string[][]>
  > | null>(null);

  // Snapshot sauvegardé pour la semaine (assignations + éventuelle liste travailleurs)
  const [savedWeekPlan, setSavedWeekPlan] = useState<SavedWeekPlanState | null>(null);
  const isSavedMode = !!savedWeekPlan?.assignments;
  // Mode édition après chargement d'une grille sauvegardée
  const [editingSaved, setEditingSaved] = useState(false);
  const [savedPlanLoading, setSavedPlanLoading] = useState(false);
  const [workersLoading, setWorkersLoading] = useState(false);

  // --- Clés de sauvegarde planning ---
  // Shared => visible côté עובדים (WorkerDashboard / History)
  // DirectorOnly => brouillon visible uniquement côté directeur
  const isoPlanKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const planKeyShared = (siteId: string | number, start: Date) => `plan_${siteId}_${isoPlanKey(start)}`;
  const planKeyDirectorOnly = (siteId: string | number, start: Date) => `plan_director_${siteId}_${isoPlanKey(start)}`;
  const multiSiteMemoryPrefix = "multi_site_generated_";
  const multiSiteMemoryKey = (start: Date) => `${multiSiteMemoryPrefix}${isoPlanKey(start)}`;
  const multiSiteGenerationPrefix = "multi_site_generating_";
  const multiSiteGenerationKey = (start: Date) => `${multiSiteGenerationPrefix}${isoPlanKey(start)}`;
  const multiSiteAssignmentFiltersPrefix = "multi_site_assignment_filters_";
  const multiSiteAssignmentFiltersKey = (start: Date) => `${multiSiteAssignmentFiltersPrefix}${isoPlanKey(start)}`;
  const multiSiteSavedEditPrefix = "multi_site_saved_edit_";
  const multiSiteSavedEditKey = (start: Date) => `${multiSiteSavedEditPrefix}${isoPlanKey(start)}`;
  const multiSiteNavigationFlag = "multi_site_navigation_in_app";
  const multiSiteNavigationLogPrefix = "multi_site_navigation_log_";
  const multiSiteNavigationLogKey = (start: Date) => `${multiSiteNavigationLogPrefix}${isoPlanKey(start)}`;
  const multiSiteSiteCachePrefix = "multi_site_site_cache_";
  const multiSiteWorkersCachePrefix = "multi_site_workers_cache_";
  const multiSiteLinkedSitesCachePrefix = "multi_site_linked_sites_cache_";
  const AUTO_WEEKLY_WORKER_CHANGES_KEY = "auto_weekly_worker_changes_v1";
  const [activeSavedPlanKey, setActiveSavedPlanKey] = useState<string | null>(null);
  const multiSitePullsSites = useMemo(() => {
    const currentId = Number(params.id);
    const deduped = new Map<number, LinkedSite>();
    deduped.set(currentId, { id: currentId, name: String(site?.name || "האתר הנוכחי") });
    linkedSites.forEach((linkedSite) => {
      if (!linkedSite || typeof linkedSite.id !== "number") return;
      deduped.set(linkedSite.id, linkedSite);
    });
    return Array.from(deduped.values());
  }, [linkedSites, params.id, site?.name]);
  const multiSitePullsCurrentSiteLabel = useMemo(
    () => multiSitePullsSites.find((linkedSite) => linkedSite.id === Number(params.id))?.name || String(site?.name || "האתר הנוכחי"),
    [multiSitePullsSites, params.id, site?.name],
  );
  const multiSiteOtherSitesLabel = useMemo(
    () => multiSitePullsSites.filter((linkedSite) => linkedSite.id !== Number(params.id)).map((linkedSite) => linkedSite.name).join(", "),
    [multiSitePullsSites, params.id],
  );
  /** Statut persistant du סידור : brouillon directeur vs envoyé aux עובדים (clés DB ou localStorage). */
  const weekPlanSaveBadgeKind = useMemo<null | "director" | "shared">(() => {
    if (editingSaved) return null;
    if (!savedWeekPlan?.assignments) return null;
    const start = new Date(weekStart);
    const ks = planKeyShared(params.id, start);
    const kd = planKeyDirectorOnly(params.id, start);
    const k = activeSavedPlanKey;
    if (k === "db:shared" || k === ks) return "shared";
    if (k === "db:director" || k === kd) return "director";
    return null;
  }, [editingSaved, savedWeekPlan?.assignments, weekStart, params.id, activeSavedPlanKey]);
  const weekPlanSaveBadgeConfig = useMemo<{ label: string; className: string } | null>(() => {
    if (weekPlanSaveBadgeKind === "director") {
      return {
        label: "נשמר (מנהל)",
        className: "inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
      };
    }
    if (weekPlanSaveBadgeKind === "shared") {
      return {
        label: "נשמר ונשלח לעובדים",
        className: "inline-flex items-center rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-xs text-teal-800 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300",
      };
    }
    return null;
  }, [weekPlanSaveBadgeKind]);
  const pullsLimitSelectOptions = useMemo(
    () => ([
      { value: "", label: "ללא" },
      { value: "1", label: "1" },
      { value: "2", label: "2" },
      { value: "3", label: "3" },
      { value: "4", label: "4" },
      { value: "5", label: "5" },
      { value: "6", label: "6" },
      { value: "7", label: "7" },
      { value: "8", label: "8" },
      { value: "9", label: "9" },
      { value: "10", label: "10" },
      { value: "unlimited", label: "מקסימום" },
    ]),
    [],
  );
  const multiSiteActionLabelByType: Record<MultiSitePlanAction, string> = {
    edit: "ערוך",
    delete: "מחק",
    save_director: "שמור",
    save_shared: "שמור ואשלח",
  };

  // --- Pulls ("משיכות") ---
  type PullEntry = {
    before: { name: string; start: string; end: string };
    after: { name: string; start: string; end: string };
    roleName?: string | null; // si roles: les 2 travailleurs doivent partager ce rôle
  };
  const [pullsByHoleKey, setPullsByHoleKey] = useState<Record<string, PullEntry>>({});
  const displayedPullsByHoleKey = useMemo(
    () => (
      isSavedMode && !editingSaved && savedWeekPlan?.pulls && typeof savedWeekPlan.pulls === "object"
        ? (savedWeekPlan.pulls as Record<string, PullEntry>)
        : pullsByHoleKey
    ),
    [isSavedMode, editingSaved, savedWeekPlan, pullsByHoleKey],
  );
  const [pullsModeStationIdx, setPullsModeStationIdx] = useState<number | null>(null);
  const [pullsEditor, setPullsEditor] = useState<null | {
    key: string;
    stationIdx: number;
    dayKey: string;
    shiftName: string;
    required: number;
    beforeOptions: string[]; // liste des travailleurs possibles (case "avant")
    afterOptions: string[]; // liste des travailleurs possibles (case "après")
    beforeName: string;
    afterName: string;
    beforeStart: string;
    beforeEnd: string;
    afterStart: string;
    afterEnd: string;
    shiftStart: string; // Heure de début de la garde (pour min)
    shiftEnd: string; // Heure de fin de la garde (pour max)
    roleName: string | null;
  }>(null);

  // --- Messages optionnels ---
  type OptionalMessage = {
    id: number;
    site_id: number;
    text: string;
    scope: "global" | "week"; // global => toutes les semaines suivantes, week => uniquement cette semaine
    created_week_iso: string; // YYYY-MM-DD
    stopped_week_iso?: string | null; // YYYY-MM-DD (exclusive)
    origin_id?: number | null;
    created_at: number;
    updated_at: number;
  };
  const [messages, setMessages] = useState<OptionalMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isAddMessageOpen, setIsAddMessageOpen] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [newMessageText, setNewMessageText] = useState("");
  const [newMessagePermanent, setNewMessagePermanent] = useState(true);
  const [messageEditorInitialHtml, setMessageEditorInitialHtml] = useState<string>("");
  const [messageTextColor, setMessageTextColor] = useState<string>("#111827");
  const [messageHighlightColor, setMessageHighlightColor] = useState<string>("#fde047");

  function isProbablyHtml(input: string): boolean {
    return /<\/?[a-z][\s\S]*>/i.test(input || "");
  }

  function sanitizeMessageHtml(rawHtml: string): string {
    return DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      ADD_TAGS: ["mark"],
      ADD_ATTR: ["style", "data-color"],
    });
  }

  function escapeHtml(s: string): string {
    return (s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function toEditorHtml(raw: string): string {
    const s = String(raw || "");
    if (isProbablyHtml(s)) return s;
    const escaped = escapeHtml(s).replace(/\n/g, "<br/>");
    return `<p>${escaped || "<br/>"}</p>`;
  }

  function isoYMD(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function closeMessageModal() {
    setIsAddMessageOpen(false);
    setEditingMessageId(null);
    setNewMessageText("");
    setNewMessagePermanent(true);
    setMessageEditorInitialHtml("");
  }

  const messageEditor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      TextStyle,
      Color,
      Underline,
      Link.configure({ openOnClick: true }),
      Highlight.configure({ multicolor: true }),
    ],
    content: messageEditorInitialHtml || "<p><br/></p>",
    editorProps: {
      attributes: {
        class:
          "tiptap-editor min-h-32 rounded-b-md bg-white px-3 py-2 text-sm outline-none dark:bg-zinc-900",
        dir: "rtl",
      },
    },
    onUpdate: ({ editor }) => {
      setNewMessageText(editor.getHTML());
    },
  });

  useEffect(() => {
    if (!isAddMessageOpen) return;
    if (!messageEditor) return;
    try {
      messageEditor.commands.setContent(messageEditorInitialHtml || "<p><br/></p>", { emitUpdate: false });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAddMessageOpen, messageEditorInitialHtml, messageEditor]);

  async function refreshMessages() {
    const siteId = Number(params.id);
    if (!siteId) return;
    const wk = isoYMD(weekStart);
    try {
      setMessagesLoading(true);
      const res = await apiFetch<OptionalMessage[]>(`/director/sites/${siteId}/messages?week=${encodeURIComponent(wk)}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
      });
      setMessages(Array.isArray(res) ? sortMessagesChronologically(res) : []);
    } catch {
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  }

  function sortMessagesChronologically(list: OptionalMessage[]) {
    return [...list].sort((a, b) => {
      const createdAtDiff = Number(a?.created_at || 0) - Number(b?.created_at || 0);
      if (createdAtDiff !== 0) return createdAtDiff;
      return Number(a?.id || 0) - Number(b?.id || 0);
    });
  }

  useEffect(() => {
    const siteId = Number(params.id);
    if (!siteId) return;
    const wk = isoYMD(weekStart);
    let alive = true;
    (async () => {
      try {
        setMessagesLoading(true);
        const res = await apiFetch<OptionalMessage[]>(`/director/sites/${siteId}/messages?week=${encodeURIComponent(wk)}`, {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        });
        if (!alive) return;
        setMessages(Array.isArray(res) ? sortMessagesChronologically(res) : []);
      } catch {
        if (!alive) return;
        setMessages([]);
      } finally {
        if (!alive) return;
        setMessagesLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [params.id, weekStart]);

  const visibleMessages = useMemo(() => messages, [messages]);
  const planningDayKeys = useMemo(() => ["sun","mon","tue","wed","thu","fri","sat"] as const, []);
  const planningShiftNames = useMemo(
    () => Array.from(
      new Set(
        ((site?.config?.stations || []) as any[])
          .flatMap((st: any) => (st?.shifts || []).filter((sh: any) => sh?.enabled).map((sh: any) => sh?.name))
          .filter(Boolean),
      ),
    ),
    [site?.config?.stations],
  );
  const planningStationNames = useMemo(
    () => (site?.config?.stations || []).map((st: any, i: number) => st?.name || `עמדה ${i+1}`),
    [site?.config?.stations],
  );

  // Mode manuel (drag & drop)
  const [isManual, setIsManual] = useState(false);
  type AssignmentsMap = PlanningAssignmentsMap;
  const [manualAssignments, setManualAssignments] = useState<AssignmentsMap | null>(null);
  const capturePendingManualFixedAssignments = useCallback(() => {
    const current = manualAssignments as PlanningAssignmentsMap | null;
    const baseline = manualModeBaseAssignmentsRef.current;
    const next = baseline
      ? buildChangedNonEmptyPlanningAssignmentsSnapshot(current, baseline)
      : buildNonEmptyPlanningAssignmentsSnapshot(current);
    pendingManualFixedAssignmentsRef.current = next;
    return next;
  }, [manualAssignments]);
  // Role hints per slot in manual mode (preserved from auto)
  type RoleHintsMap = Record<string, Record<string, (string | null)[][]>>;
  const [manualRoleHints, setManualRoleHints] = useState<RoleHintsMap | null>(null);
  const hasAiPlan = !!aiPlan;
  const isAnyGenerationRunning = aiLoading || sharedGenerationRunning;
  const aiAssignmentsVariants = useMemo(() => {
    if (!aiPlan) return [] as Record<string, Record<string, string[][]>>[];
    // Toujours préférer la grille courante de aiPlan (ex. après ידני→אוטומטי « שמור מיקומים ») :
    // baseAssignmentsRef peut rester celui d’une יצירת תכנון antérieure et écraser l’affichage / le fixed.
    const base = aiPlan.assignments || baseAssignmentsRef.current;
    if (!base) return [] as Record<string, Record<string, string[][]>>[];
    return [base, ...((aiPlan.alternatives || []).filter(Boolean) as Record<string, Record<string, string[][]>>[])];
  }, [aiPlan]);
  const assignmentCountFilters = useMemo(
    () => sharedAssignmentCountFilters[String(params.id)] || {},
    [sharedAssignmentCountFilters, params.id],
  );
  const activeAssignmentCountFilters = useMemo(
    () =>
      Object.entries(sharedAssignmentCountFilters).flatMap(([siteId, siteFilters]) => {
        if (!siteFilters || typeof siteFilters !== "object") return [];
        return Object.entries(siteFilters).flatMap(([workerName, rawValue]) => {
          const trimmed = String(rawValue || "").trim();
          if (!trimmed) return [];
          const num = Number(trimmed);
          if (!Number.isFinite(num) || num < 0) return [];
          return [[siteId, workerName, Math.floor(num)] as [string, string, number]];
        });
      }),
    [sharedAssignmentCountFilters],
  );
  const aiVariantCounts = useMemo(
    () => aiAssignmentsVariants.map((assignments) => countAssignmentsByWorker(assignments, workers)),
    [aiAssignmentsVariants, workers],
  );
  const filteredAiPlanIndices = useMemo(() => {
    if (!aiVariantCounts.length) return [] as number[];
    if (activeAssignmentCountFilters.length === 0) return aiVariantCounts.map((_, idx) => idx);
    const linkedMemory = readLinkedPlansFromMemory(weekStart);
    const countsCache = new Map<string, Map<string, number>>();
    const getCountsForSite = (siteId: string, idx: number) => {
      const cacheKey = `${siteId}:${idx}`;
      if (countsCache.has(cacheKey)) return countsCache.get(cacheKey) || null;
      let counts: Map<string, number> | null = null;
      if (siteId === String(params.id)) {
        counts = aiVariantCounts[idx] || new Map<string, number>();
      } else {
        const sitePlan = linkedMemory?.plansBySite?.[siteId];
        if (sitePlan) counts = countAssignmentsByWorker(resolveAssignmentsForAlternative(sitePlan, idx), []);
      }
      if (counts) countsCache.set(cacheKey, counts);
      return counts;
    };
    return aiVariantCounts.reduce((acc, counts, idx) => {
      if (activeAssignmentCountFilters.every(([siteId, workerName, target]) => {
        const targetCounts = siteId === String(params.id) ? counts : getCountsForSite(siteId, idx);
        return !!targetCounts && (targetCounts.get(workerName) || 0) === target;
      })) {
        acc.push(idx);
      }
      return acc;
    }, [] as number[]);
  }, [aiVariantCounts, activeAssignmentCountFilters, weekStart, params.id]);
  const generatedAssignmentCountOptionsByWorker = useMemo(() => {
    const byWorker = new Map<string, Set<number>>();
    const linkedMemory = readLinkedPlansFromMemory(weekStart);
    const countsCache = new Map<string, Map<string, number>>();
    const getCountsForSite = (siteId: string, idx: number) => {
      const cacheKey = `${siteId}:${idx}`;
      if (countsCache.has(cacheKey)) return countsCache.get(cacheKey) || null;
      let counts: Map<string, number> | null = null;
      if (siteId === String(params.id)) {
        counts = aiVariantCounts[idx] || new Map<string, number>();
      } else {
        const sitePlan = linkedMemory?.plansBySite?.[siteId];
        if (sitePlan) counts = countAssignmentsByWorker(resolveAssignmentsForAlternative(sitePlan, idx), []);
      }
      if (counts) countsCache.set(cacheKey, counts);
      return counts;
    };
    workers.forEach((w) => {
      const values = new Set<number>();
      aiVariantCounts.forEach((counts, idx) => {
        const matchesOtherFilters = activeAssignmentCountFilters.every(([siteId, workerName, target]) => {
          if (siteId === String(params.id) && workerName === w.name) return true;
          const targetCounts = siteId === String(params.id) ? counts : getCountsForSite(siteId, idx);
          return !!targetCounts && (targetCounts.get(workerName) || 0) === target;
        });
        if (matchesOtherFilters) {
          values.add(counts.get(w.name) || 0);
        }
      });
      byWorker.set(w.name, values);
    });
    return new Map<string, number[]>(
      Array.from(byWorker.entries()).map(([workerName, values]) => [
        workerName,
        Array.from(values).sort((a, b) => a - b),
      ]),
    );
  }, [aiVariantCounts, activeAssignmentCountFilters, workers, weekStart, params.id]);
  const hasActiveAssignmentCountFilters = activeAssignmentCountFilters.length > 0;
  const filteredAiPlanPosition = filteredAiPlanIndices.indexOf(altIndex);
  const displayedAlternativeState = useMemo(() => {
    const total = filteredAiPlanIndices.length;
    const totalAll = aiAssignmentsVariants.length;
    if (preserveLinkedAltSelection && linkedSites.length > 1 && totalAll > 0 && filteredAiPlanPosition < 0) {
      const rawIndex = Math.min(Math.max(0, Number(altIndex || 0)), Math.max(0, totalAll - 1));
      return {
        label: `${rawIndex + 1}/${totalAll}`,
        currentIndex: rawIndex,
        total: totalAll,
        useRawNavigation: true,
      };
    }
    const displayTotal = total > 0 ? total : totalAll;
    if (displayTotal <= 0) {
      return {
        label: null,
        currentIndex: -1,
        total: 0,
        useRawNavigation: false,
      };
    }
    const currentVisibleIndex = filteredAiPlanPosition;
    return {
      label: `${currentVisibleIndex >= 0 ? currentVisibleIndex + 1 : 0}/${displayTotal}`,
      currentIndex: currentVisibleIndex,
      total: displayTotal,
      useRawNavigation: false,
    };
  }, [filteredAiPlanIndices.length, aiAssignmentsVariants.length, filteredAiPlanPosition, preserveLinkedAltSelection, linkedSites.length, altIndex]);
  const displayedAlternativeLabel = displayedAlternativeState.label;
  useEffect(() => {
    if (isManual || !aiPlan) return;
    if (filteredAiPlanIndices.length === 0) return;
    if (preserveLinkedAltSelection && linkedSites.length > 1 && !filteredAiPlanIndices.includes(altIndex)) return;
    if (filteredAiPlanIndices.includes(altIndex)) return;
    const next = filteredAiPlanIndices[0];
    if (next === altIndex) return;
    selectAiPlanIndex(next);
  }, [isManual, aiPlan, altIndex, filteredAiPlanIndices, preserveLinkedAltSelection, linkedSites.length]);
    // Mode switch confirmation dialog
    const [showModeSwitchDialog, setShowModeSwitchDialog] = useState(false);
    const [modeSwitchTarget, setModeSwitchTarget] = useState<"auto" | "manual" | null>(null);
  // Dialogue de génération (grille non vide)
  const [showGenDialog, setShowGenDialog] = useState(false);
  const [genUseFixed, setGenUseFixed] = useState(false);
  const genUseFixedRef = useRef(false);
  const manualModeBaseAssignmentsRef = useRef<PlanningAssignmentsMap | null>(null);
  const pendingManualFixedAssignmentsRef = useRef<PlanningAssignmentsMap | null>(null);
  useEffect(() => { genUseFixedRef.current = genUseFixed; }, [genUseFixed]);
  // Bypass re-opening the generation dialog after user already chose an action
  const genDialogBypassRef = useRef<"fixed" | "reset" | null>(null);
  const [genExcludeDays, setGenExcludeDays] = useState<string[] | null>(null);
  const [showPastDaysDialog, setShowPastDaysDialog] = useState(false);
  const [pendingExcludeDays, setPendingExcludeDays] = useState<string[] | null>(null);
  const pendingLinkedAvailabilitySaveRef = useRef<null | ((propagate: boolean) => Promise<void>)>(null);
  const [linkedAvailabilityConfirmSites, setLinkedAvailabilityConfirmSites] = useState<string[] | null>(null);
  // Surcouche d'affichage de זמינות ajoutée par drop manuel (mise en rouge)
  const [availabilityOverlays, setAvailabilityOverlays] = useState<Record<string, Record<string, string[]>>>({});
  // Weekly per-worker availability overrides (per week, per site). Keys by worker name.
  const [weeklyAvailability, setWeeklyAvailability] = useState<Record<string, WorkerAvailability>>({});
  const [weeklyAvailabilityLoading, setWeeklyAvailabilityLoading] = useState(false);
  const isRefreshingWeekData = workersLoading || weeklyAvailabilityLoading || savedPlanLoading || messagesLoading;

  // Helpers to compute week key and persist weekly availability in localStorage
  function weekKeyOf(date: Date): string {
    const d = new Date(date);
    const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`;
    const wk = new Date(d);
    wk.setDate(d.getDate() - d.getDay()); // Sunday
    return `avail_${params.id}_${iso(wk)}`;
  }
  function readWeeklyAvailabilityFor(date: Date): Record<string, WorkerAvailability> {
    try {
      if (typeof window === "undefined") return {};
      const raw = localStorage.getItem(weekKeyOf(date));
      if (!raw) return {};
      const parsed = JSON.parse(raw || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  function loadWeeklyAvailability() {
    (async () => {
      try {
        setWeeklyAvailabilityLoading(true);
        if (typeof window === "undefined") return;
        const wk = getWeekKeyISO(weekStart);
        const fromApi = await apiFetch<Record<string, WorkerAvailability>>(
          `/director/sites/${params.id}/weekly-availability?week=${encodeURIComponent(wk)}`,
          {
            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
            cache: "no-store" as any,
          },
        );
        const normalized = (fromApi && typeof fromApi === "object") ? fromApi : {};
        setWeeklyAvailability(normalized);
        try {
          localStorage.setItem(weekKeyOf(weekStart), JSON.stringify(normalized));
        } catch {}
      } catch {
        // Fallback: localStorage (par appareil)
        setWeeklyAvailability(readWeeklyAvailabilityFor(weekStart));
      } finally {
        setWeeklyAvailabilityLoading(false);
      }
    })();
  }
  async function saveWeeklyAvailability(next: Record<string, WorkerAvailability>) {
    // optimistic UI + fallback local
    setWeeklyAvailability(next);
    try {
      localStorage.setItem(weekKeyOf(weekStart), JSON.stringify(next));
    } catch {}
    // persist to DB (shared across devices)
    try {
      if (typeof window === "undefined") return;
      const wk = getWeekKeyISO(weekStart);
      await apiFetch<Record<string, WorkerAvailability>>(`/director/sites/${params.id}/weekly-availability`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        body: JSON.stringify({ week_iso: wk, availability: next }),
      });
    } catch {}
  }

  // Build the availability to send to backend: weekly overrides merged with red overlays
  function buildWeeklyAvailabilityForRequest(): Record<string, WorkerAvailability> {
    const out: Record<string, WorkerAvailability> = {};
    // Nettoyer weeklyAvailability pour s'assurer qu'il n'y a pas de structure imbriquée incorrecte
    Object.keys(weeklyAvailability || {}).forEach((workerName) => {
      const wa = weeklyAvailability[workerName];
      // Si wa a une propriété "availability", c'est une structure incorrecte - extraire directement
      if (wa && typeof wa === 'object' && 'availability' in wa && !('sun' in wa)) {
        // Structure incorrecte: {availability: {...}}, extraire directement
        out[workerName] = (wa as any).availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };
      } else {
        // Structure correcte: {sun: [...], mon: [...], ...}
        out[workerName] = wa || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };
      }
    });
    
    const ensureDays = (wa: WorkerAvailability): WorkerAvailability => ({
      sun: Array.isArray(wa.sun) ? wa.sun : [],
      mon: Array.isArray(wa.mon) ? wa.mon : [],
      tue: Array.isArray(wa.tue) ? wa.tue : [],
      wed: Array.isArray(wa.wed) ? wa.wed : [],
      thu: Array.isArray(wa.thu) ? wa.thu : [],
      fri: Array.isArray(wa.fri) ? wa.fri : [],
      sat: Array.isArray(wa.sat) ? wa.sat : [],
    });
    
    // Nettoyer chaque entrée pour s'assurer qu'elle a la bonne structure
    Object.keys(out).forEach((name) => {
      out[name] = ensureDays(out[name]);
    });
    
    // Ajouter les overlays (disponibilités rouges)
    Object.keys(availabilityOverlays || {}).forEach((name) => {
      const perDay = (availabilityOverlays[name] || {}) as Record<string, string[]>;
      const base = ensureDays(out[name] || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });
      Object.keys(perDay).forEach((dayKey) => {
        if (Array.isArray(perDay[dayKey])) {
          const list = new Set<string>(base[dayKey as keyof WorkerAvailability] || []);
          perDay[dayKey].forEach((sn) => {
            if (sn) list.add(sn);
          });
          (base as any)[dayKey] = Array.from(list);
        }
      });
      out[name] = base;
    });
    return out;
  }

  useEffect(() => {
    loadWeeklyAvailability();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, params.id]);
  const [hoverSlotKey, setHoverSlotKey] = useState<string | null>(null);
  const [expandedSlotKey, setExpandedSlotKey] = useState<string | null>(null);
  const [draggingWorkerName, setDraggingWorkerName] = useState<string | null>(null);
  const lastDropRef = useRef<{ key: string; ts: number } | null>(null);
  const lastConflictConfirmRef = useRef<{ key: string; ts: number } | null>(null);
  const dragSourceRef = useRef<{
    dayKey: string;
    shiftName: string;
    stationIndex: number;
    slotIndex: number;
    workerName: string;
  } | null>(null);
  const didDropRef = useRef(false);
  const isPhoneWidth = () =>
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia("(max-width: 767px)").matches;

  const expandedKeyFor = (
    dayKey: string,
    shiftName: string,
    stationIndex: number,
    slotIndex: number,
    token: string,
  ) => `${dayKey}|${shiftName}|${stationIndex}|${slotIndex}|${token}`;

  // Helpers: day order and shift kind
  const dayOrder = ["sun","mon","tue","wed","thu","fri","sat"] as const;
  const prevDayKeyOf = (key: string) => dayOrder[(dayOrder.indexOf(key as any) + 6) % 7];
  const nextDayKeyOf = (key: string) => dayOrder[(dayOrder.indexOf(key as any) + 1) % 7];
  const isRtlName = (s: string) => /[\u0590-\u05FF]/.test(String(s || "")); // hébreu
  function detectShiftKind(sn: string): "morning" | "noon" | "night" | "other" {
    const s = String(sn || "");
    if (/בוקר|^0?6|06-14/i.test(s)) return "morning";
    if (/צהר(יים|י)ם?|14-22|^1?4/i.test(s)) return "noon";
    if (/לילה|22-06|^2?2|night/i.test(s)) return "night";
    return "other";
  }

  // Worker role check usable outside of render helpers
  const normLocal = (n: string) => (n || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  function workerHasRole(workerName: string, roleName: string): boolean {
    const w = workers.find((x) => (x.name || "").trim() === (workerName || "").trim());
    if (!w) return false;
    const target = normLocal(roleName);
    return (w.roles || []).some((r) => normLocal(String(r)) === target);
  }

  // Ordre d'affichage pour זמינות: matin → midi → nuit → autres
  function displayShiftOrderIndex(sn: string): number {
    const s = String(sn || "");
    if (/בוקר|^0?6|06-14/i.test(s)) return 0; // morning
    if (/צהר(יים|י)ם?|14-22|^1?4/i.test(s)) return 1; // noon
    if (/לילה|22-06|^2?2|night/i.test(s)) return 2; // night
    return 3; // others
  }

  function findWorkerByName(workerName: string) {
    const trimmed = (workerName || "").trim();
    const list = (savedWeekPlan?.workers || []).length
      ? (savedWeekPlan!.workers as any[]).map((rw: any) => {
          // Utiliser le maxShifts de l'état workers (mis à jour toutes les 10 secondes) au lieu de celui sauvegardé
          const currentWorker = workers.find((w) => w.name === rw.name);
          const currentMaxShifts = currentWorker?.maxShifts ?? rw.max_shifts ?? rw.maxShifts ?? 0;
          return {
            id: rw.id,
            name: rw.name,
            maxShifts: currentMaxShifts,
            roles: Array.isArray(rw.roles) ? rw.roles : [],
            availability: rw.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
          };
        })
      : workers;
    return list.find((w) => (w.name || "").trim() === trimmed);
  }

  function isWorkerAvailableForSlot(workerName: string, dayKey: string, shiftName: string): boolean {
    const trimmed = (workerName || "").trim();
    if (!trimmed) return false;
    const w = findWorkerByName(trimmed);
    // Effective availability: weekly override first, else worker base availability
    const effAvail = (() => {
      const wk = (weeklyAvailability as any)?.[trimmed] || null;
      if (wk && typeof wk === "object") {
        // Handle both shapes: {sun:...} and {availability:{sun:...}}
        if ("sun" in wk || "mon" in wk || "tue" in wk || "wed" in wk || "thu" in wk || "fri" in wk || "sat" in wk) {
          return wk as Record<string, string[]>;
        }
        if ("availability" in wk && wk.availability && typeof wk.availability === "object") {
          return wk.availability as Record<string, string[]>;
        }
      }
      return (w?.availability || {}) as Record<string, string[]>;
    })();

    const dayList = (Array.isArray((effAvail as any)?.[dayKey]) ? (effAvail as any)[dayKey] : []) as string[];
    if (dayList.includes(shiftName)) return true;

    const targetKind = detectShiftKind(shiftName);
    if (targetKind === "other") return false;
    return dayList.some((sn) => detectShiftKind(String(sn || "")) === targetKind);
  }

  function hasWorkerAssignmentOnOtherLinkedSite(
    workerName: string,
    dayKey: string,
    shiftName: string,
    mode: "same" | "kind" = "kind",
  ): boolean {
    const trimmed = (workerName || "").trim();
    if (!trimmed) return false;
    const worker = workers.find((w) => (w.name || "").trim() === trimmed) as Worker | undefined;
    const linkedSiteIds = Array.isArray(worker?.linkedSiteIds)
      ? (worker.linkedSiteIds as number[]).map((id: number) => Number(id)).filter(Number.isFinite)
      : [];
    if (linkedSiteIds.length <= 1) return false;
    const linkedMemory = readLinkedPlansFromMemory(weekStart);
    const activeAltIndex = Number(linkedMemory?.activeAltIndex || 0);
    const targetKind = detectShiftKind(shiftName);
    for (const linkedSiteId of linkedSiteIds) {
      if (String(linkedSiteId) === String(params.id)) continue;
      const plan = linkedMemory?.plansBySite?.[String(linkedSiteId)];
      const assignments = plan ? resolveAssignmentsForAlternative(plan, activeAltIndex) : null;
      const shiftsMap = assignments?.[dayKey] || {};
      for (const candidateShiftName of Object.keys(shiftsMap)) {
        const matches =
          mode === "same"
            ? candidateShiftName === shiftName
            : (
                targetKind === "other"
                  ? candidateShiftName === shiftName
                  : detectShiftKind(candidateShiftName) === targetKind
              );
        if (!matches) continue;
        const perStation = (shiftsMap as Record<string, string[][]>)[candidateShiftName] || [];
        if (perStation.some((namesHere) => (namesHere || []).some((nm) => (nm || "").trim() === trimmed))) {
          return true;
        }
      }
    }
    return false;
  }

  function getLinkedSiteConflictReason(workerName: string, dayKey: string, shiftName: string): string | null {
    const trimmed = (workerName || "").trim();
    if (!trimmed) return null;
    if (hasWorkerAssignmentOnOtherLinkedSite(trimmed, dayKey, shiftName, "kind")) {
      return "העובד כבר משובץ במשמרת חופפת באתר מקושר.";
    }
    const kind = detectShiftKind(shiftName);
    if (kind === "morning" && hasWorkerAssignmentOnOtherLinkedSite(trimmed, prevDayKeyOf(dayKey), "night", "kind")) {
      return "העובד כבר משובץ בלילה קודם באתר מקושר.";
    }
    if (kind === "noon" && hasWorkerAssignmentOnOtherLinkedSite(trimmed, dayKey, "morning", "kind")) {
      return "העובד כבר משובץ בבוקר באותו יום באתר מקושר.";
    }
    if (kind === "night" && hasWorkerAssignmentOnOtherLinkedSite(trimmed, dayKey, "noon", "kind")) {
      return "העובד כבר משובץ בצהריים באותו יום באתר מקושר.";
    }
    if (kind === "night" && hasWorkerAssignmentOnOtherLinkedSite(trimmed, nextDayKeyOf(dayKey), "morning", "kind")) {
      return "העובד כבר משובץ בבוקר שלמחרת באתר מקושר.";
    }
    return null;
  }

  function canHighlightDropTarget(
    workerName: string,
    dayKey: string,
    shiftName: string,
    stationIndex: number,
    roleHint?: string | null
  ): boolean {
    const trimmed = (workerName || "").trim();
    if (!trimmed) return false;
    if (!isWorkerAvailableForSlot(trimmed, dayKey, shiftName)) return false;
    if (roleHint && !workerHasRole(trimmed, roleHint)) return false;
    if (getLinkedSiteConflictReason(trimmed, dayKey, shiftName)) return false;

    // same day+shift elsewhere
    try {
      const perStationSame: string[][] = (((manualAssignments as any)?.[dayKey]?.[shiftName] || []) as any) || [];
      let existsElsewhere = false;
      perStationSame.forEach((namesArr: string[], sIdx: number) => {
        if (sIdx === stationIndex) return;
        if ((namesArr || []).some((nm) => (nm || "").trim() === trimmed)) existsElsewhere = true;
      });
      if (existsElsewhere) return false;
    } catch {}

    // night limit (max 3 per week)
    try {
      const isNightTarget = detectShiftKind(shiftName) === "night";
      if (isNightTarget) {
        let nightCount = 0;
        const dayKeysAll = Object.keys(manualAssignments || {});
        for (const dKey of dayKeysAll) {
          const shiftsMap = (manualAssignments as any)?.[dKey] || {};
          for (const sn of Object.keys(shiftsMap)) {
            if (detectShiftKind(sn) !== "night") continue;
            const perStation: string[][] = shiftsMap[sn] || [];
            for (const namesHere of perStation) if ((namesHere || []).some((nm) => (nm || "").trim() === trimmed)) nightCount++;
          }
        }
        // Would become +1 night if dropped here
        if (nightCount + 1 > 3) return false;
      }
    } catch {}

    // adjacent shifts rule (including day boundary)
    try {
      const kind = detectShiftKind(shiftName);
      const hasInShift = (dKey: string, kindWanted: "morning" | "noon" | "night") => {
        const shiftsMap = (manualAssignments as any)?.[dKey] || {};
        const sn = Object.keys(shiftsMap).find((x) => detectShiftKind(x) === kindWanted);
        if (!sn) return false;
        const perStation: string[][] = shiftsMap[sn] || [];
        return perStation.some((arr: string[]) => (arr || []).some((nm) => (nm || "").trim() === trimmed));
      };
      const prevCheck = () => {
        if (kind === "morning") return hasInShift(prevDayKeyOf(dayKey), "night");
        if (kind === "noon") return hasInShift(dayKey, "morning");
        if (kind === "night") return hasInShift(dayKey, "noon");
        return false;
      };
      const nextCheck = () => {
        if (kind === "morning") return hasInShift(dayKey, "noon");
        if (kind === "noon") return hasInShift(dayKey, "night");
        if (kind === "night") return hasInShift(nextDayKeyOf(dayKey), "morning");
        return false;
      };
      if (prevCheck() || nextCheck()) return false;
    } catch {}

    return true;
  }

  function ensureOverlay(name: string, dayKey: string, shiftName: string) {
    setAvailabilityOverlays((prev) => {
      const next = { ...prev } as any;
      const nm = (name || "").trim();
      next[nm] = next[nm] || {};
      const cur: string[] = Array.from((next[nm][dayKey] || []));
      if (!cur.includes(shiftName)) cur.push(shiftName);
      next[nm][dayKey] = cur;
      return next;
    });
  }

  function onWorkerDragStart(e: React.DragEvent, workerName: string) {
    didDropRef.current = false;
    dragSourceRef.current = null;
    // Detect if drag starts from an already-assigned chip (grid slot)
    const isFromSlot = (() => {
      try {
        const el = e.currentTarget as HTMLElement | null;
        const dayKey = el?.getAttribute?.("data-dkey") || "";
        const shiftName = el?.getAttribute?.("data-sname") || "";
        const stationIndex = Number(el?.getAttribute?.("data-stidx") || NaN);
        const slotIndex = Number(el?.getAttribute?.("data-slotidx") || NaN);
        return !!(dayKey && shiftName && Number.isFinite(stationIndex) && Number.isFinite(slotIndex));
      } catch {
        return false;
      }
    })();
    try {
      e.dataTransfer.setData("text/plain", workerName);
      // If dragging from a slot in manual mode, treat it as a MOVE; otherwise keep COPY.
      e.dataTransfer.effectAllowed = (isManual && isFromSlot) ? "move" : "copy";
    } catch {}
    // If drag starts from an existing assigned chip, remember its origin (for mobile "drag out = delete")
    try {
      const el = e.currentTarget as HTMLElement | null;
      const dayKey = el?.getAttribute?.("data-dkey") || "";
      const shiftName = el?.getAttribute?.("data-sname") || "";
      const stationIndex = Number(el?.getAttribute?.("data-stidx") || NaN);
      const slotIndex = Number(el?.getAttribute?.("data-slotidx") || NaN);
      const nm = (workerName || "").trim();
      if (dayKey && shiftName && Number.isFinite(stationIndex) && Number.isFinite(slotIndex) && nm) {
        dragSourceRef.current = { dayKey, shiftName, stationIndex, slotIndex, workerName: nm };
      }
    } catch {}
    setDraggingWorkerName((workerName || "").trim() || null);
  }

  function onWorkerDragEnd() {
    // Mobile manual mode: if you dragged an already-assigned worker and didn't drop into any slot => delete it
    const src = dragSourceRef.current;
    const shouldDelete = isManual && isPhoneWidth() && !!src && !didDropRef.current;
    const nm = (src?.workerName || draggingWorkerName || "").trim();
    setDraggingWorkerName(null);
    dragSourceRef.current = null;
    didDropRef.current = false;
    if (!shouldDelete || !src || !nm) return;

    setManualAssignments((prev) => {
      if (!prev) return prev;
      const base = JSON.parse(JSON.stringify(prev));
      const arr: string[] = base[src.dayKey]?.[src.shiftName]?.[src.stationIndex] || [];
      base[src.dayKey] = base[src.dayKey] || {};
      base[src.dayKey][src.shiftName] = base[src.dayKey][src.shiftName] || [];
      // Remove only the dragged slot and KEEP slot order (do not compact).
      const nextArr = Array.from(arr as string[]);
      while (nextArr.length <= src.slotIndex) nextArr.push("");
      nextArr[src.slotIndex] = "";
      base[src.dayKey][src.shiftName][src.stationIndex] = nextArr;

      // If a red availability overlay was added for this name/day/shift and this was the last occurrence, remove it too
      try {
        const nameTrimmed = nm;
        const stillThere = (base?.[src.dayKey]?.[src.shiftName] || []).some(
          (cell: string[]) => Array.isArray(cell) && cell.some((x) => (x || "").trim() === nameTrimmed),
        );
        if (!stillThere) {
          setAvailabilityOverlays((prevOv) => {
            const next: any = { ...prevOv };
            if (next?.[nameTrimmed]?.[src.dayKey]) {
              const list: string[] = Array.from(next[nameTrimmed][src.dayKey] || []);
              const filtered = list.filter((s) => s !== src.shiftName);
              if (filtered.length > 0) {
                next[nameTrimmed][src.dayKey] = filtered;
              } else {
                delete next[nameTrimmed][src.dayKey];
                if (Object.keys(next[nameTrimmed] || {}).length === 0) delete next[nameTrimmed];
              }
            }
            return next;
          });
        }
      } catch {}

      return base;
    });
  }

  // Slot-level DnD only in manual mode; no cell-level drop
  function onSlotDragOver(e: React.DragEvent) {
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "copy"; } catch {}
  }

  function dropIntoSlot(
    dayKey: string,
    shiftName: string,
    stationIndex: number,
    slotIndex: number,
    workerName: string,
    expectedRoleFromUI?: string | null,
    prechecked?: boolean
  ) {
    const trimmed = (workerName || "").trim();
    if (!trimmed) return;
    const linkedSiteConflictReason = getLinkedSiteConflictReason(trimmed, dayKey, shiftName);
    if (linkedSiteConflictReason) {
      toast.error("לא ניתן לשבץ", { description: linkedSiteConflictReason });
      return;
    }
    const dragSrc = dragSourceRef.current;
    const isMoveFromSlot = !!(isManual && dragSrc && (dragSrc.workerName || "").trim() === trimmed);
    // Vérification de la זמינות: si non demandée, demander confirmation et, si oui, ajouter un overlay rouge
    const w = findWorkerByName(trimmed);
    // Effective availability: weekly override first, else worker base availability
    const effAvail = (() => {
      const wk = (weeklyAvailability[trimmed] || null) as any;
      if (wk && typeof wk === "object") return wk as Record<string, string[]>;
      return (w?.availability || {}) as Record<string, string[]>;
    })();
    // Accept equivalent shift names by kind (morning/noon/night)
    const isMorning = (n?: string) => !!n && (/בוקר/.test(n) || /^0?6/.test(n) || /06-14/i.test(n));
    const isNoon = (n?: string) => !!n && (/צהר/.test(n) || /^1?4/.test(n) || /14-22/i.test(n));
    const isNight = (n?: string) => !!n && (/לילה/.test(n) || /night/i.test(n) || /^2?2/.test(n) || /22-06/i.test(n));
    const matchesShift = (target: string, list: string[]) => {
      if (list.includes(target)) return true;
      if (isMorning(target) && list.some(isMorning)) return true;
      if (isNoon(target) && list.some(isNoon)) return true;
      if (isNight(target) && list.some(isNight)) return true;
      return false;
    };
    const dayList = (effAvail?.[dayKey] || []) as string[];
    const allowed = matchesShift(shiftName, dayList);
    if (!allowed) {
      const ok = typeof window !== "undefined" && window.confirm && window.confirm(`לעובד "${trimmed}" אין זמינות למשמרת זו. להקצות בכל זאת?`);
      if (!ok) return;
      ensureOverlay(trimmed, dayKey, shiftName);
    }
    setManualAssignments((prev) => {
      const stationsCount = (site?.config?.stations || []).length || 0;
      const ensureBase = (base?: AssignmentsMap | null): AssignmentsMap => {
        const next: AssignmentsMap = base ? JSON.parse(JSON.stringify(base)) : ({} as any);
        if (!next[dayKey]) next[dayKey] = {} as any;
        if (!next[dayKey][shiftName]) next[dayKey][shiftName] = Array.from({ length: stationsCount }, () => []);
        if ((next[dayKey][shiftName] as any[]).length !== stationsCount) {
          next[dayKey][shiftName] = Array.from({ length: stationsCount }, (_, i) => (next[dayKey][shiftName][i] || []));
        }
        return next;
      };
      const base = ensureBase(prev);
      const beforeArr: string[] = Array.from(base[dayKey][shiftName][stationIndex] || []);

      // --- role context (station requirements and hints) ---
      const stCfg = (site?.config?.stations || [])[stationIndex] || null;
      const roleReq: Record<string, number> = (() => {
        const out: Record<string, number> = {};
        if (!stCfg) return out;
        const push = (name?: string, count?: number, enabled?: boolean) => {
          const rn = (name || "").trim();
          const c = Number(count || 0);
          if (!rn || !enabled || c <= 0) return; out[rn] = (out[rn] || 0) + c;
        };
        if (stCfg.perDayCustom) {
          const dcfg = stCfg.dayOverrides?.[dayKey];
          if (!dcfg || dcfg.active === false) return out;
          if (stCfg.uniformRoles) {
            for (const r of (stCfg.roles || [])) push(r?.name, r?.count, r?.enabled);
          } else {
            const sh = (dcfg.shifts || []).find((x: any) => x?.name === shiftName);
            for (const r of ((sh?.roles as any[]) || [])) push(r?.name, r?.count, r?.enabled);
          }
          return out;
        }
        if (stCfg.uniformRoles) {
          for (const r of (stCfg.roles || [])) push(r?.name, r?.count, r?.enabled);
        } else {
          const sh = (stCfg.shifts || []).find((x: any) => x?.name === shiftName);
          for (const r of ((sh?.roles as any[]) || [])) push(r?.name, r?.count, r?.enabled);
        }
        return out;
      })();
      const norm = (n: string) => (n || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
      const findAssignedRole = (nm: string): string | null => {
        const w = workers.find((x) => (x.name || "").trim() === (nm || "").trim());
        if (!w) return null;
        const roles = Object.keys(roleReq);
        for (const rName of roles) {
          if ((w.roles || []).some((r) => norm(String(r)) === norm(rName))) return rName;
        }
        return null;
      };
      const currentAssignedPerRole = new Map<string, number>();
      beforeArr.forEach((nm) => {
        const r = findAssignedRole(nm);
        if (!r) return;
        currentAssignedPerRole.set(r, (currentAssignedPerRole.get(r) || 0) + 1);
      });
      const roleHints: string[] = [];
      Object.entries(roleReq).forEach(([rName, rCount]) => {
        const have = currentAssignedPerRole.get(rName) || 0;
        const deficit = Math.max(0, (rCount || 0) - have);
        for (let i = 0; i < deficit; i++) roleHints.push(rName);
      });
      const slotMetaBefore = beforeArr.map((nm, i) => ({ idx: i, nm, assignedRole: findAssignedRole(nm), roleHint: roleHints[i] || null }));
      const normName = (s: any) =>
        String(s || "")
          .normalize("NFKC")
          .trim()
          .replace(/\s+/g, " ");

      // Preserve slot order: do NOT compact when removing duplicates.
      const nextTarget = Array.from(beforeArr as string[]);
      while (nextTarget.length <= slotIndex) nextTarget.push("");
      for (let i = 0; i < nextTarget.length; i++) {
        if (normName(nextTarget[i]) === normName(trimmed)) nextTarget[i] = "";
      }
      // Role validation: if the slot expects a role and the worker has roles, ensure match or confirm
      const worker = workers.find((w) => (w.name || "").trim() === trimmed);
      const workerRoles: string[] = Array.isArray(worker?.roles) ? worker!.roles : [];
      const hasWorkerRoles = workerRoles.length > 0;
      const slotHintComputed: string | null = roleHints[slotIndex] || null;
      const slotExpectedRole = (expectedRoleFromUI || slotHintComputed || "").trim() || null;
      if (!prechecked && slotExpectedRole) {
        const match = workerRoles.some((r) => norm(String(r)) === norm(slotExpectedRole as string));
        if (!match) {
          const ok = typeof window !== "undefined" && window.confirm && window.confirm(`לעובד "${trimmed}" אין את התפקיד "${slotExpectedRole}" בתא זה. להקצות בכל זאת?`);
          if (!ok) {
            return prev;
          }
        }
      }
      // Other constraints confirmations
      const conflicts: string[] = [];
      try {
        const isNight = detectShiftKind(shiftName) === "night";
        if (isNight) {
          // count night assignments for this worker across manualAssignments + this one
          let nightCount = 0;
          const dayKeysAll = Object.keys(manualAssignments || {});
          for (const dKey of dayKeysAll) {
            const shiftsMap = (manualAssignments as any)?.[dKey] || {};
            for (const sn of Object.keys(shiftsMap)) {
              if (detectShiftKind(sn) !== "night") continue;
              const perStation: string[][] = shiftsMap[sn] || [];
              for (const namesHere of perStation) if ((namesHere || []).some((nm) => (nm || "").trim() === trimmed)) nightCount++;
            }
          }
          // if not already counted in this exact target cell, account for the new drop
          const alreadyHere = beforeArr.some((nm, i) => i === slotIndex ? nm === trimmed : false);
          if (!alreadyHere) nightCount += 1;
          if (nightCount > 3) conflicts.push("יותר מ־3 לילות בשבוע");
        }
        // same day+shift elsewhere
        const perStationSame: string[][] = ((manualAssignments as any)?.[dayKey]?.[shiftName] || []) as any;
        let existsElsewhere = false;
        perStationSame.forEach((namesArr: string[], sIdx: number) => {
          if (sIdx === stationIndex) return;
          if ((namesArr || []).some((nm) => (nm || "").trim() === trimmed)) existsElsewhere = true;
        });
        if (existsElsewhere) conflicts.push("אותו עובד כבר שובץ במשמרת זו בעמדה אחרת");
        // adjacent shifts (including day boundary)
        const kind = detectShiftKind(shiftName);
        const prevCheck = () => {
          if (kind === "morning") {
            const prevDay = prevDayKeyOf(dayKey);
            const perStationPrevNight = ((manualAssignments as any)?.[prevDay]?.[Object.keys(((manualAssignments as any)?.[prevDay]||{})).find((sn) => detectShiftKind(sn) === "night") || "__none__"] || []) as any;
            return perStationPrevNight.some((arr: string[]) => (arr || []).some((nm) => (nm || "").trim() === trimmed));
          }
          if (kind === "noon") {
            const perStationPrevMorning = ((manualAssignments as any)?.[dayKey]?.[Object.keys(((manualAssignments as any)?.[dayKey]||{})).find((sn) => detectShiftKind(sn) === "morning") || "__none__"] || []) as any;
            return perStationPrevMorning.some((arr: string[]) => (arr || []).some((nm) => (nm || "").trim() === trimmed));
          }
          if (kind === "night") {
            const perStationPrevNoon = ((manualAssignments as any)?.[dayKey]?.[Object.keys(((manualAssignments as any)?.[dayKey]||{})).find((sn) => detectShiftKind(sn) === "noon") || "__none__"] || []) as any;
            return perStationPrevNoon.some((arr: string[]) => (arr || []).some((nm) => (nm || "").trim() === trimmed));
          }
          return false;
        };
        const nextCheck = () => {
          if (kind === "morning") {
            const perStationNextNoon = ((manualAssignments as any)?.[dayKey]?.[Object.keys(((manualAssignments as any)?.[dayKey]||{})).find((sn) => detectShiftKind(sn) === "noon") || "__none__"] || []) as any;
            return perStationNextNoon.some((arr: string[]) => (arr || []).some((nm) => (nm || "").trim() === trimmed));
          }
          if (kind === "noon") {
            const perStationNextNight = ((manualAssignments as any)?.[dayKey]?.[Object.keys(((manualAssignments as any)?.[dayKey]||{})).find((sn) => detectShiftKind(sn) === "night") || "__none__"] || []) as any;
            return perStationNextNight.some((arr: string[]) => (arr || []).some((nm) => (nm || "").trim() === trimmed));
          }
          if (kind === "night") {
            const nextDay = nextDayKeyOf(dayKey);
            const perStationNextMorning = ((manualAssignments as any)?.[nextDay]?.[Object.keys(((manualAssignments as any)?.[nextDay]||{})).find((sn) => detectShiftKind(sn) === "morning") || "__none__"] || []) as any;
            return perStationNextMorning.some((arr: string[]) => (arr || []).some((nm) => (nm || "").trim() === trimmed));
          }
          return false;
        };
        if (prevCheck() || nextCheck()) conflicts.push("אין משמרות צמודות (כולל חציית יום)");
      } catch {}
      if (conflicts.length > 0) {
        const conflictKey = `${dayKey}|${shiftName}|${stationIndex}|${slotIndex}|${trimmed}`;
        const last = lastConflictConfirmRef.current;
        if (!(last && last.key === conflictKey && Date.now() - last.ts < 1500)) {
          const msg = `שיבוץ עלול להפר חוקים:\n- ${conflicts.join("\n- ")}.\nלהקצות בכל זאת?`;
          const ok = typeof window !== "undefined" && window.confirm && window.confirm(msg);
          // Mémoriser la décision (OK ou Annuler) pour éviter une répétition immédiate
          lastConflictConfirmRef.current = { key: conflictKey, ts: Date.now() };
          if (!ok) return prev;
        }
      }
      nextTarget[slotIndex] = trimmed;
      base[dayKey][shiftName][stationIndex] = nextTarget;

      // If dragging from an existing assigned slot in manual mode, MOVE it: clear source slot.
      if (isMoveFromSlot && dragSrc) {
        try {
          const sameCell =
            dragSrc.dayKey === dayKey &&
            dragSrc.shiftName === shiftName &&
            Number(dragSrc.stationIndex) === Number(stationIndex);
          // Only clear when moving to a different slot or cell
          if (!sameCell || Number(dragSrc.slotIndex) !== Number(slotIndex)) {
            base[dragSrc.dayKey] = base[dragSrc.dayKey] || {};
            base[dragSrc.dayKey][dragSrc.shiftName] = Array.isArray(base[dragSrc.dayKey][dragSrc.shiftName])
              ? base[dragSrc.dayKey][dragSrc.shiftName]
              : Array.from({ length: stationsCount }, () => []);
            const srcArr: string[] = Array.from(base[dragSrc.dayKey][dragSrc.shiftName][dragSrc.stationIndex] || []);
            while (srcArr.length <= dragSrc.slotIndex) srcArr.push("");
            srcArr[dragSrc.slotIndex] = "";
            base[dragSrc.dayKey][dragSrc.shiftName][dragSrc.stationIndex] = srcArr;
          }
        } catch {}
      }
      // Update manualRoleHints according to expected role from UI
      try {
        if (typeof expectedRoleFromUI !== "undefined") {
          setManualRoleHints((prevHints) => {
            const stationsCount2 = (site?.config?.stations || []).length || 0;
            const ensureHints = (h?: RoleHintsMap | null): RoleHintsMap => {
              const nextH: RoleHintsMap = h ? JSON.parse(JSON.stringify(h)) : ({} as any);
              if (!nextH[dayKey]) nextH[dayKey] = {} as any;
              if (!nextH[dayKey][shiftName]) nextH[dayKey][shiftName] = Array.from({ length: stationsCount2 }, () => []);
              if ((nextH[dayKey][shiftName] as any[]).length !== stationsCount2) {
                nextH[dayKey][shiftName] = Array.from({ length: stationsCount2 }, (_, i) => (nextH[dayKey][shiftName][i] || []));
              }
              return nextH;
            };
            const nh = ensureHints(prevHints);
            const arrHints: (string | null)[] = Array.from(nh[dayKey][shiftName][stationIndex] || []);
            while (arrHints.length <= slotIndex) arrHints.push(null);
            const roleToSet = expectedRoleFromUI && workerHasRole(trimmed, expectedRoleFromUI) ? expectedRoleFromUI : null;
            arrHints[slotIndex] = roleToSet as any;
            nh[dayKey][shiftName][stationIndex] = arrHints;
            // Clear hint from source slot when moving
            if (isMoveFromSlot && dragSrc) {
              try {
                if (!nh[dragSrc.dayKey]) nh[dragSrc.dayKey] = {} as any;
                if (!nh[dragSrc.dayKey][dragSrc.shiftName]) {
                  nh[dragSrc.dayKey][dragSrc.shiftName] = Array.from({ length: stationsCount2 }, () => []);
                }
                const srcHints: (string | null)[] = Array.from(
                  (nh as any)[dragSrc.dayKey]?.[dragSrc.shiftName]?.[dragSrc.stationIndex] || [],
                );
                while (srcHints.length <= dragSrc.slotIndex) srcHints.push(null);
                srcHints[dragSrc.slotIndex] = null;
                (nh as any)[dragSrc.dayKey][dragSrc.shiftName][dragSrc.stationIndex] = srcHints;
              } catch {}
            }
            return nh;
          });
        }
      } catch {}
      const afterArr: string[] = Array.from(base[dayKey][shiftName][stationIndex] || []);
      const currentAssignedPerRoleAfter = new Map<string, number>();
      afterArr.forEach((nm) => {
        const r = findAssignedRole(nm);
        if (!r) return;
        currentAssignedPerRoleAfter.set(r, (currentAssignedPerRoleAfter.get(r) || 0) + 1);
      });
      const roleHintsAfter: string[] = [];
      Object.entries(roleReq).forEach(([rName, rCount]) => {
        const have = currentAssignedPerRoleAfter.get(rName) || 0;
        const deficit = Math.max(0, (rCount || 0) - have);
        for (let i = 0; i < deficit; i++) roleHintsAfter.push(rName);
      });
      const slotMetaAfter = afterArr.map((nm, i) => ({ idx: i, nm, assignedRole: findAssignedRole(nm), roleHint: roleHintsAfter[i] || null }));
      return { ...base };
    });
  }

  function onCellDrop(e: React.DragEvent, dayKey: string, shiftName: string, stationIndex: number) {
    e.preventDefault();
    const name = (() => {
      try { return e.dataTransfer.getData("text/plain"); } catch { return ""; }
    })();
    const trimmed = (name || "").trim();
    if (!trimmed) return;
    // Vérifier זמינות et demander confirmation si nécessaire
    const w = findWorkerByName(trimmed);
    const allowed = !!w && Array.isArray(w.availability?.[dayKey]) && (w.availability![dayKey] as string[]).includes(shiftName);
    if (!allowed) {
      const ok = typeof window !== "undefined" && window.confirm && window.confirm(`לעובד "${trimmed}" אין זמינות למשמרת זו. להקצות בכל זאת?`);
      if (!ok) return;
      ensureOverlay(trimmed, dayKey, shiftName);
    }
    setManualAssignments((prev) => {
      const stationsCount = (site?.config?.stations || []).length || 0;
      const ensureBase = (base?: AssignmentsMap | null): AssignmentsMap => {
        const next: AssignmentsMap = base ? JSON.parse(JSON.stringify(base)) : {} as any;
        if (!next[dayKey]) next[dayKey] = {} as any;
        if (!next[dayKey][shiftName]) next[dayKey][shiftName] = Array.from({ length: stationsCount }, () => []);
        // ensure length
        if (next[dayKey][shiftName].length !== stationsCount) {
          next[dayKey][shiftName] = Array.from({ length: stationsCount }, (_, i) => (next[dayKey][shiftName][i] || []));
        }
        return next;
      };
      const base = ensureBase(prev);
      const cell = base[dayKey][shiftName][stationIndex] || [];
      if (!cell.includes(trimmed)) {
        base[dayKey][shiftName][stationIndex] = [...cell, trimmed];
      }
      return { ...base };
    });
  }

  function onSlotDrop(
    e: React.DragEvent,
    dayKey: string,
    shiftName: string,
    stationIndex: number,
    slotIndex: number
  ) {
    e.preventDefault();
    e.stopPropagation();
    const name = (() => {
      try { return e.dataTransfer.getData("text/plain"); } catch { return ""; }
    })();
    lastDropRef.current = { key: `${dayKey}|${shiftName}|${stationIndex}|${slotIndex}`, ts: Date.now() };
    const roleHintAttr = (e.currentTarget as HTMLElement | null)?.getAttribute?.("data-rolehint") || null;
    // Pre-check mismatch before state update for reliable popup
    if (roleHintAttr) {
      const worker = workers.find((w) => (w.name || "").trim() === (name || "").trim());
      const workerRoles: string[] = Array.isArray(worker?.roles) ? worker!.roles : [];
      const match = workerRoles.some((r) => (r || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") === (roleHintAttr || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " "));
      if (!match) {
        const ok = typeof window !== "undefined" && window.confirm && window.confirm(`לעובד "${name}" אין את התפקיד "${roleHintAttr}" בתא זה. להקצות בכל זאת?`);
        if (!ok) {
          setHoverSlotKey(null);
          return;
        }
      }
    }
    didDropRef.current = true;
    dropIntoSlot(dayKey, shiftName, stationIndex, slotIndex, name, roleHintAttr, true);
    setHoverSlotKey(null);
    setDraggingWorkerName(null);
  }

  function onCellContainerDrop(
    e: React.DragEvent,
    dayKey: string,
    shiftName: string,
    stationIndex: number
  ) {
    if (!isManual) return;
    e.preventDefault();
    e.stopPropagation();
    // If a child slot handled the drop recently for the same target, ignore container drop
    const ld = lastDropRef.current;
    // If the event target is within a slot, ignore (child handles)
    const isInsideSlot = (e.target as HTMLElement | null)?.closest?.('[data-slot="1"]');
    if (isInsideSlot) {
      return;
    }
    let targetDay = dayKey;
    let targetShift = shiftName;
    let targetStation = stationIndex;
    let targetSlot = -1;
    // Prefer hovered slot if still set
    if (hoverSlotKey) {
      const [dKey, sName, stIdxStr, slotIdxStr] = hoverSlotKey.split("|");
      const stIdx = Number(stIdxStr);
      const slotIdx = Number(slotIdxStr);
      if (dKey === dayKey && sName === shiftName && stIdx === stationIndex && Number.isFinite(slotIdx)) {
        targetSlot = slotIdx;
      }
    }
    // Fallback: find closest slot under pointer
    if (targetSlot < 0 && typeof document !== "undefined") {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const slotEl = el?.closest?.('[data-slot="1"]') as HTMLElement | null;
      if (slotEl) {
        const dkey = slotEl.getAttribute("data-dkey") || dayKey;
        const sname = slotEl.getAttribute("data-sname") || shiftName;
        const stidx = Number(slotEl.getAttribute("data-stidx") || stationIndex);
        const sidx = Number(slotEl.getAttribute("data-slotidx") || -1);
        if (dkey === dayKey && sname === shiftName && stidx === stationIndex && Number.isFinite(sidx)) {
          targetSlot = sidx;
        }
      }
    }
    // After we know the precise target slot, check recent slot drop exact-key guard
    if (ld) {
      const targetKey = `${dayKey}|${shiftName}|${stationIndex}|${targetSlot}`;
      if (ld.key === targetKey && Date.now() - ld.ts < 1000) { // 1s guard
        return;
      }
    }
    if (targetSlot < 0) return;
    const name = (() => { try { return e.dataTransfer.getData("text/plain"); } catch { return ""; } })();
    let expectedRole: string | null = null;
    if (typeof document !== "undefined") {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const slotEl = el?.closest?.('[data-slot="1"]') as HTMLElement | null;
      expectedRole = (slotEl?.getAttribute?.("data-rolehint") || null);
    }
    // Pre-check mismatch
    if (expectedRole) {
      const worker = workers.find((w) => (w.name || "").trim() === (name || "").trim());
      const workerRoles: string[] = Array.isArray(worker?.roles) ? worker!.roles : [];
      const match = workerRoles.some((r) => (r || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") === (expectedRole || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " "));
      if (!match) {
        const ok = typeof window !== "undefined" && window.confirm && window.confirm(`לעובד "${name}" אין את התפקיד "${expectedRole}" בתא זה. להקצות בכל זאת?`);
        if (!ok) {
          setHoverSlotKey(null);
          return;
        }
      }
    }
    didDropRef.current = true;
    dropIntoSlot(targetDay, targetShift, targetStation, targetSlot, name, expectedRole, true);
    setHoverSlotKey(null);
    setDraggingWorkerName(null);
  }

  function colorIdentityForWorker(worker: Worker): string {
    const phone = String(worker.phone || "").trim();
    if (phone) return `phone:${phone}`;
    const linkedIds = Array.isArray(worker.linkedSiteIds) ? worker.linkedSiteIds.map((id) => Number(id)).filter(Number.isFinite).sort((a, b) => a - b) : [];
    if (linkedIds.length > 1) return `linked:${linkedIds.join(",")}:${String(worker.name || "").trim()}`;
    return `name:${String(worker.name || "").trim()}`;
  }

  const workerColorIdentityByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const worker of workers) {
      const name = String(worker.name || "").trim();
      if (!name) continue;
      map.set(name, colorIdentityForWorker(worker));
    }
    return map;
  }, [workers]);

  // Construire un mapping nom -> couleur distincte (éviter rouge/vert), stable et réparti (golden angle)
  const nameToColor = useMemo(() => {
    const namesSet = new Set<string>();
    // depuis la liste des workers
    for (const w of workers) {
      const nm = (w.name || "").trim();
      if (nm) namesSet.add(nm);
    }
    // depuis le plan IA courant
    if (aiPlan && aiPlan.assignments) {
      for (const day of Object.keys(aiPlan.assignments)) {
        const shiftsMap = (aiPlan.assignments as any)[day] || {};
        for (const sh of Object.keys(shiftsMap)) {
          const perStation: string[][] = shiftsMap[sh] || [];
          for (const arr of perStation) {
            for (const nm of arr || []) {
              const v = (nm || "").trim();
              if (v) namesSet.add(v);
            }
          }
        }
      }
    }
    const names = Array.from(namesSet).sort((a, b) => a.localeCompare(b));
    const identities = Array.from(new Set(names.map((name) => workerColorIdentityByName.get(name) || `name:${name}`))).sort((a, b) => a.localeCompare(b));
    const GOLDEN = 137.508;
    function shiftForbidden(h: number) {
      // éviter rouge ~[350..360)∪[0..20], vert ~[100..150]
      if (h < 20 || h >= 350) h = (h + 30) % 360;
      if (h >= 100 && h <= 150) h = (h + 40) % 360;
      return h;
    }
    const identityToColor = new Map<string, { bg: string; border: string; text: string }>();
    identities.forEach((identity, i) => {
      let h = (i * GOLDEN) % 360;
      h = shiftForbidden(h);
      // alterner saturation/luminosité pour plus de séparation perceptuelle
      const L = [88, 84, 80][i % 3];
      const Sbg = [85, 80, 75][(i >> 1) % 3];
      const bg = `hsl(${h} ${Sbg}% ${L}%)`;
      const border = `hsl(${h} 60% ${Math.max(65, L - 10)}%)`;
      const text = `#1f2937`;
      identityToColor.set(identity, { bg, border, text });
    });
    const map = new Map<string, { bg: string; border: string; text: string }>();
    names.forEach((name) => {
      const identity = workerColorIdentityByName.get(name) || `name:${name}`;
      const color = identityToColor.get(identity);
      if (color) map.set(name, color);
    });
    return map;
  }, [workers, aiPlan, workerColorIdentityByName]);

  // Couleur stable par employé (palette sans rouge/vert) pour éviter confusion avec l'état שיבוצים
  function colorForName(name: string): { bg: string; border: string; text: string } {
    const preset = nameToColor.get(name);
    if (preset) return preset;
    const s = name || "";
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash) + s.charCodeAt(i);
      hash |= 0;
    }
    // Hues autorisées (éviter rouge ~0 et vert ~120)
    const allowedHues = [20, 30, 40, 50, 200, 210, 220, 230, 260, 270, 280, 290, 300, 310];
    const idx = Math.abs(hash) % allowedHues.length;
    const hue = allowedHues[idx];
    // Légère variation de luminosité/saturation pour augmenter la distinction
    const lightVariants = [88, 84, 80] as const;
    const satVariants = [85, 80, 75] as const;
    const vIdx = Math.abs((hash >> 3)) % lightVariants.length;
    const L = lightVariants[vIdx];
    const Sbg = satVariants[vIdx];
    const Sborder = 60;
    const bg = `hsl(${hue} ${Sbg}% ${L}%)`;
    const border = `hsl(${hue} ${Sborder}% ${Math.max(65, L - 10)}%)`;
    const text = `#1f2937`;
    return { bg, border, text };
  }

  // Couleurs par תפקיד (rôle) – mapping stable basé sur la config du site et les rôles des employés
  const roleColorMap = useMemo(() => {
    const set = new Set<string>();
    // depuis config des stations
    for (const st of (site?.config?.stations || [])) {
      for (const r of (st?.roles || [])) {
        const nm = (r?.name || "").trim();
        if (nm) set.add(nm);
      }
      for (const sh of (st?.shifts || [])) {
        for (const r of (sh?.roles || [])) {
          const nm = (r?.name || "").trim();
          if (nm) set.add(nm);
        }
      }
    }
    // depuis les employés
    for (const w of workers) {
      for (const nm of (w.roles || [])) {
        const v = (nm || "").trim();
        if (v) set.add(v);
      }
    }
    const roles = Array.from(set).sort((a, b) => a.localeCompare(b));
    const GOLDEN = 137.508;
    const map = new Map<string, { border: string; text: string }>();
    roles.forEach((nm, i) => {
      let h = (i * GOLDEN) % 360;
      // éviter zones trop proches du vert des statuts
      if (h >= 100 && h <= 150) h = (h + 40) % 360;
      const border = `hsl(${h} 70% 40%)`;
      const text = `hsl(${h} 60% 30%)`;
      map.set(nm, { border, text });
    });
    return map;
  }, [site, workers]);

  const enabledRoleNameSet = useMemo(() => {
    const set = new Set<string>();
    const pushIfEnabled = (name?: string, enabled?: boolean) => {
      const nm = String(name || "").trim();
      if (!nm || !enabled) return;
      set.add(nm);
    };

    for (const st of (site?.config?.stations || [])) {
      for (const r of (st?.roles || [])) pushIfEnabled(r?.name, r?.enabled);
      for (const sh of (st?.shifts || [])) {
        for (const r of (sh?.roles || [])) pushIfEnabled(r?.name, r?.enabled);
      }
      for (const dayCfg of Object.values(st?.dayOverrides || {})) {
        const cfg: any = dayCfg;
        for (const sh of (cfg?.shifts || [])) {
          for (const r of (sh?.roles || [])) pushIfEnabled(r?.name, r?.enabled);
        }
      }
    }

    return set;
  }, [site]);

  function colorForRole(roleName: string): { border: string; text: string } {
    return roleColorMap.get(roleName) || { border: "#64748b", text: "#334155" };
  }

  function renderSummaryWorkerChip(name: string): ReactElement {
    const col = colorForName(name);
    return (
      <span
        className="inline-flex min-h-6 md:min-h-9 w-fit max-w-[8rem] md:max-w-[24rem] min-w-0 overflow-hidden items-start rounded-full border px-1.5 md:px-3 py-0.5 md:py-1 shadow-sm"
        style={{ backgroundColor: col.bg, borderColor: col.border, color: col.text }}
      >
        <span className="flex flex-col items-center text-center leading-tight min-w-0 max-w-full overflow-hidden">
          <span
            className={"block min-w-0 max-w-full leading-tight md:text-center " + (isRtlName(name) ? "text-right" : "text-left")}
            dir={isRtlName(name) ? "rtl" : "ltr"}
          >
            <span className="md:hidden text-[8px]">{truncateSummaryMobile(name)}</span>
            <span className="hidden md:block truncate text-[8px] md:text-sm">{name}</span>
          </span>
        </span>
      </span>
    );
  }

  function renderSummaryRoleChip(roleName: string): ReactElement {
    const rc = colorForRole(roleName);
    return (
      <span
        className="inline-flex min-h-6 md:min-h-9 w-fit max-w-[8rem] md:max-w-[24rem] min-w-0 overflow-hidden items-start rounded-full border bg-white px-1.5 md:px-3 py-0.5 md:py-1 shadow-sm"
        style={{ borderColor: rc.border, color: rc.text }}
      >
        <span className="flex flex-col items-center text-center leading-tight min-w-0 max-w-full overflow-hidden">
          <span className="block min-w-0 max-w-full leading-tight text-center">
            <span className="md:hidden text-[8px]">{truncateSummaryMobile(roleName)}</span>
            <span className="hidden md:block truncate text-[8px] md:text-sm">{roleName}</span>
          </span>
        </span>
      </span>
    );
  }

  function countAssignmentsByWorker(
    assignments: Record<string, Record<string, string[][]>> | null | undefined,
    workerList: Worker[],
  ): Map<string, number> {
    const counts = new Map<string, number>();
    workerList.forEach((w) => counts.set(w.name, 0));
    if (!assignments || typeof assignments !== "object") return counts;

    for (const dKey of Object.keys(assignments)) {
      const shiftsMap = assignments[dKey] || {};
      for (const sn of Object.keys(shiftsMap)) {
        const perStation: string[][] = shiftsMap[sn] || [];
        for (const namesHere of perStation) {
          for (const nm of (namesHere || [])) {
            const clean = String(nm || "").trim();
            if (!clean) continue;
            counts.set(clean, (counts.get(clean) || 0) + 1);
          }
        }
      }
    }

    return counts;
  }

  function requiredForStationSummary(st: any, shiftName: string, dayKey: string): number {
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

  function roleRequirementsForStationSummary(st: any, shiftName: string, dayKey: string): Record<string, number> {
    const out: Record<string, number> = {};
    const push = (name?: string, count?: number, enabled?: boolean) => {
      const roleName = String(name || "").trim();
      const roleCount = Number(count || 0);
      if (!roleName || !enabled || roleCount <= 0) return;
      out[roleName] = (out[roleName] || 0) + roleCount;
    };
    if (!st) return out;
    if (st.perDayCustom) {
      const dayCfg = st.dayOverrides?.[dayKey];
      if (!dayCfg || dayCfg.active === false) return out;
      if (st.uniformRoles) {
        for (const role of (st.roles || [])) push(role?.name, role?.count, role?.enabled);
      } else {
        const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
        if (!sh || !sh.enabled) return out;
        for (const role of (sh.roles || [])) push(role?.name, role?.count, role?.enabled);
      }
      return out;
    }
    if (st.days && st.days[dayKey] === false) return out;
    if (st.uniformRoles) {
      for (const role of (st.roles || [])) push(role?.name, role?.count, role?.enabled);
    } else {
      const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
      if (!sh || !sh.enabled) return out;
      for (const role of (sh.roles || [])) push(role?.name, role?.count, role?.enabled);
    }
    return out;
  }

  function analyzePlanPullPriority(
    assignments: Record<string, Record<string, string[][]>> | null | undefined,
    pulls?: Record<string, PullEntry> | null,
  ) {
    const stationsCfg = (site?.config?.stations || []) as any[];
    const shiftNames = Array.from(
      new Set(
        stationsCfg.flatMap((st: any) => (
          st?.perDayCustom
            ? Object.values(st?.dayOverrides || {}).flatMap((dayCfg: any) => (dayCfg?.shifts || []).filter((sh: any) => sh?.enabled).map((sh: any) => String(sh?.name || "")))
            : (st?.shifts || []).filter((sh: any) => sh?.enabled).map((sh: any) => String(sh?.name || ""))
        )),
      ),
    )
      .filter(Boolean)
      .sort((a, b) => displayShiftOrderIndex(a) - displayShiftOrderIndex(b) || a.localeCompare(b));
    const shiftsOrder = shiftNames.length ? shiftNames : Array.from(new Set(Object.values(assignments || {}).flatMap((shiftMap) => Object.keys(shiftMap || {}))));
    const dayKeys = [...dayOrder];
    const getCellNames = (dayKey: string, shiftName: string, stationIdx: number): string[] => {
      const cell = assignments?.[dayKey]?.[shiftName]?.[stationIdx];
      return Array.isArray(cell) ? cell.filter((name) => String(name || "").trim()).map((name) => String(name).trim()) : [];
    };
    const getPullsCount = (dayKey: string, shiftName: string, stationIdx: number): number =>
      Object.keys(pulls || {}).filter((key) => String(key).startsWith(`${dayKey}|${shiftName}|${stationIdx}|`)).length;

    let assigned = 0;
    let required = 0;
    let holes = 0;
    let pullableHoles = 0;
    const pullOpportunities: Array<{ key: string; pairs: Array<[string, string]> }> = [];

    for (let stationIdx = 0; stationIdx < stationsCfg.length; stationIdx++) {
      const stationCfg = stationsCfg[stationIdx];
      for (let dayIdx = 0; dayIdx < dayKeys.length; dayIdx++) {
        const dayKey = dayKeys[dayIdx];
        for (let shiftIdx = 0; shiftIdx < shiftsOrder.length; shiftIdx++) {
          const shiftName = shiftsOrder[shiftIdx];
          const req = requiredForStationSummary(stationCfg, shiftName, dayKey);
          if (req <= 0) continue;
          const namesHere = getCellNames(dayKey, shiftName, stationIdx);
          const pullsHere = getPullsCount(dayKey, shiftName, stationIdx);
          const assignedPlaces = Math.max(0, namesHere.length - pullsHere);
          assigned += assignedPlaces;
          required += req;
          if (assignedPlaces >= req) continue;
          holes += req - assignedPlaces;

          const prevCoord = (dayIdx === 0 && shiftIdx === 0)
            ? null
            : (shiftIdx === 0 ? { dayIdx: dayIdx - 1, shiftIdx: shiftsOrder.length - 1 } : { dayIdx, shiftIdx: shiftIdx - 1 });
          const nextCoord = (dayIdx === dayKeys.length - 1 && shiftIdx === shiftsOrder.length - 1)
            ? null
            : (shiftIdx === shiftsOrder.length - 1 ? { dayIdx: dayIdx + 1, shiftIdx: 0 } : { dayIdx, shiftIdx: shiftIdx + 1 });
          const prevNames = prevCoord ? getCellNames(dayKeys[prevCoord.dayIdx], shiftsOrder[prevCoord.shiftIdx], stationIdx) : [];
          const nextNames = nextCoord ? getCellNames(dayKeys[nextCoord.dayIdx], shiftsOrder[nextCoord.shiftIdx], stationIdx) : [];
          const usedInCell = new Set(namesHere);
          const beforeCandidates = prevNames.filter((name) => !usedInCell.has(name));
          const afterCandidates = nextNames.filter((name) => !usedInCell.has(name));
          const bothSides = new Set(beforeCandidates.filter((name) => afterCandidates.includes(name)));
          const beforeCandidates2 = beforeCandidates.filter((name) => !bothSides.has(name));
          const afterCandidates2 = afterCandidates.filter((name) => !bothSides.has(name));
          const reqRoles = Object.keys(roleRequirementsForStationSummary(stationCfg, shiftName, dayKey));
          const pairSet = new Set<string>();
          const pairs: Array<[string, string]> = [];
          const pushPair = (beforeName: string, afterName: string) => {
            const beforeTrimmed = String(beforeName || "").trim();
            const afterTrimmed = String(afterName || "").trim();
            if (!beforeTrimmed || !afterTrimmed || beforeTrimmed === afterTrimmed) return;
            const pairKey = `${beforeTrimmed}__${afterTrimmed}`;
            if (pairSet.has(pairKey)) return;
            pairSet.add(pairKey);
            pairs.push([beforeTrimmed, afterTrimmed]);
          };
          if (reqRoles.length > 0) {
            reqRoles.forEach((roleName) => {
              const beforeWithRole = beforeCandidates2.filter((name) => workerHasRole(name, roleName));
              const afterWithRole = afterCandidates2.filter((name) => workerHasRole(name, roleName));
              beforeWithRole.forEach((beforeName) => {
                afterWithRole.forEach((afterName) => pushPair(beforeName, afterName));
              });
            });
          } else {
            beforeCandidates2.forEach((beforeName) => {
              afterCandidates2.forEach((afterName) => pushPair(beforeName, afterName));
            });
          }
          if (pairs.length > 0) {
            pullableHoles += 1;
            pullOpportunities.push({ key: `${dayKey}|${shiftName}|${stationIdx}`, pairs });
          }
        }
      }
    }

    const orderedOpportunities = [...pullOpportunities].sort((a, b) => a.pairs.length - b.pairs.length);
    let maxCompatiblePulls = 0;
    const dfs = (index: number, usedNames: Set<string>, chosen: number) => {
      if (chosen + (orderedOpportunities.length - index) <= maxCompatiblePulls) return;
      if (index >= orderedOpportunities.length) {
        if (chosen > maxCompatiblePulls) maxCompatiblePulls = chosen;
        return;
      }
      dfs(index + 1, usedNames, chosen);
      const current = orderedOpportunities[index];
      for (const [beforeName, afterName] of current.pairs) {
        if (usedNames.has(beforeName) || usedNames.has(afterName)) continue;
        const nextUsed = new Set(usedNames);
        nextUsed.add(beforeName);
        nextUsed.add(afterName);
        dfs(index + 1, nextUsed, chosen + 1);
      }
    };
    dfs(0, new Set<string>(), 0);

    return { assigned, required, holes, pullableHoles, maxCompatiblePulls };
  }

  function shouldPromotePullFriendlyPlan(
    currentAssignments: Record<string, Record<string, string[][]>> | null | undefined,
    currentPulls: Record<string, PullEntry> | null | undefined,
    candidateAssignments: Record<string, Record<string, string[][]>> | null | undefined,
    candidatePulls: Record<string, PullEntry> | null | undefined,
  ): boolean {
    if (!currentAssignments || !candidateAssignments) return false;
    const current = analyzePlanPullPriority(currentAssignments, currentPulls);
    const candidate = analyzePlanPullPriority(candidateAssignments, candidatePulls);
    if (current.holes <= 0) return false;
    if (autoPullsEnabled) {
      if (candidate.holes < current.holes) return true;
      if (candidate.holes === current.holes && candidate.assigned > current.assigned) return true;
      return false;
    }
    const currentHasPulls = current.maxCompatiblePulls > 0;
    const candidateHasPulls = candidate.maxCompatiblePulls > 0;
    if (!currentHasPulls && candidateHasPulls) return true;
    if (currentHasPulls && candidateHasPulls && candidate.maxCompatiblePulls > current.maxCompatiblePulls) return true;
    if (currentHasPulls && candidateHasPulls && candidate.maxCompatiblePulls === current.maxCompatiblePulls && candidate.pullableHoles > current.pullableHoles) return true;
    if (candidateHasPulls === currentHasPulls && candidate.holes < current.holes) return true;
    if (candidateHasPulls === currentHasPulls && candidate.holes === current.holes && candidate.assigned > current.assigned) return true;
    return false;
  }

  function comparePlanQuality(
    currentAssignments: Record<string, Record<string, string[][]>> | null | undefined,
    currentPulls: Record<string, PullEntry> | null | undefined,
    candidateAssignments: Record<string, Record<string, string[][]>> | null | undefined,
    candidatePulls: Record<string, PullEntry> | null | undefined,
  ): -1 | 0 | 1 {
    if (!currentAssignments || !candidateAssignments) return 0;
    const current = analyzePlanPullPriority(currentAssignments, currentPulls);
    const candidate = analyzePlanPullPriority(candidateAssignments, candidatePulls);
    if (candidate.holes < current.holes) return -1;
    if (candidate.holes > current.holes) return 1;
    if (candidate.assigned > current.assigned) return -1;
    if (candidate.assigned < current.assigned) return 1;
    return 0;
  }

  function compareLinkedSitePlansQuality(
    currentPlans: Record<string, LinkedSitePlan>,
    candidatePlans: Record<string, LinkedSitePlan>,
  ): -1 | 0 | 1 {
    const summarize = (plans: Record<string, LinkedSitePlan>) =>
      Object.values(plans).reduce(
        (acc, plan) => {
          const summary = analyzePlanPullPriority(plan.assignments, plan.pulls);
          return {
            holes: acc.holes + summary.holes,
            assigned: acc.assigned + summary.assigned,
          };
        },
        { holes: 0, assigned: 0 },
      );
    const current = summarize(currentPlans);
    const candidate = summarize(candidatePlans);
    if (candidate.holes < current.holes) return -1;
    if (candidate.holes > current.holes) return 1;
    if (candidate.assigned > current.assigned) return -1;
    if (candidate.assigned < current.assigned) return 1;
    return 0;
  }

  const workersByName = useMemo(() => {
    const map = new Map<string, Worker>();
    for (const worker of workers) {
      const name = String(worker.name || "").trim();
      if (!name) continue;
      map.set(name, worker);
    }
    return map;
  }, [workers]);

  const showMultiSiteTotalColumn = linkedSites.length > 1;

  const totalAssignmentsByWorkerIdentity = useMemo(() => {
    const totals = new Map<string, number>();
    const linkedMemory = readLinkedPlansFromMemory(weekStart);

    const accumulateAssignments = (assignments: Record<string, Record<string, string[][]>> | null | undefined) => {
      const nameCounts = countAssignmentsByWorker(assignments, []);
      for (const [name, count] of nameCounts.entries()) {
        const worker = workersByName.get(String(name || "").trim());
        if (!worker) continue;
        const identity = colorIdentityForWorker(worker);
        totals.set(identity, (totals.get(identity) || 0) + count);
      }
    };

    if (linkedMemory?.plansBySite) {
      for (const plan of Object.values(linkedMemory.plansBySite)) {
        accumulateAssignments(resolveAssignmentsForAlternative(plan, linkedMemory.activeAltIndex || 0));
      }
      return totals;
    }

    const currentAssignments =
      savedWeekPlan?.assignments && !editingSaved
        ? savedWeekPlan.assignments
        : (isManual ? manualAssignments : aiPlan?.assignments);
    accumulateAssignments(currentAssignments);
    return totals;
  }, [weekStart, workersByName, savedWeekPlan, editingSaved, isManual, manualAssignments, aiPlan]);

  function totalAssignmentsForSummaryWorker(workerName: string, localCount: number): number {
    if (!showMultiSiteTotalColumn) return localCount;
    const worker = workersByName.get(String(workerName || "").trim());
    if (!worker || (worker.linkedSiteIds || []).length <= 1) return localCount;
    return totalAssignmentsByWorkerIdentity.get(colorIdentityForWorker(worker)) ?? localCount;
  }

  function countAssignedCells(
    assignments: Record<string, Record<string, string[][]>> | null | undefined,
    pulls?: Record<string, PullEntry> | null | undefined,
  ): number {
    if (!assignments || typeof assignments !== "object") return 0;
    let total = 0;
    for (const dayKey of Object.keys(assignments)) {
      const shiftsMap = assignments[dayKey] || {};
      for (const shiftName of Object.keys(shiftsMap)) {
        const perStation = shiftsMap[shiftName] || [];
        for (const cell of perStation) {
          if (Array.isArray(cell)) total += cell.filter((name) => String(name || "").trim()).length;
        }
      }
    }
    const pullsCount = pulls && typeof pulls === "object" ? Object.keys(pulls).length : 0;
    return Math.max(0, total - pullsCount);
  }

  function countRequiredForCurrentSite(): number {
    const stations = (site?.config?.stations || []) as any[];
    let total = 0;
    for (const st of stations) {
      const uniformRoles = !!st?.uniformRoles;
      const stationWorkers = Number(st?.workers || 0);
      if (st?.perDayCustom) {
        const dayOverrides = st?.dayOverrides || {};
        for (const dayCfg of Object.values(dayOverrides) as any[]) {
          if (!dayCfg?.active) continue;
          for (const shift of (dayCfg?.shifts || [])) {
            if (!shift?.enabled) continue;
            const roleTotal = Array.isArray(shift?.roles)
              ? shift.roles.filter((role: any) => role?.enabled).reduce((sum: number, role: any) => sum + Number(role?.count || 0), 0)
              : 0;
            const required = uniformRoles ? stationWorkers : Number(shift?.workers || 0);
            total += required > 0 ? required : roleTotal;
          }
        }
      } else {
        const activeDays = Object.values(st?.days || {}).filter(Boolean).length;
        for (const shift of (st?.shifts || [])) {
          if (!shift?.enabled) continue;
          const roleTotal = Array.isArray(shift?.roles)
            ? shift.roles.filter((role: any) => role?.enabled).reduce((sum: number, role: any) => sum + Number(role?.count || 0), 0)
            : 0;
          const required = uniformRoles ? stationWorkers : Number(shift?.workers || 0);
          total += (required > 0 ? required : roleTotal) * activeDays;
        }
      }
    }
    return total;
  }

  const linkedSiteEntries = useMemo(() => {
    const linkedMemory = readLinkedPlansFromMemory(weekStart);
    const currentAssignments = aiPlan?.assignments || savedWeekPlan?.assignments || null;
    const activeAltIndex = Number(linkedMemory?.activeAltIndex ?? altIndex ?? 0);
    const currentAssigned = countAssignedCells(currentAssignments, pullsByHoleKey);
    const currentRequired = countRequiredForCurrentSite();
    return linkedSites.map((linkedSite) => {
      const memoryPlan = linkedMemory?.plansBySite?.[String(linkedSite.id)];
      const planAssignments = memoryPlan ? resolveAssignmentsForAlternative(memoryPlan, activeAltIndex) : null;
      const planPulls = memoryPlan ? resolvePullsForAlternative(memoryPlan, activeAltIndex) : null;
      const assigned = planAssignments
        ? countAssignedCells(planAssignments, planPulls)
        : (typeof linkedSite.assigned_count === "number"
          ? linkedSite.assigned_count
          : (String(linkedSite.id) === String(params.id) ? currentAssigned : 0));
      const required = typeof memoryPlan?.required_count === "number"
        ? memoryPlan.required_count
        : (typeof linkedSite.required_count === "number"
          ? linkedSite.required_count
          : (String(linkedSite.id) === String(params.id) ? currentRequired : 0));
      return {
        ...linkedSite,
        assignedCount: assigned,
        requiredCount: required,
        holesCount: Math.max(0, required - assigned),
      };
    });
  }, [linkedSites, weekStart, aiPlan, savedWeekPlan, site, params.id, pullsByHoleKey, altIndex]);

  const linkedSitesTotalHoles = useMemo(
    () => linkedSiteEntries.reduce((sum, linkedSite) => sum + Number(linkedSite.holesCount || 0), 0),
    [linkedSiteEntries],
  );

  function handleAssignmentCountFilterChange(workerName: string, rawValue: string, maxAllowed?: number) {
    const cleaned = String(rawValue || "").replace(/[^\d]/g, "");
    const siteKey = String(params.id);
    setPreserveLinkedAltSelection(false);
    setSharedAssignmentCountFilters((prev) => {
      const next = { ...prev };
      const currentSiteFilters = { ...(next[siteKey] || {}) };
      if (!cleaned) {
        delete currentSiteFilters[workerName];
      } else {
        const numeric = Number(cleaned);
        const bounded = Number.isFinite(maxAllowed) ? Math.min(numeric, Number(maxAllowed)) : numeric;
        currentSiteFilters[workerName] = String(bounded);
      }
      if (Object.keys(currentSiteFilters).length > 0) next[siteKey] = currentSiteFilters;
      else delete next[siteKey];
      saveSharedAssignmentCountFilters(weekStart, next);
      return next;
    });
  }

  function selectAiPlanIndex(index: number) {
    const assignments = index === 0
      ? (aiPlan?.assignments || baseAssignmentsRef.current || null)
      : ((aiPlan?.alternatives || [])[index - 1] || null);
    const pulls = index === 0
      ? (aiPlan?.pulls || {})
      : ((aiPlan?.alternativePulls || [])[index - 1] || {});
    if (index === altIndex && sameAssignmentsMap(aiPlan?.assignments, assignments || undefined)) {
      const linkedMemory = readLinkedPlansFromMemory(weekStart);
      if (linkedMemory?.plansBySite) {
        saveLinkedPlansToMemory(weekStart, linkedMemory.plansBySite, index, "select-index-noop");
      }
      return;
    }
    setAltIndex(index);
    setPullsByHoleKey(pulls || {});
    setPullsEditor(null);
    if (assignments) {
      setAiPlan((prev) => {
        if (!prev || sameAssignmentsMap(prev.assignments, assignments)) return prev;
        return { ...prev, assignments };
      });
    }
    const linkedMemory = readLinkedPlansFromMemory(weekStart);
    if (linkedMemory?.plansBySite) {
      saveLinkedPlansToMemory(weekStart, linkedMemory.plansBySite, index, "select-index");
    }
  }

  function addDays(base: Date, days: number): Date {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
  }

  function formatHebDate(d: Date): string {
    return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  // Fonction pour obtenir la clé de semaine au format ISO (pour filtrer les réponses)
  function getWeekKeyISO(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  }

  function multiSiteSiteCacheKey(siteId: string | number) {
    return `${multiSiteSiteCachePrefix}${siteId}`;
  }

  function multiSiteWorkersCacheKey(siteId: string | number, start: Date) {
    return `${multiSiteWorkersCachePrefix}${siteId}_${getWeekKeyISO(start)}`;
  }

  function multiSiteLinkedSitesCacheKey(siteId: string | number, start: Date) {
    return `${multiSiteLinkedSitesCachePrefix}${siteId}_${getWeekKeyISO(start)}`;
  }

  function readSessionCache<T>(key: string): T | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  function writeSessionCache(key: string, value: unknown) {
    if (typeof window === "undefined") return;
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  function updateWeekStart(nextWeekStart: Date) {
    const normalized = new Date(nextWeekStart);
    normalized.setHours(0, 0, 0, 0);
    setWeekStart(normalized);
    try {
      const paramsObj = new URLSearchParams(searchParams.toString());
      paramsObj.set("week", getWeekKeyISO(normalized));
      router.replace(`/director/planning/${params.id}?${paramsObj.toString()}`);
    } catch {}
  }

  function saveLinkedPlansToMemory(start: Date, plansBySite: Record<string, LinkedSitePlan>, activeAltIndex = 0, source = "unknown") {
    if (typeof window === "undefined") return;
    try {
      const existing = readLinkedPlansFromMemory(start);
      const existingCountsBySite = summarizeLinkedMemoryCandidates(existing);
      const existingMaxCandidateCount = Math.max(0, ...Object.values(existingCountsBySite));
      const mergedPlansBySite = Object.fromEntries(
        Array.from(new Set([
          ...Object.keys(existing?.plansBySite || {}),
          ...Object.keys(plansBySite || {}),
        ])).map((siteKey) => {
          const existingPlan = existing?.plansBySite?.[siteKey];
          const incomingPlan = plansBySite?.[siteKey];
          const existingAlternatives = Array.isArray(existingPlan?.alternatives) ? existingPlan.alternatives : [];
          const incomingAlternatives = Array.isArray(incomingPlan?.alternatives) ? incomingPlan.alternatives : [];
          const existingAlternativePulls = Array.isArray(existingPlan?.alternative_pulls) ? existingPlan.alternative_pulls : [];
          const incomingAlternativePulls = Array.isArray(incomingPlan?.alternative_pulls) ? incomingPlan.alternative_pulls : [];
          return [
            siteKey,
            {
              ...(existingPlan || incomingPlan),
              ...(incomingPlan || existingPlan),
              assignments: incomingPlan?.assignments || existingPlan?.assignments,
              pulls: incomingPlan?.pulls || existingPlan?.pulls || {},
              alternatives: incomingAlternatives.length >= existingAlternatives.length ? incomingAlternatives : existingAlternatives,
              alternative_pulls: incomingAlternativePulls.length >= existingAlternativePulls.length ? incomingAlternativePulls : existingAlternativePulls,
            },
          ];
        }),
      ) as Record<string, LinkedSitePlan>;
      const maxCandidateCount = Math.max(
        0,
        ...Object.values(mergedPlansBySite).map((plan) => (
          (plan?.assignments ? 1 : 0) + (Array.isArray(plan?.alternatives) ? plan.alternatives.length : 0)
        )),
      );
      const nextPlansBySite = Object.fromEntries(
        Object.entries(mergedPlansBySite).map(([siteKey, plan]) => {
          const alternatives = Array.isArray(plan?.alternatives) ? [...plan.alternatives] : [];
          const alternativePulls = Array.isArray(plan?.alternative_pulls) ? [...plan.alternative_pulls] : [];
          const currentCandidateCount = (plan?.assignments ? 1 : 0) + alternatives.length;
          if (maxCandidateCount > 0 && currentCandidateCount > 0 && currentCandidateCount < maxCandidateCount) {
            const fallbackAssignments =
              alternatives.length > 0
                ? (alternatives[alternatives.length - 1] || plan.assignments)
                : plan.assignments;
            const fallbackPulls =
              alternativePulls.length > 0
                ? (alternativePulls[alternativePulls.length - 1] || plan.pulls || {})
                : (plan.pulls || {});
            while ((plan?.assignments ? 1 : 0) + alternatives.length < maxCandidateCount) {
              alternatives.push(fallbackAssignments || {});
              alternativePulls.push(fallbackPulls || {});
            }
          }
          return [
            siteKey,
            {
              ...plan,
              alternatives,
              alternative_pulls: alternativePulls,
            },
          ];
        }),
      ) as Record<string, LinkedSitePlan>;
      const nextCountsBySite = summarizeLinkedMemoryCandidates({ activeAltIndex, plansBySite: nextPlansBySite });
      const nextMaxCandidateCount = Math.max(0, ...Object.values(nextCountsBySite));
      const hasDrop =
        nextMaxCandidateCount < existingMaxCandidateCount ||
        Object.keys({ ...existingCountsBySite, ...nextCountsBySite }).some((siteKey) => (
          Number(nextCountsBySite[siteKey] || 0) < Number(existingCountsBySite[siteKey] || 0)
        ));
      if (hasDrop) {
        // eslint-disable-next-line no-console
        console.log("[MS][MEM_DROP]", {
          source,
          site: currentSiteIdRef.current,
          week: getWeekKeyISO(start),
          activeAltIndex,
          before: existingCountsBySite,
          after: nextCountsBySite,
        });
      }
      const currentSitePlan = nextPlansBySite[currentSiteIdRef.current];
      const maxIndexForCurrentSite = Math.max(
        0,
        (currentSitePlan?.assignments ? 1 : 0) + (Array.isArray(currentSitePlan?.alternatives) ? currentSitePlan.alternatives.length : 0) - 1,
      );
      const nextActiveAltIndex = Math.min(Math.max(0, Number(activeAltIndex || 0)), maxIndexForCurrentSite);
      const payload: LinkedPlansMemory = { activeAltIndex: nextActiveAltIndex, plansBySite: nextPlansBySite };
      const storageKey = multiSiteMemoryKey(start);
      sessionStorage.setItem(storageKey, JSON.stringify(payload));
      window.dispatchEvent(new CustomEvent("linked-plans-memory-updated", { detail: { storageKey } }));
    } catch {}
  }

  function readLinkedPlansFromMemory(start: Date): LinkedPlansMemory | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = sessionStorage.getItem(multiSiteMemoryKey(start));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if ("plansBySite" in parsed && parsed.plansBySite && typeof parsed.plansBySite === "object") {
        return {
          activeAltIndex: Number(parsed.activeAltIndex || 0),
          plansBySite: parsed.plansBySite as Record<string, LinkedSitePlan>,
        };
      }
      return {
        activeAltIndex: 0,
        plansBySite: parsed as Record<string, LinkedSitePlan>,
      };
    } catch {
      return null;
    }
  }

  function readSharedAssignmentCountFilters(start: Date): SharedAssignmentCountFilters {
    if (typeof window === "undefined") return {};
    try {
      const raw = sessionStorage.getItem(multiSiteAssignmentFiltersKey(start));
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      return parsed as SharedAssignmentCountFilters;
    } catch {
      return {};
    }
  }

  function saveSharedAssignmentCountFilters(start: Date, filters: SharedAssignmentCountFilters) {
    if (typeof window === "undefined") return;
    try {
      const storageKey = multiSiteAssignmentFiltersKey(start);
      const hasAnyFilter = Object.values(filters).some(
        (siteFilters) =>
          siteFilters &&
          typeof siteFilters === "object" &&
          Object.values(siteFilters).some((value) => String(value || "").trim().length > 0),
      );
      if (hasAnyFilter) sessionStorage.setItem(storageKey, JSON.stringify(filters));
      else sessionStorage.removeItem(storageKey);
      window.dispatchEvent(new CustomEvent("linked-assignment-filters-updated", { detail: { storageKey } }));
    } catch {}
  }

  function isSharedGenerationRunning(start: Date): boolean {
    if (typeof window === "undefined") return false;
    try {
      return sessionStorage.getItem(multiSiteGenerationKey(start)) === "1";
    } catch {
      return false;
    }
  }

  function setSharedGenerationRunningState(start: Date, running: boolean) {
    if (typeof window === "undefined") return;
    try {
      const generationKey = multiSiteGenerationKey(start);
      if (running) sessionStorage.setItem(generationKey, "1");
      else sessionStorage.removeItem(generationKey);
      window.dispatchEvent(new CustomEvent("linked-plans-generation-updated", { detail: { generationKey, running } }));
    } catch {}
  }

  function registerSharedGenerationController(start: Date, controller: AbortController | null) {
    if (typeof window === "undefined") return;
    try {
      const w = window as Window & { __linkedSiteGenerationControllers?: Record<string, AbortController | null> };
      if (!w.__linkedSiteGenerationControllers) w.__linkedSiteGenerationControllers = {};
      const generationKey = multiSiteGenerationKey(start);
      if (controller) w.__linkedSiteGenerationControllers[generationKey] = controller;
      else delete w.__linkedSiteGenerationControllers[generationKey];
    } catch {}
  }

  function stopSharedGeneration(start: Date) {
    if (typeof window === "undefined") return;
    try {
      const w = window as Window & { __linkedSiteGenerationControllers?: Record<string, AbortController | null> };
      const generationKey = multiSiteGenerationKey(start);
      const controller = w.__linkedSiteGenerationControllers?.[generationKey];
      if (controller) {
        try { controller.abort(); } catch {}
      }
      registerSharedGenerationController(start, null);
      setSharedGenerationRunningState(start, false);
    } catch {}
  }

  function clearLinkedPlansMemory() {
    if (typeof window === "undefined") return;
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith(multiSiteMemoryPrefix)) keysToRemove.push(key);
      }
      keysToRemove.forEach((key) => sessionStorage.removeItem(key));
    } catch {}
  }

  function getStoredLinkedPlanForSite(start: Date, siteId: string | number) {
    const stored = readLinkedPlansFromMemory(start);
    const current = stored?.plansBySite?.[String(siteId)];
    if (!current || !current.assignments) return null;
    return { stored, current };
  }

  async function clearAutoWeeklyPlanningCacheForCurrentContext() {
    const isoWeek = getWeekKeyISO(weekStart);
    const siteIds = Array.from(
      new Set([
        Number(params.id),
        ...linkedSites.map((linkedSite) => Number(linkedSite.id)).filter(Number.isFinite),
      ]),
    );
    await Promise.all(
      siteIds.map(async (siteId) => {
        try {
          await apiFetch(`/director/sites/${siteId}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=auto`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          });
        } catch {
          // Ignore: absence de brouillon auto ou cache déjà nettoyé.
        }
      }),
    );
  }

  function hasStoredMultiSitePlans(start: Date): boolean {
    const stored = readLinkedPlansFromMemory(start);
    const plansBySite = stored?.plansBySite;
    return !!plansBySite && Object.keys(plansBySite).length > 1;
  }

  function resolveAssignmentsForAlternative(plan: LinkedSitePlan, index: number) {
    if (index <= 0) return plan.assignments;
    return (plan.alternatives || [])[index - 1] || plan.assignments;
  }

  function resolvePullsForAlternative(plan: LinkedSitePlan, index: number) {
    if (index <= 0) return plan.pulls || {};
    return (plan.alternative_pulls || [])[index - 1] || {};
  }

  function reorderLinkedSitePlanCandidates(plan: LinkedSitePlan, orderedIndices: number[]): LinkedSitePlan {
    const candidates = orderedIndices.map((candidateIndex) => ({
      assignments: resolveAssignmentsForAlternative(plan, candidateIndex) || {},
      pulls: resolvePullsForAlternative(plan, candidateIndex) || {},
    }));
    const [nextBaseCandidate, ...nextAlternativeCandidates] = candidates;
    return {
      ...plan,
      assignments: nextBaseCandidate?.assignments || plan.assignments,
      pulls: nextBaseCandidate?.pulls || plan.pulls || {},
      alternatives: nextAlternativeCandidates.map((candidate) => candidate.assignments || {}),
      alternative_pulls: nextAlternativeCandidates.map((candidate) => candidate.pulls || {}),
    };
  }

  function collectSavedAssignmentsBySite(
    siteIds: Array<number | string>,
    excludedSiteId?: number | string,
    overrides?: Record<string, AssignmentsMap | null | undefined>,
  ): Record<string, AssignmentsMap> {
    return Object.fromEntries(
      siteIds.flatMap((siteId) => {
        const siteKey = String(siteId);
        if (excludedSiteId !== undefined && siteKey === String(excludedSiteId)) return [];
        const overrideAssignments = overrides?.[siteKey];
        if (overrideAssignments) return [[siteKey, overrideAssignments] as const];
        const savedPlan = readLocalSavedPlanForSite(Number(siteId));
        if (!savedPlan?.assignments) return [];
        return [[siteKey, savedPlan.assignments] as const];
      }),
    );
  }

  function reorderLinkedPlansForFixedSite(
    plansBySite: Record<string, LinkedSitePlan>,
    fixedSiteId: number,
    fixedAssignments: Record<string, Record<string, string[][]>>,
    preferredIndex: number,
  ): LinkedPlansMemory | null {
    const fixedSitePlan = plansBySite[String(fixedSiteId)];
    if (!fixedSitePlan?.assignments) return null;
    const totalCandidates = getLinkedPlanCandidateCount(fixedSitePlan);
    if (totalCandidates <= 1) return null;

    const compatibleIndices: number[] = [];
    const otherIndices: number[] = [];
    for (let candidateIndex = 0; candidateIndex < totalCandidates; candidateIndex += 1) {
      if (sameAssignmentsMap(resolveAssignmentsForAlternative(fixedSitePlan, candidateIndex), fixedAssignments)) {
        compatibleIndices.push(candidateIndex);
      } else {
        otherIndices.push(candidateIndex);
      }
    }

    if (compatibleIndices.length === 0) return null;

    const preferredCompatible = compatibleIndices.includes(preferredIndex) ? preferredIndex : compatibleIndices[0];
    const orderedIndices = [
      preferredCompatible,
      ...compatibleIndices.filter((candidateIndex) => candidateIndex !== preferredCompatible),
      ...otherIndices,
    ];
    if (orderedIndices.every((candidateIndex, index) => candidateIndex === index)) {
      return {
        activeAltIndex: Math.max(0, orderedIndices.indexOf(preferredCompatible)),
        plansBySite,
      };
    }

    const reorderedPlansBySite = Object.fromEntries(
      Object.entries(plansBySite).map(([siteKey, sitePlan]) => [
        siteKey,
        reorderLinkedSitePlanCandidates(sitePlan, orderedIndices),
      ]),
    ) as Record<string, LinkedSitePlan>;

    return {
      activeAltIndex: Math.max(0, orderedIndices.indexOf(preferredCompatible)),
      plansBySite: reorderedPlansBySite,
    };
  }

  function reorderLinkedPlansForSavedSites(
    plansBySite: Record<string, LinkedSitePlan>,
    fixedAssignmentsBySite: Record<string, AssignmentsMap>,
    preferredIndex: number,
  ): LinkedPlansMemory | null {
    const referencePlan = Object.values(plansBySite).find((plan) => getLinkedPlanCandidateCount(plan) > 1);
    if (!referencePlan?.assignments) return null;
    const fixedEntries = Object.entries(fixedAssignmentsBySite).filter(
      ([siteKey, assignments]) => !!plansBySite[siteKey]?.assignments && !!assignments,
    );
    if (fixedEntries.length === 0) return null;

    const totalCandidates = getLinkedPlanCandidateCount(referencePlan);
    if (totalCandidates <= 1) return null;

    const candidateScores = Array.from({ length: totalCandidates }, (_, candidateIndex) => ({
      candidateIndex,
      score: fixedEntries.reduce((matchedCount, [siteKey, savedAssignments]) => (
        sameAssignmentsMap(resolveAssignmentsForAlternative(plansBySite[siteKey], candidateIndex), savedAssignments)
          ? matchedCount + 1
          : matchedCount
      ), 0),
    }));

    const bestScore = Math.max(...candidateScores.map(({ score }) => score), 0);
    if (bestScore <= 0) return null;

    const preferredBestIndex = candidateScores.some(
      ({ candidateIndex, score }) => candidateIndex === preferredIndex && score === bestScore,
    )
      ? preferredIndex
      : (candidateScores.find(({ score }) => score === bestScore)?.candidateIndex ?? 0);

    const orderedIndices = [
      preferredBestIndex,
      ...candidateScores
        .filter(({ candidateIndex, score }) => candidateIndex !== preferredBestIndex && score === bestScore)
        .map(({ candidateIndex }) => candidateIndex),
      ...candidateScores
        .filter(({ score }) => score < bestScore)
        .sort((a, b) => (b.score - a.score) || (a.candidateIndex - b.candidateIndex))
        .map(({ candidateIndex }) => candidateIndex),
    ];

    const nextActiveAltIndex = Math.max(0, orderedIndices.indexOf(preferredBestIndex));
    const isIdentityOrder = orderedIndices.every((candidateIndex, index) => candidateIndex === index);
    if (isIdentityOrder && nextActiveAltIndex === preferredIndex) return null;

    return {
      activeAltIndex: nextActiveAltIndex,
      plansBySite: isIdentityOrder
        ? plansBySite
        : Object.fromEntries(
            Object.entries(plansBySite).map(([siteKey, sitePlan]) => [
              siteKey,
              reorderLinkedSitePlanCandidates(sitePlan, orderedIndices),
            ]),
          ) as Record<string, LinkedSitePlan>,
    };
  }

  function formatMultiSiteAlternativeLabel(plan: LinkedSitePlan | null | undefined, index: number) {
    const total = 1 + (Array.isArray(plan?.alternatives) ? plan.alternatives.length : 0);
    const safeIndex = Math.min(Math.max(0, Number(index || 0)), Math.max(0, total - 1));
    return `${safeIndex + 1}/${total}`;
  }

  function sameAssignmentsMap(
    a: Record<string, Record<string, string[][]>> | null | undefined,
    b: Record<string, Record<string, string[][]>> | null | undefined,
  ) {
    if (a === b) return true;
    if (!a || !b) return false;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  function samePullsMap(
    a: Record<string, PullEntry> | null | undefined,
    b: Record<string, PullEntry> | null | undefined,
  ) {
    if (a === b) return true;
    if (!a || !b) return false;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  function applyLinkedSitePlan(plan: LinkedSitePlan, index: number) {
    const assignments = resolveAssignmentsForAlternative(plan, index);
    const pulls = resolvePullsForAlternative(plan, index);
    setSavedWeekPlan(null);
    setEditingSaved(false);
    setPullsByHoleKey(pulls || {});
    setPullsEditor(null);
    setAiPlan((prev) => {
      const nextAlternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
      if (
        prev &&
        prev.status === (plan.status || "DONE") &&
        Number(prev.objective || 0) === Number(plan.objective || 0) &&
        prev.days.length === plan.days.length &&
        prev.shifts.length === plan.shifts.length &&
        prev.stations.length === plan.stations.length &&
        (prev.alternatives?.length || 0) === nextAlternatives.length &&
        sameAssignmentsMap(prev.assignments, assignments)
      ) {
        return prev;
      }
      return {
        days: plan.days,
        shifts: plan.shifts,
        stations: plan.stations,
        assignments,
        alternatives: nextAlternatives,
        pulls: plan.pulls || {},
        alternativePulls: Array.isArray(plan.alternative_pulls) ? plan.alternative_pulls : [],
        status: plan.status || "DONE",
        objective: Number(plan.objective || 0),
      };
    });
    setAltIndex((prev) => (prev === index ? prev : index));
    baseAssignmentsRef.current = plan.assignments;
  }

  // Fonction pour extraire les réponses de la semaine actuelle
  function getAnswersForWeek(rawAnswers: any, weekStart: Date): { general: any; perDay: any } | null {
    if (!rawAnswers || typeof rawAnswers !== "object") return null;
    
    const weekKey = getWeekKeyISO(weekStart);
    
    // Si les réponses sont stockées par semaine
    if (weekKey in rawAnswers) {
      const weekAnswers = rawAnswers[weekKey];
      if (weekAnswers && typeof weekAnswers === "object") {
        const general = (weekAnswers.general && typeof weekAnswers.general === "object") ? weekAnswers.general : {};
        const perDay = (weekAnswers.perDay && typeof weekAnswers.perDay === "object") ? weekAnswers.perDay : {};
        return { general, perDay };
      }
    }

    // Format "public register" (ou snapshot) possible: { week_key: "YYYY-MM-DD", general: {...}, perDay: {...} }
    // Dans ce cas, rawAnswers n'est pas un dictionnaire par semaine mais déjà l'objet de la semaine.
    try {
      const wk = String((rawAnswers as any)?.week_key || (rawAnswers as any)?.week_iso || "").trim();
      if (wk && wk === weekKey && (("general" in rawAnswers) || ("perDay" in rawAnswers))) {
        const general = ((rawAnswers as any).general && typeof (rawAnswers as any).general === "object") ? (rawAnswers as any).general : {};
        const perDay = ((rawAnswers as any).perDay && typeof (rawAnswers as any).perDay === "object") ? (rawAnswers as any).perDay : {};
        return { general, perDay };
      }
    } catch {}
    
    // Compatibilité ascendante : si pas de structure par semaine, vérifier si c'est l'ancien format
    if ("general" in rawAnswers || "perDay" in rawAnswers) {
      // C'est l'ancien format, mais on ne l'affiche que si c'est pour la semaine prochaine (où les workers répondent)
      const today = new Date();
      const currentDay = today.getDay();
      const daysUntilNextSunday = currentDay === 0 ? 7 : 7 - currentDay;
      const nextSunday = new Date(today);
      nextSunday.setDate(today.getDate() + daysUntilNextSunday);
      nextSunday.setHours(0, 0, 0, 0);
      
      // Si la semaine actuelle est la semaine prochaine, afficher les réponses (comparer via clé ISO, pas via getTime)
      if (getWeekKeyISO(weekStart) === getWeekKeyISO(nextSunday)) {
        const general = (rawAnswers.general && typeof rawAnswers.general === "object") ? rawAnswers.general : rawAnswers;
        const perDay = (rawAnswers.perDay && typeof rawAnswers.perDay === "object") ? rawAnswers.perDay : {};
        return { general, perDay };
      }
    }
    
    // Pas de réponses pour cette semaine
    return null;
  }

  // Référentiels communs (utilisés par la liste et la modale)
  const dayDefs = useMemo(() => [
    { key: "sun", label: "א'" },
    { key: "mon", label: "ב'" },
    { key: "tue", label: "ג'" },
    { key: "wed", label: "ד'" },
    { key: "thu", label: "ה'" },
    { key: "fri", label: "ו'" },
    { key: "sat", label: "ש'" },
  ], []);

  function mergeWorkerAvailability(
    baseAvailability: Record<string, string[]> | undefined,
    weekOverride: Record<string, string[]> | undefined,
    isNextWeekDisplay: boolean,
  ): WorkerAvailability {
    const merged: WorkerAvailability = { ...EMPTY_WORKER_AVAILABILITY };
    (dayDefs as Array<{ key: string }>).forEach((dayDef) => {
      const dayKey = dayDef.key;
      if (Object.prototype.hasOwnProperty.call(weekOverride || {}, dayKey) && Array.isArray(weekOverride?.[dayKey])) {
        merged[dayKey] = [...(weekOverride?.[dayKey] || [])];
      } else if (isNextWeekDisplay) {
        merged[dayKey] = Array.isArray(baseAvailability?.[dayKey]) ? [...(baseAvailability?.[dayKey] || [])] : [];
      } else {
        merged[dayKey] = [];
      }
    });
    return merged;
  }

  const allShiftNames: string[] = Array.from(
    new Set(
      (site?.config?.stations || [])
        .flatMap((st: any) => (st?.shifts || [])
          .filter((sh: any) => sh?.enabled)
          .map((sh: any) => sh?.name))
        .filter(Boolean)
    )
  );

  // Initialiser/vider les affectations manuelles lors du changement de mode
  useEffect(() => {
    if (!isManual) {
      setManualAssignments(null);
      setPullsModeStationIdx(null);
      return;
    }
    // En ערוך, la grille vient de restoreSavedPlanState / actions utilisateur — ne pas la reconstruire depuis l’AI vide.
    if (editingSaved) return;
    const stationsCount = (site?.config?.stations || []).length || 0;
    if (stationsCount <= 0) return;
    const dayKeys = ["sun","mon","tue","wed","thu","fri","sat"];
    const base: AssignmentsMap = {} as any;
    const hintsBase: RoleHintsMap = {} as any;
    // Après שמור en ידני, aiPlan est mis à null : utiliser aussi le snapshot sauvegardé, sinon l’effet efface toute la grille
    // et il ne reste visibles que les noms injectés par la logique משיכה.
    const assignmentSource: AssignmentsMap | null =
      (aiPlan?.assignments as AssignmentsMap | null | undefined) ||
      (savedWeekPlan?.assignments && typeof savedWeekPlan.assignments === "object"
        ? (savedWeekPlan.assignments as AssignmentsMap)
        : null);
    const getRequiredForLocal = (st: any, shiftName: string, dayKey: string): number => {
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
    };
    for (const d of dayKeys) {
      base[d] = {} as any;
      // compute shift names locally to avoid init order issues
      const shiftNamesLocal: string[] = Array.from(
        new Set(
          (site?.config?.stations || [])
            .flatMap((st: any) => (st?.shifts || [])
              .filter((sh: any) => sh?.enabled)
              .map((sh: any) => sh?.name))
            .filter(Boolean)
        )
      );
      for (const sn of shiftNamesLocal) {
        const fromAI = (assignmentSource as any)?.[d]?.[sn] || [];
        const stationArr: string[][] = [];
        const stationHintsArr: (string | null)[][] = [];
        for (let i = 0; i < stationsCount; i++) {
          const namesOriginal = Array.from((fromAI[i] || []) as string[]);
          const stCfg = (site?.config?.stations || [])[i] || null;
          const req = getRequiredForLocal(stCfg, sn, d);
          // role requirements map
          const reqMap: Record<string, number> = (() => {
            const out: Record<string, number> = {};
            const push = (name?: string, count?: number, enabled?: boolean) => {
              const rn = (name || "").trim();
              const c = Number(count || 0);
              if (!rn || !enabled || c <= 0) return; out[rn] = (out[rn] || 0) + c;
            };
            const st = stCfg;
            if (!st) return out;
            if (st.perDayCustom) {
              const dayCfg = st.dayOverrides?.[d];
              if (!dayCfg || dayCfg.active === false) return out;
              if (st.uniformRoles) { for (const r of (st.roles || [])) push(r?.name, r?.count, r?.enabled); }
              else { const sh = (dayCfg.shifts || []).find((x: any) => x?.name === sn); for (const r of ((sh?.roles as any[]) || [])) push(r?.name, r?.count, r?.enabled); }
              return out;
            }
            if (st.uniformRoles) { for (const r of (st.roles || [])) push(r?.name, r?.count, r?.enabled); }
            else { const sh = (st.shifts || []).find((x: any) => x?.name === sn); for (const r of ((sh?.roles as any[]) || [])) push(r?.name, r?.count, r?.enabled); }
            return out;
          })();
          // Créer un plan de slots avec positions fixes pour les rôles (comme en mode automatique)
          type SlotType = { roleHint: string | null, workerName: string | null };
          const fixedSlots: SlotType[] = [];
          
          // Créer un slot pour chaque rôle requis (dans l'ordre des rôles)
          Object.entries(reqMap).forEach(([rName, rCount]) => {
            for (let i = 0; i < (rCount || 0); i++) {
              fixedSlots.push({ roleHint: rName, workerName: null });
            }
          });
          const totalRoleSlots = fixedSlots.length;
          
          // Ajouter les slots sans rôle pour les assignations restantes
          const remainingRequired = Math.max(0, req - totalRoleSlots);
          for (let i = 0; i < remainingRequired; i++) {
            fixedSlots.push({ roleHint: null, workerName: null });
          }
          
          // Remplir les slots avec les assignations existantes
          const usedSlots = new Set<number>();
          const assignedWithoutRole: string[] = [];
          
          // Déterminer quels noms ont un rôle
          const roles = Object.keys(reqMap);
          const namesWithRole: { nm: string; role: string | null }[] = namesOriginal.map((nm) => {
            let matched: string | null = null;
            for (const rName of roles) { if (workerHasRole(nm, rName)) { matched = rName; break; } }
            return { nm, role: matched };
          });
          
          // D'abord remplir les slots de rôle avec les travailleurs qui ont ce rôle
          namesWithRole.forEach(({ nm, role }) => {
            if (role) {
              // Trouver le premier slot vide pour ce rôle
              for (let j = 0; j < totalRoleSlots; j++) {
                if (usedSlots.has(j)) continue;
                if (fixedSlots[j].roleHint === role) {
                  fixedSlots[j].workerName = nm;
                  usedSlots.add(j);
                  break;
                }
              }
            } else {
              assignedWithoutRole.push(nm);
            }
          });
          
          // Remplir les slots sans rôle avec les travailleurs restants
          let neutralSlotIdx = totalRoleSlots;
          assignedWithoutRole.forEach((nm) => {
            if (neutralSlotIdx < fixedSlots.length) {
              fixedSlots[neutralSlotIdx].workerName = nm;
              neutralSlotIdx++;
            }
          });
          
          // Construire le tableau selon l'ordre fixe
          const cell = fixedSlots.map(slot => slot.workerName || "");
          stationArr.push(cell);
          
          // Construire les hints alignés avec les slots fixes
          const hints = fixedSlots.map(slot => slot.roleHint);
          stationHintsArr.push(hints);
        }
        base[d][sn] = stationArr;
        hintsBase[d] = hintsBase[d] || ({} as any);
        hintsBase[d][sn] = stationHintsArr as any;
      }
    }
    setManualAssignments(base);
    setManualRoleHints(hintsBase);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManual, site?.config?.stations, aiPlan?.assignments, editingSaved, savedWeekPlan?.assignments]);

  const allRoleNames: string[] = Array.from(enabledRoleNameSet).sort((a, b) => a.localeCompare(b));

  function toggleNewAvailability(dayKey: string, shift: string) {
    setNewWorkerAvailability((prev) => {
      const cur = prev[dayKey] || [];
      return {
        ...prev,
        [dayKey]: cur.includes(shift) ? cur.filter((s) => s !== shift) : [...cur, shift],
      };
    });
  }

  useEffect(() => {
    (async () => {
      const me = await fetchMe();
      if (!me) return router.replace("/login/director");
      if (me.role !== "director") return router.replace("/worker");
      const cachedSite = readSessionCache<any>(multiSiteSiteCacheKey(params.id));
      if (cachedSite && String(cachedSite?.id) === String(params.id)) {
        setSite(cachedSite);
        setLoading(false);
      }
      try {
        const data = await apiFetch(`/director/sites/${params.id}`, {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        });
        setSite(data);
        writeSessionCache(multiSiteSiteCacheKey(params.id), data);
      } catch (e: any) {
        // Fallback: tenter via la liste si la lecture directe 404 juste après création
        try {
          const list = await apiFetch<any[]>(`/director/sites/`, {
            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
            cache: "no-store" as any,
          });
          const found = list.find((s: any) => String(s.id) === String(params.id));
          if (found) {
            setSite(found);
            writeSessionCache(multiSiteSiteCacheKey(params.id), found);
          }
          else setError("אתר לא נמצא");
        } catch (err) {
          setError("שגיאה בטעינת אתר");
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [params.id, router]);

  const refreshLinkedSites = useCallback(async () => {
    const cachedLinkedSites = readSessionCache<LinkedSite[]>(multiSiteLinkedSitesCacheKey(params.id, weekStart));
    if (cachedLinkedSites) {
      updateLinkedSites(Array.isArray(cachedLinkedSites) ? cachedLinkedSites : []);
    }
    try {
      const list = await apiFetch<LinkedSite[]>(`/director/sites/${params.id}/linked-sites?week=${encodeURIComponent(getWeekKeyISO(weekStart))}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        cache: "no-store" as any,
      });
      const nextList = Array.isArray(list) ? list : [];
      updateLinkedSites(nextList);
      writeSessionCache(multiSiteLinkedSitesCacheKey(params.id, weekStart), nextList);
    } catch {
      if (!cachedLinkedSites) updateLinkedSites([]);
    }
  }, [params.id, weekStart]);

  useEffect(() => {
    void refreshLinkedSites();
  }, [refreshLinkedSites]);

  useEffect(() => {
    const weekKey = getWeekKeyISO(weekStart);
    linkedSites.forEach((linkedSite) => {
      try {
        router.prefetch?.(`/director/planning/${linkedSite.id}?week=${encodeURIComponent(weekKey)}`);
      } catch {}
    });
  }, [linkedSites, router, weekStart]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const skipClearForInAppNavigation = sessionStorage.getItem(multiSiteNavigationFlag) === "1";
      if (skipClearForInAppNavigation) {
        sessionStorage.removeItem(multiSiteNavigationFlag);
        return;
      }
      const hasCurrentWeekLinkedMemory = !!readLinkedPlansFromMemory(weekStartRef.current || weekStart);
      if (hasCurrentWeekLinkedMemory) {
        return;
      }
      const navEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const legacyNavType = (performance as Performance & { navigation?: { type?: number } }).navigation?.type;
      const isReload = navEntry?.type === "reload" || legacyNavType === 1;
      if (isReload) {
        clearLinkedPlansMemory();
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!isSharedGenerationRunning(weekStart)) {
      const persistedSavedPlan = readLocalSavedPlanForSite(Number(params.id));
      if (persistedSavedPlan?.assignments) {
        restoreSavedPlanState(persistedSavedPlan, "SAVED");
        return;
      }
    }
    let memoryState = readLinkedPlansFromMemory(weekStart);
    const fixedAssignmentsBySite = collectSavedAssignmentsBySite(
      multiSitePullsSites.map((linkedSite) => linkedSite.id),
      Number(params.id),
    );
    const reorderedMemory = memoryState?.plansBySite
      ? reorderLinkedPlansForSavedSites(memoryState.plansBySite, fixedAssignmentsBySite, Number(memoryState.activeAltIndex || 0))
      : null;
    if (reorderedMemory?.plansBySite) {
      saveLinkedPlansToMemory(weekStart, reorderedMemory.plansBySite, reorderedMemory.activeAltIndex, "navigate-saved-sites-sort");
      memoryState = reorderedMemory;
    }
    const currentStoredPlan = memoryState?.plansBySite?.[String(params.id)];
    const storedPlan = currentStoredPlan?.assignments ? { storedMemory: memoryState, currentPlan: currentStoredPlan as LinkedSitePlan } : null;
    setPreserveLinkedAltSelection(false);
    if (!storedPlan) return;
    const { storedMemory, currentPlan } = storedPlan;
    try {
      const rawNavigationLog = sessionStorage.getItem(multiSiteNavigationLogKey(weekStart));
      if (rawNavigationLog) {
        const navigationLog = JSON.parse(rawNavigationLog) as { toSite?: string };
        if (String(navigationLog?.toSite || "") === String(params.id)) {
          setPreserveLinkedAltSelection(true);
        }
      }
    } catch {}
    applyLinkedSitePlan(currentPlan, storedMemory?.activeAltIndex || 0);
  }, [params.id, weekStart, multiSitePullsSites]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storageKey = multiSiteMemoryKey(weekStart);
    const syncFromMemory = () => {
      if (!isSharedGenerationRunning(weekStart)) {
        const persistedSavedPlan = readLocalSavedPlanForSite(Number(params.id));
        if (persistedSavedPlan?.assignments && !editingSaved) {
          restoreSavedPlanState(persistedSavedPlan, "SAVED");
          return;
        }
      }
      let memoryState = readLinkedPlansFromMemory(weekStart);
      const fixedAssignmentsBySite = collectSavedAssignmentsBySite(
        multiSitePullsSites.map((linkedSite) => linkedSite.id),
        Number(params.id),
      );
      const reorderedMemory = memoryState?.plansBySite
        ? reorderLinkedPlansForSavedSites(memoryState.plansBySite, fixedAssignmentsBySite, Number(memoryState.activeAltIndex || 0))
        : null;
      if (reorderedMemory?.plansBySite) {
        saveLinkedPlansToMemory(weekStart, reorderedMemory.plansBySite, reorderedMemory.activeAltIndex, "sync-saved-sites-sort");
        memoryState = reorderedMemory;
      }
      const currentStoredPlan = memoryState?.plansBySite?.[String(params.id)];
      const storedPlan = currentStoredPlan?.assignments ? { storedMemory: memoryState, currentPlan: currentStoredPlan as LinkedSitePlan } : null;
      if (!storedPlan) return;
      const { storedMemory, currentPlan } = storedPlan;
      applyLinkedSitePlan(currentPlan, storedMemory?.activeAltIndex || 0);
    };
    const onLinkedPlansUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{ storageKey?: string }>;
      if (customEvent.detail?.storageKey && customEvent.detail.storageKey !== storageKey) return;
      syncFromMemory();
    };
    window.addEventListener("linked-plans-memory-updated", onLinkedPlansUpdated as EventListener);
    return () => {
      window.removeEventListener("linked-plans-memory-updated", onLinkedPlansUpdated as EventListener);
    };
  }, [params.id, weekStart, editingSaved, multiSitePullsSites]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!displayedAlternativeLabel) return;
    try {
      const linkedMemory = readLinkedPlansFromMemory(weekStart);
      const currentMemoryPlan = linkedMemory?.plansBySite?.[String(params.id)];
      const memoryCandidateCount = getLinkedPlanCandidateCount(currentMemoryPlan);
      const memoryCandidatesBySite = summarizeLinkedMemoryCandidates(linkedMemory);
      const memoryMaxCandidateCount = Math.max(
        0,
        ...Object.values(linkedMemory?.plansBySite || {}).map((plan) => getLinkedPlanCandidateCount(plan)),
      );
      const rawNavigationLog = sessionStorage.getItem(multiSiteNavigationLogKey(weekStart));
      if (!rawNavigationLog) return;
      const navigationLog = JSON.parse(rawNavigationLog) as {
        fromSite?: string;
        fromAlternative?: string;
        fromRawAlternative?: string;
        fromFilteredAlternative?: string;
        fromMemoryCandidates?: number;
        fromMemoryMaxCandidates?: number;
        fromMemoryCandidatesBySite?: Record<string, number>;
        fromFilterCount?: number;
        fromPreserve?: boolean;
        toSite?: string;
      };
      if (String(navigationLog?.toSite || "") !== String(params.id)) return;
      // eslint-disable-next-line no-console
      console.log("[MS][ARRIVE]", {
        fromSite: navigationLog?.fromSite || null,
        fromAlternative: navigationLog?.fromAlternative || null,
        fromRawAlternative: navigationLog?.fromRawAlternative || null,
        fromFilteredAlternative: navigationLog?.fromFilteredAlternative || null,
        fromMemoryCandidates: navigationLog?.fromMemoryCandidates ?? null,
        fromMemoryMaxCandidates: navigationLog?.fromMemoryMaxCandidates ?? null,
        fromMemoryCandidatesBySite: navigationLog?.fromMemoryCandidatesBySite || null,
        fromFilterCount: navigationLog?.fromFilterCount ?? null,
        fromPreserve: navigationLog?.fromPreserve ?? null,
        toSite: params.id,
        toAlternative: displayedAlternativeLabel,
        toRawAlternative: `${Math.max(0, Number(altIndex || 0)) + 1}/${Math.max(0, aiAssignmentsVariants.length)}`,
        toFilteredAlternative: `${filteredAiPlanPosition >= 0 ? filteredAiPlanPosition + 1 : 0}/${filteredAiPlanIndices.length > 0 ? filteredAiPlanIndices.length : aiAssignmentsVariants.length}`,
        toMemoryCandidates: memoryCandidateCount,
        toMemoryMaxCandidates: memoryMaxCandidateCount,
        toMemoryCandidatesBySite: memoryCandidatesBySite,
        toFilterCount: activeAssignmentCountFilters.length,
        toPreserve: preserveLinkedAltSelection,
      });
      sessionStorage.removeItem(multiSiteNavigationLogKey(weekStart));
    } catch {}
  }, [params.id, weekStart, displayedAlternativeLabel]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const generationKey = multiSiteGenerationKey(weekStart);
    const syncGenerationState = () => {
      setSharedGenerationRunning(isSharedGenerationRunning(weekStart));
    };
    syncGenerationState();
    const onGenerationUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{ generationKey?: string }>;
      if (customEvent.detail?.generationKey && customEvent.detail.generationKey !== generationKey) return;
      syncGenerationState();
    };
    window.addEventListener("linked-plans-generation-updated", onGenerationUpdated as EventListener);
    return () => {
      window.removeEventListener("linked-plans-generation-updated", onGenerationUpdated as EventListener);
    };
  }, [weekStart]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storageKey = multiSiteAssignmentFiltersKey(weekStart);
    const syncAssignmentFilters = () => {
      setSharedAssignmentCountFilters(readSharedAssignmentCountFilters(weekStart));
    };
    syncAssignmentFilters();
    const onAssignmentFiltersUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{ storageKey?: string }>;
      if (customEvent.detail?.storageKey && customEvent.detail.storageKey !== storageKey) return;
      syncAssignmentFilters();
    };
    window.addEventListener("linked-assignment-filters-updated", onAssignmentFiltersUpdated as EventListener);
    return () => {
      window.removeEventListener("linked-assignment-filters-updated", onAssignmentFiltersUpdated as EventListener);
    };
  }, [weekStart]);

  // Calculer la semaine prochaine (identique à la page worker)
  function calculateNextWeek(): Date {
    const today = new Date();
    const currentDay = today.getDay(); // 0 = dimanche, 6 = samedi
    const daysUntilNextSunday = currentDay === 0 ? 7 : 7 - currentDay; // Si c'est dimanche, prendre le dimanche suivant
    
    const nextSunday = new Date(today);
    nextSunday.setDate(today.getDate() + daysUntilNextSunday);
    nextSunday.setHours(0, 0, 0, 0);
    
    return nextSunday;
  }

  // Vérifier si la date est la semaine prochaine
  function isNextWeek(date: Date): boolean {
    const nextWeekStart = calculateNextWeek();
    const weekStartNormalized = new Date(date);
    weekStartNormalized.setHours(0, 0, 0, 0);
    
    return weekStartNormalized.getTime() === nextWeekStart.getTime();
  }

  async function loadWorkers() {
    const reqId = ++loadWorkersReqIdRef.current;
    const weekKeyAtCall = weekStart.getTime();
    const cachedWorkers = readSessionCache<Worker[]>(multiSiteWorkersCacheKey(params.id, weekStart));
    try {
      setWorkersLoading(true);
      if (cachedWorkers && reqId === loadWorkersReqIdRef.current) {
        setWorkers(Array.isArray(cachedWorkers) ? cachedWorkers : []);
        setWorkersLoading(false);
      }
      const list = await apiFetch<any[]>(`/director/sites/${params.id}/workers?week=${encodeURIComponent(getWeekKeyISO(weekStart))}`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("access_token")}`,
        },
        cache: "no-store" as any,
      });
      // Si l'utilisateur a déjà changé de semaine/site entre-temps, ignorer cette réponse
      if (reqId !== loadWorkersReqIdRef.current) {
        return;
      }
      if (weekStartRef.current && weekStartRef.current.getTime() !== weekKeyAtCall) {
        return;
      }
      const mapped: Worker[] = (list || []).map((w: any) => ({
        id: w.id,
        name: w.name,
        maxShifts: w.max_shifts ?? w.maxShifts ?? 0,
        roles: Array.isArray(w.roles) ? w.roles : [],
        availability: w.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
        answers: w.answers || {},
        phone: w.phone ?? null,
        linkedSiteIds: Array.isArray(w.linked_site_ids) ? w.linked_site_ids : [],
        linkedSiteNames: Array.isArray(w.linked_site_names) ? w.linked_site_names : [],
        pendingApproval: !!(w.pending_approval ?? w.pendingApproval),
      }));
      writeSessionCache(multiSiteWorkersCacheKey(params.id, weekStart), mapped);

      // --- Handle renames (worker name changed outside planning) ---
      // Build id->previousName map from current workers + saved snapshot
      const prevNameById = new Map<number, string>();
      (workersRef.current || []).forEach((w) => prevNameById.set(Number(w.id), String(w.name || "")));
      (savedWeekPlan?.workers || []).forEach((rw: any) => {
        const id = Number(rw?.id);
        if (!Number.isFinite(id)) return;
        if (!prevNameById.has(id)) prevNameById.set(id, String(rw?.name || ""));
      });
      const renames: Array<{ id: number; from: string; to: string }> = [];
      mapped.forEach((w) => {
        const prev = (prevNameById.get(Number(w.id)) || "").trim();
        const next = (w.name || "").trim();
        if (prev && next && prev !== next) renames.push({ id: Number(w.id), from: prev, to: next });
      });
      const renameMap = new Map<string, string>();
      renames.forEach((r) => renameMap.set(r.from, r.to));

      function replaceNamesInAssignments(assignments: any): any {
        if (!assignments || typeof assignments !== "object") return assignments;
        const next = JSON.parse(JSON.stringify(assignments));
        for (const dayKey of Object.keys(next)) {
          const shifts = next[dayKey] || {};
          for (const shiftName of Object.keys(shifts)) {
            const perStation = shifts[shiftName] || [];
            if (!Array.isArray(perStation)) continue;
            for (let si = 0; si < perStation.length; si++) {
              const arr = perStation[si];
              if (!Array.isArray(arr)) continue;
              perStation[si] = arr.map((nm: any) => {
                const s = String(nm || "");
                return renameMap.get(s) || s;
              });
            }
          }
        }
        return next;
      }

      if (renames.length > 0) {
        // Migrate weeklyAvailability + overlays keys for the displayed week (localStorage is source of truth)
        const currentWeekly = readWeeklyAvailabilityFor(weekStart);
        let changedWeekly = false;
        renames.forEach(({ from, to }) => {
          if (Object.prototype.hasOwnProperty.call(currentWeekly, from) && !Object.prototype.hasOwnProperty.call(currentWeekly, to)) {
            (currentWeekly as any)[to] = (currentWeekly as any)[from];
            delete (currentWeekly as any)[from];
            changedWeekly = true;
          }
          setAvailabilityOverlays((prev) => {
            if (!prev || typeof prev !== "object") return prev;
            if (!Object.prototype.hasOwnProperty.call(prev, from)) return prev;
            if (Object.prototype.hasOwnProperty.call(prev, to)) return prev;
            const cp: any = { ...prev };
            cp[to] = cp[from];
            delete cp[from];
            return cp;
          });
        });
        if (changedWeekly) {
          void saveWeeklyAvailability(currentWeekly as any);
        }

        // Update saved plan snapshot (workers + assignments) so UI shows new names
        setSavedWeekPlan((prev) => {
          if (!prev) return prev;
          const nextWorkers = Array.isArray(prev.workers)
            ? prev.workers.map((rw: any) => {
                const apiW = mapped.find((mw) => Number(mw.id) === Number(rw?.id));
                if (!apiW) return rw;
                return { ...rw, name: apiW.name };
              })
            : prev.workers;
          const nextAssignments = replaceNamesInAssignments(prev.assignments);
          const nextPulls: any = (() => {
            const cur = (prev as any).pulls;
            if (!cur || typeof cur !== "object") return cur;
            const out: any = { ...cur };
            for (const k of Object.keys(out)) {
              const entry = out[k];
              if (!entry) continue;
              const b = entry.before;
              const a = entry.after;
              if (b?.name) b.name = renameMap.get(String(b.name)) || b.name;
              if (a?.name) a.name = renameMap.get(String(a.name)) || a.name;
              out[k] = { ...entry, before: { ...b }, after: { ...a } };
            }
            return out;
          })();
          return { ...prev, workers: nextWorkers as any, assignments: nextAssignments, pulls: nextPulls };
        });

        // Update current in-memory planning maps too
        setAiPlan((prev) => (prev && prev.assignments ? { ...prev, assignments: replaceNamesInAssignments(prev.assignments) } : prev));
        setManualAssignments((prev) => (prev ? (replaceNamesInAssignments(prev) as any) : prev));

        // Update pulls entries too
        setPullsByHoleKey((prev) => {
          if (!prev || typeof prev !== "object") return prev;
          const out: any = { ...prev };
          for (const k of Object.keys(out)) {
            const entry = out[k];
            if (!entry) continue;
            const b = entry.before;
            const a = entry.after;
            const bn = b?.name ? (renameMap.get(String(b.name)) || b.name) : b?.name;
            const an = a?.name ? (renameMap.get(String(a.name)) || a.name) : a?.name;
            out[k] = {
              ...entry,
              before: { ...b, name: bn },
              after: { ...a, name: an },
            };
          }
          return out;
        });
      }
      setWorkers(mapped);
      
      // Si on est sur la semaine prochaine, charger les זמינות depuis la base de données dans weeklyAvailability
      if (isNextWeek(weekStart)) {
        // IMPORTANT: toujours partir des overrides de LA SEMAINE COURANTE (localStorage),
        // sinon on risque d'afficher/sauvegarder les données de la semaine précédente.
        const currentWeekly = readWeeklyAvailabilityFor(weekStart);
        const nextWeekAvail: Record<string, WorkerAvailability> = {};
        mapped.forEach((w) => {
          if (w.availability && Object.keys(w.availability).length > 0) {
            // Vérifier si les זמינות ne sont pas vides
            const hasAvailability = Object.values(w.availability).some((shifts) => Array.isArray(shifts) && shifts.length > 0);
            if (hasAvailability) {
              // Utiliser directement les זמינות de la base de données pour la semaine prochaine
              nextWeekAvail[w.name] = w.availability;
            }
          }
        });
        if (Object.keys(nextWeekAvail).length > 0) {
          const merged: Record<string, WorkerAvailability> = { ...currentWeekly };
          
          // Pour chaque worker, utiliser les זמינות de la base de données si le directeur n'a pas fait de modifications
          Object.keys(nextWeekAvail).forEach((name) => {
            // Si le directeur n'a pas modifié les זמינות pour ce worker, utiliser celles de la base de données
            if (!currentWeekly[name] || Object.keys(currentWeekly[name] || {}).length === 0) {
              merged[name] = nextWeekAvail[name];
            }
          });
          
          // Mettre à jour l'état uniquement.
          // Ne PAS sauvegarder automatiquement pendant le chargement, pour éviter toute contamination entre semaines.
          setWeeklyAvailability(merged);
        }
      } else {
        // Si ce n'est pas la semaine prochaine, utiliser les overrides du localStorage pour CETTE semaine
        setWeeklyAvailability(readWeeklyAvailabilityFor(weekStart));
      }
    } catch (e: any) {
      toast.error("שגיאה בטעינת עובדים", { description: e?.message || "נסה שוב מאוחר יותר." });
    } finally {
      // Ne pas écraser un chargement plus récent (changement de semaine rapide)
      if (reqId === loadWorkersReqIdRef.current && weekStartRef.current && weekStartRef.current.getTime() === weekKeyAtCall) {
        setWorkersLoading(false);
        setWorkersResolvedForPage(true);
      }
    }
  }

  // Rafraîchir uniquement les answers depuis l'API (utile en mode plan sauvegardé/ערוך)
  async function refreshWorkersAnswersFromApi() {
    try {
      const list = await apiFetch<any[]>(`/director/sites/${params.id}/workers?week=${encodeURIComponent(getWeekKeyISO(weekStart))}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        cache: "no-store" as any,
      });
      const byId = new Map<number, any>((list || []).map((w: any) => [Number(w.id), w]));
      // Mettre à jour le state workers
      setWorkers((prev) => {
        const nextWorkers = (prev || []).map((w) => {
          const apiW = byId.get(Number(w.id));
          if (!apiW) return w;
          return { ...w, answers: apiW.answers || {} };
        });
        writeSessionCache(multiSiteWorkersCacheKey(params.id, weekStart), nextWorkers);
        return nextWorkers;
      });
      // Mettre à jour aussi le snapshot du planning sauvegardé si présent
      setSavedWeekPlan((prev) => {
        if (!prev || !Array.isArray(prev.workers) || prev.workers.length === 0) return prev;
        const nextWorkers = prev.workers.map((w: any) => {
          const apiW = byId.get(Number(w.id));
          if (!apiW) return w;
          return { ...w, answers: apiW.answers || {} };
        });
        return { ...prev, workers: nextWorkers };
      });
    } catch (e) {
      void e;
    }
  }

  async function loadExistingWorkersCatalog() {
    setExistingWorkersLoading(true);
    try {
      const [allWorkersList, sitesList] = await Promise.all([
        apiFetch<any[]>("/director/sites/all-workers", {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          cache: "no-store" as any,
        }),
        apiFetch<any[]>("/director/sites/", {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          cache: "no-store" as any,
        }),
      ]);
      const siteNameById = new Map<number, string>(
        (sitesList || []).map((siteItem: any) => [Number(siteItem.id), String(siteItem.name || `אתר #${siteItem.id}`)]),
      );
      const nextCatalog: ExistingWorkerEntry[] = (allWorkersList || []).map((workerItem: any) => ({
        id: Number(workerItem.id),
        siteId: Number(workerItem.site_id),
        siteName: siteNameById.get(Number(workerItem.site_id)) || `אתר #${workerItem.site_id}`,
        name: String(workerItem.name || ""),
        phone: workerItem.phone ?? null,
        maxShifts: Number(workerItem.max_shifts ?? workerItem.maxShifts ?? 5),
        roles: Array.isArray(workerItem.roles) ? workerItem.roles : [],
        availability: workerItem.availability || { ...EMPTY_WORKER_AVAILABILITY },
      }));
      setExistingWorkersCatalog(nextCatalog);
    } catch (e: any) {
      toast.error("שגיאה בטעינת עובדים קיימים", { description: String(e?.message || "") || undefined });
    } finally {
      setExistingWorkersLoading(false);
    }
  }

  async function openExistingWorkerPicker() {
    setIsCreateUserModalOpen(false);
    setExistingWorkerQuery("");
    setIsExistingWorkerModalOpen(true);
    await loadExistingWorkersCatalog();
  }

  async function addExistingWorkerToSite(worker: GroupedExistingWorker) {
    if (!worker.entries.length) return;
    const alreadyOnSite = worker.entries.some((entry) => Number(entry.siteId) === Number(params.id));
    if (alreadyOnSite) {
      toast.error("העובד כבר קיים באתר");
      return;
    }
    const sourceEntry = worker.entries[0];
    setExistingWorkerAddingKey(worker.key);
    try {
      const createdWorker = await apiFetch<any>(`/director/sites/${params.id}/workers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        body: JSON.stringify({
          name: worker.name,
          phone: worker.phone ?? null,
          max_shifts: sourceEntry.maxShifts || 5,
          roles: Array.isArray(sourceEntry.roles) ? sourceEntry.roles : [],
          availability: sourceEntry.availability || {},
        }),
      });
      setWorkers((prev) => {
        const fallbackAvail = { ...EMPTY_WORKER_AVAILABILITY };
        const mapped: Worker = {
          id: createdWorker.id,
          name: String(createdWorker.name),
          maxShifts: createdWorker.max_shifts ?? createdWorker.maxShifts ?? 5,
          roles: Array.isArray(createdWorker.roles) ? createdWorker.roles : [],
          availability: createdWorker.availability || fallbackAvail,
          answers: createdWorker.answers || {},
          phone: createdWorker.phone ?? null,
          linkedSiteIds: Array.isArray(createdWorker.linked_site_ids) ? createdWorker.linked_site_ids : [],
          linkedSiteNames: Array.isArray(createdWorker.linked_site_names) ? createdWorker.linked_site_names : [],
          pendingApproval: !!createdWorker.pending_approval,
        };
        const idx = prev.findIndex((item) => Number(item.id) === Number(mapped.id));
        if (idx >= 0) return prev.map((item) => (Number(item.id) === Number(mapped.id) ? mapped : item));
        return [...prev, mapped];
      });
      setIsExistingWorkerModalOpen(false);
      setExistingWorkerQuery("");
      await loadExistingWorkersCatalog();
      try {
        sessionStorage.removeItem(multiSiteLinkedSitesCacheKey(params.id, weekStart));
      } catch {}
      void refreshLinkedSites();
      toast.success("העובד נוסף לאתר");
    } catch (e: any) {
      toast.error("שגיאה בהוספת עובד קיים", { description: String(e?.message || "") || undefined });
    } finally {
      setExistingWorkerAddingKey(null);
    }
  }

  useEffect(() => {
    setWorkersResolvedForPage(false);
  }, [params.id]);

  useEffect(() => {
    // Changement de semaine/site: réinitialiser les états temporaires (ex: masquage optimiste après suppression)
    setHiddenWorkerIds([]);
    setDeletingId(null);
    loadWorkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id, weekStart]);

  const workerRowsForTable = useMemo(() => {
    const currentWeekly = readWeeklyAvailabilityFor(weekStart);
    const isNextWeekDisplay = isNextWeek(weekStart);
    const hiddenIds = new Set(hiddenWorkerIds);
    const currentWorkersById = new Map<number, Worker>((workers || []).map((worker) => [Number(worker.id), worker]));

    const baseWorkers: Worker[] = (savedWeekPlan?.workers || []).length
      ? (savedWeekPlan!.workers as any[]).map((savedWorker: any) => {
          const currentWorker = currentWorkersById.get(Number(savedWorker.id));
          return {
            id: savedWorker.id,
            name: currentWorker?.name || savedWorker.name,
            maxShifts: currentWorker?.maxShifts ?? savedWorker.max_shifts ?? savedWorker.maxShifts ?? 0,
            roles: Array.isArray(savedWorker.roles) ? savedWorker.roles : [],
            availability: mergeWorkerAvailability(
              (savedWorker.availability || EMPTY_WORKER_AVAILABILITY) as Record<string, string[]>,
              (currentWeekly[savedWorker.name] || {}) as Record<string, string[]>,
              isNextWeekDisplay,
            ),
            answers: currentWorker?.answers || savedWorker.answers || {},
            phone: currentWorker?.phone ?? savedWorker.phone ?? null,
            linkedSiteIds: currentWorker?.linkedSiteIds || [],
            linkedSiteNames: currentWorker?.linkedSiteNames || [],
            pendingApproval: !!currentWorker?.pendingApproval,
          };
        })
      : (workers || []).map((worker) => ({
          ...worker,
          availability: mergeWorkerAvailability(
            (worker.availability || EMPTY_WORKER_AVAILABILITY) as Record<string, string[]>,
            (currentWeekly[worker.name] || {}) as Record<string, string[]>,
            isNextWeekDisplay,
          ),
        }));
    const displayedIds = new Set(baseWorkers.map((worker) => Number(worker.id)));
    const extraWorkers = (workers || [])
      .filter((worker) => !displayedIds.has(Number(worker.id)))
      .map((worker) => ({
        ...worker,
        availability: mergeWorkerAvailability(
          (worker.availability || EMPTY_WORKER_AVAILABILITY) as Record<string, string[]>,
          (currentWeekly[worker.name] || {}) as Record<string, string[]>,
          isNextWeekDisplay,
        ),
      }));

    return [...baseWorkers, ...extraWorkers].filter((worker) => !hiddenIds.has(worker.id));
  }, [hiddenWorkerIds, savedWeekPlan, weekStart, weeklyAvailability, workers]);

  function openWorkerEditor(worker: Worker) {
    // Même base que la ligne du tableau (merge hebdo / saved plan) : indispensable pour ne pas
    // déclencher la pop-up « sites liés » quand seuls nom / rôles changent.
    const nextAvailability = cloneWorkerAvailability(worker.availability);
    setEditingWorkerId(worker.id);
    setNewWorkerName(worker.name);
    setNewWorkerPhone(worker.phone || "");
    setNewWorkerMax(worker.maxShifts);
    setNewWorkerRoles((worker.roles || []).filter((roleName) => enabledRoleNameSet.has(String(roleName || "").trim())));
    setOriginalAvailability(cloneWorkerAvailability(nextAvailability));
    setNewWorkerAvailability(nextAvailability);
    setIsAddModalOpen(true);
  }

  function openPendingInviteApproval(worker: Worker) {
    setPendingInviteWorker(worker);
  }

  const editingWorkerResolved = useMemo(() => {
    if (!editingWorkerId) return null;
    return (
      workers.find((worker) => Number(worker.id) === Number(editingWorkerId)) ||
      ((savedWeekPlan?.workers || []).find((worker: any) => Number(worker?.id) === Number(editingWorkerId)) as any) ||
      null
    );
  }, [editingWorkerId, savedWeekPlan, workers]);

  const editingWorkerLinkedSiteNames = useMemo(() => {
    const linkedSiteNames = Array.isArray((editingWorkerResolved as any)?.linkedSiteNames)
      ? (editingWorkerResolved as any).linkedSiteNames || []
      : (Array.isArray((editingWorkerResolved as any)?.linked_site_names) ? (editingWorkerResolved as any).linked_site_names || [] : []);
    return Array.from(new Set((linkedSiteNames || []).map((siteName: any) => String(siteName || "").trim()).filter(Boolean))) as string[];
  }, [editingWorkerResolved]);

  const workerModalQuestionView = useMemo(() => {
    if (!editingWorkerId) return { hasWeekAnswers: false, generalItems: [], perDayItems: [] };
    const rawAnswers = (editingWorkerResolved as any)?.answers || {};
    const weekAnswers = getAnswersForWeek(rawAnswers, weekStart);
    if (!weekAnswers) return { hasWeekAnswers: false, generalItems: [], perDayItems: [] };

    const questions: any[] = (site?.config?.questions || []) as any[];
    const orderedQuestions = questions.filter((question) => question && question.id && String(question.label || question.question || question.text || "").trim());
    const generalItems = orderedQuestions
      .filter((question) => !question.perDay)
      .map((question) => {
        const questionId = String(question.id);
        const value = (weekAnswers.general || {})[questionId];
        if (value === undefined || value === null || String(value).trim() === "") return null;
        return {
          id: questionId,
          label: String(question.label || question.question || question.text || questionId),
          value: typeof value === "boolean" ? (value ? "כן" : "לא") : String(value),
        };
      })
      .filter(Boolean) as Array<{ id: string; label: string; value: string }>;

    const dayKeyToDate = new Map<string, string>();
    dayDefs.forEach((dayDef, index) => {
      const dt = addDays(weekStart, index);
      dayKeyToDate.set(dayDef.key, `${dayDef.label} (${formatHebDate(dt)})`);
    });

    const perDayItems = orderedQuestions
      .filter((question) => !!question.perDay)
      .map((question) => {
        const questionId = String(question.id);
        const perObj = ((weekAnswers.perDay || {})[questionId] || {}) as Record<string, any>;
        const items = dayDefs
          .map((dayDef) => {
            const value = perObj?.[dayDef.key];
            if (value === undefined || value === null || String(value).trim() === "") return null;
            return {
              dayKey: dayDef.key,
              dayLabel: dayKeyToDate.get(dayDef.key) || dayDef.key,
              value: typeof value === "boolean" ? (value ? "כן" : "לא") : String(value),
            };
          })
          .filter(Boolean) as Array<{ dayKey: string; dayLabel: string; value: string }>;
        if (!items.length) return null;
        return {
          id: questionId,
          label: String(question.label || question.question || question.text || questionId),
          items,
        };
      })
      .filter(Boolean) as Array<{ id: string; label: string; items: Array<{ dayKey: string; dayLabel: string; value: string }> }>;

    return {
      hasWeekAnswers: true,
      generalItems,
      perDayItems,
    };
  }, [dayDefs, editingWorkerId, editingWorkerResolved, site?.config?.questions, weekStart]);

  const workerModalShiftBuckets = useMemo(() => ({
    morningName: allShiftNames.find((shiftName) => /בוקר|^0?6|06-14/i.test(shiftName || "")),
    noonName: allShiftNames.find((shiftName) => /צהריים|14-22|^1?4/i.test(shiftName || "")),
    nightName: allShiftNames.find((shiftName) => /לילה|22-06|^2?2|night/i.test(shiftName || "")),
  }), [allShiftNames]);

  const workerModalBulkSelection = useMemo(() => {
    const isAllSelected = (shiftName?: string) => {
      if (!shiftName) return false;
      return dayDefs.every((dayDef) => (newWorkerAvailability[dayDef.key] || []).includes(shiftName));
    };
    return {
      morningAll: isAllSelected(workerModalShiftBuckets.morningName),
      noonAll: isAllSelected(workerModalShiftBuckets.noonName),
      nightAll: isAllSelected(workerModalShiftBuckets.nightName),
    };
  }, [dayDefs, newWorkerAvailability, workerModalShiftBuckets]);

  const currentWeekWorkersForEditor = useMemo<Worker[]>(() => (
    (savedWeekPlan?.workers || []).length
      ? (savedWeekPlan!.workers as any[]).map((savedWorker: any) => ({
          id: savedWorker.id,
          name: savedWorker.name,
          maxShifts: savedWorker.max_shifts ?? savedWorker.maxShifts ?? 0,
          roles: Array.isArray(savedWorker.roles) ? savedWorker.roles : [],
          availability: savedWorker.availability || { ...EMPTY_WORKER_AVAILABILITY },
          answers: savedWorker.answers || {},
          phone: savedWorker.phone ?? null,
          linkedSiteIds: Array.isArray(savedWorker.linked_site_ids) ? savedWorker.linked_site_ids : [],
          linkedSiteNames: Array.isArray(savedWorker.linked_site_names) ? savedWorker.linked_site_names : [],
        }))
      : workers
  ), [savedWeekPlan, workers]);

  function toggleWorkerAvailabilityForAllDays(shiftName?: string, checked?: boolean) {
    if (!shiftName) return;
    setNewWorkerAvailability((prev) => {
      const next: WorkerAvailability = { ...prev } as WorkerAvailability;
      for (const dayDef of dayDefs) {
        const currentValues = new Set(next[dayDef.key] || []);
        if (checked) currentValues.add(shiftName);
        else currentValues.delete(shiftName);
        next[dayDef.key] = Array.from(currentValues);
      }
      return next;
    });
  }

  async function loadSavedPlanForWeek() {
    const start = new Date(weekStart);
    const isoWeek = getWeekKeyISO(start);
    const requestSiteId = String(params.id);
    const requestId = ++loadSavedPlanReqIdRef.current;
    const keyDirector = planKeyDirectorOnly(params.id, start);
    const keyShared = planKeyShared(params.id, start);
    const shouldRestoreSavedEdit = isMultiSiteSavedEditActiveForCurrentSite(start);
    const isStaleRequest = () =>
      requestId !== loadSavedPlanReqIdRef.current ||
      currentSiteIdRef.current !== requestSiteId ||
      getWeekKeyISO(weekStartRef.current || start) !== isoWeek;
    try {
      const localSavedPlan = !isSharedGenerationRunning(start)
        ? readLocalSavedPlanForSite(Number(params.id))
        : null;
      if (localSavedPlan?.assignments) {
        setSavedPlanLoading(true);
        setEditingSaved(false);
        setPullsModeStationIdx(null);
        setPullsEditor(null);
        if (typeof window !== "undefined") {
          try {
            setActiveSavedPlanKey(localStorage.getItem(keyDirector) ? keyDirector : (localStorage.getItem(keyShared) ? keyShared : null));
          } catch {}
        }
        restoreSavedPlanState(localSavedPlan, "SAVED");
        return;
      }

      // Priorité absolue au planning multi-sites gardé en mémoire, afin de conserver
      // l'alternative active et le flux visuel lorsqu'on change de site pendant ou après génération.
      let linkedMemoryPlans = readLinkedPlansFromMemory(start);
      const fixedAssignmentsBySite = collectSavedAssignmentsBySite(
        multiSitePullsSites.map((linkedSite) => linkedSite.id),
        Number(params.id),
      );
      const reorderedMemory = linkedMemoryPlans?.plansBySite
        ? reorderLinkedPlansForSavedSites(linkedMemoryPlans.plansBySite, fixedAssignmentsBySite, Number(linkedMemoryPlans.activeAltIndex || 0))
        : null;
      if (reorderedMemory?.plansBySite) {
        saveLinkedPlansToMemory(start, reorderedMemory.plansBySite, reorderedMemory.activeAltIndex, "load-saved-sites-sort");
        linkedMemoryPlans = reorderedMemory;
      }
      let linkedCurrentPlan = linkedMemoryPlans?.plansBySite?.[String(params.id)] || null;
      const linkedMemoryMaxCandidateCount = Math.max(
        0,
        ...Object.values(linkedMemoryPlans?.plansBySite || {}).map((plan) => getLinkedPlanCandidateCount(plan)),
      );
      const linkedCurrentCandidateCount = getLinkedPlanCandidateCount(linkedCurrentPlan);
      if (linkedCurrentPlan && linkedCurrentPlan.assignments) {
        const autoPlan = await fetchAutoGeneratedPlanForSite(Number(params.id));
        if (isStaleRequest()) return;
        const autoCandidateCount = getLinkedPlanCandidateCount(autoPlan);
        const shouldPreferAutoPlan =
          !!(autoPlan && autoPlan.assignments) &&
          (
            // Weekly auto-planning draft in DB should win over stale in-memory plans.
            linkedMemoryMaxCandidateCount <= 0 ||
            linkedCurrentCandidateCount < linkedMemoryMaxCandidateCount ||
            autoCandidateCount > 0
          );
        if (shouldPreferAutoPlan) {
          linkedCurrentPlan = autoPlan;
          if (linkedMemoryPlans?.plansBySite && autoPlan) {
            saveLinkedPlansToMemory(
              start,
              {
                ...linkedMemoryPlans.plansBySite,
                [String(params.id)]: autoPlan,
              },
              linkedMemoryPlans?.activeAltIndex || 0,
              "load-saved-plan-auto-priority",
            );
          }
        }
      }
      if (linkedCurrentPlan && linkedCurrentPlan.assignments) {
        setSavedPlanLoading(true);
        setSavedWeekPlan(null);
        setEditingSaved(false);
        setPullsModeStationIdx(null);
        setPullsEditor(null);
        setActiveSavedPlanKey(null);
        applyLinkedSitePlan(linkedCurrentPlan, linkedMemoryPlans?.activeAltIndex || 0);
        setManualAssignments(null);
        return;
      }
      if (isSharedGenerationRunning(start)) {
      setSavedPlanLoading(true);
      setSavedWeekPlan(null);
      setEditingSaved(false);
      setPullsByHoleKey({});
      setPullsModeStationIdx(null);
      setPullsEditor(null);
      setActiveSavedPlanKey(null);
        setAiPlan(null);
        setManualAssignments(null);
        baseAssignmentsRef.current = null;
        return;
      }

      setSavedPlanLoading(true);
      setSavedWeekPlan(null);
      setEditingSaved(false);
      setPullsByHoleKey({});
      setPullsModeStationIdx(null);
      setPullsEditor(null);
      setActiveSavedPlanKey(null);

      if (localSavedPlan?.assignments) {
        const nextSavedPlan = {
          assignments: localSavedPlan.assignments,
          isManual: !!localSavedPlan.isManual,
          workers: Array.isArray(localSavedPlan.workers) ? localSavedPlan.workers : undefined,
          pulls: localSavedPlan.pulls,
        };
        setSavedWeekPlan(nextSavedPlan);
        if (localSavedPlan.pulls && typeof localSavedPlan.pulls === "object") setPullsByHoleKey(localSavedPlan.pulls);
        if (typeof window !== "undefined") {
          try {
            setActiveSavedPlanKey(localStorage.getItem(keyDirector) ? keyDirector : (localStorage.getItem(keyShared) ? keyShared : null));
          } catch {}
        }
      }

      const [fromDirector, fromShared, fromAuto] = await Promise.all([
        fetchWeekPlanScope(Number(params.id), isoWeek, "director"),
        fetchWeekPlanScope(Number(params.id), isoWeek, "shared"),
        fetchWeekPlanScope(Number(params.id), isoWeek, "auto"),
      ]);
      if (isStaleRequest()) return;

        if (fromDirector && typeof fromDirector === "object") {
          setActiveSavedPlanKey("db:director");
          const pulls = (fromDirector?.pulls && typeof fromDirector.pulls === "object") ? fromDirector.pulls : undefined;
          if (fromDirector.assignments) {
          const nextSavedPlan = { assignments: fromDirector.assignments, isManual: !!fromDirector.isManual, workers: Array.isArray(fromDirector.workers) ? fromDirector.workers : undefined, pulls };
          setSavedWeekPlan(nextSavedPlan);
            if (pulls && typeof pulls === "object") setPullsByHoleKey(pulls);
          if (shouldRestoreSavedEdit) activateSavedPlanEdit(nextSavedPlan);
            return;
          }
        }

        if (fromShared && typeof fromShared === "object") {
          setActiveSavedPlanKey("db:shared");
          const pulls = (fromShared?.pulls && typeof fromShared.pulls === "object") ? fromShared.pulls : undefined;
          if (fromShared.assignments) {
          const nextSavedPlan = { assignments: fromShared.assignments, isManual: !!fromShared.isManual, workers: Array.isArray(fromShared.workers) ? fromShared.workers : undefined, pulls };
          setSavedWeekPlan(nextSavedPlan);
            if (pulls && typeof pulls === "object") setPullsByHoleKey(pulls);
          if (shouldRestoreSavedEdit) activateSavedPlanEdit(nextSavedPlan);
            return;
          }
        }

      if (fromAuto && typeof fromAuto === "object" && fromAuto.assignments) {
        setActiveSavedPlanKey("db:auto");
        const pulls = (fromAuto?.pulls && typeof fromAuto.pulls === "object") ? fromAuto.pulls : {};
        setPullsByHoleKey(pulls);
        setAiPlan({
          days: Array.isArray(fromAuto.days) ? fromAuto.days : [],
          shifts: Array.isArray(fromAuto.shifts) ? fromAuto.shifts : [],
          stations: Array.isArray(fromAuto.stations) ? fromAuto.stations : [],
          assignments: fromAuto.assignments,
          alternatives: Array.isArray(fromAuto.alternatives) ? fromAuto.alternatives : [],
          pulls,
          alternativePulls: Array.isArray(fromAuto.alternativePulls)
            ? fromAuto.alternativePulls
            : (Array.isArray(fromAuto.alternative_pulls) ? fromAuto.alternative_pulls : []),
          status: String(fromAuto.status || "DONE"),
          objective: Number(fromAuto.objective || 0),
        });
        baseAssignmentsRef.current = fromAuto.assignments;
        setAltIndex(0);
        setManualAssignments(null);
        return;
      }

      // 2) localStorage fallback (legacy)
      if (isStaleRequest()) return;
      const raw = typeof window !== "undefined" ? (localStorage.getItem(keyDirector) || localStorage.getItem(keyShared)) : null;
      if (typeof window !== "undefined") {
        try { setActiveSavedPlanKey(localStorage.getItem(keyDirector) ? keyDirector : (localStorage.getItem(keyShared) ? keyShared : null)); } catch {}
      }
      if (!raw) {
        setAiPlan(null);
        setManualAssignments(null);
        setAltIndex(0);
        baseAssignmentsRef.current = null;
        return;
      }
      const parsed = JSON.parse(raw);
      if (parsed && parsed.assignments) {
        const pulls = (parsed && parsed.pulls && typeof parsed.pulls === "object") ? parsed.pulls : undefined;
        const nextSavedPlan = { assignments: parsed.assignments, isManual: !!parsed.isManual, workers: Array.isArray(parsed.workers) ? parsed.workers : undefined, pulls };
        setSavedWeekPlan(nextSavedPlan);
        if (pulls && typeof pulls === "object") setPullsByHoleKey(pulls);
        if (shouldRestoreSavedEdit) activateSavedPlanEdit(nextSavedPlan);
      } else {
        setAiPlan(null);
        setManualAssignments(null);
        setAltIndex(0);
        baseAssignmentsRef.current = null;
      }
    } catch {
      if (isStaleRequest()) return;
      setSavedWeekPlan(null);
      setPullsByHoleKey({});
      setPullsModeStationIdx(null);
      setPullsEditor(null);
      setAiPlan(null);
      setManualAssignments(null);
      setAltIndex(0);
      baseAssignmentsRef.current = null;
    } finally {
      if (isStaleRequest()) return;
      setSavedPlanLoading(false);
    }
  }

  // Charger le plan sauvegardé pour la semaine sélectionnée (si existe)
  useEffect(() => {
    void loadSavedPlanForWeek();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id, weekStart]);

  // Synchroniser le mois du calendrier avec la semaine sélectionnée
  useEffect(() => {
    if (!isCalendarOpen) {
      setCalendarMonth(new Date(weekStart.getFullYear(), weekStart.getMonth(), 1));
    }
  }, [weekStart, isCalendarOpen]);

  function stopAiGeneration() {
    const activeWeekStart = weekStartRef.current || weekStart;
    stopSharedGeneration(activeWeekStart);
    if (aiControllerRef.current) {
      try {
        aiControllerRef.current.abort();
      } catch (e) {
        // Ignorer les erreurs d'annulation
      }
      aiControllerRef.current = null;
    }
    if (aiTimeoutRef.current) {
      clearTimeout(aiTimeoutRef.current);
      aiTimeoutRef.current = null;
    }
    if (aiIdleTimeoutRef.current) {
      clearTimeout(aiIdleTimeoutRef.current);
      aiIdleTimeoutRef.current = null;
    }
    setAiLoading(false);
    setSharedGenerationRunning(false);
  }

  useEffect(() => {
    if (!isSavedMode || editingSaved) return;
    if (!isSharedGenerationRunning(weekStart)) {
      stopAiGeneration();
    }
    setAiPlan(null);
    setAltIndex(0);
    baseAssignmentsRef.current = null;
  }, [isSavedMode, editingSaved, weekStart]);

  function triggerGenerateButton() {
    try {
      // If we're in saved mode (button disabled), exit saved mode first
      if (savedWeekPlan && savedWeekPlan.assignments && !editingSaved) {
        try {
          setSavedWeekPlan(null);
          setEditingSaved(true);
        } catch {}
        setTimeout(() => {
          try { triggerGenerateButton(); } catch {}
        }, 0);
        return;
      }
      const btn = document.getElementById('btn-generate-plan') as HTMLButtonElement | null;
      if (btn) {
        if (!btn.disabled) {
          try { 
            btn.click(); 
            return; 
          } catch (e) { 
            void e;
          }
          try { 
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); 
            return; 
          } catch (e) { 
            void e;
          }
        }
      }
    } catch (e) {
      void e;
    }
  }

  function readMultiSiteSavedEditSiteIds(start: Date): number[] {
    if (typeof window === "undefined") return [];
    try {
      const raw = sessionStorage.getItem(multiSiteSavedEditKey(start));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.siteIds)
        ? parsed.siteIds.map((siteId: unknown) => Number(siteId)).filter((siteId: number) => Number.isFinite(siteId))
        : [];
    } catch {
      return [];
    }
  }

  function saveMultiSiteSavedEditSiteIds(start: Date, siteIds: number[]) {
    if (typeof window === "undefined") return;
    const storageKey = multiSiteSavedEditKey(start);
    try {
      if (!siteIds.length) {
        sessionStorage.removeItem(storageKey);
      } else {
        sessionStorage.setItem(storageKey, JSON.stringify({ siteIds }));
      }
    } catch {}
  }

  function clearMultiSiteSavedEditState(start: Date) {
    saveMultiSiteSavedEditSiteIds(start, []);
  }

  function isMultiSiteSavedEditActiveForCurrentSite(start: Date) {
    return readMultiSiteSavedEditSiteIds(start).includes(Number(params.id));
  }

  function buildWorkersSnapshot(sourceWorkers: any[]) {
    return (sourceWorkers || []).map((w) => ({
          id: w.id,
          name: w.name,
          max_shifts: typeof (w as any).max_shifts === "number" ? (w as any).max_shifts : (w.maxShifts ?? 0),
          roles: Array.isArray(w.roles) ? w.roles : [],
          availability: w.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
          answers: ((w as any).answers && typeof (w as any).answers === "object") ? (w as any).answers : {},
      phone: (w as any).phone ?? null,
      linked_site_ids: Array.isArray((w as any).linked_site_ids) ? (w as any).linked_site_ids : ((w as any).linkedSiteIds || []),
      linked_site_names: Array.isArray((w as any).linked_site_names) ? (w as any).linked_site_names : ((w as any).linkedSiteNames || []),
    }));
  }

  async function fetchWorkersSnapshotForSite(siteId: number) {
    if (siteId === Number(params.id)) return buildWorkersSnapshot(workers || []);
    const cachedWorkers = readSessionCache<Worker[]>(multiSiteWorkersCacheKey(siteId, weekStart));
    if (cachedWorkers && cachedWorkers.length) {
      return buildWorkersSnapshot(cachedWorkers);
    }
    const list = await apiFetch<any[]>(`/director/sites/${siteId}/workers?week=${encodeURIComponent(getWeekKeyISO(weekStart))}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
      cache: "no-store" as any,
    });
    const mapped: Worker[] = (list || []).map((w: any) => ({
      id: w.id,
      name: w.name,
      maxShifts: w.max_shifts ?? w.maxShifts ?? 0,
      roles: Array.isArray(w.roles) ? w.roles : [],
      availability: w.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
      answers: w.answers || {},
      phone: w.phone ?? null,
      linkedSiteIds: Array.isArray(w.linked_site_ids) ? w.linked_site_ids : [],
      linkedSiteNames: Array.isArray(w.linked_site_names) ? w.linked_site_names : [],
      pendingApproval: !!(w.pending_approval ?? w.pendingApproval),
    }));
    writeSessionCache(multiSiteWorkersCacheKey(siteId, weekStart), mapped);
    return buildWorkersSnapshot(mapped);
  }

  function readLocalSavedPlanForSite(siteId: number): SavedWeekPlanState | null {
    if (typeof window === "undefined") return null;
    const start = new Date(weekStart);
    try {
      const raw = localStorage.getItem(planKeyDirectorOnly(siteId, start)) || localStorage.getItem(planKeyShared(siteId, start));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed?.assignments) return null;
      return {
        assignments: parsed.assignments,
        isManual: !!parsed.isManual,
        workers: Array.isArray(parsed.workers) ? parsed.workers : undefined,
        pulls: parsed?.pulls && typeof parsed.pulls === "object" ? parsed.pulls : {},
      };
    } catch {
      return null;
    }
  }

  async function fetchWeekPlanScope(siteId: number, isoWeek: string, scope: "director" | "shared" | "auto") {
    try {
      return await apiFetch<any>(`/director/sites/${siteId}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=${scope}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        cache: "no-store" as any,
      });
    } catch {
      return null;
    }
  }

  async function fetchExistingSavedPlanForSite(siteId: number): Promise<SavedWeekPlanState | null> {
    const localSavedPlan = readLocalSavedPlanForSite(siteId);
    if (localSavedPlan?.assignments) return localSavedPlan;
    const start = new Date(weekStart);
    const isoWeek = getWeekKeyISO(start);
    const [fromDirector, fromShared] = await Promise.all([
      fetchWeekPlanScope(siteId, isoWeek, "director"),
      fetchWeekPlanScope(siteId, isoWeek, "shared"),
    ]);
    if (fromDirector?.assignments) {
      return {
        assignments: fromDirector.assignments,
        isManual: !!fromDirector.isManual,
        workers: Array.isArray(fromDirector.workers) ? fromDirector.workers : undefined,
        pulls: fromDirector?.pulls && typeof fromDirector.pulls === "object" ? fromDirector.pulls : {},
      };
    }
    if (fromShared?.assignments) {
      return {
        assignments: fromShared.assignments,
        isManual: !!fromShared.isManual,
        workers: Array.isArray(fromShared.workers) ? fromShared.workers : undefined,
        pulls: fromShared?.pulls && typeof fromShared.pulls === "object" ? fromShared.pulls : {},
      };
    }
    return null;
  }

  function getLinkedPlanCandidateCount(plan: LinkedSitePlan | null | undefined) {
    return (plan?.assignments ? 1 : 0) + (Array.isArray(plan?.alternatives) ? plan.alternatives.length : 0);
  }

  function summarizeLinkedMemoryCandidates(memory: LinkedPlansMemory | null | undefined) {
    return Object.fromEntries(
      Object.entries(memory?.plansBySite || {}).map(([siteKey, plan]) => [
        siteKey,
        getLinkedPlanCandidateCount(plan),
      ]),
    );
  }

  async function fetchAutoGeneratedPlanForSite(siteId: number): Promise<LinkedSitePlan | null> {
    const start = new Date(weekStart);
    const isoWeek = getWeekKeyISO(start);
    try {
      const fromAuto = await apiFetch<any>(`/director/sites/${siteId}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=auto`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        cache: "no-store" as any,
      });
      if (!fromAuto || typeof fromAuto !== "object" || !fromAuto.assignments) return null;
      return {
        site_id: Number(siteId),
        site_name: String((siteId === Number(params.id) ? site?.name : "") || ""),
        days: Array.isArray(fromAuto.days) ? fromAuto.days : [],
        shifts: Array.isArray(fromAuto.shifts) ? fromAuto.shifts : [],
        stations: Array.isArray(fromAuto.stations) ? fromAuto.stations : [],
        assignments: fromAuto.assignments,
        alternatives: Array.isArray(fromAuto.alternatives) ? fromAuto.alternatives : [],
        pulls: fromAuto?.pulls && typeof fromAuto.pulls === "object" ? fromAuto.pulls : {},
        alternative_pulls: Array.isArray(fromAuto.alternativePulls)
          ? fromAuto.alternativePulls
          : (Array.isArray(fromAuto.alternative_pulls) ? fromAuto.alternative_pulls : []),
        status: String(fromAuto.status || "DONE"),
        objective: Number(fromAuto.objective || 0),
      };
    } catch {
      return null;
    }
  }

  function buildWeekPlanPayloadForSite(
    siteId: number,
    assignments: Record<string, Record<string, string[][]>> | null,
    pulls: Record<string, PullEntry>,
    workersSnapshot: any[],
    isManualPlan: boolean,
  ) {
    const start = new Date(weekStart);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return {
      siteId,
      week: { startISO: isoPlanKey(start), endISO: isoPlanKey(end), label: `${formatHebDate(start)} — ${formatHebDate(end)}` },
      isManual: isManualPlan,
      assignments,
      pulls,
      workers: workersSnapshot,
    };
  }

  async function persistWeekPlanForSite(siteId: number, publishToWorkers: boolean, payload: any) {
    const start = new Date(weekStart);
        const scope = publishToWorkers ? "shared" : "director";
    const key = publishToWorkers ? planKeyShared(siteId, start) : planKeyDirectorOnly(siteId, start);
    try {
      await apiFetch<any>(`/director/sites/${siteId}/week-plan`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          body: JSON.stringify({ week_iso: getWeekKeyISO(start), scope, data: payload }),
        });
      if (siteId === Number(params.id)) {
        setActiveSavedPlanKey(scope === "shared" ? "db:shared" : "db:director");
      }
      } catch {}
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(key, JSON.stringify(payload));
          if (publishToWorkers) {
          try { localStorage.removeItem(planKeyDirectorOnly(siteId, start)); } catch {}
          }
        } catch {}
      }
  }

  function mapSavedPlanWorkersToState(planWorkers?: SavedWeekPlanState["workers"]) {
    if (!Array.isArray(planWorkers) || planWorkers.length === 0) return null;
    const existingById = new Map<number, Worker>((workersRef.current || []).map((worker) => [Number(worker.id), worker]));
    return (planWorkers as any[]).map((w: any) => ({
      id: w.id,
      name: String(w.name),
      maxShifts: w.max_shifts ?? w.maxShifts ?? 0,
      roles: Array.isArray(w.roles) ? w.roles : [],
      availability: w.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
      answers: w.answers || {},
      phone: w.phone ?? existingById.get(Number(w.id))?.phone ?? null,
      linkedSiteIds: Array.isArray(w.linked_site_ids) ? w.linked_site_ids : (existingById.get(Number(w.id))?.linkedSiteIds || []),
      linkedSiteNames: Array.isArray(w.linked_site_names) ? w.linked_site_names : (existingById.get(Number(w.id))?.linkedSiteNames || []),
      pendingApproval: !!(w.pending_approval ?? w.pendingApproval ?? existingById.get(Number(w.id))?.pendingApproval),
    }));
  }

  function buildWeeklyAvailabilityFromPlanWorkers(planWorkers?: SavedWeekPlanState["workers"]) {
    if (!Array.isArray(planWorkers) || planWorkers.length === 0) return null;
    try {
      const merged: Record<string, WorkerAvailability> = {} as any;
      (planWorkers as any[]).forEach((rw: any) => {
        const baseAvail = (rw.availability || {}) as Record<string, string[]>;
        const weekOverride = (weeklyAvailability[rw.name] || {}) as Record<string, string[]>;
        const out: WorkerAvailability = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };
        planningDayKeys.forEach((dk) => {
          const s = new Set<string>(Array.isArray(baseAvail[dk]) ? baseAvail[dk] : []);
          (Array.isArray(weekOverride[dk]) ? weekOverride[dk] : []).forEach((sn) => s.add(sn));
          (out as any)[dk] = Array.from(s);
        });
        merged[rw.name] = out;
      });
      return merged;
    } catch {
      return null;
    }
  }

  function restoreSavedPlanState(plan: SavedWeekPlanState, status: string) {
    const assignmentsAny: any = plan.assignments;
    const pulls = (plan.pulls && typeof plan.pulls === "object") ? plan.pulls : {};
    if (plan.isManual) {
      setIsManual(true);
      setManualAssignments(assignmentsAny as any);
      setAiPlan(null);
    } else {
      setIsManual(false);
      setAiPlan({
        days: [...planningDayKeys],
        shifts: planningShiftNames,
        stations: planningStationNames,
        assignments: assignmentsAny,
        alternatives: [],
        status,
        objective: typeof (aiPlan as any)?.objective === "number" ? (aiPlan as any).objective : 0,
      } as any);
    }
    const mappedWorkers = mapSavedPlanWorkersToState(plan.workers);
    if (mappedWorkers) setWorkers(mappedWorkers);
    const mergedWeeklyAvailability = buildWeeklyAvailabilityFromPlanWorkers(plan.workers);
    if (mergedWeeklyAvailability) setWeeklyAvailability(mergedWeeklyAvailability);
    setSavedWeekPlan({
      assignments: plan.assignments,
      isManual: !!plan.isManual,
      workers: Array.isArray(plan.workers) ? plan.workers : undefined,
      pulls,
    });
    setPullsByHoleKey(pulls || {});
    setPullsModeStationIdx(null);
    setPullsEditor(null);
  }

  function activateSavedPlanEdit(planOverride?: SavedWeekPlanState | null) {
    const plan = planOverride || savedWeekPlan;
    if (!plan?.assignments) return;
    savedPlanBeforeEditRef.current = plan;
    restoreSavedPlanState(plan, "SAVED_EDIT");
    setEditingSaved(true);
  }

  function requestMultiSitePlanAction(action: MultiSitePlanAction) {
    if (linkedSites.length > 1) {
      setMultiSitePlanActionDialog({ action, scope: "current_only" });
      return;
    }
    void runMultiSitePlanAction(action, "current_only");
  }

  async function saveCurrentSitePlan(publishToWorkers: boolean) {
    try {
      const currentAssignments = isManual ? manualAssignments : aiPlan?.assignments;
      // Si on n'est pas en train d'éditer, on autorise la sauvegarde d'un plan déjà chargé (savedWeekPlan)
      const fallbackAssignments = savedWeekPlan?.assignments;
      const effective = currentAssignments || fallbackAssignments;
      if (!effective) {
        toast.error("אין מה לשמור", { description: "לא נמצא תכנון קיים לשמירה" });
        return;
      }
      const effectiveIsManual = currentAssignments ? isManual : !!savedWeekPlan?.isManual;
      // Snapshots découplés : évite le partage de référence avec manualAssignments / effets qui mutent
      // (sinon après שמור l’UI peut ne montrer que les משיכות jusqu’au rechargement).
      let assignmentsSnapshot: typeof effective;
      let pullsSnapshot: Record<string, PullEntry>;
      try {
        assignmentsSnapshot = JSON.parse(JSON.stringify(effective)) as typeof effective;
        pullsSnapshot = JSON.parse(JSON.stringify(pullsByHoleKey || {})) as Record<string, PullEntry>;
      } catch {
        assignmentsSnapshot = effective;
        pullsSnapshot = pullsByHoleKey || {};
      }
      const payload = buildWeekPlanPayloadForSite(
        Number(params.id),
        assignmentsSnapshot as Record<string, Record<string, string[][]>>,
        pullsSnapshot,
        buildWorkersSnapshot(workers || []),
        effectiveIsManual,
      );
      await persistWeekPlanForSite(Number(params.id), publishToWorkers, payload);

      // Basculer immédiatement l'UI en mode "plan sauvegardé".
      restoreSavedPlanState({
        assignments: assignmentsSnapshot as Record<string, Record<string, string[][]>>,
        isManual: payload.isManual,
        workers: payload.workers,
        pulls: payload.pulls,
      }, "SAVED");
      setPullsByHoleKey(pullsSnapshot);
      const linkedMemory = readLinkedPlansFromMemory(weekStart);
      if (linkedMemory?.plansBySite && Object.keys(linkedMemory.plansBySite).length > 1) {
        const reorderedMemory = reorderLinkedPlansForSavedSites(
          linkedMemory.plansBySite,
          collectSavedAssignmentsBySite(
            multiSitePullsSites.map((linkedSite) => linkedSite.id),
            undefined,
            { [String(params.id)]: assignmentsSnapshot as AssignmentsMap },
          ),
          Number(linkedMemory.activeAltIndex || altIndex || 0),
        );
        if (reorderedMemory?.plansBySite) {
          saveLinkedPlansToMemory(
            weekStart,
            reorderedMemory.plansBySite,
            reorderedMemory.activeAltIndex,
            "save-current-site-fixed-sort",
          );
        }
      }
      setEditingSaved(false);
      savedPlanBeforeEditRef.current = null;
      clearMultiSiteSavedEditState(weekStart);
      toast.success(publishToWorkers ? "התכנון נשמר ונשלח" : "התכנון נשמר (למנהל בלבד)");
    } catch (e: any) {
      toast.error("שמירה נכשלה", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
    }
  }

  async function saveAllLinkedSitePlans(publishToWorkers: boolean) {
    try {
      const linkedMemory = readLinkedPlansFromMemory(weekStart);
      const activeIndex = Number(linkedMemory?.activeAltIndex || 0);
      const targetSiteIds = multiSitePullsSites.map((linkedSite) => Number(linkedSite.id)).filter((siteId) => Number.isFinite(siteId));
      const preparedPlans = await Promise.all(targetSiteIds.map(async (siteId) => {
        const sitePlan = linkedMemory?.plansBySite?.[String(siteId)];
        let assignments: Record<string, Record<string, string[][]>> | null = null;
        let pulls: Record<string, PullEntry> = {};
        let workersSnapshot: any[] = [];
        let isManualPlan = false;

        if (sitePlan?.assignments) {
          assignments = resolveAssignmentsForAlternative(sitePlan, activeIndex);
          pulls = resolvePullsForAlternative(sitePlan, activeIndex);
          workersSnapshot = await fetchWorkersSnapshotForSite(siteId);
        } else if (siteId === Number(params.id)) {
          const currentAssignments = isManual ? manualAssignments : aiPlan?.assignments;
          const fallbackAssignments = savedWeekPlan?.assignments;
          const effective = currentAssignments || fallbackAssignments;
          if (!effective) {
            throw new Error("לא נמצא תכנון קיים לשמירה באתר הנוכחי.");
          }
          assignments = JSON.parse(JSON.stringify(effective));
          pulls = JSON.parse(JSON.stringify(pullsByHoleKey || {}));
          workersSnapshot = buildWorkersSnapshot(workers || []);
          isManualPlan = currentAssignments ? isManual : !!savedWeekPlan?.isManual;
        } else {
          const localSavedPlan = readLocalSavedPlanForSite(siteId);
          const existingSavedPlan = localSavedPlan || await fetchExistingSavedPlanForSite(siteId);
          if (!existingSavedPlan?.assignments) {
            throw new Error("חסר תכנון שמור באחד האתרים המקושרים, ולכן לא ניתן לשמור את כולם יחד.");
          }
          assignments = existingSavedPlan.assignments;
          pulls = existingSavedPlan.pulls || {};
          workersSnapshot = Array.isArray(existingSavedPlan.workers) && existingSavedPlan.workers.length
            ? buildWorkersSnapshot(existingSavedPlan.workers as any[])
            : await fetchWorkersSnapshotForSite(siteId);
          isManualPlan = !!existingSavedPlan.isManual;
        }

        const payload = buildWeekPlanPayloadForSite(siteId, assignments, pulls, workersSnapshot, isManualPlan);
        return { siteId, assignments, pulls, payload };
      }));

      await Promise.all(preparedPlans.map(({ siteId, payload }) => persistWeekPlanForSite(siteId, publishToWorkers, payload)));

      const currentSitePlan = preparedPlans.find(({ siteId }) => siteId === Number(params.id));
      if (currentSitePlan) {
        restoreSavedPlanState({
          assignments: currentSitePlan.assignments as Record<string, Record<string, string[][]>>,
          isManual: currentSitePlan.payload.isManual,
          workers: currentSitePlan.payload.workers,
          pulls: currentSitePlan.payload.pulls,
        }, "SAVED");
      }
      setEditingSaved(false);
      savedPlanBeforeEditRef.current = null;
      clearMultiSiteSavedEditState(weekStart);
      toast.success(publishToWorkers ? "התכנון נשמר ונשלח לכל האתרים המקושרים" : "התכנון נשמר לכל האתרים המקושרים");
    } catch (e: any) {
      toast.error("שמירה נכשלה", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
    }
  }

  async function onSavePlan(publishToWorkers: boolean) {
    requestMultiSitePlanAction(publishToWorkers ? "save_shared" : "save_director");
  }

  async function runMultiSitePlanAction(action: MultiSitePlanAction, scope: MultiSitePlanActionScope) {
    const applyToAll = scope === "all_sites";
    if (action === "edit") {
      if (applyToAll) saveMultiSiteSavedEditSiteIds(weekStart, multiSitePullsSites.map((linkedSite) => Number(linkedSite.id)).filter((siteId) => Number.isFinite(siteId)));
      else clearMultiSiteSavedEditState(weekStart);
      activateSavedPlanEdit();
      return;
    }
    if (action === "save_director") {
      if (applyToAll) await saveAllLinkedSitePlans(false);
      else await saveCurrentSitePlan(false);
      return;
    }
    if (action === "save_shared") {
      if (applyToAll) await saveAllLinkedSitePlans(true);
      else await saveCurrentSitePlan(true);
      return;
    }
    if (action === "delete") {
      if (applyToAll) {
        const confirmed = window.confirm("האם אתה בטוח שברצונך למחוק את התכנון השבועי מכל האתרים המקושרים? זה ימחק את כל השיבוצים אך ישמור את רשימות העובדים והזמינות שלהם.");
        if (!confirmed) return;
        const targetSiteIds = multiSitePullsSites.map((linkedSite) => Number(linkedSite.id)).filter((siteId) => Number.isFinite(siteId));
        for (const siteId of targetSiteIds) {
          await deletePlanForSite(siteId, siteId === Number(params.id), true, false);
        }
        clearMultiSiteSavedEditState(weekStart);
        toast.success("התכנון נמחק בכל האתרים המקושרים");
      } else {
        await deletePlanForSite(Number(params.id), true);
      }
    }
  }

  function prepareMultiSitePullsDialog() {
    const defaultValue = autoPullsLimit;
    const nextLimits = Object.fromEntries(
      multiSitePullsSites.map((linkedSite) => [String(linkedSite.id), defaultValue]),
    ) as Record<string, string>;
    setMultiSitePullsMode("current_only");
    setMultiSitePullsLimits(nextLimits);
    setShowMultiSitePullsDialog(true);
  }

  function buildMultiSitePullsRequestMap(mode: MultiSitePullsMode, draftLimits: Record<string, string>) {
    const currentSiteId = String(params.id);
    const sourceEntries =
      mode === "current_only"
        ? [[currentSiteId, draftLimits[currentSiteId] ?? autoPullsLimit] as const]
        : Object.entries(draftLimits || {});
    const nextEntries = sourceEntries.filter(([, value]) => value !== "");
    if (!nextEntries.some(([siteId]) => siteId === currentSiteId) && autoPullsLimit !== "") {
      nextEntries.unshift([currentSiteId, draftLimits[currentSiteId] ?? autoPullsLimit]);
    }
    return Object.fromEntries(nextEntries);
  }

  useEffect(() => {
    if (autoPullsEnabled) return;
    multiSitePullsDialogBypassRef.current = false;
    multiSitePullsRequestRef.current = null;
    setShowMultiSitePullsDialog(false);
  }, [autoPullsEnabled]);

  async function onCancelEdit() {
    try {
      clearMultiSiteSavedEditState(weekStart);
      if (savedPlanBeforeEditRef.current?.assignments) {
        restoreSavedPlanState(savedPlanBeforeEditRef.current, "SAVED");
        setEditingSaved(false);
        toast.success("השינויים בוטלו");
        return;
      }
      const start = new Date(weekStart);
      const isoWeek = getWeekKeyISO(start);
      const keyFallback = (() => {
        const dk = planKeyDirectorOnly(params.id, start);
        const sk = planKeyShared(params.id, start);
        try {
          if (typeof window !== "undefined" && localStorage.getItem(dk)) return dk;
        } catch {}
        return sk;
      })();
      const key = activeSavedPlanKey || keyFallback;
      // Prefer DB if activeSavedPlanKey says so
      let parsed: any = null;
      if (String(key).startsWith("db:")) {
        const scope = String(key) === "db:shared" ? "shared" : "director";
        try {
          parsed = await apiFetch<any>(`/director/sites/${params.id}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=${scope}`, {
            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
            cache: "no-store" as any,
          });
        } catch {}
      }
      // Fallback legacy localStorage
      if (!parsed) {
        const raw = typeof window !== "undefined" ? localStorage.getItem(String(key)) : null;
        parsed = raw ? JSON.parse(raw) : null;
      }

      if (!parsed) {
        // Pas de plan sauvegardé, réinitialiser tout
        setAiPlan(null);
        setManualAssignments(null);
        setEditingSaved(false);
        setSavedWeekPlan(null);
        loadWorkers();
        return;
      }
      if (!parsed || !parsed.assignments) {
        // Plan sauvegardé sans assignments, réinitialiser
        setAiPlan(null);
        setManualAssignments(null);
        setEditingSaved(false);
        setSavedWeekPlan(null);
        loadWorkers();
        return;
      }
      const pulls = (parsed && parsed.pulls && typeof parsed.pulls === "object") ? parsed.pulls : {};
      const restoredPlan: SavedWeekPlanState = {
        assignments: parsed.assignments,
        isManual: !!parsed.isManual,
        workers: Array.isArray(parsed.workers) ? parsed.workers : undefined,
        pulls,
      };
      restoreSavedPlanState(restoredPlan, "SAVED");
      if (!Array.isArray(parsed.workers) || parsed.workers.length === 0) {
        loadWorkers();
      }
      setEditingSaved(false);
      toast.success("השינויים בוטלו");
    } catch (e: any) {
      toast.error("ביטול נכשל", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
    }
  }

  async function deletePlanForSite(targetSiteId: number, updateCurrentState: boolean, skipConfirm = false, showSuccessToast = true) {
    try {
      if (updateCurrentState && !savedWeekPlan?.assignments) {
        toast.error("אין מה למחוק", { description: "לא נמצא תכנון לשמירה למחיקה" });
        return;
      }
      if (!skipConfirm) {
      const confirmed = window.confirm("האם אתה בטוח שברצונך למחוק את התכנון השבועי? זה ימחק את כל השיבוצים אך ישמור את רשימת העובדים והזמינות שלהם.");
      if (!confirmed) return;
      }
      const start = new Date(weekStart);
      const isoWeek = getWeekKeyISO(start);
      const keyShared = planKeyShared(targetSiteId, start);
      const keyDirector = planKeyDirectorOnly(targetSiteId, start);
      let parsed: any = null;
      if (updateCurrentState && savedWeekPlan?.assignments) {
        parsed = {
          siteId: targetSiteId,
          week: { startISO: isoPlanKey(start) },
          isManual: !!savedWeekPlan.isManual,
          assignments: savedWeekPlan.assignments,
          pulls: savedWeekPlan.pulls || {},
          workers: Array.isArray(savedWeekPlan.workers) ? savedWeekPlan.workers : [],
        };
      } else {
        const localSavedPlan = readLocalSavedPlanForSite(targetSiteId);
        if (localSavedPlan) {
          parsed = {
            siteId: targetSiteId,
            week: { startISO: isoPlanKey(start) },
            isManual: !!localSavedPlan.isManual,
            assignments: localSavedPlan.assignments,
            pulls: localSavedPlan.pulls || {},
            workers: Array.isArray(localSavedPlan.workers) ? localSavedPlan.workers : [],
          };
        } else {
          const [fromShared, fromDirector] = await Promise.all([
            fetchWeekPlanScope(targetSiteId, isoWeek, "shared"),
            fetchWeekPlanScope(targetSiteId, isoWeek, "director"),
          ]);
          parsed = fromShared || fromDirector || null;
        }
      }

      if (parsed) {
        // Garder les workers, supprimer les assignments (on garde un "record" shared avec assignments=null)
        const payload = {
          siteId: parsed.siteId ?? targetSiteId,
          week: parsed.week ?? { startISO: isoPlanKey(start) },
          isManual: false,
          assignments: null,
          pulls: {},
          workers: parsed.workers || [],
        };
        try {
          await apiFetch<any>(`/director/sites/${targetSiteId}/week-plan`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
            body: JSON.stringify({ week_iso: isoWeek, scope: "shared", data: payload }),
          });
          // supprimer le draft director pour éviter confusion
          try {
            await apiFetch<any>(`/director/sites/${targetSiteId}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=director`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
            });
          } catch {}
          if (updateCurrentState) setActiveSavedPlanKey("db:shared");
        } catch {}
        if (typeof window !== "undefined") {
          try {
            localStorage.setItem(keyShared, JSON.stringify(payload));
            try { localStorage.removeItem(keyDirector); } catch {}
          } catch {}
        }
      } else {
        // Si aucune donnée n'existe, supprimer complètement (DB + local)
        await Promise.allSettled([
          apiFetch<any>(`/director/sites/${targetSiteId}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=shared`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          }),
          apiFetch<any>(`/director/sites/${targetSiteId}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=director`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          }),
        ]);
        if (typeof window !== "undefined") {
          try { localStorage.removeItem(keyShared); } catch {}
          try { localStorage.removeItem(keyDirector); } catch {}
        }
        if (updateCurrentState) setActiveSavedPlanKey(null);
      }
      if (updateCurrentState) {
      setSavedWeekPlan(null);
      setEditingSaved(false);
      setAiPlan(null);
      setManualAssignments(null);
      setPullsByHoleKey({});
      setPullsModeStationIdx(null);
      setPullsEditor(null);
        savedPlanBeforeEditRef.current = null;
        clearMultiSiteSavedEditState(weekStart);
        if (showSuccessToast) toast.success("התכנון נמחק בהצלחה");
      }
    } catch (e: any) {
      toast.error("מחיקה נכשלה", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
    }
  }

  async function onDeletePlan() {
    requestMultiSitePlanAction("delete");
  }

  return (
    <div className="min-h-screen px-3 sm:px-4 lg:px-4 py-6 pb-56 md:pb-40 [&_button]:shadow-sm [&_button]:touch-manipulation [&_button]:select-none [&_button]:transition-[transform,filter,opacity] [&_button]:duration-75 [&_button]:active:scale-[0.98] [&_button]:active:brightness-95">
      <div
        className={
          "mx-auto w-full max-w-none md:max-w-5xl lg:max-w-6xl space-y-6 rounded-xl " +
          (editingSaved
            ? "ring-2 ring-[#00A8E0] ring-offset-4 ring-offset-white dark:ring-offset-zinc-950"
            : (isSavedMode
              ? "ring-2 ring-green-500 ring-offset-4 ring-offset-white dark:ring-offset-zinc-950"
              : ""))
        }
      >
        <div className="flex flex-col gap-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
        <h1 className="text-2xl font-semibold">יצירת תכנון משמרות</h1>
            </div>
          <button
            type="button"
            onClick={() => router.back()}
              className="inline-flex shrink-0 items-center justify-center rounded-md border px-3 py-2 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            aria-label="חזור"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
          </button>
        </div>
          {weekPlanSaveBadgeConfig || (editingSaved && savedWeekPlan?.assignments) ? (
            <div className="sticky top-2 z-[41] flex w-fit max-w-full flex-wrap items-center gap-1.5">
              {editingSaved && savedWeekPlan?.assignments ? (
                <span className="inline-flex items-center rounded-full border border-sky-400 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-900 dark:border-sky-600 dark:bg-sky-950/50 dark:text-sky-100">
                  ערוך
                </span>
              ) : null}
              {weekPlanSaveBadgeConfig ? (
                <span
                  className={`${weekPlanSaveBadgeConfig.className} mr-2 max-w-[calc(100vw-2rem)] sm:mr-3 sm:max-w-[calc(100vw-2.25rem)]`}
                >
                  {weekPlanSaveBadgeConfig.label}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        {showLinkedSitesDialog ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setShowLinkedSitesDialog(false)}
          >
            <div
              className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mb-3 text-center text-base font-semibold">מולטי אתרים</div>
              <div className="mb-3 text-center text-sm font-medium text-orange-600 dark:text-orange-400">
                סה"כ חוסרים: {linkedSitesTotalHoles}
              </div>
              <div className="space-y-2">
                {linkedSiteEntries.map((linkedSite) => (
                  <button
                    key={linkedSite.id}
                    type="button"
                    onClick={() => {
                      const linkedMemory = readLinkedPlansFromMemory(weekStart);
                      if (linkedMemory?.plansBySite) {
                        const fromDisplayedAlternative = displayedAlternativeLabel || "0/0";
                        const fromPlan = linkedMemory.plansBySite[String(params.id)];
                        const toPlan = linkedMemory.plansBySite[String(linkedSite.id)];
                        const memoryCandidatesBySite = summarizeLinkedMemoryCandidates(linkedMemory);
                        const fromMemoryCandidates = getLinkedPlanCandidateCount(fromPlan);
                        const toMemoryCandidates = getLinkedPlanCandidateCount(toPlan);
                        const memoryMaxCandidateCount = Math.max(
                          0,
                          ...Object.values(linkedMemory.plansBySite || {}).map((plan) => getLinkedPlanCandidateCount(plan)),
                        );
                        const rawAlternative = `${Math.max(0, Number(altIndex || 0)) + 1}/${Math.max(0, aiAssignmentsVariants.length)}`;
                        const filteredAlternative = `${filteredAiPlanPosition >= 0 ? filteredAiPlanPosition + 1 : 0}/${filteredAiPlanIndices.length > 0 ? filteredAiPlanIndices.length : aiAssignmentsVariants.length}`;
                        // eslint-disable-next-line no-console
                        console.log("[MS][NAVIGATE]", {
                          fromSite: params.id,
                          fromAlternative: fromDisplayedAlternative,
                          fromRawAlternative: rawAlternative,
                          fromFilteredAlternative: filteredAlternative,
                          fromMemoryCandidates,
                          toMemoryCandidates,
                          memoryMaxCandidates: memoryMaxCandidateCount,
                          memoryCandidatesBySite,
                          filterCount: activeAssignmentCountFilters.length,
                          preserve: preserveLinkedAltSelection,
                          toSite: linkedSite.id,
                        });
                        try {
                          sessionStorage.setItem(
                            multiSiteNavigationLogKey(weekStart),
                            JSON.stringify({
                              fromSite: String(params.id),
                              fromAlternative: fromDisplayedAlternative,
                              fromRawAlternative: rawAlternative,
                              fromFilteredAlternative: filteredAlternative,
                              fromMemoryCandidates,
                              fromMemoryMaxCandidates: memoryMaxCandidateCount,
                              fromMemoryCandidatesBySite: memoryCandidatesBySite,
                              fromFilterCount: activeAssignmentCountFilters.length,
                              fromPreserve: preserveLinkedAltSelection,
                              toSite: String(linkedSite.id),
                            }),
                          );
                        } catch {}
                        saveLinkedPlansToMemory(weekStart, linkedMemory.plansBySite, altIndex, "navigate-before-push");
                      }
                      setShowLinkedSitesDialog(false);
                      try { sessionStorage.setItem(multiSiteNavigationFlag, "1"); } catch {}
                      router.push(`/director/planning/${linkedSite.id}?week=${encodeURIComponent(getWeekKeyISO(weekStart))}`);
                    }}
                    className={
                      "flex w-full items-center justify-between rounded-xl border px-3 py-3 text-right transition-colors " +
                      (String(linkedSite.id) === String(params.id)
                        ? "border-[#00A8E0] bg-sky-50 dark:border-sky-600 dark:bg-sky-950/30"
                        : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800")
                    }
                  >
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{linkedSite.name}</span>
                    <span className="flex flex-col items-end text-sm">
                      <span className="text-zinc-500 dark:text-zinc-400">
                        {linkedSite.assignedCount}/{linkedSite.requiredCount}
                      </span>
                      <span className="text-orange-600 dark:text-orange-400">
                        חוסרים: {linkedSite.holesCount}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={() => setShowLinkedSitesDialog(false)}
                  className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  סגור
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {workerInviteLinkDialog ? (
          <div className="fixed inset-0 z-[84] flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg rounded-2xl border bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
              <div className="space-y-2 text-center">
                <h3 className="text-lg font-semibold">העתק את הלינק לעובד</h3>
                <p className="text-sm text-zinc-500">
                  אפשר להעתיק את הלינק ולשלוח אותו לעובד
                </p>
              </div>
              <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm break-all dark:border-zinc-700 dark:bg-zinc-950">
                {workerInviteLinkDialog}
              </div>
              <div className="mt-5 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setWorkerInviteLinkDialog(null)}
                  className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  סגור
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const copied = await copyTextWithFallback(workerInviteLinkDialog);
                    if (copied) toast.success("הלינק הועתק");
                    else toast.error("לא ניתן להעתיק את הלינק אוטומטית");
                  }}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
                >
                  העתק
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {pendingInviteWorker ? (
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-2xl border bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
              <div className="space-y-2 text-center">
                <h3 className="text-lg font-semibold">אישור עובד חדש</h3>
                <p className="text-sm text-zinc-500">
                  האם לאשר את הוספת {pendingInviteWorker.name} כעובד באתר?
                </p>
              </div>
              <div className="mt-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-800 dark:bg-blue-950/30 dark:text-blue-200">
                אם תאשר  העובד יהפוך לעובד רגיל באתר. אם תסרב, הוא יישאר רשום במערכת אך לא ישויך  לאתר.
              </div>
              <div className="mt-5 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setPendingInviteWorker(null)}
                  disabled={pendingInviteActionLoading}
                  className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  ביטול
                </button>
                <button
                  type="button"
                  disabled={pendingInviteActionLoading}
                  onClick={async () => {
                    if (!pendingInviteWorker) return;
                    try {
                      setPendingInviteActionLoading(true);
                      const approved = await apiFetch<any>(`/director/sites/${params.id}/workers/${pendingInviteWorker.id}/approve-invite`, {
                        method: "POST",
                        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                      });
                      setWorkers((prev) => prev.map((worker) => (
                        worker.id === pendingInviteWorker.id
                          ? {
                              ...worker,
                              name: approved.name,
                              phone: approved.phone ?? null,
                              linkedSiteIds: Array.isArray(approved.linked_site_ids) ? approved.linked_site_ids : [],
                              linkedSiteNames: Array.isArray(approved.linked_site_names) ? approved.linked_site_names : [],
                              pendingApproval: false,
                            }
                          : worker
                      )));
                      setPendingInviteWorker(null);
                      toast.success("העובד אושר ונוסף לאתר");
                    } catch (e: any) {
                      toast.error("אישור העובד נכשל", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
                    } finally {
                      setPendingInviteActionLoading(false);
                    }
                  }}
                  className="rounded-md bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-60"
                >
                  אשר הוספה
                </button>
                <button
                  type="button"
                  disabled={pendingInviteActionLoading}
                  onClick={async () => {
                    if (!pendingInviteWorker) return;
                    try {
                      setPendingInviteActionLoading(true);
                      await apiFetch(`/director/sites/${params.id}/workers/${pendingInviteWorker.id}/reject-invite`, {
                        method: "DELETE",
                        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                      });
                      setWorkers((prev) => prev.filter((worker) => worker.id !== pendingInviteWorker.id));
                      setPendingInviteWorker(null);
                      toast.success("העובד נדחה והוסר מהאתר");
                    } catch (e: any) {
                      toast.error("דחיית העובד נכשלה", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
                    } finally {
                      setPendingInviteActionLoading(false);
                    }
                  }}
                  className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-60"
                >
                  סרב והסר
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {loading || !workersResolvedForPage ? (
          <div className="fixed inset-0 z-50 flex h-screen-mobile min-h-screen-mobile w-screen items-center justify-center overflow-x-hidden overscroll-none bg-white/70 backdrop-blur-md dark:bg-zinc-950/70 dark:backdrop-blur-md">
            <LoadingAnimation size={96} />
          </div>
        ) : error ? (
          <p className="text-red-600">{error}</p>
        ) : (
          <>
          {/* Lazy loading: keep UI visible, show a centered overlay while week data refreshes */}
          {isRefreshingWeekData ? (
            <div className="fixed inset-0 z-50 flex h-screen-mobile min-h-screen-mobile w-screen items-center justify-center overflow-x-hidden overscroll-none bg-white/70 backdrop-blur-md dark:bg-zinc-950/70 dark:backdrop-blur-md">
              <LoadingAnimation size={96} />
            </div>
          ) : null}
          <div className="relative w-full rounded-2xl border p-4 dark:border-zinc-800 space-y-6">
            <div className="mb-2 relative">
              <div className="text-sm text-zinc-500">אתר</div>
              <div className="text-lg font-medium">{site?.name}</div>
              <div className="absolute top-0 left-0 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      setWorkerInviteLinkLoading(true);
                      const result = await apiFetch<{ invite_path: string }>(`/director/sites/${params.id}/worker-invite`, {
                        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                      });
                      const absoluteUrl = typeof window !== "undefined"
                        ? `${window.location.origin}${result.invite_path}`
                        : result.invite_path;
                      const copied = await copyTextWithFallback(absoluteUrl);
                      if (copied) {
                        toast.success("לינק ההרשמה הועתק");
                      } else {
                        setWorkerInviteLinkDialog(absoluteUrl);
                      }
                    } catch (e: any) {
                      toast.error("לא ניתן היה ליצור לינק הזמנה", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
                    } finally {
                      setWorkerInviteLinkLoading(false);
                    }
                  }}
                  disabled={workerInviteLinkLoading}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-sky-300 bg-gradient-to-b from-sky-50 to-sky-100/80 px-3 py-2 text-sm font-medium text-sky-900 shadow-sm transition hover:border-sky-400 hover:from-sky-100 hover:to-sky-100 disabled:opacity-60 dark:border-sky-700 dark:from-sky-950/50 dark:to-sky-950/30 dark:text-sky-100 dark:hover:border-sky-600 dark:hover:from-sky-900/60"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" className="shrink-0 text-sky-700 dark:text-sky-300" fill="currentColor" aria-hidden>
                    <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z" />
                  </svg>
                  {workerInviteLinkLoading ? "מציאת לינק..." : "לינק לעובד"}
                </button>
              <button
                type="button"
                onClick={() => router.push(`/director/sites/${site?.id}/edit`)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 shadow-sm transition hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-500 dark:hover:bg-zinc-800"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" className="shrink-0 text-zinc-600 dark:text-zinc-400" fill="currentColor" aria-hidden>
                    <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.07.63-.07.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                  </svg>
                  הגדרות
              </button>
              </div>
            </div>

            {/* Tableau travailleurs */}
            <section className="space-y-3">
              <h2 className="text-lg font-semibold text-center">עובדים</h2>
              {(() => {
                return (
                  <div className="rounded-md border p-3 space-y-3 dark:border-zinc-700">
                    <div className="flex items-center justify-between">
                      <div className="text-sm text-zinc-500">רשימת עובדים</div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setIsFilterWorkersModalOpen(true);
                            // S'assurer d'avoir les answers à jour (sans dépendre de "שחזור זמינות")
                            void refreshWorkersAnswersFromApi();
                          }}
                          disabled={!Array.isArray(site?.config?.questions) || site.config.questions.length === 0}
                          className={
                            "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm " +
                            (!Array.isArray(site?.config?.questions) || site.config.questions.length === 0
                              ? "border-zinc-200 bg-white text-zinc-400 cursor-not-allowed opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-600"
                              : "border-orange-600 bg-white text-orange-600 hover:bg-orange-50 dark:border-orange-500 dark:bg-zinc-900 dark:text-orange-400 dark:hover:bg-zinc-800")
                          }
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>
                          סינון תשובות
                        </button>
                      <button
                        type="button"
                        onClick={() => {
                          // reset form for add
                          setEditingWorkerId(null);
                          setNewWorkerName("");
                          setNewWorkerPhone("");
                          setNewWorkerMax(5);
                          setNewWorkerRoles([]);
                          setNewWorkerAvailability({ sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });
                          setIsCreateUserModalOpen(true);
                        }}
                        disabled={isSavedMode && !editingSaved}
                        className={
                          "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm " +
                          ((isSavedMode && !editingSaved)
                            ? "border-zinc-200 text-zinc-400 cursor-not-allowed opacity-60 dark:border-zinc-700 dark:text-zinc-600"
                            : "border-green-600 text-green-600 hover:bg-green-50 dark:border-green-500 dark:text-green-400 dark:hover:bg-green-900/30")
                        }
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>
                        הוסף עובד
                      </button>
                    </div>
                    </div>
                      {/* Sur mobile: pas de défilement horizontal (tout doit tenir). Sur desktop: autoriser si besoin. */}
                      <div className="max-h-[26rem] overflow-y-auto overflow-x-hidden md:overflow-x-auto">
                        <table className="w-full table-fixed border-collapse text-[10px] md:text-sm">
                          <thead>
                            <tr className="border-b dark:border-zinc-800">
                              <th className="px-1 md:px-3 py-1 md:py-2 text-center w-20 md:w-40 text-[10px] md:text-sm">שם</th>
                              <th className="px-0.5 md:px-3 py-1 md:py-2 text-center w-12 md:w-auto text-[10px] md:text-sm">מקס'</th>
                              <th className="px-0.5 md:px-3 py-1 md:py-2 text-center w-16 md:w-auto text-[10px] md:text-sm">תפקידים</th>
                              <th className="px-0.5 md:px-3 py-1 md:py-2 text-center w-20 md:w-auto text-[10px] md:text-sm">זמינות</th>
                            </tr>
                          </thead>
                          <tbody>
                          {(() => {
                            const rows = workerRowsForTable;
                            if (rows.length === 0) {
                              return (
                                <tr>
                                  <td colSpan={4} className="px-3 py-6 text-center text-zinc-500">אין עובדים</td>
                                </tr>
                              );
                            }
                            return rows.map((w) => (
                              <tr
                                key={w.id}
                                className={
                                  `border-b last:border-0 dark:border-zinc-800 cursor-pointer ${
                                    w.pendingApproval
                                      ? "bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/30 dark:hover:bg-blue-900/40"
                                      : "hover:bg-zinc-50 dark:hover:bg-zinc-800"
                                  }`
                                }
                                onClick={() => {
                                  if (w.pendingApproval) openPendingInviteApproval(w);
                                  else openWorkerEditor(w);
                                }}
                              >
                                <td className="px-1 md:px-3 py-1 md:py-2 text-center w-20 md:w-40 overflow-hidden">
                                  <span
                                    className="block w-full truncate text-center text-[10px] md:text-sm"
                                    dir={isRtlName(w.name) ? "rtl" : "ltr"}
                                    title={w.name}
                                  >
                                    {w.name}
                                  </span>
                                  {w.pendingApproval && (
                                    <span className="mt-1 inline-block rounded-full bg-blue-600/10 px-2 py-0.5 text-[9px] md:text-[10px] text-blue-700 dark:text-blue-300">
                                      ממתין לאישור
                                    </span>
                                  )}
                                  {(w.linkedSiteIds?.length ?? 0) > 1 ? (
                                    <span className="mt-1 inline-block rounded-full border border-violet-300 bg-violet-50 px-2 py-0.5 text-[9px] md:text-[10px] text-violet-800 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300">
                                      מולטי אתרים
                                    </span>
                                  ) : null}
                                </td>
                                <td className="px-0.5 md:px-3 py-1 md:py-2 text-center text-[10px] md:text-sm">{w.maxShifts}</td>
                                <td className="px-0.5 md:px-3 py-1 md:py-2 text-center text-[10px] md:text-sm break-words whitespace-normal">
                                  {w.roles.filter((rn) => enabledRoleNameSet.has(String(rn || "").trim())).join(",") || "—"}
                                </td>
                                <td className="px-0.5 md:px-3 py-1 md:py-2 text-center text-[10px] md:text-sm break-words whitespace-normal">
                                  {dayDefs.map((d, i) => {
                                    const baseRaw = (w.availability[d.key] || []) as string[];
                                    const base = [...baseRaw].sort((a, b) => displayShiftOrderIndex(a) - displayShiftOrderIndex(b));
                                    const extra = ((availabilityOverlays[w.name]?.[d.key]) || [])
                                      .filter((sn) => !baseRaw.includes(sn))
                                      .sort((a, b) => displayShiftOrderIndex(a) - displayShiftOrderIndex(b));
                                    return (
                                    <span key={d.key} className="block md:inline-block ltr:mr-0.5 md:ltr:mr-2 rtl:ml-0.5 md:rtl:ml-2 text-zinc-600 dark:text-zinc-300">
                                        <span className="font-semibold">{d.label}</span>:
                                        {base.length > 0 ? base.join("/") : "—"}
                                        {extra.length > 0 && (
                                          <>
                                            {base.length > 0 ? "/" : ""}
                                            {extra.map((sn, idx) => (
                                              <span key={sn + idx} className="text-red-600 dark:text-red-400">
                                                {sn}{idx < extra.length - 1 ? "/" : ""}
                                    </span>
                                  ))}
                                          </>
                                        )}
                                        {i < dayDefs.length - 1 ? " " : ""}
                                      </span>
                                    );
                                  })}
                                </td>
                              </tr>
                            ));
                          })()}
                          </tbody>
                        </table>
                      </div>
                  </div>
                );
              })()}
            </section>
          {/* removed per-user request: saved summary shown separately below using standard format */}

            {/* Modal de création d'utilisateur worker (nom + téléphone) */}
            {isCreateUserModalOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="relative mb-3 flex items-center justify-center">
                    <h3 className="text-lg font-semibold text-center">יצירת עובד חדש</h3>
                    <button
                      type="button"
                      onClick={() => setIsCreateUserModalOpen(false)}
                      className="absolute right-2 top-1.5 rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-semibold mb-2">שם העובד</label>
                      <input
                        type="text"
                        value={newWorkerName}
                        onChange={(e) => setNewWorkerName(e.target.value)}
                        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                        placeholder="הזן שם"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold mb-2">מספר טלפון</label>
                      <input
                        type="tel"
                        value={newWorkerPhone}
                        onChange={(e) => setNewWorkerPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                        placeholder="הזן מספר טלפון"
                      />
                      {!!newWorkerPhone && String(newWorkerPhone || "").replace(/\D/g, "").length !== 10 && (
                        <div className="mt-1 text-xs text-red-600">מספר טלפון חייב להכיל בדיוק 10 ספרות</div>
                      )}
                    </div>
                  </div>
                  <div className="mt-4">
                    <button
                      type="button"
                      onClick={() => {
                        void openExistingWorkerPicker();
                      }}
                      className="w-full rounded-md border border-[#00A8E0] px-4 py-2 text-sm font-medium text-[#00A8E0] hover:bg-sky-50 dark:border-sky-700 dark:text-sky-300 dark:hover:bg-sky-950/30"
                    >
                      הוסף עובד קיים
                    </button>
                  </div>
                  <div className="mt-4 flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsCreateUserModalOpen(false)}
                      className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                      ביטול
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const trimmedName = newWorkerName.trim();
                        const digitsPhone = String(newWorkerPhone || "").replace(/\D/g, "").trim();
                        if (!trimmedName || !digitsPhone) {
                          toast.error("נא למלא את כל השדות");
                          return;
                        }
                        if (digitsPhone.length !== 10) {
                          toast.error("מספר הטלפון חייב להכיל 10 ספרות");
                          return;
                        }
                        let userCreated = false;
                        try {
                          // Utiliser la liste locale évite un aller-retour avant la création.
                            const normalizePhoneDigits = (p: any) => String(p || "").replace(/\D/g, "").trim();
                            const phoneN = normalizePhoneDigits(digitsPhone);
                          const alreadyOnSite = workers.some((w: any) => normalizePhoneDigits(w?.phone) === phoneN);
                            if (alreadyOnSite) {
                              toast.error("העובד כבר קיים באתר");
                              return;
                          }

                          // Créer l'utilisateur worker
                          try {
                            await apiFetch<any>(`/director/sites/${params.id}/create-worker-user`, {
                            method: "POST",
                            headers: { 
                              Authorization: `Bearer ${localStorage.getItem("access_token")}`,
                              "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                              name: trimmedName,
                              phone: digitsPhone,
                            }),
                          });
                            userCreated = true;
                          } catch (userError: any) {
                            // Si le User existe déjà (téléphone déjà utilisé - erreur 400), continuer quand même
                            const errorStatus = userError?.status || 0;
                            const errorMsg = String(userError?.message || "").toLowerCase();
                            const isPhoneAlreadyUsed = errorStatus === 400 || 
                              errorMsg.includes("téléphone") || 
                              errorMsg.includes("telephone") ||
                              errorMsg.includes("déjà") || 
                              errorMsg.includes("deja") ||
                              errorMsg.includes("déjà enregistré") ||
                              errorMsg.includes("already");
                            
                            if (isPhoneAlreadyUsed) {
                              // Ne pas afficher d'erreur, on va quand même créer le SiteWorker
                            } else {
                              // Pour les autres erreurs, re-lancer
                              throw userError;
                            }
                          }
                          
                          // Créer immédiatement le SiteWorker avec זמינות vide.
                          // Ainsi, si on clique sur "ביטול" dans הוספת עובד, le worker reste dans le site (sans זמינות).
                          const createdWorker = await apiFetch<any>(`/director/sites/${params.id}/workers`, {
                            method: "POST",
                            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                            body: JSON.stringify({
                              name: trimmedName,
                              phone: digitsPhone,
                              max_shifts: 5,
                              roles: [],
                              availability: {},
                            }),
                          });

                          // Mettre à jour la liste localement pour afficher le worker tout de suite
                          setWorkers((prev) => {
                            const fallbackAvail = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };
                            const mapped: Worker = {
                              id: createdWorker.id,
                              name: String(createdWorker.name),
                              maxShifts: createdWorker.max_shifts ?? createdWorker.maxShifts ?? 5,
                              roles: Array.isArray(createdWorker.roles) ? createdWorker.roles : [],
                              availability: createdWorker.availability || fallbackAvail,
                              answers: createdWorker.answers || {},
                              phone: createdWorker.phone ?? null,
                            };
                            const idx = prev.findIndex((w) => w.id === mapped.id);
                            if (idx >= 0) return prev.map((w) => (w.id === mapped.id ? mapped : w));
                            return [...prev, mapped];
                          });

                          // Préparer la modale d'édition des זמינות pour ce nouveau worker
                          setEditingWorkerId(createdWorker.id);
                          setNewWorkerName(trimmedName);
                          setNewWorkerPhone(digitsPhone);
                          setNewWorkerMax(5);
                          setNewWorkerRoles([]);
                          setOriginalAvailability({ sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });
                          setNewWorkerAvailability({ sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });

                          // Continuer à ouvrir le modal des זמינות même si le User existe déjà
                          setIsCreateUserModalOpen(false);
                          // Ouvrir le modal des זמינות avec le nom pré-rempli
                          setIsAddModalOpen(true);
                          if (userCreated) {
                            toast.success("עובד נוצר בהצלחה!");
                          } else {
                            toast.info("משתמש קיים כבר, הוסף את העובד לאתר");
                          }
                        } catch (e: any) {
                          const msg = String(e?.message || "");
                          toast.error("שגיאה ביצירת עובד", { description: msg || "נסה שוב מאוחר יותר." });
                        }
                      }}
                      className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6]"
                    >
                      המשך
                    </button>
                  </div>
                </div>
              </div>
            )}

            {isExistingWorkerModalOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                <div className="flex h-[72vh] h-[72dvh] w-full max-w-3xl min-h-0 flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900 md:h-[34rem]">
                  <div className="border-b border-zinc-200 bg-white/95 p-3 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/95 md:p-4">
                    <div className="relative flex items-center justify-center">
                      <h3 className="text-base font-semibold text-center md:text-lg">הוספת עובד קיים</h3>
                      <button
                        type="button"
                        onClick={() => setIsExistingWorkerModalOpen(false)}
                        className="absolute right-2 top-1.5 rounded-md border px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800 md:text-sm"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="mt-3">
                      <input
                        type="text"
                        value={existingWorkerQuery}
                        onChange={(e) => setExistingWorkerQuery(e.target.value)}
                        placeholder="חיפוש לפי שם, טלפון או אתר"
                        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                      />
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto p-3 md:p-4">
                    {existingWorkersLoading ? (
                      <div className="flex h-full items-center justify-center text-sm text-zinc-500">טוען עובדים...</div>
                    ) : filteredExistingWorkers.length === 0 ? (
                      <div className="flex h-full items-center justify-center text-sm text-zinc-500">לא נמצאו עובדים</div>
                    ) : (
                      <div className="space-y-3">
                        {filteredExistingWorkers.map((worker) => {
                          const alreadyOnSite = worker.entries.some((entry) => Number(entry.siteId) === Number(params.id));
                          const isAdding = existingWorkerAddingKey === worker.key;
                          return (
                            <div
                              key={worker.key}
                              className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-950/30"
                            >
                              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100 md:text-base">
                                    {worker.name}
                                  </div>
                                  {!!worker.phone && (
                                    <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{worker.phone}</div>
                                  )}
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    {worker.entries.map((entry) => (
                                      <span
                                        key={`${worker.key}_${entry.siteId}`}
                                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${getExistingWorkerBadgeClassName(entry.siteId)}`}
                                      >
                                        {entry.siteName}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                                <div className="flex shrink-0 items-center justify-end">
                                  <button
                                    type="button"
                                    disabled={alreadyOnSite || isAdding}
                                    onClick={() => {
                                      void addExistingWorkerToSite(worker);
                                    }}
                                    className={`rounded-md px-3 py-2 text-sm font-medium ${
                                      alreadyOnSite
                                        ? "cursor-not-allowed border border-zinc-200 bg-zinc-100 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-600"
                                        : "bg-[#00A8E0] text-white hover:bg-[#0092c6]"
                                    }`}
                                  >
                                    {alreadyOnSite ? "כבר באתר" : isAdding ? "מוסיף..." : "הוסף"}
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Modal d'ajout d'employé */}
            {isAddModalOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                {/* Fixed height so the Q/A section requires scrolling (web + mobile).
                    Use vh fallback (some browsers ignore dvh). */}
                <div className="w-full max-w-3xl h-[72vh] h-[72dvh] md:h-[34rem] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900 flex flex-col min-h-0">
                  <div className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/95 p-3 md:p-4">
                    <div className="relative flex items-center justify-center">
                    <h3 className="text-base md:text-lg font-semibold text-center">{editingWorkerId ? "עריכת עובד" : "הוספת עובד"}</h3>
                    <button
                      type="button"
                      onClick={() => setIsAddModalOpen(false)}
                      className="absolute right-2 top-1.5 rounded-md border px-2 py-1 text-xs md:text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      ✕
                    </button>
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto p-3 md:p-4">
                  <div className="grid grid-cols-1 gap-2 md:gap-3 md:grid-cols-4 justify-items-center text-center">
                    <div>
                      <label className="block text-xs md:text-sm font-semibold">שם</label>
                      <input
                        type="text"
                        value={newWorkerName}
                        onChange={(e) => setNewWorkerName(e.target.value)}
                        className="w-full rounded-md border border-zinc-300 bg-white px-2 md:px-3 py-1.5 md:py-2 text-sm md:text-base text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                      />
                    </div>
                    <div>
                      <label className="block text-xs md:text-sm font-semibold">מקס' משמרות בשבוע</label>
                      <NumberPicker
                        value={newWorkerMax}
                        onChange={(value) => setNewWorkerMax(Math.max(0, Math.min(6, value)))}
                        min={0}
                        max={6}
                        className="w-full rounded-md border border-zinc-300 bg-white px-2 md:px-3 py-1.5 md:py-2 text-sm md:text-base text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <div className="block text-sm font-semibold mb-1">תפקידים</div>
                      <div className="flex flex-wrap justify-center gap-2 text-sm">
                        {allRoleNames.length === 0 ? (
                          <span className="text-zinc-500">אין תפקידים מוגדרים</span>
                        ) : (
                          allRoleNames.map((rn) => (
                            <label key={rn} className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={newWorkerRoles.includes(rn)}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setNewWorkerRoles((prev) => (checked ? [...prev, rn] : prev.filter((x) => x !== rn)));
                                }}
                              />
                              {rn}
                            </label>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                  {editingWorkerLinkedSiteNames.length > 1 && (
                      <div className="mt-3 flex w-full flex-col items-center text-center">
                        <div className="w-full text-center text-[11px] md:text-xs font-medium text-zinc-500 dark:text-zinc-400">
                          משויך לאתרים:
                        </div>
                        <div className="mt-1 flex w-full items-center justify-center gap-1.5 overflow-x-auto whitespace-nowrap pb-1">
                          {editingWorkerLinkedSiteNames.map((siteName: string) => (
                            <span
                              key={siteName}
                              className="shrink-0 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] md:text-xs font-medium text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
                            >
                              {siteName}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  <div className="mt-3 text-center">
                    <div className="block text-sm font-semibold mb-1">זמינות לפי יום/משמרת</div>
                    <div className="space-y-2">
                          <div className="mb-2 flex flex-wrap items-center justify-center gap-4 text-sm">
                            <label className="inline-flex items-center gap-2 opacity-100">
                              <input
                                type="checkbox"
                                disabled={!workerModalShiftBuckets.morningName}
                                checked={!!workerModalShiftBuckets.morningName && workerModalBulkSelection.morningAll}
                                onChange={(e) => toggleWorkerAvailabilityForAllDays(workerModalShiftBuckets.morningName, e.target.checked)}
                              />
                              כל הבוקר
                            </label>
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                disabled={!workerModalShiftBuckets.noonName}
                                checked={!!workerModalShiftBuckets.noonName && workerModalBulkSelection.noonAll}
                                onChange={(e) => toggleWorkerAvailabilityForAllDays(workerModalShiftBuckets.noonName, e.target.checked)}
                              />
                              כל הצהריים
                            </label>
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                disabled={!workerModalShiftBuckets.nightName}
                                checked={!!workerModalShiftBuckets.nightName && workerModalBulkSelection.nightAll}
                                onChange={(e) => toggleWorkerAvailabilityForAllDays(workerModalShiftBuckets.nightName, e.target.checked)}
                              />
                              כל הלילה
                            </label>
                          </div>
                      {dayDefs.map((d) => (
                        <div key={d.key} className="flex flex-wrap items-center justify-center gap-3 text-sm">
                          <div className="w-10 text-zinc-600 dark:text-zinc-300">{d.label}</div>
                          {allShiftNames.length === 0 ? (
                            <span className="text-zinc-500">אין משמרות פעילות</span>
                          ) : (
                            allShiftNames.map((sn) => (
                              <label key={sn} className="inline-flex items-center gap-1">
                                <input
                                  type="checkbox"
                                  checked={(newWorkerAvailability[d.key] || []).includes(sn)}
                                  onChange={() => toggleNewAvailability(d.key, sn)}
                                />
                                {sn}
                              </label>
                            ))
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Réponses aux questions optionnelles (du worker) */}
                  {(() => {
                    if (!editingWorkerId) return null;
                    if (!workerModalQuestionView.hasWeekAnswers) {
                      return (
                        <div className="mt-4 rounded-md border border-zinc-200 p-3 text-sm text-center text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                          אין תשובות לשאלות עבור השבוע הנוכחי
                        </div>
                      );
                    }
                    if (!workerModalQuestionView.generalItems.length && !workerModalQuestionView.perDayItems.length) return null;

                    return (
                      <div className="mt-4 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-700">
                        <div className="mb-2 font-semibold">שאלות נוספות</div>
                        <div className="space-y-2">
                          {/* Questions générales dans l'ordre de création */}
                          {workerModalQuestionView.generalItems.map((item) => {
                            return (
                              <div key={`g_${item.id}`} className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                                <div className="text-zinc-700 dark:text-zinc-200">{item.label}</div>
                                <div className="font-medium text-zinc-900 dark:text-zinc-100">
                                  {item.value}
                                </div>
                              </div>
                            );
                          })}

                          {/* Questions par jour dans l'ordre de création */}
                          {workerModalQuestionView.perDayItems.map((item) => {
                            return (
                              <div key={`p_${item.id}`} className="rounded-md border border-zinc-100 p-2 dark:border-zinc-800">
                                <div className="mb-1 font-medium text-zinc-800 dark:text-zinc-200">
                                  {item.label}
                                </div>
                                <div className="space-y-1">
                                  {item.items.map((dayItem) => {
                                    return (
                                      <div key={`${item.id}_${dayItem.dayKey}`} className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                                        <div className="text-zinc-600 dark:text-zinc-300">
                                          {dayItem.dayLabel}
                                        </div>
                                        <div className="font-medium text-zinc-900 dark:text-zinc-100">
                                          {dayItem.value}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  </div>
                  <div className="flex items-center justify-center gap-2 flex-wrap border-t border-zinc-200 bg-white/95 px-3 py-3 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/95 md:px-4">
                    <button
                      type="button"
                      onClick={() => setIsAddModalOpen(false)}
                      className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                      ביטול
                    </button>
                    {isNextWeek(weekStart) && (
                      <button
                        type="button"
                        onClick={() => {
                          const baseAvailability = originalAvailability || editingWorkerResolved?.availability || EMPTY_WORKER_AVAILABILITY;
                          setNewWorkerAvailability({ ...baseAvailability });
                            toast.info("הזמינות חזרה להגדרת העובד מהמערכת");
                        }}
                        className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                      >
                        שחזר זמינות מהעובד
                      </button>
                    )}
                    {/* Suppression depuis la popup "עריכת עובד" */}
                    {editingWorkerId && (
                      <button
                        type="button"
                        className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-60"
                        disabled={(isSavedMode && !editingSaved) || deletingId === editingWorkerId}
                        onClick={async () => {
                          const wid = editingWorkerId;
                          if (!wid) return;
                          if (!confirm(`למחוק את ${newWorkerName}?`)) return;
                          setDeletingId(wid);
                          setHiddenWorkerIds((prev) => (prev.includes(wid) ? prev : [...prev, wid]));
                          const previousWorkers = workers;
                          setWorkers((prev) => prev.filter((x) => x.id !== wid));
                          setSavedWeekPlan((prev) => {
                            if (!prev) return prev;
                            const prevWorkers = Array.isArray(prev.workers) ? prev.workers : [];
                            return { ...prev, workers: prevWorkers.filter((rw: any) => Number(rw?.id) !== Number(wid)) };
                          });
                          try {
                            await apiFetch(`/director/sites/${params.id}/workers/${wid}`, {
                              method: "DELETE",
                              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                            });
                            void refreshLinkedSites();
                            toast.success("העובד נמחק בהצלחה");
                            setIsAddModalOpen(false);
                            setEditingWorkerId(null);
                          } catch (e: any) {
                            setWorkers(previousWorkers);
                            setHiddenWorkerIds((prev) => prev.filter((id) => id !== wid));
                            toast.error("שגיאה במחיקה", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
                          } finally {
                            setDeletingId(null);
                          }
                        }}
                      >
                        מחק עובד
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={async () => {
                        if (workerModalSaving) return;
                        setWorkerModalSaving(true);
                        const trimmed = newWorkerName.trim();
                        if (!trimmed) return;
                        const DUP_MSG = "שם עובד כבר קיים באתר";
                        // Utiliser la même logique que displayWorkers : vérifier uniquement dans la liste de la semaine actuelle
                        const currentWeekWorkers = currentWeekWorkersForEditor;
                        // Pré-vérification côté client pour éviter un aller-retour inutile
                        if (!editingWorkerId) {
                          // Vérifier d'abord dans la semaine actuelle - si présent, bloquer
                          if (currentWeekWorkers.some((w) => (w.name || "").trim().toLowerCase() === trimmed.toLowerCase())) {
                            toast.info(DUP_MSG);
                            return;
                          }
                          // Si pas dans la semaine actuelle, vérifier si existe dans tous les workers du site
                          // Si oui, on le réutilisera (autorisé)
                          // Si non, nouveau worker (autorisé aussi)
                        } else {
                          // En mode édition, vérifier les doublons dans la semaine actuelle (sauf le worker en cours d'édition)
                          if (currentWeekWorkers.some((w) => w.id !== editingWorkerId && (w.name || "").trim().toLowerCase() === trimmed.toLowerCase())) {
                            toast.info(DUP_MSG);
                            return;
                          }
                        }
                        try {
                          if (editingWorkerId) {
                            const currentWorker = editingWorkerResolved;
                            const availabilityChanged = isAvailabilityDayShiftChanged(
                              originalAvailability || EMPTY_WORKER_AVAILABILITY,
                              newWorkerAvailability || EMPTY_WORKER_AVAILABILITY,
                            );
                            const maxShiftsChanged = Number(currentWorker?.maxShifts ?? 0) !== Number(newWorkerMax || 0);
                            const normalizeRoles = (roles: string[]) => (
                              Array.from(new Set((roles || []).map((roleName) => String(roleName || "").trim()).filter(Boolean))).sort()
                            );
                            const rolesBefore = normalizeRoles(Array.isArray(currentWorker?.roles) ? currentWorker!.roles : []);
                            const rolesAfter = normalizeRoles(Array.isArray(newWorkerRoles) ? newWorkerRoles : []);
                            const rolesChanged = JSON.stringify(rolesBefore) !== JSON.stringify(rolesAfter);
                            const linkedSiteNames: string[] = Array.isArray(currentWorker?.linkedSiteNames) ? currentWorker?.linkedSiteNames || [] : [];
                            const linkedOtherSiteNames = linkedSiteNames.filter((siteName) => String(siteName) !== String(site?.name || ""));
                            const submitEditedWorker = async (propagateLinkedAvailability: boolean) => {
                            const updated = await apiFetch<any>(`/director/sites/${params.id}/workers/${editingWorkerId}`, {
                              method: "PUT",
                              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                              body: JSON.stringify({
                                name: trimmed,
                                max_shifts: newWorkerMax,
                                roles: newWorkerRoles,
                                  week_iso: getWeekKeyISO(weekStart),
                                  weekly_availability: newWorkerAvailability,
                                  propagate_linked_availability: propagateLinkedAvailability,
                              }),
                            });
                            const mapped: Worker = {
                              id: updated.id,
                              name: updated.name,
                              maxShifts: updated.max_shifts ?? updated.maxShifts ?? 0,
                              roles: Array.isArray(updated.roles) ? updated.roles : [],
                              availability: updated.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
                              answers: updated.answers || {},
                                phone: updated.phone ?? null,
                                linkedSiteIds: Array.isArray(updated.linked_site_ids) ? updated.linked_site_ids : [],
                                linkedSiteNames: Array.isArray(updated.linked_site_names) ? updated.linked_site_names : [],
                                pendingApproval: !!(updated.pending_approval ?? updated.pendingApproval),
                            };
                            setWorkers((prev) => prev.map((x) => (x.id === editingWorkerId ? mapped : x)));
                              void refreshLinkedSites();
                            if (availabilityChanged || maxShiftsChanged || rolesChanged) {
                              const isMultiSiteContext = multiSitePullsSites.length > 1;
                              if (isMultiSiteContext) {
                                const linkedIds = Array.isArray(mapped.linkedSiteIds) ? mapped.linkedSiteIds : [];
                                const impactedIds = linkedIds.length > 0
                                  ? linkedIds
                                  : multiSitePullsSites.map((linkedSite) => linkedSite.id);
                                bumpAutoWeeklyWorkerChanges(impactedIds, getWeekKeyISO(weekStart));
                              }
                            }
                            toast.success("עובד עודכן בהצלחה!");
                              try {
                                const parsed = { ...(readWeeklyAvailabilityFor(weekStart) as any) };
                                parsed[trimmed] = { ...newWorkerAvailability };
                                void saveWeeklyAvailability(parsed);
                                setOriginalAvailability({ ...(mapped.availability || EMPTY_WORKER_AVAILABILITY) });
                              } catch {}
                              setEditingWorkerId(null);
                              setNewWorkerName("");
                              setNewWorkerMax(5);
                              setNewWorkerRoles([]);
                              setNewWorkerAvailability({ sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });
                              setIsAddModalOpen(false);
                            };
                            if (availabilityChanged && linkedOtherSiteNames.length > 0) {
                              pendingLinkedAvailabilitySaveRef.current = async (propagate: boolean) => {
                                try {
                                  await submitEditedWorker(propagate);
                                } catch (e: any) {
                                  const msg = String(e?.message || "");
                                  toast.error("שמירה נכשלה", { description: msg || "נסה שוב מאוחר יותר." });
                                }
                              };
                              setLinkedAvailabilityConfirmSites(linkedOtherSiteNames);
                              return;
                            }
                            await submitEditedWorker(false);
                            return;
                          } else {
                            // Le backend gère automatiquement la réutilisation si le worker existe déjà
                            const result = await apiFetch<any>(`/director/sites/${params.id}/workers`, {
                              method: "POST",
                              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                              body: JSON.stringify({
                                name: trimmed,
                                phone: newWorkerPhone.trim() || null, // Passer le téléphone pour lier automatiquement au User
                                max_shifts: newWorkerMax,
                                roles: newWorkerRoles,
                                availability: newWorkerAvailability, // Sauvegarder la disponibilité dans la base de données
                              }),
                            });
                            const mapped: Worker = {
                              id: result.id,
                              name: result.name,
                              maxShifts: result.max_shifts ?? result.maxShifts ?? 0,
                              roles: Array.isArray(result.roles) ? result.roles : [],
                              availability: result.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
                              answers: result.answers || {},
                              phone: result.phone ?? null,
                              linkedSiteIds: Array.isArray(result.linked_site_ids) ? result.linked_site_ids : [],
                              linkedSiteNames: Array.isArray(result.linked_site_names) ? result.linked_site_names : [],
                              pendingApproval: !!(result.pending_approval ?? result.pendingApproval),
                            };
                            // Vérifier si le worker existe déjà dans la liste (réutilisé)
                            const existingIndex = workers.findIndex((w) => w.id === result.id);
                            if (existingIndex >= 0) {
                              // Worker réutilisé - mettre à jour
                              setWorkers((prev) => prev.map((x) => (x.id === result.id ? mapped : x)));
                              void refreshLinkedSites();
                              toast.success("עובד עודכן בהצלחה!");
                            } else {
                              // Nouveau worker - ajouter
                            setWorkers((prev) => [...prev, mapped]);
                              void refreshLinkedSites();
                            toast.success("עובד נוסף בהצלחה!");
                            }
                          }
                          // Save weekly override for this specific week
                          try {
                            const parsed = { ...(readWeeklyAvailabilityFor(weekStart) as any) };
                            parsed[trimmed] = { ...newWorkerAvailability };
                            void saveWeeklyAvailability(parsed);
                            setOriginalAvailability({ ...EMPTY_WORKER_AVAILABILITY });
                          } catch {}
                          setEditingWorkerId(null);
                          setNewWorkerName("");
                          setNewWorkerMax(5);
                          setNewWorkerRoles([]);
                          setNewWorkerAvailability({ sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });
                          setIsAddModalOpen(false);
                        } catch (e: any) {
                          const msg = String(e?.message || "");
                          toast.error("שמירה נכשלה", { description: msg || "נסה שוב מאוחר יותר." });
                        } finally {
                          setWorkerModalSaving(false);
                        }
                      }}
                      disabled={workerModalSaving}
                      className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {workerModalSaving ? "שומר..." : "שמור"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Popup de filtrage des travailleurs */}
            {isFilterWorkersModalOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-lg border bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                  <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-6 py-4 dark:border-zinc-700 dark:bg-zinc-900">
                    <h3 className="text-lg font-semibold">סינון תשובות לשאלות</h3>
                    <button
                      type="button"
                      onClick={() => {
                        setIsFilterWorkersModalOpen(false);
                        setQuestionFilters({});
                        setFilterByWorkDays(false);
                        setQuestionVisibility({}); // Réinitialiser la visibilité
                      }}
                      className="rounded-md p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden>
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                      </svg>
                    </button>
                  </div>
                  <div className="p-6 space-y-6">
                    {/* Section de filtrage */}
                    {(() => {
                      const qs: any[] = (site?.config?.questions || []) as any[];
                      if (qs.length === 0) {
                        return (
                          <div className="text-center text-zinc-500 py-8">
                            אין שאלות אופציונליות מוגדרות
                          </div>
                        );
                      }

                      const qsOrdered = qs.filter((q) => q && q.id && String(q.label || "").trim());
                      
                      return (
                        <div className="space-y-4">
                          <div className="flex items-center justify-between">
                            <h4 className="font-semibold text-zinc-800 dark:text-zinc-200">פילטרים</h4>
                            {isSavedMode && savedWeekPlan?.assignments && (
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={filterByWorkDays}
                                  onChange={(e) => setFilterByWorkDays(e.target.checked)}
                                  className="rounded"
                                />
                                <span className="text-sm text-zinc-700 dark:text-zinc-300">
                                  הצג רק ימים שעובדים
                                </span>
                              </label>
                            )}
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {qsOrdered.map((q: any) => {
                              const qid = String(q.id);
                              const label = String(q.label || q.question || q.text || qid);
                              const type = String(q.type || "text");
                              const isPerDay = !!q.perDay;

                              // Collecter toutes les valeurs possibles pour cette question depuis tous les workers (pour la semaine actuelle)
                              const allValues = new Set<string>();
                              workers.forEach((w) => {
                                const rawAnswers = (w as any)?.answers || {};
                                const weekAnswers = getAnswersForWeek(rawAnswers, weekStart);
                                if (!weekAnswers) return; // Pas de réponses pour cette semaine
                                
                                const answersGeneral = weekAnswers.general;
                                const answersPerDay = weekAnswers.perDay;
                                
                                if (isPerDay) {
                                  const perObj = (answersPerDay || {})[qid] || {};
                                  Object.values(perObj).forEach((v: any) => {
                                    if (v !== undefined && v !== null && String(v).trim() !== "") {
                                      allValues.add(String(v));
                                    }
                                  });
                                } else {
                                  const v = (answersGeneral || {})[qid];
                                  if (v !== undefined && v !== null && String(v).trim() !== "") {
                                    allValues.add(String(v));
                                  }
                                }
                              });

                              const uniqueValues = Array.from(allValues).sort();

                              // Initialiser la visibilité par défaut à true si pas encore définie
                              const isVisible = questionVisibility[qid] !== false; // true par défaut
                              
                              return (
                                <div key={qid} className="rounded-md border p-3 dark:border-zinc-700">
                                  <div className="flex items-center justify-between mb-2">
                                    <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                                      {label} {isPerDay && <span className="text-xs text-zinc-500">(לכל יום)</span>}
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={isVisible}
                                        onChange={(e) => {
                                          setQuestionVisibility((prev) => ({
                                            ...prev,
                                            [qid]: e.target.checked,
                                          }));
                                        }}
                                        className="rounded"
                                      />
                                      <span className="text-xs text-zinc-600 dark:text-zinc-400">
                                        הצג תשובות
                                      </span>
                                    </label>
                                  </div>
                                  {type === "dropdown" && q.options && Array.isArray(q.options) ? (
                                    <select
                                      value={questionFilters[qid] || ""}
                                      onChange={(e) => {
                                        setQuestionFilters((prev) => ({
                                          ...prev,
                                          [qid]: e.target.value || undefined,
                                        }));
                                      }}
                                      className="w-full rounded-md border px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-800"
                                    >
                                      <option value="">כל התשובות</option>
                                      {q.options.map((opt: string) => (
                                        <option key={opt} value={opt}>{opt}</option>
                                      ))}
                                    </select>
                                  ) : type === "yesno" || type === "yes_no" ? (
                                    <select
                                      value={questionFilters[qid] || ""}
                                      onChange={(e) => {
                                        setQuestionFilters((prev) => ({
                                          ...prev,
                                          [qid]: e.target.value || undefined,
                                        }));
                                      }}
                                      className="w-full rounded-md border px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-800"
                                    >
                                      <option value="">כל התשובות</option>
                                      <option value="true">כן</option>
                                      <option value="false">לא</option>
                                    </select>
                                  ) : uniqueValues.length > 0 ? (
                                    <select
                                      value={questionFilters[qid] || ""}
                                      onChange={(e) => {
                                        setQuestionFilters((prev) => ({
                                          ...prev,
                                          [qid]: e.target.value || undefined,
                                        }));
                                      }}
                                      className="w-full rounded-md border px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-800"
                                    >
                                      <option value="">כל התשובות</option>
                                      {uniqueValues.map((val) => (
                                        <option key={val} value={val}>{val}</option>
                                      ))}
                                    </select>
                                  ) : (
                                    <input
                                      type="text"
                                      value={questionFilters[qid] || ""}
                                      onChange={(e) => {
                                        setQuestionFilters((prev) => ({
                                          ...prev,
                                          [qid]: e.target.value.trim() || undefined,
                                        }));
                                      }}
                                      placeholder="הזן ערך לחיפוש..."
                                      className="w-full rounded-md border px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-800"
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Liste des travailleurs filtrés */}
                    <div className="space-y-4">
                      <h4 className="font-semibold text-zinc-800 dark:text-zinc-200">
                        רשימת עובדים ({(() => {
                          // Filtrer les workers selon les filtres et qui ont des réponses pour cette semaine
                          const filtered = workers.filter((w) => {
                            const rawAnswers = (w as any)?.answers || {};
                            const weekAnswers = getAnswersForWeek(rawAnswers, weekStart);
                            if (!weekAnswers) return false; // Exclure les workers sans réponses pour cette semaine
                            
                            const answersGeneral = weekAnswers.general;
                            const answersPerDay = weekAnswers.perDay;
                            
                            const qs: any[] = (site?.config?.questions || []) as any[];
                            
                            // Vérifier chaque filtre
                            for (const [qid, filterValue] of Object.entries(questionFilters)) {
                              if (!filterValue) continue; // Pas de filtre pour cette question
                              
                              const q = qs.find((q) => String(q.id) === qid);
                              if (!q) continue;
                              
                              const isPerDay = !!q.perDay;
                              
                              if (isPerDay) {
                                const perObj = (answersPerDay || {})[qid] || {};
                                const hasMatch = Object.values(perObj).some((v: any) => {
                                  const strVal = String(v);
                                  const filterStr = String(filterValue);
                                  if (q.type === "yesno" || q.type === "yes_no") {
                                    return (filterStr === "true" && (v === true || strVal === "true" || strVal === "כן")) ||
                                           (filterStr === "false" && (v === false || strVal === "false" || strVal === "לא"));
                                  }
                                  return strVal.toLowerCase().includes(filterStr.toLowerCase()) || strVal === filterStr;
                                });
                                if (!hasMatch) return false;
                              } else {
                                const v = (answersGeneral || {})[qid];
                                const strVal = v !== undefined && v !== null ? String(v) : "";
                                const filterStr = String(filterValue);
                                if (q.type === "yesno" || q.type === "yes_no") {
                                  const matches = (filterStr === "true" && (v === true || strVal === "true" || strVal === "כן")) ||
                                                 (filterStr === "false" && (v === false || strVal === "false" || strVal === "לא"));
                                  if (!matches) return false;
                                } else {
                                  if (!strVal.toLowerCase().includes(filterStr.toLowerCase()) && strVal !== filterStr) {
                                    return false;
                                  }
                                }
                              }
                            }
                            return true;
                          });
                          return filtered.length;
                        })()})
                      </h4>
                      <div className="space-y-2 max-h-96 overflow-y-auto">
                        {(() => {
                          // Filtrer les workers selon les filtres et qui ont des réponses pour cette semaine
                          const filtered = workers.filter((w) => {
                            const rawAnswers = (w as any)?.answers || {};
                            const weekAnswers = getAnswersForWeek(rawAnswers, weekStart);
                            if (!weekAnswers) return false; // Exclure les workers sans réponses pour cette semaine
                            
                            const answersGeneral = weekAnswers.general;
                            const answersPerDay = weekAnswers.perDay;
                            
                            const qs: any[] = (site?.config?.questions || []) as any[];
                            
                            // Vérifier chaque filtre
                            for (const [qid, filterValue] of Object.entries(questionFilters)) {
                              if (!filterValue) continue; // Pas de filtre pour cette question
                              
                              const q = qs.find((q) => String(q.id) === qid);
                              if (!q) continue;
                              
                              const isPerDay = !!q.perDay;
                              
                              if (isPerDay) {
                                const perObj = (answersPerDay || {})[qid] || {};
                                const hasMatch = Object.values(perObj).some((v: any) => {
                                  const strVal = String(v);
                                  const filterStr = String(filterValue);
                                  if (q.type === "yesno" || q.type === "yes_no") {
                                    return (filterStr === "true" && (v === true || strVal === "true" || strVal === "כן")) ||
                                           (filterStr === "false" && (v === false || strVal === "false" || strVal === "לא"));
                                  }
                                  return strVal.toLowerCase().includes(filterStr.toLowerCase()) || strVal === filterStr;
                                });
                                if (!hasMatch) return false;
                              } else {
                                const v = (answersGeneral || {})[qid];
                                const strVal = v !== undefined && v !== null ? String(v) : "";
                                const filterStr = String(filterValue);
                                if (q.type === "yesno" || q.type === "yes_no") {
                                  const matches = (filterStr === "true" && (v === true || strVal === "true" || strVal === "כן")) ||
                                                 (filterStr === "false" && (v === false || strVal === "false" || strVal === "לא"));
                                  if (!matches) return false;
                                } else {
                                  if (!strVal.toLowerCase().includes(filterStr.toLowerCase()) && strVal !== filterStr) {
                                    return false;
                                  }
                                }
                              }
                            }
                            return true;
                          });

                          if (filtered.length === 0) {
                            return (
                              <div className="text-center text-zinc-500 py-8">
                                אין עובדים התואמים לפילטרים
                              </div>
                            );
                          }

                          return filtered.map((w) => {
                            const rawAnswers = (w as any)?.answers || {};
                            // Extraire les réponses de la semaine actuelle
                            const weekAnswers = getAnswersForWeek(rawAnswers, weekStart);
                            if (!weekAnswers) return null; // Pas de réponses pour cette semaine
                            
                            const answersGeneral = weekAnswers.general;
                            const answersPerDay = weekAnswers.perDay;
                            const qs: any[] = (site?.config?.questions || []) as any[];
                            const labelById = new Map<string, string>();
                            qs.forEach((q: any) => {
                              if (q && q.id) {
                                labelById.set(String(q.id), String(q.label || q.question || q.text || q.id));
                              }
                            });

                            return (
                              <div key={w.id} className="rounded-md border p-4 dark:border-zinc-700">
                                <div className="font-semibold text-zinc-900 dark:text-zinc-100 mb-3">{w.name}</div>
                                <div className="space-y-2 text-sm">
                                  {qs.filter((q) => q && q.id).map((q: any) => {
                                    const qid = String(q.id);
                                    // Vérifier si la question est visible (par défaut true)
                                    const isVisible = questionVisibility[qid] !== false;
                                    if (!isVisible) return null; // Ne pas afficher si le toggle est désactivé
                                    
                                    const label = labelById.get(qid) || qid;
                                    const isPerDay = !!q.perDay;
                                    
                                    if (isPerDay) {
                                      const perObj = (answersPerDay || {})[qid] || {};
                                      const hasAny = Object.values(perObj).some((v: any) => v !== undefined && v !== null && String(v).trim() !== "");
                                      if (!hasAny) return null;
                                      
                                      // Fonction pour extraire l'horaire depuis le nom du shift
                                      const hoursOf = (sn: string): string | null => {
                                        const s = String(sn || "");
                                        // direct numeric pattern like 06-14 or 14:22
                                        const m = s.match(/(\d{1,2})\s*[-:–]\s*(\d{1,2})/);
                                        if (m) {
                                          const a = m[1].padStart(2, "0");
                                          const b = m[2].padStart(2, "0");
                                          return `${a}-${b}`;
                                        }
                                        // Hebrew/english names
                                        if (/בוקר/i.test(s)) return "06-14";
                                        if (/צהר(יים|י)ם?/i.test(s)) return "14-22";
                                        if (/לילה|night/i.test(s)) return "22-06";
                                        return null;
                                      };
                                      
                                      // Fonction pour extraire l'horaire depuis la config de la station
                                      const hoursFromConfig = (station: any, shiftName: string): string | null => {
                                        if (!station) return null;
                                        function fmt(start?: string, end?: string): string | null {
                                          if (!start || !end) return null;
                                          return `${start}-${end}`;
                                        }
                                        if (station.perDayCustom && station.dayOverrides) {
                                          const order = ["sun","mon","tue","wed","thu","fri","sat"];
                                          for (const key of order) {
                                            const dcfg = station.dayOverrides?.[key];
                                            if (!dcfg || dcfg.active === false) continue;
                                            const sh = (dcfg.shifts || []).find((x: any) => x?.name === shiftName);
                                            const f = fmt(sh?.start, sh?.end);
                                            if (f) return f;
                                          }
                                        }
                                        const base = (station.shifts || []).find((x: any) => x?.name === shiftName);
                                        return fmt(base?.start, base?.end);
                                      };
                                      
                                      // Extraire les jours travaillés avec station, shift et horaire si le filtre est activé
                                      const getWorkDays = (): Array<{ dayKey: string; station: string; shift: string; hours: string | null; pullHighlightKind?: "cell" | "before" | "after" | null }> => {
                                        if (!filterByWorkDays || !isSavedMode || !savedWeekPlan?.assignments) return [];
                                        
                                        const assignments = savedWeekPlan.assignments;
                                        const stations = (site?.config?.stations || []) as any[];
                                        const workDays: Array<{ dayKey: string; station: string; shift: string; hours: string | null; pullHighlightKind?: "cell" | "before" | "after" | null }> = [];
                                        const workerNameTrimmed = (w.name || "").trim();
                                        const dayKeysOrdered = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
                                        const shiftNamesOrdered: string[] = Array.from(
                                          new Set(
                                            (site?.config?.stations || [])
                                              .flatMap((stationCfg: any) => (stationCfg?.shifts || [])
                                                .filter((sh: any) => sh?.enabled)
                                                .map((sh: any) => sh?.name))
                                              .filter(Boolean),
                                          ),
                                        );
                                        const getPullHighlightKindForEntry = (
                                          dayKey: string,
                                          shiftName: string,
                                          stationIndex: number,
                                        ): "cell" | "before" | "after" | null => {
                                          const dayIdx = dayKeysOrdered.indexOf(dayKey);
                                          const shiftIdx = shiftNamesOrdered.indexOf(shiftName);
                                          if (dayIdx < 0 || shiftIdx < 0) return null;
                                          let found: "cell" | "before" | "after" | null = null;
                                          Object.entries(displayedPullsByHoleKey || {}).forEach(([pullKey, entryAny]) => {
                                            if (found === "cell") return;
                                            const parts = String(pullKey || "").split("|");
                                            if (parts.length < 3) return;
                                            const [pullDayKey, pullShiftName, pullStationIdxRaw] = parts;
                                            if (Number(pullStationIdxRaw) !== Number(stationIndex)) return;
                                            const entry = entryAny as any;
                                            const beforeName = String(entry?.before?.name || "").trim();
                                            const afterName = String(entry?.after?.name || "").trim();
                                            const pullDayIdx = dayKeysOrdered.indexOf(pullDayKey);
                                            const pullShiftIdx = shiftNamesOrdered.indexOf(pullShiftName);
                                            if (pullDayIdx < 0 || pullShiftIdx < 0) return;
                                            const pullPrevCoord = (pullDayIdx === 0 && pullShiftIdx === 0)
                                              ? null
                                              : (pullShiftIdx === 0 ? { dayIdx: pullDayIdx - 1, shiftIdx: shiftNamesOrdered.length - 1 } : { dayIdx: pullDayIdx, shiftIdx: pullShiftIdx - 1 });
                                            const pullNextCoord = (pullDayIdx === dayKeysOrdered.length - 1 && pullShiftIdx === shiftNamesOrdered.length - 1)
                                              ? null
                                              : (pullShiftIdx === shiftNamesOrdered.length - 1 ? { dayIdx: pullDayIdx + 1, shiftIdx: 0 } : { dayIdx: pullDayIdx, shiftIdx: pullShiftIdx + 1 });
                                            if (pullDayKey === dayKey && pullShiftName === shiftName) {
                                              if (beforeName === workerNameTrimmed || afterName === workerNameTrimmed) {
                                                found = "cell";
                                              }
                                              return;
                                            }
                                            if (!found && beforeName === workerNameTrimmed && pullPrevCoord && pullPrevCoord.dayIdx === dayIdx && pullPrevCoord.shiftIdx === shiftIdx) {
                                              found = "before";
                                            }
                                            if (!found && afterName === workerNameTrimmed && pullNextCoord && pullNextCoord.dayIdx === dayIdx && pullNextCoord.shiftIdx === shiftIdx) {
                                              found = "after";
                                            }
                                          });
                                          return found;
                                        };
                                        
                                        dayKeysOrdered.forEach((dayKey) => {
                                          const dayAssignments = assignments[dayKey] || {};
                                          Object.entries(dayAssignments).forEach(([shiftName, stationArray]) => {
                                            if (!Array.isArray(stationArray)) return;
                                            stationArray.forEach((workerArray, stationIndex) => {
                                              if (!Array.isArray(workerArray)) return;
                                              // Vérifier si le worker est dans ce tableau
                                              const hasWorker = workerArray.some((wn: any) => String(wn || "").trim() === workerNameTrimmed);
                                              if (hasWorker) {
                                                const stationConfig = stations[stationIndex];
                                                const stationName = stationConfig?.name || `עמדה ${stationIndex + 1}`;
                                                // Extraire l'horaire depuis la config ou depuis le nom du shift
                                                const hours = hoursFromConfig(stationConfig, shiftName) || hoursOf(shiftName) || shiftName;
                                                const pullHighlightKind = getPullHighlightKindForEntry(dayKey, shiftName, stationIndex);
                                                // Ajouter chaque assignation (même jour peut avoir plusieurs shifts/stations)
                                                workDays.push({ dayKey, station: stationName, shift: shiftName, hours, pullHighlightKind });
                                              }
                                            });
                                          });
                                        });
                                        
                                        return workDays;
                                      };
                                      
                                      const workDays = getWorkDays();
                                      
                                      // Si le filtre est activé mais qu'il n'y a pas de jours travaillés, ne rien afficher
                                      if (filterByWorkDays && workDays.length === 0) {
                                        return null;
                                      }
                                      
                                      const dayKeysToShow = filterByWorkDays && workDays.length > 0
                                        ? workDays.map(wd => wd.dayKey)
                                        : ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
                                      
                                      return (
                                        <div key={qid} className="rounded-md border border-zinc-100 p-2 dark:border-zinc-800">
                                          <div className="font-medium text-zinc-800 dark:text-zinc-200 mb-1">{label}</div>
                                          <div className="space-y-1 text-xs">
                                            {dayKeysToShow.map((dayKey) => {
                                              const v = perObj[dayKey];
                                              // Si le filtre est activé, on n'affiche que si il y a une réponse ET une assignation
                                              if (filterByWorkDays) {
                                                const workDayInfos = workDays.filter(wd => wd.dayKey === dayKey);
                                                if (workDayInfos.length === 0) return null; // Pas d'assignation pour ce jour
                                                if (v === undefined || v === null || String(v).trim() === "") return null; // Pas de réponse
                                              } else {
                                                // Sans filtre, on affiche seulement si il y a une réponse
                                                if (v === undefined || v === null || String(v).trim() === "") return null;
                                              }
                                              
                                              const dayLabels: Record<string, string> = { sun: "א'", mon: "ב'", tue: "ג'", wed: "ד'", thu: "ה'", fri: "ו'", sat: "ש'" };
                                              
                                              // Trouver toutes les stations et shifts pour ce jour si le filtre est activé
                                              const workDayInfos = filterByWorkDays ? workDays.filter(wd => wd.dayKey === dayKey) : [];
                                              
                                              return (
                                                <div key={dayKey} className="flex justify-between items-start gap-2">
                                                  <div className="flex flex-col flex-1">
                                                    <span className="text-zinc-600 dark:text-zinc-300">{dayLabels[dayKey]}</span>
                                                    {workDayInfos.length > 0 && (
                                                      <div className="mt-1 space-y-0.5">
                                                        {workDayInfos.map((wdi, idx) => (
                                                          <span
                                                            key={idx}
                                                            className={
                                                              "block text-xs " +
                                                              (wdi.pullHighlightKind
                                                                ? "rounded-md border border-orange-400 px-1.5 py-0.5 text-zinc-700 dark:border-orange-400 dark:text-zinc-200"
                                                                : "text-zinc-500 dark:text-zinc-400")
                                                            }
                                                          >
                                                            {wdi.station} - {wdi.shift} {wdi.hours && `(${wdi.hours})`}
                                                          </span>
                                                        ))}
                                                      </div>
                                                    )}
                                                  </div>
                                                  <span className="font-medium text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
                                                    {typeof v === "boolean" ? (v ? "כן" : "לא") : String(v)}
                                                  </span>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        </div>
                                      );
                                    } else {
                                      const v = (answersGeneral || {})[qid];
                                      if (v === undefined || v === null || String(v).trim() === "") return null;
                                      
                                      return (
                                        <div key={qid} className="flex justify-between">
                                          <span className="text-zinc-700 dark:text-zinc-200">{label}</span>
                                          <span className="font-medium text-zinc-900 dark:text-zinc-100">
                                            {typeof v === "boolean" ? (v ? "כן" : "לא") : String(v)}
                                          </span>
                                        </div>
                                      );
                                    }
                                  })}
                                </div>
                              </div>
                            );
                          });
                        })()}
                      </div>
                    </div>
                  </div>
                  <div className="sticky bottom-0 flex items-center gap-2 border-t bg-white px-6 py-4 dark:border-zinc-700 dark:bg-zinc-900">
                    {/* Section gauche : סגור */}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setIsFilterWorkersModalOpen(false);
                          setQuestionFilters({});
                          setFilterByWorkDays(false);
                          setQuestionVisibility({}); // Réinitialiser la visibilité
                        }}
                        className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                      >
                        סגור
                      </button>
                    </div>
                    
                    {/* Section milieu : boutons de téléchargement et partage (centrés) */}
                    <div className="flex-1 flex items-center justify-center gap-2">
                      {/* Fonction pour générer le contenu des travailleurs avec leurs réponses */}
                      {(() => {
                        const generateWorkersContent = () => {
                          // Filtrer les workers selon les filtres actifs
                          const filtered = workers.filter((w) => {
                            const rawAnswers = (w as any)?.answers || {};
                            // Extraire les réponses de la semaine actuelle
                            const weekAnswers = getAnswersForWeek(rawAnswers, weekStart);
                            if (!weekAnswers) return false; // Pas de réponses pour cette semaine
                            
                            const answersGeneral = weekAnswers.general;
                            const answersPerDay = weekAnswers.perDay;
                            
                            const qs: any[] = (site?.config?.questions || []) as any[];
                            
                            // Vérifier chaque filtre
                            for (const [qid, filterValue] of Object.entries(questionFilters)) {
                              if (!filterValue) continue;
                              
                              const q = qs.find((q) => String(q.id) === qid);
                              if (!q) continue;
                              
                              const isPerDay = !!q.perDay;
                              
                              if (isPerDay) {
                                const perObj = (answersPerDay || {})[qid] || {};
                                const hasMatch = Object.values(perObj).some((v: any) => {
                                  const strVal = String(v);
                                  const filterStr = String(filterValue);
                                  if (q.type === "yesno" || q.type === "yes_no") {
                                    return (filterStr === "true" && (v === true || strVal === "true" || strVal === "כן")) ||
                                           (filterStr === "false" && (v === false || strVal === "false" || strVal === "לא"));
                                  }
                                  return strVal.toLowerCase().includes(filterStr.toLowerCase()) || strVal === filterStr;
                                });
                                if (!hasMatch) return false;
                              } else {
                                const v = (answersGeneral || {})[qid];
                                const strVal = v !== undefined && v !== null ? String(v) : "";
                                const filterStr = String(filterValue);
                                if (q.type === "yesno" || q.type === "yes_no") {
                                  const matches = (filterStr === "true" && (v === true || strVal === "true" || strVal === "כן")) ||
                                                 (filterStr === "false" && (v === false || strVal === "false" || strVal === "לא"));
                                  if (!matches) return false;
                                } else {
                                  if (!strVal.toLowerCase().includes(filterStr.toLowerCase()) && strVal !== filterStr) {
                                    return false;
                                  }
                                }
                              }
                            }
                            return true;
                          });

                          const qs: any[] = (site?.config?.questions || []) as any[];
                          const labelById = new Map<string, string>();
                          qs.forEach((q: any) => {
                            if (q && q.id) {
                              labelById.set(String(q.id), String(q.label || q.question || q.text || q.id));
                            }
                          });

                          // Fonctions pour extraire les horaires (réutilisées)
                          const hoursOf = (sn: string): string | null => {
                            const s = String(sn || "");
                            const m = s.match(/(\d{1,2})\s*[-:–]\s*(\d{1,2})/);
                            if (m) {
                              const a = m[1].padStart(2, "0");
                              const b = m[2].padStart(2, "0");
                              return `${a}-${b}`;
                            }
                            if (/בוקר/i.test(s)) return "06-14";
                            if (/צהר(יים|י)ם?/i.test(s)) return "14-22";
                            if (/לילה|night/i.test(s)) return "22-06";
                            return null;
                          };
                          
                          const hoursFromConfig = (station: any, shiftName: string): string | null => {
                            if (!station) return null;
                            function fmt(start?: string, end?: string): string | null {
                              if (!start || !end) return null;
                              return `${start}-${end}`;
                            }
                            if (station.perDayCustom && station.dayOverrides) {
                              const order = ["sun","mon","tue","wed","thu","fri","sat"];
                              for (const key of order) {
                                const dcfg = station.dayOverrides?.[key];
                                if (!dcfg || dcfg.active === false) continue;
                                const sh = (dcfg.shifts || []).find((x: any) => x?.name === shiftName);
                                const f = fmt(sh?.start, sh?.end);
                                if (f) return f;
                              }
                            }
                            const base = (station.shifts || []).find((x: any) => x?.name === shiftName);
                            return fmt(base?.start, base?.end);
                          };

                          const getWorkDays = (w: Worker) => {
                            if (!filterByWorkDays || !isSavedMode || !savedWeekPlan?.assignments) return [];
                            
                            const assignments = savedWeekPlan.assignments;
                            const stations = (site?.config?.stations || []) as any[];
                            const workDays: Array<{ dayKey: string; station: string; shift: string; hours: string | null }> = [];
                            const workerNameTrimmed = (w.name || "").trim();
                            
                            const dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
                            dayKeys.forEach((dayKey) => {
                              const dayAssignments = assignments[dayKey] || {};
                              Object.entries(dayAssignments).forEach(([shiftName, stationArray]) => {
                                if (!Array.isArray(stationArray)) return;
                                stationArray.forEach((workerArray, stationIndex) => {
                                  if (!Array.isArray(workerArray)) return;
                                  const hasWorker = workerArray.some((wn: any) => String(wn || "").trim() === workerNameTrimmed);
                                  if (hasWorker) {
                                    const stationConfig = stations[stationIndex];
                                    const stationName = stationConfig?.name || `עמדה ${stationIndex + 1}`;
                                    const hours = hoursFromConfig(stationConfig, shiftName) || hoursOf(shiftName) || shiftName;
                                    workDays.push({ dayKey, station: stationName, shift: shiftName, hours });
                                  }
                                });
                              });
                            });
                            
                            return workDays;
                          };

                          // Générer le contenu texte
                          let content = `רשימת עובדים - ${site?.name || "אתר"}\n`;
                          content += `תאריך: ${new Date().toLocaleDateString('he-IL')}\n`;
                          content += `\n${"=".repeat(50)}\n\n`;

                          filtered.forEach((w) => {
                            content += `עובד: ${w.name}\n`;
                            content += `מקס' משמרות: ${w.maxShifts}\n`;
                            if (w.roles && w.roles.length > 0) {
                              content += `תפקידים: ${w.roles.join(", ")}\n`;
                            }
                            content += `\n`;

                            const rawAnswers = (w as any)?.answers || {};
                            // Extraire les réponses de la semaine actuelle
                            const weekAnswers = getAnswersForWeek(rawAnswers, weekStart);
                            if (!weekAnswers) return; // Pas de réponses pour cette semaine, ne pas inclure dans le contenu
                            
                            const answersGeneral = weekAnswers.general;
                            const answersPerDay = weekAnswers.perDay;

                            // Questions visibles uniquement
                            const visibleQuestions = qs.filter((q) => {
                              const qid = String(q.id);
                              return questionVisibility[qid] !== false; // true par défaut
                            });

                            visibleQuestions.forEach((q: any) => {
                              const qid = String(q.id);
                              const label = labelById.get(qid) || qid;
                              const isPerDay = !!q.perDay;

                              if (isPerDay) {
                                const perObj = (answersPerDay || {})[qid] || {};
                                const workDays = getWorkDays(w);
                                const dayKeysToShow = filterByWorkDays && workDays.length > 0
                                  ? workDays.map(wd => wd.dayKey)
                                  : ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

                                const dayLabels: Record<string, string> = { sun: "א'", mon: "ב'", tue: "ג'", wed: "ד'", thu: "ה'", fri: "ו'", sat: "ש'" };
                                
                                let hasAnswer = false;
                                let answerText = `${label}:\n`;
                                
                                dayKeysToShow.forEach((dayKey) => {
                                  const v = perObj[dayKey];
                                  if (filterByWorkDays) {
                                    const workDayInfos = workDays.filter(wd => wd.dayKey === dayKey);
                                    if (workDayInfos.length === 0) return;
                                    if (v === undefined || v === null || String(v).trim() === "") return;
                                  } else {
                                    if (v === undefined || v === null || String(v).trim() === "") return;
                                  }
                                  
                                  hasAnswer = true;
                                  const dayLabel = dayLabels[dayKey];
                                  const answerValue = typeof v === "boolean" ? (v ? "כן" : "לא") : String(v);
                                  
                                  if (filterByWorkDays) {
                                    const workDayInfos = workDays.filter(wd => wd.dayKey === dayKey);
                                    workDayInfos.forEach((wdi) => {
                                      answerText += `  ${dayLabel}: ${answerValue} (${wdi.station} - ${wdi.shift}${wdi.hours ? ` ${wdi.hours}` : ""})\n`;
                                    });
                                  } else {
                                    answerText += `  ${dayLabel}: ${answerValue}\n`;
                                  }
                                });

                                if (hasAnswer) {
                                  content += answerText + "\n";
                                }
                              } else {
                                const v = (answersGeneral || {})[qid];
                                if (v !== undefined && v !== null && String(v).trim() !== "") {
                                  const answerValue = typeof v === "boolean" ? (v ? "כן" : "לא") : String(v);
                                  content += `${label}: ${answerValue}\n`;
                                }
                              }
                            });

                            content += `\n${"-".repeat(50)}\n\n`;
                          });

                          return content;
                        };

                        const handleDownload = () => {
                          const content = generateWorkersContent();
                          const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `רשימת_עובדים_${new Date().toISOString().split('T')[0]}.txt`;
                          document.body.appendChild(a);
                          a.click();
                          document.body.removeChild(a);
                          URL.revokeObjectURL(url);
                        };

                        const handleShareEmail = () => {
                          const content = generateWorkersContent();
                          const subject = encodeURIComponent(`רשימת עובדים - ${site?.name || "אתר"}`);
                          const body = encodeURIComponent(content);
                          window.location.href = `mailto:?subject=${subject}&body=${body}`;
                        };

                        const handleShareWhatsApp = () => {
                          const content = generateWorkersContent();
                          // Limiter la longueur pour WhatsApp (environ 4096 caractères)
                          const maxLength = 4000;
                          const truncatedContent = content.length > maxLength 
                            ? content.substring(0, maxLength) + "\n\n... (תוכן מקוצר)"
                            : content;
                          const text = encodeURIComponent(truncatedContent);
                          window.open(`https://wa.me/?text=${text}`, '_blank');
                        };

                        return (
                          <>
                            <button
                              type="button"
                              onClick={handleDownload}
                              className="inline-flex items-center gap-2 rounded-md border border-blue-600 bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 dark:border-blue-500 dark:bg-blue-500 dark:hover:bg-blue-600"
                            >
                              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                              </svg>
                              הורד
                            </button>
                            <button
                              type="button"
                              onClick={handleShareEmail}
                              className="inline-flex items-center gap-2 rounded-md border border-green-600 bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700 dark:border-green-500 dark:bg-green-500 dark:hover:bg-green-600"
                            >
                              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                                <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
                              </svg>
                              אימייל
                            </button>
                            <button
                              type="button"
                              onClick={handleShareWhatsApp}
                              className="inline-flex items-center gap-2 rounded-md border border-[#25D366] bg-[#25D366] px-3 py-2 text-sm text-white hover:bg-[#20BA5A] dark:bg-[#25D366] dark:hover:bg-[#20BA5A]"
                            >
                              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
                              </svg>
                              WhatsApp
                            </button>
                          </>
                        );
                      })()}
                    </div>
                    
                    {/* Section droite : נקה פילטרים */}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setQuestionFilters({});
                          setFilterByWorkDays(false);
                          setQuestionVisibility({}); // Réinitialiser la visibilité
                        }}
                        className="rounded-md border border-orange-600 bg-orange-600 px-4 py-2 text-sm text-white hover:bg-orange-700 dark:border-orange-500 dark:bg-orange-500 dark:hover:bg-orange-600"
                      >
                        נקה פילטרים
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Grilles hebdomadaires par עמדה */}
            <section className="space-y-4">
              <h2 className="text-lg font-semibold text-center">
                גריד שבועי לפי עמדה
              </h2>
              <div className="flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    // If already in auto mode, do nothing (no popup)
                    if (!isManual) return;
                    // Only show dialog if current grid has content; else switch directly
                    const nonEmpty = (assignments: any): boolean => {
                      if (!assignments || typeof assignments !== "object") return false;
                      for (const dayKey of Object.keys(assignments)) {
                        const shiftsMap = (assignments as any)[dayKey];
                        if (!shiftsMap || typeof shiftsMap !== "object") continue;
                        for (const shiftName of Object.keys(shiftsMap)) {
                          const perStation = (shiftsMap as any)[shiftName];
                          if (!Array.isArray(perStation)) continue;
                          for (const cell of perStation) {
                            if (Array.isArray(cell) && cell.some((n) => n && String(n).trim().length > 0)) {
                              return true;
                            }
                          }
                        }
                      }
                      return false;
                    };
                    const hasContent = isManual
                      ? nonEmpty(manualAssignments)
                      : (nonEmpty(aiPlan?.assignments as any) || (!!savedWeekPlan?.assignments && !editingSaved && nonEmpty(savedWeekPlan.assignments as any)));
                    if (!hasContent) {
                      // No content: switch to auto immediately
                    setIsManual(false);
                      return;
                    }
                    setModeSwitchTarget("auto");
                    setShowModeSwitchDialog(true);
                  }}
                  className={
                    "inline-flex items-center rounded-md border px-3 py-1 text-sm " +
                     (isManual ? "dark:border-zinc-700" : "bg-[#00A8E0] text-white border-[#00A8E0]")
                  }
                  style={{ display: 'none' }}
                >
                  אוטומטי
                </button>
                <button
                  type="button"
                  style={{ display: 'none' }}
                  onClick={() => {
                    // If already in manual mode, do nothing (no popup)
                    if (isManual) return;
                    // Only show dialog if current grid has content; else switch directly
                    const nonEmpty = (assignments: any): boolean => {
                      if (!assignments || typeof assignments !== "object") return false;
                      for (const dayKey of Object.keys(assignments)) {
                        const shiftsMap = (assignments as any)[dayKey];
                        if (!shiftsMap || typeof shiftsMap !== "object") continue;
                        for (const shiftName of Object.keys(shiftsMap)) {
                          const perStation = (shiftsMap as any)[shiftName];
                          if (!Array.isArray(perStation)) continue;
                          for (const cell of perStation) {
                            if (Array.isArray(cell) && cell.some((n) => n && String(n).trim().length > 0)) {
                              return true;
                            }
                          }
                        }
                      }
                      return false;
                    };
                    const hasContent = !isManual
                      ? nonEmpty(aiPlan?.assignments as any)
                      : (nonEmpty(manualAssignments) || (!!savedWeekPlan?.assignments && !editingSaved && nonEmpty(savedWeekPlan.assignments as any)));
                    if (!hasContent) {
                      // No content: switch to manual immediately, stop any ongoing AI generation
                      try { stopAiGeneration(); } catch {}
                    setIsManual(true);
                      return;
                    }
                    setModeSwitchTarget("manual");
                    setShowModeSwitchDialog(true);
                  }}
                  className={
                    "inline-flex items-center rounded-md border px-3 py-1 text-sm " +
                     (isManual ? "bg-[#00A8E0] text-white border-[#00A8E0]" : "dark:border-zinc-700")
                  }
                >
                  ידני
                </button>
              </div>
              {/* Date navigation - responsive layout */}
              <div className="flex items-center justify-center gap-3 text-sm text-zinc-600 dark:text-zinc-300">
                {/* Desktop: inline layout */}
                <div className="hidden md:flex items-center gap-3">
                <button
                  type="button"
                  aria-label="שבוע קודם"
                  onClick={() => {
                    if (editingSaved) return;
                    stopAiGeneration();
                    setAiPlan(null);
                    setAltIndex(0);
                    baseAssignmentsRef.current = null;
                    // Default to automatic mode on week change
                    setIsManual(false);
                    updateWeekStart(addDays(weekStartRef.current || weekStart, -7));
                  }}
                  disabled={editingSaved}
                  className={`inline-flex items-center rounded-md border px-2 py-1 dark:border-zinc-700 ${editingSaved ? "opacity-50 cursor-not-allowed" : "hover:bg-zinc-50 dark:hover:bg-zinc-800"}`}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
                </button>
                <span>
                  {(() => {
                    const end = addDays(weekStart, 6);
                    return `שבוע: ${formatHebDate(weekStart)} — ${formatHebDate(end)}`;
                  })()}
                </span>
                <button
                  type="button"
                  aria-label="שבוע הבא"
                  onClick={() => {
                    if (editingSaved) return;
                    stopAiGeneration();
                    setAiPlan(null);
                    setAltIndex(0);
                    baseAssignmentsRef.current = null;
                    // Default to automatic mode on week change
                    setIsManual(false);
                    updateWeekStart(addDays(weekStartRef.current || weekStart, 7));
                  }}
                  disabled={editingSaved}
                  className={`inline-flex items-center rounded-md border px-2 py-1 dark:border-zinc-700 ${editingSaved ? "opacity-50 cursor-not-allowed" : "hover:bg-zinc-50 dark:hover:bg-zinc-800"}`}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                </button>
                <button
                  type="button"
                  aria-label="בחר שבוע מלוח שנה"
                  onClick={() => { if (!editingSaved) setIsCalendarOpen(true); }}
                  disabled={editingSaved}
                  className={`inline-flex items-center rounded-md border px-2 py-1 dark:border-zinc-700 ${editingSaved ? "opacity-50 cursor-not-allowed" : "hover:bg-zinc-50 dark:hover:bg-zinc-800"}`}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
                    <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z"/>
                    <path d="M7 14h5v5H7z"/>
                  </svg>
                </button>
              </div>
                {/* Mobile: centered date with buttons on sides */}
                <div className="flex md:hidden items-center justify-center gap-3 w-full">
                  <button
                    type="button"
                    aria-label="שבוע קודם"
                    onClick={() => {
                      if (editingSaved) return;
                      stopAiGeneration();
                      setAiPlan(null);
                      setAltIndex(0);
                      baseAssignmentsRef.current = null;
                      // Default to automatic mode on week change
                      setIsManual(false);
                      updateWeekStart(addDays(weekStartRef.current || weekStart, -7));
                    }}
                    disabled={editingSaved}
                    className={`inline-flex items-center rounded-md border px-2 py-1 dark:border-zinc-700 ${editingSaved ? "opacity-50 cursor-not-allowed" : "hover:bg-zinc-50 dark:hover:bg-zinc-800"}`}
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
                  </button>
                  <div className="flex flex-col items-center gap-1 flex-1">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">שבוע</span>
                    <div className="flex flex-col items-center gap-0.5">
                      <span>{formatHebDate(weekStart)}</span>
                      <span className="text-zinc-400">—</span>
                      <span>{formatHebDate(addDays(weekStart, 6))}</span>
                    </div>
                  </div>
                <button
                  type="button"
                  aria-label="שבוע הבא"
                  onClick={() => {
                    if (editingSaved) return;
                    stopAiGeneration();
                    setAiPlan(null);
                    setAltIndex(0);
                    baseAssignmentsRef.current = null;
                    // Default to automatic mode on week change
                    setIsManual(false);
                    updateWeekStart(addDays(weekStartRef.current || weekStart, 7));
                  }}
                  disabled={editingSaved}
                  className={`inline-flex items-center rounded-md border px-2 py-1 dark:border-zinc-700 ${editingSaved ? "opacity-50 cursor-not-allowed" : "hover:bg-zinc-50 dark:hover:bg-zinc-800"}`}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                </button>
                <button
                  type="button"
                  aria-label="בחר שבוע מלוח שנה"
                  onClick={() => { if (!editingSaved) setIsCalendarOpen(true); }}
                  disabled={editingSaved}
                  className={`inline-flex items-center rounded-md border px-2 py-1 dark:border-zinc-700 ${editingSaved ? "opacity-50 cursor-not-allowed" : "hover:bg-zinc-50 dark:hover:bg-zinc-800"}`}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
                    <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z"/>
                    <path d="M7 14h5v5H7z"/>
                  </svg>
                </button>
              </div>
              </div>
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
                          if (editingSaved) return;
                          const nextMonth = new Date(calendarMonth);
                          nextMonth.setMonth(nextMonth.getMonth() + 1);
                          setCalendarMonth(nextMonth);
                        }}
                        disabled={editingSaved}
                        className={`p-1 rounded ${editingSaved ? "opacity-50 cursor-not-allowed" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
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
                          if (editingSaved) return;
                          const prevMonth = new Date(calendarMonth);
                          prevMonth.setMonth(prevMonth.getMonth() - 1);
                          setCalendarMonth(prevMonth);
                        }}
                        disabled={editingSaved}
                        className={`p-1 rounded ${editingSaved ? "opacity-50 cursor-not-allowed" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
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
                        const lastDay = new Date(year, month + 1, 0);
                        const startDate = new Date(firstDay);
                        startDate.setDate(startDate.getDate() - firstDay.getDay()); // Start from Sunday
                        const days: ReactElement[] = [];
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);
                        
                        // Helper function to check if a plan exists for a date
                        const hasSavedPlan = (date: Date): boolean => {
                          if (typeof window === "undefined") return false;
                          const weekStartForDate = new Date(date);
                          weekStartForDate.setDate(date.getDate() - date.getDay()); // Sunday
                          const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
                          const key = `plan_${params.id}_${iso(weekStartForDate)}`;
                          const raw = localStorage.getItem(key);
                          if (!raw) return false;
                          try {
                            const parsed = JSON.parse(raw);
                            return !!(parsed && parsed.assignments);
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
                          
                          // Check if there's a saved plan for this week
                          const hasPlan = hasSavedPlan(date);
                          
                          days.push(
                            <button
                              key={i}
                              type="button"
                              onClick={() => {
                                if (editingSaved) return;
                                stopAiGeneration();
                                setAiPlan(null);
                                setAltIndex(0);
                                baseAssignmentsRef.current = null;
                                const selectedWeekStart = new Date(date);
                                selectedWeekStart.setDate(date.getDate() - date.getDay());
                                // Default to automatic mode on week change
                                setIsManual(false);
                                updateWeekStart(selectedWeekStart);
                                setCalendarMonth(new Date(year, month, 1));
                                setIsCalendarOpen(false);
                              }}
                              disabled={editingSaved}
                              className={`
                                p-2 text-sm rounded flex flex-col items-center relative
                                ${!isCurrentMonth ? "text-zinc-300 dark:text-zinc-600" : ""}
                                ${isToday ? "bg-[#00A8E0] text-white font-semibold" : ""}
                                ${isCurrentWeek && isCurrentMonth && !isToday ? "bg-[#00A8E0]/20 border border-[#00A8E0]" : ""}
                                ${isWeekStart && isCurrentMonth ? "font-semibold" : ""}
                                ${editingSaved ? "opacity-50 cursor-not-allowed" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}
                                ${isCurrentMonth && !isToday && !isCurrentWeek ? "text-zinc-700 dark:text-zinc-300" : ""}
                              `}
                            >
                              <span>{date.getDate()}</span>
                              {hasPlan && (
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
              {(() => {
                const dayCols = [
                  { key: "sun", label: "א'" },
                  { key: "mon", label: "ב'" },
                  { key: "tue", label: "ג'" },
                  { key: "wed", label: "ד'" },
                  { key: "thu", label: "ה'" },
                  { key: "fri", label: "ו'" },
                  { key: "sat", label: "ש'" },
                ];
                function getRequiredFor(st: any, shiftName: string, dayKey: string): number {
                  if (!st) return 0;
                  // Mode personnalisation par jour
                  if (st.perDayCustom) {
                    const dayCfg = st.dayOverrides?.[dayKey];
                    if (!dayCfg || dayCfg.active === false) return 0;
                    if (st.uniformRoles) {
                      // En mode uniforme, le nombre d'employés requis est celui défini pour l'עמדה
                      return Number(st.workers || 0);
                    }
                    const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
                    if (!sh || !sh.enabled) return 0;
                    return Number(sh.workers || 0);
                  }
                  // Mode global (pas par jour)
                  if (st.days && st.days[dayKey] === false) return 0;
                  if (st.uniformRoles) {
                    return Number(st.workers || 0);
                  }
                  const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
                  if (!sh || !sh.enabled) return 0;
                  return Number(sh.workers || 0);
                }
                function isDayActive(st: any, dayKey: string): boolean {
                  if (!st) return false;
                  if (st.perDayCustom) {
                    const dayCfg = st.dayOverrides?.[dayKey];
                    return !!(dayCfg && dayCfg.active);
                  }
                  if (st.days && Object.prototype.hasOwnProperty.call(st.days, dayKey)) {
                    return st.days[dayKey] !== false;
                  }
                  return true; // par défaut actif si non précisé
                }
                const shiftNamesAll: string[] = Array.from(
                  new Set(
                    (site?.config?.stations || [])
                      .flatMap((st: any) => (st?.shifts || [])
                        .filter((sh: any) => sh?.enabled)
                        .map((sh: any) => sh?.name))
                      .filter(Boolean)
                  )
                );
                function hoursOf(sn: string): string | null {
                  const s = String(sn || "");
                  // direct numeric pattern like 06-14 or 14:22
                  const m = s.match(/(\d{1,2})\s*[-:–]\s*(\d{1,2})/);
                  if (m) {
                    const a = m[1].padStart(2, "0");
                    const b = m[2].padStart(2, "0");
                    return `${a}–${b}`;
                  }
                  // Hebrew/english names
                  if (/בוקר/i.test(s)) return "06–14";
                  if (/צהר(יים|י)ם?/i.test(s)) return "14–22";
                  if (/לילה|night/i.test(s)) return "22–06";
                  return null;
                }
                function hoursFromConfig(station: any, shiftName: string): string | null {
                  if (!station) return null;
                  function fmt(start?: string, end?: string): string | null {
                    if (!start || !end) return null;
                    // IMPORTANT: utiliser un tiret simple pour uniformiser l'affichage
                    return `${start}-${end}`;
                  }
                  if (station.perDayCustom && station.dayOverrides) {
                    const order = ["sun","mon","tue","wed","thu","fri","sat"];
                    for (const key of order) {
                      const dcfg = station.dayOverrides?.[key];
                      if (!dcfg || dcfg.active === false) continue;
                      const sh = (dcfg.shifts || []).find((x: any) => x?.name === shiftName);
                      const f = fmt(sh?.start, sh?.end);
                      if (f) return f;
                    }
                  }
                  const base = (station.shifts || []).find((x: any) => x?.name === shiftName);
                  return fmt(base?.start, base?.end);
                }

                function parseHoursRange(range: string | null): { start: string; end: string } | null {
                  if (!range) return null;
                  const clean = String(range).trim().replace("–", "-");
                  const parts = clean.split("-");
                  if (parts.length < 2) return null;
                  const start = parts[0]?.trim();
                  const end = parts.slice(1).join("-").trim();
                  if (!start || !end) return null;
                  return { start, end };
                }

                function toMinutes(t: string): number | null {
                  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})$/);
                  if (!m) return null;
                  const hh = Number(m[1]);
                  const mm = Number(m[2]);
                  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
                  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
                  return hh * 60 + mm;
                }

                function fromMinutes(mins: number): string {
                  let m = Math.round(mins);
                  m = ((m % (24 * 60)) + (24 * 60)) % (24 * 60);
                  const hh = Math.floor(m / 60);
                  const mm = m % 60;
                  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
                }

                function splitRangeHalf(start: string, end: string): { before: { start: string; end: string }; after: { start: string; end: string } } {
                  const s = toMinutes(start);
                  const e0 = toMinutes(end);
                  if (s == null || e0 == null) {
                    // fallback: 00:00-12:00 / 12:00-00:00
                    return { before: { start: "00:00", end: "12:00" }, after: { start: "12:00", end: "00:00" } };
                  }
                  let e = e0;
                  if (e <= s) e += 24 * 60; // overnight
                  const mid = s + (e - s) / 2;
                  return { before: { start: fromMinutes(s), end: fromMinutes(mid) }, after: { start: fromMinutes(mid), end: fromMinutes(e) } };
                }

                // Par défaut pour "משיכות": limiter chaque part à maxEachMinutes (ex: 4h)
                function splitRangeForPulls(start: string, end: string, maxEachMinutes: number): { before: { start: string; end: string }; after: { start: string; end: string } } {
                  const s = toMinutes(start);
                  const e0 = toMinutes(end);
                  if (s == null || e0 == null) return splitRangeHalf(start, end);
                  let e = e0;
                  if (e <= s) e += 24 * 60; // overnight
                  const duration = e - s;
                  const half = duration / 2;
                  const each = Math.min(maxEachMinutes, half);
                  const beforeEnd = s + each;
                  const afterStart = e - each;
                  return {
                    before: { start: fromMinutes(s), end: fromMinutes(beforeEnd) },
                    after: { start: fromMinutes(afterStart), end: fromMinutes(e) },
                  };
                }
                function roleRequirements(st: any, shiftName: string, dayKey: string): Record<string, number> {
                  const out: Record<string, number> = {};
                  if (!st) return out;
                  const pushRole = (name?: string, count?: number, enabled?: boolean) => {
                    const rn = (name || "").trim();
                    const c = Number(count || 0);
                    if (!rn || !enabled || c <= 0) return;
                    out[rn] = (out[rn] || 0) + c;
                  };
                  if (st.perDayCustom) {
                    const dayCfg = st.dayOverrides?.[dayKey];
                    if (!dayCfg || dayCfg.active === false) return out;
                    if (st.uniformRoles) {
                      for (const r of (st.roles || [])) pushRole(r?.name, r?.count, r?.enabled);
                    } else {
                      const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
                      for (const r of ((sh?.roles as any[]) || [])) pushRole(r?.name, r?.count, r?.enabled);
                    }
                    return out;
                  }
                  // global mode
                  if (st.uniformRoles) {
                    for (const r of (st.roles || [])) pushRole(r?.name, r?.count, r?.enabled);
                  } else {
                    const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
                    for (const r of ((sh?.roles as any[]) || [])) pushRole(r?.name, r?.count, r?.enabled);
                  }
                  return out;
                }
                // Normalisation robuste des libellés de rôle pour éviter les mismatches (casse/espaces/forme)
                function normRole(n: string): string {
                  return (n || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
                }
                function nameHasRole(name: string, roleName: string): boolean {
                  const w = workers.find((x) => (x.name || "").trim() === (name || "").trim());
                  if (!w) return false;
                  const target = normRole(roleName);
                  return (w.roles || []).some((r) => normRole(String(r)) === target);
                }
                function assignRoles(assignedNames: string[], st: any, shiftName: string, dayKey: string): Map<string, string | null> {
                  const req = roleRequirements(st, shiftName, dayKey);
                  const res = new Map<string, string | null>();
                  const used = new Set<number>();
                  // prefill null
                  assignedNames.forEach((nm) => res.set(nm, null));
                  // greedy fill per role
                  for (const [rName, rCount] of Object.entries(req)) {
                    let left = rCount;
                    if (left <= 0) continue;
                    for (let i = 0; i < assignedNames.length && left > 0; i++) {
                      if (used.has(i)) continue;
                      const nm = assignedNames[i];
                      if (!nameHasRole(nm, rName)) continue;
                      res.set(nm, rName);
                      used.add(i);
                      left--;
                    }
                  }
                  return res;
                }
                return (
                  <div className="space-y-6">
                    {(site?.config?.stations || []).map((st: any, idx: number) => (
                      <div key={idx} className="rounded-xl border p-3 dark:border-zinc-800">
                        <div className="mb-2 flex items-center justify-between">
                          <div className="text-base font-medium">{st.name}</div>
                          <div className="flex items-center gap-1">
                            {isManual && (!!aiPlan?.assignments || !!manualAssignments) && (
                          <button
                            type="button"
                            onClick={() => {
                                  if (isSavedMode && !editingSaved) return;
                                  const effective = (isManual && manualAssignments) ? manualAssignments : (aiPlan?.assignments || null);
                                  if (!effective) {
                                    toast.error("אין תכנון פעיל", { description: "צור תכנון כדי להשתמש במשיכות" });
                                    return;
                                  }
                                  // Vérifier qu'il existe au moins un "trou" ISOLÉ (vide entre deux gardes remplies),
                                  // y compris à cheval sur 2 jours (dim -> lun). Si 2 trous ou plus d'affilée: ignorer.
                                  const shiftsCount = shiftNamesAll.length;
                                  const cellCount = (dayIdx: number, shiftIdx: number): number => {
                                    if (dayIdx < 0 || dayIdx > 6) return 0;
                                    if (shiftIdx < 0 || shiftIdx >= shiftsCount) return 0;
                                    const dayKey = dayCols[dayIdx]?.key;
                                    const shiftName = shiftNamesAll[shiftIdx];
                                    const required = getRequiredFor(st, shiftName, dayKey);
                                    if (!required || required <= 0) return 0;
                                    const activeDay = isDayActive(st, dayKey);
                                    if (!activeDay) return 0;
                                    const stationShift = (st.shifts || []).find((x: any) => x?.name === shiftName);
                                    const enabled = !!stationShift?.enabled;
                                    if (!enabled) return 0;
                                    const cell = (effective as any)?.[dayKey]?.[shiftName]?.[idx];
                                    const names = Array.isArray(cell) ? (cell as any[]).filter((x) => x && String(x).trim()) : [];
                                    return names.length;
                                  };
                                  let hasHole = false;
                                  for (let dayIdx = 0; dayIdx < dayCols.length; dayIdx++) {
                                    for (let sIdx = 0; sIdx < shiftsCount; sIdx++) {
                                      const dayKey = dayCols[dayIdx]?.key;
                                      const shiftName = shiftNamesAll[sIdx];
                                      const required = getRequiredFor(st, shiftName, dayKey);
                                      if (!required || required <= 0) continue;
                                      const stationShift = (st.shifts || []).find((x: any) => x?.name === shiftName);
                                      const enabled = !!stationShift?.enabled;
                                      const activeDay = isDayActive(st, dayKey);
                                      if (!enabled || !activeDay) continue;
                                      const cur = cellCount(dayIdx, sIdx);
                                      if (cur !== 0) continue;
                                      // prev / next in timeline (跨日)
                                      const prev = (dayIdx === 0 && sIdx === 0) ? null : (sIdx === 0 ? { dayIdx: dayIdx - 1, sIdx: shiftsCount - 1 } : { dayIdx, sIdx: sIdx - 1 });
                                      const next = (dayIdx === 6 && sIdx === shiftsCount - 1) ? null : (sIdx === shiftsCount - 1 ? { dayIdx: dayIdx + 1, sIdx: 0 } : { dayIdx, sIdx: sIdx + 1 });
                                      if (!prev || !next) continue;
                                      const prevCount = cellCount(prev.dayIdx, prev.sIdx);
                                      const nextCount = cellCount(next.dayIdx, next.sIdx);
                                      // Trou isolé: les deux côtés sont remplis (=> pas de trous consécutifs)
                                      if (prevCount > 0 && nextCount > 0) { hasHole = true; break; }
                                    }
                                    if (hasHole) break;
                                  }
                                  if (!hasHole) {
                                    toast("אין חורים בעמדה זו", { description: "לא נמצאה משמרת ריקה בין שתי משמרות" });
                                    return;
                                  }
                                  setPullsEditor(null);
                                  setPullsModeStationIdx((prev) => (prev === idx ? null : idx));
                                }}
                                disabled={isSavedMode && !editingSaved}
                                className={
                                  "inline-flex items-center rounded-md border px-2 py-1 text-xs " +
                                  ((isSavedMode && !editingSaved)
                                    ? "border-zinc-200 text-zinc-400 cursor-not-allowed opacity-60 dark:border-zinc-700 dark:text-zinc-600"
                                    : (pullsModeStationIdx === idx
                                      ? "border-orange-500 bg-orange-500 text-white hover:bg-orange-600 dark:border-orange-600 dark:bg-orange-600 dark:hover:bg-orange-700"
                                      : "border-orange-400 text-orange-600 hover:bg-orange-50 dark:border-orange-700 dark:text-orange-400 dark:hover:bg-orange-900/20"))
                                }
                              >
                                משיכות
                              </button>
                            )}
                          {isManual ? (
                          <button
                            type="button"
                            onClick={() => {
                              // Si une משיכה a été enregistrée sur cette עמדה, la supprimer lors de l'איפוס עמדה
                              setPullsByHoleKey((prev) => {
                                const next: Record<string, PullEntry> = {};
                                Object.entries(prev || {}).forEach(([k, v]) => {
                                  const parts = String(k).split("|");
                                  const stationIdx = parts.length >= 3 ? parts[2] : "";
                                  if (String(stationIdx) !== String(idx)) next[k] = v as any;
                                });
                                return next;
                              });
                              setPullsEditor(null);

                              if (isManual) {
                                setManualAssignments((prev) => {
                                  if (!prev) return prev;
                                  const base = JSON.parse(JSON.stringify(prev));
                                  const dayKeys = ["sun","mon","tue","wed","thu","fri","sat"];
                                  const shiftNames: string[] = Array.from(
                                    new Set(
                                      (site?.config?.stations || [])
                                        .flatMap((station: any) => (station?.shifts || [])
                                          .filter((sh: any) => sh?.enabled)
                                          .map((sh: any) => sh?.name))
                                        .filter(Boolean)
                                    )
                                  ).map(String);
                                  // Collecte des noms retirés (manuel) par (jour, shift)
                                  const removedMapManual: Record<string, Record<string, Set<string>>> = {};
                                  for (const d of dayKeys) {
                                    const dayData = (base as Record<string, any>)[d as string] as Record<string, any[]> | undefined;
                                    if (!dayData) continue;
                                    for (const sn of shiftNames) {
                                      const shiftData = (dayData as Record<string, any[]>)[sn as string] as any[] | undefined;
                                      if (!Array.isArray(shiftData)) continue;
                                      if (Array.isArray(shiftData[idx])) {
                                        const removed = Array.isArray(shiftData[idx])
                                          ? (shiftData[idx] as string[]).map((s) => (s || "").trim()).filter(Boolean)
                                          : [];
                                        if (removed.length > 0) {
                                          removedMapManual[d as string] = (removedMapManual[d as string] || {}) as Record<string, Set<string>>;
                                          removedMapManual[d as string][sn as string] = removedMapManual[d as string][sn as string] || new Set<string>();
                                          removed.forEach((nm) => removedMapManual[d as string][sn as string].add(nm));
                                        }
                                        shiftData[idx] = [];
                                      }
                                    }
                                  }
                                  // Mise à jour des overlays pour le mode manuel
                                  try {
                                    setAvailabilityOverlays((prevOv) => {
                                      const next: any = { ...prevOv };
                                      for (const d of Object.keys(removedMapManual)) {
                                        for (const sn of Object.keys(removedMapManual[d as string] || {})) {
                                          const namesRemoved = Array.from((removedMapManual[d as string]?.[sn as string] || new Set<string>()) as Set<string>);
                                          const perStationAll: string[][] = (((base as any) || {})?.[d as string]?.[sn as string] || []) as any;
                                          for (const nm of namesRemoved) {
                                            const stillThere = (perStationAll || []).some((cell: any) => Array.isArray(cell) && cell.some((x: any) => (x || "").trim() === nm));
                                            if (!stillThere) {
                                              if ((next as any)?.[nm]?.[d as string]) {
                                                const list: string[] = Array.from(((next as any)[nm][d as string] || []) as string[]);
                                                const filtered = list.filter((s) => s !== sn);
                                                if (filtered.length > 0) {
                                                  (next as any)[nm][d as string] = filtered;
                                                } else {
                                                  delete (next as any)[nm][d as string];
                                                  if (Object.keys(((next as any)[nm] || {})).length === 0) delete (next as any)[nm];
                                      }
                                    }
                                  }
                                          }
                                        }
                                      }
                                      return next;
                                    });
                                  } catch {}
                                  return base;
                                });
                                setManualRoleHints((prevHints) => {
                                  if (!prevHints) return prevHints;
                                  const base = JSON.parse(JSON.stringify(prevHints));
                                  const dayKeys = ["sun","mon","tue","wed","thu","fri","sat"];
                                  const shiftNames: string[] = Array.from(
                                    new Set(
                                      (site?.config?.stations || [])
                                        .flatMap((station: any) => (station?.shifts || [])
                                          .filter((sh: any) => sh?.enabled)
                                          .map((sh: any) => sh?.name))
                                        .filter(Boolean)
                                    )
                                  ).map(String);
                                  for (const d of dayKeys) {
                                    const dayData: any = (base as any)[d];
                                    if (!dayData) continue;
                                    for (const sn of shiftNames) {
                                      // @ts-ignore
                                      const shiftData: any = dayData[sn];
                                      if (!shiftData) continue;
                                      const arr = shiftData as any;
                                      if (Array.isArray(arr) && Array.isArray(arr[idx])) {
                                        arr[idx] = [];
                                      }
                                    }
                                  }
                                  return base;
                                });
                              } else {
                                setAiPlan((prev) => {
                                  if (!prev || !prev.assignments) return prev;
                                  const base = JSON.parse(JSON.stringify(prev));
                                  const dayKeys = ["sun","mon","tue","wed","thu","fri","sat"];
                                  const shiftNames = Array.from(
                                    new Set(
                                      (site?.config?.stations || [])
                                        .flatMap((station: any) => (station?.shifts || [])
                                          .filter((sh: any) => sh?.enabled)
                                          .map((sh: any) => sh?.name))
                                        .filter(Boolean)
                                    )
                                  );
                                  // Collecte des noms retirés par (jour, shift)
                                  const removedMap: Record<string, Record<string, Set<string>>> = {};
                                  for (const d of dayKeys) {
                                    const dayData = (base.assignments as Record<string, Record<string, any[]>>)[d as string] as Record<string, any[]> | undefined;
                                    if (!dayData) continue;
                                    for (const sn of shiftNames) {
                                      const shiftData = (dayData as Record<string, any[]>)[sn as string] as any[] | undefined;
                                      if (!shiftData) continue;
                                      const arr = shiftData as any;
                                      if (Array.isArray(arr) && Array.isArray(arr[idx])) {
                                        const removed = Array.isArray(arr[idx]) ? (arr[idx] as string[]).map((s) => (s || "").trim()).filter(Boolean) : [];
                                        if (removed.length > 0) {
                                          removedMap[d as string] = (removedMap[d as string] || {}) as Record<string, Set<string>>;
                                          removedMap[d as string][sn as string] = removedMap[d as string][sn as string] || new Set<string>();
                                          removed.forEach((nm) => removedMap[d as string][sn as string].add(nm));
                                        }
                                        arr[idx] = [];
                                      }
                                    }
                                  }
                                  // Met à jour les overlays: retirer le rouge si le nom n'apparaît plus sur ce jour/shift
                                  try {
                                    setAvailabilityOverlays((prevOv) => {
                                      const next: any = { ...prevOv };
                                      for (const d of Object.keys(removedMap)) {
                                        for (const sn of Object.keys(removedMap[d as string] || {})) {
                                          const namesRemoved = Array.from((removedMap[d as string]?.[sn as string] || new Set<string>()) as Set<string>);
                                          const perStationAll: string[][] = ((base.assignments as any)?.[d as string]?.[sn as string] || []) as any;
                                          for (const nm of namesRemoved) {
                                            const stillThere = (perStationAll || []).some((cell: any) => Array.isArray(cell) && cell.some((x: any) => (x || "").trim() === nm));
                                            if (!stillThere) {
                                              if ((next as any)?.[nm]?.[d as string]) {
                                                const list: string[] = Array.from(((next as any)[nm][d as string] || []) as string[]);
                                                const filtered = list.filter((s) => s !== sn);
                                                if (filtered.length > 0) {
                                                  (next as any)[nm][d as string] = filtered;
                                                } else {
                                                  delete (next as any)[nm][d as string];
                                                  if (Object.keys(((next as any)[nm] || {})).length === 0) delete (next as any)[nm];
                                                }
                                              }
                                            }
                                          }
                                        }
                                      }
                                      return next;
                                    });
                                  } catch {}
                                  return base;
                                });
                              }
                            }}
                            disabled={isSavedMode && !editingSaved}
                            className={
                              "inline-flex items-center rounded-md border px-2 py-1 text-xs " +
                              ((isSavedMode && !editingSaved)
                                ? "border-zinc-200 text-zinc-400 cursor-not-allowed opacity-60 dark:border-zinc-700 dark:text-zinc-600"
                                : "border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20")
                            }
                          >
                            איפוס עמדה
                          </button>
                          ) : null}
                        </div>
                        </div>
                        {/* Sur mobile: pas de scroll horizontal, tout doit tenir */}
                        <div className="max-h-[24rem] overflow-y-auto overflow-x-hidden md:overflow-x-auto">
                          <table className="w-full border-collapse table-fixed text-[8px] md:text-sm">
                            <thead>
                              <tr className="border-b dark:border-zinc-800">
                                <th className="px-0 md:px-2 py-0.5 md:py-2 text-right align-bottom w-10 md:w-28 text-[8px] md:text-sm">משמרת</th>
                                {dayCols.map((d, i) => {
                                  const date = addDays(weekStart, i);
                                  return (
                                    <th key={d.key} className="px-0.5 md:px-2 py-0.5 md:py-2 text-center align-bottom">
                                      <div className="flex flex-col items-center leading-tight min-w-0">
                                        <span className="text-[5px] md:text-xs text-zinc-500 whitespace-nowrap max-w-full truncate">
                                          {formatHebDate(date)}
                                        </span>
                                        <span className="mt-0.5 text-[8px] md:text-sm">{d.label}</span>
                                      </div>
                                    </th>
                                  );
                                })}
                              </tr>
                            </thead>
                            <tbody>
                              {shiftNamesAll.map((sn) => {
                                const stationShift = (st.shifts || []).find((x: any) => x?.name === sn);
                                const enabled = !!stationShift?.enabled;
                                return (
                                  <tr key={sn} className="border-b last:border-0 dark:border-zinc-800">
                                <td className="px-0 md:px-2 py-0.5 md:py-2 w-10 md:w-28">
                                  <div className="flex flex-col items-start min-w-0">
                                    {(() => {
                                      const h = hoursFromConfig(st, sn) || hoursOf(sn);
                                      return h ? (
                                        <div className="text-[7px] md:text-[10px] leading-none text-zinc-500 mb-0.5" dir="ltr">
                                          {(() => {
                                            const s = String(h || "").trim();
                                            const parts = s.split(/[-–—]/).map((x) => x.trim()).filter(Boolean);
                                            if (parts.length >= 2) {
                                              return (
                                                <span className="flex flex-col">
                                                  <span>{parts[0]}</span>
                                                  <span>{parts[1]}</span>
                                                </span>
                                              );
                                            }
                                            return s;
                                          })()}
                                        </div>
                                      ) : null;
                                    })()}
                                    <div className="font-medium text-[6px] md:text-sm whitespace-normal break-words leading-tight">{sn}</div>
                                  </div>
                                </td>
                                    {dayCols.map((d, dayIdx) => {
                                      const required = getRequiredFor(st, sn, d.key);
                                      const dateCell = addDays(weekStart, dayIdx);
                                      const today0 = new Date(); today0.setHours(0,0,0,0);
                                      const isPastDay = dateCell < today0; // Jours passés (sans le jour actuel), toujours grisés
                                      const getCellNames = (dayKey: string, shiftName: string): string[] => {
                                        // En mode ערוך, utiliser les assignations en cours d'édition, sinon utiliser savedWeekPlan
                                        if (editingSaved) {
                                          if (isManual && manualAssignments) {
                                            const cell = (manualAssignments as any)[dayKey]?.[shiftName]?.[idx];
                                            return Array.isArray(cell) ? (cell as any[]).filter((x) => x && String(x).trim()) : [];
                                          }
                                          if (aiPlan?.assignments) {
                                            const cell = (aiPlan.assignments as any)[dayKey]?.[shiftName]?.[idx];
                                            return Array.isArray(cell) ? (cell as any[]).filter((x) => x && String(x).trim()) : [];
                                          }
                                          // Fallback: utiliser savedWeekPlan si les assignations en cours d'édition ne sont pas encore chargées
                                          if (savedWeekPlan?.assignments) {
                                            const savedCell = (savedWeekPlan as any).assignments?.[dayKey]?.[shiftName]?.[idx];
                                            return Array.isArray(savedCell) ? (savedCell as any[]).filter((x) => x && String(x).trim()) : [];
                                          }
                                          return [];
                                        }
                                        // Mode normal: si on est en manuel avec une grille chargée, elle prime.
                                        // En automatique, toujours privilégier le plan AI courant s'il existe,
                                        // sinon seulement retomber sur le planning sauvegardé.
                                        if (isManual && manualAssignments) {
                                          const cell = (manualAssignments as any)[dayKey]?.[shiftName]?.[idx];
                                          return Array.isArray(cell) ? (cell as any[]).filter((x) => x && String(x).trim()) : [];
                                        }
                                        if (aiPlan?.assignments) {
                                          const cell = (aiPlan.assignments as any)[dayKey]?.[shiftName]?.[idx];
                                          return Array.isArray(cell) ? (cell as any[]).filter((x) => x && String(x).trim()) : [];
                                        }
                                        if (savedWeekPlan?.assignments) {
                                          const savedCell = (savedWeekPlan as any).assignments?.[dayKey]?.[shiftName]?.[idx];
                                          if (Array.isArray(savedCell)) return (savedCell as any[]).filter((x) => x && String(x).trim());
                                        }
                                        return [];
                                      };
                                      let assignedNames: string[] = getCellNames(d.key, sn);
                                      // Garantir l'affichage des 2 personnes d'une משיכה même si l'assignation n'a qu'1 nom
                                      // (ex: après switch auto->manual, ou si l'utilisateur a modifié la cellule)
                                      const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                      const pullEntriesHere: any[] = Object.entries(pullsByHoleKey || {})
                                        .filter(([k]) => String(k).startsWith(cellPrefix))
                                        .map(([, e]) => e as any);
                                      const normPullNameLocal = (s: any) =>
                                        String(s || "")
                                          .normalize("NFKC")
                                          .trim()
                                          .replace(/\s+/g, " ");
                                      /** שמור / שמור ואשלח sans עריכה : aucune interaction sur les bulles d'une משיכה */
                                      const blockSavedViewPullBubble = (workerName: string) => {
                                        if (!isSavedMode || editingSaved) return false;
                                        const nmN = normPullNameLocal(workerName);
                                        if (!nmN) return false;
                                        return pullEntriesHere.some((e: any) => {
                                          const b = normPullNameLocal(e?.before?.name);
                                          const a = normPullNameLocal(e?.after?.name);
                                          return b === nmN || a === nmN;
                                        });
                                      };
                                      const pullRoleMap = new Map<string, string>();
                                      pullEntriesHere.forEach((e) => {
                                        const rn = String(e?.roleName || "").trim();
                                        if (!rn) return;
                                        const b = String(e?.before?.name || "").trim();
                                        const a = String(e?.after?.name || "").trim();
                                        if (b) pullRoleMap.set(b, rn);
                                        if (a) pullRoleMap.set(a, rn);
                                      });
                                      // Forcer l'affichage "avant puis après" l'un sous l'autre (la case "ajoutée" par la משיכה)
                                      const orderNamesByPullPairs = (namesIn: string[], entries: any[]): string[] => {
                                        const base = (namesIn || []).map((x) => String(x || "").trim()).filter(Boolean);
                                        const uniq: string[] = [];
                                        const seen = new Set<string>();
                                        base.forEach((n) => { if (!seen.has(n)) { seen.add(n); uniq.push(n); } });
                                        const pair = new Map<string, string>();
                                        (entries || []).forEach((e) => {
                                          const b = String(e?.before?.name || "").trim();
                                          const a = String(e?.after?.name || "").trim();
                                          if (b && a) pair.set(b, a);
                                        });
                                        // Déplacer "after" juste après "before"
                                        for (let i = 0; i < uniq.length; i++) {
                                          const b = uniq[i];
                                          const a = pair.get(b);
                                          if (!a) continue;
                                          const j = uniq.indexOf(a);
                                          if (j === -1) continue;
                                          if (j === i + 1) continue;
                                          uniq.splice(j, 1);
                                          uniq.splice(i + 1, 0, a);
                                        }
                                        return uniq;
                                      };
                                      if (pullEntriesHere.length > 0) {
                                        const wanted = new Set<string>();
                                        pullEntriesHere.forEach((e) => {
                                          const b = String(e?.before?.name || "").trim();
                                          const a = String(e?.after?.name || "").trim();
                                          if (b) wanted.add(b);
                                          if (a) wanted.add(a);
                                        });
                                        const have = new Set<string>(assignedNames.map((x) => String(x || "").trim()).filter(Boolean));
                                        wanted.forEach((nm) => { if (!have.has(nm)) assignedNames.push(nm); });
                                      }
                                      // Après avoir garanti la présence des 2 noms, les mettre l'un sous l'autre
                                      assignedNames = orderNamesByPullPairs(assignedNames, pullEntriesHere);

                                      const roleMap = assignRoles(assignedNames, st, sn, d.key);
                                      // Pour les משיכות avec rôle: forcer le rôle sur les 2 travailleurs,
                                      // sinon le 2e peut être classé "sans rôle" et ne pas être affiché.
                                      try {
                                        pullRoleMap.forEach((rName, nm) => {
                                          const n = String(nm || "").trim();
                                          const r = String(rName || "").trim();
                                          if (!n || !r) return;
                                          (roleMap as any).set(n, r);
                                        });
                                      } catch {}
                                      // Comptage: une "משיכה" (2 personnes) doit compter comme 1 seule place.
                                      const pullsInCell = pullEntriesHere.length;
                                      const personsCount = assignedNames.length;
                                      const assignedCount = Math.max(0, personsCount - pullsInCell); // places prises
                                      const activeDay = isDayActive(st, d.key);
                                      const pullsActiveHere = pullsModeStationIdx === idx;
                                      // "Trou pullable": la garde (shift) est entre 2 gardes remplies dans la timeline
                                      // (y compris dim->lun). On ne surligne QUE les slots vides.
                                      const shiftsCount = shiftNamesAll.length;
                                      const shiftIdx = shiftNamesAll.indexOf(sn);
                                      const prevCoord = (dayIdx === 0 && shiftIdx === 0)
                                        ? null
                                        : (shiftIdx === 0 ? { dayIdx: dayIdx - 1, shiftIdx: shiftsCount - 1 } : { dayIdx, shiftIdx: shiftIdx - 1 });
                                      const nextCoord = (dayIdx === 6 && shiftIdx === shiftsCount - 1)
                                        ? null
                                        : (shiftIdx === shiftsCount - 1 ? { dayIdx: dayIdx + 1, shiftIdx: 0 } : { dayIdx, shiftIdx: shiftIdx + 1 });
                                      // IMPORTANT: ne pas considérer comme "voisins" les travailleurs ajoutés via משיכות
                                      // dans la garde d'avant/d'après (sinon ils permettent d'enchaîner des משיכות).
                                      // Ensemble des travailleurs impliqués dans une משיכה pour un (jour, shift),
                                      // toutes עמדות confondues (fatigue globale).
                                      const pulledNamesFor = (dayKey: string, shiftName: string): Set<string> => {
                                        const out = new Set<string>();
                                        const prefix = `${dayKey}|${shiftName}|`;
                                        Object.entries(pullsByHoleKey || {}).forEach(([k, e]) => {
                                          if (!String(k).startsWith(prefix)) return;
                                          const pe: any = e;
                                          if (pe?.before?.name) out.add(String(pe.before.name).trim());
                                          if (pe?.after?.name) out.add(String(pe.after.name).trim());
                                        });
                                        return out;
                                      };
                                      const neighborNames = (dayKey: string, shiftName: string): string[] => {
                                        const base = getCellNames(dayKey, shiftName);
                                        const pulled = pulledNamesFor(dayKey, shiftName);
                                        // Ne pas utiliser comme "voisin" quelqu'un déjà impliqué dans une משיכה sur ce shift
                                        return (base || []).filter((nm) => !pulled.has(String(nm).trim()));
                                      };
                                      const prevNames = prevCoord ? neighborNames(dayCols[prevCoord.dayIdx]?.key, shiftNamesAll[prevCoord.shiftIdx]) : [];
                                      const nextNames = nextCoord ? neighborNames(dayCols[nextCoord.dayIdx]?.key, shiftNamesAll[nextCoord.shiftIdx]) : [];
                                      const sameCoord = (
                                        a: { dayIdx: number; shiftIdx: number } | null,
                                        bDayIdx: number,
                                        bShiftIdx: number,
                                      ) => !!a && a.dayIdx === bDayIdx && a.shiftIdx === bShiftIdx;
                                      const pullHighlightKindByName = new Map<string, "cell" | "before" | "after">();
                                      Object.entries(pullsByHoleKey || {}).forEach(([pullKey, entryAny]) => {
                                        const parts = String(pullKey || "").split("|");
                                        if (parts.length < 3) return;
                                        const [pullDayKey, pullShiftName, pullStationIdxRaw] = parts;
                                        if (Number(pullStationIdxRaw) !== Number(idx)) return;
                                        const pullDayIdx = dayCols.findIndex((col) => col?.key === pullDayKey);
                                        const pullShiftIdx = shiftNamesAll.indexOf(pullShiftName);
                                        if (pullDayIdx < 0 || pullShiftIdx < 0) return;
                                        const pullPrevCoord = (pullDayIdx === 0 && pullShiftIdx === 0)
                                          ? null
                                          : (pullShiftIdx === 0 ? { dayIdx: pullDayIdx - 1, shiftIdx: shiftsCount - 1 } : { dayIdx: pullDayIdx, shiftIdx: pullShiftIdx - 1 });
                                        const pullNextCoord = (pullDayIdx === 6 && pullShiftIdx === shiftsCount - 1)
                                          ? null
                                          : (pullShiftIdx === shiftsCount - 1 ? { dayIdx: pullDayIdx + 1, shiftIdx: 0 } : { dayIdx: pullDayIdx, shiftIdx: pullShiftIdx + 1 });
                                        const entry = entryAny as any;
                                        const beforeName = String(entry?.before?.name || "").trim();
                                        const afterName = String(entry?.after?.name || "").trim();
                                        if (pullDayKey === d.key && pullShiftName === sn) {
                                          if (beforeName) pullHighlightKindByName.set(beforeName, "cell");
                                          if (afterName) pullHighlightKindByName.set(afterName, "cell");
                                          return;
                                        }
                                        if (beforeName && sameCoord(pullPrevCoord, dayIdx, shiftIdx)) {
                                          pullHighlightKindByName.set(beforeName, "before");
                                        }
                                        if (afterName && sameCoord(pullNextCoord, dayIdx, shiftIdx)) {
                                          pullHighlightKindByName.set(afterName, "after");
                                        }
                                      });
                                      const pullHighlightClassForName = (workerName: string) => {
                                        const relation = pullHighlightKindByName.get(String(workerName || "").trim());
                                        if (!relation) return "";
                                        if (relation === "cell") {
                                          return blockSavedViewPullBubble(workerName)
                                            ? " ring-2 ring-orange-400 cursor-default"
                                            : " ring-2 ring-orange-400 cursor-pointer";
                                        }
                                        return " ring-2 ring-orange-400";
                                      };
                                      const remainingCapacity = Math.max(0, required - assignedCount);
                                      // Pull possible seulement si on a AU MOINS un candidat "avant" et un candidat "après"
                                      // qui ne sont pas déjà utilisés dans la case, et que l'on peut former une paire de 2 noms différents.
                                      const usedInCell = new Set<string>(assignedNames.map((x) => String(x).trim()).filter(Boolean));
                                      // Règle "fatigue": si un travailleur a participé à une משיכה sur la garde juste avant/juste après,
                                      // il ne peut pas être réutilisé pour une nouvelle משיכה sur la garde suivante (ex: dim soir pull + lun matin => pas pull lun midi via lun matin).
                                      const prevOf = (c: { dayIdx: number; shiftIdx: number } | null) => {
                                        if (!c) return null;
                                        if (c.dayIdx === 0 && c.shiftIdx === 0) return null;
                                        return c.shiftIdx === 0 ? { dayIdx: c.dayIdx - 1, shiftIdx: shiftsCount - 1 } : { dayIdx: c.dayIdx, shiftIdx: c.shiftIdx - 1 };
                                      };
                                      const nextOf = (c: { dayIdx: number; shiftIdx: number } | null) => {
                                        if (!c) return null;
                                        if (c.dayIdx === 6 && c.shiftIdx === shiftsCount - 1) return null;
                                        return c.shiftIdx === shiftsCount - 1 ? { dayIdx: c.dayIdx + 1, shiftIdx: 0 } : { dayIdx: c.dayIdx, shiftIdx: c.shiftIdx + 1 };
                                      };
                                      const prevPrevCoord = prevOf(prevCoord);
                                      const nextNextCoord = nextOf(nextCoord);
                                      const pulledBeforePrevShift = prevPrevCoord
                                        ? pulledNamesFor(dayCols[prevPrevCoord.dayIdx]?.key, shiftNamesAll[prevPrevCoord.shiftIdx])
                                        : new Set<string>();
                                      const pulledAfterNextShift = nextNextCoord
                                        ? pulledNamesFor(dayCols[nextNextCoord.dayIdx]?.key, shiftNamesAll[nextNextCoord.shiftIdx])
                                        : new Set<string>();

                                      const beforeCandidates = (prevNames || [])
                                        .map((x) => String(x).trim())
                                        .filter(Boolean)
                                        .filter((x) => !usedInCell.has(x))
                                        .filter((x) => !pulledBeforePrevShift.has(x));
                                      const afterCandidates = (nextNames || [])
                                        .map((x) => String(x).trim())
                                        .filter(Boolean)
                                        .filter((x) => !usedInCell.has(x))
                                        .filter((x) => !pulledAfterNextShift.has(x));
                                      // Règle: si un travailleur est dans les DEUX gardes voisines (ex: dim nuit ET lun midi),
                                      // il ne peut pas participer à la משיכה du trou entre les deux.
                                      const bothSides = new Set<string>();
                                      beforeCandidates.forEach((nm) => {
                                        const n = String(nm).trim();
                                        if (!n) return;
                                        if (afterCandidates.some((x) => String(x).trim() === n)) bothSides.add(n);
                                      });
                                      const beforeCandidates2 = beforeCandidates.filter((x) => !bothSides.has(String(x).trim()));
                                      const afterCandidates2 = afterCandidates.filter((x) => !bothSides.has(String(x).trim()));
                                      // Si des rôles existent sur cette garde, il faut 2 עובדים avec le même rôle (un avant + un après)
                                      const reqRolesNow = roleRequirements(st, sn, d.key);
                                      const roleKeysNow = Object.keys(reqRolesNow || {});
                                      const canPullForRole = (roleName: string): boolean => {
                                        const r = String(roleName || "").trim();
                                        if (!r) return false;
                                        const b = beforeCandidates2.filter((nm) => nameHasRole(nm, r));
                                        const a = afterCandidates2.filter((nm) => nameHasRole(nm, r));
                                        if (b.length === 0 || a.length === 0) return false;
                                        if (b.length === 1 && a.length === 1 && b[0] === a[0]) return false;
                                        return true;
                                      };
                                      const canPickTwoDifferent = (() => {
                                        if (beforeCandidates2.length === 0 || afterCandidates2.length === 0) return false;
                                        // Aucun rôle => règle originale
                                        if (roleKeysNow.length === 0) {
                                          return !(
                                            beforeCandidates2.length === 1 &&
                                            afterCandidates2.length === 1 &&
                                            beforeCandidates2[0] === afterCandidates2[0]
                                          );
                                        }
                                        // Rôles => il doit exister au moins un rôle commun possible
                                        return roleKeysNow.some((rName) => canPullForRole(rName));
                                      })();
                                      const isPullable =
                                        enabled &&
                                        activeDay &&
                                        !isPastDay &&
                                        required > 0 &&
                                        !!prevCoord &&
                                        !!nextCoord &&
                                        remainingCapacity >= 1 &&
                                        canPickTwoDifferent;
                                      return (
                                        <td
                                          key={d.key}
                                          className={
                                            "px-2 py-2 text-center " +
                                            (enabled ? "" : "text-zinc-400 ") +
                                            (!activeDay ? "bg-zinc-100 text-zinc-400 dark:bg-zinc-900/40 " : "") +
                                            (isPastDay ? " bg-zinc-100 dark:bg-zinc-900/40 " : "")
                                          }
                                        >
                                        {enabled ? (
                                            <div
                                              className="flex flex-col items-center rounded-md"
                                              onDragOver={(isManual && !(isSavedMode && !editingSaved)) ? (e) => { e.preventDefault(); try { (e as any).dataTransfer.dropEffect = "copy"; } catch {} } : undefined}
                                              onDrop={(isManual && !(isSavedMode && !editingSaved)) ? (e) => onCellContainerDrop(e, d.key, sn, idx) : undefined}
                                            >
                                              {required > 0 ? (
                                                <div className="mb-1 flex flex-col items-center gap-1 min-w-full">
                                                  {(isManual && !(isSavedMode && !editingSaved)) ? (
                                                    <div className="flex flex-col items-center gap-1 w-full px-2 py-1">
                                                  {(() => {
                                                    const reqRoles = roleRequirements(st, sn, d.key);

                                                    // Construire la liste de slots "rôles" (toujours basée sur la config, pas sur des déficits)
                                                        const roleHints: string[] = [];
                                                    Object.entries(reqRoles || {}).forEach(([rName, rCount]) => {
                                                      const n = Number(rCount || 0);
                                                      for (let i = 0; i < n; i++) roleHints.push(String(rName));
                                                    });

                                                    // Déduire un rôle à afficher pour chaque nom (utile après auto -> manuel "שמור מיקומים")
                                                    const roleForName = new Map<string, string>();
                                                    const remaining = new Map<string, number>(
                                                      Object.entries(reqRoles || {}).map(([rName, rCount]) => [String(rName), Number(rCount || 0)]),
                                                    );

                                                    // En mode ידני: préserver l'ordre des slots (tableau brut) et séparer des noms non vides (pour les calculs).
                                                    const cellRaw: string[] = (() => {
                                                      try {
                                                        const cell = (manualAssignments as any)?.[d.key]?.[sn]?.[idx];
                                                        const baseArr = Array.isArray(cell) ? (cell as any[]).map((x) => String(x ?? "")) : [];
                                                        // Garantir que les 2 noms d'une משיכה existent dans les slots (sans changer l'ordre existant):
                                                        // si un nom manque, le placer dans un slot vide, sinon l'ajouter à la fin.
                                                        const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                        const normSlot = (s: any) => String(s ?? "");
                                                        const normName = (s: any) =>
                                                          String(s || "")
                                                            .normalize("NFKC")
                                                            .trim()
                                                            .replace(/\s+/g, " ");
                                                        const have = new Set<string>(baseArr.map((x) => normName(x)).filter(Boolean));
                                                        const addInto = (name: string) => {
                                                          const n = normName(name);
                                                          if (!n || have.has(n)) return;
                                                          const emptyIdx = baseArr.findIndex((x) => !normName(x));
                                                          if (emptyIdx >= 0) baseArr[emptyIdx] = normSlot(name);
                                                          else baseArr.push(normSlot(name));
                                                          have.add(n);
                                                        };
                                                        try {
                                                          Object.entries(pullsByHoleKey || {}).forEach(([k, entry]) => {
                                                            if (!String(k).startsWith(cellPrefix)) return;
                                                            const b = String((entry as any)?.before?.name || "").trim();
                                                            const a = String((entry as any)?.after?.name || "").trim();
                                                            if (b) addInto(b);
                                                            if (a) addInto(a);
                                                          });
                                                        } catch {}
                                                        return baseArr;
                                                      } catch {
                                                        return [];
                                                      }
                                                    })();
                                                    const assignedNamesNonEmpty: string[] = (cellRaw || [])
                                                      .map((x) => String(x || "").trim())
                                                      .filter(Boolean);

                                                    // Priorité: si un nom provient d'une משיכה avec roleName, afficher ce rôle.
                                                    // On décrémente seulement si ce rôle est effectivement requis et encore disponible.
                                                    (assignedNamesNonEmpty || []).forEach((nm) => {
                                                      const nameTrimmed = String(nm || "").trim();
                                                      const pr = pullRoleMap.get(nameTrimmed) || null;
                                                      if (!pr) return;
                                                      if (!nameHasRole(nameTrimmed, pr)) return;
                                                      roleForName.set(nameTrimmed, pr);
                                                      if (remaining.has(pr) && (remaining.get(pr) || 0) > 0) {
                                                        remaining.set(pr, (remaining.get(pr) || 0) - 1);
                                                      }
                                                    });

                                                    // Allocation simple des rôles restants par déficit
                                                    (assignedNamesNonEmpty || []).forEach((nm) => {
                                                      const nameTrimmed = String(nm || "").trim();
                                                      if (!nameTrimmed) return;
                                                      if (roleForName.has(nameTrimmed)) return;
                                                      for (const [rName, cnt] of Array.from(remaining.entries())) {
                                                        if ((cnt || 0) <= 0) continue;
                                                        if (!nameHasRole(nameTrimmed, rName)) continue;
                                                        roleForName.set(nameTrimmed, rName);
                                                        remaining.set(rName, (cnt || 0) - 1);
                                                        break;
                                                      }
                                                    });

                                                    // IMPORTANT:
                                                    // Quand on a une משיכה, on affiche 2 personnes pour 1 place.
                                                    // Cela ajoute des "slots" visuels, mais il faut conserver les placeholders de rôles
                                                    // pour les rôles encore manquants (sinon on voit un slot vide "neutre").
                                                    const roleHintsExtended: string[] = [
                                                      ...roleHints,
                                                      ...Array.from(remaining.entries())
                                                        .flatMap(([rName, cnt]) =>
                                                          Array.from({ length: Math.max(0, Number(cnt || 0)) }, () => String(rName)),
                                                        ),
                                                    ];

                                                        // +pullsInCell: pour afficher 2 bulles pour une seule place (משיכה)
                                                        const slots = Math.max(required + pullsInCell, assignedNamesNonEmpty.length, roleHints.length, 1);
                                                        return Array.from({ length: slots }).map((_, slotIdx) => {
                                                          const nm = String(cellRaw[slotIdx] || "").trim();
                                                          if (nm) {
                                                            const nmKey = String(nm || "")
                                                              .normalize("NFKC")
                                                              .trim()
                                                              .replace(/\s+/g, " ");
                                                            const expKey = expandedKeyFor(d.key, sn, idx, slotIdx, nmKey);
                                                            const c = colorForName(nm);
                                                            const hintedStored = ((manualRoleHints as any)?.[d.key]?.[sn]?.[idx]?.[slotIdx] ?? null) as (string | null);
                                                            const pullRn = pullRoleMap.get(String(nm || "").trim()) || null;
                                                            const hintedOk = hintedStored && nameHasRole(nm, hintedStored) ? hintedStored : null;
                                                            const rn =
                                                              hintedOk ||
                                                              (pullRn && nameHasRole(nm, pullRn) ? pullRn : null) ||
                                                              (roleForName.get(String(nm || "").trim()) || null);
                                                            // Aligner l'affichage des משיכות sur l'automatique:
                                                            // si ce nom fait partie d'une משיכה, afficher aussi roleName (couleur/bordure + libellé).
                                                            const pullRoleName = (() => {
                                                              const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                              const norm = (s: any) =>
                                                                String(s || "")
                                                                  .normalize("NFKC")
                                                                  .trim()
                                                                  .replace(/\s+/g, " ");
                                                              const nmN = norm(nm);
                                                              const match = Object.entries(pullsByHoleKey || {}).find(([k, entry]) => {
                                                                if (!String(k).startsWith(cellPrefix)) return false;
                                                                const e: any = entry;
                                                                return norm(e?.before?.name) === nmN || norm(e?.after?.name) === nmN;
                                                              });
                                                              if (!match) return null;
                                                              const [, entryAny] = match as any;
                                                              const e: any = entryAny;
                                                              return String(e?.roleName || "").trim() || null;
                                                            })();
                                                            const roleToShow = rn || pullRoleName || null;
                                                            const rc = roleToShow ? colorForRole(roleToShow) : null;
                                                            return (
                                                              <div
                                                                key={"slot-nm-wrapper-" + slotIdx}
                                                                className="group/slot relative w-full flex justify-center py-0.5"
                                                                onDragEnter={(e) => {
                                                                  e.preventDefault();
                                                                  e.stopPropagation();
                                                                  setHoverSlotKey(`${d.key}|${sn}|${idx}|${slotIdx}`);
                                                                }}
                                                                onDragLeave={(e) => {
                                                                  const rect = e.currentTarget.getBoundingClientRect();
                                                                  const x = e.clientX;
                                                                  const y = e.clientY;
                                                                  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
                                                                    setHoverSlotKey((k) => (k === `${d.key}|${sn}|${idx}|${slotIdx}` ? null : k));
                                                                  }
                                                                }}
                                                                onDragOver={onSlotDragOver}
                                                                onDrop={(e) => onSlotDrop(e, d.key, sn, idx, slotIdx)}
                                                                data-slot="1"
                                                                data-dkey={d.key}
                                                                data-sname={sn}
                                                                data-stidx={idx}
                                                                data-slotidx={slotIdx}
                                                              >
                      <span
                                                                  key={"slot-nm-" + slotIdx}
                                                                  tabIndex={blockSavedViewPullBubble(nm) ? -1 : 0}
                                                                  className={
                                                                    // Sur mobile, éviter les effets ":hover" qui peuvent impacter plusieurs slots de la même cellule.
                                                                    // Hover uniquement sur desktop (md+). Mobile = expansion via expandedSlotKey.
                                                                    "relative inline-flex min-h-6 md:min-h-9 w-auto md:w-full max-w-[6rem] md:max-w-[6rem] md:group-hover/slot:max-w-[18rem] md:focus:max-w-[18rem] min-w-0 overflow-hidden items-center rounded-full border px-1 md:px-3 py-0.5 md:py-1 shadow-sm gap-1 md:gap-2 select-none md:group-hover/slot:z-30 md:focus:z-30 focus:outline-none transition-[max-width,transform] duration-200 ease-out " +
                                                                    (hoverSlotKey === `${d.key}|${sn}|${idx}|${slotIdx}` ? "scale-110 ring-2 ring-[#00A8E0]" : "") +
                                                                    (expandedSlotKey === expKey ? " w-[18rem] max-w-[18rem] z-30" : "") +
                                                                    pullHighlightClassForName(nm)
                                                                  }
                                                                  style={{ backgroundColor: c.bg, borderColor: (rc?.border || c.border), color: c.text }}
                                                                  draggable={!blockSavedViewPullBubble(nm)}
                                                                  onPointerDown={(e) => {
                                                                    if (blockSavedViewPullBubble(nm)) {
                                                                      e.preventDefault();
                                                                      e.stopPropagation();
                                                                      return;
                                                                    }
                                                                    setExpandedSlotKey(expKey);
                                                                  }}
                                                                  onPointerEnter={(e) => {
                                                                    if (blockSavedViewPullBubble(nm)) return;
                                                                    if ((e as any)?.pointerType === "mouse") {
                                                                      setExpandedSlotKey(expKey);
                                                                    }
                                                                  }}
                                                                  onPointerLeave={(e) => {
                                                                    if ((e as any)?.pointerType === "mouse") {
                                                                      setExpandedSlotKey((k) => (k === expKey ? null : k));
                                                                    }
                                                                  }}
                                                                  onFocus={(ev) => {
                                                                    if (blockSavedViewPullBubble(nm)) {
                                                                      ev.preventDefault();
                                                                      return;
                                                                    }
                                                                    setExpandedSlotKey(expKey);
                                                                  }}
                                                                  onBlur={() => setExpandedSlotKey((k) => (k === expKey ? null : k))}
                                                                  onClick={(e) => {
                                                                    // Si cette bulle fait partie d'une משיכה, permettre d'ouvrir la popup en cliquant sur la bulle
                                                                    if (pullsModeStationIdx !== idx) return;
                                                                    if (isSavedMode && !editingSaved) return;
                                                                    const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                                    const match = Object.entries(pullsByHoleKey || {}).find(([k, entry]) => {
                                                                      if (!String(k).startsWith(cellPrefix)) return false;
                                                                      const pe: any = entry;
                                                                      return pe?.before?.name === nm || pe?.after?.name === nm;
                                                                    });
                                                                    if (!match) return;
                                                                    e.stopPropagation();
                                                                    const [k, entryAny] = match as any;
                                                                    const entry = entryAny as any;
                                                                    const hours = hoursFromConfig(st, sn) || hoursOf(sn);
                                                                    const parsed = parseHoursRange(hours);
                                                                    const shiftStart = parsed ? parsed.start : "00:00";
                                                                    const shiftEnd = parsed ? parsed.end : "23:59";
                                                                    const used = new Set(getCellNames(d.key, sn));
                                                                    const prevDayKey = prevCoord ? dayCols[prevCoord.dayIdx]?.key : null;
                                                                    const prevShiftName = prevCoord ? shiftNamesAll[prevCoord.shiftIdx] : null;
                                                                    const nextDayKey = nextCoord ? dayCols[nextCoord.dayIdx]?.key : null;
                                                                    const nextShiftName = nextCoord ? shiftNamesAll[nextCoord.shiftIdx] : null;
                                                                    const prevOptsRaw = (prevDayKey && prevShiftName) ? neighborNames(prevDayKey, prevShiftName) : [];
                                                                    const nextOptsRaw = (nextDayKey && nextShiftName) ? neighborNames(nextDayKey, nextShiftName) : [];
                                                                    const beforeOptions = Array.from(
                                                                      new Set<string>([...prevOptsRaw, String(entry?.before?.name || "").trim()].filter(Boolean)),
                                                                    ).filter((x) => !used.has(x) || x === entry?.before?.name || x === entry?.after?.name);
                                                                    const afterOptions = Array.from(
                                                                      new Set<string>([...nextOptsRaw, String(entry?.after?.name || "").trim()].filter(Boolean)),
                                                                    ).filter((x) => !used.has(x) || x === entry?.before?.name || x === entry?.after?.name);
                                                                    const roleName = String(entry?.roleName || "").trim() || null;
                                                                    const beforeOptionsRole = roleName
                                                                      ? Array.from(new Set<string>([...beforeOptions.filter((x) => nameHasRole(x, roleName)), String(entry?.before?.name || "").trim()].filter(Boolean)))
                                                                      : beforeOptions;
                                                                    const afterOptionsRole = roleName
                                                                      ? Array.from(new Set<string>([...afterOptions.filter((x) => nameHasRole(x, roleName)), String(entry?.after?.name || "").trim()].filter(Boolean)))
                                                                      : afterOptions;
                                                                    setPullsEditor({
                                                                      key: String(k),
                                                                      stationIdx: idx,
                                                                      dayKey: d.key,
                                                                      shiftName: sn,
                                                                      required,
                                                                      beforeOptions: beforeOptionsRole,
                                                                      afterOptions: afterOptionsRole,
                                                                      beforeName: entry.before.name,
                                                                      afterName: entry.after.name,
                                                                      beforeStart: entry.before.start,
                                                                      beforeEnd: entry.before.end,
                                                                      afterStart: entry.after.start,
                                                                      afterEnd: entry.after.end,
                                                                      shiftStart,
                                                                      shiftEnd,
                                                                      roleName,
                                                                    });
                                                                  }}
                                                                  onDragStart={(e) => onWorkerDragStart(e, nm)}
                                                                  onDragEnd={onWorkerDragEnd}
                                                                  data-slot="1"
                                                                  data-dkey={d.key}
                                                                  data-sname={sn}
                                                                  data-stidx={idx}
                                                                  data-slotidx={slotIdx}
                                                                >
                                                                  <span className="flex flex-col items-center text-center leading-tight flex-1 min-w-0 w-full overflow-hidden">
                                                                    {roleToShow ? (
                                                                      <span className="block w-full min-w-0 text-[7px] md:text-[10px] font-medium text-zinc-700 dark:text-zinc-300 truncate mb-0.5">{roleToShow}</span>
                                                                    ) : null}
                                                                    <span
                                                                      className={"block w-full min-w-0 max-w-full leading-tight md:text-center " + (isRtlName(nm) ? "text-right" : "text-left")}
                                                                      dir={isRtlName(nm) ? "rtl" : "ltr"}
                                                                    >
                                                                      {/* Mobile: tronqué par défaut, complet uniquement sur le slot ciblé */}
                                                                      <span className="md:hidden">
                                                                        {expandedSlotKey === expKey ? (
                                                                          <span className="whitespace-nowrap">{nm}</span>
                                                                        ) : (
                                                                          <span>{truncateMobile6(nm)}</span>
                                                                        )}
                                                                      </span>
                                                                      {/* Desktop: ellipsis classique */}
                                                                      <span className="hidden md:block w-full truncate text-[8px] md:text-sm">{nm}</span>
                                                                    </span>
                                                                    {(() => {
                                                                      const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                                      const match = Object.entries(pullsByHoleKey || {}).find(([k, entry]) => {
                                                                        if (!k.startsWith(cellPrefix)) return false;
                                                                        const e: any = entry;
                                                                        return e?.before?.name === nm || e?.after?.name === nm;
                                                                      });
                                                                      if (!match) return null;
                                                                      const [k, entryAny] = match as any;
                                                                      const entry = entryAny as any;
                                                                      const txt =
                                                                        entry?.before?.name === nm
                                                                          ? `${entry.before.start}-${entry.before.end}`
                                                                          : `${entry.after.start}-${entry.after.end}`;
                                                                      return (
                                                                        <button
                                                                          type="button"
                                                                          dir="ltr"
                                                                          className="text-[7px] md:text-[10px] leading-tight text-zinc-700/80 dark:text-zinc-300/80 underline decoration-dotted"
                                                                          onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            if (isSavedMode && !editingSaved) return;
                                                                            const hours = hoursFromConfig(st, sn) || hoursOf(sn);
                                                                            const parsed = parseHoursRange(hours);
                                                                            const shiftStart = parsed ? parsed.start : "00:00";
                                                                            const shiftEnd = parsed ? parsed.end : "23:59";
                                                                            // Exclure les travailleurs déjà utilisés par d'autres משיכות de cette même case
                                                                            const used = new Set(getCellNames(d.key, sn));
                                                                            const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                                            Object.entries(pullsByHoleKey || {}).forEach(([kk, ee]) => {
                                                                              if (!String(kk).startsWith(cellPrefix)) return;
                                                                              if (String(kk) === String(k)) return; // ne pas compter l'entrée en cours d'édition
                                                                              const e: any = ee;
                                                                              if (e?.before?.name) used.add(String(e.before.name).trim());
                                                                              if (e?.after?.name) used.add(String(e.after.name).trim());
                                                                            });
                                                                            const prevDayKey = prevCoord ? dayCols[prevCoord.dayIdx]?.key : null;
                                                                            const prevShiftName = prevCoord ? shiftNamesAll[prevCoord.shiftIdx] : null;
                                                                            const nextDayKey = nextCoord ? dayCols[nextCoord.dayIdx]?.key : null;
                                                                            const nextShiftName = nextCoord ? shiftNamesAll[nextCoord.shiftIdx] : null;
                                                                            const prevOptsRaw = (prevDayKey && prevShiftName) ? neighborNames(prevDayKey, prevShiftName) : [];
                                                                            const nextOptsRaw = (nextDayKey && nextShiftName) ? neighborNames(nextDayKey, nextShiftName) : [];
                                                                            const beforeOptions = Array.from(
                                                                              new Set<string>([...prevOptsRaw, String(entry?.before?.name || "").trim()].filter(Boolean)),
                                                                            ).filter((x) => !used.has(x) || x === entry?.before?.name || x === entry?.after?.name);
                                                                            const afterOptions = Array.from(
                                                                              new Set<string>([...nextOptsRaw, String(entry?.after?.name || "").trim()].filter(Boolean)),
                                                                            ).filter((x) => !used.has(x) || x === entry?.before?.name || x === entry?.after?.name);
                                                                            const roleName = String(entry?.roleName || "").trim() || null;
                                                                            const beforeOptionsRole = roleName
                                                                              ? Array.from(new Set<string>([...beforeOptions.filter((x) => nameHasRole(x, roleName)), String(entry?.before?.name || "").trim()].filter(Boolean)))
                                                                              : beforeOptions;
                                                                            const afterOptionsRole = roleName
                                                                              ? Array.from(new Set<string>([...afterOptions.filter((x) => nameHasRole(x, roleName)), String(entry?.after?.name || "").trim()].filter(Boolean)))
                                                                              : afterOptions;
                                                                            setPullsEditor({
                                                                              key: k,
                                                                              stationIdx: idx,
                                                                              dayKey: d.key,
                                                                              shiftName: sn,
                                                                              required,
                                                                              beforeOptions: beforeOptionsRole,
                                                                              afterOptions: afterOptionsRole,
                                                                              beforeName: entry.before.name,
                                                                              afterName: entry.after.name,
                                                                              beforeStart: entry.before.start,
                                                                              beforeEnd: entry.before.end,
                                                                              afterStart: entry.after.start,
                                                                              afterEnd: entry.after.end,
                                                                              shiftStart,
                                                                              shiftEnd,
                                                                              roleName,
                                                                            });
                                                                          }}
                                                                        >
                                                                          {txt}
                                                                        </button>
                                                                      );
                                                                    })()}
                                                                  </span>
                                                                  <button
                                                                    type="button"
                                                                    aria-label="הסר"
                                                                    title="הסר"
                                                                    onClick={(e) => {
                                                                      e.stopPropagation();
                                                                      if (blockSavedViewPullBubble(nm)) return;
                                                                      const norm = (s: any) =>
                                                                        String(s || "")
                                                                          .normalize("NFKC")
                                                                          .trim()
                                                                          .replace(/\s+/g, " ");
                                                                      const clickedName = norm(nm);
                                                                      const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                                      const keysToDelete: string[] = [];
                                                                      const namesToRemove = new Set<string>();
                                                                      if (clickedName) namesToRemove.add(clickedName);

                                                                      // Si on clique sur une personne qui fait partie d'une משיכה,
                                                                      // supprimer la משיכה ET les deux personnes (before+after) de la cellule.
                                                                      try {
                                                                        Object.entries(pullsByHoleKey || {}).forEach(([k, entry]) => {
                                                                          if (!String(k).startsWith(cellPrefix)) return;
                                                                          const b = norm((entry as any)?.before?.name);
                                                                          const a = norm((entry as any)?.after?.name);
                                                                          if (!b && !a) return;
                                                                          if (b === clickedName || a === clickedName) {
                                                                            keysToDelete.push(String(k));
                                                                            if (b) namesToRemove.add(b);
                                                                            if (a) namesToRemove.add(a);
                                                                          }
                                                                        });
                                                                      } catch {}

                                                                      if (keysToDelete.length > 0) {
                                                                        setPullsByHoleKey((prevPulls) => {
                                                                          const next: any = { ...(prevPulls || {}) };
                                                                          keysToDelete.forEach((k) => {
                                                                            try { delete next[k]; } catch {}
                                                                          });
                                                                          return next;
                                                                        });
                                                                      }
                                                                      setManualAssignments((prev) => {
                                                                        if (!prev) return prev;
                                                                        const base = JSON.parse(JSON.stringify(prev));
                                                                        base[d.key] = base[d.key] || {};
                                                                        base[d.key][sn] = base[d.key][sn] || [];
                                                                        const arr: string[] = Array.isArray(base[d.key]?.[sn]?.[idx]) ? (base[d.key][sn][idx] as string[]) : [];
                                                                        // Retirer par valeur (pas par index) pour éviter les décalages quand l'ordre d'affichage diffère
                                                                        // (ex: réordonnancement "before/after" pour les משיכות).
                                                                        const nextArr = (arr || []).filter((x) => !namesToRemove.has(norm(x)));
                                                                        base[d.key][sn][idx] = nextArr;

                                                                        // Si l'overlay rouge a été ajouté pour un nom retiré sur ce jour/shift
                                                                        // et que c'est la dernière occurrence (sur toutes les stations), le retirer aussi.
                                                                        try {
                                                                          const removedNorms = Array.from(namesToRemove);
                                                                          const stillThereByNorm = new Set<string>();
                                                                          (base?.[d.key]?.[sn] || []).forEach((cell: string[]) => {
                                                                            if (!Array.isArray(cell)) return;
                                                                            cell.forEach((x) => {
                                                                              const nx = norm(x);
                                                                              if (removedNorms.includes(nx)) stillThereByNorm.add(nx);
                                                                            });
                                                                          });
                                                                          const toClear = removedNorms.filter((nrm) => !stillThereByNorm.has(nrm));
                                                                          if (toClear.length > 0) {
                                                                            setAvailabilityOverlays((prevOv) => {
                                                                              const next: any = { ...prevOv };
                                                                              Object.keys(next || {}).forEach((keyName) => {
                                                                                const keyNorm = norm(keyName);
                                                                                if (!toClear.includes(keyNorm)) return;
                                                                                if (next?.[keyName]?.[d.key]) {
                                                                                  const list: string[] = Array.from(next[keyName][d.key] || []);
                                                                                  const filtered = list.filter((s) => s !== sn);
                                                                                  if (filtered.length > 0) {
                                                                                    next[keyName][d.key] = filtered;
                                                                                  } else {
                                                                                    delete next[keyName][d.key];
                                                                                    if (Object.keys(next[keyName] || {}).length === 0) delete next[keyName];
                                                                                  }
                                                                                }
                                                                              });
                                                                              return next;
                                                                            });
                                                                          }
                                                                        } catch {}
                                                                        return base;
                                                                      });
                                                                    }}
                                                                    className="hidden md:inline-flex flex-shrink-0 items-center justify-center md:relative md:z-[2] md:p-2.5 md:-m-2.5 md:hover:[&>span]:bg-white/50 md:dark:hover:[&>span]:bg-zinc-800/60"
                                                                  >
                                                                    <span
                                                                      className="flex h-5 w-5 items-center justify-center rounded-full border text-xs pointer-events-none"
                                                                    style={{ borderColor: (rc?.border || c.border), color: c.text }}
                                                                      aria-hidden
                                                                  >
                                                                    ×
                                                                    </span>
                                                                  </button>
                                                                </span>
                                                              </div>
                                                            );
                                                          }
                                                          const hint = ((manualRoleHints as any)?.[d.key]?.[sn]?.[idx]?.[slotIdx] ?? roleHintsExtended[slotIdx] ?? null) as (string | null);
                                                          if (hint) {
                                                            const rc = colorForRole(hint);
                                                            // En mode manuel, afficher clairement les slots "pullables"
                                                            // même si le mode משיכות n'est pas activé (pour aider à repérer les trous).
                                                            const canPullThisRole = pullsActiveHere && isPullable && canPullForRole(hint);
                                                            const slotHoverKey = `${d.key}|${sn}|${idx}|${slotIdx}`;
                                                            const isSlotHovered = hoverSlotKey === slotHoverKey;
                                                            return (
                                                              <div
                                                                key={"slot-hint-wrapper-" + slotIdx}
                                                                className={
                                                                  "group/slot w-full flex justify-center py-0.5 " +
                                                                  (draggingWorkerName && isSlotHovered
                                                                    ? "relative z-50 scale-[1.15] origin-center will-change-transform transition-transform duration-150 ease-out"
                                                                    : "")
                                                                }
                                                                onDragEnter={(e) => {
                                                                  e.preventDefault();
                                                                  e.stopPropagation();
                                                                  setHoverSlotKey(slotHoverKey);
                                                                }}
                                                                onDragLeave={(e) => {
                                                                  const rect = e.currentTarget.getBoundingClientRect();
                                                                  const x = e.clientX;
                                                                  const y = e.clientY;
                                                                  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
                                                                    setHoverSlotKey((k) => (k === slotHoverKey ? null : k));
                                                                  }
                                                                }}
                                                                onDragOver={(e) => {
                                                                  onSlotDragOver(e);
                                                                  if (draggingWorkerName) setHoverSlotKey(slotHoverKey);
                                                                }}
                                                                onDrop={(e) => onSlotDrop(e, d.key, sn, idx, slotIdx)}
                                                                data-slot="1"
                                                                data-dkey={d.key}
                                                                data-sname={sn}
                                                                data-stidx={idx}
                                                                data-slotidx={slotIdx}
                                                                data-rolehint={hint}
                                                              >
                                                                <span
                                                                  tabIndex={0}
                                                                  className={
                                                                    // Même gabarit que les chips "remplies" (mode téléphone inclus)
                                                                    // L'agrandissement pendant le glisser est sur le wrapper (évite overflow-hidden du span).
                                                                    "inline-flex min-h-6 md:min-h-9 w-auto md:w-full max-w-[6rem] md:max-w-[6rem] md:group-hover/slot:max-w-[18rem] md:group-focus-within/slot:max-w-[18rem] min-w-0 overflow-hidden flex-col items-center justify-center rounded-full border px-1 md:px-3 py-0.5 md:py-1 bg-white dark:bg-zinc-900 transition-[max-width,transform] duration-200 ease-out cursor-pointer focus:outline-none md:focus:z-30 " +
                                                                    (canPullThisRole ? " ring-2 ring-orange-400" : "") +
                                                                    (!draggingWorkerName && isSlotHovered ? "scale-110 ring-2 ring-[#00A8E0]" : "") +
                                                                    (draggingWorkerName && canHighlightDropTarget(draggingWorkerName, d.key, sn, idx, hint) && !isSlotHovered ? " ring-2 ring-green-500" : "") +
                                                                    (draggingWorkerName && canHighlightDropTarget(draggingWorkerName, d.key, sn, idx, hint) && isSlotHovered ? " [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22),0_0_0_2px_rgb(34_197_94)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38),0_0_0_2px_rgb(34_197_94)]" : "") +
                                                                    (draggingWorkerName && !canHighlightDropTarget(draggingWorkerName, d.key, sn, idx, hint) && isSlotHovered ? "ring-2 ring-[#00A8E0] cursor-not-allowed [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38)]" : "")
                                                                  }
                                                                  style={{ borderColor: rc.border }}
                                                                  onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    if (!canPullThisRole) return;
                                                                    if (isSavedMode && !editingSaved) return;
                                                                    // Exclure les travailleurs déjà utilisés par d'autres משיכות de cette même case
                                                                    const used = new Set(getCellNames(d.key, sn));
                                                                    const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                                    Object.entries(pullsByHoleKey || {}).forEach(([kk, ee]) => {
                                                                      if (!String(kk).startsWith(cellPrefix)) return;
                                                                      const e: any = ee;
                                                                      if (e?.before?.name) used.add(String(e.before.name).trim());
                                                                      if (e?.after?.name) used.add(String(e.after.name).trim());
                                                                    });
                                                                    const roleName = String(hint || "").trim() || null;
                                                                    const beforeOptions = (beforeCandidates2 || [])
                                                                      .filter((x) => !used.has(x))
                                                                      .filter((x) => !roleName || nameHasRole(x, roleName));
                                                                    const afterOptions = (afterCandidates2 || [])
                                                                      .filter((x) => !used.has(x))
                                                                      .filter((x) => !roleName || nameHasRole(x, roleName));
                                                                    const beforeName = String(beforeOptions[0] || "").trim();
                                                                    const afterName = String(afterOptions[0] || "").trim();
                                                                    if (!beforeName || !afterName) {
                                                                      toast.error("לא ניתן ליצור משיכות", { description: roleName ? "אין שני עובדים עם אותו תפקיד לפני/אחרי" : "אין עובדים זמינים לפני/אחרי" });
                                                                      return;
                                                                    }
                                                                    const hours = hoursFromConfig(st, sn) || hoursOf(sn);
                                                                    const parsed = parseHoursRange(hours);
                                                                    const split = parsed ? splitRangeForPulls(parsed.start, parsed.end, 4 * 60) : splitRangeForPulls("00:00", "00:00", 4 * 60);
                                                                    const shiftStart = parsed ? parsed.start : "00:00";
                                                                    const shiftEnd = parsed ? parsed.end : "23:59";
                                                                    setPullsEditor({
                                                                      key: `${d.key}|${sn}|${idx}|${slotIdx}`,
                                                                      stationIdx: idx,
                                                                      dayKey: d.key,
                                                                      shiftName: sn,
                                                                      required,
                                                                      beforeOptions,
                                                                      afterOptions,
                                                                      beforeName,
                                                                      afterName,
                                                                      beforeStart: split.before.start,
                                                                      beforeEnd: split.before.end,
                                                                      afterStart: split.after.start,
                                                                      afterEnd: split.after.end,
                                                                      shiftStart,
                                                                      shiftEnd,
                                                                      roleName,
                                                                    });
                                                                  }}
                      >
                                                                  <span className="text-[7px] md:text-[10px] font-medium" style={{ color: rc.text }}>{hint}</span>
                        <span className="text-[8px] md:text-xs leading-none text-zinc-400 dark:text-zinc-400">—</span>
                      </span>
                                                              </div>
                    );
                  }
                                                          const slotHoverKeyNeu = `${d.key}|${sn}|${idx}|${slotIdx}`;
                                                          const isSlotHoveredNeu = hoverSlotKey === slotHoverKeyNeu;
                                                          return (
                                                              <div
                                                                key={"slot-empty-wrapper-" + slotIdx}
                                                                className={
                                                                  "group/slot w-full flex justify-center py-0.5 " +
                                                                  (draggingWorkerName && isSlotHoveredNeu
                                                                    ? "relative z-50 scale-[1.15] origin-center will-change-transform transition-transform duration-150 ease-out"
                                                                    : "")
                                                                }
                                                                onDragEnter={(e) => {
                                                                  e.preventDefault();
                                                                  e.stopPropagation();
                                                                  setHoverSlotKey(slotHoverKeyNeu);
                                                                }}
                                                                onDragLeave={(e) => {
                                                                  const rect = e.currentTarget.getBoundingClientRect();
                                                                  const x = e.clientX;
                                                                  const y = e.clientY;
                                                                  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
                                                                    setHoverSlotKey((k) => (k === slotHoverKeyNeu ? null : k));
                                                                  }
                                                                }}
                                                                onDragOver={(e) => {
                                                                  onSlotDragOver(e);
                                                                  if (draggingWorkerName) setHoverSlotKey(slotHoverKeyNeu);
                                                                }}
                                                                onDrop={(e) => onSlotDrop(e, d.key, sn, idx, slotIdx)}
                                                                data-slot="1"
                                                                data-dkey={d.key}
                                                                data-sname={sn}
                                                                data-stidx={idx}
                                                                data-slotidx={slotIdx}
                                                              >
                                                      <span
                                                                  key={"slot-empty-" + slotIdx}
                                                                  tabIndex={0}
                                                                  className={
                                                                    // Même gabarit que les chips "remplies" (mode téléphone inclus)
                                                                    "inline-flex min-h-6 min-w-[2.15rem] md:min-h-9 md:min-w-0 w-auto md:w-full max-w-[6rem] md:max-w-[6rem] md:group-hover/slot:max-w-[18rem] md:group-focus-within/slot:max-w-[18rem] overflow-hidden flex-col items-center justify-center rounded-full border px-1 md:px-3 py-0.5 md:py-1 text-[8px] md:text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700 transition-[max-width,transform] duration-200 ease-out cursor-pointer focus:outline-none md:focus:z-30 " +
                                                                    (pullsActiveHere && isPullable ? " ring-2 ring-orange-400" : "") +
                                                                    (!draggingWorkerName && isSlotHoveredNeu ? "scale-110 ring-2 ring-[#00A8E0]" : "") +
                                                                    (draggingWorkerName && canHighlightDropTarget(draggingWorkerName, d.key, sn, idx, null) && !isSlotHoveredNeu ? " ring-2 ring-green-500" : "") +
                                                                    (draggingWorkerName && canHighlightDropTarget(draggingWorkerName, d.key, sn, idx, null) && isSlotHoveredNeu ? " [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22),0_0_0_2px_rgb(34_197_94)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38),0_0_0_2px_rgb(34_197_94)]" : "") +
                                                                    (draggingWorkerName && !canHighlightDropTarget(draggingWorkerName, d.key, sn, idx, null) && isSlotHoveredNeu ? "ring-2 ring-[#00A8E0] cursor-not-allowed [box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.22)] dark:[box-shadow:inset_0_0_0_9999px_rgba(0,0,0,0.38)]" : "")
                                                                  }
                                                                  onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    if (!pullsActiveHere || !isPullable) return;
                                                                    if (isSavedMode && !editingSaved) return;
                                                                    // Exclure les travailleurs déjà utilisés par d'autres משיכות de cette même case
                                                                    const used = new Set(getCellNames(d.key, sn));
                                                                    const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                                    Object.entries(pullsByHoleKey || {}).forEach(([kk, ee]) => {
                                                                      if (!String(kk).startsWith(cellPrefix)) return;
                                                                      const e: any = ee;
                                                                      if (e?.before?.name) used.add(String(e.before.name).trim());
                                                                      if (e?.after?.name) used.add(String(e.after.name).trim());
                                                                    });
                                                                    const beforeOptionsBase = (beforeCandidates2 || []).filter((x) => !used.has(x));
                                                                    const afterOptionsBase = (afterCandidates2 || []).filter((x) => !used.has(x));
                                                                    // Si des rôles sont définis pour cette garde: imposer même rôle pour les 2 travailleurs
                                                                    const reqRolesNow = roleRequirements(st, sn, d.key);
                                                                    const roleKeys = Object.keys(reqRolesNow || {});
                                                                    const roleName = roleKeys.length > 0
                                                                      ? (roleKeys.find((rName) => beforeOptionsBase.some((nm) => nameHasRole(nm, rName)) && afterOptionsBase.some((nm) => nameHasRole(nm, rName))) || null)
                                                                      : null;
                                                                    const beforeOptions = roleName ? beforeOptionsBase.filter((nm) => nameHasRole(nm, roleName)) : beforeOptionsBase;
                                                                    const afterOptions = roleName ? afterOptionsBase.filter((nm) => nameHasRole(nm, roleName)) : afterOptionsBase;
                                                                    const beforeName = String(beforeOptions[0] || "").trim();
                                                                    const afterName = String(afterOptions[0] || "").trim();
                                                                    if (!beforeName || !afterName) {
                                                                      toast.error("לא ניתן ליצור משיכות", { description: roleKeys.length > 0 ? "אין שני עובדים עם אותו תפקיד לפני/אחרי" : "אין עובדים זמינים לפני/אחרי" });
                                                                      return;
                                                                    }
                                                                    const hours = hoursFromConfig(st, sn) || hoursOf(sn);
                                                                    const parsed = parseHoursRange(hours);
                                                                    const split = parsed ? splitRangeForPulls(parsed.start, parsed.end, 4 * 60) : splitRangeForPulls("00:00", "00:00", 4 * 60);
                                                                    const shiftStart = parsed ? parsed.start : "00:00";
                                                                    const shiftEnd = parsed ? parsed.end : "23:59";
                                                                    setPullsEditor({
                                                                      key: `${d.key}|${sn}|${idx}|${slotIdx}`,
                                                                      stationIdx: idx,
                                                                      dayKey: d.key,
                                                                      shiftName: sn,
                                                                      required,
                                                                      beforeOptions,
                                                                      afterOptions,
                                                                      beforeName,
                                                                      afterName,
                                                                      beforeStart: split.before.start,
                                                                      beforeEnd: split.before.end,
                                                                      afterStart: split.after.start,
                                                                      afterEnd: split.after.end,
                                                                      shiftStart,
                                                                      shiftEnd,
                                                                      roleName,
                                                                    });
                                                                  }}
                                                                  style={undefined}
                                                      >
                                                                {/* Garder la même hauteur qu'une chip remplie (2 lignes) */}
                                                                <span className="text-[7px] md:text-[10px] font-medium opacity-0">—</span>
                                                                <span className="text-[8px] md:text-xs leading-none text-zinc-400 dark:text-zinc-400">—</span>
                                                      </span>
                                                              </div>
                                                          );
                                                        });
                                                      })()}
                                                    </div>
                                                  ) : (
                                                    (() => {
                                                      const reqRoles = roleRequirements(st, sn, d.key);
                                                      // Créer un plan de slots avec positions fixes pour les rôles
                                                      // Chaque rôle requis a un slot fixe, même s'il est vide
                                                      type SlotType = { type: 'assigned' | 'role-empty' | 'neutral-empty', name?: string, role?: string | null, roleHint?: string };
                                                      const slots: SlotType[] = [];
                                                      // Si une משיכה existe avec un roleName, on ajoute 1 slot supplémentaire dans CE rôle
                                                      // (pour que before/after soient collés, sans être séparés par d'autres rôles).
                                                      const pullsExtraByRole: Record<string, number> = {};
                                                      (pullEntriesHere || []).forEach((e: any) => {
                                                        const rn = String(e?.roleName || "").trim();
                                                        if (!rn) return;
                                                        pullsExtraByRole[rn] = (pullsExtraByRole[rn] || 0) + 1;
                                                      });
                                                      
                                                      // Créer un slot pour chaque rôle requis (dans l'ordre des rôles)
                                                      Object.entries(reqRoles).forEach(([rName, rCount]) => {
                                                        const extra = pullsExtraByRole[String(rName || "").trim()] || 0;
                                                        for (let i = 0; i < ((rCount || 0) + extra); i++) {
                                                          slots.push({ type: 'role-empty', roleHint: rName });
                                                        }
                                                      });
                                                      
                                                      // Compter les assignations par rôle
                                                      const assignedPerRole = new Map<string, number>();
                                                      roleMap.forEach((rName) => {
                                                        if (!rName) return;
                                                        assignedPerRole.set(rName, (assignedPerRole.get(rName) || 0) + 1);
                                                      });
                                                      
                                                      // Remplir les slots de rôle avec les assignations correspondantes
                                                      const usedSlots = new Set<number>();
                                                      const assignedWithoutRole: Array<{ name: string, index: number }> = [];
                                                      
                                                      // D'abord remplir les slots de rôle avec les assignations qui ont ce rôle
                                                      assignedNames.forEach((nm, i) => {
                                                        if (!nm) return;
                                                        const assignedRole = roleMap.get(nm) || null;
                                                        if (assignedRole) {
                                                          // Trouver le premier slot vide pour ce rôle
                                                          for (let j = 0; j < slots.length; j++) {
                                                            if (usedSlots.has(j)) continue;
                                                            if (slots[j].roleHint === assignedRole) {
                                                              slots[j] = { type: 'assigned', name: nm, role: assignedRole };
                                                              usedSlots.add(j);
                                                              assignedPerRole.set(assignedRole, (assignedPerRole.get(assignedRole) || 0) - 1);
                                                              break;
                                                            }
                                                          }
                                                        } else {
                                                          assignedWithoutRole.push({ name: nm, index: i });
                                                        }
                                                      });
                                                      
                                                      // Ajouter les slots sans rôle.
                                                      // IMPORTANT: si on a plus d'assignés que "required" (ex: משיכות => 2 personnes sur une garde),
                                                      // il faut afficher 2 bulles (et pas couper à required).
                                                      const totalRoleSlots = slots.length;
                                                      // +pullsInCell: pour afficher 2 bulles pour une seule place (משיכה)
                                                      const targetSlots = Math.max(required + pullsInCell, assignedNames.filter(Boolean).length);
                                                      const remainingRequired = Math.max(0, targetSlots - totalRoleSlots);
                                                      for (let i = 0; i < remainingRequired; i++) {
                                                        slots.push({ type: 'neutral-empty' });
                                                      }
                                                      
                                                      // Remplir les slots sans rôle avec les assignations restantes
                                                      let neutralSlotIdx = totalRoleSlots;
                                                      assignedWithoutRole.forEach(({ name }) => {
                                                        if (neutralSlotIdx < slots.length) {
                                                          slots[neutralSlotIdx] = { type: 'assigned', name: name, role: null };
                                                          neutralSlotIdx++;
                                                        }
                                                      });
                                                      
                                                      const renderChip = (nm: string, i: number, rn: string | null) => {
                                                          const c = colorForName(nm);
                                                          const nmKey = String(nm || "")
                                                            .normalize("NFKC")
                                                            .trim()
                                                            .replace(/\s+/g, " ");
                                                          const expKey = expandedKeyFor(d.key, sn, idx, i, nmKey);
                                                          // Si ce nom fait partie d'une משיכה avec roleName, afficher aussi le rôle sur la bulle "ajoutée"
                                                          const pullRoleName = (() => {
                                                            const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                            const match = Object.entries(pullsByHoleKey || {}).find(([k, entry]) => {
                                                              if (!String(k).startsWith(cellPrefix)) return false;
                                                              const e: any = entry;
                                                              return e?.before?.name === nm || e?.after?.name === nm;
                                                            });
                                                            if (!match) return null;
                                                            const [, entryAny] = match as any;
                                                            const e: any = entryAny;
                                                            return String(e?.roleName || "").trim() || null;
                                                          })();
                                                          const roleToShow = rn || pullRoleName || null;
                                                          const rc = roleToShow ? colorForRole(roleToShow) : null;
                                                          const chipClass =
                                                            // Auto: aligner l'expansion desktop sur le mode manuel (la chip s'étire au hover/focus).
                                                            // Icône שיבוץ קבוע : cadenas noir inline à côté du nom (items-center évite l’effet « coin »).
                                                            "inline-flex min-h-6 md:min-h-9 w-auto md:w-full max-w-[6rem] md:max-w-[6rem] md:group-hover/slot:max-w-[18rem] md:focus:max-w-[18rem] min-w-0 overflow-hidden items-center rounded-full border px-1 md:px-3 py-0.5 md:py-1 shadow-sm gap-1 md:gap-2 select-none md:group-hover/slot:z-30 md:focus:z-30 focus:outline-none transition-[max-width,transform] duration-200 ease-out " +
                                                            pullHighlightClassForName(nm);
                                                          const showDraftFixedPin = shouldShowDraftFixedPinForWorker(
                                                            draftFixedAssignmentsSnapshot,
                                                            isSavedMode,
                                                            editingSaved,
                                                            d.key,
                                                            sn,
                                                            idx,
                                                            nm,
                                                            assignedNames,
                                                          );
                                                          return (
                                                            <div
                                                              key={"chip-wrapper-" + i}
                                                              className="group/slot relative w-full flex justify-center py-0.5"
                                                            >
                                                            <div
                                                              className={
                                                                "relative inline-block w-auto min-w-0 max-w-[6rem] md:max-w-[6rem] md:w-full md:group-hover/slot:max-w-[18rem] md:group-focus-within/slot:max-w-[18rem] " +
                                                                (expandedSlotKey === expKey ? "w-[18rem] max-w-[18rem] " : "")
                                                              }
                                                            >
                                                            <span
                                                              key={"nm-" + i}
                                                              className={chipClass + (expandedSlotKey === expKey ? " w-[18rem] max-w-[18rem] z-30" : "")}
                                                              style={{ backgroundColor: c.bg, borderColor: (rc?.border || c.border), color: c.text }}
                                                              tabIndex={blockSavedViewPullBubble(nm) ? -1 : 0}
                                                              onPointerDown={(e) => {
                                                                if (blockSavedViewPullBubble(nm)) {
                                                                  e.preventDefault();
                                                                  e.stopPropagation();
                                                                  return;
                                                                }
                                                                setExpandedSlotKey(expKey);
                                                              }}
                                                              onPointerEnter={(e) => {
                                                                if (blockSavedViewPullBubble(nm)) return;
                                                                if ((e as any)?.pointerType === "mouse") {
                                                                  setExpandedSlotKey(expKey);
                                                                }
                                                              }}
                                                              onPointerLeave={(e) => {
                                                                if ((e as any)?.pointerType === "mouse") {
                                                                  setExpandedSlotKey((k) => (k === expKey ? null : k));
                                                                }
                                                              }}
                                                              onFocus={(ev) => {
                                                                if (blockSavedViewPullBubble(nm)) {
                                                                  ev.preventDefault();
                                                                  return;
                                                                }
                                                                setExpandedSlotKey(expKey);
                                                              }}
                                                              onBlur={() => setExpandedSlotKey((k) => (k === expKey ? null : k))}
                                                              onClick={(e) => {
                                                                if (pullsModeStationIdx !== idx) return;
                                                                if (isSavedMode && !editingSaved) return;
                                                                const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                                const match = Object.entries(pullsByHoleKey || {}).find(([k, entry]) => {
                                                                  if (!String(k).startsWith(cellPrefix)) return false;
                                                                  const pe: any = entry;
                                                                  return pe?.before?.name === nm || pe?.after?.name === nm;
                                                                });
                                                                if (!match) return;
                                                                e.stopPropagation();
                                                                const [k, entryAny] = match as any;
                                                                const entry = entryAny as any;
                                                                const hours = hoursFromConfig(st, sn) || hoursOf(sn);
                                                                const parsed = parseHoursRange(hours);
                                                                const shiftStart = parsed ? parsed.start : "00:00";
                                                                const shiftEnd = parsed ? parsed.end : "23:59";
                                                                const used = new Set(getCellNames(d.key, sn));
                                                                const prevDayKey = prevCoord ? dayCols[prevCoord.dayIdx]?.key : null;
                                                                const prevShiftName = prevCoord ? shiftNamesAll[prevCoord.shiftIdx] : null;
                                                                const nextDayKey = nextCoord ? dayCols[nextCoord.dayIdx]?.key : null;
                                                                const nextShiftName = nextCoord ? shiftNamesAll[nextCoord.shiftIdx] : null;
                                                                const prevOptsRaw = (prevDayKey && prevShiftName) ? neighborNames(prevDayKey, prevShiftName) : [];
                                                                const nextOptsRaw = (nextDayKey && nextShiftName) ? neighborNames(nextDayKey, nextShiftName) : [];
                                                                const beforeOptions = Array.from(
                                                                  new Set<string>([...prevOptsRaw, String(entry?.before?.name || "").trim()].filter(Boolean)),
                                                                ).filter((x) => !used.has(x) || x === entry?.before?.name || x === entry?.after?.name);
                                                                const afterOptions = Array.from(
                                                                  new Set<string>([...nextOptsRaw, String(entry?.after?.name || "").trim()].filter(Boolean)),
                                                                ).filter((x) => !used.has(x) || x === entry?.before?.name || x === entry?.after?.name);
                                                                const roleName = String(entry?.roleName || "").trim() || null;
                                                                const beforeOptionsRole = roleName
                                                                  ? Array.from(new Set<string>([...beforeOptions.filter((x) => nameHasRole(x, roleName)), String(entry?.before?.name || "").trim()].filter(Boolean)))
                                                                  : beforeOptions;
                                                                const afterOptionsRole = roleName
                                                                  ? Array.from(new Set<string>([...afterOptions.filter((x) => nameHasRole(x, roleName)), String(entry?.after?.name || "").trim()].filter(Boolean)))
                                                                  : afterOptions;
                                                                setPullsEditor({
                                                                  key: String(k),
                                                                  stationIdx: idx,
                                                                  dayKey: d.key,
                                                                  shiftName: sn,
                                                                  required,
                                                                  beforeOptions: beforeOptionsRole,
                                                                  afterOptions: afterOptionsRole,
                                                                  beforeName: entry.before.name,
                                                                  afterName: entry.after.name,
                                                                  beforeStart: entry.before.start,
                                                                  beforeEnd: entry.before.end,
                                                                  afterStart: entry.after.start,
                                                                  afterEnd: entry.after.end,
                                                                  shiftStart,
                                                                  shiftEnd,
                                                                  roleName,
                                                                });
                                                              }}
                                                            >
                                                              <span className="flex flex-col items-center text-center leading-tight flex-1 min-w-0 w-full overflow-hidden">
                                                                {roleToShow ? (
                                                                  <span className="block w-full min-w-0 text-[7px] md:text-[10px] font-medium text-zinc-700 dark:text-zinc-300 truncate mb-0.5">{roleToShow}</span>
                                                                ) : null}
                                                                <span
                                                                  className="flex w-full min-w-0 max-w-full items-center justify-center gap-0.5 leading-tight"
                                                                  dir={isRtlName(nm) ? "rtl" : "ltr"}
                                                                >
                                                                  {showDraftFixedPin ? (
                                                                    <svg
                                                                      viewBox="0 0 24 24"
                                                                      className="pointer-events-none h-2.5 w-2.5 shrink-0 text-black md:h-3 md:w-3"
                                                                      fill="currentColor"
                                                                      aria-hidden
                                                                    >
                                                                      <title>שיבוץ קבוע</title>
                                                                      <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
                                                                    </svg>
                                                                  ) : null}
                                                                  <span
                                                                    className={"block min-w-0 flex-1 max-w-full leading-tight md:text-center " + (isRtlName(nm) ? "text-right" : "text-left")}
                                                                    dir={isRtlName(nm) ? "rtl" : "ltr"}
                                                                  >
                                                                    {/* Mobile: tronqué par défaut, complet uniquement sur le slot ciblé */}
                                                                    <span className="md:hidden">
                                                                      {expandedSlotKey === expKey ? (
                                                                        <span className="whitespace-nowrap">{nm}</span>
                                                                      ) : (
                                                                        <span>{truncateMobile6(nm)}</span>
                                                                      )}
                                                                    </span>
                                                                    {/* Desktop: ellipsis classique */}
                                                                    <span className="hidden md:block w-full truncate text-[8px] md:text-sm">{nm}</span>
                                                                  </span>
                                                                </span>
                                                                {(() => {
                                                                  const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                                  const match = Object.entries(pullsByHoleKey || {}).find(([k, entry]) => {
                                                                    if (!k.startsWith(cellPrefix)) return false;
                                                                    const e: any = entry;
                                                                    return e?.before?.name === nm || e?.after?.name === nm;
                                                                  });
                                                                  if (!match) return null;
                                                                  const [k, entryAny] = match as any;
                                                                  const entry = entryAny as any;
                                                                  const txt =
                                                                    entry?.before?.name === nm
                                                                      ? `${entry.before.start}-${entry.before.end}`
                                                                      : `${entry.after.start}-${entry.after.end}`;
                                                                  return (
                                                                    <button
                                                                      type="button"
                                                                      dir="ltr"
                                                                      className="text-[7px] md:text-[10px] leading-tight text-zinc-700/80 dark:text-zinc-300/80 underline decoration-dotted"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        if (isSavedMode && !editingSaved) return;
                                                                        const hours = hoursFromConfig(st, sn) || hoursOf(sn);
                                                                        const parsed = parseHoursRange(hours);
                                                                        const shiftStart = parsed ? parsed.start : "00:00";
                                                                        const shiftEnd = parsed ? parsed.end : "23:59";
                                                                        // Exclure les travailleurs déjà utilisés par d'autres משיכות de cette même case
                                                                        const used = new Set(getCellNames(d.key, sn));
                                                                        const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                                        Object.entries(pullsByHoleKey || {}).forEach(([kk, ee]) => {
                                                                          if (!String(kk).startsWith(cellPrefix)) return;
                                                                          const e: any = ee;
                                                                          if (e?.before?.name) used.add(String(e.before.name).trim());
                                                                          if (e?.after?.name) used.add(String(e.after.name).trim());
                                                                        });
                                                                        const prevDayKey = prevCoord ? dayCols[prevCoord.dayIdx]?.key : null;
                                                                        const prevShiftName = prevCoord ? shiftNamesAll[prevCoord.shiftIdx] : null;
                                                                        const nextDayKey = nextCoord ? dayCols[nextCoord.dayIdx]?.key : null;
                                                                        const nextShiftName = nextCoord ? shiftNamesAll[nextCoord.shiftIdx] : null;
                                                                        const prevOptsRaw = (prevDayKey && prevShiftName) ? neighborNames(prevDayKey, prevShiftName) : [];
                                                                        const nextOptsRaw = (nextDayKey && nextShiftName) ? neighborNames(nextDayKey, nextShiftName) : [];
                                                                        const beforeOptions = Array.from(
                                                                          new Set<string>([...prevOptsRaw, String(entry?.before?.name || "").trim()].filter(Boolean)),
                                                                        ).filter((x) => !used.has(x) || x === entry?.before?.name || x === entry?.after?.name);
                                                                        const afterOptions = Array.from(
                                                                          new Set<string>([...nextOptsRaw, String(entry?.after?.name || "").trim()].filter(Boolean)),
                                                                        ).filter((x) => !used.has(x) || x === entry?.before?.name || x === entry?.after?.name);
                                                                        const roleName = String(entry?.roleName || "").trim() || null;
                                                                        const beforeOptionsRole = roleName
                                                                          ? Array.from(new Set<string>([...beforeOptions.filter((x) => nameHasRole(x, roleName)), String(entry?.before?.name || "").trim()].filter(Boolean)))
                                                                          : beforeOptions;
                                                                        const afterOptionsRole = roleName
                                                                          ? Array.from(new Set<string>([...afterOptions.filter((x) => nameHasRole(x, roleName)), String(entry?.after?.name || "").trim()].filter(Boolean)))
                                                                          : afterOptions;
                                                                        setPullsEditor({
                                                                          key: k,
                                                                          stationIdx: idx,
                                                                          dayKey: d.key,
                                                                          shiftName: sn,
                                                                          required,
                                                                          beforeOptions: beforeOptionsRole,
                                                                          afterOptions: afterOptionsRole,
                                                                          beforeName: entry.before.name,
                                                                          afterName: entry.after.name,
                                                                          beforeStart: entry.before.start,
                                                                          beforeEnd: entry.before.end,
                                                                          afterStart: entry.after.start,
                                                                          afterEnd: entry.after.end,
                                                                          shiftStart,
                                                                          shiftEnd,
                                                                          roleName,
                                                                        });
                                                                      }}
                                                                    >
                                                                      {txt}
                                                                    </button>
                                                                  );
                                                                })()}
                                                              </span>
                                                            </span>
                                                            </div>
                                                            </div>
                                                          );
                                                      };
                                                      
                                                      return (
                                                        <div className="flex flex-col items-center gap-0.5 md:gap-1 w-full px-1 md:px-2 py-0.5 md:py-1">
                                                          {slots.map((slot, slotIdx) => {
                                                            if (slot.type === 'assigned' && slot.name) {
                                                              return renderChip(slot.name, slotIdx, slot.role ?? null);
                                                            } else if (slot.type === 'role-empty' && slot.roleHint) {
                                                              const c = colorForRole(slot.roleHint);
                                                              const canPullThisRole = pullsActiveHere && isPullable && canPullForRole(slot.roleHint);
                                                              return (
                                                                <div
                                                                  key={`roleph-wrapper-${slot.roleHint}-${slotIdx}`}
                                                                  className="group/slot w-full flex justify-center py-0.5"
                                                                >
                                                                  <span
                                                                    key={`roleph-${slot.roleHint}-${slotIdx}`}
                                                                    className={
                                                                      // Même gabarit que les chips "remplies" (mode téléphone inclus)
                                                                      "inline-flex min-h-6 md:min-h-9 w-auto md:w-full max-w-[6rem] md:max-w-[6rem] md:group-hover/slot:max-w-[18rem] md:group-focus-within/slot:max-w-[18rem] min-w-0 overflow-hidden flex-col items-center justify-center rounded-full border px-1 md:px-3 py-0.5 md:py-1 bg-white dark:bg-zinc-900 transition-[max-width,transform] duration-200 ease-out cursor-pointer focus:outline-none md:focus:z-30 " +
                                                                      (expandedSlotKey === `${d.key}|${sn}|${idx}|${slotIdx}` ? " w-[18rem] max-w-[18rem] z-30" : "") +
                                                                      (canPullThisRole ? "ring-2 ring-orange-400" : "")
                                                                    }
                                                                    style={{ borderColor: c.border }}
                                                                    tabIndex={0}
                                                                    onPointerDown={(e) => {
                                                                      if ((e as any)?.pointerType !== "mouse") setExpandedSlotKey(`${d.key}|${sn}|${idx}|${slotIdx}`);
                                                                    }}
                                                                    onFocus={() => setExpandedSlotKey(`${d.key}|${sn}|${idx}|${slotIdx}`)}
                                                                    onBlur={() => setExpandedSlotKey((k) => (k === `${d.key}|${sn}|${idx}|${slotIdx}` ? null : k))}
                                                                    onClick={(e) => {
                                                                      e.stopPropagation();
                                                                      if (!canPullThisRole) return;
                                                                      if (isSavedMode && !editingSaved) return;
                                                                      // Exclure les travailleurs déjà utilisés par d'autres משיכות de cette même case
                                                                      const used = new Set(getCellNames(d.key, sn));
                                                                      const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                                      Object.entries(pullsByHoleKey || {}).forEach(([kk, ee]) => {
                                                                        if (!String(kk).startsWith(cellPrefix)) return;
                                                                        const e: any = ee;
                                                                        if (e?.before?.name) used.add(String(e.before.name).trim());
                                                                        if (e?.after?.name) used.add(String(e.after.name).trim());
                                                                      });
                                                                      const roleName = String(slot.roleHint || "").trim() || null;
                                                                      const beforeOptions = (beforeCandidates2 || [])
                                                                        .filter((x) => !used.has(x))
                                                                        .filter((x) => !roleName || nameHasRole(x, roleName));
                                                                      const afterOptions = (afterCandidates2 || [])
                                                                        .filter((x) => !used.has(x))
                                                                        .filter((x) => !roleName || nameHasRole(x, roleName));
                                                                      const beforeName = String(beforeOptions[0] || "").trim();
                                                                      const afterName = String(afterOptions[0] || "").trim();
                                                                      if (!beforeName || !afterName) {
                                                                        toast.error("לא ניתן ליצור משיכות", { description: roleName ? "אין שני עובדים עם אותו תפקיד לפני/אחרי" : "אין עובדים זמינים לפני/אחרי" });
                                                                        return;
                                                                      }
                                                                      const hours = hoursFromConfig(st, sn) || hoursOf(sn);
                                                                      const parsed = parseHoursRange(hours);
                                                                      const split = parsed ? splitRangeForPulls(parsed.start, parsed.end, 4 * 60) : splitRangeForPulls("00:00", "00:00", 4 * 60);
                                                                      const shiftStart = parsed ? parsed.start : "00:00";
                                                                      const shiftEnd = parsed ? parsed.end : "23:59";
                                                                      setPullsEditor({
                                                                        key: `${d.key}|${sn}|${idx}|${slotIdx}`,
                                                                        stationIdx: idx,
                                                                        dayKey: d.key,
                                                                        shiftName: sn,
                                                                        required,
                                                                        beforeOptions,
                                                                        afterOptions,
                                                                        beforeName,
                                                                        afterName,
                                                                        beforeStart: split.before.start,
                                                                        beforeEnd: split.before.end,
                                                                        afterStart: split.after.start,
                                                                        afterEnd: split.after.end,
                                                                        shiftStart,
                                                                        shiftEnd,
                                                                        roleName,
                                                                      });
                                                                    }}
                                                                  >
                                                                    <span className="text-[7px] md:text-[10px] font-medium" style={{ color: c.text }}>{slot.roleHint}</span>
                                                                    <span className="text-[8px] md:text-xs leading-none text-zinc-400 dark:text-zinc-400">—</span>
                                                                  </span>
                                                                </div>
                                                              );
                                                            } else {
                                                              const neutralIsPullable = pullsActiveHere && isPullable;
                                                              return (
                                                                <div
                                                                  key={"empty-wrapper-" + slotIdx}
                                                                  className="group/slot w-full flex justify-center py-0.5"
                                                                >
                                                                  <span
                                                                    key={"empty-" + slotIdx}
                                                                    className={
                                                                      // Même gabarit que les chips "remplies" (mode téléphone inclus)
                                                                      "inline-flex min-h-6 min-w-[2.15rem] md:min-h-9 md:min-w-0 w-auto md:w-full max-w-[6rem] md:max-w-[6rem] md:group-hover/slot:max-w-[18rem] md:group-focus-within/slot:max-w-[18rem] overflow-hidden flex-col items-center justify-center rounded-full border px-1 md:px-3 py-0.5 md:py-1 text-[8px] md:text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700 transition-[max-width,transform] duration-200 ease-out cursor-pointer focus:outline-none md:focus:z-30 " +
                                                                      (expandedSlotKey === `${d.key}|${sn}|${idx}|${slotIdx}` ? " w-[18rem] max-w-[18rem] z-30" : "") +
                                                                      (neutralIsPullable ? "ring-2 ring-orange-400" : "")
                                                                    }
                                                                    tabIndex={0}
                                                                    onPointerDown={(e) => {
                                                                      if ((e as any)?.pointerType !== "mouse") setExpandedSlotKey(`${d.key}|${sn}|${idx}|${slotIdx}`);
                                                                    }}
                                                                    onFocus={() => setExpandedSlotKey(`${d.key}|${sn}|${idx}|${slotIdx}`)}
                                                                    onBlur={() => setExpandedSlotKey((k) => (k === `${d.key}|${sn}|${idx}|${slotIdx}` ? null : k))}
                                                                    onClick={(e) => {
                                                                      e.stopPropagation();
                                                                      if (!neutralIsPullable) return;
                                                                      if (isSavedMode && !editingSaved) return;
                                                                      // Exclure les travailleurs déjà utilisés par d'autres משיכות de cette même case
                                                                      const used = new Set(getCellNames(d.key, sn));
                                                                      const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                                      Object.entries(pullsByHoleKey || {}).forEach(([kk, ee]) => {
                                                                        if (!String(kk).startsWith(cellPrefix)) return;
                                                                        const e: any = ee;
                                                                        if (e?.before?.name) used.add(String(e.before.name).trim());
                                                                        if (e?.after?.name) used.add(String(e.after.name).trim());
                                                                      });
                                                                      const beforeOptionsBase = (beforeCandidates2 || []).filter((x) => !used.has(x));
                                                                      const afterOptionsBase = (afterCandidates2 || []).filter((x) => !used.has(x));
                                                                      const reqRolesNow = roleRequirements(st, sn, d.key);
                                                                      const roleKeys = Object.keys(reqRolesNow || {});
                                                                      const roleName = roleKeys.length > 0
                                                                        ? (roleKeys.find((rName) => beforeOptionsBase.some((nm) => nameHasRole(nm, rName)) && afterOptionsBase.some((nm) => nameHasRole(nm, rName))) || null)
                                                                        : null;
                                                                      const beforeOptions = roleName ? beforeOptionsBase.filter((nm) => nameHasRole(nm, roleName)) : beforeOptionsBase;
                                                                      const afterOptions = roleName ? afterOptionsBase.filter((nm) => nameHasRole(nm, roleName)) : afterOptionsBase;
                                                                      const beforeName = String(beforeOptions[0] || "").trim();
                                                                      const afterName = String(afterOptions[0] || "").trim();
                                                                      if (!beforeName || !afterName) {
                                                                        toast.error("לא ניתן ליצור משיכות", { description: roleKeys.length > 0 ? "אין שני עובדים עם אותו תפקיד לפני/אחרי" : "אין עובדים זמינים לפני/אחרי" });
                                                                        return;
                                                                      }
                                                                      const hours = hoursFromConfig(st, sn) || hoursOf(sn);
                                                                      const parsed = parseHoursRange(hours);
                                                                      const split = parsed ? splitRangeForPulls(parsed.start, parsed.end, 4 * 60) : splitRangeForPulls("00:00", "00:00", 4 * 60);
                                                                      const shiftStart = parsed ? parsed.start : "00:00";
                                                                      const shiftEnd = parsed ? parsed.end : "23:59";
                                                                      setPullsEditor({
                                                                        key: `${d.key}|${sn}|${idx}|${slotIdx}`,
                                                                        stationIdx: idx,
                                                                        dayKey: d.key,
                                                                        shiftName: sn,
                                                                        required,
                                                                        beforeOptions,
                                                                        afterOptions,
                                                                        beforeName,
                                                                        afterName,
                                                                        beforeStart: split.before.start,
                                                                        beforeEnd: split.before.end,
                                                                        afterStart: split.after.start,
                                                                        afterEnd: split.after.end,
                                                                        shiftStart,
                                                                        shiftEnd,
                                                                        roleName,
                                                                      });
                                                                    }}
                                                                  >
                                                                    {/* Garder la même hauteur qu'une chip remplie (2 lignes) */}
                                                                    <span className="text-[7px] md:text-[10px] font-medium opacity-0">—</span>
                                                                    <span className="text-[8px] md:text-xs leading-none text-zinc-400 dark:text-zinc-400">—</span>
                                                                  </span>
                                                                </div>
                                                              );
                                                            }
                                                          })}
                                                        </div>
                                                    );
                                                    })()
                                                  )}
                                                </div>
                                              ) : null}
                                              <div className="mt-0.5 flex w-full min-w-0 flex-col items-center gap-0.5 leading-tight max-md:max-w-[5.5rem] md:max-w-none md:mt-1 md:gap-1">
                                                <span
                                                  className={
                                                    "flex w-full items-center justify-center gap-0.5 whitespace-nowrap text-[7px] md:text-[10px] " +
                                                    (assignedCount < required
                                                      ? "text-red-600 dark:text-red-400"
                                                      : required > 0 && assignedCount >= required
                                                        ? "text-green-600 dark:text-green-400"
                                                        : "")
                                                  }
                                                >
                                                  <span>שיבוצים:</span>
                                                  <span className="font-medium tabular-nums">{assignedCount}</span>
                                                </span>
                                                <span className="flex w-full items-center justify-center gap-0.5 whitespace-nowrap text-[7px] text-zinc-500 md:text-[10px]">
                                                  <span>נדרש:</span>
                                                  <span className="font-medium tabular-nums text-zinc-600 dark:text-zinc-400">{required}</span>
                                                </span>
                                              </div>
                                          </div>
                                        ) : (
                                          <span className="text-[9px] md:text-xs">לא פעיל</span>
                                        )}
                                      </td>
                                      );
                                    })}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {isManual && !(isSavedMode && !editingSaved) && (
                          <div className="mt-3">
                            <div className="mb-1 text-xs text-zinc-600 dark:text-zinc-300 text-center">גרור/י עובד אל תא השיבוץ</div>
                            <div className="flex flex-wrap items-center justify-center gap-2">
                              {workers
                                .filter((w) => !hiddenWorkerIds.includes(w.id) && !w.pendingApproval)
                                .map((w) => {
                                const c = colorForName(w.name);
                                return (
                                  <span
                                    key={w.id}
                                    draggable
                                    onDragStart={(e) => onWorkerDragStart(e, w.name)}
                                    onDragEnd={onWorkerDragEnd}
                                    className="inline-flex items-center rounded-full border px-3 py-1 text-sm shadow-sm select-none cursor-grab active:cursor-grabbing"
                                    style={{ backgroundColor: c.bg, borderColor: c.border, color: c.text }}
                                  >
                                    {w.name}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        )}
                    {/* per-station summary removed; replaced by global summary below */}
                      </div>
                    ))}
                  </div>
                );
              })()}
              {aiPlan && !isManual && (!savedWeekPlan?.assignments || editingSaved) && (
                <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
                  {(() => {
                    const counts = new Map<string, number>();
                    const days = Object.keys(aiPlan.assignments || {});
                    for (const dKey of days) {
                      const shiftsMap = (aiPlan.assignments as any)[dKey] || {};
                      for (const sn of Object.keys(shiftsMap)) {
                        const perStation: string[][] = shiftsMap[sn] || [];
                        for (const namesHere of perStation) {
                          for (const nm of (namesHere || [])) {
                            if (!nm) continue; // Ignorer les cellules vides
                            counts.set(nm, (counts.get(nm) || 0) + 1);
                          }
                        }
                      }
                    }
                  // Totaux globaux: נדרש (required) et שיבוצים (assignés)
                  const stationsCfgAll: any[] = (site?.config?.stations || []) as any[];
                  function requiredForSummary(st: any, shiftName: string, dayKey: string): number {
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
                  let totalRequired = 0;
                  for (const dKey of days) {
                    const shiftsMap = (aiPlan.assignments as any)[dKey] || {};
                    for (const sn of Object.keys(shiftsMap)) {
                      for (let tIdx = 0; tIdx < stationsCfgAll.length; tIdx++) {
                        totalRequired += requiredForSummary(stationsCfgAll[tIdx], sn, dKey);
                      }
                    }
                  }
                  const totalAssigned = Array.from(counts.values()).reduce((a, b) => a + b, 0);
                    // Compléter avec tous les travailleurs (compte 0 si non assigné)
                    workers.forEach((w) => {
                      if (!counts.has(w.name)) counts.set(w.name, 0);
                    });
                    // Ordre stable: suivre l'ordre d'apparition dans la liste 'workers'
                    const order = new Map<string, number>();
                    workers.forEach((w, i) => order.set(w.name, i));
                    const items = Array.from(counts.entries())
                      .sort((a, b) => {
                        const ia = order.has(a[0]) ? (order.get(a[0]) as number) : Number.MAX_SAFE_INTEGER;
                        const ib = order.has(b[0]) ? (order.get(b[0]) as number) : Number.MAX_SAFE_INTEGER;
                        if (ia !== ib) return ia - ib;
                        return a[0].localeCompare(b[0]);
                      });
                    if (workers.length === 0) {
                      return <div className="text-sm text-zinc-500">אין שיבוצים</div>;
                    }
                    const generatedPlansTotal = aiAssignmentsVariants.length;
                    const matchingPlansTotal = filteredAiPlanIndices.length;
                    const allowCountFiltering = generatedPlansTotal > 1;
                    return (
                      <>
                        <div className="mb-2 flex items-center justify-between gap-3 text-sm text-zinc-600 dark:text-zinc-300 flex-wrap">
                          <div>סיכום שיבוצים לעמדה (כל העמדות)</div>
                          {allowCountFiltering && hasActiveAssignmentCountFilters && (
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                                {matchingPlansTotal}/{generatedPlansTotal}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setPreserveLinkedAltSelection(false);
                                  setSharedAssignmentCountFilters({});
                                  saveSharedAssignmentCountFilters(weekStart, {});
                                }}
                                className="inline-flex items-center rounded-md border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
                              >
                                איפוס סינון
                              </button>
                            </div>
                          )}
                        </div>
                        <div className="mb-2 flex items-center justify-end gap-3 text-xs md:text-sm flex-wrap">
                          <div>סה"כ נדרש: <span className="font-medium">{totalRequired}</span></div>
                          <div>סה"כ שיבוצים: <span className="font-medium">{totalAssigned}</span></div>
                        </div>
                        {allowCountFiltering && matchingPlansTotal === 0 && (
                          <div className="mb-2 text-sm text-amber-600 dark:text-amber-400">
                            אין חלופות שתואמות את מספרי המשמרות שנבחרו.
                          </div>
                        )}
                        <div className="max-h-[24rem] overflow-y-auto overflow-x-hidden md:overflow-x-auto">
                        <table className="w-full border-collapse table-fixed text-[10px] md:text-sm">
                          <thead>
                            <tr className="border-b dark:border-zinc-800">
                              <th className="px-1 md:px-2 py-1 md:py-2 text-center w-32 md:w-64">עובד</th>
                              <th className="px-1 md:px-2 py-1 md:py-2 text-right w-16 md:w-28 whitespace-nowrap">מס' משמרות</th>
                              {showMultiSiteTotalColumn && (
                                <th className="px-1 md:px-2 py-1 md:py-2 text-right w-16 md:w-28 whitespace-nowrap">סה״כ שיבוצים</th>
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {items.map(([nm, c]) => {
                              const allowedCounts = generatedAssignmentCountOptionsByWorker.get(nm) || [c];
                              const minAllowed = allowedCounts[0] ?? 0;
                              const maxAllowed = allowedCounts[allowedCounts.length - 1] ?? c;
                              const isManuallyModified = Object.prototype.hasOwnProperty.call(assignmentCountFilters, nm);
                              return (
                                <tr key={nm} className="border-b last:border-0 dark:border-zinc-800">
                                  <td className="px-1 md:px-2 py-1 md:py-2 w-32 md:w-64 overflow-hidden text-center">
                                    {renderSummaryWorkerChip(nm)}
                                  </td>
                                  <td className="px-1 md:px-2 py-1 md:py-2 w-16 md:w-28 whitespace-nowrap">
                                    {allowCountFiltering ? (
                                      <>
                                        <div className="md:hidden">
                                          <NumberPicker
                                            value={Number(assignmentCountFilters[nm] ?? c)}
                                            onChange={(value) => handleAssignmentCountFilterChange(nm, String(value), maxAllowed)}
                                            min={minAllowed}
                                            max={maxAllowed}
                                            placeholder={String(c)}
                                            className={
                                              "w-14 rounded-md border px-2 py-1 text-center text-[10px] outline-none " +
                                              (isManuallyModified
                                                ? "border-orange-400 bg-orange-50 text-orange-700 focus:border-orange-500 dark:border-orange-600 dark:bg-orange-950/30 dark:text-orange-300"
                                                : "border-zinc-300 bg-white focus:border-[#00A8E0] dark:border-zinc-700 dark:bg-zinc-950")
                                            }
                                          />
                                        </div>
                                        <input
                                          type="number"
                                          min={minAllowed}
                                          max={maxAllowed}
                                          inputMode="numeric"
                                          value={assignmentCountFilters[nm] ?? ""}
                                          placeholder={String(c)}
                                          onChange={(e) => handleAssignmentCountFilterChange(nm, e.target.value, maxAllowed)}
                                          className={
                                            "hidden md:block w-14 rounded-md border px-2 py-1 text-center text-[10px] md:text-sm outline-none " +
                                            (isManuallyModified
                                              ? "border-orange-400 bg-orange-50 text-orange-700 focus:border-orange-500 dark:border-orange-600 dark:bg-orange-950/30 dark:text-orange-300"
                                              : "border-zinc-300 bg-white focus:border-[#00A8E0] dark:border-zinc-700 dark:bg-zinc-950")
                                          }
                                          aria-label={`מספר משמרות עבור ${nm}`}
                                          title={`Valeurs générées: ${allowedCounts.join(", ")}`}
                                        />
                                      </>
                                    ) : (
                                      c
                                    )}
                                  </td>
                                  {showMultiSiteTotalColumn && (
                                    <td className="px-1 md:px-2 py-1 md:py-2 w-16 md:w-28 whitespace-nowrap text-right">
                                      {totalAssignmentsForSummaryWorker(nm, c)}
                                    </td>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        </div>
                        {(() => {
                          // Récap par תפקיד
                          const roleTotals = new Map<string, number>();
                          const stationsCfg: any[] = (site?.config?.stations || []) as any[];
                          const getStationCfg = (tIdx: number) => stationsCfg[tIdx] || null;
                          const dayKeys = Object.keys(aiPlan.assignments || {});
                          function roleRequirementsLocal(st: any, shiftName: string, dayKey: string): Record<string, number> {
                            const out: Record<string, number> = {};
                            const push = (name?: string, count?: number, enabled?: boolean) => {
                              const rn = (name || "").trim();
                              const c = Number(count || 0);
                              if (!rn || !enabled || c <= 0) return; out[rn] = (out[rn] || 0) + c;
                            };
                            if (!st) return out;
                            if (st.perDayCustom) {
                              const dayCfg = st.dayOverrides?.[dayKey];
                              if (!dayCfg || dayCfg.active === false) return out;
                              if (st.uniformRoles) {
                                for (const r of (st.roles || [])) push(r?.name, r?.count, r?.enabled);
                              } else {
                                const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
                                for (const r of ((sh?.roles as any[]) || [])) push(r?.name, r?.count, r?.enabled);
                              }
                              return out;
                            }
                            if (st.uniformRoles) {
                              for (const r of (st.roles || [])) push(r?.name, r?.count, r?.enabled);
                            } else {
                              const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
                              for (const r of ((sh?.roles as any[]) || [])) push(r?.name, r?.count, r?.enabled);
                            }
                            return out;
                          }
                          function assignRolesLocal(assignedNames: string[], st: any, shiftName: string, dayKey: string): Map<string, string | null> {
                            const req = roleRequirementsLocal(st, shiftName, dayKey);
                            const res = new Map<string, string | null>();
                            const used = new Set<number>();
                            assignedNames.forEach((nm) => res.set(nm, null));
                            for (const [rName, rCount] of Object.entries(req)) {
                              let left = rCount;
                              if (left <= 0) continue;
                              for (let i = 0; i < assignedNames.length && left > 0; i++) {
                                if (used.has(i)) continue;
                                const nm = assignedNames[i];
                                const w = workers.find((x) => (x.name || "").trim() === (nm || "").trim());
                                const has = !!w && (w.roles || []).includes(rName);
                                if (!has) continue;
                                res.set(nm, rName);
                                used.add(i);
                                left--;
                              }
                            }
                            return res;
                          }
                          // parcours des cellules
                          dayKeys.forEach((dKey) => {
                            const shiftsMap = (aiPlan.assignments as any)[dKey] || {};
                            for (const sn of Object.keys(shiftsMap)) {
                              const perStation: string[][] = shiftsMap[sn] || [];
                              perStation.forEach((namesHere, tIdx) => {
                                const stCfg = getStationCfg(tIdx);
                                // Filtrer les valeurs vides avant d'assigner les rôles
                                const filteredNames = (namesHere || []).filter(Boolean);
                                const m = assignRolesLocal(filteredNames, stCfg, sn, dKey);
                                m.forEach((rName) => {
                                  if (!rName) return;
                                  roleTotals.set(rName, (roleTotals.get(rName) || 0) + 1);
                                });
                              });
                            }
                          });
                          // Compléter avec tous les rôles connus (même si 0 assignation)
                          for (const rName of Array.from(enabledRoleNameSet)) {
                            if (!roleTotals.has(rName)) roleTotals.set(rName, 0);
                          }
                          // N'afficher que les rôles actifs dans la config
                          if (enabledRoleNameSet.size === 0) return null;
                          const rows = Array.from(roleTotals.entries())
                            .filter(([rName]) => enabledRoleNameSet.has(rName))
                            .sort((a, b) => a[0].localeCompare(b[0]));
                          return (
                            <div className="mt-4 max-h-[24rem] overflow-y-auto overflow-x-hidden md:overflow-x-auto">
                              <table className="w-full border-collapse table-fixed text-[10px] md:text-sm">
                                <thead>
                                  <tr className="border-b dark:border-zinc-800">
                                    <th className="px-1 md:px-2 py-1 md:py-2 text-center w-32 md:w-64">תפקיד</th>
                                    <th className="px-1 md:px-2 py-1 md:py-2 text-right w-16 md:w-28 whitespace-nowrap">סה"כ שיבוצים</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {rows.map(([rName, cnt]) => {
                                    const rc = colorForRole(rName);
                                    return (
                                      <tr key={rName} className="border-b last:border-0 dark:border-zinc-800">
                                        <td className="px-1 md:px-2 py-1 md:py-2 w-32 md:w-64 overflow-hidden text-center">
                                          {renderSummaryRoleChip(rName)}
                                        </td>
                                        <td className="px-1 md:px-2 py-1 md:py-2 w-16 md:w-28 whitespace-nowrap">{cnt}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          );
                        })()}
                      </>
                    );
                  })()}
                </div>
              )}
              {isManual && manualAssignments && (!savedWeekPlan?.assignments || editingSaved) && (
                <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
                  <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">סיכום שיבוצים לעמדה (כל העמדות)</div>
                  {(() => {
                    // Build counts from manualAssignments
                    const counts = new Map<string, number>();
                    const days = Object.keys(manualAssignments || {});
                    for (const dKey of days) {
                      const shiftsMap = (manualAssignments as any)[dKey] || {};
                      for (const sn of Object.keys(shiftsMap)) {
                        const perStation: string[][] = shiftsMap[sn] || [];
                        for (const namesHere of perStation) {
                          for (const nm of (namesHere || [])) {
                            if (!nm) continue;
                            counts.set(nm, (counts.get(nm) || 0) + 1);
                          }
                        }
                      }
                    }
                    // Include all workers with 0
                    workers.forEach((w) => { if (!counts.has(w.name)) counts.set(w.name, 0); });
                    const order = new Map<string, number>();
                    workers.forEach((w, i) => order.set(w.name, i));
                    const isPendingApprovalName = (name: string) =>
                      !!(workers.find((w) => String(w.name || "").trim() === String(name || "").trim())?.pendingApproval);
                    const items = Array.from(counts.entries())
                      .filter(([nm]) => !isPendingApprovalName(nm))
                      .sort((a, b) => {
                      const ia = order.has(a[0]) ? (order.get(a[0]) as number) : Number.MAX_SAFE_INTEGER;
                      const ib = order.has(b[0]) ? (order.get(b[0]) as number) : Number.MAX_SAFE_INTEGER;
                      if (ia !== ib) return ia - ib;
                      return a[0].localeCompare(b[0]);
                    });
                    // Compute totals required from site config as in AI summary
                    const stationsCfgAll: any[] = (site?.config?.stations || []) as any[];
                    function requiredForSummary(st: any, shiftName: string, dayKey: string): number {
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
                    let totalRequired = 0;
                    for (const dKey of days) {
                      const shiftsMap = (manualAssignments as any)[dKey] || {};
                      for (const sn of Object.keys(shiftsMap)) {
                        for (let tIdx = 0; tIdx < stationsCfgAll.length; tIdx++) {
                          totalRequired += requiredForSummary(stationsCfgAll[tIdx], sn, dKey);
                        }
                      }
                    }
                    const totalAssigned = Array.from(counts.values()).reduce((a, b) => a + b, 0);
                    return (
                      <>
                        <div className="mb-2 flex items-center justify-end gap-6 text-xs md:text-sm">
                          <div>סה"כ נדרש: <span className="font-medium">{totalRequired}</span></div>
                          <div>סה"כ שיבוצים: <span className="font-medium">{totalAssigned}</span></div>
                        </div>
                        <div className="max-h-[24rem] overflow-y-auto overflow-x-hidden md:overflow-x-auto">
                          <table className="w-full border-collapse table-fixed text-[10px] md:text-sm">
                            <thead>
                              <tr className="border-b dark:border-zinc-800">
                                <th className="px-1 md:px-2 py-1 md:py-2 text-center w-32 md:w-64">עובד</th>
                                <th className="px-1 md:px-2 py-1 md:py-2 text-right w-16 md:w-28 whitespace-nowrap">מס' משמרות</th>
                                {showMultiSiteTotalColumn && (
                                  <th className="px-1 md:px-2 py-1 md:py-2 text-right w-16 md:w-28 whitespace-nowrap">total שיבוצים</th>
                                )}
                              </tr>
                            </thead>
                            <tbody>
                              {items.map(([nm, c]) => {
                                return (
                                  <tr key={nm} className="border-b last:border-0 dark:border-zinc-800">
                                    <td className="px-1 md:px-2 py-1 md:py-2 w-32 md:w-64 overflow-hidden text-center">
                                      {renderSummaryWorkerChip(nm)}
                                    </td>
                                    <td className="px-1 md:px-2 py-1 md:py-2 w-16 md:w-28 whitespace-nowrap">{c}</td>
                                    {showMultiSiteTotalColumn && (
                                      <td className="px-1 md:px-2 py-1 md:py-2 w-16 md:w-28 whitespace-nowrap text-right">
                                        {totalAssignmentsForSummaryWorker(nm, c)}
                                      </td>
                                    )}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}
              {savedWeekPlan?.assignments && !editingSaved && (
                <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
                  <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">סיכום שיבוצים לעמדה (כל העמדות)</div>
                  {(() => {
                    const assignments = savedWeekPlan!.assignments as any;
                    const counts = new Map<string, number>();
                    const dayKeys = Object.keys(assignments || {});
                    for (const dKey of dayKeys) {
                      const shiftsMap = assignments[dKey] || {};
                      for (const sn of Object.keys(shiftsMap)) {
                        const perStation: string[][] = shiftsMap[sn] || [];
                        for (const namesHere of perStation) {
                          for (const nm of (namesHere || [])) {
                            if (!nm) continue;
                            counts.set(nm, (counts.get(nm) || 0) + 1);
                          }
                        }
                      }
                    }
                    // Worker ordering based on saved snapshot workers if available
                    const workerList: Worker[] = (Array.isArray(savedWeekPlan!.workers) && savedWeekPlan!.workers!.length)
                      ? (savedWeekPlan!.workers as any[]).map((w: any, idx: number) => ({
                          id: Number(w.id) || idx,
                          name: String(w.name || ""),
                          maxShifts: Number(w.maxShifts || 0),
                          roles: Array.isArray(w.roles) ? w.roles : [],
                          availability: w.availability || {},
                          answers: w.answers || {},
                        }))
                      : workers;
                    workerList.forEach((w) => { if (!counts.has(w.name)) counts.set(w.name, 0); });
                    const order = new Map<string, number>();
                    workerList.forEach((w, i) => order.set(w.name, i));
                    const items = Array.from(counts.entries()).sort((a, b) => {
                      const ia = order.has(a[0]) ? (order.get(a[0]) as number) : Number.MAX_SAFE_INTEGER;
                      const ib = order.has(b[0]) ? (order.get(b[0]) as number) : Number.MAX_SAFE_INTEGER;
                      if (ia !== ib) return ia - ib;
                      return a[0].localeCompare(b[0]);
                    });
                    // Totaux
                    const stationsCfgAll: any[] = (site?.config?.stations || []) as any[];
                    function requiredForSummary(st: any, shiftName: string, dayKey: string): number {
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
                    let totalRequired = 0;
                    for (const dKey of dayKeys) {
                      const shiftsMap = assignments[dKey] || {};
                      for (const sn of Object.keys(shiftsMap)) {
                        for (let tIdx = 0; tIdx < stationsCfgAll.length; tIdx++) {
                          totalRequired += requiredForSummary(stationsCfgAll[tIdx], sn, dKey);
                        }
                      }
                    }
                    const totalAssigned = Array.from(counts.values()).reduce((a, b) => a + b, 0);
                    if (workerList.length === 0) {
                      return <div className="text-sm text-zinc-500">אין שיבוצים</div>;
                    }
                    return (
                      <>
                        <div className="mb-2 flex items-center justify-end gap-6 text-xs md:text-sm">
                          <div>סה"כ נדרש: <span className="font-medium">{totalRequired}</span></div>
                          <div>סה"כ שיבוצים: <span className="font-medium">{totalAssigned}</span></div>
                        </div>
                        <div className="max-h-[24rem] overflow-y-auto overflow-x-hidden md:overflow-x-auto">
                          <table className="w-full border-collapse table-fixed text-[10px] md:text-sm">
                            <thead>
                              <tr className="border-b dark:border-zinc-800">
                                <th className="px-1 md:px-2 py-1 md:py-2 text-center w-32 md:w-64">עובד</th>
                                <th className="px-1 md:px-2 py-1 md:py-2 text-right w-16 md:w-28 whitespace-nowrap">מס' משמרות</th>
                                {showMultiSiteTotalColumn && (
                                  <th className="px-1 md:px-2 py-1 md:py-2 text-right w-16 md:w-28 whitespace-nowrap">total שיבוצים</th>
                                )}
                              </tr>
                            </thead>
                            <tbody>
                              {items.map(([nm, c]) => {
                                return (
                                  <tr key={nm} className="border-b last:border-0 dark:border-zinc-800">
                                    <td className="px-1 md:px-2 py-1 md:py-2 w-32 md:w-64 overflow-hidden text-center">
                                      {renderSummaryWorkerChip(nm)}
                                    </td>
                                    <td className="px-1 md:px-2 py-1 md:py-2 w-16 md:w-28 whitespace-nowrap">{c}</td>
                                    {showMultiSiteTotalColumn && (
                                      <td className="px-1 md:px-2 py-1 md:py-2 w-16 md:w-28 whitespace-nowrap text-right">
                                        {totalAssignmentsForSummaryWorker(nm, c)}
                                      </td>
                                    )}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          </div>
                          {(() => {
                            // Récap par תפקיד
                            const roleTotals = new Map<string, number>();
                            const stationsCfg: any[] = (site?.config?.stations || []) as any[];
                            const getStationCfg = (tIdx: number) => stationsCfg[tIdx] || null;
                            function roleRequirementsLocal(st: any, shiftName: string, dayKey: string): Record<string, number> {
                              const out: Record<string, number> = {};
                              const push = (name?: string, count?: number, enabled?: boolean) => {
                                const rn = (name || "").trim();
                                const c = Number(count || 0);
                                if (!rn || !enabled || c <= 0) return; out[rn] = (out[rn] || 0) + c;
                              };
                              if (!st) return out;
                              if (st.perDayCustom) {
                                const dayCfg = st.dayOverrides?.[dayKey];
                                if (!dayCfg || dayCfg.active === false) return out;
                                if (st.uniformRoles) {
                                  for (const r of (st.roles || [])) push(r?.name, r?.count, r?.enabled);
                                } else {
                                  const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
                                  for (const r of ((sh?.roles as any[]) || [])) push(r?.name, r?.count, r?.enabled);
                                }
                                return out;
                              }
                              if (st.uniformRoles) {
                                for (const r of (st.roles || [])) push(r?.name, r?.count, r?.enabled);
                              } else {
                                const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
                                for (const r of ((sh?.roles as any[]) || [])) push(r?.name, r?.count, r?.enabled);
                              }
                              return out;
                            }
                            function assignRolesLocal(assignedNames: string[], st: any, shiftName: string, dayKey: string): Map<string, string | null> {
                              const req = roleRequirementsLocal(st, shiftName, dayKey);
                              const res = new Map<string, string | null>();
                              const used = new Set<number>();
                              assignedNames.forEach((nm) => res.set(nm, null));
                              for (const [rName, rCount] of Object.entries(req)) {
                                let left = rCount;
                                if (left <= 0) continue;
                                for (let i = 0; i < assignedNames.length && left > 0; i++) {
                                  if (used.has(i)) continue;
                                  const nm = assignedNames[i];
                                  const w = workerList.find((x) => (x.name || "").trim() === (nm || "").trim());
                                  const has = !!w && (w.roles || []).includes(rName);
                                  if (!has) continue;
                                  res.set(nm, rName);
                                  used.add(i);
                                  left--;
                                }
                              }
                              return res;
                            }
                            // parcours des cellules
                            dayKeys.forEach((dKey) => {
                              const shiftsMap = assignments[dKey] || {};
                              for (const sn of Object.keys(shiftsMap)) {
                                const perStation: string[][] = shiftsMap[sn] || [];
                                perStation.forEach((namesHere, tIdx) => {
                                  const stCfg = getStationCfg(tIdx);
                                  const m = assignRolesLocal((namesHere || []).filter(Boolean), stCfg, sn, dKey);
                                  m.forEach((rName) => {
                                    if (!rName) return;
                                    roleTotals.set(rName, (roleTotals.get(rName) || 0) + 1);
                                  });
                                });
                              }
                            });
                            // Compléter avec tous les rôles connus (même si 0 assignation)
                            for (const rName of Array.from(enabledRoleNameSet)) {
                              if (!roleTotals.has(rName)) roleTotals.set(rName, 0);
                            }
                            // N'afficher que les rôles actifs dans la config
                            if (enabledRoleNameSet.size === 0) return null;
                            const rows = Array.from(roleTotals.entries())
                              .filter(([rName]) => enabledRoleNameSet.has(rName))
                              .sort((a, b) => a[0].localeCompare(b[0]));
                            return (
                              <div className="mt-4 max-h-[24rem] overflow-y-auto overflow-x-hidden md:overflow-x-auto">
                                <table className="w-full border-collapse table-fixed text-[10px] md:text-sm">
                                  <thead>
                                    <tr className="border-b dark:border-zinc-800">
                                      <th className="px-1 md:px-2 py-1 md:py-2 text-center w-32 md:w-64">תפקיד</th>
                                      <th className="px-1 md:px-2 py-1 md:py-2 text-right w-16 md:w-28 whitespace-nowrap">סה"כ שיבוצים</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {rows.map(([rName, cnt]) => {
                                      const rc = colorForRole(rName);
                                      return (
                                        <tr key={rName} className="border-b last:border-0 dark:border-zinc-800">
                                          <td className="px-1 md:px-2 py-1 md:py-2 w-32 md:w-64 overflow-hidden text-center">
                                            {renderSummaryRoleChip(rName)}
                                          </td>
                                          <td className="px-1 md:px-2 py-1 md:py-2 w-16 md:w-28 whitespace-nowrap">{cnt}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            );
                          })()}
                      </>
                    );
                  })()}
                </div>
              )}

              {/* Messages optionnels (sous le récap) */}
              {/** En mode planning sauvegardé (lecture seule), désactiver édition des messages */}
              {/** isSavedMode = savedWeekPlan?.assignments; editingSaved = mode ערוך */}
              <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-sm text-zinc-600 dark:text-zinc-300">הודעה אופציונלית</div>
                  <button
                    type="button"
                    disabled={isSavedMode && !editingSaved}
                    className={
                      "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm " +
                      ((isSavedMode && !editingSaved)
                        ? "border-zinc-300 text-zinc-400 cursor-not-allowed dark:border-zinc-700 dark:text-zinc-500"
                        : "border-green-600 text-green-600 hover:bg-green-50 dark:border-green-500 dark:text-green-400 dark:hover:bg-green-900/30")
                    }
                    onClick={() => {
                      if (isSavedMode && !editingSaved) return;
                      setEditingMessageId(null);
                      const initial = "<p><br/></p>";
                      setMessageEditorInitialHtml(initial);
                      setNewMessageText(initial);
                      setNewMessagePermanent(true);
                      setIsAddMessageOpen(true);
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M19 11H13V5h-2v6H5v2h6v6h2v-6h6v-2z" />
                    </svg>
                    הוסף הודעה
                  </button>
                </div>

                {messagesLoading ? (
                  <LoadingAnimation className="py-4" size={60} />
                ) : visibleMessages.length === 0 ? (
                  <div className="text-sm text-zinc-500">אין הודעות</div>
                ) : (
                  <div className="space-y-2">
                    {visibleMessages.map((m) => (
                      <div key={m.id} className="rounded-md border p-3 dark:border-zinc-700">
                        <div className="flex items-start justify-between gap-3">
                          <div className="text-sm text-zinc-800 dark:text-zinc-100" dir="rtl">
                            {(() => {
                              const raw = String(m.text || "");
                              if (isProbablyHtml(raw)) {
                                const clean = sanitizeMessageHtml(raw);
                                return <div className="prose prose-sm max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: clean }} />;
                              }
                              return (
                                <ReactMarkdown
                                  remarkPlugins={[remarkGfm]}
                                  components={{
                                    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                                    ul: ({ children }) => <ul className="mb-2 list-disc pr-5">{children}</ul>,
                                    ol: ({ children }) => <ol className="mb-2 list-decimal pr-5">{children}</ol>,
                                    li: ({ children }) => <li className="mb-1 last:mb-0">{children}</li>,
                                    a: ({ children, href }) => (
                                      <a className="underline decoration-dotted" href={href} target="_blank" rel="noreferrer">
                                        {children}
                                      </a>
                                    ),
                                    table: ({ children }) => (
                                      <div className="overflow-x-auto">
                                        <table className="w-full border-collapse text-sm">{children}</table>
                                      </div>
                                    ),
                                    th: ({ children }) => <th className="border px-2 py-1 text-right bg-zinc-50 dark:bg-zinc-800">{children}</th>,
                                    td: ({ children }) => <td className="border px-2 py-1 text-right align-top">{children}</td>,
                                  }}
                                >
                                  {raw}
                                </ReactMarkdown>
                              );
                            })()}
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={isSavedMode && !editingSaved}
                              className={
                                "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs " +
                                ((isSavedMode && !editingSaved)
                                  ? "cursor-not-allowed opacity-50 dark:border-zinc-700"
                                  : "hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800")
                              }
                              onClick={() => {
                                if (isSavedMode && !editingSaved) return;
                                setEditingMessageId(m.id);
                                const initial = toEditorHtml(String(m.text || ""));
                                setMessageEditorInitialHtml(initial);
                                setNewMessageText(initial);
                                setNewMessagePermanent(m.scope === "global");
                                setIsAddMessageOpen(true);
                              }}
                            >
                              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
                                <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75Z"/>
                              </svg>
                              ערוך
                            </button>
                            <button
                              type="button"
                              disabled={isSavedMode && !editingSaved}
                              className={
                                "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs " +
                                (((isSavedMode && !editingSaved))
                                  ? "border-zinc-200 text-zinc-400 cursor-not-allowed opacity-60 dark:border-zinc-700 dark:text-zinc-600"
                                  : "border-red-600 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/40")
                              }
                              onClick={async () => {
                                if (isSavedMode && !editingSaved) return;
                                const siteId = Number(params.id);
                                const wk = isoYMD(weekStart);
                                if (!siteId) return;
                                const previousMessages = messages;
                                setMessages((prev) => prev.filter((msg) => Number(msg.id) !== Number(m.id)));
                                try {
                                  await apiFetch<string>(`/director/sites/${siteId}/messages/${m.id}?week=${encodeURIComponent(wk)}`, {
                                    method: "DELETE",
                                    headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                                  });
                                } catch {
                                  setMessages(previousMessages);
                                }
                              }}
                            >
                              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
                                <path d="M6 7h12v2H6Zm2 4h8l-1 9H9ZM9 4h6v2H9Z"/>
                              </svg>
                              מחק
                            </button>
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-3">
                          <label className="inline-flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
                            <input
                              type="checkbox"
                              checked={m.scope === "global"}
                              disabled={isSavedMode && !editingSaved}
                              onChange={async (e) => {
                                if (isSavedMode && !editingSaved) return;
                                const siteId = Number(params.id);
                                const wk = isoYMD(weekStart);
                                if (!siteId) return;
                                const scope = e.target.checked ? "global" : "week";
                                try {
                                  const res = await apiFetch<OptionalMessage[]>(
                                    `/director/sites/${siteId}/messages/${m.id}`,
                                    {
                                      method: "PATCH",
                                      headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                                      body: JSON.stringify({ scope, week_iso: wk }),
                                    }
                                  );
        setMessages(Array.isArray(res) ? sortMessagesChronologically(res) : []);
                                } catch {}
                              }}
                            />
                            קבוע
                          </label>
                          <span className="text-xs text-zinc-500">
                            {m.scope === "global" ? "לכל השבועות הבאים" : "לשבוע זה בלבד"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {isAddMessageOpen && !(isSavedMode && !editingSaved) && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={closeMessageModal}>
                  <div className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
                    <div className="mb-3 flex items-center justify-between">
                      <div className="text-lg font-semibold">{editingMessageId ? "עריכת הודעה" : "הוסף הודעה"}</div>
                      <button
                        type="button"
                        className="inline-flex items-center justify-center rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        onClick={closeMessageModal}
                        aria-label="סגור"
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                      </button>
                    </div>
                    <div className="rounded-md border dark:border-zinc-700">
                      <div className="flex flex-wrap items-center gap-2 border-b p-2 dark:border-zinc-700">
                        {(() => {
                          const btn = (active: boolean) =>
                            "rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800 " +
                            (active ? "border-2 font-bold text-zinc-900 dark:text-zinc-100" : "text-zinc-700 dark:text-zinc-200");
                          const md = (fn: () => void) => (e: any) => { e.preventDefault(); e.stopPropagation(); fn(); };
                          const isBold = !!messageEditor?.isActive("bold");
                          const isItalic = !!messageEditor?.isActive("italic");
                          const isUnderline = !!messageEditor?.isActive("underline");
                          const isH2 = !!messageEditor?.isActive("heading", { level: 2 });
                          const isBullet = !!messageEditor?.isActive("bulletList");
                          const isOrdered = !!messageEditor?.isActive("orderedList");
                          const isLink = !!messageEditor?.isActive("link");
                          const isHighlight = !!messageEditor?.isActive("highlight");
                          return (
                            <>
                              <button type="button" className={btn(isBold)} onMouseDown={md(() => messageEditor?.chain().focus().toggleBold().run())}>B</button>
                              <button type="button" className={btn(isItalic) + " italic"} onMouseDown={md(() => messageEditor?.chain().focus().toggleItalic().run())}>I</button>
                              <button type="button" className={btn(isUnderline) + " underline"} onMouseDown={md(() => messageEditor?.chain().focus().toggleUnderline().run())}>U</button>
                              <button type="button" className={btn(isH2)} onMouseDown={md(() => messageEditor?.chain().focus().toggleHeading({ level: 2 }).run())}>H2</button>
                              <button type="button" className={btn(isBullet)} onMouseDown={md(() => messageEditor?.chain().focus().toggleBulletList().run())}>•</button>
                              <button type="button" className={btn(isOrdered)} onMouseDown={md(() => messageEditor?.chain().focus().toggleOrderedList().run())}>1.</button>

                              <div className="mx-1 h-6 w-px bg-zinc-200 dark:bg-zinc-700" />

                              <button
                                type="button"
                                className={btn(isLink)}
                                onMouseDown={md(() => {
                                  const url = window.prompt("כתובת קישור (URL):", "https://");
                                  if (!url) return;
                                  messageEditor?.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
                                })}
                              >
                                🔗
                              </button>

                              <div className="mx-1 h-6 w-px bg-zinc-200 dark:bg-zinc-700" />

                              <button
                                type="button"
                                className={btn(isHighlight)}
                                style={{ borderColor: messageHighlightColor, color: messageHighlightColor }}
                                onMouseDown={md(() => messageEditor?.chain().focus().toggleHighlight({ color: messageHighlightColor }).run())}
                              >
                                HL
                              </button>
                              <input
                                type="color"
                                value={messageHighlightColor}
                                onChange={(e) => setMessageHighlightColor(e.target.value)}
                                className="h-8 w-10 cursor-pointer rounded-md border dark:border-zinc-700"
                                title="צבע סימון"
                              />

                              <button
                                type="button"
                                className={btn(false)}
                                style={{ borderColor: messageTextColor, color: messageTextColor }}
                                onMouseDown={md(() => messageEditor?.chain().focus().setColor(messageTextColor).run())}
                              >
                                A
                              </button>
                              <input
                                type="color"
                                value={messageTextColor}
                                onChange={(e) => setMessageTextColor(e.target.value)}
                                className="h-8 w-10 cursor-pointer rounded-md border dark:border-zinc-700"
                                title="צבע טקסט"
                              />
                            </>
                          );
                        })()}
                      </div>
                      {messageEditor ? (
                        <EditorContent editor={messageEditor} />
                      ) : (
                        <div className="min-h-32 bg-white px-3 py-2 dark:bg-zinc-900 flex items-center justify-center">
                          <LoadingAnimation size={60} />
                        </div>
                      )}
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <label className="inline-flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
                        <input type="checkbox" checked={newMessagePermanent} onChange={(e) => setNewMessagePermanent(e.target.checked)} />
                        קבוע (לכל השבועות הבאים)
                      </label>
                      <span className="text-xs text-zinc-500">{newMessagePermanent ? "קבוע" : "לשבוע זה בלבד"}</span>
                    </div>
                    <div className="mt-4 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        onClick={closeMessageModal}
                      >
                        ביטול
                      </button>
                      <button
                        type="button"
                        className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6]"
                        onClick={async () => {
                          const txt = newMessageText.trim();
                          if (!txt) return;
                          const siteId = Number(params.id);
                          if (!siteId) return;
                          const wk = isoYMD(weekStart);

                          const targetScope: OptionalMessage["scope"] = newMessagePermanent ? "global" : "week";
                          try {
                            if (editingMessageId) {
                              const res = await apiFetch<OptionalMessage[]>(
                                `/director/sites/${siteId}/messages/${editingMessageId}`,
                                {
                                  method: "PATCH",
                                  headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                                  body: JSON.stringify({ text: txt, scope: targetScope, week_iso: wk }),
                                }
                              );
                              setMessages(Array.isArray(res) ? sortMessagesChronologically(res) : []);
                              closeMessageModal();
                              return;
                            }
                            const created = await apiFetch<OptionalMessage>(
                              `/director/sites/${siteId}/messages`,
                              {
                                method: "POST",
                                headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                                body: JSON.stringify({ text: txt, scope: targetScope, week_iso: wk }),
                              }
                            );
                            setMessages((prev) => sortMessagesChronologically([...prev, created]));
                          } catch {}
                          closeMessageModal();
                        }}
                      >
                        {editingMessageId ? "שמור" : "הוסף"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {!isManual && (
              <div className="pt-2 text-center">
                <button
                  type="button"
                      id="btn-generate-plan"
                  style={{ display: 'none' }}
                  aria-hidden
                  onClick={async () => {
                    // Vérifier si on est en mode ערוך et si la semaine contient le jour actuel
                    if (editingSaved) {
                      const today = new Date();
                      today.setHours(0, 0, 0, 0);
                      const weekStartNormalized = new Date(weekStart);
                      weekStartNormalized.setHours(0, 0, 0, 0);
                      const weekEnd = addDays(weekStartNormalized, 6);
                      weekEnd.setHours(23, 59, 59, 999);
                      
                      // Vérifier si la semaine contient le jour actuel
                      if (today >= weekStartNormalized && today <= weekEnd) {
                        // Compter les jours passés (sans compter le jour actuel)
                        const pastDaysCount = Math.floor((today.getTime() - weekStartNormalized.getTime()) / (1000 * 60 * 60 * 24));
                        if (pastDaysCount > 0) {
                          const confirmed = window.confirm(
                            `כבר עברו ${pastDaysCount} ימים בשבוע זה. האם ברצונך לשנות רק את הימים הנותרים החל מהיום?`
                          );
                          if (!confirmed) return;
                          // Note: Pour l'instant, on continue avec le plan complet
                          // On pourrait implémenter une logique pour préserver les jours passés
                        }
                      }
                    }
                    // Arrêter tout processus en cours
                    stopAiGeneration();
                    
                    // Vérifier si la grille n'est pas vide
                    const checkGridNonEmpty = () => {
                      const check = (assignments: any): boolean => {
                        if (!assignments || typeof assignments !== "object") return false;
                        for (const dayKey of Object.keys(assignments)) {
                          const shiftsMap = assignments[dayKey];
                          if (!shiftsMap || typeof shiftsMap !== "object") continue;
                          for (const shiftName of Object.keys(shiftsMap)) {
                            const perStation = shiftsMap[shiftName];
                            if (!Array.isArray(perStation)) continue;
                            for (const cell of perStation) {
                              if (Array.isArray(cell) && cell.some((n) => n && String(n).trim().length > 0)) {
                                return true;
                              }
                            }
                          }
                        }
                        return false;
                      };
                      return check(manualAssignments) || check(aiPlan?.assignments) || (check(savedWeekPlan?.assignments) && !editingSaved);
                    };

                    const hasNonemptyNameCells = checkGridNonEmpty();
                    // Pop-up « שיבוצים קיימים » : uniquement s’il reste au moins une cellule avec un nom
                    // (pas pour le seul cas « plusieurs alternatives » avec grille vide).
                    if (hasNonemptyNameCells) {
                      if (genDialogBypassRef.current) {
                        genDialogBypassRef.current = null; // consume bypass and proceed to generation
                      } else {
                      setShowGenDialog(true);
                      return;
                      }
                    }
                    setGenUseFixed(false);
                    // Grille vide: proposer d'ignorer les jours passés si la semaine en contient
                    if (genExcludeDays === null) {
                      const today = new Date(); today.setHours(0,0,0,0);
                      const weekStartNormalized = new Date(weekStart); weekStartNormalized.setHours(0,0,0,0);
                      const weekEnd = addDays(weekStartNormalized, 6); weekEnd.setHours(23,59,59,999);
                      let excludeList: string[] | null = null;
                      if (today >= weekStartNormalized && today <= weekEnd) {
                        const pastDaysCount = Math.max(0, Math.floor((today.getTime() - weekStartNormalized.getTime()) / (1000*60*60*24)));
                        if (pastDaysCount > 0) {
                          const order = ["sun","mon","tue","wed","thu","fri","sat"];
                          // Construire la liste à exclure depuis le début de la semaine jusqu'à hier
                          excludeList = order.slice(0, pastDaysCount);
                          // Ouvrir un dialogue à 3 choix (Oui / Non / Annuler)
                          setPendingExcludeDays(excludeList);
                          setShowPastDaysDialog(true);
                          return; // attendre la décision de l'utilisateur
                        }
                      }
                      setGenExcludeDays(excludeList);
                    }
                    if (linkedSites.length > 1 && autoPullsEnabled) {
                      if (multiSitePullsDialogBypassRef.current) {
                        multiSitePullsDialogBypassRef.current = false;
                      } else {
                        prepareMultiSitePullsDialog();
                        return;
                      }
                    } else {
                      multiSitePullsRequestRef.current = null;
                    }

                    /** Avant tout await : après setGenUseFixed(false) le useEffect peut remettre la ref à false,
                     * ce qui annulait fixed_assignments. On fige l’intention ici. */
                    const snapshotGenUseFixed = genUseFixedRef.current;

                    let stopped = false;
                    try {
                      await clearAutoWeeklyPlanningCacheForCurrentContext();
                      clearLinkedPlansMemory();
                      setAiLoading(true);
                      setAiPlan(null);
                      setPullsByHoleKey({});
                      setPullsEditor(null);
                      baseAssignmentsRef.current = null;
                      streamPullPriorityPromotedRef.current = false;
                      setAltIndex(0);
                      const controller = new AbortController();
                      aiControllerRef.current = controller;
                      registerSharedGenerationController(weekStart, controller);
                      setSharedGenerationRunningState(weekStart, true);
                      setSharedGenerationRunning(true);
                      const timeoutId = setTimeout(() => {
                        try { controller.abort(); } catch {}
                        setAiLoading(false);
                        registerSharedGenerationController(weekStart, null);
                        setSharedGenerationRunningState(weekStart, false);
                        setSharedGenerationRunning(false);
                      }, 120000);
                      aiTimeoutRef.current = timeoutId;
                      // Inactivité: si aucune frame reçue pendant X ms, terminer proprement
                      const armIdle = () => {
                        if (aiIdleTimeoutRef.current) clearTimeout(aiIdleTimeoutRef.current);
                        aiIdleTimeoutRef.current = setTimeout(async () => {
                          setAiPlan((prev) => (prev ? { ...prev, status: "DONE" } : prev));
                          setAiLoading(false);
                          setSharedGenerationRunning(false);
                          try { await reader.cancel?.(); } catch {}
                          try { controller.abort(); } catch {}
                          aiControllerRef.current = null;
                          registerSharedGenerationController(weekStart, null);
                          setSharedGenerationRunningState(weekStart, false);
                          if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
                          aiTimeoutRef.current = null;
                          if (aiIdleTimeoutRef.current) clearTimeout(aiIdleTimeoutRef.current);
                          aiIdleTimeoutRef.current = null;
                          stopped = true;
                          toast.success("התכנון הושלם");
                        }, 3000); // 3s d'inactivité
                      };
                      // Construire les cellules fixées (préaffectations)
                      // Priorité: manuel > planning sauvegardé (non en édition) > plan AI de l’alternative affichée
                      // Utiliser snapshotGenUseFixed (voir plus haut), pas genUseFixedRef après await.
                      const fixed = (() => {
                        if (!snapshotGenUseFixed) return null;
                        const nonEmpty = (obj: any) => obj && Object.keys(obj || {}).length > 0;
                        const pickSource = () => {
                          const pendingManualFixed = pendingManualFixedAssignmentsRef.current;
                          if (nonEmpty(pendingManualFixed)) return { src: 'manual-fixed', data: pendingManualFixed } as const;
                          // Toujours préférer les assignations manuelles si présentes ; si on a une base de comparaison,
                          // ne garder que les cellules non vides réellement modifiées en mode ידני.
                          if (nonEmpty(manualAssignments)) {
                            const manualFixed = manualModeBaseAssignmentsRef.current
                              ? buildChangedNonEmptyPlanningAssignmentsSnapshot(
                                  manualAssignments as PlanningAssignmentsMap,
                                  manualModeBaseAssignmentsRef.current,
                                )
                              : buildNonEmptyPlanningAssignmentsSnapshot(manualAssignments as PlanningAssignmentsMap);
                            if (nonEmpty(manualFixed)) return { src: 'manual', data: manualFixed } as const;
                          }
                          // Grille auto affichée : avant le planning sauvegardé, sinon on renvoie un brouillon DB périmé
                          // après éditions ידני puis retour אוטומטי avec « שמור מיקומים ».
                          if (!isManual && aiPlan && aiAssignmentsVariants.length) {
                            const safeIdx = Math.min(Math.max(0, Number(altIndex) || 0), aiAssignmentsVariants.length - 1);
                            const visible = aiAssignmentsVariants[safeIdx];
                            if (visible && nonEmpty(visible as any)) return { src: 'ai', data: visible as any } as const;
                          }
                          if (aiPlan?.assignments && nonEmpty(aiPlan.assignments as any)) return { src: 'ai', data: aiPlan.assignments as any } as const;
                          if (savedWeekPlan?.assignments && !editingSaved && nonEmpty(savedWeekPlan.assignments)) return { src: 'saved', data: savedWeekPlan.assignments as any } as const;
                          return null;
                        };
                        const chosen = pickSource();
                        if (!chosen) {
                          return null;
                        }
                        return buildNonEmptyPlanningAssignmentsSnapshot(chosen.data as PlanningAssignmentsMap);
                      })();

                      setDraftFixedAssignmentsSnapshot(
                        fixed && typeof fixed === "object" ? (JSON.parse(JSON.stringify(fixed)) as Record<string, Record<string, string[][]>>) : null,
                      );

                      const effectiveExcludeDays = (genExcludeDays && genExcludeDays.length ? genExcludeDays : undefined);
                      const weeklyAvailabilityForRequest = (() => {
                        return buildWeeklyAvailabilityForRequest();
                      })();
                      const effectivePullsLimitsBySite =
                        linkedSites.length > 1 && autoPullsEnabled
                          ? Object.fromEntries(
                              Object.entries(multiSitePullsRequestRef.current || {}).map(([siteId, value]) => [
                                siteId,
                                value === "unlimited" ? null : Number(value),
                              ]),
                            )
                          : undefined;
                      const currentSitePullsValue =
                        effectivePullsLimitsBySite && Object.prototype.hasOwnProperty.call(effectivePullsLimitsBySite, String(params.id))
                          ? effectivePullsLimitsBySite[String(params.id)]
                          : (autoPullsEnabled ? (autoPullsLimit === "unlimited" ? null : Number(autoPullsLimit)) : undefined);
                      const effectivePullsLimit: number | undefined =
                        typeof currentSitePullsValue === "number" ? currentSitePullsValue : undefined;
                      const pullsCountOf = (pulls: any) => (pulls && typeof pulls === "object" ? Object.keys(pulls).length : 0);
                      const exceedsPullsLimit = (pulls: any) =>
                        effectivePullsLimit != null && pullsCountOf(pulls) > effectivePullsLimit;
                      if (linkedSites.length > 1) {
                        const linkedResp = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/director/sites/${params.id}/ai-generate-linked/stream`, {
                          method: "POST",
                          headers: {
                            Authorization: `Bearer ${localStorage.getItem("access_token")}`,
                            Accept: "text/event-stream",
                            "Content-Type": "application/json",
                          },
                          body: JSON.stringify({
                            week_iso: getWeekKeyISO(weekStart),
                            num_alternatives: 500,
                            auto_pulls_enabled: autoPullsEnabled,
                            pulls_limit: effectivePullsLimit,
                            pulls_limits_by_site: effectivePullsLimitsBySite,
                            fixed_assignments: fixed || undefined,
                            exclude_days: effectiveExcludeDays,
                            weekly_availability: weeklyAvailabilityForRequest,
                          }),
                          signal: controller.signal,
                        });
                        if (!linkedResp.ok || !linkedResp.body) {
                          throw new Error(`HTTP ${linkedResp.status}`);
                        }
                        const reader = linkedResp.body.getReader();
                        const decoder = new TextDecoder("utf-8");
                        let buffer = "";
                        while (true) {
                          const { value, done } = await reader.read();
                          if (done) break;
                          buffer += decoder.decode(value, { stream: true });
                          let idx;
                          while ((idx = buffer.indexOf("\n\n")) !== -1) {
                            const frame = buffer.slice(0, idx).trim();
                            buffer = buffer.slice(idx + 2);
                            if (!frame.startsWith("data:")) continue;
                            try {
                              const jsonStr = frame.replace(/^data:\s*/, "");
                              const evt = JSON.parse(jsonStr);
                              if (Array.isArray(evt?.linked_sites)) {
                                updateLinkedSites(evt.linked_sites);
                              }
                              if (evt?.type === "base" && evt?.site_plans && typeof evt.site_plans === "object") {
                                const current = evt.site_plans[currentSiteIdRef.current];
                                if (exceedsPullsLimit(current?.pulls)) {
                                  continue;
                                }
                                const existingMemory = readLinkedPlansFromMemory(weekStart);
                                const mergedBasePlans = Object.fromEntries(
                                  Object.entries(evt.site_plans as Record<string, LinkedSitePlan>).map(([siteKey, incomingPlan]) => {
                                    const prevPlan = existingMemory?.plansBySite?.[siteKey];
                                    return [
                                      siteKey,
                                      {
                                        ...(prevPlan || incomingPlan),
                                        ...incomingPlan,
                                        assignments: incomingPlan.assignments,
                                        pulls: incomingPlan.pulls || {},
                                        alternatives: Array.isArray(prevPlan?.alternatives)
                                          ? prevPlan.alternatives
                                          : (Array.isArray(incomingPlan.alternatives) ? incomingPlan.alternatives : []),
                                        alternative_pulls: Array.isArray(prevPlan?.alternative_pulls)
                                          ? prevPlan.alternative_pulls
                                          : (Array.isArray(incomingPlan.alternative_pulls) ? incomingPlan.alternative_pulls : []),
                                      },
                                    ];
                                  }),
                                ) as Record<string, LinkedSitePlan>;
                                const nextActiveIndex = Math.max(0, Number(existingMemory?.activeAltIndex || 0));
                                saveLinkedPlansToMemory(weekStart, mergedBasePlans, nextActiveIndex, "sse-base");
                                const currentMerged = mergedBasePlans[currentSiteIdRef.current];
                                if (currentMerged?.assignments) {
                                  applyLinkedSitePlan(currentMerged, nextActiveIndex);
                                  toast.success("תכנון בסיסי מוכן");
                                  armIdle();
                                }
                              } else if (evt?.type === "alternative" && evt?.site_plans && typeof evt.site_plans === "object") {
                                armIdle();
                                const currentIncomingPlan = (evt.site_plans as Record<string, LinkedSitePlan>)[currentSiteIdRef.current];
                                if (exceedsPullsLimit(currentIncomingPlan?.pulls)) {
                                  continue;
                                }
                                const existingMemory = readLinkedPlansFromMemory(weekStart);
                                const mergedPlans = { ...(existingMemory?.plansBySite || {}) } as Record<string, LinkedSitePlan>;
                                const activeIndex = Number(existingMemory?.activeAltIndex || 0);
                                if (autoPullsEnabled && Object.keys(mergedPlans).length > 0) {
                                  const quality = compareLinkedSitePlansQuality(mergedPlans, evt.site_plans as Record<string, LinkedSitePlan>);
                                  if (quality < 0) {
                                    const nextPlans = Object.fromEntries(
                                      Object.entries(evt.site_plans as Record<string, LinkedSitePlan>).map(([siteKey, incomingPlan]) => [
                                        siteKey,
                                        {
                                          ...(mergedPlans[siteKey] || incomingPlan),
                                          ...incomingPlan,
                                          assignments: incomingPlan.assignments,
                                          alternatives: [
                                            ...((mergedPlans[siteKey]?.assignments ? [mergedPlans[siteKey].assignments] : []) as Record<string, Record<string, string[][]>>[]),
                                            ...((mergedPlans[siteKey]?.alternatives || []) as Record<string, Record<string, string[][]>>[]),
                                          ],
                                          pulls: incomingPlan.pulls || {},
                                          alternative_pulls: [
                                            ...((mergedPlans[siteKey]?.pulls ? [mergedPlans[siteKey].pulls] : []) as Record<string, PullEntry>[]),
                                            ...((mergedPlans[siteKey]?.alternative_pulls || []) as Record<string, PullEntry>[]),
                                          ],
                                        },
                                      ]),
                                    ) as Record<string, LinkedSitePlan>;
                                    const nextActiveIndex = activeIndex + 1;
                                    saveLinkedPlansToMemory(weekStart, nextPlans, nextActiveIndex, "sse-alt-promote");
                                    const current = nextPlans[currentSiteIdRef.current];
                                    if (current?.assignments) applyLinkedSitePlan(current, nextActiveIndex);
                                  } else if (quality === 0) {
                                    // Garder un index d'alternative global aligné entre tous les sites liés,
                                    // même si une alternative donnée produit localement le même planning.
                                    Object.entries(evt.site_plans as Record<string, LinkedSitePlan>).forEach(([siteKey, incomingPlan]) => {
                                      const prevPlan = mergedPlans[siteKey];
                                      mergedPlans[siteKey] = {
                                        ...(prevPlan || incomingPlan),
                                        assignments: prevPlan?.assignments || incomingPlan.assignments,
                                        pulls: prevPlan?.pulls || incomingPlan.pulls || {},
                                        alternatives: [
                                          ...((prevPlan?.alternatives || []) as Record<string, Record<string, string[][]>>[]),
                                          incomingPlan.assignments,
                                        ],
                                        alternative_pulls: [
                                          ...((prevPlan?.alternative_pulls || []) as Record<string, PullEntry>[]),
                                          (incomingPlan.pulls || {}),
                                        ],
                                      };
                                    });
                                    saveLinkedPlansToMemory(weekStart, mergedPlans, Number(existingMemory?.activeAltIndex || 0), "sse-alt-append");
                                  }
                                } else {
                                  const currentExistingPlan = mergedPlans[currentSiteIdRef.current];
                                  const promoteIncomingAsBase =
                                    !streamPullPriorityPromotedRef.current &&
                                    !!currentExistingPlan?.assignments &&
                                    !!currentIncomingPlan?.assignments &&
                                    shouldPromotePullFriendlyPlan(
                                      currentExistingPlan.assignments,
                                      currentExistingPlan.pulls,
                                      currentIncomingPlan.assignments,
                                      currentIncomingPlan.pulls,
                                    );
                                  Object.entries(evt.site_plans as Record<string, LinkedSitePlan>).forEach(([siteKey, incomingPlan]) => {
                                    const prevPlan = mergedPlans[siteKey];
                                    mergedPlans[siteKey] = {
                                      ...(prevPlan || incomingPlan),
                                      ...incomingPlan,
                                      assignments: promoteIncomingAsBase
                                        ? incomingPlan.assignments
                                        : (prevPlan?.assignments || incomingPlan.assignments),
                                      alternatives: promoteIncomingAsBase
                                        ? [
                                            ...(prevPlan?.assignments ? [prevPlan.assignments] : []),
                                            ...((prevPlan?.alternatives || []) as Record<string, Record<string, string[][]>>[]),
                                          ]
                                        : [
                                            ...((prevPlan?.alternatives || []) as Record<string, Record<string, string[][]>>[]),
                                            incomingPlan.assignments,
                                          ],
                                      pulls: promoteIncomingAsBase
                                        ? (incomingPlan.pulls || {})
                                        : (prevPlan?.pulls || incomingPlan.pulls || {}),
                                      alternative_pulls: promoteIncomingAsBase
                                        ? [
                                            ...(prevPlan?.pulls ? [prevPlan.pulls] : []),
                                            ...((prevPlan?.alternative_pulls || []) as Record<string, PullEntry>[]),
                                          ]
                                        : [
                                            ...((prevPlan?.alternative_pulls || []) as Record<string, PullEntry>[]),
                                            (incomingPlan.pulls || {}),
                                          ],
                                    };
                                  });
                                  if (promoteIncomingAsBase) {
                                    streamPullPriorityPromotedRef.current = true;
                                  }
                                  const nextActiveIndex = promoteIncomingAsBase ? activeIndex + 1 : activeIndex;
                                  saveLinkedPlansToMemory(weekStart, mergedPlans, nextActiveIndex, "sse-alt-merge");
                                  const current = mergedPlans[currentSiteIdRef.current];
                                  if (current?.assignments) {
                                    applyLinkedSitePlan(current, nextActiveIndex);
                                  }
                                }
                              } else if (evt?.type === "status") {
                                if (evt?.status === "ERROR" && evt?.detail) {
                                  toast.error("יצירת תכנון נכשלה", { description: String(evt.detail) });
                                }
                                setAiLoading(false);
                                setSharedGenerationRunning(false);
                                try { await reader.cancel(); } catch {}
                                if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
                                aiTimeoutRef.current = null;
                                if (aiIdleTimeoutRef.current) clearTimeout(aiIdleTimeoutRef.current);
                                aiIdleTimeoutRef.current = null;
                                aiControllerRef.current = null;
                                registerSharedGenerationController(weekStart, null);
                                setSharedGenerationRunningState(weekStart, false);
                                stopped = true;
                                break;
                              } else if (evt?.type === "done") {
                                try { await reader.cancel(); } catch {}
                                if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
                                aiTimeoutRef.current = null;
                                if (aiIdleTimeoutRef.current) clearTimeout(aiIdleTimeoutRef.current);
                                aiIdleTimeoutRef.current = null;
                                aiControllerRef.current = null;
                                stopped = true;
                                setAiLoading(false);
                                setSharedGenerationRunning(false);
                                registerSharedGenerationController(weekStart, null);
                                setSharedGenerationRunningState(weekStart, false);
                                setAiPlan((prev) => (prev ? { ...prev, status: "DONE" } : prev));
                                toast.success("התכנון הושלם");
                                break;
                              }
                            } catch (e) {
                              void e;
                            }
                          }
                          if (stopped) break;
                        }
                        if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
                        aiTimeoutRef.current = null;
                        if (aiIdleTimeoutRef.current) clearTimeout(aiIdleTimeoutRef.current);
                        aiIdleTimeoutRef.current = null;
                        aiControllerRef.current = null;
                        return;
                      }
                      const resp = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/director/sites/${params.id}/ai-generate/stream`, {
                        method: "POST",
                        headers: {
                          Authorization: `Bearer ${localStorage.getItem("access_token")}`,
                          Accept: "text/event-stream",
                          "Content-Type": "application/json",
                        },
                        body: JSON.stringify({ 
                          num_alternatives: 500, 
                          auto_pulls_enabled: autoPullsEnabled,
                          pulls_limit: effectivePullsLimit,
                          fixed_assignments: fixed || undefined, 
                          exclude_days: effectiveExcludeDays, 
                          weekly_availability: weeklyAvailabilityForRequest
                        }),
                        signal: controller.signal,
                      });
                      if (!resp.ok || !resp.body) {
                        throw new Error(`HTTP ${resp.status}`);
                      }
                      const reader = resp.body.getReader();
                      const decoder = new TextDecoder("utf-8");
                      let buffer = "";
                      // eslint-disable-next-line no-constant-condition
                      while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        let idx;
                        while ((idx = buffer.indexOf("\n\n")) !== -1) {
                          const frame = buffer.slice(0, idx).trim();
                          buffer = buffer.slice(idx + 2);
                          if (!frame.startsWith("data:")) continue;
                          try {
                            const jsonStr = frame.replace(/^data:\s*/, "");
                            const evt = JSON.parse(jsonStr);
                            if (evt?.type === "base") {
                              if (exceedsPullsLimit(evt?.pulls)) {
                                continue;
                              }
                              setPullsByHoleKey(evt.pulls || {});
                              setPullsEditor(null);
                              setAiPlan({
                                days: evt.days,
                                shifts: evt.shifts,
                                stations: evt.stations,
                                assignments: evt.assignments,
                                alternatives: [],
                                pulls: evt.pulls || {},
                                alternativePulls: [],
                                status: "STREAMING",
                                objective: 0,
                              } as any);
                              baseAssignmentsRef.current = evt.assignments;
                              toast.success("תכנון בסיסי מוכן");
                              armIdle();
                            } else if (evt?.type === "alternative") {
                              armIdle();
                              if (exceedsPullsLimit(evt?.pulls)) {
                                continue;
                              }
                              setAiPlan((prev) => {
                                if (!prev) return prev;
                                const activeIndex = Math.max(0, Number(altIndex || 0));
                                const currentDisplayedPulls = activeIndex === 0
                                  ? (prev.pulls || {})
                                  : (((prev.alternativePulls || [])[activeIndex - 1] || {}) as Record<string, PullEntry>);
                                const previousBaseAssignments = baseAssignmentsRef.current || prev.assignments;
                                if (autoPullsEnabled) {
                                  const quality = comparePlanQuality(previousBaseAssignments, prev.pulls, evt.assignments, evt.pulls);
                                  if (quality > 0) return prev;
                                  if (quality < 0) {
                                    baseAssignmentsRef.current = evt.assignments;
                                    setAltIndex((current) => Math.max(0, Number(current || 0)) + 1);
                                    setPullsByHoleKey(currentDisplayedPulls || {});
                                    return {
                                      ...prev,
                                      assignments: prev.assignments,
                                      pulls: evt.pulls || {},
                                      alternatives: [
                                        ...((previousBaseAssignments ? [previousBaseAssignments] : []) as Record<string, Record<string, string[][]>>[]),
                                        ...((prev.alternatives || []) as Record<string, Record<string, string[][]>>[]),
                                      ],
                                      alternativePulls: [
                                        ...((prev.pulls ? [prev.pulls] : []) as Record<string, PullEntry>[]),
                                        ...((prev.alternativePulls || []) as Record<string, PullEntry>[]),
                                      ],
                                    } as any;
                                  }
                                  const duplicateBase =
                                    sameAssignmentsMap(previousBaseAssignments, evt.assignments) &&
                                    samePullsMap(prev.pulls || {}, evt.pulls || {});
                                  const duplicateAlt = ((prev.alternatives || []) as Record<string, Record<string, string[][]>>[])
                                    .some((alt, idx) =>
                                      sameAssignmentsMap(alt, evt.assignments) &&
                                      samePullsMap(((prev.alternativePulls || [])[idx] || {}) as Record<string, PullEntry>, evt.pulls || {}),
                                    );
                                  if (duplicateBase || duplicateAlt) return prev;
                                  return {
                                    ...prev,
                                    alternatives: [...((prev.alternatives || []) as Record<string, Record<string, string[][]>>[]), evt.assignments],
                                    alternativePulls: [...((prev.alternativePulls || []) as Record<string, PullEntry>[]), (evt.pulls || {})],
                                  } as any;
                                }
                                const promoteIncomingAsBase =
                                  !streamPullPriorityPromotedRef.current &&
                                  !!baseAssignmentsRef.current &&
                                  shouldPromotePullFriendlyPlan(
                                    baseAssignmentsRef.current,
                                    aiPlan?.pulls,
                                    evt.assignments,
                                    evt.pulls,
                                  );
                                const alts = Array.isArray(prev.alternatives) ? prev.alternatives : [];
                                const next = promoteIncomingAsBase
                                  ? {
                                      ...prev,
                                      assignments: prev.assignments,
                                      pulls: evt.pulls || {},
                                      alternatives: [
                                        ...(baseAssignmentsRef.current ? [baseAssignmentsRef.current] : []),
                                        ...alts,
                                      ],
                                      alternativePulls: [
                                        ...(prev.pulls ? [prev.pulls] : []),
                                        ...((prev.alternativePulls || []) as Record<string, PullEntry>[]),
                                      ],
                                    }
                                  : {
                                      ...prev,
                                      alternatives: [...alts, evt.assignments],
                                      alternativePulls: [...((prev.alternativePulls || []) as Record<string, PullEntry>[]), (evt.pulls || {})],
                                    };
                                if (promoteIncomingAsBase) {
                                  baseAssignmentsRef.current = evt.assignments;
                                  streamPullPriorityPromotedRef.current = true;
                                  setAltIndex((current) => Math.max(0, Number(current || 0)) + 1);
                                  setPullsByHoleKey(currentDisplayedPulls || {});
                                }
                                return next as any;
                              });
                            } else if (evt?.type === "status") {
                              if (evt?.status === "ERROR" && evt?.detail) {
                                toast.error("יצירת תכנון נכשלה", { description: String(evt.detail) });
                              }
                              setAiLoading(false);
                              setSharedGenerationRunning(false);
                              try { await reader.cancel(); } catch {}
                              if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
                              aiTimeoutRef.current = null;
                              if (aiIdleTimeoutRef.current) clearTimeout(aiIdleTimeoutRef.current);
                              aiIdleTimeoutRef.current = null;
                              aiControllerRef.current = null;
                              registerSharedGenerationController(weekStart, null);
                              setSharedGenerationRunningState(weekStart, false);
                              stopped = true;
                              break;
                            } else if (evt?.type === "done") {
                              try { await reader.cancel(); } catch {}
                              if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
                              aiTimeoutRef.current = null;
                              if (aiIdleTimeoutRef.current) clearTimeout(aiIdleTimeoutRef.current);
                              aiIdleTimeoutRef.current = null;
                              aiControllerRef.current = null;
                              stopped = true;
                              setAiLoading(false);
                              setSharedGenerationRunning(false);
                              registerSharedGenerationController(weekStart, null);
                              setSharedGenerationRunningState(weekStart, false);
                              setAiPlan((prev) => (prev ? { ...prev, status: "DONE" } : prev));
                              toast.success("התכנון הושלם");
                              break;
                            }
                          } catch (e) {
                            void e;
                          }
                        }
                        if (stopped) break;
                      }
                      if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
                      aiTimeoutRef.current = null;
                      if (aiIdleTimeoutRef.current) clearTimeout(aiIdleTimeoutRef.current);
                      aiIdleTimeoutRef.current = null;
                      aiControllerRef.current = null;
                    } catch (e: any) {
                      const msg = String(e?.message || e || "");
                      // Ne pas alerter si on a volontairement stoppé/annulé (AbortError)
                      if (stopped || e?.name === "AbortError" || /aborted/i.test(msg)) {
                      } else {
                        toast.error("יצירת תכנון נכשלה", { description: msg || "נסה שוב מאוחר יותר." });
                      }
                    } finally {
                      // Nettoyer les refs seulement si elles n'ont pas déjà été nettoyées
                      if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
                      if (aiIdleTimeoutRef.current) clearTimeout(aiIdleTimeoutRef.current);
                      aiControllerRef.current = null;
                      aiTimeoutRef.current = null;
                      aiIdleTimeoutRef.current = null;
                      setAiLoading(false);
                      setSharedGenerationRunning(false);
                      registerSharedGenerationController(weekStart, null);
                      setSharedGenerationRunningState(weekStart, false);
                    }
                  }}
                  className={
                    "inline-flex items-center rounded-md px-6 py-2 text-white disabled:opacity-60 " +
                    ((isSavedMode && !editingSaved)
                      ? "bg-zinc-300 cursor-not-allowed dark:bg-zinc-700"
                      : "bg-[#00A8E0] hover:bg-[#0092c6]")
                  }
                  disabled={(isSavedMode && !editingSaved) || isAnyGenerationRunning}
                >
                  {isAnyGenerationRunning ? "יוצר..." : "יצירת תכנון"}
                </button>
                {showMultiSitePullsDialog && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                    <div className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                      <div className="space-y-2 text-right">
                        <div className="text-base font-semibold">הגדרת משיכות לאתרים מקושרים</div>
                        <div className="text-sm text-zinc-600 dark:text-zinc-300">
                          בחר האם להחיל את המשיכות רק על {multiSitePullsCurrentSiteLabel} או להגדיר מגבלה נפרדת לכל אתר מקושר.
                        </div>
                      </div>
                      <div className="mt-4 space-y-3">
                        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 px-3 py-3 text-right dark:border-zinc-700">
                          <input
                            type="radio"
                            name="multi-site-pulls-mode"
                            className="mt-1"
                            checked={multiSitePullsMode === "current_only"}
                            onChange={() => setMultiSitePullsMode("current_only")}
                          />
                          <div className="flex-1">
                            <div className="text-sm font-medium">רק באתר הנוכחי</div>
                            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                              {multiSitePullsCurrentSiteLabel}: {pullsLimitSelectOptions.find((option) => option.value === (multiSitePullsLimits[String(params.id)] ?? autoPullsLimit))?.label || "ללא"}
                            </div>
                          </div>
                        </label>
                        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 px-3 py-3 text-right dark:border-zinc-700">
                          <input
                            type="radio"
                            name="multi-site-pulls-mode"
                            className="mt-1"
                            checked={multiSitePullsMode === "custom_sites"}
                            onChange={() => setMultiSitePullsMode("custom_sites")}
                          />
                          <div className="flex-1">
                            <div className="text-sm font-medium">להגדיר גם באתרים המקושרים</div>
                            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                              ברירת המחדל לכל אתר היא הערך שנבחר באתר הנוכחי, וניתן לשנות ידנית לכל אתר.
                            </div>
                          </div>
                        </label>
                      </div>
                      <div className="mt-4 max-h-[45dvh] space-y-3 overflow-y-auto rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
                        {multiSitePullsSites.map((linkedSite) => {
                          const siteKey = String(linkedSite.id);
                          const disabled = multiSitePullsMode !== "custom_sites" && linkedSite.id !== Number(params.id);
                          return (
                            <div
                              key={siteKey}
                              className={
                                "flex items-center justify-between gap-3 rounded-lg px-2 py-1 transition-opacity " +
                                (disabled ? "opacity-50" : "opacity-100")
                              }
                            >
                              <select
                                value={multiSitePullsLimits[siteKey] ?? autoPullsLimit}
                                onChange={(e) => {
                                  const nextValue = e.target.value;
                                  setMultiSitePullsLimits((prev) => ({ ...prev, [siteKey]: nextValue }));
                                }}
                                disabled={disabled}
                                className={
                                  "rounded-md border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-70 " +
                                  "border-zinc-300 bg-white dark:border-zinc-600 dark:bg-zinc-800"
                                }
                              >
                                {pullsLimitSelectOptions.map((option) => (
                                  <option key={option.value || "none"} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                              <div className="text-sm font-medium text-right">
                                {linkedSite.name}
                                {linkedSite.id === Number(params.id) ? (
                                  <span className="mr-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">(נוכחי)</span>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="mt-4 flex items-center justify-center gap-2">
                        <button
                          type="button"
                          className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          onClick={() => {
                            multiSitePullsDialogBypassRef.current = false;
                            multiSitePullsRequestRef.current = null;
                            setShowMultiSitePullsDialog(false);
                          }}
                        >
                          ביטול
                        </button>
                        <button
                          type="button"
                          className="rounded-md bg-[#00A8E0] px-3 py-1 text-sm text-white hover:bg-[#0092c6]"
                          onClick={() => {
                            const nextRequestMap = buildMultiSitePullsRequestMap(multiSitePullsMode, multiSitePullsLimits);
                            multiSitePullsRequestRef.current = nextRequestMap;
                            multiSitePullsDialogBypassRef.current = true;
                            genDialogBypassRef.current = genUseFixedRef.current ? "fixed" : "reset";
                            setShowMultiSitePullsDialog(false);
                            setTimeout(() => { try { triggerGenerateButton(); } catch {} }, 0);
                          }}
                        >
                          המשך
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {multiSitePlanActionDialog && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                    <div className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                      <div className="space-y-2 text-right">
                        <div className="text-base font-semibold">{multiSiteActionLabelByType[multiSitePlanActionDialog.action]} באתרים מקושרים</div>
                        <div className="text-sm text-zinc-600 dark:text-zinc-300">
                          האם לבצע את הפעולה רק עבור {multiSitePullsCurrentSiteLabel} או עבור כל האתרים המקושרים?
                        </div>
                        {multiSiteOtherSitesLabel ? (
                          <div className="text-xs text-zinc-500 dark:text-zinc-400">
                            אתרים מקושרים נוספים: {multiSiteOtherSitesLabel}
                          </div>
                        ) : null}
                      </div>
                      <div className="mt-4 space-y-3">
                        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 px-3 py-3 text-right dark:border-zinc-700">
                          <input
                            type="radio"
                            name="multi-site-plan-action-scope"
                            className="mt-1"
                            checked={multiSitePlanActionDialog.scope === "current_only"}
                            onChange={() => setMultiSitePlanActionDialog((prev) => (prev ? { ...prev, scope: "current_only" } : prev))}
                          />
                          <div className="flex-1">
                            <div className="text-sm font-medium">רק באתר הנוכחי</div>
                            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{multiSitePullsCurrentSiteLabel}</div>
                          </div>
                        </label>
                        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 px-3 py-3 text-right dark:border-zinc-700">
                          <input
                            type="radio"
                            name="multi-site-plan-action-scope"
                            className="mt-1"
                            checked={multiSitePlanActionDialog.scope === "all_sites"}
                            onChange={() => setMultiSitePlanActionDialog((prev) => (prev ? { ...prev, scope: "all_sites" } : prev))}
                          />
                          <div className="flex-1">
                            <div className="text-sm font-medium">בכל האתרים המקושרים</div>
                            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                              {multiSitePullsSites.map((linkedSite) => linkedSite.name).join(", ")}
                            </div>
                          </div>
                        </label>
                      </div>
                      <div className="mt-4 flex items-center justify-center gap-2">
                        <button
                          type="button"
                          className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          onClick={() => setMultiSitePlanActionDialog(null)}
                        >
                          ביטול
                        </button>
                        <button
                          type="button"
                          className="rounded-md bg-[#00A8E0] px-3 py-1 text-sm text-white hover:bg-[#0092c6]"
                          onClick={() => {
                            const dialogState = multiSitePlanActionDialog;
                            setMultiSitePlanActionDialog(null);
                            if (!dialogState) return;
                            void runMultiSitePlanAction(dialogState.action, dialogState.scope);
                          }}
                        >
                          המשך
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {showGenDialog && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                    <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                      <div className="mb-3 text-center text-sm">
                        התכנית מכילה שיבוצים קיימים.<br/>
                        האם לשמור אותם כקבועים וליצור תכנון סביבם, או להתחיל מאפס?
                      </div>
                      <div className="flex items-center justify-center gap-2">
                        <button
                          type="button"
                          className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          onClick={() => setShowGenDialog(false)}
                        >
                          ביטול
                        </button>
                        <button
                          type="button"
                          className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          onClick={() => {
                            // Ne pas réutiliser un ancien brouillon / ref de génération précédente
                            setDraftFixedAssignmentsSnapshot(null);
                            pendingManualFixedAssignmentsRef.current = null;
                            genDialogBypassRef.current = "fixed";
                            genUseFixedRef.current = true;
                            setGenUseFixed(true);
                            if (isManual) capturePendingManualFixedAssignments();
                            setShowGenDialog(false);
                            // Ensure the generate button exists (auto mode)
                            setIsManual(false);
                            setTimeout(() => { try { triggerGenerateButton(); } catch {} }, 0);
                          }}
                        >
                          שמור כשיבוצים קבועים
                        </button>
                        <button
                          type="button"
                          className="rounded-md bg-[#00A8E0] px-3 py-1 text-sm text-white hover:bg-[#0092c6]"
                          onClick={() => {
                            setDraftFixedAssignmentsSnapshot(null);
                            genDialogBypassRef.current = "reset";
                            genUseFixedRef.current = false;
                            setGenUseFixed(false);
                            pendingManualFixedAssignmentsRef.current = null;
                            manualModeBaseAssignmentsRef.current = null;
                            setShowGenDialog(false);
                            // Vider la grille puis lancer
                            setPullsByHoleKey({});
                            setPullsEditor(null);
                            setManualAssignments(null);
                            setAiPlan(null);
                            // Ensure the generate button exists (auto mode)
                            setIsManual(false);
                            setTimeout(() => { try { triggerGenerateButton(); } catch {} }, 0);
                          }}
                        >
                          תכנון מאפס
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {showPastDaysDialog && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                    <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900 text-center">
                      <div className="mb-3 text-sm">
                        {`כבר עברו ${Array.isArray(pendingExcludeDays) ? pendingExcludeDays.length : 0} ימים בשבוע זה. להתעלם מהימים שעברו (להשאיר אותם ריקים)?`}
                      </div>
                      <div className="flex items-center justify-center gap-2">
                        <button
                          type="button"
                          className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          onClick={() => { setShowPastDaysDialog(false); /* Annuler: ne rien faire */ }}
                        >
                          ביטול
                        </button>
                        <button
                          type="button"
                          className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          onClick={() => {
                            // Non: ne pas exclure
                            // Use empty array so the generator won't re-open this dialog again
                            // null triggers the prompt; [] means "no excluded days"
                            setGenExcludeDays([]);
                            setShowPastDaysDialog(false);
                            setTimeout(() => document.getElementById('btn-generate-plan')?.dispatchEvent(new MouseEvent('click', { bubbles: true })), 0);
                          }}
                        >
                          לא
                        </button>
                        <button
                          type="button"
                          className="rounded-md bg-[#00A8E0] px-3 py-1 text-sm text-white hover:bg-[#0092c6]"
                          onClick={() => {
                            // Oui: utiliser pendingExcludeDays
                            setGenExcludeDays((pendingExcludeDays && pendingExcludeDays.length) ? pendingExcludeDays : null);
                            setShowPastDaysDialog(false);
                            setTimeout(() => document.getElementById('btn-generate-plan')?.dispatchEvent(new MouseEvent('click', { bubbles: true })), 0);
                          }}
                        >
                          כן
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {/* Mode switch dialog moved outside mode-specific blocks */}
                {/* Inline alternatives controls removed in favor of fixed bottom bar */}
              </div>
              )}
            </section>
          </div>
          {/* legacy footer controls removed; now using fixed bottom bar */}
          </>
        )}
      </div>
      {showModeSwitchDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900 text-center">
            <div className="mb-3 text-sm">
              {modeSwitchTarget === "manual"
                ? "לעבור למצב ידני. לשמור את השיבוצים הנוכחיים במקומם?"
                : "לעבור למצב אוטומטי. לשמור את השיבוצים הנוכחיים במקומם?"}
            </div>
            <div className="flex items-center justify-center gap-2">
                          <button
                            type="button"
                className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => { setShowModeSwitchDialog(false); setModeSwitchTarget(null); }}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                            onClick={() => {
                  // Keep current placements while switching
                  if (modeSwitchTarget === "auto") {
                    // Effacer tout brouillon auto (cadenas / fixed_cells d’une génération précédente) avant d’appliquer le choix
                    setDraftFixedAssignmentsSnapshot(null);
                    if (isManual && manualAssignments) {
                      capturePendingManualFixedAssignments();
                      // Preserve pulls placements when switching back to auto:
                      // ensure both before/after names exist in the target cell slots (without reordering existing slots).
                      let nextAssignments: any = JSON.parse(JSON.stringify(manualAssignments));
                      try {
                        const normName = (s: any) =>
                          String(s || "")
                            .normalize("NFKC")
                            .trim()
                            .replace(/\s+/g, " ");
                        const putIntoCell = (arrIn: any[], name: string) => {
                          const n = normName(name);
                          if (!n) return arrIn;
                          const arr = Array.isArray(arrIn) ? arrIn.map((x) => String(x ?? "")) : [];
                          const have = new Set<string>(arr.map((x) => normName(x)).filter(Boolean));
                          if (have.has(n)) return arr;
                          const emptyIdx = arr.findIndex((x) => !normName(x));
                          if (emptyIdx >= 0) arr[emptyIdx] = String(name);
                          else arr.push(String(name));
                          return arr;
                        };
                        Object.entries(pullsByHoleKey || {}).forEach(([k, entry]) => {
                          const parts = String(k).split("|");
                          if (parts.length < 3) return;
                          const dayKey = parts[0];
                          const shiftName = parts[1];
                          const stationIdx = Number(parts[2]);
                          if (!dayKey || !shiftName || !Number.isFinite(stationIdx)) return;
                          const beforeNm = String((entry as any)?.before?.name || "").trim();
                          const afterNm = String((entry as any)?.after?.name || "").trim();
                          if (!beforeNm || !afterNm) return;
                          nextAssignments[dayKey] = nextAssignments[dayKey] || {};
                          nextAssignments[dayKey][shiftName] = Array.isArray(nextAssignments[dayKey][shiftName]) ? nextAssignments[dayKey][shiftName] : [];
                          while (nextAssignments[dayKey][shiftName].length <= stationIdx) nextAssignments[dayKey][shiftName].push([]);
                          let cell = Array.isArray(nextAssignments[dayKey][shiftName][stationIdx]) ? nextAssignments[dayKey][shiftName][stationIdx] : [];
                          cell = putIntoCell(cell, beforeNm);
                          cell = putIntoCell(cell, afterNm);
                          nextAssignments[dayKey][shiftName][stationIdx] = cell;
                        });
                      } catch {}
                      const dayKeys = ["sun","mon","tue","wed","thu","fri","sat"];
                      const shiftNames = Array.from(new Set(((site?.config?.stations || []) as any[])
                        .flatMap((st: any) => (st?.shifts || []).filter((sh: any) => sh?.enabled).map((sh: any) => sh?.name))
                        .filter(Boolean)));
                      const stationNames = (site?.config?.stations || []).map((st: any, i: number) => st?.name || `עמדה ${i+1}`);
                      setAiPlan({
                        days: dayKeys,
                        shifts: shiftNames,
                        stations: stationNames,
                        assignments: nextAssignments,
                        alternatives: [],
                        status: "TEMP",
                        objective: typeof (aiPlan as any)?.objective === "number" ? (aiPlan as any).objective : 0,
                      } as any);
                      // Pas de cadenas ici : ils ne reflètent le brouillon « שיבוצים קבועים » qu’après יצירת תכנון
                    } else {
                      pendingManualFixedAssignmentsRef.current = null;
                    }
                    setIsManual(false);
                  } else if (modeSwitchTarget === "manual") {
                    try { stopAiGeneration(); } catch {}
                    pendingManualFixedAssignmentsRef.current = null;
                    if (!isManual && aiPlan?.assignments) {
                      manualModeBaseAssignmentsRef.current = JSON.parse(JSON.stringify(aiPlan.assignments));
                      // IMPORTANT: deep-clone pour éviter de partager la même référence avec aiPlan,
                      // et garantir que les משיכות déjà appliquées restent visibles en mode ידני.
                      const cloned = JSON.parse(JSON.stringify(aiPlan.assignments));
                      // IMPORTANT: s'assurer que les 2 travailleurs d'une משיכה existent bien dans la cellule,
                      // sinon l'UI en mode ידני affichera 1 nom + 1 slot vide (pullsCount > noms).
                      try {
                        const next = cloned as any;
                        Object.entries(pullsByHoleKey || {}).forEach(([k, entry]) => {
                          const parts = String(k).split("|");
                          if (parts.length < 3) return;
                          const dayKey = parts[0];
                          const shiftName = parts[1];
                          const stationIdx = Number(parts[2]);
                          if (!dayKey || !shiftName || !Number.isFinite(stationIdx)) return;
                          const beforeNm = String((entry as any)?.before?.name || "").trim();
                          const afterNm = String((entry as any)?.after?.name || "").trim();
                          if (!beforeNm || !afterNm) return;
                          next[dayKey] = next[dayKey] || {};
                          next[dayKey][shiftName] = Array.isArray(next[dayKey][shiftName]) ? next[dayKey][shiftName] : [];
                          while (next[dayKey][shiftName].length <= stationIdx) next[dayKey][shiftName].push([]);
                          const cell = Array.isArray(next[dayKey][shiftName][stationIdx]) ? next[dayKey][shiftName][stationIdx] : [];
                          let names = (cell as any[]).map((x) => String(x || "").trim()).filter(Boolean);
                          if (!names.includes(beforeNm)) names.push(beforeNm);
                          if (!names.includes(afterNm)) names.push(afterNm);
                          next[dayKey][shiftName][stationIdx] = names;
                        });
                        setManualAssignments(next);
                      } catch {
                        setManualAssignments(cloned);
                      }
                      // Repartir sans indices de rôles "stales" lors du passage en ידני
                      setManualRoleHints(null);
                    } else if (!isManual) {
                      manualModeBaseAssignmentsRef.current = null;
                    }
                    // Fermer la popup משיכות si ouverte (mais conserver pullsByHoleKey)
                    setPullsEditor(null);
                    setIsManual(true);
                  }
                  setShowModeSwitchDialog(false);
                  setModeSwitchTarget(null);
                }}
              >
                שמור מיקומים
                          </button>
                          <button
                            type="button"
                className="rounded-md bg-[#00A8E0] px-3 py-1 text-sm text-white hover:bg-[#0092c6]"
                            onClick={() => {
                  // Reset grid when switching
                  setDraftFixedAssignmentsSnapshot(null);
                  setGenUseFixed(false);
                  setPullsByHoleKey({});
                  setPullsEditor(null);
                  pendingManualFixedAssignmentsRef.current = null;
                  manualModeBaseAssignmentsRef.current = null;
                  if (modeSwitchTarget === "auto") {
                    setAiPlan(null);
                    setIsManual(false);
                  } else if (modeSwitchTarget === "manual") {
                    try { stopAiGeneration(); } catch {}
                    setManualAssignments(null);
                    setManualRoleHints(null);
                    setAiPlan(null);
                    setIsManual(true);
                  }
                  setShowModeSwitchDialog(false);
                  setModeSwitchTarget(null);
                }}
              >
                אפס גריד
                          </button>
                  </div>
              </div>
          </div>
      )}
      {(() => {
        const total = displayedAlternativeState.total;
        const currentVisibleIndex = displayedAlternativeState.currentIndex;
        const useRawNavigation = displayedAlternativeState.useRawNavigation;
        return (
          <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/70 dark:bg-zinc-900/90 dark:border-zinc-800">
            <div className="mx-auto w-full max-w-none px-3 sm:px-6 py-3 md:py-4 grid grid-cols-1 place-items-center gap-3 md:gap-4 text-sm">
              {/* Left: Mobile landscape = 2 lignes centrées */}
              <div className="flex items-center justify-center md:justify-center gap-2 md:gap-3 flex-wrap order-2 md:order-1">
                <div className="flex items-center justify-center gap-2 flex-wrap w-full md:w-auto [@media(orientation:landscape)_and_(max-width:1024px)]:flex-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:gap-1">
                {isAnyGenerationRunning && (
                <button
                  type="button"
                    onClick={() => {
                      try {
                        stopAiGeneration();
                        toast.message("יצירת התכנון הופסקה");
                      } catch {}
                    }}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-red-500/90 bg-white px-3 py-2 text-sm font-medium text-red-600 shadow-sm hover:bg-red-50 dark:border-red-500/70 dark:bg-zinc-900 dark:text-red-400 dark:hover:bg-red-950/50 [@media(orientation:landscape)_and_(max-width:1024px)]:gap-1 [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                      <path d="M6 6h12v12H6z" />
                    </svg>
                  </button>
                )}
                <div
                  className={
                    "inline-flex overflow-hidden rounded-md border disabled:opacity-60 " +
                    (isAnyGenerationRunning || (isSavedMode && !editingSaved) || isManual
                      ? "border-zinc-300 dark:border-zinc-600"
                      : "border-[#00A8E0]")
                  }
                >
                  <button
                    type="button"
                    onClick={() => {
                      try {
                        triggerGenerateButton();
                      } catch {}
                    }}
                    disabled={isAnyGenerationRunning || (isSavedMode && !editingSaved) || isManual}
                    className={
                      "inline-flex items-center gap-2 rounded-none border-0 px-4 py-2 disabled:opacity-60 [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs " +
                      (isAnyGenerationRunning || (isSavedMode && !editingSaved) || isManual
                      ? "bg-zinc-300 text-zinc-600 cursor-not-allowed dark:bg-zinc-700 dark:text-zinc-400"
                      : "bg-[#00A8E0] text-white hover:bg-[#0092c6]")
                  }
                >
                    {isAnyGenerationRunning ? (
                    <>
                      <svg className="animate-spin" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                          <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
                      </svg>
                      יוצר...
                    </>
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                          <path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z" />
                      </svg>
                      יצירת תכנון
          </>
        )}
                </button>
                  <div
                    onClick={(e) => {
                      if (isAnyGenerationRunning || isManual || (isSavedMode && !editingSaved)) return;
                      const trigger = (e.currentTarget as HTMLDivElement).querySelector('[data-pulls-picker-trigger="1"]') as HTMLButtonElement | null;
                      trigger?.click();
                    }}
                    className={
                      "flex min-w-[2rem] flex-col items-center justify-center border-l px-0.5 py-0 cursor-pointer [@media(orientation:landscape)_and_(max-width:1024px)]:min-w-[1.85rem] " +
                      (isAnyGenerationRunning || (isSavedMode && !editingSaved) || isManual
                        ? "border-zinc-400/60 bg-zinc-300 cursor-not-allowed dark:border-zinc-600 dark:bg-zinc-700"
                        : autoPullsEnabled
                          ? "border-orange-500 bg-orange-500 dark:border-orange-500 dark:bg-orange-500"
                          : "border-[#00A8E0]/80 bg-white dark:border-[#0092c6]/80 dark:bg-zinc-900")
                    }
                  >
                    <span
                      className={
                        "text-[9px] font-medium leading-none [@media(orientation:landscape)_and_(max-width:1024px)]:text-[8px] " +
                        (isAnyGenerationRunning || (isSavedMode && !editingSaved) || isManual
                          ? "text-zinc-600 dark:text-zinc-400"
                          : autoPullsEnabled
                            ? "text-white"
                            : "text-orange-600 dark:text-orange-400")
                      }
                    >
                      משיכות
                    </span>
                    <PullsLimitPicker
                      value={autoPullsLimit}
                      onChange={setAutoPullsLimit}
                      disabled={isAnyGenerationRunning || isManual || (isSavedMode && !editingSaved)}
                      className={
                        "!shadow-none w-full max-w-[3.25rem] bg-transparent py-0 text-center text-[12px] font-semibold leading-none outline-none [@media(orientation:landscape)_and_(max-width:1024px)]:max-w-[3rem] [@media(orientation:landscape)_and_(max-width:1024px)]:text-[11px] " +
                        (isAnyGenerationRunning || (isSavedMode && !editingSaved) || isManual
                          ? "text-zinc-600 placeholder:text-zinc-500 dark:text-zinc-400 dark:placeholder:text-zinc-500 disabled:opacity-100"
                          : autoPullsEnabled
                            ? "text-white placeholder:text-white/70 disabled:opacity-50"
                            : "text-orange-600 placeholder:text-orange-600/70 dark:text-orange-400 dark:placeholder:text-orange-400/70 disabled:opacity-50")
                      }
                      title="מגבלת משיכות"
                    />
                  </div>
                </div>
                {linkedSites.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setShowLinkedSitesDialog(true)}
                    className="relative inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800 [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1"
                    aria-label="מולטי אתרים"
                    title="מולטי אתרים"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                      <path d="M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h16v2H4v-2Z" />
                    </svg>
                    <span className="absolute -right-1 -top-1 min-w-4 rounded-full border border-orange-200 bg-orange-100 px-1 py-0 text-[10px] font-medium leading-4 text-orange-700 dark:border-orange-800 dark:bg-orange-950/70 dark:text-orange-300">
                      {linkedSitesTotalHoles}
                    </span>
                  </button>
                )}
                {(!isSavedMode || editingSaved) && (
            <div className="flex items-center gap-2 [@media(orientation:landscape)_and_(max-width:1024px)]:gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (!isManual) return;
                        const nonEmpty = (assignments: any): boolean => {
                          if (!assignments || typeof assignments !== "object") return false;
                          for (const dayKey of Object.keys(assignments)) {
                            const shiftsMap = (assignments as any)[dayKey];
                            if (!shiftsMap || typeof shiftsMap !== "object") continue;
                            for (const shiftName of Object.keys(shiftsMap)) {
                              const perStation = (shiftsMap as any)[shiftName];
                              if (!Array.isArray(perStation)) continue;
                              for (const cell of perStation) {
                                if (Array.isArray(cell) && cell.some((n) => n && String(n).trim().length > 0)) {
                                  return true;
                                }
                              }
                            }
                          }
                          return false;
                        };
                        if (!nonEmpty(manualAssignments)) {
                          setIsManual(false);
                          return;
                        }
                        setModeSwitchTarget("auto");
                        setShowModeSwitchDialog(true);
                      }}
                      className={
                        "inline-flex items-center gap-2 rounded-md border px-3 py-1 text-sm [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs " +
                         (isManual ? "dark:border-zinc-700" : "bg-[#00A8E0] text-white border-[#00A8E0]")
                      }
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                        <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94L14.4 2.81c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.3-.06.61-.06.94 0 .32.02.64.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
                      </svg>
                      אוטומטי
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (isManual) return;
                        const nonEmpty = (assignments: any): boolean => {
                          if (!assignments || typeof assignments !== "object") return false;
                          for (const dayKey of Object.keys(assignments)) {
                            const shiftsMap = (assignments as any)[dayKey];
                            if (!shiftsMap || typeof shiftsMap !== "object") continue;
                            for (const shiftName of Object.keys(shiftsMap)) {
                              const perStation = (shiftsMap as any)[shiftName];
                              if (!Array.isArray(perStation)) continue;
                              for (const cell of perStation) {
                                if (Array.isArray(cell) && cell.some((n) => n && String(n).trim().length > 0)) {
                                  return true;
                                }
                              }
                            }
                          }
                          return false;
                        };
                        const hasContent = !isManual
                          ? nonEmpty(aiPlan?.assignments as any)
                          : (nonEmpty(manualAssignments) || (!!savedWeekPlan?.assignments && !editingSaved && nonEmpty(savedWeekPlan.assignments as any)));
                        if (!hasContent) {
                          try { stopAiGeneration(); } catch {}
                          setIsManual(true);
                          return;
                        }
                        setModeSwitchTarget("manual");
                        setShowModeSwitchDialog(true);
                      }}
                      className={
                        "inline-flex items-center gap-2 rounded-md border px-3 py-1 text-sm [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs " +
                         (isManual ? "bg-[#00A8E0] text-white border-[#00A8E0]" : "dark:border-zinc-700")
                      }
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                        <path d="M9 11.24V7.5a2.5 2.5 0 0 1 5 0v3.74c1.21-.81 2-2.18 2-3.74C16 5.01 13.99 3 11.5 3S7 5.01 7 7.5c0 1.56.79 2.93 2 3.74zm9.84 4.63l-4.54-2.26c-.17-.07-.35-.11-.54-.11H13v-6c0-.83-.67-1.5-1.5-1.5S10 6.67 10 7.5v10.74l-3.43-.72c-.08-.01-.15-.03-.24-.03-.31 0-.59.13-.79.33l-.79.8 4.94 4.94c.27.27.65.44 1.06.44h6.79c.75 0 1.33-.55 1.44-1.28l.75-5.27c.01-.07.02-.14.02-.2 0-.62-.38-1.16-.91-1.38z"/>
                      </svg>
                      ידני
                    </button>
                  </div>
                )}
                {/* Alternatives sur la même ligne que création/auto/manuel */}
                {!isManual && aiPlan && total > 1 && (
                  <div className="flex items-center justify-center gap-2 flex-wrap [@media(orientation:landscape)_and_(max-width:1024px)]:flex-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (total <= 0) return;
                        const next = useRawNavigation
                          ? ((Math.max(0, Number(altIndex || 0)) - 1 + total) % total)
                          : (() => {
                              const pos = currentVisibleIndex >= 0 ? currentVisibleIndex : 0;
                              return filteredAiPlanIndices[(pos - 1 + total) % total];
                            })();
                        selectAiPlanIndex(next);
                      }}
                      disabled={total <= 1 || currentVisibleIndex < 0}
                      className="inline-flex items-center gap-2 rounded-md border px-3 py-1 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800 whitespace-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                        <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/>
                      </svg>
                      חלופה
                    </button>
                    <span className="min-w-14 text-center whitespace-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs">
                      {currentVisibleIndex >= 0 ? currentVisibleIndex + 1 : 0}/{total}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (total <= 0) return;
                        const next = useRawNavigation
                          ? ((Math.max(0, Number(altIndex || 0)) + 1) % total)
                          : (() => {
                              const pos = currentVisibleIndex >= 0 ? currentVisibleIndex : 0;
                              return filteredAiPlanIndices[(pos + 1) % total];
                            })();
                        selectAiPlanIndex(next);
                      }}
                      disabled={total <= 1 || currentVisibleIndex < 0}
                      className="inline-flex items-center gap-2 rounded-md border px-3 py-1 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800 whitespace-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs"
                    >
                      חלופה
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                        <path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/>
                      </svg>
                    </button>
                  </div>
                )}
                </div>
                {/* Save / Edit / Delete sous les alternatives */}
                <div className="flex items-center justify-center gap-2 flex-wrap md:flex-nowrap w-full md:w-auto [@media(orientation:landscape)_and_(max-width:1024px)]:flex-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:gap-1">
                <button
                  type="button"
                  onClick={onDeletePlan}
                disabled={!isSavedMode}
                className={
                    "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs " +
                  (isSavedMode
                    ? "bg-red-600 text-white hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600"
                    : "bg-zinc-300 text-zinc-600 cursor-not-allowed opacity-60 dark:bg-zinc-700 dark:text-zinc-400")
                }
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                  </svg>
                  מחק
                </button>
              {!editingSaved && (
                <button
                  type="button"
                  onClick={() => requestMultiSitePlanAction("edit")}
                  disabled={!isSavedMode}
                  className={
                      "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs " +
                    (isSavedMode
                      ? "bg-[#00A8E0] text-white hover:bg-[#0092c6] border border-[#00A8E0]"
                      : "bg-zinc-300 text-zinc-600 cursor-not-allowed opacity-60 dark:bg-zinc-700 dark:text-zinc-400 border border-zinc-300 dark:border-zinc-700")
                  }
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                  </svg>
                  ערוך
                </button>
              )}
                {editingSaved && (
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    className="inline-flex items-center gap-2 rounded-md bg-gray-600 px-3 py-2 text-sm text-white hover:bg-gray-700 dark:bg-gray-500 dark:hover:bg-gray-600 whitespace-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                    </svg>
                    ביטול
                </button>
              )}
                <div className="flex items-center gap-2 flex-wrap md:flex-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:flex-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:gap-1">
              <button
                type="button"
                    onClick={() => onSavePlan(false)}
                    className="inline-flex items-center gap-2 rounded-md border border-green-600 bg-white px-3 py-2 text-sm text-green-700 hover:bg-green-50 dark:border-green-500 dark:bg-zinc-900 dark:text-green-300 dark:hover:bg-green-900/30 whitespace-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/>
                </svg>
                שמור
              </button>
                <button
                  type="button"
                    onClick={() => onSavePlan(true)}
                    className="inline-flex items-center gap-2 rounded-md bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-600 whitespace-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs"
                  >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                      </svg>
                    שמור ואשלח
                </button>
                </div>
              </div>
      </div>
              {/* Middle column - now empty, can be removed or used for other content */}
              <div className="flex items-center justify-center gap-2 flex-wrap order-1 md:order-2"></div>
      </div>
          </div>
        );
      })()}

      {/* Pulls editor (משיכות) */}
      {pullsEditor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setPullsEditor(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-semibold">משיכות</div>
                    <button
                      type="button"
                className="inline-flex items-center justify-center rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => setPullsEditor(null)}
                aria-label="סגור"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                      </svg>
                    </button>
            </div>

            <div className="text-sm text-zinc-600 dark:text-zinc-300 mb-3">
              {(() => {
                const dayLabels: Record<string, string> = {
                  sun: "א'",
                  mon: "ב'",
                  tue: "ג'",
                  wed: "ד'",
                  thu: "ה'",
                  fri: "ו'",
                  sat: "ש'",
                };
                const dayLabel = dayLabels[pullsEditor.dayKey] || pullsEditor.dayKey;
                return `${dayLabel} • ${pullsEditor.shiftName} • עמדה ${pullsEditor.stationIdx + 1}`;
              })()}
            </div>
            {pullsEditor.roleName ? (
              <div className="mb-3 text-xs text-zinc-500">
                תפקיד: <span className="font-medium text-zinc-700 dark:text-zinc-200">{pullsEditor.roleName}</span>
              </div>
            ) : null}

            <div className="space-y-3">
              <div className="rounded-md border p-3 dark:border-zinc-700">
                <div className="mb-2 text-sm font-medium">{pullsEditor.beforeName}</div>
                {(pullsEditor.beforeOptions || []).length > 1 && (
                  <div className="mb-3">
                    <div className="mb-1 text-xs text-zinc-500">בחר עובד (לפני)</div>
                    <select
                      value={pullsEditor.beforeName}
                      onChange={(e) => setPullsEditor((p) => (p ? { ...p, beforeName: e.target.value } : p))}
                      size={Math.min(4, Math.max(2, (pullsEditor.beforeOptions || []).length))}
                      className="w-full rounded-md border px-2 py-1 text-sm dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-y-auto"
                    >
                      {(pullsEditor.beforeOptions || []).map((nm) => (
                        <option key={nm} value={nm}>
                          {nm}
                        </option>
                      ))}
                    </select>
      </div>
        )}
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-zinc-500">
                    התחלה
                    <TimePicker
                      value={pullsEditor.beforeStart}
                      onChange={(v) => setPullsEditor((p) => (p ? { ...p, beforeStart: v } : p))}
                      className="mt-1 h-9 w-full rounded-md border px-3 text-sm dark:border-zinc-700 bg-white dark:bg-zinc-900"
                      dir="ltr"
                    />
                  </label>
                  <label className="text-xs text-zinc-500">
                    סיום
                    <TimePicker
                      value={pullsEditor.beforeEnd}
                      onChange={(v) => setPullsEditor((p) => (p ? { ...p, beforeEnd: v } : p))}
                      className="mt-1 h-9 w-full rounded-md border px-3 text-sm dark:border-zinc-700 bg-white dark:bg-zinc-900"
                      dir="ltr"
                    />
                  </label>
      </div>
              </div>

              <div className="rounded-md border p-3 dark:border-zinc-700">
                <div className="mb-2 text-sm font-medium">{pullsEditor.afterName}</div>
                {(pullsEditor.afterOptions || []).length > 1 && (
                  <div className="mb-3">
                    <div className="mb-1 text-xs text-zinc-500">בחר עובד (אחרי)</div>
                    <select
                      value={pullsEditor.afterName}
                      onChange={(e) => setPullsEditor((p) => (p ? { ...p, afterName: e.target.value } : p))}
                      size={Math.min(4, Math.max(2, (pullsEditor.afterOptions || []).length))}
                      className="w-full rounded-md border px-2 py-1 text-sm dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-y-auto"
                    >
                      {(pullsEditor.afterOptions || []).map((nm) => (
                        <option key={nm} value={nm}>
                          {nm}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-zinc-500">
                    התחלה
                    <TimePicker
                      value={pullsEditor.afterStart}
                      onChange={(v) => setPullsEditor((p) => (p ? { ...p, afterStart: v } : p))}
                      className="mt-1 h-9 w-full rounded-md border px-3 text-sm dark:border-zinc-700 bg-white dark:bg-zinc-900"
                      dir="ltr"
                    />
                  </label>
                  <label className="text-xs text-zinc-500">
                    סיום
                    <TimePicker
                      value={pullsEditor.afterEnd}
                      onChange={(v) => setPullsEditor((p) => (p ? { ...p, afterEnd: v } : p))}
                      className="mt-1 h-9 w-full rounded-md border px-3 text-sm dark:border-zinc-700 bg-white dark:bg-zinc-900"
                      dir="ltr"
                    />
                  </label>
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    type="button"
                className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-60"
                    onClick={() => {
                  const p = pullsEditor;
                  if (!p) return;
                  const existing: any = (pullsByHoleKey as any)?.[p.key];
                  if (!existing) {
                    setPullsEditor(null);
                    return;
                  }

                  // Retirer l'entrée de pulls
                  setPullsByHoleKey((prev) => {
                    const next: any = { ...(prev || {}) };
                    delete next[p.key];
                    return next;
                  });

                  // Retirer aussi les noms de la case (si pas utilisés par d'autres משיכות de la même case)
                  const cellPrefix = `${p.dayKey}|${p.shiftName}|${p.stationIdx}|`;
                  const others: any[] = Object.entries(pullsByHoleKey || {})
                    .filter(([k]) => String(k).startsWith(cellPrefix) && String(k) !== String(p.key))
                    .map(([, e]) => e as any);
                  const keep = new Set<string>();
                  others.forEach((e) => {
                    if (e?.before?.name) keep.add(String(e.before.name).trim());
                    if (e?.after?.name) keep.add(String(e.after.name).trim());
                  });
                  const removeNames = [
                    String(existing?.before?.name || "").trim(),
                    String(existing?.after?.name || "").trim(),
                  ].filter(Boolean);

                  const baseAssignments: any = isManual ? (manualAssignments || {}) : (aiPlan?.assignments || {});
                  const existingCell: any = baseAssignments?.[p.dayKey]?.[p.shiftName]?.[p.stationIdx];
                  const curNames: string[] = Array.isArray(existingCell)
                    ? (existingCell as any[]).map((x) => String(x || "").trim()).filter(Boolean)
                    : [];
                  const nextNames = curNames.filter((nm) => !removeNames.includes(nm) || keep.has(nm));

                  const nextAssignments = JSON.parse(JSON.stringify(baseAssignments || {}));
                  nextAssignments[p.dayKey] = nextAssignments[p.dayKey] || {};
                  nextAssignments[p.dayKey][p.shiftName] = Array.isArray(nextAssignments[p.dayKey][p.shiftName]) ? nextAssignments[p.dayKey][p.shiftName] : [];
                  while (nextAssignments[p.dayKey][p.shiftName].length <= p.stationIdx) nextAssignments[p.dayKey][p.shiftName].push([]);
                  nextAssignments[p.dayKey][p.shiftName][p.stationIdx] = nextNames;
                  if (isManual) {
                    setManualAssignments(nextAssignments);
                      } else {
                    setAiPlan((prev) => (prev && prev.assignments ? { ...prev, assignments: nextAssignments } : prev));
                      }

                  setPullsEditor(null);
                    }}
                  >
                מחק
                  </button>
                  <button
                    type="button"
                className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => setPullsEditor(null)}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6]"
                    onClick={() => {
                  const p = pullsEditor;
                  if (!p) return;
                  // Valider que les horaires restent dans la plage de la garde (gère aussi les gardes qui traversent minuit)
                  const toMinutesLocal = (t: string): number | null => {
                    const m = String(t || "").trim().match(/^(\d{1,2}):(\d{2})$/);
                    if (!m) return null;
                    const hh = Number(m[1]);
                    const mm = Number(m[2]);
                    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
                    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
                    return hh * 60 + mm;
                  };
                  const s0 = toMinutesLocal(p.shiftStart);
                  const e0 = toMinutesLocal(p.shiftEnd);
                  const bS0 = toMinutesLocal(p.beforeStart);
                  const bE0 = toMinutesLocal(p.beforeEnd);
                  const aS0 = toMinutesLocal(p.afterStart);
                  const aE0 = toMinutesLocal(p.afterEnd);
                  if ([s0, e0, bS0, bE0, aS0, aE0].some((x) => x == null)) {
                    toast.error("שעות לא תקינות", { description: "פורמט השעה חייב להיות HH:MM" });
                    return;
                  }
                  const s = s0 as number;
                  let e = e0 as number;
                  const crossesMidnight = e <= s;
                  if (crossesMidnight) e += 24 * 60;
                  const abs = (m: number) => (crossesMidnight && m < s ? m + 24 * 60 : m);
                  const within = (m: number) => {
                    const am = abs(m);
                    return am >= s && am <= e;
                  };
                  const okRange = (startM: number, endM: number) => within(startM) && within(endM) && abs(startM) <= abs(endM);
                  if (!okRange(bS0 as number, bE0 as number) || !okRange(aS0 as number, aE0 as number)) {
                    toast.error("שעות לא תקינות", { description: "השעות חייבות להיות בתוך טווח המשמרת" });
                    return;
                  }
                  const maxEach = 4 * 60;
                  const durBefore = abs(bE0 as number) - abs(bS0 as number);
                  const durAfter = abs(aE0 as number) - abs(aS0 as number);
                  if (durBefore > maxEach || durAfter > maxEach) {
                    toast.error("שעות לא תקינות", { description: "מקסימום 4 שעות לכל עובד במשיכה" });
                    return;
                  }
                  // Appliquer l'assignation: on AJOUTE une paire (avant+après) sans écraser le reste,
                  // pour permettre plusieurs משיכות dans une même case (si slots vides disponibles).
                  if ((p.beforeName || "").trim() === (p.afterName || "").trim()) {
                    toast.error("שעות לא תקינות", { description: "בחר שני עובדים שונים" });
                    return;
                  }
                  // Validation rôle (si défini)
                  if (p.roleName) {
                    if (!workerHasRole(p.beforeName, p.roleName) || !workerHasRole(p.afterName, p.roleName)) {
                      toast.error("לא ניתן ליצור משיכות", { description: "שני העובדים חייבים להיות עם אותו תפקיד" });
                      return;
                    }
                  }
                  const req = Number((p as any).required || 0);
                  if (!req || req <= 0) {
                    toast.error("לא ניתן ליצור משיכות", { description: "המשמרת לא פעילה / לא נדרש" });
                    return;
                  }
                  const baseAssignments: any = isManual ? (manualAssignments || {}) : (aiPlan?.assignments || {});
                  const existingCell: any = baseAssignments?.[p.dayKey]?.[p.shiftName]?.[p.stationIdx];
                  let names: string[] = Array.isArray(existingCell) ? (existingCell as any[]).map((x) => String(x || "").trim()).filter(Boolean) : [];
                  const cellPrefix = `${p.dayKey}|${p.shiftName}|${p.stationIdx}|`;
                  const oldEntry: any = (pullsByHoleKey as any)?.[p.key] || null;
                  const othersEntries: Array<[string, any]> = Object.entries(pullsByHoleKey || {})
                    .filter(([k]) => String(k).startsWith(cellPrefix) && String(k) !== String(p.key))
                    .map(([k, e]) => [String(k), e as any]);
                  const others: any[] = othersEntries.map(([, e]) => e);
                  const usedElsewhere = (nm: string) => others.some((e) => e?.before?.name === nm || e?.after?.name === nm);
                  const pullsCountOther = othersEntries.length;
                  const pullsCountCurrent = oldEntry ? 1 : 0;
                  const pullsCountNew = oldEntry ? pullsCountOther + 1 : pullsCountOther + 1; // après save, cette clé existera
                  if (oldEntry?.before?.name || oldEntry?.after?.name) {
                    const oldBefore = String(oldEntry?.before?.name || "").trim();
                    const oldAfter = String(oldEntry?.after?.name || "").trim();
                    const keep = new Set<string>([String(p.beforeName || "").trim(), String(p.afterName || "").trim()]);
                    // Si on modifie une משיכה existante, retirer les anciens noms (si pas utilisés ailleurs)
                    if (oldBefore && !keep.has(oldBefore) && !usedElsewhere(oldBefore)) names = names.filter((x) => x !== oldBefore);
                    if (oldAfter && !keep.has(oldAfter) && !usedElsewhere(oldAfter)) names = names.filter((x) => x !== oldAfter);
                  }
                  const toAdd = [String(p.beforeName || "").trim(), String(p.afterName || "").trim()].filter(Boolean).filter((x) => !names.includes(x));
                  const nextNames = [...names, ...toAdd];
                  // Capacité: une משיכה (2 personnes) compte comme 1 place => max noms = req + pullsCount
                  const maxNamesAllowed = req + pullsCountNew;
                  if (nextNames.length > maxNamesAllowed) {
                    toast.error("לא ניתן ליצור משיכות", { description: "אין מספיק מקום בעמדה" });
                    return;
                  }
                  const nextAssignments = JSON.parse(JSON.stringify(baseAssignments || {}));
                  nextAssignments[p.dayKey] = nextAssignments[p.dayKey] || {};
                  nextAssignments[p.dayKey][p.shiftName] = Array.isArray(nextAssignments[p.dayKey][p.shiftName]) ? nextAssignments[p.dayKey][p.shiftName] : [];
                  while (nextAssignments[p.dayKey][p.shiftName].length <= p.stationIdx) nextAssignments[p.dayKey][p.shiftName].push([]);
                  nextAssignments[p.dayKey][p.shiftName][p.stationIdx] = nextNames;
                  if (isManual) {
                    setManualAssignments(nextAssignments);
                      } else {
                    setAiPlan((prev) => (prev && prev.assignments ? { ...prev, assignments: nextAssignments } : prev));
                      }
                  setPullsByHoleKey((prev) => ({
                    ...(prev || {}),
                    [p.key]: {
                      before: { name: p.beforeName, start: p.beforeStart, end: p.beforeEnd },
                      after: { name: p.afterName, start: p.afterStart, end: p.afterEnd },
                      roleName: p.roleName,
                    },
                  }));
                  setPullsEditor(null);
                }}
              >
                שמור
                  </button>
                </div>
      </div>
          </div>
      )}
      {linkedAvailabilityConfirmSites && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900 text-center">
            <div className="mb-3 text-sm">
              {`העובד משויך גם לאתרים נוספים: ${linkedAvailabilityConfirmSites.join(", ")}.`}
              <br />
              הזמינות תתעדכן אוטומטית גם באתרים המקושרים.
            </div>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => {
                  pendingLinkedAvailabilitySaveRef.current = null;
                  setLinkedAvailabilityConfirmSites(null);
                }}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-3 py-1 text-sm text-white hover:bg-[#0092c6]"
                onClick={async () => {
                  const run = pendingLinkedAvailabilitySaveRef.current;
                  pendingLinkedAvailabilitySaveRef.current = null;
                  setLinkedAvailabilityConfirmSites(null);
                  if (run) await run(true);
                }}
              >
                כן
                  </button>
                </div>
      </div>
          </div>
      )}
    </div>
  );
}



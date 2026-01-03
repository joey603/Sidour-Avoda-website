"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { fetchMe } from "@/lib/auth";
import { toast } from "sonner";
import TimePicker from "@/components/time-picker";
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

export default function PlanningPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const truncateMobile6 = (value: any) => {
    const s = String(value ?? "");
    const chars = Array.from(s);
    return chars.length > 6 ? chars.slice(0, 4).join("") + "…" : s;
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [site, setSite] = useState<any>(null);
  type WorkerAvailability = Record<string, string[]>; // key: day key (sun..sat) -> enabled shift names
  type Worker = {
    id: number;
    name: string;
    maxShifts: number;
    roles: string[];
    availability: WorkerAvailability;
    answers: Record<string, any>;
  };
  const [workers, setWorkers] = useState<Worker[]>([]);
  const workersRef = useRef<Worker[]>([]);
  useEffect(() => {
    workersRef.current = workers;
  }, [workers]);
  const [newWorkerName, setNewWorkerName] = useState("");
  const [newWorkerMax, setNewWorkerMax] = useState<number>(5);
  const [newWorkerRoles, setNewWorkerRoles] = useState<string[]>([]);
  const [newWorkerAvailability, setNewWorkerAvailability] = useState<WorkerAvailability>({
    sun: [],
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
  });
  // Snapshot de la disponibilité d'origine (celle fournie par le travailleur) au moment de l'édition
  const [originalAvailability, setOriginalAvailability] = useState<WorkerAvailability | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isCreateUserModalOpen, setIsCreateUserModalOpen] = useState(false);
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
  const [hiddenWorkerIds, setHiddenWorkerIds] = useState<number[]>([]);
  // Empêcher qu'une réponse "ancienne" (ancienne semaine) n'écrase l'état quand on navigue vite
  const loadWorkersReqIdRef = useRef(0);
  const weekStartRef = useRef<Date | null>(null);
  // Éviter de re-fetch les réponses en boucle dans le modal
  const answersRefreshKeyRef = useRef<string | null>(null);
  const [weekStart, setWeekStart] = useState<Date>(() => {
    // Calculer la semaine prochaine (identique à la page worker)
    const today = new Date();
    const currentDay = today.getDay(); // 0 = dimanche, 6 = samedi
    const daysUntilNextSunday = currentDay === 0 ? 7 : 7 - currentDay; // Si c'est dimanche, prendre le dimanche suivant
    
    const nextSunday = new Date(today);
    nextSunday.setDate(today.getDate() + daysUntilNextSunday);
    nextSunday.setHours(0, 0, 0, 0);
    
    return nextSunday;
  });
  useEffect(() => {
    weekStartRef.current = weekStart;
  }, [weekStart]);

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
  type AIPlan = {
    days: string[];
    shifts: string[];
    stations: string[];
    assignments: Record<string, Record<string, string[][]>>;
    alternatives?: Record<string, Record<string, string[][]>>[];
    status: string;
    objective: number;
  };
  const [aiPlan, setAiPlan] = useState<AIPlan | null>(null);
  const [altIndex, setAltIndex] = useState<number>(0);
  const baseAssignmentsRef = useRef<Record<string, Record<string, string[][]>> | null>(null);
  const prevAltCountRef = useRef<number>(0);
  const aiControllerRef = useRef<AbortController | null>(null);
  const aiTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const aiIdleTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Snapshot sauvegardé pour la semaine (assignations + éventuelle liste travailleurs)
  const [savedWeekPlan, setSavedWeekPlan] = useState<null | {
    assignments: Record<string, Record<string, string[][]>>,
    isManual?: boolean,
    workers?: Array<{ id: number; name: string; max_shifts?: number; roles?: string[]; availability?: Record<string, string[]>; answers?: Record<string, any> }>,
    pulls?: Record<
      string,
      {
        before: { name: string; start: string; end: string };
        after: { name: string; start: string; end: string };
        roleName?: string | null;
      }
    >
  }>(null);
  const isSavedMode = !!savedWeekPlan?.assignments;
  // Mode édition après chargement d'une grille sauvegardée
  const [editingSaved, setEditingSaved] = useState(false);

  // --- Clés de sauvegarde planning ---
  // Shared => visible côté עובדים (WorkerDashboard / History)
  // DirectorOnly => brouillon visible uniquement côté directeur
  const isoPlanKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const planKeyShared = (siteId: string | number, start: Date) => `plan_${siteId}_${isoPlanKey(start)}`;
  const planKeyDirectorOnly = (siteId: string | number, start: Date) => `plan_director_${siteId}_${isoPlanKey(start)}`;
  const [activeSavedPlanKey, setActiveSavedPlanKey] = useState<string | null>(null);

  // --- Pulls ("משיכות") ---
  type PullEntry = {
    before: { name: string; start: string; end: string };
    after: { name: string; start: string; end: string };
    roleName?: string | null; // si roles: les 2 travailleurs doivent partager ce rôle
  };
  const [pullsByHoleKey, setPullsByHoleKey] = useState<Record<string, PullEntry>>({});
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
      setMessages(Array.isArray(res) ? res : []);
    } catch {
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
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
        setMessages(Array.isArray(res) ? res : []);
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

  // Logs de debug pour l'état du bouton
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log("[BTN] aiLoading:", aiLoading);
  }, [aiLoading]);

  // Log centralisé: chaque fois que le nombre de חלופות change
  useEffect(() => {
    const count = aiPlan?.alternatives?.length || 0;
    if (count !== prevAltCountRef.current) {
      // eslint-disable-next-line no-console
      console.log("[ALT][OBS] alternatives updated", { count, status: aiPlan?.status, aiLoading });
      prevAltCountRef.current = count;
    }
  }, [aiPlan?.alternatives?.length, aiPlan?.status, aiLoading]);

  // Log quand le statut passe à DONE (fin de diffusion)
  useEffect(() => {
    if (aiPlan?.status === "DONE") {
      const count = aiPlan?.alternatives?.length || 0;
      // eslint-disable-next-line no-console
      console.log("[ALT][OBS] DONE broadcast", { count, status: aiPlan?.status });
    }
  }, [aiPlan?.status]);

  // Mode manuel (drag & drop)
  const [isManual, setIsManual] = useState(false);
  type AssignmentsMap = Record<string, Record<string, string[][]>>;
  const [manualAssignments, setManualAssignments] = useState<AssignmentsMap | null>(null);
  // Role hints per slot in manual mode (preserved from auto)
  type RoleHintsMap = Record<string, Record<string, (string | null)[][]>>;
  const [manualRoleHints, setManualRoleHints] = useState<RoleHintsMap | null>(null);
    // Mode switch confirmation dialog
    const [showModeSwitchDialog, setShowModeSwitchDialog] = useState(false);
    const [modeSwitchTarget, setModeSwitchTarget] = useState<"auto" | "manual" | null>(null);
  // Dialogue de génération (grille non vide)
  const [showGenDialog, setShowGenDialog] = useState(false);
  const [genUseFixed, setGenUseFixed] = useState(false);
  const genUseFixedRef = useRef(false);
  useEffect(() => { genUseFixedRef.current = genUseFixed; }, [genUseFixed]);
  // Bypass re-opening the generation dialog after user already chose an action
  const genDialogBypassRef = useRef<"fixed" | "reset" | null>(null);
  const [genExcludeDays, setGenExcludeDays] = useState<string[] | null>(null);
  const [showPastDaysDialog, setShowPastDaysDialog] = useState(false);
  const [pendingExcludeDays, setPendingExcludeDays] = useState<string[] | null>(null);
  // Surcouche d'affichage de זמינות ajoutée par drop manuel (mise en rouge)
  const [availabilityOverlays, setAvailabilityOverlays] = useState<Record<string, Record<string, string[]>>>({});
  // Weekly per-worker availability overrides (per week, per site). Keys by worker name.
  const [weeklyAvailability, setWeeklyAvailability] = useState<Record<string, WorkerAvailability>>({});

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
    setWeeklyAvailability(readWeeklyAvailabilityFor(weekStart));
  }
  function saveWeeklyAvailability(next: Record<string, WorkerAvailability>) {
    try {
      localStorage.setItem(weekKeyOf(weekStart), JSON.stringify(next));
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
    try {
      e.dataTransfer.setData("text/plain", workerName);
      e.dataTransfer.effectAllowed = "copy";
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
    // debug
    try { console.log("[DND] dragstart worker:", workerName); } catch {}
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
      // Remove only the dragged slot (preserve others), then compact
      base[src.dayKey][src.shiftName][src.stationIndex] = (arr as string[])
        .map((x: string, i: number) => (i === src.slotIndex ? "" : x))
        .filter(Boolean);

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
      try {
        console.log("[DND] dropIntoSlot BEFORE:", { dayKey, shiftName, stationIndex, slotIndex, workerName: trimmed });
        console.log("[DND] roleReq:", Object.entries(roleReq));
        console.log("[DND] slotMetaBefore:", slotMetaBefore.map(x => ({ idx: x.idx, nm: x.nm, assignedRole: x.assignedRole, roleHint: x.roleHint })));
        console.table(slotMetaBefore.map(x => ({ idx: x.idx, nm: x.nm, assignedRole: x.assignedRole || "—", roleHint: x.roleHint || "—" })));
      } catch {}
      const arr: string[] = Array.from(beforeArr);
      // Remove existing occurrence in this cell to avoid duplicates
      const filtered = arr.filter((x) => (x || "").trim() !== trimmed);
      // Role validation: if the slot expects a role and the worker has roles, ensure match or confirm
      const worker = workers.find((w) => (w.name || "").trim() === trimmed);
      const workerRoles: string[] = Array.isArray(worker?.roles) ? worker!.roles : [];
      const hasWorkerRoles = workerRoles.length > 0;
      const slotHintComputed: string | null = roleHints[slotIndex] || null;
      const slotExpectedRole = (expectedRoleFromUI || slotHintComputed || "").trim() || null;
      if (!prechecked && slotExpectedRole) {
        const match = workerRoles.some((r) => norm(String(r)) === norm(slotExpectedRole as string));
        if (!match) {
          try { console.log("[DND] role mismatch (computed)", { worker: trimmed, workerRoles, slotExpectedRole }); } catch {}
          const ok = typeof window !== "undefined" && window.confirm && window.confirm(`לעובד "${trimmed}" אין את התפקיד "${slotExpectedRole}" בתא זה. להקצות בכל זאת?`);
          if (!ok) {
            try { console.log("[DND] assignment cancelled by user"); } catch {}
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
      while (filtered.length <= slotIndex) filtered.push("");
      filtered[slotIndex] = trimmed;
      base[dayKey][shiftName][stationIndex] = filtered;
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
      try {
        console.log("[DND] dropIntoSlot AFTER:", { afterArr });
        console.log("[DND] slotMetaAfter:", slotMetaAfter.map(x => ({ idx: x.idx, nm: x.nm, assignedRole: x.assignedRole, roleHint: x.roleHint })));
        console.table(slotMetaAfter.map(x => ({ idx: x.idx, nm: x.nm, assignedRole: x.assignedRole || "—", roleHint: x.roleHint || "—" })));
      } catch {}
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
    try { console.log("[DND] onSlotDrop", { dayKey, shiftName, stationIndex, slotIndex, name }); } catch {}
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
          try { console.log("[DND] precheck: cancelled"); } catch {}
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
      try { console.log("[DND] container drop ignored: inside slot target"); } catch {}
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
        try { console.log("[DND] container drop ignored due to recent slot drop (exact key)", ld); } catch {}
        return;
      }
    }
    try { console.log("[DND] onCellContainerDrop", { dayKey, shiftName, stationIndex, hoverSlotKey, resolvedTargetSlot: targetSlot }); } catch {}
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
    try { console.log("[DND] onCellContainerDrop applying", { targetDay, targetShift, targetStation, targetSlot, name, expectedRole }); } catch {}
    didDropRef.current = true;
    dropIntoSlot(targetDay, targetShift, targetStation, targetSlot, name, expectedRole, true);
    setHoverSlotKey(null);
    setDraggingWorkerName(null);
  }

  // Construire un mapping nom -> couleur distincte (éviter rouge/vert), stable et réparti (golden angle)
  const nameToColor = useMemo(() => {
    const set = new Set<string>();
    // depuis la liste des workers
    for (const w of workers) {
      const nm = (w.name || "").trim();
      if (nm) set.add(nm);
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
              if (v) set.add(v);
            }
          }
        }
      }
    }
    const names = Array.from(set).sort((a, b) => a.localeCompare(b));
    const GOLDEN = 137.508;
    function shiftForbidden(h: number) {
      // éviter rouge ~[350..360)∪[0..20], vert ~[100..150]
      if (h < 20 || h >= 350) h = (h + 30) % 360;
      if (h >= 100 && h <= 150) h = (h + 40) % 360;
      return h;
    }
    const map = new Map<string, { bg: string; border: string; text: string }>();
    names.forEach((nm, i) => {
      let h = (i * GOLDEN) % 360;
      h = shiftForbidden(h);
      // alterner saturation/luminosité pour plus de séparation perceptuelle
      const L = [88, 84, 80][i % 3];
      const Sbg = [85, 80, 75][(i >> 1) % 3];
      const bg = `hsl(${h} ${Sbg}% ${L}%)`;
      const border = `hsl(${h} 60% ${Math.max(65, L - 10)}%)`;
      const text = `#1f2937`;
      map.set(nm, { bg, border, text });
    });
    return map;
  }, [workers, aiPlan]);

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

  function colorForRole(roleName: string): { border: string; text: string } {
    return roleColorMap.get(roleName) || { border: "#64748b", text: "#334155" };
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
    
    // Compatibilité ascendante : si pas de structure par semaine, vérifier si c'est l'ancien format
    if ("general" in rawAnswers || "perDay" in rawAnswers) {
      // C'est l'ancien format, mais on ne l'affiche que si c'est pour la semaine prochaine (où les workers répondent)
      const today = new Date();
      const currentDay = today.getDay();
      const daysUntilNextSunday = currentDay === 0 ? 7 : 7 - currentDay;
      const nextSunday = new Date(today);
      nextSunday.setDate(today.getDate() + daysUntilNextSunday);
      nextSunday.setHours(0, 0, 0, 0);
      
      // Si la semaine actuelle est la semaine prochaine, afficher les réponses
      if (weekStart.getTime() === nextSunday.getTime()) {
        const general = (rawAnswers.general && typeof rawAnswers.general === "object") ? rawAnswers.general : rawAnswers;
        const perDay = (rawAnswers.perDay && typeof rawAnswers.perDay === "object") ? rawAnswers.perDay : {};
        return { general, perDay };
      }
    }
    
    // Pas de réponses pour cette semaine
    return null;
  }

  useEffect(() => {
    // Debug: workers/hiddenIds
    // eslint-disable-next-line no-console
    console.log("[Planning] workers state:", workers);
  }, [workers]);
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log("[Planning] hiddenWorkerIds:", hiddenWorkerIds);
  }, [hiddenWorkerIds]);

  // Référentiels communs (utilisés par la liste et la modale)
  const dayDefs = [
    { key: "sun", label: "א'" },
    { key: "mon", label: "ב'" },
    { key: "tue", label: "ג'" },
    { key: "wed", label: "ד'" },
    { key: "thu", label: "ה'" },
    { key: "fri", label: "ו'" },
    { key: "sat", label: "ש'" },
  ];

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
      return;
    }
    const stationsCount = (site?.config?.stations || []).length || 0;
    if (stationsCount <= 0) return;
    const dayKeys = ["sun","mon","tue","wed","thu","fri","sat"];
    const base: AssignmentsMap = {} as any;
    const hintsBase: RoleHintsMap = {} as any;
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
        const fromAI = (aiPlan?.assignments as any)?.[d]?.[sn] || [];
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
  }, [isManual, site?.config?.stations, aiPlan?.assignments]);

  const allRoleNames: string[] = Array.from(
    new Set(
      (site?.config?.stations || [])
        .flatMap((st: any) => (st?.roles || []).map((r: any) => r?.name))
        .filter(Boolean)
    )
  );

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
      try {
        const data = await apiFetch(`/director/sites/${params.id}`, {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        });
        setSite(data);
      } catch (e: any) {
        // Fallback: tenter via la liste si la lecture directe 404 juste après création
        try {
          const list = await apiFetch<any[]>(`/director/sites/`, {
            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
            cache: "no-store" as any,
          });
          const found = list.find((s: any) => String(s.id) === String(params.id));
          if (found) setSite(found);
          else setError("אתר לא נמצא");
        } catch (err) {
          setError("שגיאה בטעינת אתר");
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [params.id, router]);

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
    try {
      // eslint-disable-next-line no-console
      console.log("[Planning] loadWorkers: fetching...", { reqId, weekKeyAtCall });
      const list = await apiFetch<any[]>(`/director/sites/${params.id}/workers`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        cache: "no-store" as any,
      });
      // Si l'utilisateur a déjà changé de semaine/site entre-temps, ignorer cette réponse
      if (reqId !== loadWorkersReqIdRef.current) {
        // eslint-disable-next-line no-console
        console.log("[Planning] loadWorkers: stale response ignored", { reqId, current: loadWorkersReqIdRef.current });
        return;
      }
      if (weekStartRef.current && weekStartRef.current.getTime() !== weekKeyAtCall) {
        // eslint-disable-next-line no-console
        console.log("[Planning] loadWorkers: week changed, response ignored", {
          reqId,
          weekKeyAtCall,
          weekKeyNow: weekStartRef.current.getTime(),
        });
        return;
      }
      // eslint-disable-next-line no-console
      console.log("[Planning] loadWorkers: fetched", list);
      const mapped: Worker[] = (list || []).map((w: any) => ({
        id: w.id,
        name: w.name,
        maxShifts: w.max_shifts ?? w.maxShifts ?? 0,
        roles: Array.isArray(w.roles) ? w.roles : [],
        availability: w.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
        answers: w.answers || {},
      }));

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
          setWeeklyAvailability(currentWeekly as any);
          try { localStorage.setItem(weekKeyOf(weekStart), JSON.stringify(currentWeekly)); } catch {}
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
      // eslint-disable-next-line no-console
      console.log("[Planning] loadWorkers: mapped", mapped);
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
    }
  }

  // Rafraîchir uniquement les answers depuis l'API (utile en mode plan sauvegardé/ערוך)
  async function refreshWorkersAnswersFromApi() {
    try {
      const list = await apiFetch<any[]>(`/director/sites/${params.id}/workers`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        cache: "no-store" as any,
      });
      const byId = new Map<number, any>((list || []).map((w: any) => [Number(w.id), w]));
      // Mettre à jour le state workers
      setWorkers((prev) =>
        (prev || []).map((w) => {
          const apiW = byId.get(Number(w.id));
          if (!apiW) return w;
          return { ...w, answers: apiW.answers || {} };
        }),
      );
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
      // eslint-disable-next-line no-console
      console.warn("[Planning] refreshWorkersAnswersFromApi failed", e);
    }
  }

  useEffect(() => {
    // Changement de semaine/site: réinitialiser les états temporaires (ex: masquage optimiste après suppression)
    setHiddenWorkerIds([]);
    setDeletingId(null);
    loadWorkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id, weekStart]);

  // Charger le plan sauvegardé pour la semaine sélectionnée (si existe)
  useEffect(() => {
    const start = new Date(weekStart);
    const keyDirector = planKeyDirectorOnly(params.id, start);
    const keyShared = planKeyShared(params.id, start);
    try {
      setSavedWeekPlan(null);
      setEditingSaved(false);
      setPullsByHoleKey({});
      setPullsModeStationIdx(null);
      setPullsEditor(null);
      const raw = typeof window !== "undefined" ? (localStorage.getItem(keyDirector) || localStorage.getItem(keyShared)) : null;
      if (typeof window !== "undefined") {
        try { setActiveSavedPlanKey(localStorage.getItem(keyDirector) ? keyDirector : (localStorage.getItem(keyShared) ? keyShared : null)); } catch {}
      }
      if (raw) {
        const parsed = JSON.parse(raw);
        // Charger les workers même si assignments est null (après suppression)
        if (parsed && parsed.assignments) {
          const pulls = (parsed && parsed.pulls && typeof parsed.pulls === "object") ? parsed.pulls : undefined;
          setSavedWeekPlan({ assignments: parsed.assignments, isManual: !!parsed.isManual, workers: Array.isArray(parsed.workers) ? parsed.workers : undefined, pulls });
          if (pulls && typeof pulls === "object") setPullsByHoleKey(pulls);
        } else if (parsed && Array.isArray(parsed.workers) && parsed.workers.length) {
          // Si assignments est null mais workers existe, ne pas écraser workers
          // Les workers de la semaine sauvegardée sont utilisés uniquement pour l'affichage
          // On garde tous les workers du site dans l'état workers pour permettre la réutilisation
          setAiPlan(null);
          setManualAssignments(null);
          setAltIndex(0);
          baseAssignmentsRef.current = null;
        } else {
          // Aucune grille sauvegardée trouvée pour cette date, réinitialiser les états actifs
          setAiPlan(null);
          setManualAssignments(null);
          setAltIndex(0);
          baseAssignmentsRef.current = null;
        }
      } else {
        // Aucune grille sauvegardée trouvée pour cette date, réinitialiser les états actifs
        setAiPlan(null);
        setManualAssignments(null);
        setAltIndex(0);
        baseAssignmentsRef.current = null;
      }
    } catch {
      setSavedWeekPlan(null);
      setPullsByHoleKey({});
      setPullsModeStationIdx(null);
      setPullsEditor(null);
      // En cas d'erreur, réinitialiser aussi les états actifs
      setAiPlan(null);
      setManualAssignments(null);
      setAltIndex(0);
      baseAssignmentsRef.current = null;
    }
  }, [params.id, weekStart]);

  // Synchroniser le mois du calendrier avec la semaine sélectionnée
  useEffect(() => {
    if (!isCalendarOpen) {
      setCalendarMonth(new Date(weekStart.getFullYear(), weekStart.getMonth(), 1));
    }
  }, [weekStart, isCalendarOpen]);

  function stopAiGeneration() {
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
  }

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
      // eslint-disable-next-line no-console
      console.log('[DBG] triggerGenerateButton: btn exists?', !!btn);
      if (btn) {
        // eslint-disable-next-line no-console
        console.log('[DBG] triggerGenerateButton: disabled=', btn.disabled);
        if (!btn.disabled) {
          try { 
            // eslint-disable-next-line no-console
            console.log('[DBG] triggerGenerateButton: invoking .click()');
            btn.click(); 
            return; 
          } catch (e) { 
            // eslint-disable-next-line no-console
            console.log('[DBG] triggerGenerateButton: .click() failed', e);
          }
          try { 
            // eslint-disable-next-line no-console
            console.log('[DBG] triggerGenerateButton: dispatching MouseEvent');
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); 
            return; 
          } catch (e) { 
            // eslint-disable-next-line no-console
            console.log('[DBG] triggerGenerateButton: dispatch failed', e);
          }
        }
      }
      // eslint-disable-next-line no-console
      console.log('[DBG] triggerGenerateButton: done (button missing or disabled)');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('[DBG] triggerGenerateButton: error', e);
    }
  }
  function onSavePlan(publishToWorkers: boolean) {
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
      // Range de semaine
      const start = new Date(weekStart);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      const key = publishToWorkers ? planKeyShared(params.id, start) : planKeyDirectorOnly(params.id, start);
      const payload = {
        siteId: Number(params.id),
        week: { startISO: isoPlanKey(start), endISO: isoPlanKey(end), label: `${formatHebDate(start)} — ${formatHebDate(end)}` },
        isManual: effectiveIsManual,
        assignments: effective,
        pulls: pullsByHoleKey,
        workers: (workers || []).map((w) => ({
          id: w.id,
          name: w.name,
          max_shifts: typeof (w as any).max_shifts === "number" ? (w as any).max_shifts : (w.maxShifts ?? 0),
          roles: Array.isArray(w.roles) ? w.roles : [],
          availability: w.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
          // IMPORTANT: garder un snapshot des réponses pour le mode ערוך d'un planning sauvegardé
          answers: ((w as any).answers && typeof (w as any).answers === "object") ? (w as any).answers : {},
        })),
      };
      if (typeof window !== "undefined") {
        localStorage.setItem(key, JSON.stringify(payload));
        setActiveSavedPlanKey(key);
        // Si on publie vers les עובדים, nettoyer le brouillon directeur pour éviter de recharger un ancien draft
        if (publishToWorkers) {
          try { localStorage.removeItem(planKeyDirectorOnly(params.id, start)); } catch {}
      }
      }
      // Marquer le plan comme sauvegardé (pour activer le contour vert) et sortir du mode ערוך
      setSavedWeekPlan({ assignments: payload.assignments, isManual: payload.isManual, workers: payload.workers, pulls: payload.pulls });
      setEditingSaved(false);
      toast.success(publishToWorkers ? "התכנון נשמר ונשלח" : "התכנון נשמר (למנהל בלבד)");
    } catch (e: any) {
      toast.error("שמירה נכשלה", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
    }
  }

  function onCancelEdit() {
    try {
      // Recharger le plan sauvegardé depuis localStorage
      const start = new Date(weekStart);
      const keyFallback = (() => {
        const dk = planKeyDirectorOnly(params.id, start);
        const sk = planKeyShared(params.id, start);
        try {
          if (typeof window !== "undefined" && localStorage.getItem(dk)) return dk;
        } catch {}
        return sk;
      })();
      const key = activeSavedPlanKey || keyFallback;
      const raw = typeof window !== "undefined" ? localStorage.getItem(key) : null;
      if (!raw) {
        // Pas de plan sauvegardé, réinitialiser tout
        setAiPlan(null);
        setManualAssignments(null);
        setEditingSaved(false);
        setSavedWeekPlan(null);
        loadWorkers();
        return;
      }
      const parsed = JSON.parse(raw);
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
      // Restaurer le plan sauvegardé
      const assignmentsAny: any = parsed.assignments;
      const dayKeys = ["sun","mon","tue","wed","thu","fri","sat"];
      const shiftNames = Array.from(
        new Set(
          (site?.config?.stations || [])
            .flatMap((st: any) => (st?.shifts || []).filter((sh: any) => sh?.enabled).map((sh: any) => sh?.name))
            .filter(Boolean)
        )
      );
      const stationNames = (site?.config?.stations || []).map((st: any, i: number) => st?.name || `עמדה ${i+1}`);
      if (parsed.isManual) {
        setIsManual(true);
        setManualAssignments(assignmentsAny as any);
      } else {
        setIsManual(false);
        const newPlan = {
          days: dayKeys,
          shifts: shiftNames,
          stations: stationNames,
          assignments: assignmentsAny,
          alternatives: [],
          status: "SAVED",
          objective: typeof (parsed as any)?.objective === "number" ? (parsed as any).objective : 0,
        } as any;
        setAiPlan(newPlan);
      }
      if (Array.isArray(parsed.workers) && parsed.workers.length) {
        const mapped = (parsed.workers as any[]).map((w: any) => ({
          id: w.id,
          name: String(w.name),
          maxShifts: w.max_shifts ?? w.maxShifts ?? 0,
          roles: Array.isArray(w.roles) ? w.roles : [],
          availability: w.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
          answers: w.answers || {},
        }));
        setWorkers(mapped);
      } else {
        loadWorkers();
      }
      // Restaurer savedWeekPlan et sortir du mode ערוך
      setSavedWeekPlan({ assignments: parsed.assignments, isManual: !!parsed.isManual, workers: Array.isArray(parsed.workers) ? parsed.workers : undefined, pulls });
      setPullsByHoleKey(pulls || {});
      setEditingSaved(false);
      toast.success("השינויים בוטלו");
    } catch (e: any) {
      toast.error("ביטול נכשל", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
    }
  }

  function onDeletePlan() {
    try {
      if (!savedWeekPlan?.assignments) {
        toast.error("אין מה למחוק", { description: "לא נמצא תכנון לשמירה למחיקה" });
        return;
      }
      const confirmed = window.confirm("האם אתה בטוח שברצונך למחוק את התכנון השבועי? זה ימחק את כל השיבוצים אך ישמור את רשימת העובדים והזמינות שלהם.");
      if (!confirmed) return;
      const start = new Date(weekStart);
      const keyShared = planKeyShared(params.id, start);
      const keyDirector = planKeyDirectorOnly(params.id, start);
      // Charger les données actuelles pour garder les workers
      const raw = typeof window !== "undefined" ? (localStorage.getItem(keyShared) || localStorage.getItem(keyDirector)) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        // Garder les workers, supprimer les assignments
        const payload = {
          siteId: parsed.siteId,
          week: parsed.week,
          isManual: false,
          assignments: null,
          pulls: {},
          workers: parsed.workers || [],
        };
        if (typeof window !== "undefined") {
          localStorage.setItem(keyShared, JSON.stringify(payload));
          try { localStorage.removeItem(keyDirector); } catch {}
          setActiveSavedPlanKey(keyShared);
        }
      } else {
        // Si aucune donnée n'existe, supprimer complètement
        if (typeof window !== "undefined") {
          localStorage.removeItem(keyShared);
          try { localStorage.removeItem(keyDirector); } catch {}
          setActiveSavedPlanKey(null);
        }
      }
      // Réinitialiser les états
      setSavedWeekPlan(null);
      setEditingSaved(false);
      setAiPlan(null);
      setManualAssignments(null);
      setPullsByHoleKey({});
      setPullsModeStationIdx(null);
      setPullsEditor(null);
      toast.success("התכנון נמחק בהצלחה");
    } catch (e: any) {
      toast.error("מחיקה נכשלה", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
    }
  }

  return (
    <div className="min-h-screen px-3 sm:px-4 lg:px-4 py-6 pb-24">
      <div
        className={
          "mx-auto w-full max-w-none space-y-6 rounded-xl " +
          (editingSaved
            ? "ring-2 ring-[#00A8E0] ring-offset-4 ring-offset-white dark:ring-offset-zinc-950"
            : (isSavedMode
              ? "ring-2 ring-green-500 ring-offset-4 ring-offset-white dark:ring-offset-zinc-950"
              : ""))
        }
      >
        <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">יצירת תכנון משמרות</h1>
          <button
            type="button"
            onClick={() => router.back()}
            className="inline-flex items-center justify-center rounded-md border px-3 py-2 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            aria-label="חזור"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
          </button>
        </div>
        {loading ? (
          <p>טוען...</p>
        ) : error ? (
          <p className="text-red-600">{error}</p>
        ) : (
          <>
          <div className="w-full rounded-2xl border p-4 dark:border-zinc-800 space-y-6">
            <div className="mb-2 relative">
              <div className="text-sm text-zinc-500">אתר</div>
              <div className="text-lg font-medium">{site?.name}</div>
              <button
                type="button"
                onClick={() => router.push(`/director/sites/${site?.id}/edit`)}
                className="absolute top-0 left-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75Z"/></svg>
                עדכן הגדרות
              </button>
            </div>

            {/* Tableau travailleurs */}
            <section className="space-y-3">
              <h2 className="text-lg font-semibold text-center">עובדים</h2>
              {(() => {
                const dayDefs = [
                  { key: "sun", label: "א'" },
                  { key: "mon", label: "ב'" },
                  { key: "tue", label: "ג'" },
                  { key: "wed", label: "ד'" },
                  { key: "thu", label: "ה'" },
                  { key: "fri", label: "ו'" },
                  { key: "sat", label: "ש'" },
                ];
                const allShiftNames: string[] = Array.from(
                  new Set(
                    (site?.config?.stations || [])
                      .flatMap((st: any) => (st?.shifts || [])
                        .filter((sh: any) => sh?.enabled)
                        .map((sh: any) => sh?.name))
                      .filter(Boolean)
                  )
                );
                const allRoleNames: string[] = Array.from(
                  new Set(
                    (site?.config?.stations || [])
                      .flatMap((st: any) => (st?.roles || []).map((r: any) => r?.name))
                      .filter(Boolean)
                  )
                );

                function toggleNewAvailability(dayKey: string, shift: string) {
                  setNewWorkerAvailability((prev) => {
                    const cur = prev[dayKey] || [];
                    return {
                      ...prev,
                      [dayKey]: cur.includes(shift)
                        ? cur.filter((s) => s !== shift)
                        : [...cur, shift],
                    };
                  });
                }

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
                      <div className="overflow-x-hidden md:overflow-x-auto">
                        <table className="w-full table-fixed border-collapse text-[10px] md:text-sm">
                          <thead>
                            <tr className="border-b dark:border-zinc-800">
                              <th className="px-1 md:px-3 py-1 md:py-2 text-center w-20 md:w-40 text-[10px] md:text-sm">שם</th>
                              <th className="px-0.5 md:px-3 py-1 md:py-2 text-center w-12 md:w-auto text-[10px] md:text-sm">מקס'</th>
                              <th className="px-0.5 md:px-3 py-1 md:py-2 text-center w-16 md:w-auto text-[10px] md:text-sm">תפקידים</th>
                              <th className="px-0.5 md:px-3 py-1 md:py-2 text-center w-20 md:w-auto text-[10px] md:text-sm">זמינות</th>
                              {/* Actions: cachées sur mobile (cliquer la ligne ouvre עריכת עובד) */}
                              <th className="hidden md:table-cell px-1 md:px-3 py-1 md:py-2 w-16 md:w-auto"></th>
                            </tr>
                          </thead>
                          <tbody>
                          {(() => {
                            // IMPORTANT: en mode ערוך, `weeklyAvailability` peut être stale.
                            // Toujours lire les overrides depuis le localStorage pour la semaine affichée.
                            const currentWeekly = readWeeklyAvailabilityFor(weekStart);
                            const displayWorkers: Worker[] = (savedWeekPlan?.workers || []).length
                              ? (savedWeekPlan!.workers as any[]).map((rw: any) => {
                                  // Pour la semaine prochaine, utiliser la base (snapshot) OU weeklyAvailability
                                  // Pour les autres semaines, afficher uniquement weeklyAvailability (sinon vide)
                                  const isNextWeekDisplay = isNextWeek(weekStart);
                                  // Utiliser les זמינות sauvegardées comme base (snapshot)
                                  const baseAvail = (rw.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] }) as Record<string, string[]>;
                                  // weeklyAvailability sert d'override pour cette semaine
                                  const weekOverride = (currentWeekly[rw.name] || {}) as Record<string, string[]>;
                                  const daysK = ["sun","mon","tue","wed","thu","fri","sat"] as const;
                                  const merged: Record<string, string[]> = {} as any;
                                  daysK.forEach((dk) => {
                                    // Si un override existe pour ce jour, l'utiliser (même si vide => modification explicite)
                                    if (Object.prototype.hasOwnProperty.call(weekOverride, dk) && Array.isArray(weekOverride[dk])) {
                                      merged[dk] = weekOverride[dk] as any;
                                    } else if (isNextWeekDisplay) {
                                      // Pour la semaine prochaine uniquement, utiliser la base
                                      merged[dk] = Array.isArray(baseAvail[dk]) ? baseAvail[dk] : [];
                                    } else {
                                      // Pour les autres semaines, ne pas afficher la base
                                      merged[dk] = [];
                                    }
                                  });
                                  // Utiliser le maxShifts de l'état workers (mis à jour toutes les 10 secondes) au lieu de celui sauvegardé
                                  const currentWorker = workers.find((w) => Number(w.id) === Number(rw.id));
                                  const currentMaxShifts = currentWorker?.maxShifts ?? rw.max_shifts ?? rw.maxShifts ?? 0;
                                  return ({
                                  id: rw.id,
                                  name: currentWorker?.name || rw.name,
                                  maxShifts: currentMaxShifts,
                                  roles: Array.isArray(rw.roles) ? rw.roles : [],
                                    availability: merged,
                                    answers: currentWorker?.answers || rw.answers || {},
                                  });
                                })
                              : workers.map((bw) => {
                                  // Pour la semaine prochaine, utiliser les זמינות de la base de données OU weeklyAvailability
                                  // Pour les autres semaines, utiliser uniquement weeklyAvailability (pas les זמינות de la base de données)
                                  const isNextWeekDisplay = isNextWeek(weekStart);
                                  const baseAvail = (bw.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] }) as Record<string, string[]>;
                                  const weekOverride = (currentWeekly[bw.name] || {}) as Record<string, string[]>;
                                  const daysK = ["sun","mon","tue","wed","thu","fri","sat"] as const;
                                  const merged: Record<string, string[]> = {} as any;
                                  daysK.forEach((dk) => {
                                    // Si un override existe pour ce jour, l'utiliser
                                    if (Object.prototype.hasOwnProperty.call(weekOverride, dk) && Array.isArray(weekOverride[dk])) {
                                      merged[dk] = weekOverride[dk] as any;
                                    } else if (isNextWeekDisplay) {
                                      // Pour la semaine prochaine uniquement, utiliser les זמינות de la base de données
                                      merged[dk] = Array.isArray(baseAvail[dk]) ? baseAvail[dk] : [];
                                    } else {
                                      // Pour les autres semaines, ne pas utiliser les זמינות de la base de données
                                      merged[dk] = [];
                                    }
                                  });
                                  return {
                                    ...bw,
                                    availability: merged,
                                  };
                                });
                            const rows = displayWorkers.filter((w) => !hiddenWorkerIds.includes(w.id));
                            if (rows.length === 0) {
                              return (
                                <tr>
                                  <td colSpan={5} className="px-3 py-6 text-center text-zinc-500">אין עובדים</td>
                                </tr>
                              );
                            }
                            return rows.map((w) => (
                              <tr
                                key={w.id}
                                className="border-b last:border-0 dark:border-zinc-800 cursor-pointer md:cursor-default hover:bg-zinc-50 dark:hover:bg-zinc-800 md:hover:bg-transparent md:dark:hover:bg-transparent"
                                onClick={() => {
                                  // Sur mobile: pas de colonne d'actions → cliquer la ligne ouvre עריכת עובד
                                  if (typeof window !== "undefined" && window.innerWidth < 768) {
                                    setEditingWorkerId(w.id);
                                    // eslint-disable-next-line no-console
                                    console.log("[Planning] edit worker (row click)", w);
                                    setNewWorkerName(w.name);
                                    setNewWorkerMax(w.maxShifts);
                                    setNewWorkerRoles([...w.roles]);
                                    const wa = (weeklyAvailability[w.name] || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });
                                    setOriginalAvailability({ ...wa });
                                    setNewWorkerAvailability({ ...wa });
                                    setIsAddModalOpen(true);
                                    void refreshWorkersAnswersFromApi();
                                  }
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
                                </td>
                                <td className="px-0.5 md:px-3 py-1 md:py-2 text-center text-[10px] md:text-sm">{w.maxShifts}</td>
                                <td className="px-0.5 md:px-3 py-1 md:py-2 text-center text-[10px] md:text-sm break-words whitespace-normal">
                                  {w.roles.join(",") || "—"}
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
                                {/* Actions: desktop uniquement */}
                                <td className="hidden md:table-cell px-1 md:px-3 py-1 md:py-2 text-left">
                                  <div className="flex flex-col md:flex-row items-center md:items-center gap-0.5 md:gap-2">
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setEditingWorkerId(w.id);
                                        // eslint-disable-next-line no-console
                                        console.log("[Planning] edit worker", w);
                                        setNewWorkerName(w.name);
                                        setNewWorkerMax(w.maxShifts);
                                        setNewWorkerRoles([...w.roles]);
                                        // Preload weekly availability (or empty) for this worker for this week only
                                        const wa = (weeklyAvailability[w.name] || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });
                                      setOriginalAvailability({ ...wa });
                                        setNewWorkerAvailability({ ...wa });
                                        setIsAddModalOpen(true);
                                        // S'assurer d'avoir les réponses à jour dans le modal
                                        void refreshWorkersAnswersFromApi();
                                      }}
                                      disabled={isSavedMode && !editingSaved}
                                      className={
                                        "inline-flex items-center gap-0.5 md:gap-1 rounded-md border px-1 md:px-2 py-0.5 md:py-1 text-[10px] md:text-xs " +
                                        ((isSavedMode && !editingSaved) ? "border-zinc-200 text-zinc-400 cursor-not-allowed opacity-60 dark:border-zinc-700 dark:text-zinc-600" : "hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800")
                                      }
                                    >
                                      <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" aria-hidden className="md:w-3 md:h-3"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75Z"/></svg>
                                      <span className="hidden md:inline">ערוך</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        // eslint-disable-next-line no-console
                                        console.log("[Planning] delete click worker", w.id, w.name);
                                        if (!confirm(`למחוק את ${w.name}?`)) return;
                                        setDeletingId(w.id);
                                        setHiddenWorkerIds((prev) => (prev.includes(w.id) ? prev : [...prev, w.id]));
                                        const previousWorkers = workers;
                                        // Retrait immédiat (optimiste)
                                        setWorkers((prev) => prev.filter((x) => x.id !== w.id));
                                        try {
                                          // eslint-disable-next-line no-console
                                          console.log("[Planning] DELETE /workers/", w.id);
                                          await apiFetch(`/director/sites/${params.id}/workers/${w.id}`, {
                                            method: "DELETE",
                                            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                                          });
                                          toast.success("העובד נמחק בהצלחה");
                                          // Rechargement avec retries pour éviter la réapparition (latence DB)
                                          for (let i = 0; i < 3; i++) {
                                            try {
                                              // eslint-disable-next-line no-console
                                              console.log(`[Planning] reload workers attempt ${i + 1}`);
                                              const list = await apiFetch<any[]>(`/director/sites/${params.id}/workers`, {
                                                headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                                                cache: "no-store" as any,
                                              });
                                              // eslint-disable-next-line no-console
                                              console.log("[Planning] reloaded list:", list);
                                              const contains = (list || []).some((it: any) => Number(it?.id) === Number(w.id));
                                              // eslint-disable-next-line no-console
                                              console.log("[Planning] contains deleted?", contains);
                                              if (!contains) {
                                                const mapped: Worker[] = (list || []).map((rw: any) => ({
                                                  id: rw.id,
                                                  name: rw.name,
                                                  maxShifts: rw.max_shifts ?? rw.maxShifts ?? 0,
                                                  roles: Array.isArray(rw.roles) ? rw.roles : [],
                                                  availability: rw.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
                                                  answers: rw.answers || {},
                                                }));
                                                setWorkers(mapped);
                                                setHiddenWorkerIds((prev) => prev.filter((id) => id !== w.id));
                                                break;
                                              }
                                              await new Promise((r) => setTimeout(r, 250));
                                            } catch {}
                                          }
                                          // Si, malgré tout, le backend renvoie encore l'élément, on le masque côté UI
                                          setHiddenWorkerIds((prev) => prev.filter((id) => id !== w.id));
                                        } catch (e: any) {
                                          // eslint-disable-next-line no-console
                                          console.log("[Planning] DELETE failed", e);
                                          // Vérifier l'état réel côté serveur: si l'élément n'existe plus, considérer la suppression comme réussie
                                          try {
                                            const list = await apiFetch<any[]>(`/director/sites/${params.id}/workers`, {
                                              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                                              cache: "no-store" as any,
                                            });
                                            const stillThere = (list || []).some((it: any) => Number(it?.id) === Number(w.id));
                                            // eslint-disable-next-line no-console
                                            console.log("[Planning] verify after failed DELETE, stillThere=", stillThere);
                                            if (!stillThere) {
                                              toast.success("העובד נמחק בהצלחה");
                                              setHiddenWorkerIds((prev) => prev.filter((id) => id !== w.id));
                                              return;
                                            }
                                          } catch (verifyErr) {
                                            // eslint-disable-next-line no-console
                                            console.log("[Planning] verify after delete error failed", verifyErr);
                                          }
                                          // Rollback si réellement non supprimé
                                          setWorkers(previousWorkers);
                                          toast.error("שגיאה במחיקה", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
                                        } finally {
                                          // eslint-disable-next-line no-console
                                          console.log("[Planning] delete done", w.id);
                                          setDeletingId(null);
                                        }
                                      }}
                                      disabled={(isSavedMode && !editingSaved) || deletingId === w.id}
                                      className={
                                        "inline-flex items-center gap-0.5 md:gap-1 rounded-md border px-1 md:px-2 py-0.5 md:py-1 text-[10px] md:text-xs " +
                                        (((isSavedMode && !editingSaved) || deletingId === w.id)
                                          ? "border-zinc-200 text-zinc-400 cursor-not-allowed opacity-60 dark:border-zinc-700 dark:text-zinc-600"
                                          : "border-red-600 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/40")
                                      }
                                    >
                                      <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" aria-hidden className="md:w-3 md:h-3"><path d="M6 7h12v2H6Zm2 4h8l-1 9H9ZM9 4h6v2H9Z"/></svg>
                                      <span className="hidden md:inline">מחק</span>
                                    </button>
                                  </div>
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
                        onChange={(e) => setNewWorkerPhone(e.target.value)}
                        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                        placeholder="הזן מספר טלפון"
                      />
                    </div>
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
                        const trimmedPhone = newWorkerPhone.trim();
                        if (!trimmedName || !trimmedPhone) {
                          toast.error("נא למלא את כל השדות");
                          return;
                        }
                        let userCreated = false;
                        try {
                          // Si un worker avec ce téléphone existe déjà sur ce site, ne rien faire
                          try {
                            const existingWorkers = await apiFetch<any[]>(`/director/sites/${params.id}/workers`, {
                              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                              cache: "no-store" as any,
                            });
                            const normalizePhone = (p: any) => String(p || "").replace(/\s+/g, "").trim();
                            const phoneN = normalizePhone(trimmedPhone);
                            const alreadyOnSite = (existingWorkers || []).some((w: any) => normalizePhone(w?.phone) === phoneN);
                            if (alreadyOnSite) {
                              toast.error("העובד כבר קיים באתר");
                              return;
                            }
                          } catch {
                            // Si on n'arrive pas à vérifier, on continue le flux normal
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
                              phone: trimmedPhone,
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
                              console.warn("[Planning] User already exists, continuing to create SiteWorker");
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
                              phone: trimmedPhone,
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
                            };
                            const idx = prev.findIndex((w) => w.id === mapped.id);
                            if (idx >= 0) return prev.map((w) => (w.id === mapped.id ? mapped : w));
                            return [...prev, mapped];
                          });

                          // Préparer la modale d'édition des זמינות pour ce nouveau worker
                          setEditingWorkerId(createdWorker.id);
                          setNewWorkerName(trimmedName);
                          setNewWorkerPhone(trimmedPhone);
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

            {/* Modal d'ajout d'employé */}
            {isAddModalOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                <div className="w-full max-w-3xl rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="relative mb-3 flex items-center justify-center">
                    <h3 className="text-lg font-semibold text-center">{editingWorkerId ? "עריכת עובד" : "הוספת עובד"}</h3>
                    <button
                      type="button"
                      onClick={() => setIsAddModalOpen(false)}
                      className="absolute right-2 top-1.5 rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-4 justify-items-center text-center">
                    <div>
                      <label className="block text-sm font-semibold">שם</label>
                      <input
                        type="text"
                        value={newWorkerName}
                        onChange={(e) => setNewWorkerName(e.target.value)}
                        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold">מקס' משמרות בשבוע</label>
                      <input
                        type="number"
                        min={0}
                        value={newWorkerMax}
                        onChange={(e) => setNewWorkerMax(Math.max(0, parseInt(e.target.value || "0", 10)))}
                        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
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
                  <div className="mt-3 text-center">
                    <div className="block text-sm font-semibold mb-1">זמינות לפי יום/משמרת</div>
                    <div className="space-y-2">
                      {(() => {
                        const morningName = allShiftNames.find((sn) => /בוקר|^0?6|06-14/i.test(sn || ""));
                        const noonName = allShiftNames.find((sn) => /צהריים|14-22|^1?4/i.test(sn || ""));
                        const nightName = allShiftNames.find((sn) => /לילה|22-06|^2?2|night/i.test(sn || ""));
                        function isAllSelected(shiftName?: string) {
                          if (!shiftName) return false;
                          return dayDefs.every((d) => (newWorkerAvailability[d.key] || []).includes(shiftName));
                        }
                        function toggleAll(shiftName?: string, checked?: boolean) {
                          if (!shiftName) return;
                          setNewWorkerAvailability((prev) => {
                            const next: WorkerAvailability = { ...prev } as any;
                            for (const d of dayDefs) {
                              const cur = new Set(next[d.key] || []);
                              if (checked) {
                                cur.add(shiftName);
                              } else {
                                cur.delete(shiftName);
                              }
                              next[d.key] = Array.from(cur);
                            }
                            return next;
                          });
                        }
                        const morningAll = isAllSelected(morningName);
                        const noonAll = isAllSelected(noonName);
                        const nightAll = isAllSelected(nightName);
                        return (
                          <div className="mb-2 flex flex-wrap items-center justify-center gap-4 text-sm">
                            <label className="inline-flex items-center gap-2 opacity-100">
                              <input
                                type="checkbox"
                                disabled={!morningName}
                                checked={!!morningName && morningAll}
                                onChange={(e) => toggleAll(morningName, e.target.checked)}
                              />
                              כל הבוקר
                            </label>
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                disabled={!noonName}
                                checked={!!noonName && noonAll}
                                onChange={(e) => toggleAll(noonName, e.target.checked)}
                              />
                              כל הצהריים
                            </label>
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                disabled={!nightName}
                                checked={!!nightName && nightAll}
                                onChange={(e) => toggleAll(nightName, e.target.checked)}
                              />
                              כל הלילה
                            </label>
                          </div>
                        );
                      })()}
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
                    const w = workers.find((x) => Number(x.id) === Number(editingWorkerId));
                    const rawAnswers = (w as any)?.answers || {};
                    
                    // Extraire les réponses de la semaine actuelle
                    const weekAnswers = getAnswersForWeek(rawAnswers, weekStart);
                    if (!weekAnswers) {
                      return (
                        <div className="mt-4 rounded-md border border-zinc-200 p-3 text-sm text-center text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                          אין תשובות לשאלות עבור השבוע הנוכחי
                        </div>
                      );
                    }
                    
                    const qs: any[] = (site?.config?.questions || []) as any[];
                    const labelById = new Map<string, string>();
                    const perDayById = new Map<string, boolean>();
                    qs.forEach((q: any) => {
                      if (q && q.id) {
                        labelById.set(String(q.id), String(q.label || q.question || q.text || q.id));
                        perDayById.set(String(q.id), !!q.perDay);
                      }
                    });

                    const answersGeneral = weekAnswers.general;
                    const answersPerDay = weekAnswers.perDay;

                    const qsOrdered: any[] = (qs || []).filter((q) => q && q.id && String(q.label || "").trim());
                    const qsGeneral = qsOrdered.filter((q) => !q.perDay);
                    const qsPerDay = qsOrdered.filter((q) => !!q.perDay);

                    const hasGeneral = qsGeneral.some((q) => {
                      const v = (answersGeneral || {})[q.id];
                      return !(v === undefined || v === null || String(v).trim() === "");
                    });
                    const hasPerDay = qsPerDay.some((q) => {
                      const per = (answersPerDay || {})[q.id] || {};
                      return dayDefs.some((d) => {
                        const v = (per as any)[d.key];
                        return !(v === undefined || v === null || String(v).trim() === "");
                      });
                    });
                    if (!hasGeneral && !hasPerDay) return null;

                    const dayKeyToDate = new Map<string, string>();
                    try {
                      dayDefs.forEach((d, idx) => {
                        const dt = addDays(weekStart, idx);
                        dayKeyToDate.set(d.key, `${d.label} (${formatHebDate(dt)})`);
                      });
                    } catch {}

                    return (
                      <div className="mt-4 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-700">
                        <div className="mb-2 font-semibold">שאלות נוספות</div>
                        <div className="space-y-2">
                          {/* Questions générales dans l'ordre de création */}
                          {qsGeneral.map((q) => {
                            const qid = String(q.id);
                            const v = (answersGeneral || {})[qid];
                            if (v === undefined || v === null || String(v).trim() === "") return null;
                            return (
                              <div key={`g_${qid}`} className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                                <div className="text-zinc-700 dark:text-zinc-200">{labelById.get(qid) || qid}</div>
                                <div className="font-medium text-zinc-900 dark:text-zinc-100">
                                  {typeof v === "boolean" ? (v ? "כן" : "לא") : String(v)}
                                </div>
                              </div>
                            );
                          })}

                          {/* Questions par jour dans l'ordre de création */}
                          {qsPerDay.map((q) => {
                            const qid = String(q.id);
                            const perObj = ((answersPerDay || {})[qid] || {}) as Record<string, any>;
                            const hasAny = dayDefs.some((d) => {
                              const v = perObj?.[d.key];
                              return !(v === undefined || v === null || String(v).trim() === "");
                            });
                            if (!hasAny) return null;
                            return (
                              <div key={`p_${qid}`} className="rounded-md border border-zinc-100 p-2 dark:border-zinc-800">
                                <div className="mb-1 font-medium text-zinc-800 dark:text-zinc-200">
                                  {labelById.get(qid) || qid}
                                </div>
                                <div className="space-y-1">
                                  {dayDefs.map((d) => {
                                    const v = perObj?.[d.key];
                                    return (
                                      <div key={`${qid}_${d.key}`} className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                                        <div className="text-zinc-600 dark:text-zinc-300">
                                          {dayKeyToDate.get(d.key) || d.key}
                                        </div>
                                        <div className="font-medium text-zinc-900 dark:text-zinc-100">
                                          {v === undefined || v === null || String(v).trim() === "" ? "—" : (typeof v === "boolean" ? (v ? "כן" : "לא") : String(v))}
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

                  <div className="mt-4 flex items-center justify-center gap-2 flex-wrap">
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
                        onClick={async () => {
                          // Revenir à la disponibilité d'origine (celle soumise par le travailleur pour la semaine prochaine)
                          const fallback = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };
                          try {
                            // Recharger les workers depuis l'API pour avoir les זמינות à jour
                            // eslint-disable-next-line no-console
                            console.log(
                              "[Planning] Restore: api base =",
                              process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000",
                              "siteId =",
                              params.id,
                              "editingWorkerId =",
                              editingWorkerId,
                              "newWorkerName =",
                              newWorkerName,
                            );
                            const freshWorkers = await apiFetch<any[]>(`/director/sites/${params.id}/workers`, {
                              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                            });
                            // eslint-disable-next-line no-console
                            console.log("[Planning] Fresh workers from API:", freshWorkers);
                            // eslint-disable-next-line no-console
                            console.log("[Planning] Fresh workers from API (json):", JSON.stringify(freshWorkers));
                            const workerFromDb = freshWorkers.find((w: any) =>
                              editingWorkerId ? Number(w.id) === Number(editingWorkerId) : w.name === newWorkerName,
                            );
                            const baseFromDb = workerFromDb?.availability || fallback;
                            // eslint-disable-next-line no-console
                            console.log("[Planning] Restore availability from DB for", newWorkerName, ":", baseFromDb);
                            setNewWorkerAvailability({ ...baseFromDb });
                            // Mettre à jour le state workers aussi
                            const mapped = freshWorkers.map((w: any) => ({
                              id: w.id,
                              name: String(w.name),
                              maxShifts: w.max_shifts ?? w.maxShifts ?? 0,
                              roles: Array.isArray(w.roles) ? w.roles : [],
                              availability: w.availability || fallback,
                              answers: w.answers || {},
                            }));
                            setWorkers(mapped);
                            toast.info("הזמינות חזרה להגדרת העובד מהמערכת");
                          } catch (err) {
                            // eslint-disable-next-line no-console
                            console.error("[Planning] Error fetching workers:", err);
                            toast.error("שגיאה בטעינת הזמינות");
                          }
                        }}
                        className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                      >
                        שחזר זמינות מהעובד
                      </button>
                    )}
                    {/* Mobile: suppression depuis la popup "עריכת עובד" (placée ליד שמור) */}
                    {editingWorkerId && (
                      <button
                        type="button"
                        className="md:hidden rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-60"
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
                        const trimmed = newWorkerName.trim();
                        if (!trimmed) return;
                        const DUP_MSG = "שם עובד כבר קיים באתר";
                        // eslint-disable-next-line no-console
                        console.log("[Workers] save clicked", { editingWorkerId, trimmed });
                        // Utiliser la même logique que displayWorkers : vérifier uniquement dans la liste de la semaine actuelle
                        const currentWeekWorkers: Worker[] = (savedWeekPlan?.workers || []).length
                          ? (savedWeekPlan!.workers as any[]).map((rw: any) => ({
                              id: rw.id,
                              name: rw.name,
                              maxShifts: rw.max_shifts ?? rw.maxShifts ?? 0,
                              roles: Array.isArray(rw.roles) ? rw.roles : [],
                              availability: rw.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
                              answers: rw.answers || {},
                            }))
                          : workers;
                        // Pré-vérification côté client pour éviter un aller-retour inutile
                        if (!editingWorkerId) {
                          // eslint-disable-next-line no-console
                          console.log("[Workers] checking duplicate (create)", { trimmed, currentWeekWorkers, allWorkers: workers });
                          // Vérifier d'abord dans la semaine actuelle - si présent, bloquer
                          if (currentWeekWorkers.some((w) => (w.name || "").trim().toLowerCase() === trimmed.toLowerCase())) {
                            // eslint-disable-next-line no-console
                            console.log("[Workers] duplicate detected in current week (create)");
                            toast.info(DUP_MSG);
                            return;
                          }
                          // Si pas dans la semaine actuelle, vérifier si existe dans tous les workers du site
                          // Si oui, on le réutilisera (autorisé)
                          // Si non, nouveau worker (autorisé aussi)
                          // eslint-disable-next-line no-console
                          console.log("[Workers] name not in current week, checking if exists in all workers");
                        } else {
                          // eslint-disable-next-line no-console
                          console.log("[Workers] checking duplicate (update)", { editingWorkerId, trimmed, currentWeekWorkers });
                          // En mode édition, vérifier les doublons dans la semaine actuelle (sauf le worker en cours d'édition)
                          if (currentWeekWorkers.some((w) => w.id !== editingWorkerId && (w.name || "").trim().toLowerCase() === trimmed.toLowerCase())) {
                            // eslint-disable-next-line no-console
                            console.log("[Workers] duplicate detected in current week (update)");
                            toast.info(DUP_MSG);
                            return;
                          }
                        }
                        try {
                          if (editingWorkerId) {
                            // eslint-disable-next-line no-console
                            console.log("[Workers] calling API (PUT)");
                            const updated = await apiFetch<any>(`/director/sites/${params.id}/workers/${editingWorkerId}`, {
                              method: "PUT",
                              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                              body: JSON.stringify({
                                name: trimmed,
                                max_shifts: newWorkerMax,
                                roles: newWorkerRoles,
                                // do not update global availability here
                              }),
                            });
                            // eslint-disable-next-line no-console
                            console.log("[Workers] API ok (PUT)", updated);
                            const mapped: Worker = {
                              id: updated.id,
                              name: updated.name,
                              maxShifts: updated.max_shifts ?? updated.maxShifts ?? 0,
                              roles: Array.isArray(updated.roles) ? updated.roles : [],
                              availability: updated.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
                              answers: updated.answers || {},
                            };
                            setWorkers((prev) => prev.map((x) => (x.id === editingWorkerId ? mapped : x)));
                            toast.success("עובד עודכן בהצלחה!");
                          } else {
                            // eslint-disable-next-line no-console
                            console.log("[Workers] calling API (POST)");
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
                            // eslint-disable-next-line no-console
                            console.log("[Workers] API ok (POST)", result);
                            const mapped: Worker = {
                              id: result.id,
                              name: result.name,
                              maxShifts: result.max_shifts ?? result.maxShifts ?? 0,
                              roles: Array.isArray(result.roles) ? result.roles : [],
                              availability: result.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
                              answers: result.answers || {},
                            };
                            // Vérifier si le worker existe déjà dans la liste (réutilisé)
                            const existingIndex = workers.findIndex((w) => w.id === result.id);
                            if (existingIndex >= 0) {
                              // Worker réutilisé - mettre à jour
                              setWorkers((prev) => prev.map((x) => (x.id === result.id ? mapped : x)));
                              toast.success("עובד עודכן בהצלחה!");
                            } else {
                              // Nouveau worker - ajouter
                            setWorkers((prev) => [...prev, mapped]);
                            toast.success("עובד נוסף בהצלחה!");
                            }
                          }
                          // Save weekly override for this specific week
                          try {
                            const key = weekKeyOf(weekStart);
                            const cur = localStorage.getItem(key);
                            const parsed = cur ? JSON.parse(cur) : {};
                            parsed[trimmed] = { ...newWorkerAvailability };
                            localStorage.setItem(key, JSON.stringify(parsed));
                            setWeeklyAvailability(parsed);
                          } catch {}
                          setEditingWorkerId(null);
                          setNewWorkerName("");
                          setNewWorkerMax(5);
                          setNewWorkerRoles([]);
                          setNewWorkerAvailability({ sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });
                          setIsAddModalOpen(false);
                        } catch (e: any) {
                          const msg = String(e?.message || "");
                          // eslint-disable-next-line no-console
                          console.log("[Workers] save error", { status: e?.status, message: msg, raw: e });
                          toast.error("שמירה נכשלה", { description: msg || "נסה שוב מאוחר יותר." });
                        }
                      }}
                      className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6]"
                    >
                      שמור
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
                                      const getWorkDays = (): Array<{ dayKey: string; station: string; shift: string; hours: string | null }> => {
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
                                              // Vérifier si le worker est dans ce tableau
                                              const hasWorker = workerArray.some((wn: any) => String(wn || "").trim() === workerNameTrimmed);
                                              if (hasWorker) {
                                                const stationConfig = stations[stationIndex];
                                                const stationName = stationConfig?.name || `עמדה ${stationIndex + 1}`;
                                                // Extraire l'horaire depuis la config ou depuis le nom du shift
                                                const hours = hoursFromConfig(stationConfig, shiftName) || hoursOf(shiftName) || shiftName;
                                                // Ajouter chaque assignation (même jour peut avoir plusieurs shifts/stations)
                                                workDays.push({ dayKey, station: stationName, shift: shiftName, hours });
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
                                                          <span key={idx} className="block text-xs text-zinc-500 dark:text-zinc-400">
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
                    setWeekStart((prev) => addDays(prev, -7));
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
                    setWeekStart((prev) => addDays(prev, 7));
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
                      setWeekStart((prev) => addDays(prev, -7));
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
                    setWeekStart((prev) => addDays(prev, 7));
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
                                setWeekStart(selectedWeekStart);
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
                            {(!!aiPlan?.assignments || !!manualAssignments) && (
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
                          </div>
                        </div>
                        {/* Sur mobile: pas de scroll horizontal, tout doit tenir */}
                        <div className="overflow-x-hidden md:overflow-x-auto">
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
                                        // Mode normal: si on est en manuel avec une grille chargée, elle prime (sinon on peut afficher l'ancien plan sauvegardé)
                                        if (isManual && manualAssignments) {
                                          const cell = (manualAssignments as any)[dayKey]?.[shiftName]?.[idx];
                                          return Array.isArray(cell) ? (cell as any[]).filter((x) => x && String(x).trim()) : [];
                                        }
                                        // Sinon: priorité au plan sauvegardé (lecture)
                                        if (savedWeekPlan?.assignments) {
                                          const savedCell = (savedWeekPlan as any).assignments?.[dayKey]?.[shiftName]?.[idx];
                                          if (Array.isArray(savedCell)) return (savedCell as any[]).filter((x) => x && String(x).trim());
                                        }
                                        if (isManual && manualAssignments) {
                                          const cell = (manualAssignments as any)[dayKey]?.[shiftName]?.[idx];
                                          return Array.isArray(cell) ? (cell as any[]).filter((x) => x && String(x).trim()) : [];
                                        }
                                        if (aiPlan?.assignments) {
                                          const cell = (aiPlan.assignments as any)[dayKey]?.[shiftName]?.[idx];
                                          return Array.isArray(cell) ? (cell as any[]).filter((x) => x && String(x).trim()) : [];
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
                                              onDragOver={isManual ? (e) => { e.preventDefault(); try { (e as any).dataTransfer.dropEffect = "copy"; } catch {} } : undefined}
                                              onDrop={isManual ? (e) => onCellContainerDrop(e, d.key, sn, idx) : undefined}
                                            >
                                              {required > 0 ? (
                                                <div className="mb-1 flex flex-col items-center gap-1 min-w-full">
                                                  {isManual ? (
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

                                                    // Priorité: si un nom provient d'une משיכה avec roleName, afficher ce rôle.
                                                    // On décrémente seulement si ce rôle est effectivement requis et encore disponible.
                                                    (assignedNames || []).forEach((nm) => {
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
                                                    (assignedNames || []).forEach((nm) => {
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

                                                        // +pullsInCell: pour afficher 2 bulles pour une seule place (משיכה)
                                                        const slots = Math.max(required + pullsInCell, assignedNames.length, roleHints.length, 1);
                                                        return Array.from({ length: slots }).map((_, slotIdx) => {
                                                          const nm = assignedNames[slotIdx];
                                                          if (nm) {
                                                            const c = colorForName(nm);
                                                            const hintedStored = ((manualRoleHints as any)?.[d.key]?.[sn]?.[idx]?.[slotIdx] ?? null) as (string | null);
                                                            const pullRn = pullRoleMap.get(String(nm || "").trim()) || null;
                                                            const hintedOk = hintedStored && nameHasRole(nm, hintedStored) ? hintedStored : null;
                                                            const rn =
                                                              hintedOk ||
                                                              (pullRn && nameHasRole(nm, pullRn) ? pullRn : null) ||
                                                              (roleForName.get(String(nm || "").trim()) || null);
                                                            const rc = rn ? colorForRole(rn) : null;
                                                            return (
                                                              <div
                                                                key={"slot-nm-wrapper-" + slotIdx}
                                                                className="group relative w-full flex justify-center py-0.5"
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
                                                                  tabIndex={0}
                                                                  className={
                                                                    "relative inline-flex min-h-6 md:min-h-9 w-full max-w-full md:max-w-[6rem] group-hover:max-w-[18rem] focus:max-w-[18rem] min-w-0 overflow-hidden items-start rounded-full border px-1 md:px-3 py-0.5 md:py-1 shadow-sm gap-1 md:gap-2 select-none group-hover:z-50 focus:z-50 focus:outline-none transition-[max-width,transform] duration-200 ease-out " +
                                                                    (hoverSlotKey === `${d.key}|${sn}|${idx}|${slotIdx}` ? "scale-110 ring-2 ring-[#00A8E0]" : "") +
                                                                    (() => {
                                                                      if (pullsModeStationIdx !== idx) return "";
                                                                      const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                                      const match = Object.entries(pullsByHoleKey || {}).find(([k, entry]) => {
                                                                        if (!k.startsWith(cellPrefix)) return false;
                                                                        const e: any = entry;
                                                                        return e?.before?.name === nm || e?.after?.name === nm;
                                                                      });
                                                                      return match ? " ring-2 ring-orange-400 cursor-pointer" : "";
                                                                    })()
                                                                  }
                                                                  style={{ backgroundColor: c.bg, borderColor: (rc?.border || c.border), color: c.text }}
                                                                  draggable
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
                                                                  <span className="flex flex-col items-center text-center flex-1 min-w-0 w-full overflow-hidden">
                                                                    {rn ? (
                                                                      <span className="block w-full min-w-0 text-[7px] md:text-[10px] font-medium text-zinc-700 dark:text-zinc-300 truncate mb-0.5">{rn}</span>
                                                                    ) : null}
                                                                    <span
                                                                      className={"block w-full min-w-0 max-w-full leading-tight " + (isRtlName(nm) ? "text-right" : "text-left")}
                                                                      dir={isRtlName(nm) ? "rtl" : "ltr"}
                                                                    >
                                                                      {/* Mobile: tronqué par défaut, complet quand focus/hover */}
                                                                      <span className="md:hidden">
                                                                        <span className="inline group-hover:hidden group-focus-within:hidden">{truncateMobile6(nm)}</span>
                                                                        <span className="hidden group-hover:inline group-focus-within:inline whitespace-nowrap">{nm}</span>
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
                                                                      setManualAssignments((prev) => {
                                                                        if (!prev) return prev;
                                                                        const base = JSON.parse(JSON.stringify(prev));
                                                                        const arr: string[] = base[d.key]?.[sn]?.[idx] || [];
                                                                        base[d.key] = base[d.key] || {};
                                                                        base[d.key][sn] = base[d.key][sn] || [];
                                                                        base[d.key][sn][idx] = (arr as string[]).map((x: string, i: number) => (i === slotIdx ? "" : x)).filter(Boolean);
                                                                        // Si l'overlay rouge a été ajouté pour ce nom/jour/shift et que c'est la dernière occurrence, le retirer aussi
                                                                        try {
                                                                          const nameTrimmed = (nm || "").trim();
                                                                          const stillThere = (base?.[d.key]?.[sn] || []).some((cell: string[]) => Array.isArray(cell) && cell.some((x) => (x || "").trim() === nameTrimmed));
                                                                          if (!stillThere) {
                                                                            setAvailabilityOverlays((prevOv) => {
                                                                              const next: any = { ...prevOv };
                                                                              if (next?.[nameTrimmed]?.[d.key]) {
                                                                                const list: string[] = Array.from(next[nameTrimmed][d.key] || []);
                                                                                const filtered = list.filter((s) => s !== sn);
                                                                                if (filtered.length > 0) {
                                                                                  next[nameTrimmed][d.key] = filtered;
                                                                                } else {
                                                                                  delete next[nameTrimmed][d.key];
                                                                                  if (Object.keys(next[nameTrimmed] || {}).length === 0) delete next[nameTrimmed];
                                                                                }
                                                                              }
                                                                              return next;
                                                                            });
                                                                          }
                                                                        } catch {}
                                                                        return base;
                                                                      });
                                                                    }}
                                                                    className="hidden md:inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs hover:bg-white/50 dark:hover:bg-zinc-800/60 flex-shrink-0"
                                                                    style={{ borderColor: (rc?.border || c.border), color: c.text }}
                                                                  >
                                                                    ×
                                                                  </button>
                                                                </span>
                                                              </div>
                                                            );
                                                          }
                                                          const hint = ((manualRoleHints as any)?.[d.key]?.[sn]?.[idx]?.[slotIdx] ?? roleHints[slotIdx] ?? null) as (string | null);
                                                          if (hint) {
                                                            const rc = colorForRole(hint);
                                                            const canPullThisRole = pullsActiveHere && isPullable && canPullForRole(hint);
                                                            return (
                                                              <div
                                                                key={"slot-hint-wrapper-" + slotIdx}
                                                                className="group w-full flex justify-center py-0.5"
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
                                                                data-rolehint={hint}
                                                              >
                                                                <span
                                                                  tabIndex={0}
                                                                  className={
                                                                    "inline-flex h-6 md:h-9 w-full max-w-full md:max-w-[6rem] group-hover:max-w-[18rem] group-focus-within:max-w-[18rem] min-w-0 overflow-hidden flex-col items-center justify-center rounded-full border px-1 md:px-3 py-0.5 md:py-1 bg-white dark:bg-zinc-900 transition-[max-width,transform] duration-200 ease-out cursor-pointer focus:outline-none focus:z-50 " +
                                                                    (hoverSlotKey === `${d.key}|${sn}|${idx}|${slotIdx}` ? "scale-110 ring-2 ring-[#00A8E0]" : "") +
                                                                    (draggingWorkerName && canHighlightDropTarget(draggingWorkerName, d.key, sn, idx, hint) ? " ring-2 ring-green-500" : "")
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
                                                          return (
                                                              <div
                                                                key={"slot-empty-wrapper-" + slotIdx}
                                                                className="group w-full flex justify-center py-0.5"
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
                                                                  key={"slot-empty-" + slotIdx}
                                                                  tabIndex={0}
                                                                  className={
                                                                    "inline-flex h-6 md:h-9 w-full max-w-full md:max-w-[6rem] group-hover:max-w-[18rem] group-focus-within:max-w-[18rem] min-w-0 overflow-hidden items-center justify-center rounded-full border px-1 md:px-3 py-0.5 md:py-1 text-[8px] md:text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700 transition-[max-width,transform] duration-200 ease-out cursor-pointer focus:outline-none focus:z-50 " +
                                                                    (hoverSlotKey === `${d.key}|${sn}|${idx}|${slotIdx}` ? "scale-110 ring-2 ring-[#00A8E0]" : "") +
                                                                    (draggingWorkerName && canHighlightDropTarget(draggingWorkerName, d.key, sn, idx, null) ? " ring-2 ring-green-500" : "")
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
                                                                  style={pullsActiveHere && isPullable ? { outline: "2px solid #fb923c", outlineOffset: "2px" } : undefined}
                                                      >
                                                        —
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
                                                            "inline-flex min-h-6 md:min-h-9 w-full max-w-full md:max-w-[6rem] min-w-0 overflow-hidden items-start rounded-full border px-1 md:px-3 py-0.5 md:py-1 shadow-sm gap-1 md:gap-2 focus:max-w-[18rem] focus:z-50 focus:outline-none " +
                                                            (() => {
                                                              if (pullsModeStationIdx !== idx) return "";
                                                              const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                              const match = Object.entries(pullsByHoleKey || {}).find(([k, entry]) => {
                                                                if (!k.startsWith(cellPrefix)) return false;
                                                                const e: any = entry;
                                                                return e?.before?.name === nm || e?.after?.name === nm;
                                                              });
                                                              return match ? " ring-2 ring-orange-400 cursor-pointer" : "";
                                                            })();
                                                          return (
                                                            <div
                                                              key={"chip-wrapper-" + i}
                                                              className="group relative w-full flex justify-center py-0.5"
                                                            >
                                                            <span
                                                              key={"nm-" + i}
                                                              className={chipClass}
                                                              style={{ backgroundColor: c.bg, borderColor: (rc?.border || c.border), color: c.text }}
                                                              tabIndex={0}
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
                                                                  className={"block w-full min-w-0 max-w-full leading-tight " + (isRtlName(nm) ? "text-right" : "text-left")}
                                                                  dir={isRtlName(nm) ? "rtl" : "ltr"}
                                                                >
                                                                  {/* Mobile: tronqué par défaut, complet quand focus/hover */}
                                                                  <span className="md:hidden">
                                                                    <span className="inline group-hover:hidden group-focus-within:hidden">{truncateMobile6(nm)}</span>
                                                                    <span className="hidden group-hover:inline group-focus-within:inline whitespace-nowrap">{nm}</span>
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

                                                            {/* Expansion animée au survol (pas de tooltip) */}
                                                            <div
                                                              aria-hidden
                                                              className="pointer-events-none absolute inset-x-0 top-0.1 z-50 flex justify-center opacity-0 scale-95 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 transition-all duration-200 ease-out"
                                                            >
                                                              <span
                                                                className={chipClass + " max-w-[6rem] group-hover:max-w-[18rem] group-focus-within:max-w-[18rem] transition-[max-width] duration-200 ease-out shadow-lg"}
                                                                style={{ backgroundColor: c.bg, borderColor: (rc?.border || c.border), color: c.text }}
                                                              >
                                                                <span className="flex flex-col items-center text-center leading-tight flex-1 min-w-0">
                                                                  {roleToShow ? (
                                                                    <span className="block w-full min-w-0 text-[7px] md:text-[10px] font-medium text-zinc-700 dark:text-zinc-300 truncate mb-0.5">{roleToShow}</span>
                                                                  ) : null}
                                                                  <span
                                                                    className={"text-[8px] md:text-sm whitespace-nowrap leading-tight " + (isRtlName(nm) ? "text-right" : "text-left")}
                                                                    dir={isRtlName(nm) ? "rtl" : "ltr"}
                                                                  >
                                                                    {nm}
                                                                  </span>
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
                                                                  className="w-full flex justify-center py-0.5"
                                                                >
                                                                  <span
                                                                    key={`roleph-${slot.roleHint}-${slotIdx}`}
                                                                    className={
                                                                      "inline-flex h-6 md:h-9 min-w-[3rem] md:min-w-[4rem] max-w-[4rem] md:max-w-[6rem] flex-col items-center justify-center rounded-full border px-1 md:px-3 py-0.5 md:py-1 bg-white dark:bg-zinc-900 cursor-pointer " +
                                                                      (canPullThisRole ? "ring-2 ring-orange-400" : "")
                                                                    }
                                                                    style={{ borderColor: c.border }}
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
                                                                  className="w-full flex justify-center py-0.5"
                                                                >
                                                                  <span
                                                                    key={"empty-" + slotIdx}
                                                                    className={
                                                                      "inline-flex h-6 md:h-9 min-w-[3rem] md:min-w-[4rem] max-w-[4rem] md:max-w-[6rem] items-center justify-center rounded-full border px-1 md:px-3 py-0.5 md:py-1 text-[8px] md:text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700 cursor-pointer " +
                                                                      (neutralIsPullable ? "ring-2 ring-orange-400" : "")
                                                                    }
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
                                                                    —
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
                                              <span
                                                className={
                                                "text-[9px] md:text-xs " + (
                                                    assignedCount < required
                                                    ? "text-red-600 dark:text-red-400"
                                                      : (required > 0 && assignedCount >= required
                                                        ? "text-green-600 dark:text-green-400"
                                                        : "")
                                                )
                                                }
                                              >
                                                {"שיבוצים: "}{assignedCount}
                                              </span>
                                              <span className="text-[9px] md:text-xs text-zinc-500">נדרש: {required}</span>
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
                        {isManual && (
                          <div className="mt-3">
                            <div className="mb-1 text-xs text-zinc-600 dark:text-zinc-300 text-center">גרור/י עובד אל תא השיבוץ</div>
                            <div className="flex flex-wrap items-center justify-center gap-2">
                              {workers.filter((w) => !hiddenWorkerIds.includes(w.id)).map((w) => {
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
                  <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">סיכום שיבוצים לעמדה (כל העמדות)</div>
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
                    return (
                      <>
                        <div className="mb-2 flex items-center justify-end gap-6 text-sm">
                          <div>סה"כ נדרש: <span className="font-medium">{totalRequired}</span></div>
                          <div>סה"כ שיבוצים: <span className="font-medium">{totalAssigned}</span></div>
                        </div>
                        <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm table-fixed">
                          <thead>
                            <tr className="border-b dark:border-zinc-800">
                              <th className="px-2 py-2 text-right w-64">עובד</th>
                              <th className="px-2 py-2 text-right w-28">מס' משמרות</th>
                            </tr>
                          </thead>
                          <tbody>
                            {items.map(([nm, c]) => {
                              const col = colorForName(nm);
                              return (
                                <tr key={nm} className="border-b last:border-0 dark:border-zinc-800">
                                  <td className="px-2 py-2 w-64">
                                    <span className="inline-flex items-center rounded-full border px-3 py-1 text-sm shadow-sm" style={{ backgroundColor: col.bg, borderColor: col.border, color: col.text }}>
                                      {nm}
                                    </span>
                                  </td>
                                  <td className="px-2 py-2 w-28">{c}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
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
                          for (const rName of Array.from(roleColorMap.keys())) {
                            if (!roleTotals.has(rName)) roleTotals.set(rName, 0);
                          }
                          // S'il n'y a aucun rôle défini globalement, ne rien afficher
                          if (roleTotals.size === 0 && roleColorMap.size === 0) return null;
                          const rows = Array.from(roleTotals.entries()).sort((a, b) => a[0].localeCompare(b[0]));
                          return (
                            <div className="mt-4 overflow-x-auto">
                              <table className="w-full border-collapse text-sm table-fixed">
                                <thead>
                                  <tr className="border-b dark:border-zinc-800">
                                    <th className="px-2 py-2 text-right w-64">תפקיד</th>
                                    <th className="px-2 py-2 text-right w-28">סה"כ שיבוצים</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {rows.map(([rName, cnt]) => {
                                    const rc = colorForRole(rName);
                                    return (
                                      <tr key={rName} className="border-b last:border-0 dark:border-zinc-800">
                                        <td className="px-2 py-2 w-64">
                                          <span className="inline-flex items-center rounded-full border bg-white px-3 py-1 text-sm shadow-sm" style={{ borderColor: rc.border, color: rc.text }}>
                                            {rName}
                                          </span>
                                        </td>
                                        <td className="px-2 py-2 w-28">{cnt}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          );
                        })()}
                      </div>
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
                    const items = Array.from(counts.entries()).sort((a, b) => {
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
                        <div className="mb-2 flex items-center justify-end gap-6 text-sm">
                          <div>סה"כ נדרש: <span className="font-medium">{totalRequired}</span></div>
                          <div>סה"כ שיבוצים: <span className="font-medium">{totalAssigned}</span></div>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full border-collapse text-sm table-fixed">
                            <thead>
                              <tr className="border-b dark:border-zinc-800">
                                <th className="px-2 py-2 text-right w-64">עובד</th>
                                <th className="px-2 py-2 text-right w-28">מס' משמרות</th>
                              </tr>
                            </thead>
                            <tbody>
                              {items.map(([nm, c]) => {
                                const col = colorForName(nm);
                                return (
                                  <tr key={nm} className="border-b last:border-0 dark:border-zinc-800">
                                    <td className="px-2 py-2 w-64">
                                      <span className="inline-flex items-center rounded-full border px-3 py-1 text-sm shadow-sm" style={{ backgroundColor: col.bg, borderColor: col.border, color: col.text }}>
                                        {nm}
                                      </span>
                                    </td>
                                    <td className="px-2 py-2 w-28">{c}</td>
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
                        <div className="mb-2 flex items-center justify-end gap-6 text-sm">
                          <div>סה"כ נדרש: <span className="font-medium">{totalRequired}</span></div>
                          <div>סה"כ שיבוצים: <span className="font-medium">{totalAssigned}</span></div>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full border-collapse text-sm table-fixed">
                            <thead>
                              <tr className="border-b dark:border-zinc-800">
                                <th className="px-2 py-2 text-right w-64">עובד</th>
                                <th className="px-2 py-2 text-right w-28">מס' משמרות</th>
                              </tr>
                            </thead>
                            <tbody>
                              {items.map(([nm, c]) => {
                                const col = colorForName(nm);
                                return (
                                  <tr key={nm} className="border-b last:border-0 dark:border-zinc-800">
                                    <td className="px-2 py-2 w-64">
                                      <span className="inline-flex items-center rounded-full border px-3 py-1 text-sm shadow-sm" style={{ backgroundColor: col.bg, borderColor: col.border, color: col.text }}>
                                        {nm}
                                      </span>
                                    </td>
                                    <td className="px-2 py-2 w-28">{c}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
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
                            for (const rName of Array.from(roleColorMap.keys())) {
                              if (!roleTotals.has(rName)) roleTotals.set(rName, 0);
                            }
                            // S'il n'y a aucun rôle défini globalement, ne rien afficher
                            if (roleTotals.size === 0 && roleColorMap.size === 0) return null;
                            const rows = Array.from(roleTotals.entries()).sort((a, b) => a[0].localeCompare(b[0]));
                            return (
                              <div className="mt-4 overflow-x-auto">
                                <table className="w-full border-collapse text-sm table-fixed">
                                  <thead>
                                    <tr className="border-b dark:border-zinc-800">
                                      <th className="px-2 py-2 text-right w-64">תפקיד</th>
                                      <th className="px-2 py-2 text-right w-28">סה"כ שיבוצים</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {rows.map(([rName, cnt]) => {
                                      const rc = colorForRole(rName);
                                      return (
                                        <tr key={rName} className="border-b last:border-0 dark:border-zinc-800">
                                          <td className="px-2 py-2 w-64">
                                            <span className="inline-flex items-center rounded-full border bg-white px-3 py-1 text-sm shadow-sm" style={{ borderColor: rc.border, color: rc.text }}>
                                              {rName}
                                            </span>
                                          </td>
                                          <td className="px-2 py-2 w-28">{cnt}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            );
                          })()}
                        </div>
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
                  <div className="text-sm text-zinc-500">טוען...</div>
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
                                try {
                                  await apiFetch<string>(`/director/sites/${siteId}/messages/${m.id}?week=${encodeURIComponent(wk)}`, {
                                    method: "DELETE",
                                    headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                                  });
                                } catch {}
                                await refreshMessages();
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
                                  setMessages(Array.isArray(res) ? res : []);
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
                        <div className="min-h-32 bg-white px-3 py-2 text-sm text-zinc-500 dark:bg-zinc-900">טוען...</div>
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
                              setMessages(Array.isArray(res) ? res : []);
                              closeMessageModal();
                              return;
                            }
                            await apiFetch<OptionalMessage>(
                              `/director/sites/${siteId}/messages`,
                              {
                                method: "POST",
                                headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                                body: JSON.stringify({ text: txt, scope: targetScope, week_iso: wk }),
                              }
                            );
                          } catch {}
                          closeMessageModal();
                          await refreshMessages();
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
                      
                      // eslint-disable-next-line no-console
                      console.log("[BTN] editingSaved check:", { editingSaved, today, weekStartNormalized, weekEnd, containsToday: today >= weekStartNormalized && today <= weekEnd });
                      
                      // Vérifier si la semaine contient le jour actuel
                      if (today >= weekStartNormalized && today <= weekEnd) {
                        // Compter les jours passés (sans compter le jour actuel)
                        const pastDaysCount = Math.floor((today.getTime() - weekStartNormalized.getTime()) / (1000 * 60 * 60 * 24));
                        // eslint-disable-next-line no-console
                        console.log("[BTN] pastDaysCount:", pastDaysCount);
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

                    const hasContent = checkGridNonEmpty();
                    if (hasContent) {
                      if (genDialogBypassRef.current) {
                        // eslint-disable-next-line no-console
                        console.log('[DBG] bypass GenDialog once with', genDialogBypassRef.current);
                        genDialogBypassRef.current = null; // consume bypass and proceed to generation
                      } else {
                        // eslint-disable-next-line no-console
                        console.log('[DBG] open GenDialog: grid has content. isManual=', isManual);
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
                    
                    let stopped = false;
                    try {
                      // eslint-disable-next-line no-console
                      console.log("[BTN] click start");
                      setAiLoading(true);
                      setAiPlan(null);
                      baseAssignmentsRef.current = null;
                      setAltIndex(0);
                      const controller = new AbortController();
                      aiControllerRef.current = controller;
                      const timeoutId = setTimeout(() => {
                        try { controller.abort(); } catch {}
                        setAiLoading(false);
                      }, 120000);
                      aiTimeoutRef.current = timeoutId;
                      // Inactivité: si aucune frame reçue pendant X ms, terminer proprement
                      const armIdle = () => {
                        if (aiIdleTimeoutRef.current) clearTimeout(aiIdleTimeoutRef.current);
                        aiIdleTimeoutRef.current = setTimeout(async () => {
                          // eslint-disable-next-line no-console
                          console.log("[AI][SSE] idle timeout → finalize");
                          setAiPlan((prev) => (prev ? { ...prev, status: "DONE" } : prev));
                          setAiLoading(false);
                          try { await reader.cancel?.(); } catch {}
                          try { controller.abort(); } catch {}
                          aiControllerRef.current = null;
                          if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
                          aiTimeoutRef.current = null;
                          if (aiIdleTimeoutRef.current) clearTimeout(aiIdleTimeoutRef.current);
                          aiIdleTimeoutRef.current = null;
                          stopped = true;
                          toast.success("התכנון הושלם");
                        }, 3000); // 3s d'inactivité
                      };
                      // Construire les cellules fixées (préaffectations)
                      // Priorité: manuel > planning sauvegardé (non en édition) > plan AI courant
                      // Mais seulement si l'utilisateur a choisi de les garder comme fixes (genUseFixed)
                      const fixed = (() => {
                        if (!genUseFixedRef.current) return null;
                        const nonEmpty = (obj: any) => obj && Object.keys(obj || {}).length > 0;
                        const pickSource = () => {
                          // Toujours préférer les assignations manuelles si présentes, même si on vient de basculer en auto
                          if (nonEmpty(manualAssignments)) return { src: 'manual', data: manualAssignments } as const;
                          if (savedWeekPlan?.assignments && !editingSaved && nonEmpty(savedWeekPlan.assignments)) return { src: 'saved', data: savedWeekPlan.assignments as any } as const;
                          if (aiPlan?.assignments && nonEmpty(aiPlan.assignments as any)) return { src: 'ai', data: aiPlan.assignments as any } as const;
                          return null;
                        };
                        const chosen = pickSource();
                        if (!chosen) {
                          // eslint-disable-next-line no-console
                          console.log('[DBG] fixed: no source chosen');
                          return null;
                        }
                        // eslint-disable-next-line no-console
                        console.log('[DBG] fixed: using source', chosen.src);
                        const src = chosen.data as any;
                        // Nettoyer: ne garder que des chaînes non vides et respecter la forme [day][shift][station][]
                        const out: any = {};
                        Object.keys(src || {}).forEach((day) => {
                          out[day] = out[day] || {};
                          const shifts = (src as any)[day] || {};
                          Object.keys(shifts).forEach((sn) => {
                            const perStation: string[][] = (shifts as any)[sn] || [];
                            out[day][sn] = perStation.map((arr) => Array.isArray(arr) ? arr.filter((s) => !!s && String(s).trim().length > 0) : []);
                          });
                        });
                        return out;
                      })();

                      const effectiveExcludeDays = (genExcludeDays && genExcludeDays.length ? genExcludeDays : undefined);
                      const resp = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/director/sites/${params.id}/ai-generate/stream`, {
                        method: "POST",
                        headers: {
                          Authorization: `Bearer ${localStorage.getItem("access_token")}`,
                          Accept: "text/event-stream",
                          "Content-Type": "application/json",
                        },
                        body: JSON.stringify({ 
                          num_alternatives: 500, 
                          fixed_assignments: fixed || undefined, 
                          exclude_days: effectiveExcludeDays, 
                          weekly_availability: (() => {
                            const wa = buildWeeklyAvailabilityForRequest();
                            // eslint-disable-next-line no-console
                            console.log("[BTN] weekly_availability to send:", Object.keys(wa), Object.keys(wa).map(k => ({ name: k, days: Object.keys(wa[k] || {}) })));
                            return wa;
                          })()
                        }),
                        signal: controller.signal,
                      });
                      if (!resp.ok || !resp.body) {
                        // eslint-disable-next-line no-console
                        console.log("[BTN] bad response", resp.status);
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
                              setAiPlan({
                                days: evt.days,
                                shifts: evt.shifts,
                                stations: evt.stations,
                                assignments: evt.assignments,
                                alternatives: [],
                                status: "STREAMING",
                                objective: 0,
                              } as any);
                              baseAssignmentsRef.current = evt.assignments;
                              toast.success("תכנון בסיסי מוכן");
                              armIdle();
                            } else if (evt?.type === "alternative") {
                              armIdle();
                              setAiPlan((prev) => {
                                if (!prev) return prev;
                                const alts = Array.isArray(prev.alternatives) ? prev.alternatives : [];
                                const next = { ...prev, alternatives: [...alts, evt.assignments] } as any;
                                // eslint-disable-next-line no-console
                                console.log("[AI][SSE] alternatives count:", next.alternatives.length);
                                return next;
                              });
                            } else if (evt?.type === "status") {
                              // eslint-disable-next-line no-console
                              console.log("[AI][SSE] status", evt);
                              setAiLoading(false);
                              try { await reader.cancel(); } catch {}
                              if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
                              aiTimeoutRef.current = null;
                              if (aiIdleTimeoutRef.current) clearTimeout(aiIdleTimeoutRef.current);
                              aiIdleTimeoutRef.current = null;
                              aiControllerRef.current = null;
                              stopped = true;
                              break;
                            } else if (evt?.type === "done") {
                              // eslint-disable-next-line no-console
                              console.log("[AI][SSE] done");
                              try { await reader.cancel(); } catch {}
                              if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
                              aiTimeoutRef.current = null;
                              if (aiIdleTimeoutRef.current) clearTimeout(aiIdleTimeoutRef.current);
                              aiIdleTimeoutRef.current = null;
                              aiControllerRef.current = null;
                              stopped = true;
                              setAiLoading(false);
                              setAiPlan((prev) => (prev ? { ...prev, status: "DONE" } : prev));
                              toast.success("התכנון הושלם");
                              break;
                            }
                          } catch (e) {
                            // eslint-disable-next-line no-console
                            console.log("[AI][SSE] parse error", e);
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
                      // eslint-disable-next-line no-console
                      console.log("[BTN] error", e);
                      const msg = String(e?.message || e || "");
                      // Ne pas alerter si on a volontairement stoppé/annulé (AbortError)
                      if (stopped || e?.name === "AbortError" || /aborted/i.test(msg)) {
                        // eslint-disable-next-line no-console
                        console.log("[BTN] fetch aborted/ended gracefully, no toast");
                      } else {
                        toast.error("יצירת תכנון נכשלה", { description: msg || "נסה שוב מאוחר יותר." });
                      }
                    } finally {
                      // eslint-disable-next-line no-console
                      console.log("[BTN] finally set loading false");
                      // Nettoyer les refs seulement si elles n'ont pas déjà été nettoyées
                      if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
                      if (aiIdleTimeoutRef.current) clearTimeout(aiIdleTimeoutRef.current);
                      aiControllerRef.current = null;
                      aiTimeoutRef.current = null;
                      aiIdleTimeoutRef.current = null;
                      setAiLoading(false);
                    }
                  }}
                  className={
                    "inline-flex items-center rounded-md px-6 py-2 text-white disabled:opacity-60 " +
                    ((isSavedMode && !editingSaved)
                      ? "bg-zinc-300 cursor-not-allowed dark:bg-zinc-700"
                      : "bg-[#00A8E0] hover:bg-[#0092c6]")
                  }
                  disabled={(isSavedMode && !editingSaved) || aiLoading}
                >
                  {aiLoading ? "יוצר..." : "יצירת תכנון"}
                </button>
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
                            genDialogBypassRef.current = "fixed";
                            // eslint-disable-next-line no-console
                            console.log('[DBG] GenDialog: keep as fixed clicked');
                            genUseFixedRef.current = true;
                            setGenUseFixed(true);
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
                            genDialogBypassRef.current = "reset";
                            // eslint-disable-next-line no-console
                            console.log('[DBG] GenDialog: reset grid clicked');
                            genUseFixedRef.current = false;
                            setGenUseFixed(false);
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
                    if (isManual && manualAssignments) {
                      const dayKeys = ["sun","mon","tue","wed","thu","fri","sat"];
                      const shiftNames = Array.from(new Set(((site?.config?.stations || []) as any[])
                        .flatMap((st: any) => (st?.shifts || []).filter((sh: any) => sh?.enabled).map((sh: any) => sh?.name))
                        .filter(Boolean)));
                      const stationNames = (site?.config?.stations || []).map((st: any, i: number) => st?.name || `עמדה ${i+1}`);
                      setAiPlan({
                        days: dayKeys,
                        shifts: shiftNames,
                        stations: stationNames,
                        assignments: manualAssignments,
                        alternatives: [],
                        status: "TEMP",
                        objective: typeof (aiPlan as any)?.objective === "number" ? (aiPlan as any).objective : 0,
                      } as any);
                    }
                    setIsManual(false);
                  } else if (modeSwitchTarget === "manual") {
                    try { stopAiGeneration(); } catch {}
                    if (!isManual && aiPlan?.assignments) {
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
                  setPullsByHoleKey({});
                  setPullsEditor(null);
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
        const alts = aiPlan?.alternatives || [];
        const total = 1 + (alts?.length || 0);
        return (
          <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/70 dark:bg-zinc-900/90 dark:border-zinc-800">
            <div className="mx-auto w-full max-w-none px-3 sm:px-6 py-3 md:py-4 grid grid-cols-1 md:grid-cols-3 items-center gap-3 md:gap-4 text-sm">
              {/* Left: Generate Plan + Mode toggle */}
              <div className="flex items-center justify-center md:justify-start gap-2 md:gap-3 flex-wrap order-2 md:order-1">
                <button
                  type="button"
                  onClick={() => { try { triggerGenerateButton(); } catch {} }}
                  disabled={aiLoading || (isSavedMode && !editingSaved) || isManual}
                  className={
                    "inline-flex items-center gap-2 rounded-md px-4 py-2 disabled:opacity-60 " +
                    ((aiLoading || (isSavedMode && !editingSaved) || isManual)
                      ? "bg-zinc-300 text-zinc-600 cursor-not-allowed dark:bg-zinc-700 dark:text-zinc-400"
                      : "bg-[#00A8E0] text-white hover:bg-[#0092c6]")
                  }
                >
                  {aiLoading ? (
                    <>
                      <svg className="animate-spin" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                        <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
                      </svg>
                      יוצר...
                    </>
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                        <path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>
                      </svg>
                      יצירת תכנון
          </>
        )}
                </button>
                {(!isSavedMode || editingSaved) && (
            <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setModeSwitchTarget("auto");
                        setShowModeSwitchDialog(true);
                      }}
                      className={
                        "inline-flex items-center gap-2 rounded-md border px-3 py-1 text-sm " +
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
                        "inline-flex items-center gap-2 rounded-md border px-3 py-1 text-sm " +
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
                {/* Alternatives sous les boutons mode */}
                {!isManual && aiPlan && total > 1 && (
                  <div className="flex items-center justify-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => {
                        const next = (altIndex - 1 + total) % total;
                        setAltIndex(next);
                        // En changeant de חלופה: garder le mode משיכות, mais effacer les משיכות sauvegardées
                        setPullsByHoleKey({});
                        setPullsEditor(null);
                        if (next === 0) {
                          setAiPlan((prev) => (prev ? { ...prev, assignments: baseAssignmentsRef.current || prev.assignments } : prev));
                        } else {
                          const alt = alts[next - 1];
                          setAiPlan((prev) => (prev ? { ...prev, assignments: alt } : prev));
                        }
                      }}
                      disabled={total <= 1 || (altIndex === 0 && aiLoading)}
                      className="inline-flex items-center gap-2 rounded-md border px-3 py-1 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                        <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/>
                      </svg>
                      חלופה
                    </button>
                    <span className="min-w-20 text-center">
                      {altIndex + 1} / {total}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const next = (altIndex + 1) % total;
                        setAltIndex(next);
                        // En changeant de חלופה: garder le mode משיכות, mais effacer les משיכות sauvegardées
                        setPullsByHoleKey({});
                        setPullsEditor(null);
                        if (next === 0) {
                          setAiPlan((prev) => (prev ? { ...prev, assignments: baseAssignmentsRef.current || prev.assignments } : prev));
                        } else {
                          const alt = alts[next - 1];
                          setAiPlan((prev) => (prev ? { ...prev, assignments: alt } : prev));
                        }
                      }}
                      disabled={total <= 1}
                      className="inline-flex items-center gap-2 rounded-md border px-3 py-1 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      חלופה
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                        <path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/>
                      </svg>
                    </button>
                  </div>
                )}
                {/* Save / Edit / Delete sous les alternatives */}
                <div className="flex items-center justify-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={onDeletePlan}
                disabled={!isSavedMode}
                className={
                    "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm " +
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
                  onClick={() => {
                    if (!isSavedMode || !savedWeekPlan || !savedWeekPlan.assignments) return;
                      const assignmentsAny: any = savedWeekPlan.assignments;
                      const dayKeys = ["sun","mon","tue","wed","thu","fri","sat"];
                      const shiftNames = Array.from(
                        new Set(
                          (site?.config?.stations || [])
                            .flatMap((st: any) => (st?.shifts || []).filter((sh: any) => sh?.enabled).map((sh: any) => sh?.name))
                            .filter(Boolean)
                        )
                      );
                      const stationNames = (site?.config?.stations || []).map((st: any, i: number) => st?.name || `עמדה ${i+1}`);
                      if (savedWeekPlan.isManual) {
                        setIsManual(true);
                        setManualAssignments(assignmentsAny as any);
                      } else {
                        setIsManual(false);
                        const newPlan = {
                          days: dayKeys,
                          shifts: shiftNames,
                          stations: stationNames,
                          assignments: assignmentsAny,
                          alternatives: [],
                          status: "SAVED_EDIT",
                          objective: typeof (aiPlan as any)?.objective === "number" ? (aiPlan as any).objective : 0,
                        } as any;
                        setAiPlan(newPlan);
                      }
                      if (Array.isArray(savedWeekPlan.workers) && savedWeekPlan.workers.length) {
                        const mapped = (savedWeekPlan.workers as any[]).map((w: any) => ({
                          id: w.id,
                          name: String(w.name),
                          maxShifts: w.max_shifts ?? w.maxShifts ?? 0,
                          roles: Array.isArray(w.roles) ? w.roles : [],
                          availability: w.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
                          answers: w.answers || {},
                        }));
                        setWorkers(mapped);
                      // Précharger les זמינות hebdomadaires avec celles du planning sauvegardé (fusion avec overrides existants)
                      try {
                        const merged: Record<string, WorkerAvailability> = {} as any;
                        const daysK = ["sun","mon","tue","wed","thu","fri","sat"] as const;
                        (savedWeekPlan.workers as any[]).forEach((rw: any) => {
                          const baseAvail = (rw.availability || {}) as Record<string, string[]>;
                          const weekOverride = (weeklyAvailability[rw.name] || {}) as Record<string, string[]>;
                          const out: WorkerAvailability = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };
                          daysK.forEach((dk) => {
                            const s = new Set<string>(Array.isArray(baseAvail[dk]) ? baseAvail[dk] : []);
                            (Array.isArray(weekOverride[dk]) ? weekOverride[dk] : []).forEach((sn) => s.add(sn));
                            (out as any)[dk] = Array.from(s);
                          });
                          merged[rw.name] = out;
                        });
                        setWeeklyAvailability(merged);
                      } catch {}
                    }
                      setEditingSaved(true);
                  }}
                  disabled={!isSavedMode}
                  className={
                      "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm " +
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
                    className="inline-flex items-center gap-2 rounded-md bg-gray-600 px-3 py-2 text-sm text-white hover:bg-gray-700 dark:bg-gray-500 dark:hover:bg-gray-600"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                    </svg>
                    ביטול
                </button>
              )}
                <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                    onClick={() => onSavePlan(false)}
                    className="inline-flex items-center gap-2 rounded-md border border-green-600 bg-white px-3 py-2 text-sm text-green-700 hover:bg-green-50 dark:border-green-500 dark:bg-zinc-900 dark:text-green-300 dark:hover:bg-green-900/30"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/>
                </svg>
                שמור
              </button>
                <button
                  type="button"
                    onClick={() => onSavePlan(true)}
                    className="inline-flex items-center gap-2 rounded-md bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-600"
                  >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                      <path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/>
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
    </div>
  );
}



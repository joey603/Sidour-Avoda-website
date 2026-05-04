"use client";

import { useCallback, useMemo, useState } from "react";
import PullsLimitPicker from "@/components/pulls-limit-picker";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import type { V2WeekPlanData } from "./hooks/use-planning-v2-week-plan";
import type { LinkedSiteRow } from "./hooks/use-planning-v2-linked-sites";
import { assignmentsNonEmpty } from "./lib/assignments-empty";
import { addDays, getWeekKeyISO } from "./lib/week";

type PlanningV2ActionBarProps = {
  siteId: string;
  weekStart: Date;
  weekPlan: V2WeekPlanData;
  /** Assignations affichées (brouillon IA + serveur) — pour בדיקות מצב */
  effectiveAssignments: Record<string, Record<string, string[][]>> | null;
  linkedSites: LinkedSiteRow[];
  /** Site archivé (soft-delete) : pas d’enregistrement / génération. */
  readOnly?: boolean;
  editingSaved: boolean;
  onEditingSavedChange: (v: boolean) => void;
  /** ביטול מצב עריכה — ניקוי טיוטה והצגת התכנון השמור (לפני סגירת ה־UI). */
  onCancelSavedEdit?: () => void | Promise<void>;
  reloadWeekPlan: (opts?: { silent?: boolean }) => void | Promise<void>;
  generationRunning: boolean;
  onRequestGenerate: (options?: {
    excludeDays?: string[];
    fixedAssignments?: Record<string, Record<string, string[][]>>;
  }) => void;
  onStopGeneration: () => void;
  autoPullsLimit: string;
  onAutoPullsLimitChange: (v: string) => void;
  autoPullsEnabled: boolean;
  isManual: boolean;
  onIsManualChange: (v: boolean) => void;
  /** מעבר לידני + איפוס גריד מקומי (ללא טעינה מחדש מהשרת). */
  onEnterManualWithGridReset?: () => void;
  onSavePlan: (publishToWorkers: boolean) => void | Promise<void>;
  onDraftClear?: () => void;
  /** טיוטת IA ללא שמירה — מאפשר שמור בלי מצב ערוך */
  draftActive: boolean;
  /** Nombre d’alternatives navigables actuellement (peut être filtré). */
  alternativeCount: number;
  /** Index dans l’ensemble navigable actuel (peut être filtré). */
  selectedAlternativeIndex: number;
  /** Index réel dans l’ensemble total des alternatives. */
  selectedAlternativeDisplayIndex?: number;
  onSelectedAlternativeChange: (index: number) => void;
  onRequestMoreAlternatives?: () => void;
  moreAlternativesAvailable?: boolean;
  /** Faux tant qu’aucune יצירת תכנון n’a produit de plan (ou pas d’alternatives côté serveur / brouillon). */
  alternativesEnabled?: boolean;
  /** Affichage figé (ex. entre יצירה מאפס et le premier événement SSE) : barre visible mais navigation désactivée. */
  alternativesFrozen?: boolean;
  alternativesFiltered?: boolean;
  alternativesTotalCount?: number;
};

type MultiSitePlanAction = "delete" | "save_director" | "save_shared";

export function PlanningV2ActionBar({
  siteId,
  weekStart,
  weekPlan,
  effectiveAssignments,
  linkedSites,
  readOnly = false,
  editingSaved,
  onEditingSavedChange,
  onCancelSavedEdit,
  reloadWeekPlan,
  generationRunning,
  onRequestGenerate,
  onStopGeneration,
  autoPullsLimit,
  onAutoPullsLimitChange,
  autoPullsEnabled,
  isManual,
  onIsManualChange,
  onEnterManualWithGridReset,
  onSavePlan,
  onDraftClear,
  draftActive,
  alternativeCount,
  selectedAlternativeIndex,
  selectedAlternativeDisplayIndex,
  onSelectedAlternativeChange,
  onRequestMoreAlternatives,
  moreAlternativesAvailable = true,
  alternativesEnabled = true,
  alternativesFrozen = false,
  alternativesFiltered = false,
  alternativesTotalCount,
}: PlanningV2ActionBarProps) {
  const isoWeek = getWeekKeyISO(weekStart);

  const [showModeSwitchDialog, setShowModeSwitchDialog] = useState(false);
  const [modeSwitchTarget, setModeSwitchTarget] = useState<"manual" | "auto" | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showPastDaysDialog, setShowPastDaysDialog] = useState(false);
  const [pendingExcludeDays, setPendingExcludeDays] = useState<string[]>([]);
  const [showExistingAssignmentsDialog, setShowExistingAssignmentsDialog] = useState(false);
  const [pendingGenerateOptions, setPendingGenerateOptions] = useState<{
    fixedAssignments?: Record<string, Record<string, string[][]>>;
    skipExistingCheck?: boolean;
  } | null>(null);
  const [multiSitePlanActionDialog, setMultiSitePlanActionDialog] = useState<{
    action: MultiSitePlanAction;
  } | null>(null);

  /** תכנון verrouillé : director/shared seulement — une טיוטת `auto` reste éditable / regénérable sans « ערוך ». */
  const isSavedMode = useMemo(
    () =>
      assignmentsNonEmpty(weekPlan?.assignments ?? null) &&
      (weekPlan?.sourceScope === "director" || weekPlan?.sourceScope === "shared"),
    [weekPlan?.assignments, weekPlan?.sourceScope],
  );

  // "מחק/ערוך" רק עבור תכנון שמור אמיתי (מנהל/משותף),
  // לא עבור טיוטת auto שנוצרה אחרי יצירת תכנון.
  const hasPersistedWeekPlan = useMemo(
    () =>
      assignmentsNonEmpty(weekPlan?.assignments ?? null) &&
      (weekPlan?.sourceScope === "director" || weekPlan?.sourceScope === "shared"),
    [weekPlan?.assignments, weekPlan?.sourceScope],
  );

  const multiSiteActionLabelByType: Record<MultiSitePlanAction, string> = {
    delete: "מחק",
    save_director: "שמור",
    save_shared: "שמור ואשלח",
  };
  const currentSiteLabel = useMemo(() => {
    const current = linkedSites.find((s) => String(s.id) === String(siteId));
    return current?.name || "האתר הנוכחי";
  }, [linkedSites, siteId]);
  const otherSitesLabel = useMemo(() => {
    const names = linkedSites
      .filter((s) => String(s.id) !== String(siteId))
      .map((s) => s.name)
      .filter(Boolean);
    return names.join(", ");
  }, [linkedSites, siteId]);

  /** Comme planning : יצירת תכנון bloquée si génération, plan serveur sans édition, ou mode ידני */
  const generationBlocked = readOnly || generationRunning || (isSavedMode && !editingSaved) || isManual;
  const showAutoManual = !isSavedMode || editingSaved;

  const canSavePlan =
    !readOnly &&
    assignmentsNonEmpty(effectiveAssignments) &&
    (editingSaved || draftActive || weekPlan?.sourceScope === "auto");

  const buildNonEmptyAssignmentsSnapshot = useCallback(
    (src: Record<string, Record<string, string[][]>> | null | undefined) => {
      if (!src || typeof src !== "object") return undefined;
      const out: Record<string, Record<string, string[][]>> = {};
      Object.entries(src).forEach(([dayKey, shiftsMap]) => {
        if (!shiftsMap || typeof shiftsMap !== "object") return;
        let dayUsed = false;
        const nextShifts: Record<string, string[][]> = {};
        Object.entries(shiftsMap).forEach(([shiftName, perStation]) => {
          if (!Array.isArray(perStation)) return;
          const nextStations = perStation.map((cell) => {
            if (!Array.isArray(cell)) return [];
            return cell.map((n) => String(n || "").trim()).filter(Boolean);
          });
          const hasAny = nextStations.some((cell) => cell.length > 0);
          if (hasAny) {
            nextShifts[shiftName] = nextStations;
            dayUsed = true;
          }
        });
        if (dayUsed) out[dayKey] = nextShifts;
      });
      return Object.keys(out).length > 0 ? out : undefined;
    },
    [],
  );

  const alternativesInteractive = alternativesEnabled && !alternativesFrozen;
  const hasAlternatives = alternativeCount >= 1;
  const altCurrent = Math.max(0, Math.min(Math.max(0, selectedAlternativeIndex), Math.max(0, alternativeCount - 1)));
  const altTotalCount = Math.max(0, alternativesTotalCount ?? alternativeCount);
  const altDisplayCurrent = Math.max(
    0,
    Math.min(
      Math.max(0, selectedAlternativeDisplayIndex ?? selectedAlternativeIndex),
      Math.max(0, altTotalCount - 1),
    ),
  );
  const canAltPrev = alternativesInteractive && hasAlternatives && altCurrent > 0;
  const canAltNext = alternativesInteractive && hasAlternatives && altCurrent < alternativeCount - 1;
  const canRequestMoreAlternatives =
    alternativesInteractive &&
    hasAlternatives &&
    moreAlternativesAvailable &&
    !generationBlocked &&
    assignmentsNonEmpty(effectiveAssignments) &&
    typeof onRequestMoreAlternatives === "function";

  const handleDelete = useCallback(async () => {
    if (readOnly) return;
    const id = Number(siteId);
    if (!Number.isFinite(id) || id <= 0) return;
    setDeleting(true);
    try {
      const headers = { Authorization: `Bearer ${localStorage.getItem("access_token")}` };
      await Promise.allSettled([
        apiFetch(`/director/sites/${siteId}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=director`, {
          method: "DELETE",
          headers,
        }),
        apiFetch(`/director/sites/${siteId}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=shared`, {
          method: "DELETE",
          headers,
        }),
        apiFetch(`/director/sites/${siteId}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=auto`, {
          method: "DELETE",
          headers,
        }),
      ]);
      toast.success("התכנון נמחק בהצלחה");
      setShowDeleteConfirm(false);
      onEditingSavedChange(false);
      onDraftClear?.();
      await reloadWeekPlan();
    } catch (e: unknown) {
      toast.error("מחיקה נכשלה", { description: String((e as Error)?.message || "נסה שוב מאוחר יותר.") });
    } finally {
      setDeleting(false);
    }
  }, [readOnly, siteId, isoWeek, reloadWeekPlan, onEditingSavedChange, onDraftClear]);

  const deletePlanForSite = useCallback(
    async (targetSiteId: number) => {
      const headers = { Authorization: `Bearer ${localStorage.getItem("access_token")}` };
      await Promise.allSettled([
        apiFetch(`/director/sites/${targetSiteId}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=director`, {
          method: "DELETE",
          headers,
        }),
        apiFetch(`/director/sites/${targetSiteId}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=shared`, {
          method: "DELETE",
          headers,
        }),
        apiFetch(`/director/sites/${targetSiteId}/week-plan?week=${encodeURIComponent(isoWeek)}&scope=auto`, {
          method: "DELETE",
          headers,
        }),
      ]);
    },
    [isoWeek],
  );

  const executeMultiSitePlanAction = useCallback(
    async (action: MultiSitePlanAction, allLinked: boolean) => {
      if (readOnly) return;
      if (action === "save_director") {
        await onSavePlan(false);
        return;
      }
      if (action === "save_shared") {
        await onSavePlan(true);
        return;
      }
      if (action === "delete") {
        if (!allLinked) {
          await handleDelete();
          return;
        }
        setDeleting(true);
        try {
          const ids = linkedSites.map((s) => Number(s.id)).filter(Number.isFinite);
          await Promise.all(ids.map((id) => deletePlanForSite(id)));
          toast.success("התכנון נמחק בכל האתרים המקושרים");
          setShowDeleteConfirm(false);
          onEditingSavedChange(false);
          onDraftClear?.();
          await reloadWeekPlan();
        } catch (e: unknown) {
          toast.error("מחיקה נכשלה", { description: String((e as Error)?.message || "נסה שוב מאוחר יותר.") });
        } finally {
          setDeleting(false);
        }
      }
    },
    [readOnly, onSavePlan, handleDelete, linkedSites, deletePlanForSite, onEditingSavedChange, onDraftClear, reloadWeekPlan],
  );

  const requestMultiSitePlanAction = useCallback(
    (action: MultiSitePlanAction) => {
      if (readOnly) return;
      if (linkedSites.length > 1) {
        setMultiSitePlanActionDialog({ action });
        return;
      }
      if (action === "delete") {
        setShowDeleteConfirm(true);
        return;
      }
      void executeMultiSitePlanAction(action, false);
    },
    [readOnly, linkedSites.length, executeMultiSitePlanAction],
  );

  const runGenerateWithChecks = useCallback(
    (options?: {
      fixedAssignments?: Record<string, Record<string, string[][]>>;
      skipExistingCheck?: boolean;
    }) => {
      if (generationBlocked) return;
      const baseOptions = options || {};
      const hasNonEmptyGrid = assignmentsNonEmpty(effectiveAssignments);
      if (hasNonEmptyGrid && !baseOptions.fixedAssignments && !baseOptions.skipExistingCheck) {
        setPendingGenerateOptions(baseOptions);
        setShowExistingAssignmentsDialog(true);
        return;
      }
      const dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const toExclude: string[] = [];
      for (let i = 0; i < 7; i++) {
        const d = addDays(weekStart, i);
        d.setHours(0, 0, 0, 0);
        if (d < today) toExclude.push(dayKeys[i]);
      }
      if (toExclude.length > 0) {
        setPendingGenerateOptions(baseOptions);
        setPendingExcludeDays(toExclude);
        setShowPastDaysDialog(true);
        return;
      }
      onRequestGenerate({
        fixedAssignments: baseOptions.fixedAssignments,
      });
    },
    [generationBlocked, effectiveAssignments, onRequestGenerate, weekStart],
  );

  const handleGenerateClick = useCallback(() => {
    if (generationBlocked) return;
    runGenerateWithChecks();
  }, [generationBlocked, runGenerateWithChecks]);

  return (
    <>
      {showModeSwitchDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 text-center shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-3 text-center text-sm">
              {modeSwitchTarget === "manual"
                ? "לעבור למצב ידני. לשמור את השיבוצים הנוכחיים במקומם?"
                : "לעבור למצב אוטומטי. לשמור את השיבוצים הנוכחיים במקומם?"}
            </div>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => {
                  setShowModeSwitchDialog(false);
                  setModeSwitchTarget(null);
                }}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => {
                  if (modeSwitchTarget === "auto") onIsManualChange(false);
                  else if (modeSwitchTarget === "manual") onIsManualChange(true);
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
                  if (modeSwitchTarget === "auto") {
                    onIsManualChange(false);
                    setShowModeSwitchDialog(false);
                    setModeSwitchTarget(null);
                    void reloadWeekPlan();
                  } else if (modeSwitchTarget === "manual") {
                    onEnterManualWithGridReset?.();
                    setShowModeSwitchDialog(false);
                    setModeSwitchTarget(null);
                  }
                }}
              >
                אפס גריד
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 text-center shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-3 text-sm">למחוק את התכנון השמור לשבוע זה?</div>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700 disabled:opacity-60"
                onClick={() => void handleDelete()}
                disabled={deleting}
              >
                {deleting ? "מוחק…" : "מחק"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showPastDaysDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 text-center shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-3 text-center text-sm">
              {`כבר עברו ${pendingExcludeDays.length} ימים בשבוע זה. להתעלם מהימים שעברו (להשאיר אותם ריקים)?`}
            </div>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => setShowPastDaysDialog(false)}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => {
                  setShowPastDaysDialog(false);
                  onRequestGenerate({
                    fixedAssignments: pendingGenerateOptions?.fixedAssignments,
                    excludeDays: [],
                  });
                  setPendingGenerateOptions(null);
                }}
              >
                לא
              </button>
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-3 py-1 text-sm text-white hover:bg-[#0092c6]"
                onClick={() => {
                  setShowPastDaysDialog(false);
                  onRequestGenerate({
                    fixedAssignments: pendingGenerateOptions?.fixedAssignments,
                    excludeDays: pendingExcludeDays,
                  });
                  setPendingGenerateOptions(null);
                }}
              >
                כן
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showExistingAssignmentsDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-3 text-sm">
              התכנית מכילה שיבוצים קיימים.
              <br />
              האם לשמור אותם כקבועים וליצור תכנון סביבם, או להתחיל מאפס?
            </div>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => {
                  setShowExistingAssignmentsDialog(false);
                  setPendingGenerateOptions(null);
                }}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => {
                  const fixedAssignments = buildNonEmptyAssignmentsSnapshot(effectiveAssignments);
                  setShowExistingAssignmentsDialog(false);
                  if (!fixedAssignments) {
                    const base = { ...(pendingGenerateOptions || {}), skipExistingCheck: true };
                    setPendingGenerateOptions(null);
                    runGenerateWithChecks(base);
                    return;
                  }
                  const base = { ...(pendingGenerateOptions || {}), fixedAssignments, skipExistingCheck: true };
                  setPendingGenerateOptions(null);
                  runGenerateWithChecks(base);
                }}
              >
                שמור כשיבוצים קבועים
              </button>
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-3 py-1 text-sm text-white hover:bg-[#0092c6]"
                onClick={() => {
                  setShowExistingAssignmentsDialog(false);
                  const base = { ...(pendingGenerateOptions || {}), skipExistingCheck: true };
                  setPendingGenerateOptions(null);
                  runGenerateWithChecks(base);
                }}
              >
                תכנון מאפס
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {multiSitePlanActionDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
            <div className="space-y-2 text-right">
              <div className="text-base font-semibold">
                {multiSiteActionLabelByType[multiSitePlanActionDialog.action]} באתרים מקושרים
              </div>
              <div className="text-sm text-zinc-600 dark:text-zinc-300">
                האם לבצע את הפעולה רק עבור {currentSiteLabel} או עבור כל האתרים המקושרים?
              </div>
              {otherSitesLabel ? (
                <div className="text-xs text-zinc-500 dark:text-zinc-400">האתרים המקושרים: {otherSitesLabel}</div>
              ) : null}
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
                className="rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => {
                  const action = multiSitePlanActionDialog.action;
                  setMultiSitePlanActionDialog(null);
                  void executeMultiSitePlanAction(action, false);
                }}
              >
                רק באתר הנוכחי
              </button>
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-3 py-1 text-sm text-white hover:bg-[#0092c6]"
                onClick={() => {
                  const action = multiSitePlanActionDialog.action;
                  setMultiSitePlanActionDialog(null);
                  void executeMultiSitePlanAction(action, true);
                }}
              >
                בכל האתרים המקושרים
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div
        id="planning-v2-action-bar"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/70 dark:border-zinc-800 dark:bg-zinc-900/90"
      >
        <div className="mx-auto grid w-full max-w-none grid-cols-1 place-items-center gap-3 px-3 py-3 text-sm md:gap-4 md:py-4 sm:px-6">
          <div className="order-2 flex w-full flex-col items-center justify-center gap-2 md:order-1 md:gap-2">
            <div className="flex w-full flex-nowrap items-center justify-center gap-2 overflow-x-auto [@media(orientation:landscape)_and_(max-width:1024px)]:gap-1">
              {generationRunning && (
                <button
                  type="button"
                  onClick={() => onStopGeneration()}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-red-500/90 bg-white px-3 py-2 text-sm font-medium text-red-600 shadow-sm hover:bg-red-50 dark:border-red-500/70 dark:bg-zinc-900 dark:text-red-400 dark:hover:bg-red-950/50 [@media(orientation:landscape)_and_(max-width:1024px)]:gap-1 [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                    <path d="M6 6h12v12H6z" />
                  </svg>
                </button>
              )}
              <div
                className={
                  "inline-flex shrink-0 overflow-hidden rounded-md border disabled:opacity-60 " +
                  (generationBlocked ? "border-zinc-300 dark:border-zinc-600" : "border-[#00A8E0]") +
                  (generationRunning ? " backdrop-blur-md supports-[backdrop-filter]:bg-white/25 dark:supports-[backdrop-filter]:bg-zinc-900/35" : "")
                }
              >
                <button
                  type="button"
                  onClick={() => handleGenerateClick()}
                  disabled={generationBlocked}
                  className={
                    "inline-flex items-center gap-2 rounded-none border-0 px-4 py-2 disabled:opacity-60 [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs " +
                    (generationBlocked
                      ? "cursor-not-allowed bg-zinc-300 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400"
                      : "bg-[#00A8E0] text-white hover:bg-[#0092c6]")
                  }
                >
                  {generationRunning ? (
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="inline-block h-3 w-3 shrink-0 rounded-full border-2 border-zinc-500/35 border-t-zinc-700 motion-safe:animate-spin dark:border-zinc-400/30 dark:border-t-zinc-100"
                        aria-hidden
                      />
                      יוצר...
                    </span>
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
                    if (generationBlocked) return;
                    const trigger = (e.currentTarget as HTMLDivElement).querySelector(
                      '[data-pulls-picker-trigger="1"]',
                    ) as HTMLButtonElement | null;
                    trigger?.click();
                  }}
                  className={
                    "flex min-w-[2rem] cursor-pointer flex-col items-center justify-center border-l px-0.5 py-0 [@media(orientation:landscape)_and_(max-width:1024px)]:min-w-[1.85rem] " +
                    (generationBlocked
                      ? "cursor-not-allowed border-zinc-400/60 bg-zinc-300 dark:border-zinc-600 dark:bg-zinc-700"
                      : autoPullsEnabled
                        ? "border-orange-500 bg-orange-500 dark:border-orange-500 dark:bg-orange-500"
                        : "border-[#00A8E0]/80 bg-white dark:border-[#0092c6]/80 dark:bg-zinc-900")
                  }
                >
                  <span
                    className={
                      "text-[9px] font-medium leading-none [@media(orientation:landscape)_and_(max-width:1024px)]:text-[8px] " +
                      (generationBlocked
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
                    onChange={onAutoPullsLimitChange}
                    disabled={generationBlocked}
                    className={
                      "!shadow-none w-full max-w-[3.25rem] bg-transparent py-0 text-center text-[12px] font-semibold leading-none outline-none [@media(orientation:landscape)_and_(max-width:1024px)]:max-w-[3rem] [@media(orientation:landscape)_and_(max-width:1024px)]:text-[11px] " +
                      (generationBlocked
                        ? "text-zinc-600 placeholder:text-zinc-500 dark:text-zinc-400 dark:placeholder:text-zinc-500 disabled:opacity-100"
                        : autoPullsEnabled
                          ? "text-white placeholder:text-white/70 disabled:opacity-50"
                          : "text-orange-600 placeholder:text-orange-600/70 dark:text-orange-400 dark:placeholder:text-orange-400/70 disabled:opacity-50")
                    }
                    title="מגבלת משיכות"
                  />
                </div>
              </div>

              {showAutoManual && (
                <div className="flex shrink-0 items-center gap-2 [@media(orientation:landscape)_and_(max-width:1024px)]:gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      if (!isManual) return;
                      if (!assignmentsNonEmpty(effectiveAssignments)) {
                        onIsManualChange(false);
                        return;
                      }
                      setModeSwitchTarget("auto");
                      setShowModeSwitchDialog(true);
                    }}
                    className={
                      "inline-flex items-center gap-2 rounded-md border px-3 py-1 text-sm [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs " +
                      (isManual ? "dark:border-zinc-700" : "border-[#00A8E0] bg-[#00A8E0] text-white")
                    }
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                      <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94L14.4 2.81c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.3-.06.61-.06.94 0 .32.02.64.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                    </svg>
                    אוטומטי
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (isManual) return;
                      const hasContent = assignmentsNonEmpty(effectiveAssignments);
                      if (!hasContent) {
                        onIsManualChange(true);
                        return;
                      }
                      setModeSwitchTarget("manual");
                      setShowModeSwitchDialog(true);
                    }}
                    className={
                      "inline-flex items-center gap-2 rounded-md border px-3 py-1 text-sm [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs " +
                      (isManual ? "border-[#00A8E0] bg-[#00A8E0] text-white" : "dark:border-zinc-700")
                    }
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                      <path d="M9 11.24V7.5a2.5 2.5 0 0 1 5 0v3.74c1.21-.81 2-2.18 2-3.74C16 5.01 13.99 3 11.5 3S7 5.01 7 7.5c0 1.56.79 2.93 2 3.74zm9.84 4.63l-4.54-2.26c-.17-.07-.35-.11-.54-.11H13v-6c0-.83-.67-1.5-1.5-1.5S10 6.67 10 7.5v10.74l-3.43-.72c-.08-.01-.15-.03-.24-.03-.31 0-.59.13-.79.33l-.79.8 4.94 4.94c.27.27.65.44 1.06.44h6.79c.75 0 1.33-.55 1.44-1.28l.75-5.27c.01-.07.02-.14.02-.2 0-.62-.38-1.16-.91-1.38z" />
                    </svg>
                    ידני
                  </button>
                </div>
              )}
            </div>

            {showAutoManual && alternativesEnabled ? (
              <div className="flex w-full justify-center">
                <div
                  className={
                    "inline-flex flex-col gap-1 rounded-md border px-2 py-1 " +
                    (alternativesFrozen
                      ? "border-zinc-200 bg-zinc-50 opacity-90 dark:border-zinc-600 dark:bg-zinc-900/80"
                      : "border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900")
                  }
                >
                  <div className="text-center text-[10px] font-medium text-zinc-600 dark:text-zinc-300">חלופות</div>
                  <div className="inline-flex items-center gap-1">
                    {alternativesFiltered ? (
                      <span
                        className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                        title={
                          typeof alternativesTotalCount === "number"
                            ? `מסונן: ${alternativeCount}/${alternativesTotalCount}`
                            : "מסונן לפי פילטרים"
                        }
                      >
                        {typeof alternativesTotalCount === "number" ? `מסונן ${alternativeCount}/${alternativesTotalCount}` : "מסונן"}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        if (!canAltPrev) return;
                        onSelectedAlternativeChange(altCurrent - 1);
                      }}
                      disabled={!canAltPrev}
                      className={
                        "inline-flex items-center justify-center rounded-md border px-2 py-1 text-xs " +
                        (canAltPrev
                          ? "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          : "cursor-not-allowed border-zinc-200 text-zinc-400 dark:border-zinc-800 dark:text-zinc-500")
                      }
                      aria-label="אלטרנטיבה קודמת"
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
                        <path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" />
                      </svg>
                    </button>
                    <span className="min-w-14 text-center text-xs font-medium text-zinc-700 dark:text-zinc-200" dir="ltr">
                      {hasAlternatives ? `${altDisplayCurrent + 1}/${altTotalCount || alternativeCount}` : "0/0"}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (!canAltNext) return;
                        onSelectedAlternativeChange(altCurrent + 1);
                      }}
                      disabled={!canAltNext}
                      className={
                        "inline-flex items-center justify-center rounded-md border px-2 py-1 text-xs " +
                        (canAltNext
                          ? "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          : "cursor-not-allowed border-zinc-200 text-zinc-400 dark:border-zinc-800 dark:text-zinc-500")
                      }
                      aria-label="אלטרנטיבה הבאה"
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
                        <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!canRequestMoreAlternatives) return;
                        onRequestMoreAlternatives?.();
                      }}
                      disabled={!canRequestMoreAlternatives}
                      className={
                        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs whitespace-nowrap " +
                        (canRequestMoreAlternatives
                          ? "border-[#00A8E0] bg-[#00A8E0] text-white hover:bg-[#0092c6]"
                          : "cursor-not-allowed border-zinc-200 text-zinc-400 dark:border-zinc-800 dark:text-zinc-500")
                      }
                      title={moreAlternativesAvailable ? "יצירת חלופות נוספות" : "אין חלופות חדשות נוספות"}
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
                        <path d="M19 11h-6V5h-2v6H5v2h6v6h2v-6h6z" />
                      </svg>
                      עוד
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="flex w-full flex-wrap items-center justify-center gap-2 md:flex-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:flex-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:gap-1">
              <button
                type="button"
                onClick={() => requestMultiSitePlanAction("delete")}
                disabled={readOnly || !hasPersistedWeekPlan}
                className={
                  "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs " +
                  (hasPersistedWeekPlan && !readOnly
                    ? "bg-red-600 text-white hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600"
                    : "cursor-not-allowed bg-zinc-300 text-zinc-600 opacity-60 dark:bg-zinc-700 dark:text-zinc-400")
                }
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                </svg>
                מחק
              </button>

              {!editingSaved && (
                <button
                  type="button"
                  onClick={() => {
                    if (!hasPersistedWeekPlan || readOnly) return;
                    onEditingSavedChange(true);
                  }}
                  disabled={readOnly || !hasPersistedWeekPlan}
                  className={
                    "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm whitespace-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs " +
                    (hasPersistedWeekPlan && !readOnly
                      ? "border-[#00A8E0] bg-[#00A8E0] text-white hover:bg-[#0092c6]"
                      : "cursor-not-allowed border-zinc-300 bg-zinc-300 text-zinc-600 opacity-60 dark:border-zinc-700 dark:bg-zinc-700 dark:text-zinc-400")
                  }
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                  </svg>
                  ערוך
                </button>
              )}

              {editingSaved && (
                <button
                  type="button"
                  onClick={() => {
                    void (async () => {
                      try {
                        await onCancelSavedEdit?.();
                      } finally {
                        onEditingSavedChange(false);
                      }
                    })();
                  }}
                  className="inline-flex items-center gap-2 rounded-md bg-gray-600 px-3 py-2 text-sm text-white hover:bg-gray-700 dark:bg-gray-500 dark:hover:bg-gray-600 whitespace-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                  </svg>
                  ביטול
                </button>
              )}

              <div className="flex flex-wrap items-center gap-2 md:flex-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:flex-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:gap-1">
                <button
                  type="button"
                  onClick={() => requestMultiSitePlanAction("save_director")}
                  disabled={!canSavePlan}
                  className={
                    "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm whitespace-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs " +
                    (canSavePlan
                      ? "border-green-600 bg-white text-green-700 hover:bg-green-50 dark:border-green-500 dark:bg-zinc-900 dark:text-green-300 dark:hover:bg-green-900/30"
                      : "cursor-not-allowed border-zinc-200 bg-zinc-100 text-zinc-400 opacity-60 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-500")
                  }
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                    <path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z" />
                  </svg>
                  שמור
                </button>
                <button
                  type="button"
                  onClick={() => requestMultiSitePlanAction("save_shared")}
                  disabled={!canSavePlan}
                  className={
                    "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap [@media(orientation:landscape)_and_(max-width:1024px)]:px-2 [@media(orientation:landscape)_and_(max-width:1024px)]:py-1 [@media(orientation:landscape)_and_(max-width:1024px)]:text-xs " +
                    (canSavePlan
                      ? "bg-green-600 text-white hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-600"
                      : "cursor-not-allowed bg-zinc-300 text-zinc-600 opacity-60 dark:bg-zinc-700 dark:text-zinc-400")
                  }
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                  שמור ואשלח
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

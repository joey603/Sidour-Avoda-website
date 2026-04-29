"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import { buildWorkerModalQuestionView } from "@/components/planning-shared/worker-modal-question-view";
import { collectShiftNamesFromSiteConfig } from "@/components/planning-shared/site-shift-roles";
import { isAvailabilityDayShiftChanged } from "@/lib/worker-availability-compare";
import type { PlanningWorker, SiteSummary, WorkerAvailability } from "../types";
import { EMPTY_WORKER_AVAILABILITY } from "../lib/constants";
import { DAY_DEFS, buildEnabledRoleNameSet } from "../lib/display";
import { cloneWorkerAvailability } from "../lib/merge-availability";
import { persistWorkerNameWeeklyOverride } from "../lib/availability-storage";
import { getWeekKeyISO, isNextWeekDisplayed } from "../lib/week";

export type WorkerRowForEditor = PlanningWorker & { availability: WorkerAvailability };

export function usePlanningV2WorkerModals(
  siteId: string,
  site: SiteSummary | null,
  weekStart: Date,
  workers: PlanningWorker[],
  availabilityOverlaysByWorkerName: Record<string, Record<string, string[]>>,
  reloadWorkers: () => void,
) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [questionFilters, setQuestionFilters] = useState<Record<string, string | undefined>>({});
  const [filterByWorkDays, setFilterByWorkDays] = useState(false);
  const [questionVisibility, setQuestionVisibility] = useState<Record<string, boolean | undefined>>({});

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingWorkerId, setEditingWorkerId] = useState<number | null>(null);
  const [newWorkerName, setNewWorkerName] = useState("");
  const [newWorkerMax, setNewWorkerMax] = useState(5);
  const [newWorkerRoles, setNewWorkerRoles] = useState<string[]>([]);
  const [newWorkerAvailability, setNewWorkerAvailability] = useState<WorkerAvailability>({
    ...EMPTY_WORKER_AVAILABILITY,
  });
  const [originalAvailability, setOriginalAvailability] = useState<WorkerAvailability>({
    ...EMPTY_WORKER_AVAILABILITY,
  });
  const [workerModalSaving, setWorkerModalSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [linkedAvailabilityConfirmSites, setLinkedAvailabilityConfirmSites] = useState<string[] | null>(null);
  const pendingLinkedAvailabilitySaveRef = useRef<((propagate: boolean) => Promise<void>) | null>(null);
  /** Étape 1 (comme le planning) : יצירת עובד חדש — שם + טלפון. */
  const [createStepOpen, setCreateStepOpen] = useState(false);
  const [existingPickerOpen, setExistingPickerOpen] = useState(false);

  const enabledRoleNameSet = useMemo(() => buildEnabledRoleNameSet(site), [site]);
  const allRoleNames = useMemo(
    () => Array.from(enabledRoleNameSet).sort((a, b) => a.localeCompare(b)),
    [enabledRoleNameSet, availabilityOverlaysByWorkerName],
  );
  const allShiftNames = useMemo(() => collectShiftNamesFromSiteConfig(site), [site]);

  const editingWorkerResolved = useMemo(() => {
    if (!editingWorkerId) return null;
    return workers.find((w) => Number(w.id) === Number(editingWorkerId)) ?? null;
  }, [editingWorkerId, workers]);

  const editingWorkerLinkedSiteNames = useMemo(() => {
    const w = editingWorkerResolved as Record<string, unknown> | null;
    const linkedSiteNames = Array.isArray(w?.linkedSiteNames)
      ? (w!.linkedSiteNames as string[])
      : Array.isArray(w?.linked_site_names)
        ? (w!.linked_site_names as string[])
        : [];
    return Array.from(
      new Set((linkedSiteNames || []).map((x) => String(x || "").trim()).filter(Boolean)),
    ) as string[];
  }, [editingWorkerResolved]);

  const workerModalQuestionView = useMemo(
    () =>
      buildWorkerModalQuestionView(
        editingWorkerId,
        editingWorkerResolved?.answers,
        weekStart,
        ((site?.config as { questions?: unknown[] } | undefined)?.questions || []) as unknown[],
        DAY_DEFS,
      ),
    [editingWorkerId, editingWorkerResolved?.answers, site?.config, weekStart],
  );

  const workerModalShiftBuckets = useMemo(
    () => ({
      morningName: allShiftNames.find((sn) => /בוקר|^0?6|06-14/i.test(sn || "")),
      noonName: allShiftNames.find((sn) => /צהריים|14-22|^1?4/i.test(sn || "")),
      nightName: allShiftNames.find((sn) => /לילה|22-06|^2?2|night/i.test(sn || "")),
    }),
    [allShiftNames],
  );

  const workerModalBulkSelection = useMemo(() => {
    const isAllSelected = (shiftName?: string) => {
      if (!shiftName) return false;
      return DAY_DEFS.every((d) => (newWorkerAvailability[d.key] || []).includes(shiftName));
    };
    return {
      morningAll: isAllSelected(workerModalShiftBuckets.morningName),
      noonAll: isAllSelected(workerModalShiftBuckets.noonName),
      nightAll: isAllSelected(workerModalShiftBuckets.nightName),
    };
  }, [newWorkerAvailability, workerModalShiftBuckets]);

  const currentWeekWorkersForEditor = useMemo(() => workers, [workers]);

  const toggleNewAvailability = useCallback((dayKey: string, shift: string) => {
    setNewWorkerAvailability((prev) => {
      const cur = prev[dayKey] || [];
      return {
        ...prev,
        [dayKey]: cur.includes(shift) ? cur.filter((s) => s !== shift) : [...cur, shift],
      };
    });
  }, []);

  const toggleWorkerAvailabilityForAllDays = useCallback((shiftName?: string, checked?: boolean) => {
    if (!shiftName) return;
    setNewWorkerAvailability((prev) => {
      const next: WorkerAvailability = { ...prev };
      for (const dayDef of DAY_DEFS) {
        const currentValues = new Set(next[dayDef.key] || []);
        if (checked) currentValues.add(shiftName);
        else currentValues.delete(shiftName);
        next[dayDef.key] = Array.from(currentValues);
      }
      return next;
    });
  }, []);

  const closeWorkerEditor = useCallback(() => {
    setEditorOpen(false);
    setEditingWorkerId(null);
    setNewWorkerName("");
    setNewWorkerMax(5);
    setNewWorkerRoles([]);
    setNewWorkerAvailability({ ...EMPTY_WORKER_AVAILABILITY });
    setOriginalAvailability({ ...EMPTY_WORKER_AVAILABILITY });
  }, []);

  const openWorkerEditor = useCallback(
    (row: WorkerRowForEditor) => {
      setCreateStepOpen(false);
      setExistingPickerOpen(false);
      const overlay = (availabilityOverlaysByWorkerName[String(row.name || "").trim()] || {}) as WorkerAvailability;
      const nextAvailability = cloneWorkerAvailability(row.availability);
      for (const d of DAY_DEFS) {
        const k = d.key;
        const merged = new Set<string>([...(nextAvailability[k] || []), ...((overlay[k] || []) as string[])]);
        nextAvailability[k] = Array.from(merged);
      }
      setEditingWorkerId(row.id);
      setNewWorkerName(row.name);
      setNewWorkerMax(row.maxShifts);
      setNewWorkerRoles((row.roles || []).filter((rn) => enabledRoleNameSet.has(String(rn || "").trim())));
      setOriginalAvailability(cloneWorkerAvailability(nextAvailability));
      setNewWorkerAvailability(nextAvailability);
      setEditorOpen(true);
    },
    [enabledRoleNameSet, availabilityOverlaysByWorkerName],
  );

  /** Même flux que le planning : d’abord la petite modale שם/טלפון, puis la grande (זמינות…). */
  const openAddWorkerEditor = useCallback(() => {
    setEditingWorkerId(null);
    setNewWorkerName("");
    setNewWorkerMax(5);
    setNewWorkerRoles([]);
    setNewWorkerAvailability({ ...EMPTY_WORKER_AVAILABILITY });
    setOriginalAvailability({ ...EMPTY_WORKER_AVAILABILITY });
    setEditorOpen(false);
    setExistingPickerOpen(false);
    setCreateStepOpen(true);
  }, []);

  const openExistingWorkerPicker = useCallback(() => {
    setCreateStepOpen(false);
    setExistingPickerOpen(true);
  }, []);

  const handleCreateStepContinue = useCallback(
    async (trimmedName: string, digitsPhone: string) => {
      const normalizePhoneDigits = (p: string | null | undefined) => String(p || "").replace(/\D/g, "").trim();
      const phoneN = normalizePhoneDigits(digitsPhone);
      const alreadyOnSite = workers.some((w) => normalizePhoneDigits(w.phone) === phoneN);
      if (alreadyOnSite) {
        toast.error("העובד כבר קיים באתר");
        return;
      }

      let userCreated = false;
      try {
        try {
          await apiFetch(`/director/sites/${siteId}/create-worker-user`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${localStorage.getItem("access_token")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: trimmedName,
              phone: digitsPhone,
            }),
          });
          userCreated = true;
        } catch (userError: unknown) {
          const err = userError as { status?: number; message?: string };
          const errorStatus = err?.status || 0;
          const errorMsg = String(err?.message || "").toLowerCase();
          const isPhoneAlreadyUsed =
            errorStatus === 400 ||
            errorMsg.includes("téléphone") ||
            errorMsg.includes("telephone") ||
            errorMsg.includes("déjà") ||
            errorMsg.includes("deja") ||
            errorMsg.includes("déjà enregistré") ||
            errorMsg.includes("already");
          if (!isPhoneAlreadyUsed) throw userError;
        }

        const createdWorker = await apiFetch<Record<string, unknown>>(`/director/sites/${siteId}/workers`, {
          method: "POST",
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          body: JSON.stringify({
            name: trimmedName,
            phone: digitsPhone,
            max_shifts: 5,
            roles: [] as string[],
            availability: {},
          }),
        });

        const newId = Number(createdWorker.id);
        setCreateStepOpen(false);
        setEditingWorkerId(newId);
        setNewWorkerName(trimmedName);
        setNewWorkerMax(5);
        setNewWorkerRoles([]);
        setOriginalAvailability({ ...EMPTY_WORKER_AVAILABILITY });
        setNewWorkerAvailability({ ...EMPTY_WORKER_AVAILABILITY });
        setEditorOpen(true);
        if (userCreated) {
          toast.success("עובד נוצר בהצלחה!");
        } else {
          toast.info("משתמש קיים כבר, הוסף את העובד לאתר");
        }
        void reloadWorkers();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "";
        toast.error("שגיאה ביצירת עובד", { description: msg || "נסה שוב מאוחר יותר." });
      }
    },
    [reloadWorkers, siteId, workers],
  );

  const handleDeleteWorker = useCallback(async () => {
    const wid = editingWorkerId;
    if (!wid) return;
    if (!confirm(`להסיר את ${newWorkerName} מהשבוע הנבחר והלאה?`)) return;
    setDeletingId(wid);
    try {
      const weekIso = getWeekKeyISO(weekStart);
      await apiFetch(`/director/sites/${siteId}/workers/${wid}?week=${encodeURIComponent(weekIso)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
      });
      toast.success("העובד הוסר מהשבוע הנבחר והלאה");
      closeWorkerEditor();
      reloadWorkers();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "נסה שוב מאוחר יותר.";
      toast.error("שגיאה במחיקה", { description: msg });
    } finally {
      setDeletingId(null);
    }
  }, [closeWorkerEditor, editingWorkerId, newWorkerName, reloadWorkers, siteId, weekStart]);

  const handleSaveWorker = useCallback(async () => {
    if (workerModalSaving) return;
    const trimmed = newWorkerName.trim();
    if (!trimmed) {
      toast.info("נא להזין שם");
      return;
    }
    const DUP_MSG = "שם עובד כבר קיים באתר";

    if (!editingWorkerId) {
      if (currentWeekWorkersForEditor.some((w) => (w.name || "").trim().toLowerCase() === trimmed.toLowerCase())) {
        toast.info(DUP_MSG);
        return;
      }
    } else {
      if (
        currentWeekWorkersForEditor.some(
          (w) => w.id !== editingWorkerId && (w.name || "").trim().toLowerCase() === trimmed.toLowerCase(),
        )
      ) {
        toast.info(DUP_MSG);
        return;
      }
    }

    setWorkerModalSaving(true);
    try {
      if (editingWorkerId) {
        const currentWorker = editingWorkerResolved;
        if (!currentWorker) return;

        const availabilityChanged = isAvailabilityDayShiftChanged(
          originalAvailability || EMPTY_WORKER_AVAILABILITY,
          newWorkerAvailability || EMPTY_WORKER_AVAILABILITY,
        );
        const maxShiftsChanged = Number(currentWorker.maxShifts ?? 0) !== Number(newWorkerMax || 0);
        const normalizeRoles = (roles: string[]) =>
          Array.from(new Set((roles || []).map((r) => String(r || "").trim()).filter(Boolean))).sort();
        const rolesBefore = normalizeRoles(Array.isArray(currentWorker.roles) ? currentWorker.roles : []);
        const rolesAfter = normalizeRoles(newWorkerRoles);
        const rolesChanged = JSON.stringify(rolesBefore) !== JSON.stringify(rolesAfter);

        const linkedSiteNames: string[] = Array.isArray(currentWorker.linkedSiteNames)
          ? currentWorker.linkedSiteNames || []
          : [];
        const linkedOtherSiteNames = linkedSiteNames.filter((n) => String(n) !== String(site?.name || ""));

        const submitEditedWorker = async (propagateLinkedAvailability: boolean) => {
          const updated = await apiFetch<Record<string, unknown>>(`/director/sites/${siteId}/workers/${editingWorkerId}`, {
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
          void updated;
          await persistWorkerNameWeeklyOverride(siteId, weekStart, trimmed, newWorkerAvailability);
          toast.success("עובד עודכן בהצלחה!");
          setOriginalAvailability(cloneWorkerAvailability(newWorkerAvailability));
          closeWorkerEditor();
          reloadWorkers();
        };

        if (availabilityChanged && linkedOtherSiteNames.length > 0) {
          pendingLinkedAvailabilitySaveRef.current = submitEditedWorker;
          setLinkedAvailabilityConfirmSites(linkedOtherSiteNames);
          return;
        }

        await submitEditedWorker(false);
        return;
      }

      const result = await apiFetch<Record<string, unknown>>(`/director/sites/${siteId}/workers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        body: JSON.stringify({
          name: trimmed,
          phone: null,
          max_shifts: newWorkerMax,
          roles: newWorkerRoles,
          availability: newWorkerAvailability,
        }),
      });
      void result;
      await persistWorkerNameWeeklyOverride(siteId, weekStart, trimmed, newWorkerAvailability);
      toast.success("עובד נוסף בהצלחה!");
      closeWorkerEditor();
      reloadWorkers();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      toast.error("שמירה נכשלה", { description: msg || "נסה שוב מאוחר יותר." });
    } finally {
      setWorkerModalSaving(false);
    }
  }, [
    closeWorkerEditor,
    currentWeekWorkersForEditor,
    editingWorkerId,
    editingWorkerResolved,
    newWorkerAvailability,
    newWorkerMax,
    newWorkerName,
    newWorkerRoles,
    originalAvailability,
    reloadWorkers,
    site?.name,
    siteId,
    weekStart,
  ]);

  const closeFilterModal = useCallback(() => {
    setFilterOpen(false);
    setQuestionFilters({});
    setFilterByWorkDays(false);
    setQuestionVisibility({});
  }, []);

  return {
    setFilterOpen,
    closeFilterModal,
    filterModalProps: {
      open: filterOpen,
      onClose: closeFilterModal,
      workers,
      site,
      weekStart,
      questionFilters,
      setQuestionFilters,
      filterByWorkDays,
      setFilterByWorkDays,
      questionVisibility,
      setQuestionVisibility,
      isSavedMode: false,
      savedWeekPlan: null,
      displayedPullsByHoleKey: {},
    },
    openWorkerEditor,
    openAddWorkerEditor,
    createWorkerStepModalProps: {
      open: createStepOpen,
      onClose: () => setCreateStepOpen(false),
      onOpenExistingPicker: openExistingWorkerPicker,
      initialName: "",
      initialPhone: "",
      onContinue: handleCreateStepContinue,
    },
    existingWorkersPickerModalProps: {
      open: existingPickerOpen,
      onClose: () => setExistingPickerOpen(false),
      siteId,
      onAdded: () => void reloadWorkers(),
    },
    workerEditModalProps: {
      open: editorOpen,
      onClose: closeWorkerEditor,
      editingWorkerId,
      newWorkerName,
      onNewWorkerNameChange: setNewWorkerName,
      newWorkerMax,
      onNewWorkerMaxChange: setNewWorkerMax,
      newWorkerRoles,
      onToggleRole: (roleName: string, checked: boolean) => {
        setNewWorkerRoles((prev) => (checked ? [...prev, roleName] : prev.filter((x) => x !== roleName)));
      },
      allRoleNames,
      editingWorkerLinkedSiteNames,
      dayDefs: DAY_DEFS,
      allShiftNames,
      newWorkerAvailability,
      onToggleAvailability: toggleNewAvailability,
      onToggleAvailabilityForAllDays: toggleWorkerAvailabilityForAllDays,
      workerModalShiftBuckets,
      workerModalBulkSelection,
      workerModalQuestionView,
      workerAvailabilityOverlay:
        (availabilityOverlaysByWorkerName[String(editingWorkerResolved?.name || newWorkerName || "").trim()] as
          | Record<string, string[]>
          | undefined) || {},
      showRestoreAvailabilityButton: isNextWeekDisplayed(weekStart),
      onRestoreAvailability: () => {
        // Restaurer depuis la disponibilité "source worker" (menu עובדים),
        // pas depuis l’état mergé/édité courant de la modale.
        const base =
          (editingWorkerResolved?.availability as WorkerAvailability | undefined) ||
          originalAvailability ||
          EMPTY_WORKER_AVAILABILITY;
        setNewWorkerAvailability(cloneWorkerAvailability(base));
        toast.info("הזמינות חזרה להגדרת העובד מהמערכת");
      },
      showDeleteButton: !!editingWorkerId,
      deleteDisabled: deletingId === editingWorkerId,
      onDelete: handleDeleteWorker,
      workerModalSaving,
      onSave: handleSaveWorker,
    },
    linkedDialogProps: {
      open: !!linkedAvailabilityConfirmSites && linkedAvailabilityConfirmSites.length > 0,
      siteNames: linkedAvailabilityConfirmSites || [],
      onCancel: () => {
        pendingLinkedAvailabilitySaveRef.current = null;
        setLinkedAvailabilityConfirmSites(null);
      },
      onConfirm: async () => {
        const run = pendingLinkedAvailabilitySaveRef.current;
        pendingLinkedAvailabilitySaveRef.current = null;
        setLinkedAvailabilityConfirmSites(null);
        setWorkerModalSaving(true);
        try {
          if (run) await run(true);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "";
          toast.error("שמירה נכשלה", { description: msg || "נסה שוב מאוחר יותר." });
        } finally {
          setWorkerModalSaving(false);
        }
      },
    },
    onTableRowClick: openWorkerEditor,
  };
}

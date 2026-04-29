"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import type { WorkerAvailability } from "../types";
import { EMPTY_WORKER_AVAILABILITY } from "../lib/constants";
import { getWeekKeyISO } from "../lib/week";

type ExistingWorkerEntry = {
  id: number;
  siteId: number;
  siteName: string;
  name: string;
  phone?: string | null;
  maxShifts: number;
  roles: string[];
  availability: WorkerAvailability;
  removedFromWeekIso?: string | null;
  removedByPlanning?: boolean;
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
  "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:border-amber-950/40 dark:text-amber-300",
  "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300",
  "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-300",
];

function normalizePhoneDigits(value: string | null | undefined) {
  return String(value || "").replace(/\D/g, "").trim();
}

type ExistingWorkersPickerModalProps = {
  open: boolean;
  onClose: () => void;
  siteId: string;
  weekStart: Date;
  onAdded: () => void;
};

/** Modale « הוספת עובד קיים » — même contenu que le planning director. */
export function ExistingWorkersPickerModal({ open, onClose, siteId, weekStart, onAdded }: ExistingWorkersPickerModalProps) {
  const [existingWorkersLoading, setExistingWorkersLoading] = useState(false);
  const [existingWorkerQuery, setExistingWorkerQuery] = useState("");
  const [existingWorkerAddingKey, setExistingWorkerAddingKey] = useState<string | null>(null);
  const [existingWorkersCatalog, setExistingWorkersCatalog] = useState<ExistingWorkerEntry[]>([]);

  const getExistingWorkerBadgeClassName = useCallback((id: number) => {
    const normalizedId = Math.abs(Number(id) || 0);
    return SITE_BADGE_COLORS[normalizedId % SITE_BADGE_COLORS.length];
  }, []);

  const loadExistingWorkersCatalog = useCallback(async () => {
    setExistingWorkersLoading(true);
    try {
      const [allWorkersList, sitesList] = await Promise.all([
        apiFetch<Record<string, unknown>[]>("/director/sites/all-workers", {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          cache: "no-store" as RequestCache,
        }),
        apiFetch<Record<string, unknown>[]>("/director/sites/", {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          cache: "no-store" as RequestCache,
        }),
      ]);
      const siteNameById = new Map<number, string>(
        (sitesList || []).map((siteItem) => [
          Number(siteItem.id),
          String(siteItem.name || `אתר #${siteItem.id}`),
        ]),
      );
      const nextCatalog: ExistingWorkerEntry[] = (allWorkersList || []).map((workerItem) => ({
        id: Number(workerItem.id),
        siteId: Number(workerItem.site_id),
        siteName: siteNameById.get(Number(workerItem.site_id)) || `אתר #${workerItem.site_id}`,
        name: String(workerItem.name || ""),
        phone: (workerItem.phone as string | null | undefined) ?? null,
        maxShifts: Number(workerItem.max_shifts ?? workerItem.maxShifts ?? 5),
        roles: Array.isArray(workerItem.roles) ? (workerItem.roles as string[]) : [],
        availability: (workerItem.availability as WorkerAvailability) || { ...EMPTY_WORKER_AVAILABILITY },
        removedFromWeekIso: (workerItem.removed_from_week_iso as string | null | undefined) ?? null,
        removedByPlanning: Boolean(workerItem.removed_by_planning),
      }));
      setExistingWorkersCatalog(nextCatalog);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      toast.error("שגיאה בטעינת עובדים קיימים", { description: msg || undefined });
    } finally {
      setExistingWorkersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setExistingWorkerQuery("");
      void loadExistingWorkersCatalog();
    }
  }, [open, loadExistingWorkersCatalog]);

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

  const addExistingWorkerToSite = async (worker: GroupedExistingWorker) => {
    if (!worker.entries.length) return;
    const selectedWeekIso = getWeekKeyISO(weekStart);
    const alreadyOnSite = worker.entries.some((entry) => {
      if (Number(entry.siteId) !== Number(siteId)) return false;
      const removedIso = String(entry.removedFromWeekIso || "").trim();
      // Autoriser la réactivation si le worker est supprimé à partir de la semaine sélectionnée.
      if (removedIso && selectedWeekIso >= removedIso) return false;
      return true;
    });
    if (alreadyOnSite) {
      toast.error("העובד כבר קיים באתר");
      return;
    }
    const sourceEntry = worker.entries[0];
    setExistingWorkerAddingKey(worker.key);
    try {
      await apiFetch(`/director/sites/${siteId}/workers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        body: JSON.stringify({
          name: worker.name,
          phone: worker.phone ?? null,
          max_shifts: sourceEntry.maxShifts || 5,
          roles: Array.isArray(sourceEntry.roles) ? sourceEntry.roles : [],
          availability: sourceEntry.availability || {},
          week_iso: getWeekKeyISO(weekStart),
        }),
      });
      onClose();
      setExistingWorkerQuery("");
      await loadExistingWorkersCatalog();
      onAdded();
      toast.success("העובד נוסף לאתר");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      toast.error("שגיאה בהוספת עובד קיים", { description: msg || undefined });
    } finally {
      setExistingWorkerAddingKey(null);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex h-[72vh] h-[72dvh] w-full max-w-3xl min-h-0 flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900 md:h-[34rem]">
        <div className="border-b border-zinc-200 bg-white/95 p-3 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/95 md:p-4">
          <div className="relative flex items-center justify-center">
            <h3 className="text-center text-base font-semibold md:text-lg">הוספת עובד קיים</h3>
            <button
              type="button"
              onClick={() => onClose()}
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
        <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
          {existingWorkersLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500">טוען עובדים...</div>
          ) : filteredExistingWorkers.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500">לא נמצאו עובדים</div>
          ) : (
            <div className="space-y-3">
              {filteredExistingWorkers.map((worker) => {
                const selectedWeekIso = getWeekKeyISO(weekStart);
                const existingOnSiteEntry = worker.entries.find((entry) => Number(entry.siteId) === Number(siteId));
                const removedIso = String(existingOnSiteEntry?.removedFromWeekIso || "").trim();
                const canReactivateFromSelectedWeek = !!existingOnSiteEntry && !!removedIso && selectedWeekIso >= removedIso;
                const alreadyOnSite = !!existingOnSiteEntry && !canReactivateFromSelectedWeek;
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
                          onClick={() => void addExistingWorkerToSite(worker)}
                          className={`rounded-md px-3 py-2 text-sm font-medium ${
                            alreadyOnSite
                              ? "cursor-not-allowed border border-zinc-200 bg-zinc-100 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-600"
                              : "bg-[#00A8E0] text-white hover:bg-[#0092c6]"
                          }`}
                        >
                          {alreadyOnSite
                            ? "כבר באתר"
                            : isAdding
                              ? "מוסיף..."
                              : canReactivateFromSelectedWeek
                                ? "החזר"
                                : "הוסף"}
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
  );
}

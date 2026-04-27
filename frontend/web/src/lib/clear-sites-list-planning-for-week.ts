/**
 * Données liées à une הרצה depuis רשימת אתרים (badges / compteurs côté client + טיוטות auto en base).
 * À invalider avant une יצירת תכנון depuis la page planning pour éviter mélange d’états.
 */

import { apiFetch } from "@/lib/api";

export const AUTO_WEEKLY_WORKER_CHANGES_STORAGE_KEY = "auto_weekly_worker_changes_v1";

export function clearAutoWeeklyWorkerChangesLocalStorageForWeek(weekIso: string): void {
  const wk = String(weekIso || "").trim();
  if (!wk || typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(AUTO_WEEKLY_WORKER_CHANGES_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || !parsed[wk]) return;
    delete parsed[wk];
    localStorage.setItem(AUTO_WEEKLY_WORKER_CHANGES_STORAGE_KEY, JSON.stringify(parsed));
    try {
      window.dispatchEvent(new CustomEvent("auto-planning-worker-changes-updated"));
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

/** Supprime les טיוטות auto (scope=auto) pour la semaine — aligné sur planning legacy. */
export async function deleteAutoScopeWeekPlansForSites(weekIso: string, siteIds: number[]): Promise<void> {
  const wk = String(weekIso || "").trim();
  if (!wk) return;
  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
  if (!token) return;
  const uniq = [...new Set(siteIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
  await Promise.all(
    uniq.map(async (sid) => {
      try {
        await apiFetch<unknown>(
          `/director/sites/${sid}/week-plan?week=${encodeURIComponent(wk)}&scope=auto`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          },
        );
      } catch {
        /* ignore: pas de טיוטה ou déjà supprimée */
      }
    }),
  );
}

/** Nettoie ce qu’une ריצה depuis la liste sites a laissé pour cette semaine / ces sites. */
export async function clearSitesListPlanningBeforePlanningCreat(
  weekIso: string,
  siteIds: number[],
): Promise<void> {
  clearAutoWeeklyWorkerChangesLocalStorageForWeek(weekIso);
  await deleteAutoScopeWeekPlansForSites(weekIso, siteIds);
}

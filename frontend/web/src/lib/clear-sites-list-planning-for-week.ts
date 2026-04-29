/**
 * Données liées à une הרצה depuis רשימת אתרים (badges / compteurs côté client + טיוטות auto en base).
 * À invalider avant une יצירת תכנון depuis la page planning pour éviter mélange d’états.
 */

import { apiFetch } from "@/lib/api";

export const AUTO_WEEKLY_WORKER_CHANGES_STORAGE_KEY = "auto_weekly_worker_changes_v1";

function normalizeSiteIds(siteIds: number[]): number[] {
  return [...new Set(siteIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
}

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

/**
 * Supprime les clés localStorage hebdo utilisées par l'affichage planning (legacy/v2):
 * - `plan_${siteId}_${weekIso}`
 * - `plan_director_${siteId}_${weekIso}`
 * - `plan_shared_${siteId}_${weekIso}`
 * pour les sites demandés + la semaine ciblée.
 */
export function clearWeeklyPlanLocalStorageKeysForWeekAndSites(weekIso: string, siteIds: number[]): void {
  const wk = String(weekIso || "").trim();
  if (!wk || typeof window === "undefined") return;
  try {
    const normalizedIds = normalizeSiteIds(siteIds);
    const removedKeys: string[] = [];
    normalizedIds.forEach((sid) => {
      const suffix = `${sid}_${wk}`;
      const keys = [`plan_${suffix}`, `plan_director_${suffix}`, `plan_shared_${suffix}`];
      keys.forEach((key) => {
        try {
          localStorage.removeItem(key);
          removedKeys.push(key);
        } catch {
          /* ignore */
        }
      });
    });
    if (removedKeys.length > 0) {
      console.debug("[planning-v2][cache][generate] removed weekly plan localStorage keys:", {
        weekIso: wk,
        siteIds: normalizedIds,
        keys: removedKeys,
      });
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
  const uniq = normalizeSiteIds(siteIds);
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
  console.debug("[planning-v2][cache][generate] clear before create plan:", {
    weekIso,
    siteIds: normalizeSiteIds(siteIds),
  });
  clearAutoWeeklyWorkerChangesLocalStorageForWeek(weekIso);
  clearWeeklyPlanLocalStorageKeysForWeekAndSites(weekIso, siteIds);
  await deleteAutoScopeWeekPlansForSites(weekIso, siteIds);
}

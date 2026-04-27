/**
 * Caches sessionStorage du planning multi-sites / יצירת תכנון (pages /director/planning*).
 * Ne concerne pas le localStorage de la liste des sites (ex. auto_weekly_worker_changes_v1).
 * Purge hebdo : après le dernier samedi 23:59:59 local écoulé (fin de semaine).
 */

const SESSION_PREFIXES = [
  "multi_site_generated_",
  "multi_site_generating_",
  "multi_site_assignment_filters_",
  "multi_site_saved_edit_",
  "multi_site_navigation_log_",
  "multi_site_site_cache_",
  "multi_site_workers_cache_",
  "multi_site_linked_sites_cache_",
] as const;

const MULTI_SITE_NAV_FLAG = "multi_site_navigation_in_app";

export const PLANNING_WEEKLY_PURGE_LAST_BOUNDARY_MS_KEY = "planning_weekly_purge_last_sat_end_ms";

/** Dans le navigateur, `setInterval` renvoie un `number` ; éviter `NodeJS.Timeout` du typage Node. */
let weeklyPurgeIntervalId: number | null = null;

function clearMultiSitePlanningSessionStorageCore(): void {
  if (typeof window === "undefined") return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (!key) continue;
      if (key === MULTI_SITE_NAV_FLAG) {
        keysToRemove.push(key);
        continue;
      }
      if (SESSION_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => {
      try {
        sessionStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    });
    queueMicrotask(() => {
      try {
        window.dispatchEvent(new CustomEvent("linked-plans-memory-updated", { detail: { reason: "session-cache-cleared" } }));
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

/** Vide les brouillons sessionStorage du planning (יצירת תכנון, multi-sites). */
export function clearAllPlanningSessionCaches(): void {
  clearMultiSitePlanningSessionStorageCore();
}

/**
 * À appeler uniquement lors de la **déconnexion** utilisateur : supprime les caches
 * de יצירת תכנון depuis le planning (clés multi_site en session). Ne modifie pas
 * le localStorage utilisé par la liste des sites (ex. suivi hebdo auto_weekly_worker_changes).
 */
export function clearPlanningCreatPlanSessionStorageOnLogout(): void {
  clearMultiSitePlanningSessionStorageCore();
}

/**
 * Dernier instant samedi 23:59:59.999 local dont la fin est **strictement dépassée** par `ref`
 * (après cette borne, une nouvelle « semaine » commence pour la purge hebdo).
 */
export function getLastPassedSaturdayEndMs(ref: Date = new Date()): number {
  const refMs = ref.getTime();
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 23, 59, 59, 999);
  const dow = ref.getDay();
  const daysToSaturday = (dow - 6 + 7) % 7;
  d.setDate(d.getDate() - daysToSaturday);
  const thisSatEnd = d.getTime();
  if (refMs > thisSatEnd) {
    return thisSatEnd;
  }
  d.setDate(d.getDate() - 7);
  return d.getTime();
}

/** Si une nouvelle fin de semaine (samedi 23:59) est passée depuis la dernière purge, nettoie les caches. */
export function maybePurgePlanningSessionCachesAfterWeeklyBoundary(): void {
  if (typeof window === "undefined") return;
  try {
    const boundary = getLastPassedSaturdayEndMs(new Date());
    const last = Number(localStorage.getItem(PLANNING_WEEKLY_PURGE_LAST_BOUNDARY_MS_KEY) || "0");
    if (!Number.isFinite(boundary) || boundary <= 0) return;
    if (Number.isFinite(last) && last >= boundary) return;
    clearAllPlanningSessionCaches();
    localStorage.setItem(PLANNING_WEEKLY_PURGE_LAST_BOUNDARY_MS_KEY, String(boundary));
  } catch {
    /* ignore */
  }
}

/** Une seule minuterie globale : contrôle hebdo + purge si besoin. */
export function ensurePlanningWeeklyCachePurgeScheduled(): void {
  if (typeof window === "undefined" || weeklyPurgeIntervalId !== null) return;
  maybePurgePlanningSessionCachesAfterWeeklyBoundary();
  weeklyPurgeIntervalId = window.setInterval(() => {
    maybePurgePlanningSessionCachesAfterWeeklyBoundary();
  }, 60_000);
}

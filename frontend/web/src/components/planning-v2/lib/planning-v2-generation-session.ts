/** SessionStorage + CustomEvents pour unlock חלופות et génération multi-site partagée. */

const PLANNING_V2_ALTERNATIVES_UNLOCK_PREFIX = "planning_v2_alternatives_unlock_";
const PLANNING_V2_LINKED_GENERATION_PREFIX = "planning_v2_linked_generation_";
const PLANNING_V2_LINKED_GENERATION_STOP_PREFIX = "planning_v2_linked_generation_stop_";
const PLANNING_V2_LINKED_GENERATION_STOP_VISIBLE_PREFIX = "planning_v2_linked_generation_stop_visible_";

export const PLANNING_V2_LINKED_GENERATION_UPDATED_EVENT = "planning-v2-linked-generation-updated";
export const PLANNING_V2_LINKED_GENERATION_STOP_UPDATED_EVENT = "planning-v2-linked-generation-stop-updated";

function alternativesUnlockSessionKey(weekIso: string, siteId: string) {
  return `${PLANNING_V2_ALTERNATIVES_UNLOCK_PREFIX}${weekIso}_${siteId}`;
}

export function readAlternativesUnlockedFromSession(weekIso: string, siteId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(alternativesUnlockSessionKey(weekIso, siteId)) === "1";
  } catch {
    return false;
  }
}

export function writeAlternativesUnlockedToSession(weekIso: string, siteId: string) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(alternativesUnlockSessionKey(weekIso, siteId), "1");
    sessionStorage.setItem(alternativesUnlockSessionKey(weekIso, "*"), "1");
  } catch {
    /* ignore */
  }
}

export function readAlternativesUnlockedForWeek(weekIso: string): boolean {
  return readAlternativesUnlockedFromSession(weekIso, "*");
}

function linkedGenerationSessionKey(weekIso: string) {
  return `${PLANNING_V2_LINKED_GENERATION_PREFIX}${weekIso}`;
}

const PLANNING_V2_LINKED_GENERATION_ORIGIN_PREFIX = "planning_v2_linked_generation_origin_";

function linkedGenerationOriginSessionKey(weekIso: string) {
  return `${PLANNING_V2_LINKED_GENERATION_ORIGIN_PREFIX}${weekIso}`;
}

export function readLinkedGenerationOriginFromSession(weekIso: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(linkedGenerationOriginSessionKey(weekIso));
    const id = String(raw || "").trim();
    return id || null;
  } catch {
    return null;
  }
}

export function writeLinkedGenerationOriginToSession(weekIso: string, siteId: string | null) {
  if (typeof window === "undefined") return;
  try {
    const key = linkedGenerationOriginSessionKey(weekIso);
    if (!siteId) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, String(siteId));
  } catch {
    /* ignore */
  }
}

export function isViewingLinkedSiteDuringGeneration(
  originSiteId: string | null | undefined,
  currentSiteId: string,
  _generationActive?: boolean,
): boolean {
  const origin = String(originSiteId || "").trim();
  if (!origin) return false;
  return origin !== String(currentSiteId);
}

function linkedGenerationStopSessionKey(weekIso: string) {
  return `${PLANNING_V2_LINKED_GENERATION_STOP_PREFIX}${weekIso}`;
}

function linkedGenerationStopVisibleCountSessionKey(weekIso: string) {
  return `${PLANNING_V2_LINKED_GENERATION_STOP_VISIBLE_PREFIX}${weekIso}`;
}

export function readLinkedGenerationRunningFromSession(weekIso: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(linkedGenerationSessionKey(weekIso)) === "1";
  } catch {
    return false;
  }
}

export function readLinkedGenerationStopRequestFromSession(weekIso: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(linkedGenerationStopSessionKey(weekIso)) === "1";
  } catch {
    return false;
  }
}

export function readLinkedGenerationStopVisibleCountFromSession(weekIso: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(linkedGenerationStopVisibleCountSessionKey(weekIso));
    const value = raw == null ? NaN : Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.max(1, Math.trunc(value));
  } catch {
    return null;
  }
}

export function writeLinkedGenerationStopVisibleCountToSession(weekIso: string, visibleCount: number | null) {
  if (typeof window === "undefined") return;
  try {
    const key = linkedGenerationStopVisibleCountSessionKey(weekIso);
    if (visibleCount == null || !Number.isFinite(visibleCount) || visibleCount <= 0) {
      sessionStorage.removeItem(key);
    } else {
      sessionStorage.setItem(key, String(Math.max(1, Math.trunc(visibleCount))));
    }
  } catch {
    /* ignore */
  }
}

export function writeLinkedGenerationStopRequestToSession(weekIso: string, stopRequested: boolean) {
  if (typeof window === "undefined") return;
  try {
    const key = linkedGenerationStopSessionKey(weekIso);
    if (stopRequested) sessionStorage.setItem(key, "1");
    else sessionStorage.removeItem(key);
    queueMicrotask(() => {
      try {
        window.dispatchEvent(
          new CustomEvent(PLANNING_V2_LINKED_GENERATION_STOP_UPDATED_EVENT, { detail: { key, stopRequested } }),
        );
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

export function writeLinkedGenerationRunningToSession(weekIso: string, running: boolean) {
  if (typeof window === "undefined") return;
  try {
    const key = linkedGenerationSessionKey(weekIso);
    if (running) sessionStorage.setItem(key, "1");
    else sessionStorage.removeItem(key);
    queueMicrotask(() => {
      try {
        window.dispatchEvent(
          new CustomEvent(PLANNING_V2_LINKED_GENERATION_UPDATED_EVENT, { detail: { key, running } }),
        );
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

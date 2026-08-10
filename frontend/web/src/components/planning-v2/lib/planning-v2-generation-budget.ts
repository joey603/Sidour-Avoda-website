/** Budgets de génération AI (single / multi-site) + idle watches SSE. */

export const VISIBLE_ALTERNATIVES_BATCH_SIZE = 500;
/** Silence totale sans plan accepté (CP-SAT peut mettre longtemps avant la 1ère vague). */
export const GENERATION_ACCEPTED_IDLE_CLOSE_MS = 180_000;
/** Déjà des חלופות visibles, plus aucune nouvelle → arrêter יוצר/stop. */
export const GENERATION_PLATEAU_IDLE_CLOSE_MS = 15_000;
/** Rejets SSE répétés sans nouvelle חלופה visible → l’utilisateur voit que c’est fini. */
export const GENERATION_STAGNANT_NOISE_IDLE_MS = 8_000;
export const GENERATION_STAGNANT_NOISE_EVENTS = 15;

const GENERATION_SEARCH_NUM_ALTERNATIVES = 20000;
export const MULTI_SITE_GENERATION_NUM_ALTERNATIVES = GENERATION_SEARCH_NUM_ALTERNATIVES;
export const MULTI_SITE_GENERATION_TIME_LIMIT_SECONDS = 120;
export const SINGLE_SITE_GENERATION_NUM_ALTERNATIVES = GENERATION_SEARCH_NUM_ALTERNATIVES;
export const SINGLE_SITE_GENERATION_TIME_LIMIT_SECONDS = 120;
export const MULTI_SITE_GENERATION_MAX_NUM_ALTERNATIVES = GENERATION_SEARCH_NUM_ALTERNATIVES;
export const MULTI_SITE_GENERATION_MAX_TIME_LIMIT_SECONDS = 120;
export const SINGLE_SITE_GENERATION_MAX_NUM_ALTERNATIVES = GENERATION_SEARCH_NUM_ALTERNATIVES;
export const SINGLE_SITE_GENERATION_MAX_TIME_LIMIT_SECONDS = 120;

export function adjustedAppendGenerationBudget(linked: boolean, existingAlternativesCount: number) {
  const baseNum = linked ? MULTI_SITE_GENERATION_NUM_ALTERNATIVES : SINGLE_SITE_GENERATION_NUM_ALTERNATIVES;
  const baseTime = linked ? MULTI_SITE_GENERATION_TIME_LIMIT_SECONDS : SINGLE_SITE_GENERATION_TIME_LIMIT_SECONDS;
  const maxNum = linked ? MULTI_SITE_GENERATION_MAX_NUM_ALTERNATIVES : SINGLE_SITE_GENERATION_MAX_NUM_ALTERNATIVES;
  const maxTime = linked ? MULTI_SITE_GENERATION_MAX_TIME_LIMIT_SECONDS : SINGLE_SITE_GENERATION_MAX_TIME_LIMIT_SECONDS;
  const existing = Math.max(0, Math.trunc(Number(existingAlternativesCount || 0)));
  // `עוד` filtre les doublons côté client. On ajoute un buffer proportionnel au stock déjà vu
  // pour garder un effort de recherche comparable à une génération initiale.
  const nextNum = Math.min(maxNum, baseNum + existing);
  const nextTime = Math.min(maxTime, baseTime + Math.ceil(existing / Math.max(1, Math.ceil(baseNum / 4))));
  return {
    numAlternatives: nextNum,
    timeLimitSeconds: nextTime,
  };
}

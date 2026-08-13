/** Overlay plein écran : attendre le site / le plan / la חלופה partagée — pas la liste עובדים. */
export function shouldShowPlanningLoadingOverlay(opts: {
  workerModalSaving: boolean;
  generationRunning: boolean;
  siteLoading: boolean;
  hasSite: boolean;
  weekPlanLoading: boolean;
  hasCurrentPlan: boolean;
  multiSiteNavigationLoading: boolean;
}): boolean {
  if (opts.workerModalSaving) return false;
  // Changement d’אתר pendant יצירת תכנון : attendre le nouveau site (grille ≠ site d’origine).
  if (opts.siteLoading && !opts.hasSite) return true;
  if (opts.generationRunning) return false;
  if (opts.weekPlanLoading && !opts.hasCurrentPlan) return true;
  if (opts.multiSiteNavigationLoading) return true;
  return false;
}

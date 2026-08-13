import { shouldShowPlanningLoadingOverlay } from "@/components/planning-v2/lib/planning-v2-loading-overlay";

const idle = {
  workerModalSaving: false,
  generationRunning: false,
  siteLoading: false,
  hasSite: true,
  weekPlanLoading: false,
  hasCurrentPlan: true,
  multiSiteNavigationLoading: false,
};

describe("shouldShowPlanningLoadingOverlay", () => {
  it("n’attend pas les workers si le plan est déjà là", () => {
    expect(shouldShowPlanningLoadingOverlay(idle)).toBe(false);
  });

  it("garde l’overlay tant que le plan n’est pas chargé", () => {
    expect(
      shouldShowPlanningLoadingOverlay({
        ...idle,
        weekPlanLoading: true,
        hasCurrentPlan: false,
      }),
    ).toBe(true);
  });

  it("ne bloque pas un changement de semaine si le site est déjà connu", () => {
    expect(
      shouldShowPlanningLoadingOverlay({
        ...idle,
        siteLoading: true,
        hasSite: true,
        weekPlanLoading: true,
        hasCurrentPlan: true,
      }),
    ).toBe(false);
  });

  it("attend le site au premier chargement", () => {
    expect(
      shouldShowPlanningLoadingOverlay({
        ...idle,
        siteLoading: true,
        hasSite: false,
        weekPlanLoading: true,
        hasCurrentPlan: false,
      }),
    ).toBe(true);
  });

  it("garde l’overlay jusqu’à la חלופה partagée", () => {
    expect(
      shouldShowPlanningLoadingOverlay({
        ...idle,
        multiSiteNavigationLoading: true,
      }),
    ).toBe(true);
  });

  it("masque l’overlay pendant יצירת תכנון ou sauvegarde worker", () => {
    expect(shouldShowPlanningLoadingOverlay({ ...idle, generationRunning: true, weekPlanLoading: true, hasCurrentPlan: false })).toBe(
      false,
    );
    expect(shouldShowPlanningLoadingOverlay({ ...idle, workerModalSaving: true, weekPlanLoading: true, hasCurrentPlan: false })).toBe(
      false,
    );
  });

  it("attend le nouveau site pendant יצירת תכנון si l’אתר affiché ne correspond plus", () => {
    expect(
      shouldShowPlanningLoadingOverlay({
        ...idle,
        generationRunning: true,
        siteLoading: true,
        hasSite: false,
        weekPlanLoading: true,
        hasCurrentPlan: false,
      }),
    ).toBe(true);
  });
});

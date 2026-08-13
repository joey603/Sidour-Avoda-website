import {
  discardCachedAutoWeekPlans,
  discardUnsavedWeekArtifactsExcept,
  getCachedWeekPlan,
  retainUnsavedCachedWeekPlans,
  setCachedWeekPlan,
  shouldDiscardUnsavedOnPlanningNav,
} from "@/components/planning-v2/lib/week-nav-cache";
import { unsavedPlanKeepWeekIsos } from "@/components/planning-v2/lib/week";
import {
  clearLinkedPlansMemoryExcept,
  readLinkedPlansFromMemory,
  saveLinkedPlansToMemory,
} from "@/components/planning-v2/lib/multi-site-linked-memory";

const emptyAssignments = { sun: { "06-14": [[]] } };

describe("discardCachedAutoWeekPlans", () => {
  const weekIso = "2026-08-09";

  beforeEach(() => {
    retainUnsavedCachedWeekPlans([]);
  });

  it("oublie les טיוטות auto et garde director/shared", () => {
    setCachedWeekPlan("1", weekIso, {
      assignments: emptyAssignments,
      sourceScope: "auto",
    });
    setCachedWeekPlan("2", weekIso, {
      assignments: emptyAssignments,
      sourceScope: "director",
    });
    setCachedWeekPlan("3", weekIso, {
      assignments: emptyAssignments,
      sourceScope: "shared",
    });
    discardCachedAutoWeekPlans([1, 2, 3], weekIso);
    expect(getCachedWeekPlan("1", weekIso)).toBeUndefined();
    expect(getCachedWeekPlan("2", weekIso)?.sourceScope).toBe("director");
    expect(getCachedWeekPlan("3", weekIso)?.sourceScope).toBe("shared");
  });
});

describe("retainUnsavedCachedWeekPlans", () => {
  const current = "2026-08-16";
  const next = "2026-08-23";
  const other = "2026-08-09";

  afterEach(() => {
    retainUnsavedCachedWeekPlans([]);
  });

  it("oublie les unsaved / חלופות des autres semaines et garde la suivante", () => {
    retainUnsavedCachedWeekPlans([]);
    setCachedWeekPlan("1", other, {
      assignments: emptyAssignments,
      alternatives: [emptyAssignments],
      sourceScope: "auto",
    });
    setCachedWeekPlan("1", current, {
      assignments: emptyAssignments,
      alternatives: [emptyAssignments],
      sourceScope: "auto",
    });
    setCachedWeekPlan("1", next, {
      assignments: emptyAssignments,
      alternatives: [emptyAssignments],
      sourceScope: "auto",
    });
    setCachedWeekPlan("2", other, {
      assignments: emptyAssignments,
      sourceScope: "shared",
    });
    retainUnsavedCachedWeekPlans([current, next]);
    expect(getCachedWeekPlan("1", other)).toBeUndefined();
    expect(getCachedWeekPlan("2", other)?.sourceScope).toBe("shared");
    expect(getCachedWeekPlan("1", current)?.sourceScope).toBe("auto");
    expect(getCachedWeekPlan("1", next)?.alternatives).toHaveLength(1);
  });

  it("refuse de recacher une טיוטה d’une semaine non retenue", () => {
    retainUnsavedCachedWeekPlans([current, next]);
    setCachedWeekPlan("1", other, {
      assignments: emptyAssignments,
      sourceScope: "auto",
    });
    expect(getCachedWeekPlan("1", other)).toBeUndefined();
  });
});

describe("unsavedPlanKeepWeekIsos", () => {
  it("garde la semaine calendaire et la suivante, pas la semaine affichée +7", () => {
    const thursday = new Date(2026, 7, 13);
    expect(unsavedPlanKeepWeekIsos(thursday)).toEqual(["2026-08-09", "2026-08-16"]);
  });
});

describe("discardUnsavedWeekArtifactsExcept", () => {
  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("efface tous les unsaved au changement de semaine, garde director/shared", () => {
    localStorage.setItem("plan_1_2026-08-09", JSON.stringify({ assignments: emptyAssignments }));
    localStorage.setItem("plan_director_1_2026-08-09", JSON.stringify({ assignments: emptyAssignments }));
    sessionStorage.setItem("plan_1_2026-08-09", JSON.stringify({ assignments: emptyAssignments }));
    setCachedWeekPlan("1", "2026-08-09", {
      assignments: emptyAssignments,
      alternatives: [emptyAssignments],
      sourceScope: "auto",
    });
    setCachedWeekPlan("1", "2026-08-16", {
      assignments: emptyAssignments,
      sourceScope: "shared",
    });
    discardUnsavedWeekArtifactsExcept([]);
    expect(localStorage.getItem("plan_1_2026-08-09")).toBeNull();
    expect(sessionStorage.getItem("plan_1_2026-08-09")).toBeNull();
    expect(localStorage.getItem("plan_director_1_2026-08-09")).toBeTruthy();
    expect(getCachedWeekPlan("1", "2026-08-09")).toBeUndefined();
    expect(getCachedWeekPlan("1", "2026-08-16")?.sourceScope).toBe("shared");
  });
});

describe("clearLinkedPlansMemoryExcept", () => {
  const current = new Date(2026, 7, 16);
  const next = new Date(2026, 7, 23);
  const other = new Date(2026, 7, 9);

  afterEach(() => {
    sessionStorage.clear();
  });

  it("liste vide : efface toutes les semaines", () => {
    saveLinkedPlansToMemory(other, { "1": { assignments: emptyAssignments } }, 2);
    saveLinkedPlansToMemory(current, { "1": { assignments: emptyAssignments } }, 1);
    saveLinkedPlansToMemory(next, { "1": { assignments: emptyAssignments } }, 0);
    clearLinkedPlansMemoryExcept([]);
    expect(readLinkedPlansFromMemory(other)).toBeNull();
    expect(readLinkedPlansFromMemory(current)).toBeNull();
    expect(readLinkedPlansFromMemory(next)).toBeNull();
  });
});

describe("shouldDiscardUnsavedOnPlanningNav", () => {
  it("vide les unsaved à l’ouverture depuis la liste ou au changement de semaine", () => {
    expect(
      shouldDiscardUnsavedOnPlanningNav({
        firstLoad: true,
        weekChanged: false,
        siteChanged: false,
        inAppMultiSiteNav: false,
      }),
    ).toBe(true);
    expect(
      shouldDiscardUnsavedOnPlanningNav({
        firstLoad: false,
        weekChanged: true,
        siteChanged: false,
        inAppMultiSiteNav: false,
      }),
    ).toBe(true);
  });

  it("conserve la session multi-sites pendant פתח אתר", () => {
    expect(
      shouldDiscardUnsavedOnPlanningNav({
        firstLoad: true,
        weekChanged: false,
        siteChanged: false,
        inAppMultiSiteNav: true,
      }),
    ).toBe(false);
    expect(
      shouldDiscardUnsavedOnPlanningNav({
        firstLoad: false,
        weekChanged: false,
        siteChanged: true,
        inAppMultiSiteNav: true,
      }),
    ).toBe(false);
  });

  it("change de semaine même pendant une session פתח אתר", () => {
    expect(
      shouldDiscardUnsavedOnPlanningNav({
        firstLoad: false,
        weekChanged: true,
        siteChanged: false,
        inAppMultiSiteNav: true,
      }),
    ).toBe(true);
  });
});

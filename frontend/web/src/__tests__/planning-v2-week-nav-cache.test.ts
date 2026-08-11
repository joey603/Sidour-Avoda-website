import {
  discardCachedAutoWeekPlans,
  getCachedWeekPlan,
  setCachedWeekPlan,
} from "@/components/planning-v2/lib/week-nav-cache";

const emptyAssignments = { sun: { "06-14": [[]] } };

describe("discardCachedAutoWeekPlans", () => {
  const weekIso = "2026-08-09";

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

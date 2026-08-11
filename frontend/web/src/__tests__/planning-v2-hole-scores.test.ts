import {
  compareHoleScores,
  noonPullsCount,
  preferredPullsCount,
  shouldHoldPlanUntilPullTarget,
  type HoleScore,
} from "@/components/planning-v2/lib/planning-v2-hole-scores";

function score(partial: Partial<HoleScore>): HoleScore {
  return {
    holes: 0,
    assigned: 10,
    required: 10,
    pulls: 0,
    noonPulls: 0,
    ...partial,
  };
}

describe("compareHoleScores", () => {
  it("préfère un plan avec 2 משיכות quand 2 sont demandées", () => {
    const one = score({ pulls: 1, noonPulls: 1, holes: 2 });
    const two = score({ pulls: 2, noonPulls: 1, holes: 2 });
    expect(compareHoleScores(two, one, 2)).toBeLessThan(0);
    expect(compareHoleScores(one, two, 2)).toBeGreaterThan(0);
  });

  it("à nombre égal, préfère plus de משיכות צהריים", () => {
    const mixed = score({ pulls: 2, noonPulls: 1 });
    const noon = score({ pulls: 2, noonPulls: 2 });
    expect(compareHoleScores(noon, mixed, 2)).toBeLessThan(0);
  });

  it("préfère 0/1 משיכה si cela comble plus de trous", () => {
    const oneFilled = score({ pulls: 1, noonPulls: 1, holes: 0, assigned: 12 });
    const twoWithHoles = score({ pulls: 2, noonPulls: 2, holes: 2, assigned: 10 });
    expect(compareHoleScores(oneFilled, twoWithHoles, 2)).toBeLessThan(0);
  });

  it("avec préférence, un plan avec משיכות du kind demandé passe avant les autres", () => {
    const morning = score({ pulls: 1, noonPulls: 1, holes: 2 });
    const nightOnly = score({ pulls: 2, noonPulls: 0, holes: 2 });
    expect(compareHoleScores(morning, nightOnly, 2)).toBeLessThan(0);
  });
});

describe("shouldHoldPlanUntilPullTarget", () => {
  it("attend tant qu’il reste des trous et moins de N משיכות", () => {
    expect(shouldHoldPlanUntilPullTarget(score({ pulls: 1, holes: 2 }), 2)).toBe(true);
    expect(shouldHoldPlanUntilPullTarget(score({ pulls: 0, holes: 3 }), 2)).toBe(true);
  });

  it("n’attend pas si N est atteint ou s’il n’y a plus de trous", () => {
    expect(shouldHoldPlanUntilPullTarget(score({ pulls: 2, holes: 2 }), 2)).toBe(false);
    expect(shouldHoldPlanUntilPullTarget(score({ pulls: 1, holes: 0 }), 2)).toBe(false);
    expect(shouldHoldPlanUntilPullTarget(score({ pulls: 0, holes: 0 }), 2)).toBe(false);
  });

  it("préférence souple : n’attend pas un kind s’il n’y en a pas", () => {
    expect(shouldHoldPlanUntilPullTarget(score({ pulls: 2, noonPulls: 0, holes: 2 }), 2, ["night"])).toBe(false);
    expect(shouldHoldPlanUntilPullTarget(score({ pulls: 1, noonPulls: 0, holes: 2 }), 2, ["night"])).toBe(true);
  });
});

describe("noonPullsCount", () => {
  it("compte les clés dont le shift est צהריים", () => {
    expect(
      noonPullsCount({
        "sun|צהריים|0|1": {},
        "sun|לילה|0|1": {},
        "mon|14-22|0|1": {},
      }),
    ).toBe(2);
  });
});

describe("preferredPullsCount", () => {
  const pulls = {
    "sun|בוקר|0|1": {},
    "sun|צהריים|0|1": {},
    "sun|לילה|0|1": {},
  };

  it("mix (vide) = 0 — pas un score de gardes", () => {
    expect(preferredPullsCount(pulls, null)).toBe(0);
    expect(preferredPullsCount(pulls, [])).toBe(0);
  });

  it("compte seulement les משיכות du kind demandé", () => {
    expect(preferredPullsCount(pulls, ["night"])).toBe(1);
    expect(preferredPullsCount(pulls, ["morning", "noon"])).toBe(2);
  });
});

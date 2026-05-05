describe("resolveMaxShifts", () => {
  it("retombe sur 5 quand la valeur est absente", async () => {
    const { resolveMaxShifts } = await import("@/lib/max-shifts");
    expect(resolveMaxShifts(undefined, null)).toBe(5);
  });

  it("préserve 0 quand il est explicitement configuré", async () => {
    const { resolveMaxShifts } = await import("@/lib/max-shifts");
    expect(resolveMaxShifts(0, 5)).toBe(0);
  });

  it("utilise la première valeur numérique valide", async () => {
    const { resolveMaxShifts } = await import("@/lib/max-shifts");
    expect(resolveMaxShifts(undefined, "7", 5)).toBe(7);
  });
});

describe("resolveSharedAlternativeIndex", () => {
  it("retombe sur la dernière alternative dispo au lieu du plan de base", async () => {
    const { resolveSharedAlternativeIndex } = await import("@/components/planning-v2/lib/multi-site-linked-memory");
    expect(resolveSharedAlternativeIndex({ assignments: {}, alternatives: [{}, {}] }, 5)).toBe(2);
  });

  it("garde 0 pour le plan de base", async () => {
    const { resolveSharedAlternativeIndex } = await import("@/components/planning-v2/lib/multi-site-linked-memory");
    expect(resolveSharedAlternativeIndex({ assignments: {}, alternatives: [{}, {}] }, 0)).toBe(0);
  });
});

describe("buildPersistableLinkedPlans", () => {
  it("garde les alternatives multi-sites alignées au lieu de dédupliquer par site", async () => {
    const { buildPersistableLinkedPlans } = await import("@/components/planning-v2/lib/multi-site-linked-memory");
    const sharedAlt = { d1: { morning: [["test1"]] } };
    const onlySite11Alt = { d1: { morning: [["test2"]] } };
    const plans = buildPersistableLinkedPlans({
      "11": {
        assignments: { d1: { morning: [["base-11"]] } },
        alternatives: [sharedAlt, sharedAlt, onlySite11Alt],
        alternative_pulls: [{}, {}, {}],
      },
      "12": {
        assignments: { d1: { morning: [["base-12"]] } },
        alternatives: [sharedAlt, sharedAlt],
        alternative_pulls: [{}, {}],
      },
    });
    expect(plans["11"]?.alternatives).toHaveLength(1);
    expect(plans["12"]?.alternatives).toHaveLength(1);
    expect(plans["11"]?.alternatives?.[0]).toEqual(sharedAlt);
    expect(plans["12"]?.alternatives?.[0]).toEqual(sharedAlt);
  });
});

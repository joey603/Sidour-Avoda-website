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

describe("maxLinkedMemoryAlternativeCount / shouldHoldSharedAlternativeIndex", () => {
  const base = { sun: { "06-14": [["A"]] } };
  const alt = { sun: { "06-14": [["B"]] } };

  it("prend le plus grand nombre de חלופות parmi les אתרים", async () => {
    const { maxLinkedMemoryAlternativeCount } = await import(
      "@/components/planning-v2/lib/multi-site-linked-memory"
    );
    expect(
      maxLinkedMemoryAlternativeCount({
        activeAltIndex: 3,
        plansBySite: {
          "1": { assignments: base, alternatives: [alt, alt] },
          "2": { assignments: base, alternatives: [alt, alt, alt, alt] },
        },
      }),
    ).toBe(5);
  });

  it("conserve l’index partagé 4/55 au changement d’אתר", async () => {
    const { shouldHoldSharedAlternativeIndex, MULTI_SITE_NAV_FLAG } = await import(
      "@/components/planning-v2/lib/multi-site-linked-memory"
    );
    const mem = {
      activeAltIndex: 3,
      plansBySite: {
        "1": { assignments: base, alternatives: [alt, alt, alt] },
        "2": { assignments: base, alternatives: [alt, alt, alt] },
      },
    };
    expect(shouldHoldSharedAlternativeIndex(mem, 3)).toBe(true);
    sessionStorage.setItem(MULTI_SITE_NAV_FLAG, "1");
    expect(shouldHoldSharedAlternativeIndex({ activeAltIndex: 0, plansBySite: {} }, 3)).toBe(true);
    sessionStorage.removeItem(MULTI_SITE_NAV_FLAG);
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

describe("softNavigateToPlanningSite", () => {
  it("pose le flag multi-site et construit l’URL planning", async () => {
    const { softNavigateToPlanningSite, MULTI_SITE_NAV_FLAG, readMultiSiteNavigationInApp } = await import(
      "@/components/planning-v2/lib/multi-site-linked-memory"
    );
    sessionStorage.removeItem(MULTI_SITE_NAV_FLAG);
    const href = softNavigateToPlanningSite("34", "2026-08-16");
    expect(href).toBe("/director/planning/34?week=2026-08-16");
    expect(readMultiSiteNavigationInApp()).toBe(true);
  });
});

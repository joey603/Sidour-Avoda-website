import {
  anyPlanHasNonPreferredPulls,
  anyPlanHasPreferredPulls,
  firstNonExclusivePreferredIndex,
  hebrewPreferKindsLabel,
  planHasNonPreferredPulls,
  pullsPreferFallbackToastCopy,
  pullsPreferMixedAltsToastCopy,
} from "@/components/planning-v2/lib/planning-v2-pulls-prefer-notices";

const noon = { "sun|צהריים|0|1": {} };
const morning = { "sun|בוקר|0|1": {} };
const night = { "sun|לילה|0|1": {} };
const noonAndMorning = { ...noon, ...morning };

describe("hebrewPreferKindsLabel", () => {
  it("compose les labels hébreu", () => {
    expect(hebrewPreferKindsLabel(["noon"])).toBe("צהריים");
    expect(hebrewPreferKindsLabel(["morning", "noon"])).toBe("בוקר וצהריים");
    expect(hebrewPreferKindsLabel(["morning", "noon", "night"])).toBe("בוקר, צהריים ולילה");
  });
});

describe("planHasNonPreferredPulls", () => {
  it("ignore mix (pas de préférence) et les plans vides", () => {
    expect(planHasNonPreferredPulls(noonAndMorning, null)).toBe(false);
    expect(planHasNonPreferredPulls({}, ["noon"])).toBe(false);
  });

  it("détecte matin/nuit/mixte hors préférence צהריים", () => {
    expect(planHasNonPreferredPulls(noon, ["noon"])).toBe(false);
    expect(planHasNonPreferredPulls(morning, ["noon"])).toBe(true);
    expect(planHasNonPreferredPulls(noonAndMorning, ["noon"])).toBe(true);
  });
});

describe("firstNonExclusivePreferredIndex", () => {
  it("pointe la première חלופה qui n’est plus uniquement le kind préféré", () => {
    const maps = [noon, noon, noonAndMorning, morning, night];
    expect(firstNonExclusivePreferredIndex(maps, ["noon"])).toBe(2);
  });

  it("null si toutes les חלופות restent exclusives", () => {
    expect(firstNonExclusivePreferredIndex([noon, noon], ["noon"])).toBeNull();
  });

  it("0 si dès la base ce n’est plus uniquement la préférence", () => {
    expect(firstNonExclusivePreferredIndex([morning, night], ["noon"])).toBe(0);
  });
});

describe("anyPlanHasPreferredPulls / anyPlanHasNonPreferredPulls", () => {
  it("sert le toast fallback (aucune משיכה préférée, mais d’autres oui)", () => {
    const maps = [morning, night];
    expect(anyPlanHasPreferredPulls(maps, ["noon"])).toBe(false);
    expect(anyPlanHasNonPreferredPulls(maps, ["noon"])).toBe(true);
  });

  it("ne déclenche pas le fallback s’il existe au moins une משיכה préférée", () => {
    const maps = [noon, morning];
    expect(anyPlanHasPreferredPulls(maps, ["noon"])).toBe(true);
  });
});

describe("toast copy", () => {
  it("rappelle le fallback matin/midi", () => {
    const copy = pullsPreferFallbackToastCopy(["night"]);
    expect(copy.title).toContain("לילה");
    expect(copy.description).toContain("משמרות אחרות");
  });

  it("annonce la fin des חלופות uniquement préférées", () => {
    const copy = pullsPreferMixedAltsToastCopy(["noon"]);
    expect(copy.title).toContain("צהריים");
    expect(copy.title).toContain("מכאן והלאה");
  });
});

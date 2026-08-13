import {
  rankUnseenDraftPlans,
  viewedIndicesForPreferResplit,
  rankMorningNightPairsLast,
  type DraftAlternative,
} from "@/components/planning-v2/lib/planning-v2-draft-alternatives";

function plan(id: string, noonPulls: number): DraftAlternative {
  return {
    assignments: { [id]: { a: [[id]] } },
    pulls: noonPulls > 0 ? { [`sun|צהריים|0|${id}`]: {} } : { [`sun|בוקר|0|${id}`]: {} },
  };
}

function byNoonFirst(left: DraftAlternative, right: DraftAlternative): number {
  const score = (p: DraftAlternative) =>
    Object.keys(p.pulls || {}).some((k) => k.includes("צהריים")) ? 0 : 1;
  return score(left) - score(right);
}

describe("rankUnseenDraftPlans", () => {
  const a = plan("a", 0);
  const b = plan("b", 0);
  const c = plan("c", 1);
  const d = plan("d", 1);

  it("sans index vu : reclasse tout", () => {
    const next = rankUnseenDraftPlans([a, b, c, d], [], byNoonFirst);
    expect(next[0]).toBe(c);
    expect(next[1]).toBe(d);
    expect(next[next.length - 1]).toBe(b);
  });

  it("fige toutes les חלופות déjà vues, reclasse seulement le reste", () => {
    const e = plan("e", 0);
    const next = rankUnseenDraftPlans([a, b, e, d], [0, 1], byNoonFirst);
    expect(next[0]).toBe(a);
    expect(next[1]).toBe(b);
    expect(next[2]).toBe(d);
    expect(next[3]).toBe(e);
  });

  it("un slot non vu entre deux vus peut encore bouger", () => {
    const next = rankUnseenDraftPlans([a, b, c, d], [0, 2], byNoonFirst);
    expect(next[0]).toBe(a);
    expect(next[2]).toBe(c);
    expect(next[1]).toBe(d);
    expect(next[3]).toBe(b);
  });

  it("laisse inchangé un seul plan", () => {
    expect(rankUnseenDraftPlans([a], [0], byNoonFirst)).toEqual([a]);
  });
});

describe("viewedIndicesForPreferResplit", () => {
  it("laisse la 1re vue se reclasse tant qu’on n’a pas navigué", () => {
    const morning = plan("morning", 0);
    const noon = plan("noon", 1);
    const next = rankUnseenDraftPlans(
      [morning, noon],
      viewedIndicesForPreferResplit([0], 0, null),
      byNoonFirst,
    );
    expect(next[0]).toBe(noon);
    expect(next[1]).toBe(morning);
  });

  it("fige la 1re vue dès qu’une autre חלופה a été choisie", () => {
    const morning = plan("morning", 0);
    const noon = plan("noon", 1);
    const next = rankUnseenDraftPlans(
      [morning, noon],
      viewedIndicesForPreferResplit([0, 1], 1, 1),
      byNoonFirst,
    );
    expect(next[0]).toBe(morning);
    expect(next[1]).toBe(noon);
  });

  it("fige aussi la 1re vue si on y revient après navigation", () => {
    const morning = plan("morning", 0);
    const noon = plan("noon", 1);
    const next = rankUnseenDraftPlans(
      [morning, noon],
      viewedIndicesForPreferResplit([0], 0, 0),
      byNoonFirst,
    );
    expect(next[0]).toBe(morning);
    expect(next[1]).toBe(noon);
  });
});

describe("rankMorningNightPairsLast", () => {
  it("met à la fin les plans où quelqu’un a בוקר et לילה le même jour", () => {
    const clean: DraftAlternative = {
      assignments: { sun: { בוקר: [["A"]], לילה: [["B"]] } },
      pulls: {},
    };
    const sameDay: DraftAlternative = {
      assignments: { thu: { בוקר: [["Hanna"]], לילה: [["Hanna"]] } },
      pulls: {},
    };
    const next = rankMorningNightPairsLast([sameDay, clean, sameDay]);
    expect(next[0]).toBe(clean);
    expect(next[1]).toBe(sameDay);
    expect(next[2]).toBe(sameDay);
  });

  it("compte aussi une משיכה matin + שיבוץ nuit", () => {
    const clean: DraftAlternative = {
      assignments: { sun: { בוקר: [["A"]], לילה: [["B"]] } },
      pulls: {},
    };
    const viaPull: DraftAlternative = {
      assignments: { thu: { בוקר: [[]], לילה: [["Hanna"]] } },
      pulls: { "thu|בוקר|0|1": { before: { name: "Hanna" }, after: { name: "X" } } },
    };
    const next = rankMorningNightPairsLast([viaPull, clean]);
    expect(next[0]).toBe(clean);
    expect(next[1]).toBe(viaPull);
  });
});

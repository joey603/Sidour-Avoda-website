import {
  rankUnseenDraftPlans,
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

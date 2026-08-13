import { isViewingLinkedSiteDuringGeneration } from "@/components/planning-v2/lib/planning-v2-generation-session";

describe("isViewingLinkedSiteDuringGeneration", () => {
  it("reste sur le site d’origine pendant le SSE", () => {
    expect(isViewingLinkedSiteDuringGeneration("12", "12", true)).toBe(false);
  });

  it("affiche un autre אתר lié sans abort le SSE", () => {
    expect(isViewingLinkedSiteDuringGeneration("12", "34", true)).toBe(true);
  });

  it("garde l’autre אתר depuis la mémoire jusqu’au remount après fin/pause", () => {
    expect(isViewingLinkedSiteDuringGeneration("12", "34", false)).toBe(true);
  });

  it("ne s’applique pas sans origine", () => {
    expect(isViewingLinkedSiteDuringGeneration(null, "34", true)).toBe(false);
    expect(isViewingLinkedSiteDuringGeneration("", "34", true)).toBe(false);
  });
});

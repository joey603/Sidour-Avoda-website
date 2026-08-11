import { loadWeekPlanForSiteWeek, normalizeWeekPlan } from "@/components/planning-v2/lib/week-plan-fetch";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
}));

const { apiFetch } = require("@/lib/api") as { apiFetch: jest.Mock };

describe("loadWeekPlanForSiteWeek", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("fait un GET resolve base + alternatives au lieu du waterfall director/shared/auto", async () => {
    apiFetch.mockResolvedValue({
      assignments: { sun: {} },
      alternatives: [],
      _source_scope: "shared",
    });
    const plan = await loadWeekPlanForSiteWeek("12", "2026-08-09");
    expect(apiFetch).toHaveBeenCalledTimes(2);
    const urls = apiFetch.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(urls.every((url: string) => url.includes("scope=resolve"))).toBe(true);
    expect(urls.every((url: string) => !url.includes("prefer="))).toBe(true);
    expect(urls.some((url: string) => url.includes("parts=base"))).toBe(true);
    expect(urls.some((url: string) => url.includes("parts=alternatives"))).toBe(true);
    expect(plan?.sourceScope).toBe("shared");
  });

  it("passe prefer=director quand demandé", async () => {
    apiFetch.mockResolvedValue({
      assignments: { sun: {} },
      _source_scope: "director",
    });
    await loadWeekPlanForSiteWeek("12", "2026-08-09", "director");
    const urls = apiFetch.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(urls.every((url: string) => url.includes("prefer=director"))).toBe(true);
  });

  it("nav légère : GET auto base + alternatives", async () => {
    apiFetch.mockResolvedValue({ assignments: { sun: {} } });
    const plan = await loadWeekPlanForSiteWeek("12", "2026-08-09", null, { lightweightNav: true });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    const urls = apiFetch.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(urls.every((url: string) => url.includes("scope=auto"))).toBe(true);
    expect(plan?.sourceScope).toBe("auto");
  });

  it("fusionne les חלופות sans reclasse quand le backend omet les alts", async () => {
    const onBase = jest.fn();
    apiFetch.mockImplementation((path: string) => {
      if (String(path).includes("parts=base")) {
        return Promise.resolve({
          assignments: { sun: { "06-14": [["A"]] } },
          pulls: { p: 1 },
          _source_scope: "auto",
          _alts_omitted: true,
          _alts_count: 1,
        });
      }
      if (String(path).includes("parts=alternatives")) {
        return Promise.resolve({
          alternatives: [{ sun: { "06-14": [["B"]] } }],
          alternative_pulls: [{ q: 2 }],
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const plan = await loadWeekPlanForSiteWeek("12", "2026-08-09", null, { onBase });
    expect(onBase).toHaveBeenCalledTimes(1);
    expect(onBase.mock.calls[0][0].assignments).toEqual({ sun: { "06-14": [["A"]] } });
    expect(onBase.mock.calls[0][0].alternatives).toEqual([]);
    expect(plan?.assignments).toEqual({ sun: { "06-14": [["A"]] } });
    expect(plan?.alternatives).toEqual([{ sun: { "06-14": [["B"]] } }]);
    expect(plan?.alternativePulls).toEqual([{ q: 2 }]);
  });
});

describe("normalizeWeekPlan", () => {
  it("lit _source_scope sans l’exiger dans assignments", () => {
    const plan = normalizeWeekPlan({
      assignments: { sun: {} },
      _source_scope: "auto",
    });
    expect(plan?.sourceScope).toBe("auto");
  });
});

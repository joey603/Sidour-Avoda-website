import { loadWeekPlanForSiteWeek, normalizeWeekPlan } from "@/components/planning-v2/lib/week-plan-fetch";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
}));

const { apiFetch } = require("@/lib/api") as { apiFetch: jest.Mock };

describe("loadWeekPlanForSiteWeek", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("fait un seul GET resolve au lieu du waterfall director/shared/auto", async () => {
    apiFetch.mockResolvedValue({
      assignments: { sun: {} },
      alternatives: [],
      _source_scope: "shared",
    });
    const plan = await loadWeekPlanForSiteWeek("12", "2026-08-09");
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(String(apiFetch.mock.calls[0][0])).toContain("scope=resolve");
    expect(String(apiFetch.mock.calls[0][0])).not.toContain("prefer=");
    expect(plan?.sourceScope).toBe("shared");
  });

  it("passe prefer=director quand demandé", async () => {
    apiFetch.mockResolvedValue({
      assignments: { sun: {} },
      _source_scope: "director",
    });
    await loadWeekPlanForSiteWeek("12", "2026-08-09", "director");
    expect(String(apiFetch.mock.calls[0][0])).toContain("prefer=director");
  });

  it("nav légère : un GET auto seulement", async () => {
    apiFetch.mockResolvedValue({ assignments: { sun: {} } });
    const plan = await loadWeekPlanForSiteWeek("12", "2026-08-09", null, { lightweightNav: true });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(String(apiFetch.mock.calls[0][0])).toContain("scope=auto");
    expect(plan?.sourceScope).toBe("auto");
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

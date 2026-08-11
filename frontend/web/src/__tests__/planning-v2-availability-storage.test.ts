import {
  availabilityStorageKey,
  persistWorkerNameWeeklyOverride,
  writeWorkerWeeklyAvailabilityLocal,
} from "@/components/planning-v2/lib/availability-storage";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
}));

const { apiFetch } = require("@/lib/api") as { apiFetch: jest.Mock };

describe("writeWorkerWeeklyAvailabilityLocal", () => {
  const weekStart = new Date(2026, 7, 9);
  const siteId = "12";

  beforeEach(() => {
    localStorage.clear();
    apiFetch.mockReset();
  });

  it("retire l’ancien nom si le עובד a été renommé", () => {
    const key = availabilityStorageKey(siteId, weekStart);
    localStorage.setItem(key, JSON.stringify({ Old: { sun: ["06-14"] } }));
    const next = writeWorkerWeeklyAvailabilityLocal(
      siteId,
      weekStart,
      "New",
      { sun: ["06-14"], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
      "Old",
    );
    expect(next.Old).toBeUndefined();
    expect(next.New.sun).toEqual(["06-14"]);
  });

  it("fusionne un עובד sans appeler l’API", () => {
    const key = availabilityStorageKey(siteId, weekStart);
    localStorage.setItem(key, JSON.stringify({ Other: { sun: ["06-14"] } }));
    const next = writeWorkerWeeklyAvailabilityLocal(siteId, weekStart, "Yoel", {
      sun: ["14-22"],
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
    });
    expect(next.Other).toEqual({ sun: ["06-14"] });
    expect(next.Yoel.sun).toEqual(["14-22"]);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("persistWorkerNameWeeklyOverride n’envoie plus le PUT global", async () => {
    await persistWorkerNameWeeklyOverride(siteId, weekStart, "Yoel", {
      sun: ["06-14"],
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

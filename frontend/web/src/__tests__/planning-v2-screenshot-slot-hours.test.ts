// @hebcal/core est ESM-only et n'est pas résolvable par jest ; l'export צילום ne
// l'utilise que pour les fêtes du calcul salaire, hors périmètre de ce test.
jest.mock(
  "@hebcal/core",
  () => ({
    HebrewCalendar: { calendar: () => [] },
    HDate: class {},
    Location: { lookup: () => null },
    flags: {},
  }),
  { virtual: true },
);

import { buildPlanningScheduleWeekSectionsHtml } from "@/components/planning-v2/lib/planning-v2-schedule-screenshot";
import type { PlanningV2PullsMap, PlanningWorker, SiteSummary } from "@/components/planning-v2/types";

const weekStart = new Date(2026, 7, 9); // dimanche

const site = {
  id: 1,
  name: "אתר",
  config: {
    stations: [
      {
        name: "עמדה 1",
        shifts: [{ name: "בוקר", start: "07:00", end: "15:00", workers: 2, enabled: true }],
        days: { sun: true, mon: false, tue: false, wed: false, thu: false, fri: false, sat: false },
      },
    ],
  },
} as unknown as SiteSummary;

const workers = [
  { id: 1, name: "Alice", maxShifts: 6, roles: [], availability: {}, answers: {} },
  { id: 2, name: "Bob", maxShifts: 6, roles: [], availability: {}, answers: {} },
] as unknown as PlanningWorker[];

function buildHtml(pulls: PlanningV2PullsMap, names: string[]) {
  return buildPlanningScheduleWeekSectionsHtml({
    siteLabel: "אתר",
    weekStart,
    workers,
    assignments: { sun: { בוקר: [names] } },
    pulls,
    site,
    events: [],
  });
}

/** Bloc <td> de la ligne horaires (מ/עד) pour dimanche. */
function sundayTimeCells(html: string): string {
  const timeRow = html.split("מ</td>")[1] || "";
  return timeRow;
}

describe("צילום — horaires par travailleur sur une garde à deux personnes", () => {
  it("garde les horaires normaux de la garde et affiche l’horaire modifié en rouge sous le nom", () => {
    const html = buildHtml(
      { "sun|בוקר|0|1": { guardDisplay: { start: "09:00", end: "17:00" } } },
      ["Alice", "Bob"],
    );

    // Ligne מ/עד : horaires de la garde, non surlignés
    expect(sundayTimeCells(html)).toContain("07:00");
    expect(sundayTimeCells(html)).toContain("15:00");

    // Horaire propre à Bob en rouge sous son nom
    expect(html).toContain("Bob");
    expect(html).toContain("color:#dc2626");
    expect(html).toContain("09:00-17:00");
  });

  it("écrit les horaires modifiés dans la ligne מ/עד quand un seul travailleur occupe la garde", () => {
    const html = buildHtml(
      { "sun|בוקר|0|0": { guardDisplay: { start: "09:00", end: "17:00" } } },
      ["Alice"],
    );

    expect(sundayTimeCells(html)).toContain("09:00");
    // Pas de doublon rouge sous le nom : la ligne de la garde porte déjà l’horaire
    expect(html).not.toContain("color:#dc2626");
  });

  it("écrit les horaires dans la ligne מ/עד quand les deux travailleurs partagent le même horaire modifié", () => {
    const html = buildHtml(
      {
        "sun|בוקר|0|0": { guardDisplay: { start: "09:00", end: "17:00" } },
        "sun|בוקר|0|1": { guardDisplay: { start: "09:00", end: "17:00" } },
      },
      ["Alice", "Bob"],
    );

    expect(sundayTimeCells(html)).toContain("09:00");
    expect(html).not.toContain("color:#dc2626");
  });

  it("affiche les deux horaires en rouge quand chaque travailleur a le sien", () => {
    const html = buildHtml(
      {
        "sun|בוקר|0|0": { guardDisplay: { start: "07:00", end: "11:00" } },
        "sun|בוקר|0|1": { guardDisplay: { start: "11:00", end: "15:00" } },
      },
      ["Alice", "Bob"],
    );

    expect(html).toContain("07:00-11:00");
    expect(html).toContain("11:00-15:00");
  });
});

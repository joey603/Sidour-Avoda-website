// @hebcal/core est ESM-only et n'est pas résolvable par jest ; l'export Excel ne
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

import ExcelJS from "exceljs";

import { generatePlanningExcelBlob } from "@/components/planning-v2/lib/planning-v2-excel-export";
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

type CellText = { text: string; red: boolean };

async function readCells(pulls: PlanningV2PullsMap, names: string[]): Promise<CellText[]> {
  const blob = await generatePlanningExcelBlob({
    siteLabel: "אתר",
    weekStart,
    workers,
    assignments: { sun: { בוקר: [names] } },
    pulls,
    site,
    events: [],
  });
  // jsdom n'implémente pas Blob.arrayBuffer()
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out: CellText[] = [];
  wb.eachSheet((ws) => {
    ws.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value as { richText?: Array<{ text: string; font?: ExcelJS.Font }> };
        if (value && Array.isArray(value.richText)) {
          for (const run of value.richText) {
            out.push({ text: run.text, red: run.font?.color?.argb === "FFDC2626" });
          }
          return;
        }
        out.push({ text: String(cell.value ?? ""), red: false });
      });
    });
  });
  return out;
}

const redTexts = (cells: CellText[]) => cells.filter((c) => c.red).map((c) => c.text.trim());
const plainTexts = (cells: CellText[]) => cells.filter((c) => !c.red).map((c) => c.text.trim());

describe("Excel — horaires par travailleur sur une garde à deux personnes", () => {
  it("garde les horaires normaux de la garde et écrit l’horaire modifié en rouge sous le nom", async () => {
    const cells = await readCells(
      { "sun|בוקר|0|1": { guardDisplay: { start: "09:00", end: "17:00" } } },
      ["Alice", "Bob"],
    );

    expect(redTexts(cells)).toContain("09:00-17:00");
    // La ligne מ/עד conserve les horaires de la garde
    expect(plainTexts(cells)).toContain("07:00");
    expect(plainTexts(cells)).toContain("15:00");
    expect(plainTexts(cells)).not.toContain("17:00");
  }, 20000);

  it("écrit les horaires modifiés dans la ligne מ/עד quand un seul travailleur occupe la garde", async () => {
    const cells = await readCells(
      { "sun|בוקר|0|0": { guardDisplay: { start: "09:00", end: "17:00" } } },
      ["Alice"],
    );

    expect(redTexts(cells)).toHaveLength(0);
    expect(plainTexts(cells)).toContain("09:00");
    expect(plainTexts(cells)).toContain("17:00");
  }, 20000);

  it("écrit les horaires dans la ligne מ/עד quand les deux travailleurs partagent le même horaire", async () => {
    const cells = await readCells(
      {
        "sun|בוקר|0|0": { guardDisplay: { start: "09:00", end: "17:00" } },
        "sun|בוקר|0|1": { guardDisplay: { start: "09:00", end: "17:00" } },
      },
      ["Alice", "Bob"],
    );

    expect(redTexts(cells)).toHaveLength(0);
    expect(plainTexts(cells)).toContain("09:00");
  }, 20000);

  it("écrit les deux horaires en rouge quand chaque travailleur a le sien", async () => {
    const cells = await readCells(
      {
        "sun|בוקר|0|0": { guardDisplay: { start: "07:00", end: "11:00" } },
        "sun|בוקר|0|1": { guardDisplay: { start: "11:00", end: "15:00" } },
      },
      ["Alice", "Bob"],
    );

    expect(redTexts(cells)).toEqual(expect.arrayContaining(["07:00-11:00", "11:00-15:00"]));
  }, 20000);
});

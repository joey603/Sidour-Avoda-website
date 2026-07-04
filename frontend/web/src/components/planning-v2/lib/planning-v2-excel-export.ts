import ExcelJS from "exceljs";
import type { PlanningV2PullsMap, PlanningWorker, SiteSummary } from "../types";
import {
  countAssignmentsPerWorkerName,
  subtractPullExtrasFromWorkerCounts,
} from "./assignments-summary-math";
import { addDays } from "./week";
import {
  DAY_COLS,
  getRequiredFor,
  hoursFromConfig,
  hoursOf,
  isDayActive,
  isShiftEnabledForStation,
  shiftNamesFromSite,
} from "./station-grid-helpers";
import {
  buildPullHighlightKindByNormName,
  slotTimeMetaFromPulls,
} from "./planning-v2-pull-slot-display";

const GREEN = "548235";
const BLUE = "5B9BD5";
const ORANGE = "ED7D31";
const YELLOW = "FFFF00";
const BLACK = "000000";
const GRAY = "D9D9D9";
const WHITE = "FFFFFF";
const THIN_BLACK = { style: "thin" as const, color: { argb: "FF000000" } };

const DAY_FULL_HE: Record<string, string> = {
  sun: "ראשון",
  mon: "שני",
  tue: "שלישי",
  wed: "רביעי",
  thu: "חמישי",
  fri: "שישי",
  sat: "שבת",
};

function normName(s: string): string {
  return String(s || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isRealPullEntry(entry: unknown): boolean {
  const e = entry as { before?: { name?: string }; after?: { name?: string } } | undefined;
  return !!String(e?.before?.name || "").trim() && !!String(e?.after?.name || "").trim();
}

/** Noms réellement affectés dans la cellule (sans injection משיכה). */
function baseCellNames(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
): string[] {
  const cell = assignments?.[dayKey]?.[shiftName]?.[stationIdx];
  if (!Array.isArray(cell)) return [];
  return (cell as unknown[]).map((x) => String(x ?? "").trim()).filter(Boolean);
}

/**
 * Cellule « trou » de משיכה : une garde y a une affectation en moins
 * (transition before/after, pas de שיבוץ plein) → tout en noir.
 */
function isPullHoleCell(
  pulls: PlanningV2PullsMap | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
): boolean {
  if (!pulls) return false;
  const prefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  for (const [k, entry] of Object.entries(pulls)) {
    if (!String(k).startsWith(prefix)) continue;
    if (isRealPullEntry(entry)) return true;
  }
  return false;
}

function parseTimeLabel(label: string | null | undefined): { from: string; to: string } | null {
  if (!label) return null;
  const m = String(label).match(/(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?/);
  if (!m) return null;
  const fmt = (h: string, min?: string) => `${Number(h)}:${min || "00"}`;
  return { from: fmt(m[1], m[2]), to: fmt(m[3], m[4]) };
}

/** Horaires before/after d'une משיכה pour ce travailleur (même hors cellule trou). */
function pullHoursForWorkerAnywhere(
  pulls: PlanningV2PullsMap | null | undefined,
  stationIdx: number,
  workerName: string,
): { from: string; to: string } | null {
  if (!pulls) return null;
  const nm = normName(workerName);
  if (!nm) return null;
  for (const [k, entry] of Object.entries(pulls)) {
    const parts = String(k).split("|");
    if (parts.length < 4) continue;
    if (Number(parts[2]) !== Number(stationIdx)) continue;
    if (!isRealPullEntry(entry)) continue;
    const e = entry as {
      before?: { name?: string; start?: string; end?: string };
      after?: { name?: string; start?: string; end?: string };
    };
    if (normName(String(e.before?.name || "")) === nm) {
      const s = String(e.before?.start || "").trim();
      const en = String(e.before?.end || "").trim();
      if (s && en) return parseTimeLabel(`${s}–${en}`);
    }
    if (normName(String(e.after?.name || "")) === nm) {
      const s = String(e.after?.start || "").trim();
      const en = String(e.after?.end || "").trim();
      if (s && en) return parseTimeLabel(`${s}–${en}`);
    }
  }
  return null;
}

/** Jaune + gras : שינוי שעות (guard) ou משיכה (pull / before / after). */
function slotHighlightMeta(
  pulls: PlanningV2PullsMap | null | undefined,
  shiftNamesAll: string[],
  dayIdx: number,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  slotIdx: number,
  workerName: string,
): { highlight: boolean; from: string; to: string } {
  const meta = slotTimeMetaFromPulls(pulls, dayKey, shiftName, stationIdx, slotIdx, workerName);
  const pullRel = buildPullHighlightKindByNormName(
    pulls,
    shiftNamesAll,
    dayIdx,
    dayKey,
    shiftName,
    stationIdx,
  ).get(normName(workerName));
  const highlight =
    meta?.highlight === "guard" ||
    meta?.highlight === "pull" ||
    pullRel === "before" ||
    pullRel === "after" ||
    pullRel === "cell";
  const custom =
    parseTimeLabel(meta?.label) ||
    (highlight ? pullHoursForWorkerAnywhere(pulls, stationIdx, workerName) : null);
  return {
    highlight: !!highlight,
    from: custom?.from || "",
    to: custom?.to || "",
  };
}

function formatDateDdMmYy(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}

function parseHours(hours: string | null): { from: string; to: string } {
  if (!hours) return { from: "", to: "" };
  const m = String(hours).match(/(\d{1,2})(?::(\d{2}))?\s*[-–:]\s*(\d{1,2})(?::(\d{2}))?/);
  if (!m) return { from: String(hours), to: "" };
  const fmt = (h: string, min?: string) => `${Number(h)}:${min || "00"}`;
  return { from: fmt(m[1], m[2]), to: fmt(m[3], m[4]) };
}

function shiftLabelFill(shiftName: string): string {
  if (/בוקר/i.test(shiftName)) return BLUE;
  if (/צהר/i.test(shiftName)) return WHITE;
  if (/לילה|night/i.test(shiftName)) return ORANGE;
  return GRAY;
}

function applyFill(cell: ExcelJS.Cell, hex: string) {
  cell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: `FF${hex}` },
  };
}

function applyBorder(cell: ExcelJS.Cell) {
  cell.border = {
    top: THIN_BLACK,
    left: THIN_BLACK,
    bottom: THIN_BLACK,
    right: THIN_BLACK,
  };
}

function styleCenter(cell: ExcelJS.Cell, opts?: { bold?: boolean; size?: number; color?: string }) {
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  cell.font = {
    name: "Arial",
    bold: !!opts?.bold,
    size: opts?.size ?? 11,
    color: opts?.color ? { argb: `FF${opts.color}` } : { argb: "FF000000" },
  };
  applyBorder(cell);
}

function buildSummaryRows(
  workers: PlanningWorker[],
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: PlanningV2PullsMap | null | undefined,
): Array<[string, number]> {
  const plan = assignments ?? {};
  const counts = subtractPullExtrasFromWorkerCounts(countAssignmentsPerWorkerName(plan), pulls ?? null);
  workers.forEach((w) => {
    const n = String(w.name || "").trim();
    if (n && !counts.has(n)) counts.set(n, 0);
  });
  const isPendingApprovalName = (name: string) =>
    !!workers.find((w) => String(w.name || "").trim() === String(name || "").trim())?.pendingApproval;
  const order = new Map<string, number>();
  workers.forEach((w, i) => order.set(w.name, i));
  return Array.from(counts.entries())
    .filter(([nm]) => !isPendingApprovalName(nm))
    .sort((a, b) => {
      const ia = order.has(a[0]) ? (order.get(a[0]) as number) : Number.MAX_SAFE_INTEGER;
      const ib = order.has(b[0]) ? (order.get(b[0]) as number) : Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      return a[0].localeCompare(b[0]);
    });
}

function safeSheetName(raw: string, fallback: string): string {
  const s = String(raw || "")
    .replace(/[:\\/?*[\]]/g, "-")
    .trim()
    .slice(0, 31);
  return s || fallback;
}

type ExportParams = {
  siteLabel: string;
  weekStart: Date;
  workers: PlanningWorker[];
  assignments: Record<string, Record<string, string[][]>> | null | undefined;
  pulls: PlanningV2PullsMap | null | undefined;
  site: SiteSummary | null;
};

/**
 * Excel hebdomadaire style « סידור שבועי » :
 * en-tête vert, colonnes jour (מ/עד), blocs משמרת colorés,
 * jaune+gras si שינוי שעות ou משיכה, noir si inactif ou trou משיכה (affectation en moins),
 * légende עובדים à droite.
 */
export async function generatePlanningExcelBlob(params: ExportParams): Promise<Blob> {
  const { siteLabel, weekStart, workers, assignments, pulls, site } = params;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Sidour Avoda";
  workbook.created = new Date();

  const stations = (site?.config?.stations || []) as unknown[];
  const shiftNamesAll = shiftNamesFromSite(site);
  const summary = buildSummaryRows(workers, assignments, pulls);

  const stationsToWrite =
    stations.length > 0
      ? stations.map((st, idx) => ({
          st,
          idx,
          name: String((st as { name?: string })?.name || "").trim() || `עמדה ${idx + 1}`,
        }))
      : [{ st: {}, idx: 0, name: siteLabel }];

  for (const { st, idx: stationIdx, name: stationName } of stationsToWrite) {
    const sheetName =
      stationsToWrite.length === 1
        ? safeSheetName(siteLabel, "סידור")
        : safeSheetName(stationName, `עמדה ${stationIdx + 1}`);
    const ws = workbook.addWorksheet(sheetName, {
      views: [{ rightToLeft: true, state: "normal", showGridLines: false }],
      properties: { defaultRowHeight: 18 },
    });

    // En RTL Excel, la col A est à droite (comme le modèle) :
    // légende (# / מאבטח / משמרות) | espace | תווית משמרת | jours dim→sam (מ/עד)
    const legendStartCol = 1;
    const shiftCol = 5;
    const dayStartCol = 6;

    ws.getColumn(legendStartCol).width = 5;
    ws.getColumn(legendStartCol + 1).width = 14;
    ws.getColumn(legendStartCol + 2).width = 6;
    ws.getColumn(4).width = 2;
    ws.getColumn(shiftCol).width = 14;
    for (let i = 0; i < DAY_COLS.length * 2; i++) {
      ws.getColumn(dayStartCol + i).width = 8;
    }

    // Ligne 1 : titre vert sur les colonnes jours (bande fine)
    const titleRow = ws.getRow(1);
    titleRow.height = 18;
    const titleStart = dayStartCol;
    const titleEnd = dayStartCol + DAY_COLS.length * 2 - 1;
    ws.mergeCells(1, titleStart, 1, titleEnd);
    const titleCell = ws.getCell(1, titleStart);
    titleCell.value = `סידור שבועי - ${siteLabel}`;
    applyFill(titleCell, GREEN);
    styleCenter(titleCell, { bold: false, size: 11, color: WHITE });
    for (let c = titleStart; c <= titleEnd; c++) {
      applyBorder(ws.getCell(1, c));
      applyFill(ws.getCell(1, c), GREEN);
    }
    // Cellule vide sous le titre côté תווית
    const corner = ws.getCell(1, shiftCol);
    applyFill(corner, GREEN);
    applyBorder(corner);

    // Ligne 2 : dates seules (fond blanc), séparées du nom du jour
    const dateHeaderRow = ws.getRow(2);
    dateHeaderRow.height = 20;
    const shiftDateCorner = ws.getCell(2, shiftCol);
    shiftDateCorner.value = "";
    applyFill(shiftDateCorner, WHITE);
    applyBorder(shiftDateCorner);
    DAY_COLS.forEach((d, dayIdx) => {
      const col = dayStartCol + dayIdx * 2;
      ws.mergeCells(2, col, 2, col + 1);
      const cell = ws.getCell(2, col);
      cell.value = formatDateDdMmYy(addDays(weekStart, dayIdx));
      applyFill(cell, WHITE);
      styleCenter(cell, { bold: false, size: 11 });
      applyBorder(ws.getCell(2, col + 1));
      applyFill(ws.getCell(2, col + 1), WHITE);
    });

    // Ligne 3 : noms de jours seuls (fond blanc)
    const dayNameRow = ws.getRow(3);
    dayNameRow.height = 20;
    const shiftDayCorner = ws.getCell(3, shiftCol);
    shiftDayCorner.value = "";
    applyFill(shiftDayCorner, WHITE);
    applyBorder(shiftDayCorner);
    DAY_COLS.forEach((d, dayIdx) => {
      const col = dayStartCol + dayIdx * 2;
      ws.mergeCells(3, col, 3, col + 1);
      const cell = ws.getCell(3, col);
      cell.value = DAY_FULL_HE[d.key] || d.label;
      applyFill(cell, WHITE);
      styleCenter(cell, { bold: false, size: 11 });
      applyBorder(ws.getCell(3, col + 1));
      applyFill(ws.getCell(3, col + 1), WHITE);
    });

    // מ / עד sont des cases dans chaque bloc d'horaires (matin / midi / nuit)
    let row = 4;
    const enabledShifts = shiftNamesAll.filter((sn) => isShiftEnabledForStation(st, sn));
    const gridLastCol = dayStartCol + DAY_COLS.length * 2 - 1;
    const blackBandRows: number[] = [];

    const paintBlackBand = (bandRow: number) => {
      blackBandRows.push(bandRow);
      for (let c = shiftCol; c <= gridLastCol; c++) {
        const cell = ws.getCell(bandRow, c);
        cell.value = "";
        applyFill(cell, BLACK);
        applyBorder(cell);
      }
    };

    enabledShifts.forEach((sn, shiftBlockIdx) => {
      const hoursStr = hoursFromConfig(st, sn) || hoursOf(sn);
      const { from: defaultFrom, to: defaultTo } = parseHours(hoursStr);

      // Lignes noms = max slots d'affectations réelles (pas les noms injectés par משיכה)
      let maxSlots = 1;
      for (const d of DAY_COLS) {
        const required = getRequiredFor(st as object, sn, d.key);
        const activeDay = isDayActive(st, d.key);
        if (!activeDay || required <= 0) continue;
        if (isPullHoleCell(pulls ?? null, d.key, sn, stationIdx)) continue;
        const names = baseCellNames(assignments, d.key, sn, stationIdx);
        maxSlots = Math.max(maxSlots, required, names.length, 1);
      }

      // Par garde : ligne cases מ|עד, ligne horaires, lignes noms
      const meAdRowIdx = row;
      const timeRowIdx = row + 1;
      const nameStartRow = row + 2;
      const nameEndRow = row + 1 + maxSlots;
      const blockEndRow = nameEndRow;

      // Label משמרת (fusion verticale) : בוקר / מ- horaire / עד- horaire
      ws.mergeCells(meAdRowIdx, shiftCol, blockEndRow, shiftCol);
      const labelCell = ws.getCell(meAdRowIdx, shiftCol);
      labelCell.value =
        defaultFrom && defaultTo
          ? `${sn}\nמ- ${defaultFrom}\nעד- ${defaultTo}`
          : sn;
      applyFill(labelCell, shiftLabelFill(sn));
      styleCenter(labelCell, {
        bold: false,
        size: 11,
        color: "000000",
      });
      for (let r = meAdRowIdx; r <= blockEndRow; r++) {
        applyBorder(ws.getCell(r, shiftCol));
        applyFill(ws.getCell(r, shiftCol), shiftLabelFill(sn));
      }

      // Pré-calcul par jour : noir / jaune / horaires custom
      const dayMeta = DAY_COLS.map((d, dayIdx) => {
        const required = getRequiredFor(st as object, sn, d.key);
        const activeDay = isDayActive(st, d.key);
        const inactive = !activeDay || required <= 0;
        const pullHole = !inactive && isPullHoleCell(pulls ?? null, d.key, sn, stationIdx);
        const allBlack = inactive || pullHole;
        const names = allBlack ? [] : baseCellNames(assignments, d.key, sn, stationIdx);
        const highlights = names.map((name, slotIdx) =>
          slotHighlightMeta(pulls ?? null, shiftNamesAll, dayIdx, d.key, sn, stationIdx, slotIdx, name),
        );
        const anyHighlight = highlights.some((h) => h.highlight);
        const customHours = highlights.find((h) => h.highlight && h.from && h.to);
        return {
          allBlack,
          names,
          highlights,
          anyHighlight,
          from: customHours?.from || defaultFrom,
          to: customHours?.to || defaultTo,
        };
      });

      // Ligne de cases מ | עד (une paire de cellules par jour)
      const meAdRow = ws.getRow(meAdRowIdx);
      meAdRow.height = 18;
      dayMeta.forEach((meta, dayIdx) => {
        const col = dayStartCol + dayIdx * 2;
        const fromLabel = ws.getCell(meAdRowIdx, col);
        const toLabel = ws.getCell(meAdRowIdx, col + 1);
        if (meta.allBlack) {
          fromLabel.value = "";
          toLabel.value = "";
          applyFill(fromLabel, BLACK);
          applyFill(toLabel, BLACK);
          styleCenter(fromLabel, { size: 10, color: WHITE, bold: false });
          styleCenter(toLabel, { size: 10, color: WHITE, bold: false });
          return;
        }
        fromLabel.value = "מ";
        toLabel.value = "עד";
        applyFill(fromLabel, WHITE);
        applyFill(toLabel, WHITE);
        styleCenter(fromLabel, { size: 10, bold: false });
        styleCenter(toLabel, { size: 10, bold: false });
      });

      // Ligne horaires (sous les cases מ / עד)
      const timeRow = ws.getRow(timeRowIdx);
      timeRow.height = 18;
      dayMeta.forEach((meta, dayIdx) => {
        const col = dayStartCol + dayIdx * 2;
        const fromCell = ws.getCell(timeRowIdx, col);
        const toCell = ws.getCell(timeRowIdx, col + 1);

        if (meta.allBlack) {
          fromCell.value = "";
          toCell.value = "";
          applyFill(fromCell, BLACK);
          applyFill(toCell, BLACK);
          styleCenter(fromCell, { size: 10, color: WHITE, bold: false });
          styleCenter(toCell, { size: 10, color: WHITE, bold: false });
          return;
        }

        fromCell.value = meta.from;
        toCell.value = meta.to;
        if (meta.anyHighlight) {
          applyFill(fromCell, YELLOW);
          applyFill(toCell, YELLOW);
          styleCenter(fromCell, { size: 10, bold: true });
          styleCenter(toCell, { size: 10, bold: true });
        } else {
          applyFill(fromCell, GRAY);
          applyFill(toCell, GRAY);
          styleCenter(fromCell, { size: 10, bold: false });
          styleCenter(toCell, { size: 10, bold: false });
        }
      });

      // Lignes noms (une par slot)
      for (let slot = 0; slot < maxSlots; slot++) {
        const nameRowIdx = nameStartRow + slot;
        const nameRow = ws.getRow(nameRowIdx);
        nameRow.height = 20;
        dayMeta.forEach((meta, dayIdx) => {
          const col = dayStartCol + dayIdx * 2;
          const name = meta.names[slot] || "";
          const hl = meta.highlights[slot];
          const isYellow = !!name && !!hl?.highlight;

          ws.mergeCells(nameRowIdx, col, nameRowIdx, col + 1);
          const cell = ws.getCell(nameRowIdx, col);
          cell.value = meta.allBlack ? "" : name;
          if (meta.allBlack) {
            applyFill(cell, BLACK);
            applyFill(ws.getCell(nameRowIdx, col + 1), BLACK);
            styleCenter(cell, { bold: false, size: 11, color: WHITE });
          } else if (isYellow) {
            applyFill(cell, YELLOW);
            applyFill(ws.getCell(nameRowIdx, col + 1), YELLOW);
            styleCenter(cell, { bold: true, size: 11 });
          } else {
            applyFill(cell, WHITE);
            applyFill(ws.getCell(nameRowIdx, col + 1), WHITE);
            styleCenter(cell, { bold: false, size: 11 });
          }
          applyBorder(ws.getCell(nameRowIdx, col + 1));
        });
      }

      row = blockEndRow + 1;

      // Bande noire entre les gardes (matin / midi / nuit), comme le modèle Excel
      if (shiftBlockIdx < enabledShifts.length - 1) {
        paintBlackBand(row);
        row += 1;
      }
    });

    // Légende à droite (שמור / מאבטח / מספר משמרות)
    const legendHeaderRow = 1;
    const legendIdxCol = legendStartCol;
    const legendNameCol = legendStartCol + 1;
    const legendCountCol = legendStartCol + 2;

    const legendTitle = ws.getCell(legendHeaderRow, legendNameCol);
    legendTitle.value = "מאבטח";
    applyFill(legendTitle, YELLOW);
    styleCenter(legendTitle, { bold: false, size: 11 });
    applyFill(ws.getCell(legendHeaderRow, legendIdxCol), YELLOW);
    applyBorder(ws.getCell(legendHeaderRow, legendIdxCol));
    applyFill(ws.getCell(legendHeaderRow, legendCountCol), YELLOW);
    applyBorder(ws.getCell(legendHeaderRow, legendCountCol));

    // Tableau légende collé (sans ligne d'en-têtes # / מאבטח / משמרות).
    const LEGEND_ROW_HEIGHT = 20;
    summary.forEach(([nm, count], i) => {
      const r = 2 + i;
      ws.getRow(r).height = LEGEND_ROW_HEIGHT;
      const idxCell = ws.getCell(r, legendIdxCol);
      const nameCell = ws.getCell(r, legendNameCol);
      const countCell = ws.getCell(r, legendCountCol);
      idxCell.value = i + 1;
      nameCell.value = nm;
      countCell.value = count;
      applyFill(idxCell, YELLOW);
      styleCenter(idxCell, { size: 10 });
      styleCenter(nameCell, { size: 11 });
      styleCenter(countCell, { bold: true, size: 11 });
    });

    // Toutes les barres noires entre gardes : même épaisseur.
    const BLACK_BAND_HEIGHT = LEGEND_ROW_HEIGHT;
    for (const bandRow of blackBandRows) {
      ws.getRow(bandRow).height = BLACK_BAND_HEIGHT;
    }

    // Titre / date / jour : hauteurs stables (ne pas se faire écraser par la légende / bandes).
    ws.getRow(1).height = 18;
    ws.getRow(2).height = 20;
    ws.getRow(3).height = 20;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

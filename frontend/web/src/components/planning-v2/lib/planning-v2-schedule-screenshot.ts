import { toPng } from "html-to-image";
import type { PlanningV2PullsMap, PlanningWorker, SiteEvent, SiteSummary } from "../types";
import {
  countAssignmentsPerWorkerName,
  subtractPullExtrasFromWorkerCounts,
} from "./assignments-summary-math";
import { addDays, HEBREW_MONTH_NAMES } from "./week";
import { computeWorkerHoursTotals, mergeWorkerHoursTotals } from "./salary-calculator";
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
  resolveSlotExportHours,
} from "./planning-v2-pull-slot-display";
import { buildEventExportOccurrences, buildEventTablesHtml } from "./event-export-tables";
import { addEventCountsToAssignmentCounts, countEventAssignmentsPerWorkerName } from "./event-availability-locks";

const GREEN = "#548235";
const BLUE = "#5B9BD5";
const ORANGE = "#ED7D31";
const YELLOW = "#FFFF00";
const BLACK = "#000000";
const GRAY = "#D9D9D9";
const WHITE = "#FFFFFF";

/** Densité pixels pour un rendu net (Retina). */
export const SCHEDULE_SCREENSHOT_PIXEL_RATIO = 2;
/** Petite marge autour des tableaux (pas de grand fond blanc). */
const SCREENSHOT_PAD_PX = 8;

const DAY_FULL_HE: Record<string, string> = {
  sun: "ראשון",
  mon: "שני",
  tue: "שלישי",
  wed: "רביעי",
  thu: "חמישי",
  fri: "שישי",
  sat: "שבת",
};

const CELL =
  "border:1px solid #000;text-align:center;vertical-align:middle;font-family:Arial,sans-serif;font-size:12px;color:#000;padding:2px 6px;white-space:nowrap;";
const DAY_CELL = `${CELL}min-width:44px;`;
const ROW_ME_AD = "height:22px;";
const ROW_TIME = "height:22px;";
const ROW_NAME = "height:26px;";

function isRealPullEntry(entry: unknown): boolean {
  const e = entry as { before?: { name?: string }; after?: { name?: string } } | undefined;
  return !!String(e?.before?.name || "").trim() && !!String(e?.after?.name || "").trim();
}

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
  const fmt = (h: string, min?: string) =>
    `${String(Number(h)).padStart(2, "0")}:${(min || "00").padStart(2, "0")}`;
  return { from: fmt(m[1], m[2]), to: fmt(m[3], m[4]) };
}

function shiftLabelFill(shiftName: string): string {
  if (/בוקר/i.test(shiftName)) return BLUE;
  if (/צהר/i.test(shiftName)) return WHITE;
  if (/לילה|night/i.test(shiftName)) return ORANGE;
  return GRAY;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildSummaryRows(
  workers: PlanningWorker[],
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: PlanningV2PullsMap | null | undefined,
  events?: SiteEvent[] | null,
  weekStart?: Date,
): Array<[string, number]> {
  const plan = assignments ?? {};
  let counts = subtractPullExtrasFromWorkerCounts(countAssignmentsPerWorkerName(plan), pulls ?? null);
  if (events && weekStart) {
    counts = addEventCountsToAssignmentCounts(
      counts,
      countEventAssignmentsPerWorkerName(events, weekStart, workers),
    );
  }
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

type ExportParams = {
  siteLabel: string;
  weekStart: Date;
  workers: PlanningWorker[];
  assignments: Record<string, Record<string, string[][]>> | null | undefined;
  pulls: PlanningV2PullsMap | null | undefined;
  site: SiteSummary | null;
  events?: SiteEvent[] | null;
};

function buildStationScheduleHtml(
  siteLabel: string,
  weekStart: Date,
  workers: PlanningWorker[],
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: PlanningV2PullsMap | null | undefined,
  st: unknown,
  stationIdx: number,
  shiftNamesAll: string[],
  summary: Array<[string, number]>,
  eventsHtml = "",
): string {
  const enabledShifts = shiftNamesAll.filter((sn) => isShiftEnabledForStation(st, sn));
  const dayCols = DAY_COLS.length * 2;

  const dateCells = DAY_COLS.map((d, dayIdx) => {
    const dateStr = formatDateDdMmYy(addDays(weekStart, dayIdx));
    return `<td colspan="2" style="${DAY_CELL}background:${WHITE};">${escapeHtml(dateStr)}</td>`;
  }).join("");

  const dayNameCells = DAY_COLS.map((d) => {
    return `<td colspan="2" style="${DAY_CELL}background:${WHITE};">${escapeHtml(DAY_FULL_HE[d.key] || d.label)}</td>`;
  }).join("");

  const shiftBlocks = enabledShifts
    .map((sn, shiftBlockIdx) => {
      const hoursStr = hoursFromConfig(st, sn) || hoursOf(sn);
      const { from: defaultFrom, to: defaultTo } = parseHours(hoursStr);
      let maxSlots = 1;
      for (const d of DAY_COLS) {
        const required = getRequiredFor(st as object, sn, d.key);
        const activeDay = isDayActive(st, d.key);
        if (!activeDay || required <= 0) continue;
        if (isPullHoleCell(pulls ?? null, d.key, sn, stationIdx)) continue;
        const names = baseCellNames(assignments, d.key, sn, stationIdx);
        maxSlots = Math.max(maxSlots, required, names.length, 1);
      }
      const blockRows = 2 + maxSlots;

      const dayMeta = DAY_COLS.map((d, dayIdx) => {
        const required = getRequiredFor(st as object, sn, d.key);
        const activeDay = isDayActive(st, d.key);
        const inactive = !activeDay || required <= 0;
        const pullHole = !inactive && isPullHoleCell(pulls ?? null, d.key, sn, stationIdx);
        const allBlack = inactive || pullHole;
        const names = allBlack ? [] : baseCellNames(assignments, d.key, sn, stationIdx);
        const highlights = names.map((name, slotIdx) =>
          resolveSlotExportHours(
            pulls ?? null,
            assignments,
            shiftNamesAll,
            dayIdx,
            d.key,
            sn,
            stationIdx,
            slotIdx,
            name,
            defaultFrom,
            defaultTo,
          ),
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

      const labelBg = shiftLabelFill(sn);
      const labelText =
        defaultFrom && defaultTo
          ? `${escapeHtml(sn)}<br/>מ- ${escapeHtml(defaultFrom)}<br/>עד- ${escapeHtml(defaultTo)}`
          : escapeHtml(sn);
      const labelCell = `<td rowspan="${blockRows}" style="${CELL}background:${labelBg};font-weight:normal;width:72px;line-height:1.25;">${labelText}</td>`;

      const meAdCells = dayMeta
        .map((meta) => {
          if (meta.allBlack) {
            return `<td style="${CELL}${ROW_ME_AD}background:${BLACK};color:${WHITE};">&nbsp;</td><td style="${CELL}${ROW_ME_AD}background:${BLACK};color:${WHITE};">&nbsp;</td>`;
          }
          return `<td style="${CELL}${ROW_ME_AD}background:${WHITE};">מ</td><td style="${CELL}${ROW_ME_AD}background:${WHITE};">עד</td>`;
        })
        .join("");

      const timeCells = dayMeta
        .map((meta) => {
          if (meta.allBlack) {
            return `<td style="${CELL}${ROW_TIME}background:${BLACK};color:${WHITE};">&nbsp;</td><td style="${CELL}${ROW_TIME}background:${BLACK};color:${WHITE};">&nbsp;</td>`;
          }
          const bg = meta.anyHighlight ? YELLOW : GRAY;
          const weight = meta.anyHighlight ? "bold" : "normal";
          const from = meta.from || "&nbsp;";
          const to = meta.to || "&nbsp;";
          return `<td style="${CELL}${ROW_TIME}background:${bg};font-weight:${weight};">${from === "&nbsp;" ? from : escapeHtml(meta.from)}</td><td style="${CELL}${ROW_TIME}background:${bg};font-weight:${weight};">${to === "&nbsp;" ? to : escapeHtml(meta.to)}</td>`;
        })
        .join("");

      const nameRows = Array.from({ length: maxSlots }, (_, slot) => {
        const cells = dayMeta
          .map((meta) => {
            const name = meta.names[slot] || "";
            const hl = meta.highlights[slot];
            const isYellow = !!name && !!hl?.highlight;
            // &nbsp; empêche la compression d'une ligne de garde entièrement vide
            if (meta.allBlack) {
              return `<td colspan="2" style="${CELL}${ROW_NAME}background:${BLACK};color:${WHITE};">&nbsp;</td>`;
            }
            if (isYellow) {
              return `<td colspan="2" style="${CELL}${ROW_NAME}background:${YELLOW};font-weight:bold;">${escapeHtml(name) || "&nbsp;"}</td>`;
            }
            return `<td colspan="2" style="${CELL}${ROW_NAME}background:${WHITE};font-weight:normal;">${escapeHtml(name) || "&nbsp;"}</td>`;
          })
          .join("");
        return `<tr style="${ROW_NAME}">${cells}</tr>`;
      }).join("");

      const band =
        shiftBlockIdx < enabledShifts.length - 1
          ? `<tr><td colspan="${dayCols + 1}" style="height:10px;background:${BLACK};border:1px solid #000;padding:0;font-size:0;line-height:0;">&nbsp;</td></tr>`
          : "";

      return `<tr style="${ROW_ME_AD}">${labelCell}${meAdCells}</tr><tr style="${ROW_TIME}">${timeCells}</tr>${nameRows}${band}`;
    })
    .join("");

  const legendRows = summary
    .map(
      ([nm, count], i) =>
        `<tr>
  <td style="${CELL}background:${YELLOW};width:28px;">${i + 1}</td>
  <td style="${CELL}background:${WHITE};">${escapeHtml(nm)}</td>
  <td style="${CELL}background:${WHITE};font-weight:bold;width:36px;">${count}</td>
</tr>`,
    )
    .join("");

  return `
<div style="display:inline-flex;flex-direction:row-reverse;align-items:flex-start;gap:10px;background:${WHITE};width:max-content;box-sizing:border-box;">
  <table dir="rtl" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:${WHITE};width:auto;">
    <tr>
      <td style="${CELL}background:${GREEN};width:72px;"></td>
      <td colspan="${dayCols}" style="${CELL}background:${GREEN};color:${WHITE};font-size:13px;height:22px;">סידור שבועי - ${escapeHtml(siteLabel)}</td>
    </tr>
    <tr>
      <td style="${CELL}background:${WHITE};"></td>
      ${dateCells}
    </tr>
    <tr>
      <td style="${CELL}background:${WHITE};"></td>
      ${dayNameCells}
    </tr>
    ${shiftBlocks}
  </table>
  <div style="display:flex;flex-direction:column;align-items:stretch;gap:8px;flex:0 0 auto;">
    <table dir="rtl" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:${WHITE};width:auto;">
      <tr>
        <td style="${CELL}background:${YELLOW};width:28px;"></td>
        <td style="${CELL}background:${YELLOW};">מאבטח</td>
        <td style="${CELL}background:${YELLOW};width:36px;"></td>
      </tr>
      ${legendRows}
    </table>
    ${eventsHtml}
  </div>
</div>`;
}

/** HTML d’une semaine (stations + מאבטח + אירועים) — réutilisé par capture semaine / mois. */
export function buildPlanningScheduleWeekSectionsHtml(params: ExportParams): string {
  const { siteLabel, weekStart, workers, assignments, pulls, site, events } = params;
  const stations = (site?.config?.stations || []) as unknown[];
  const shiftNamesAll = shiftNamesFromSite(site);
  const summary = buildSummaryRows(workers, assignments, pulls, events, weekStart);
  const eventHtml = buildEventTablesHtml(
    buildEventExportOccurrences({ events, weekStart, workers }),
  );

  const stationsToWrite =
    stations.length > 0
      ? stations.map((st, idx) => ({
          st,
          idx,
          name: String((st as { name?: string })?.name || "").trim() || `עמדה ${idx + 1}`,
        }))
      : [{ st: {}, idx: 0, name: siteLabel }];

  return stationsToWrite
    .map(({ st, idx, name }) => {
      const title =
        stationsToWrite.length > 1
          ? `<div style="font-family:Arial,sans-serif;font-size:14px;margin:0 0 6px;text-align:center;">${escapeHtml(name)}</div>`
          : "";
      return `<div style="width:max-content;margin:0 auto;">${title}<div style="display:flex;justify-content:center;">${buildStationScheduleHtml(
        siteLabel,
        weekStart,
        workers,
        assignments,
        pulls,
        st,
        idx,
        shiftNamesAll,
        summary,
        eventHtml,
      )}</div></div>`;
    })
    .join('<div style="height:12px;"></div>');
}

async function captureHtmlToPngBlob(innerHtml: string): Promise<Blob> {
  const host = document.createElement("div");
  host.setAttribute("data-planning-screenshot", "1");
  host.style.cssText = [
    "position:fixed",
    "left:-10000px",
    "top:0",
    "width:max-content",
    "background:#ffffff",
    "z-index:-1",
    "pointer-events:none",
  ].join(";");
  host.innerHTML = `<div style="display:inline-block;width:max-content;background:#ffffff;padding:${SCREENSHOT_PAD_PX}px;box-sizing:border-box;">${innerHtml}</div>`;
  document.body.appendChild(host);

  const target = host.firstElementChild as HTMLElement;
  try {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const width = Math.ceil(Math.max(target.scrollWidth, target.offsetWidth));
    const height = Math.ceil(Math.max(target.scrollHeight, target.offsetHeight));
    const dataUrl = await toPng(target, {
      width,
      height,
      pixelRatio: SCHEDULE_SCREENSHOT_PIXEL_RATIO,
      backgroundColor: "#ffffff",
      cacheBust: true,
      style: {
        transform: "none",
        margin: "0",
        width: `${width}px`,
        height: `${height}px`,
      },
    });
    const res = await fetch(dataUrl);
    return await res.blob();
  } finally {
    host.remove();
  }
}

/**
 * Capture PNG du planning au format סידור שבועי (mêmes règles que l'export Excel).
 * Cadre collé au contenu (pas de grand fond blanc), tableaux centrés dans une petite marge.
 */
export async function generatePlanningScheduleScreenshotPng(params: ExportParams): Promise<Blob> {
  return captureHtmlToPngBlob(buildPlanningScheduleWeekSectionsHtml(params));
}

export type MonthWeekScreenshotInput = ExportParams & {
  /** Libellé affiché au-dessus de la semaine. */
  weekLabel?: string;
};

/**
 * Photo d’un mois entier : empile les tableaux hebdomadaires (avec אירועים à côté de מאבטח).
 * En bas : total d’heures par travailleur pour le mois.
 */
export async function generatePlanningMonthScreenshotPng(params: {
  siteLabel: string;
  year: number;
  monthIndex: number;
  weeks: MonthWeekScreenshotInput[];
}): Promise<Blob> {
  const { siteLabel, year, monthIndex, weeks } = params;
  const monthTitle = `${HEBREW_MONTH_NAMES[monthIndex] || ""} ${year}`.trim();
  const header = `<div style="font-family:Arial,sans-serif;font-size:18px;font-weight:bold;text-align:center;margin:0 0 14px;">סידור חודשי - ${escapeHtml(
    siteLabel,
  )} · ${escapeHtml(monthTitle)}</div>`;

  const weekBlocks = (weeks || [])
    .map((week) => {
      const label =
        week.weekLabel ||
        `שבוע מתאריך ${formatDateDdMmYy(week.weekStart)}`;
      const body = buildPlanningScheduleWeekSectionsHtml(week);
      return `<div style="width:max-content;margin:0 auto 18px;">
  <div style="font-family:Arial,sans-serif;font-size:14px;font-weight:bold;text-align:center;margin:0 0 8px;">${escapeHtml(label)}</div>
  ${body}
</div>`;
    })
    .join("");

  if (!weekBlocks) {
    throw new Error("אין שבועות לייצוא בחודש זה");
  }

  const hoursLists = (weeks || []).map((week) =>
    computeWorkerHoursTotals({
      weekStart: week.weekStart,
      site: week.site,
      assignments: week.assignments,
      pulls: week.pulls ?? null,
      clipToMonth: { year, monthIndex },
    }),
  );
  const hoursTotals = mergeWorkerHoursTotals(hoursLists);
  const hoursFooter =
    hoursTotals.length === 0
      ? ""
      : `<div style="width:max-content;min-width:280px;margin:8px auto 0;font-family:Arial,sans-serif;direction:rtl;">
  <div style="font-size:14px;font-weight:bold;text-align:center;margin:0 0 8px;">סה״כ שעות לחודש — לפי עובד</div>
  <table style="border-collapse:collapse;width:100%;font-size:13px;">
    <thead>
      <tr>
        <th style="border:1px solid #333;padding:6px 10px;background:#f3f4f6;text-align:right;">עובד</th>
        <th style="border:1px solid #333;padding:6px 10px;background:#f3f4f6;text-align:center;min-width:72px;">שעות</th>
      </tr>
    </thead>
    <tbody>
      ${hoursTotals
        .map(
          (row) => `<tr>
        <td style="border:1px solid #333;padding:5px 10px;text-align:right;">${escapeHtml(row.workerName)}</td>
        <td style="border:1px solid #333;padding:5px 10px;text-align:center;font-variant-numeric:tabular-nums;">${formatHoursHe(row.hours)}</td>
      </tr>`,
        )
        .join("")}
      <tr>
        <td style="border:1px solid #333;padding:6px 10px;text-align:right;font-weight:bold;background:#f9fafb;">סה״כ</td>
        <td style="border:1px solid #333;padding:6px 10px;text-align:center;font-weight:bold;background:#f9fafb;font-variant-numeric:tabular-nums;">${formatHoursHe(
          hoursTotals.reduce((s, r) => s + r.hours, 0),
        )}</td>
      </tr>
    </tbody>
  </table>
</div>`;

  return captureHtmlToPngBlob(`${header}${weekBlocks}${hoursFooter}`);
}

function formatHoursHe(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString("he-IL", {
    minimumFractionDigits: Number.isInteger(rounded) ? 0 : 1,
    maximumFractionDigits: 2,
  });
}

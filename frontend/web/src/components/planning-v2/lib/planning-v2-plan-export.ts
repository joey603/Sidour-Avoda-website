import type { PlanningV2PullsMap, PlanningWorker, SiteSummary } from "../types";
import {
  countAssignmentsPerWorkerName,
  subtractPullExtrasFromWorkerCounts,
} from "./assignments-summary-math";
import { addDays, formatHebDate, getWeekKeyISO } from "./week";
import {
  DAY_COLS,
  getRequiredFor,
  isDayActive,
  isShiftEnabledForStation,
  shiftNamesFromSite,
} from "./station-grid-helpers";
import { workerNameChipColor } from "./worker-name-chip-color";

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

function mergeCellRawWithPulls(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: PlanningV2PullsMap | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
): string[] {
  const cell = assignments?.[dayKey]?.[shiftName]?.[stationIdx];
  const baseArr: string[] = Array.isArray(cell)
    ? (cell as unknown[]).map((x) => String(x ?? ""))
    : [];
  const cellPrefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  const have = new Set(baseArr.map((x) => normName(x)).filter(Boolean));
  const normSlot = (s: unknown) => String(s ?? "");
  const addInto = (name: string) => {
    const n = normName(name);
    if (!n || have.has(n)) return;
    const emptyIdx = baseArr.findIndex((x) => !normName(x));
    if (emptyIdx >= 0) baseArr[emptyIdx] = normSlot(name);
    else baseArr.push(normSlot(name));
    have.add(n);
  };
  try {
    if (pulls) {
      Object.entries(pulls).forEach(([k, entry]) => {
        if (!String(k).startsWith(cellPrefix)) return;
        if (!isRealPullEntry(entry)) return;
        const e = entry as { before?: { name?: string }; after?: { name?: string } };
        const b = String(e?.before?.name || "").trim();
        const a = String(e?.after?.name || "").trim();
        if (b) addInto(b);
        if (a) addInto(a);
      });
    }
  } catch {
    /* ignore */
  }
  return baseArr;
}

/** Pour CSV / Excel — conversion approximative HSL CSS → hex. */
export function cssColorToHex(input: string): string {
  const t = String(input || "").trim();
  if (t.startsWith("#")) {
    if (t.length === 4) {
      return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`.toLowerCase();
    }
    return t.length >= 7 ? t.slice(0, 7).toLowerCase() : "#cccccc";
  }
  const m = t.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/i);
  if (!m) return "#cccccc";
  const hDeg = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const hh = ((hDeg % 360) + 360) % 360;
  const h = hh / 360;
  const hue2rgb = (p: number, q: number, tt: number) => {
    let t2 = tt;
    if (t2 < 0) t2 += 1;
    if (t2 > 1) t2 -= 1;
    if (t2 < 1 / 6) return p + (q - p) * 6 * t2;
    if (t2 < 1 / 2) return q;
    if (t2 < 2 / 3) return p + (q - p) * (2 / 3 - t2) * 6;
    return p;
  };
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (x: number) =>
    Math.round(Math.min(255, Math.max(0, x * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function csvEscapeField(s: string): string {
  const t = String(s ?? "");
  if (/[;"\r\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
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

export function safePlanningExportFilePart(raw: string): string {
  const s = String(raw || "")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .trim()
    .replace(/\s+/g, "-");
  return s.length ? s.slice(0, 80) : "planning";
}

export type PlanningExportTableData = {
  siteLabel: string;
  weekIso: string;
  summaryHeaders: string[];
  summaryRows: string[][];
  detailHeaders: string[];
  detailRows: string[][];
};

/** מבנה טבלאות זהה ל-CSV — משמש גם PDF (ללא html2canvas). */
export function buildPlanningExportTableData(params: {
  siteLabel: string;
  weekStart: Date;
  workers: PlanningWorker[];
  assignments: Record<string, Record<string, string[][]>> | null | undefined;
  pulls: PlanningV2PullsMap | null | undefined;
  site: SiteSummary | null;
  nameColorMap: Map<string, { bg: string; border: string; text: string }>;
}): PlanningExportTableData {
  const { siteLabel, weekStart, workers, assignments, pulls, site, nameColorMap } = params;
  const rows = buildSummaryRows(workers, assignments, pulls);
  const stations = (site?.config?.stations || []) as unknown[];
  const shiftNamesAll = shiftNamesFromSite(site);

  const summaryHeaders = ["עובד", "מספר משמרות", "צבע רקע (HEX)", "צבע טקסט (HEX)", "צבע מסגרת (HEX)"];
  const summaryRows: string[][] = [];
  for (const [nm, c] of rows) {
    const col = workerNameChipColor(nm, nameColorMap);
    summaryRows.push([nm, String(c), cssColorToHex(col.bg), cssColorToHex(col.text), cssColorToHex(col.border)]);
  }

  const detailHeaders = [
    "עמדה",
    "משמרת",
    "יום",
    "תאריך",
    "שם עובד",
    "מספר סלוט בתא",
    "צבע רקע (HEX)",
    "צבע טקסט (HEX)",
  ];
  const detailRows: string[][] = [];
  stations.forEach((st: unknown, stationIdx: number) => {
    const stationName = String((st as { name?: string })?.name || "").trim() || `עמדה ${stationIdx + 1}`;
    for (const sn of shiftNamesAll) {
      if (!isShiftEnabledForStation(st, sn)) continue;
      for (let dayIdx = 0; dayIdx < DAY_COLS.length; dayIdx++) {
        const d = DAY_COLS[dayIdx];
        const required = getRequiredFor(st as object, sn, d.key);
        const activeDay = isDayActive(st, d.key);
        if (!activeDay || required <= 0) continue;
        const merged = mergeCellRawWithPulls(assignments, pulls ?? null, d.key, sn, stationIdx);
        const dateStr = formatHebDate(addDays(weekStart, dayIdx));
        merged.forEach((rawName, slotIdx) => {
          const name = String(rawName || "").trim();
          if (!name) return;
          const col = workerNameChipColor(name, nameColorMap);
          detailRows.push([
            stationName,
            sn,
            d.label,
            dateStr,
            name,
            String(slotIdx + 1),
            cssColorToHex(col.bg),
            cssColorToHex(col.text),
          ]);
        });
      }
    }
  });

  return {
    siteLabel,
    weekIso: getWeekKeyISO(weekStart),
    summaryHeaders,
    summaryRows,
    detailHeaders,
    detailRows,
  };
}

/** CSV נתונים (סיכום + פירוט תאים) — UTF-8 BOM, מפריד `;` לתאימות Excel בעברית. */
export function buildPlanningDataCsv(params: {
  siteLabel: string;
  weekStart: Date;
  workers: PlanningWorker[];
  assignments: Record<string, Record<string, string[][]>> | null | undefined;
  pulls: PlanningV2PullsMap | null | undefined;
  site: SiteSummary | null;
  nameColorMap: Map<string, { bg: string; border: string; text: string }>;
}): string {
  const d = buildPlanningExportTableData(params);
  const lines: string[] = [];
  lines.push("\ufeffsep=;");
  lines.push(csvEscapeField(`אתר: ${d.siteLabel}`));
  lines.push(csvEscapeField(`שבוע מתאריך: ${d.weekIso}`));
  lines.push("");
  lines.push(csvEscapeField("סיכום משמרות לפי עובד"));
  lines.push(d.summaryHeaders.map(csvEscapeField).join(";"));
  for (const row of d.summaryRows) {
    lines.push(row.map(csvEscapeField).join(";"));
  }
  lines.push("");
  lines.push(csvEscapeField("פירוט תאים (עמדה / משמרת / יום)"));
  lines.push(d.detailHeaders.map(csvEscapeField).join(";"));
  for (const row of d.detailRows) {
    lines.push(row.map(csvEscapeField).join(";"));
  }
  return lines.join("\r\n");
}

/** טבלת HTML עם צבעי צ׳יפים — דומה לגריד השבועי (לצפייה בדפדפן / ייבוא לאקסל). */
export function buildPlanningGridStyledHtml(params: {
  siteLabel: string;
  weekStart: Date;
  workers: PlanningWorker[];
  assignments: Record<string, Record<string, string[][]>> | null | undefined;
  pulls: PlanningV2PullsMap | null | undefined;
  site: SiteSummary | null;
  nameColorMap: Map<string, { bg: string; border: string; text: string }>;
}): string {
  const { siteLabel, weekStart, workers, assignments, pulls, site, nameColorMap } = params;
  const summary = buildSummaryRows(workers, assignments, pulls);
  const stations = (site?.config?.stations || []) as unknown[];
  const shiftNamesAll = shiftNamesFromSite(site);

  const summaryTableRows = summary
    .map(([nm, c]) => {
      const col = workerNameChipColor(nm, nameColorMap);
      return `<tr>
  <td style="padding:6px 10px;border:1px solid #e4e4e7;text-align:center;">
    <span style="display:inline-block;padding:4px 10px;border-radius:9999px;border:1px solid ${escapeHtml(col.border)};background:${escapeHtml(col.bg)};color:${escapeHtml(col.text)};">${escapeHtml(nm)}</span>
  </td>
  <td style="padding:6px 10px;border:1px solid #e4e4e7;text-align:center;font-weight:600;">${c}</td>
</tr>`;
    })
    .join("\n");

  const stationSections = stations
    .map((st: unknown, idx: number) => {
      const stationName = String((st as { name?: string })?.name || "").trim() || `עמדה ${idx + 1}`;
      const headerCells = DAY_COLS.map((d, i) => {
        const date = formatHebDate(addDays(weekStart, i));
        return `<th style="padding:8px 6px;border:1px solid #d4d4d8;background:#fafafa;font-size:12px;">
  <div style="font-size:10px;color:#71717a;">${escapeHtml(date)}</div>
  <div style="margin-top:4px;font-weight:600;">${escapeHtml(d.label)}</div>
</th>`;
      }).join("");

      const bodyRows = shiftNamesAll
        .map((sn) => {
          if (!isShiftEnabledForStation(st, sn)) return "";
          return `<tr>
  <td style="padding:8px;border:1px solid #e4e4e7;background:#fafafa;font-size:12px;vertical-align:top;">
    <div style="font-weight:600;">${escapeHtml(sn)}</div>
  </td>
  ${DAY_COLS.map((d) => {
    const required = getRequiredFor(st as object, sn, d.key);
    const activeDay = isDayActive(st, d.key);
    const show = activeDay && required > 0;
    if (!show) {
      return `<td style="padding:6px;border:1px solid #e4e4e7;background:#f4f4f5;font-size:11px;color:#a1a1aa;text-align:center;">—</td>`;
    }
    const merged = mergeCellRawWithPulls(assignments, pulls ?? null, d.key, sn, idx);
    const names = merged.map((x) => String(x || "").trim()).filter(Boolean);
    if (names.length === 0) {
      return `<td style="padding:6px;border:1px solid #e4e4e7;background:#fff;min-width:72px;"></td>`;
    }
    const chips = names
      .map((nm) => {
        const col = workerNameChipColor(nm, nameColorMap);
        return `<div style="margin:3px 0;"><span style="display:inline-block;max-width:100%;padding:4px 8px;border-radius:9999px;border:1px solid ${escapeHtml(col.border)};background:${escapeHtml(col.bg)};color:${escapeHtml(col.text)};font-size:11px;">${escapeHtml(nm)}</span></div>`;
      })
      .join("");
    return `<td style="padding:6px;border:1px solid #e4e4e7;background:#fff;vertical-align:top;">${chips}</td>`;
  }).join("")}
</tr>`;
        })
        .filter(Boolean)
        .join("\n");

      return `<section style="margin-bottom:28px;page-break-inside:avoid;">
<h2 style="font-size:16px;margin:12px 0 8px;border-bottom:2px solid #e4e4e7;padding-bottom:6px;">${escapeHtml(stationName)}</h2>
<table dir="rtl" style="border-collapse:collapse;width:100%;font-family:system-ui,-apple-system,sans-serif;">
<thead><tr>
<th style="padding:8px;border:1px solid #d4d4d8;background:#fafafa;width:7rem;text-align:right;font-size:12px;">משמרת</th>
${headerCells}
</tr></thead>
<tbody>${bodyRows}</tbody>
</table>
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(siteLabel)} — ${escapeHtml(getWeekKeyISO(weekStart))}</title>
</head>
<body style="margin:16px;background:#fff;color:#18181b;">
<h1 style="font-size:18px;margin:0 0 12px;">${escapeHtml(siteLabel)}</h1>
<p style="margin:0 0 16px;color:#52525b;font-size:14px;">שבוע מתאריך: ${escapeHtml(getWeekKeyISO(weekStart))}</p>
<h2 style="font-size:15px;margin:16px 0 8px;">סיכום משמרות לפי עובד</h2>
<table dir="rtl" style="border-collapse:collapse;width:100%;max-width:560px;margin-bottom:24px;font-size:13px;">
<thead><tr>
<th style="padding:8px;border:1px solid #d4d4d8;background:#fafafa;">עובד</th>
<th style="padding:8px;border:1px solid #d4d4d8;background:#fafafa;">מספר משמרות</th>
</tr></thead>
<tbody>${summaryTableRows}</tbody>
</table>
${stationSections}
</body>
</html>`;
}

export function triggerDownloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

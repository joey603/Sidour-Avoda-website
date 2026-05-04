import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { PlanningExportTableData } from "./planning-v2-plan-export";

type JsPdfWithAutoTable = jsPDF & { lastAutoTable?: { finalY: number } };

const FONT_FILE = "NotoSansHebrew-Regular.ttf";
const FONT_NAME = "NotoHebrew";

let fontBase64Cache: string | null = null;

async function loadNotoHebrewFontBase64(): Promise<string> {
  if (fontBase64Cache) return fontBase64Cache;
  const base =
    typeof window !== "undefined" && window.location?.origin ? window.location.origin : "";
  const res = await fetch(`${base}/fonts/${FONT_FILE}`);
  if (!res.ok) {
    throw new Error(`טעינת גופן נכשלה (${res.status})`);
  }
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(slice) as number[]);
  }
  fontBase64Cache = btoa(binary);
  return fontBase64Cache;
}

/** PDF טקסטואלי בלבד — אותו תוכן כמו CSV, ללא html2canvas (אין lab/oklch). */
export async function generatePlanningPdfBlob(data: PlanningExportTableData): Promise<Blob> {
  const fontB64 = await loadNotoHebrewFontBase64();
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  doc.addFileToVFS(FONT_FILE, fontB64);
  doc.addFont(FONT_FILE, FONT_NAME, "normal");
  doc.setFont(FONT_NAME);

  const pageW = doc.internal.pageSize.getWidth();
  const margin = 12;

  doc.setFontSize(13);
  doc.text(data.siteLabel, pageW - margin, margin, { align: "right" });
  doc.setFontSize(9);
  doc.setTextColor(82, 82, 91);
  doc.text(`שבוע מתאריך: ${data.weekIso}`, pageW - margin, margin + 5, { align: "right" });
  doc.setTextColor(0, 0, 0);

  autoTable(doc, {
    startY: margin + 12,
    head: [data.summaryHeaders],
    body: data.summaryRows,
    styles: {
      font: FONT_NAME,
      fontSize: 8,
      cellPadding: 1.5,
      halign: "center",
      valign: "middle",
      textColor: [24, 24, 27],
    },
    headStyles: {
      fillColor: [250, 250, 250],
      textColor: [24, 24, 27],
      font: FONT_NAME,
      fontStyle: "normal",
    },
    margin: { left: margin, right: margin },
  });

  const docExt = doc as JsPdfWithAutoTable;
  const afterSummary = docExt.lastAutoTable?.finalY ?? margin + 12;

  doc.setFontSize(10);
  doc.text("פירוט תאים (עמדה / משמרת / יום)", pageW - margin, afterSummary + 8, { align: "right" });

  autoTable(doc, {
    startY: afterSummary + 14,
    head: [data.detailHeaders],
    body: data.detailRows,
    styles: {
      font: FONT_NAME,
      fontSize: 7,
      cellPadding: 1,
      halign: "center",
      valign: "middle",
      textColor: [24, 24, 27],
    },
    headStyles: {
      fillColor: [250, 250, 250],
      textColor: [24, 24, 27],
      font: FONT_NAME,
      fontStyle: "normal",
    },
    margin: { left: margin, right: margin },
    showHead: "everyPage",
    pageBreak: "auto",
  });

  return doc.output("blob");
}

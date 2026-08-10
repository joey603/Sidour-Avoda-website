import type { PlanningV2PullEntry } from "../types";

export function normWorkerName(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

export function planningV2PullEntryIsReal(e: PlanningV2PullEntry | undefined): boolean {
  const beforeName = normWorkerName(String(e?.before?.name || ""));
  const afterName = normWorkerName(String(e?.after?.name || ""));
  return !!beforeName && !!afterName && beforeName !== afterName;
}

export function truncateMobile6(value: unknown): string {
  const s = String(value ?? "");
  const chars = Array.from(s);
  return chars.length > 6 ? chars.slice(0, 4).join("") + "…" : s;
}

export function isRtlName(value: string): boolean {
  return /[\u0590-\u05FF]/.test(String(value || ""));
}

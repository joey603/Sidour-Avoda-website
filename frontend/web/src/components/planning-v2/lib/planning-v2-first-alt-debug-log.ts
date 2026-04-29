/**
 * Logs console pour déboguer l’alternative 0 uniquement : positions des sous-slots,
 * attribution brute depuis le serveur vs ordre affiché auto (alignement par rôle).
 */
import type { PlanningWorker, SiteSummary } from "../types";
import { DAY_COLS, getRequiredFor, isDayActive, shiftNamesFromSite } from "./station-grid-helpers";
import {
  alignNamesToRoleSlots,
  buildPullRoleMapForCell,
  computeRoleDisplayForCell,
} from "./planning-v2-slot-role-display";

function normName(s: unknown): string {
  return String(s || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

function mergeCellRawWithPulls(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: Record<string, unknown> | null | undefined,
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

export type PlanningV2FirstAltDebugCellRow = {
  stationIndex: number;
  dayKey: string;
  shiftName: string;
  slotIndex: number;
  /** Ordre brut (assignments + משיכות injectées comme dans la grille). */
  workerNameRaw: string;
  expectedRoleForSlot: string | null;
  roleResolvedOnRaw: string | null;
  /** Après alignNamesToRoleSlots (affichage auto hors édition manuelle). */
  workerNameDisplayAuto: string;
  roleResolvedOnDisplay: string | null;
};

export function buildFirstAlternativeDebugRows(
  site: SiteSummary | null,
  workers: PlanningWorker[],
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: Record<string, unknown> | null | undefined,
): PlanningV2FirstAltDebugCellRow[] {
  const stations = (Array.isArray(site?.config?.stations) ? site?.config?.stations : []) as Record<
    string,
    unknown
  >[];
  const out: PlanningV2FirstAltDebugCellRow[] = [];
  const shiftNamesAll = shiftNamesFromSite(site);

  stations.forEach((st, stationIndex) => {
    shiftNamesAll.forEach((sn) => {
      const stationShift = ((st.shifts as unknown[]) || []).find(
        (x) => (x as { name?: string })?.name === sn,
      ) as { enabled?: boolean } | undefined;
      const shiftRowEnabled = !!stationShift?.enabled;
      if (!shiftRowEnabled) return;

      DAY_COLS.forEach((d) => {
        const required = getRequiredFor(st, sn, d.key);
        const activeDay = isDayActive(st, d.key);
        const showCell = activeDay && required > 0;
        if (!showCell) return;

        const cellRaw = mergeCellRawWithPulls(assignments, pulls, d.key, sn, stationIndex);
        const pullRoleMap = buildPullRoleMapForCell(pulls || null, d.key, sn, stationIndex);
        const { roleHints, roleForSlot: roleForSlotRaw } = computeRoleDisplayForCell(
          workers,
          st,
          sn,
          d.key,
          cellRaw,
          pullRoleMap,
        );
        const displayCellRaw = alignNamesToRoleSlots(workers, cellRaw, roleHints);
        const { roleForSlot: roleForSlotDisplay } = computeRoleDisplayForCell(
          workers,
          st,
          sn,
          d.key,
          displayCellRaw,
          pullRoleMap,
        );

        const len = Math.max(cellRaw.length, displayCellRaw.length, 1);
        for (let slotIndex = 0; slotIndex < len; slotIndex++) {
          const workerNameRaw = String(cellRaw[slotIndex] || "").trim();
          const workerNameDisplayAuto = String(displayCellRaw[slotIndex] || "").trim();
          const expected = String(roleHints[slotIndex] || "").trim() || null;
          if (!workerNameRaw && !workerNameDisplayAuto && !expected) continue;
          out.push({
            stationIndex,
            dayKey: d.key,
            shiftName: sn,
            slotIndex,
            workerNameRaw,
            expectedRoleForSlot: expected,
            roleResolvedOnRaw: roleForSlotRaw[slotIndex] ?? null,
            workerNameDisplayAuto,
            roleResolvedOnDisplay: roleForSlotDisplay[slotIndex] ?? null,
          });
        }
      });
    });
  });

  return out;
}

/** À appeler après fin de `יצירת תכנון` (SSE), uniquement pour l’alternative 0. */
export function logPlanningV2FirstAltAfterGeneration(label: string, payload: unknown): void {
  try {
    console.log(`[planning-v2][alt0][${label}]`, payload);
  } catch {
    /* ignore */
  }
}

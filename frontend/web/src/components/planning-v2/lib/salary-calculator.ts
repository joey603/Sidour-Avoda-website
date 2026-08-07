/**
 * Calcul salaire brut IL à partir du תכנון (assignments + heures config + משיכות).
 */

import type { PlanningV2PullsMap, PlanningWorker, SiteSummary } from "../types";
import { DAY_COLS, hoursFromConfig, hoursOf } from "./station-grid-helpers";
import { getYomTovIsoSet } from "./jewish-holidays";
import {
  hourlyRateForWorker,
  isSalaryOnlyRoleName,
  monthlyBonusForWorker,
  normalizeSiteSalaryConfig,
  otMultiplierForHourIndex,
  SALARY_NO_ROLE_LABEL,
  workerEligibleForTravel,
  type SiteSalaryConfig,
} from "./site-salary-config";
import { addDays, getWeekKeyISO } from "./week";

export type SalaryWorkSegment = {
  workerName: string;
  startMs: number;
  endMs: number;
  label: string;
  /** Clé unique de la garde (יום|משמרת|עמדה|משבצת) pour נסיעות. */
  guardKey: string;
};

export type WorkerSalaryLine = {
  workerName: string;
  workerId?: number | null;
  roles: string[];
  hourlyRate: number;
  totalHours: number;
  regularHours: number;
  ot125Hours: number;
  ot150Hours: number;
  premiumHours: number;
  /** Nombre de gardes (pour נסיעות). */
  travelShifts: number;
  /** Heures bonus נסיעות (100%, hors temps de travail). */
  travelBonusHours: number;
  /** Paye נסיעות (₪). */
  travelPay: number;
  /** מענק חודשי (₪) — rempli surtout en משכורת חודש. */
  monthlyBonus: number;
  /** Paye des heures travaillées seule (sans נסיעות / מענק). */
  workPay: number;
  grossPay: number;
};

export type SalaryReport = {
  periodLabel: string;
  currency: "₪";
  config: SiteSalaryConfig;
  lines: WorkerSalaryLine[];
  totalGross: number;
  totalHours: number;
};

const DAY_KEY_TO_OFFSET: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function parseHm(hm: string): { h: number; m: number } | null {
  const m = String(hm || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return { h, m: min };
}

function parseHourRange(range: string | null): { start: string; end: string } | null {
  if (!range) return null;
  const s = String(range).trim();
  // "07:00-15:00" or "07-15"
  const m = s.match(/^(\d{1,2}(?::\d{2})?)\s*[-–]\s*(\d{1,2}(?::\d{2})?)$/);
  if (!m) return null;
  const norm = (x: string) => (x.includes(":") ? x : `${x.padStart(2, "0")}:00`);
  return { start: norm(m[1]), end: norm(m[2]) };
}

function hoursRangeForAssignment(
  station: any,
  shiftName: string,
  dayKey: string,
): { start: string; end: string } | null {
  if (station?.perDayCustom && station.dayOverrides?.[dayKey]) {
    const dcfg = station.dayOverrides[dayKey];
    if (dcfg && dcfg.active !== false) {
      const sh = (dcfg.shifts || []).find((x: any) => x?.name === shiftName);
      if (sh?.start && sh?.end) {
        return parseHourRange(`${sh.start}-${sh.end}`);
      }
    }
  }
  return parseHourRange(hoursFromConfig(station, shiftName)) || parseHourRange(hoursOf(shiftName));
}

function dateAtWeekDay(weekStart: Date, dayKey: string): Date {
  const offset = DAY_KEY_TO_OFFSET[dayKey] ?? 0;
  return addDays(weekStart, offset);
}

function toLocalMs(date: Date, hm: string): number | null {
  const p = parseHm(hm);
  if (!p) return null;
  const d = new Date(date);
  d.setHours(p.h, p.m, 0, 0);
  return d.getTime();
}

function isoFromMs(ms: number): string {
  const d = new Date(ms);
  return getWeekKeyISO(d);
}

function isPremiumInstant(
  ms: number,
  salary: SiteSalaryConfig,
  yomTovDays: Set<string>,
): boolean {
  const d = new Date(ms);
  const day = d.getDay(); // 0=Sun … 5=Fri 6=Sat
  const minutes = d.getHours() * 60 + d.getMinutes();
  const friStart = salary.weekendStartHour * 60 + salary.weekendStartMinute;
  const sunEnd = salary.weekendEndHour * 60 + salary.weekendEndMinute;

  // Vendredi dès l’heure configurée → samedi toute la journée → dimanche jusqu’à l’heure de fin
  if (day === 5 && minutes >= friStart) return true;
  if (day === 6) return true;
  if (day === 0 && minutes < sunEnd) return true;

  const iso = isoFromMs(ms);
  if (yomTovDays.has(iso)) return true;

  // Veille de Yom Tov : dès l’heure weekendStart (comme vendredi)
  const tomorrow = new Date(d);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowIso = getWeekKeyISO(tomorrow);
  if (yomTovDays.has(tomorrowIso) && minutes >= friStart) return true;

  // Matin après Yom Tov jusqu’à weekendEnd
  const yesterday = new Date(d);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayIso = getWeekKeyISO(yesterday);
  if (yomTovDays.has(yesterdayIso) && minutes < sunEnd) return true;

  return false;
}

function collectSegmentsForWeek(
  weekStart: Date,
  site: SiteSummary | null,
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  pulls: PlanningV2PullsMap | null | undefined,
): SalaryWorkSegment[] {
  const segments: SalaryWorkSegment[] = [];
  const stations = Array.isArray(site?.config?.stations) ? (site!.config!.stations as any[]) : [];
  const plan = assignments && typeof assignments === "object" ? assignments : {};

  for (const dayCol of DAY_COLS) {
    const dayKey = dayCol.key;
    const dayDate = dateAtWeekDay(weekStart, dayKey);
    const shiftsMap = plan[dayKey] || {};
    for (const [shiftName, perStation] of Object.entries(shiftsMap)) {
      if (!Array.isArray(perStation)) continue;
      perStation.forEach((cell, stationIdx) => {
        if (!Array.isArray(cell)) return;
        const station = stations[stationIdx] || stations[0] || null;
        const range = hoursRangeForAssignment(station, shiftName, dayKey);
        if (!range) return;

        cell.forEach((rawName, slotIdx) => {
          const workerName = String(rawName || "").trim();
          if (!workerName) return;
          const pullKey = `${dayKey}|${shiftName}|${stationIdx}|${slotIdx}`;
          const pull = pulls?.[pullKey];

          const guardKey = `${dayKey}|${shiftName}|${stationIdx}|${slotIdx}`;

          // שינוי שעות / garde display
          const display = pull?.guardDisplay;
          if (display?.start && display?.end && !pull?.before?.name && !pull?.after?.name) {
            const startMs = toLocalMs(dayDate, display.start);
            let endMs = toLocalMs(dayDate, display.end);
            if (startMs == null || endMs == null) return;
            if (endMs <= startMs) endMs += 24 * 60 * 60 * 1000;
            segments.push({
              workerName,
              startMs,
              endMs,
              label: `${dayKey}/${shiftName}`,
              guardKey,
            });
            return;
          }

          // משיכה : payer la portion before/after si le nom match
          if (pull?.before?.name || pull?.after?.name) {
            const beforeName = String(pull.before?.name || "").trim();
            const afterName = String(pull.after?.name || "").trim();
            if (beforeName === workerName && pull.before?.start && pull.before?.end) {
              const startMs = toLocalMs(dayDate, pull.before.start);
              let endMs = toLocalMs(dayDate, pull.before.end);
              if (startMs != null && endMs != null) {
                if (endMs <= startMs) endMs += 24 * 60 * 60 * 1000;
                segments.push({
                  workerName,
                  startMs,
                  endMs,
                  label: `${dayKey}/${shiftName}/משיכה`,
                  guardKey: `${guardKey}|before`,
                });
              }
            }
            if (afterName === workerName && pull.after?.start && pull.after?.end) {
              const startMs = toLocalMs(dayDate, pull.after.start);
              let endMs = toLocalMs(dayDate, pull.after.end);
              if (startMs != null && endMs != null) {
                if (endMs <= startMs) endMs += 24 * 60 * 60 * 1000;
                segments.push({
                  workerName,
                  startMs,
                  endMs,
                  label: `${dayKey}/${shiftName}/משיכה`,
                  guardKey: `${guardKey}|after`,
                });
              }
            }
            // Si le worker n'est que dans la cellule « pleine » sans être before/after, ignorer
            if (beforeName === workerName || afterName === workerName) return;
          }

          const startMs = toLocalMs(dayDate, range.start);
          let endMs = toLocalMs(dayDate, range.end);
          if (startMs == null || endMs == null) return;
          if (endMs <= startMs) endMs += 24 * 60 * 60 * 1000;
          segments.push({
            workerName,
            startMs,
            endMs,
            label: `${dayKey}/${shiftName}`,
            guardKey,
          });
        });
      });
    }
  }

  return segments;
}

function travelForWorker(
  salary: SiteSalaryConfig,
  hourlyRate: number,
  guardCount: number,
  eligible: boolean,
): { travelShifts: number; travelBonusHours: number; travelPay: number } {
  const travelShifts = Math.max(0, guardCount);
  if (!eligible || travelShifts === 0 || salary.travelMode === "none") {
    return { travelShifts: eligible ? travelShifts : 0, travelBonusHours: 0, travelPay: 0 };
  }
  if (salary.travelMode === "fixed") {
    return {
      travelShifts,
      travelBonusHours: 0,
      travelPay: travelShifts * Math.max(0, salary.travelFixedPerShift),
    };
  }
  // hours : 100% du tarif, hors OT / Shabbat / temps de travail
  const travelBonusHours = travelShifts * Math.max(0, salary.travelHoursPerShift);
  return {
    travelShifts,
    travelBonusHours,
    travelPay: travelBonusHours * Math.max(0, hourlyRate),
  };
}

function payWorkerSegments(
  workerName: string,
  workerRoles: string[],
  segments: SalaryWorkSegment[],
  salary: SiteSalaryConfig,
  yomTovDays: Set<string>,
  options?: {
    includeMonthlyBonus?: boolean;
    workerId?: number | null;
  },
): WorkerSalaryLine {
  const hourlyRate = hourlyRateForWorker(salary, workerRoles);
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);

  // Compteur d’heures par jour civil (pour OT)
  const dayHourIndex = new Map<string, number>();
  let regularHours = 0;
  let ot125Hours = 0;
  let ot150Hours = 0;
  let premiumHours = 0;
  let workPay = 0;
  let totalHours = 0;

  const STEP_MS = 60 * 1000; // 1 minute

  for (const seg of sorted) {
    for (let t = seg.startMs; t < seg.endMs; t += STEP_MS) {
      const iso = isoFromMs(t);
      const prev = dayHourIndex.get(iso) || 0;
      const next = prev + 1 / 60;
      dayHourIndex.set(iso, next);
      const hourIndex1Based = Math.floor(prev) + 1;

      const premium = isPremiumInstant(t, salary, yomTovDays);
      const otMult = otMultiplierForHourIndex(hourIndex1Based, salary);
      let mult = otMult;
      if (premium) {
        const premMult = Math.max(salary.weekendPremiumPercent, salary.yomTovPremiumPercent) / 100;
        mult = Math.max(mult, premMult);
        premiumHours += 1 / 60;
      } else if (hourIndex1Based >= 11) {
        ot150Hours += 1 / 60;
      } else if (hourIndex1Based === 9 || hourIndex1Based === 10) {
        ot125Hours += 1 / 60;
      } else {
        regularHours += 1 / 60;
      }

      workPay += hourlyRate * mult * (1 / 60);
      totalHours += 1 / 60;
    }
  }

  const uniqueGuards = new Set(segments.map((s) => s.guardKey).filter(Boolean));
  const eligibleTravel = workerEligibleForTravel(salary, {
    id: options?.workerId,
    name: workerName,
  });
  const travel = travelForWorker(salary, hourlyRate, uniqueGuards.size, eligibleTravel);
  const monthlyBonus = options?.includeMonthlyBonus
    ? monthlyBonusForWorker(salary, workerRoles, {
        id: options?.workerId,
        name: workerName,
      })
    : 0;
  const grossPay = workPay + travel.travelPay + monthlyBonus;

  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    workerName,
    workerId: options?.workerId ?? null,
    roles: workerRoles,
    hourlyRate,
    totalHours: round2(totalHours),
    regularHours: round2(regularHours),
    ot125Hours: round2(ot125Hours),
    ot150Hours: round2(ot150Hours),
    premiumHours: round2(premiumHours),
    travelShifts: travel.travelShifts,
    travelBonusHours: round2(travel.travelBonusHours),
    travelPay: round2(travel.travelPay),
    monthlyBonus: round2(monthlyBonus),
    workPay: round2(workPay),
    grossPay: round2(grossPay),
  };
}

export function computeSalaryReportForWeek(args: {
  weekStart: Date;
  site: SiteSummary | null;
  workers: PlanningWorker[];
  assignments: Record<string, Record<string, string[][]>> | null | undefined;
  pulls?: PlanningV2PullsMap | null;
  periodLabel?: string;
  /** Inclure le מענק חודשי (typiquement faux pour semaine, vrai via merge mensuel). */
  includeMonthlyBonus?: boolean;
}): SalaryReport {
  const salary = normalizeSiteSalaryConfig(
    args.site?.config && typeof args.site.config === "object"
      ? (args.site.config as Record<string, unknown>).salary
      : null,
  );
  const weekIso = getWeekKeyISO(args.weekStart);
  const endIso = getWeekKeyISO(addDays(args.weekStart, 6));
  // Inclure veilles / lendemains pour premium Yom Tov
  const yomTovDays = getYomTovIsoSet(
    getWeekKeyISO(addDays(args.weekStart, -1)),
    getWeekKeyISO(addDays(args.weekStart, 7)),
  );

  const segments = collectSegmentsForWeek(
    args.weekStart,
    args.site,
    args.assignments,
    args.pulls || null,
  );
  const byWorker = new Map<string, SalaryWorkSegment[]>();
  for (const seg of segments) {
    const list = byWorker.get(seg.workerName) || [];
    list.push(seg);
    byWorker.set(seg.workerName, list);
  }

  const workerByName = new Map(
    args.workers.map((w) => [String(w.name || "").trim(), w] as const),
  );

  const lines: WorkerSalaryLine[] = [];
  for (const [name, segs] of byWorker) {
    const w = workerByName.get(name);
    const rawRoles = Array.isArray(w?.roles) ? w!.roles : [];
    const roles = rawRoles
      .map((r) => String(r || "").trim())
      .filter((r) => r && !isSalaryOnlyRoleName(r));
    // Affichage salaire uniquement — pas un rôle planning
    const displayRoles = roles.length > 0 ? roles : [SALARY_NO_ROLE_LABEL];
    lines.push(
      payWorkerSegments(
        name,
        roles,
        segs,
        salary,
        yomTovDays,
        {
          includeMonthlyBonus: !!args.includeMonthlyBonus,
          workerId: w?.id ?? null,
        },
      ),
    );
    const last = lines[lines.length - 1];
    if (last) last.roles = displayRoles;
  }
  lines.sort((a, b) => a.workerName.localeCompare(b.workerName, "he"));

  const totalGross = Math.round(lines.reduce((s, l) => s + l.grossPay, 0) * 100) / 100;
  const totalHours = Math.round(lines.reduce((s, l) => s + l.totalHours, 0) * 100) / 100;

  return {
    periodLabel: args.periodLabel || `שבוע ${weekIso} – ${endIso}`,
    currency: "₪",
    config: salary,
    lines,
    totalGross,
    totalHours,
  };
}

export function mergeSalaryReports(
  reports: SalaryReport[],
  periodLabel: string,
  options?: { applyMonthlyBonus?: boolean },
): SalaryReport {
  const byName = new Map<string, WorkerSalaryLine>();
  let config = reports[0]?.config || normalizeSiteSalaryConfig(null);
  for (const r of reports) {
    config = r.config;
    for (const line of r.lines) {
      const prev = byName.get(line.workerName);
      if (!prev) {
        byName.set(line.workerName, {
          ...line,
          workerId: line.workerId ?? null,
          // Le מענק est appliqué une seule fois au merge mensuel
          monthlyBonus: 0,
          grossPay: Math.round((line.workPay + line.travelPay) * 100) / 100,
        });
        continue;
      }
      if (line.workerId != null && prev.workerId == null) prev.workerId = line.workerId;
      prev.totalHours = Math.round((prev.totalHours + line.totalHours) * 100) / 100;
      prev.regularHours = Math.round((prev.regularHours + line.regularHours) * 100) / 100;
      prev.ot125Hours = Math.round((prev.ot125Hours + line.ot125Hours) * 100) / 100;
      prev.ot150Hours = Math.round((prev.ot150Hours + line.ot150Hours) * 100) / 100;
      prev.premiumHours = Math.round((prev.premiumHours + line.premiumHours) * 100) / 100;
      prev.travelShifts += line.travelShifts;
      prev.travelBonusHours = Math.round((prev.travelBonusHours + line.travelBonusHours) * 100) / 100;
      prev.travelPay = Math.round((prev.travelPay + line.travelPay) * 100) / 100;
      prev.workPay = Math.round((prev.workPay + line.workPay) * 100) / 100;
      prev.grossPay = Math.round((prev.workPay + prev.travelPay + prev.monthlyBonus) * 100) / 100;
      if (line.hourlyRate > prev.hourlyRate) prev.hourlyRate = line.hourlyRate;
      // Union des rôles (ללא תפקיד = affichage salaire seulement)
      for (const role of line.roles) {
        if (!prev.roles.includes(role)) prev.roles = [...prev.roles, role];
      }
      const realRoles = prev.roles.filter((r) => !isSalaryOnlyRoleName(r));
      prev.roles = realRoles.length > 0 ? realRoles : [SALARY_NO_ROLE_LABEL];
    }
  }

  if (options?.applyMonthlyBonus) {
    for (const line of byName.values()) {
      const rolesForBonus = line.roles.filter((r) => !isSalaryOnlyRoleName(r));
      line.monthlyBonus = Math.round(
        monthlyBonusForWorker(config, rolesForBonus, {
          id: line.workerId,
          name: line.workerName,
        }) * 100,
      ) / 100;
      line.grossPay = Math.round((line.workPay + line.travelPay + line.monthlyBonus) * 100) / 100;
    }
  }

  const lines = Array.from(byName.values()).sort((a, b) =>
    a.workerName.localeCompare(b.workerName, "he"),
  );
  return {
    periodLabel,
    currency: "₪",
    config,
    lines,
    totalGross: Math.round(lines.reduce((s, l) => s + l.grossPay, 0) * 100) / 100,
    totalHours: Math.round(lines.reduce((s, l) => s + l.totalHours, 0) * 100) / 100,
  };
}

export type WorkerHoursTotal = { workerName: string; hours: number };

/**
 * Total d’heures travaillées par employé (segments planning + משיכות).
 * Optionnellement borné au mois civil (pour סידור חודשי).
 */
export function computeWorkerHoursTotals(args: {
  weekStart: Date;
  site: SiteSummary | null;
  assignments: Record<string, Record<string, string[][]>> | null | undefined;
  pulls?: PlanningV2PullsMap | null;
  clipToMonth?: { year: number; monthIndex: number };
}): WorkerHoursTotal[] {
  const segments = collectSegmentsForWeek(
    args.weekStart,
    args.site,
    args.assignments,
    args.pulls || null,
  );
  let rangeStart = Number.NEGATIVE_INFINITY;
  let rangeEnd = Number.POSITIVE_INFINITY;
  if (args.clipToMonth) {
    const { year, monthIndex } = args.clipToMonth;
    rangeStart = new Date(year, monthIndex, 1, 0, 0, 0, 0).getTime();
    rangeEnd = new Date(year, monthIndex + 1, 1, 0, 0, 0, 0).getTime();
  }

  const byName = new Map<string, number>();
  for (const seg of segments) {
    const start = Math.max(seg.startMs, rangeStart);
    const end = Math.min(seg.endMs, rangeEnd);
    if (!(end > start)) continue;
    const hours = (end - start) / (60 * 60 * 1000);
    byName.set(seg.workerName, (byName.get(seg.workerName) || 0) + hours);
  }

  return Array.from(byName.entries())
    .map(([workerName, hours]) => ({
      workerName,
      hours: Math.round(hours * 100) / 100,
    }))
    .filter((x) => x.hours > 0)
    .sort((a, b) => a.workerName.localeCompare(b.workerName, "he"));
}

export function mergeWorkerHoursTotals(lists: WorkerHoursTotal[][]): WorkerHoursTotal[] {
  const byName = new Map<string, number>();
  for (const list of lists) {
    for (const row of list) {
      byName.set(row.workerName, (byName.get(row.workerName) || 0) + row.hours);
    }
  }
  return Array.from(byName.entries())
    .map(([workerName, hours]) => ({
      workerName,
      hours: Math.round(hours * 100) / 100,
    }))
    .filter((x) => x.hours > 0)
    .sort((a, b) => a.workerName.localeCompare(b.workerName, "he"));
}

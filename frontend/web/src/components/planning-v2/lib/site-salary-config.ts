/**
 * Config salaire site — stockée dans site.config.salary
 * Calcul brut selon règles IL configurables (שעות נוספות + שבת/חג + מענק + נסיעות).
 */

export type TravelAllowanceMode = "none" | "fixed" | "hours";

/**
 * Pseudo-rôle salaire uniquement (עובד בלי תפקיד).
 * Ne jamais l’ajouter aux rôles stations / planning.
 */
export const SALARY_NO_ROLE_LABEL = "ללא תפקיד";

export function isSalaryOnlyRoleName(name: string | null | undefined): boolean {
  return String(name || "").trim() === SALARY_NO_ROLE_LABEL;
}

export type SiteSalaryConfig = {
  /**
   * Active le calcul salaire + boutons משכורת / משכורת חודש dans le planning.
   * Défaut : false.
   */
  enabled: boolean;
  /** Salaire horaire de base (₪) si aucun rôle spécifique. */
  defaultHourlyRate: number;
  /** Tarif horaire par rôle (nom rôle → ₪). */
  ratesByRole: Record<string, number>;
  /** מענק חודשי par rôle (₪ / mois). */
  monthlyBonusByRole: Record<string, number>;
  /** מענק חודשי par défaut (si rôle sans valeur). */
  defaultMonthlyBonus: number;
  /**
   * Si true (défaut) — מענק pour tous (selon rôle).
   * Si false — uniquement monthlyBonusWorkerIds / Names.
   */
  monthlyBonusAllWorkers: boolean;
  monthlyBonusWorkerIds: number[];
  monthlyBonusWorkerNames: string[];
  /**
   * נסיעות : aucune / somme fixe par garde / heures bonus par garde.
   * Les heures nesi'ot sont payées au tarif de base (100%) — pas d'OT / pas de % Shabbat,
   * et ne comptent pas comme temps de travail.
   */
  travelMode: TravelAllowanceMode;
  /** ₪ par garde (si travelMode === "fixed"). */
  travelFixedPerShift: number;
  /** Heures bonus par garde (si travelMode === "hours"), ex. 1. */
  travelHoursPerShift: number;
  /**
   * Si true (défaut) — נסיעות pour tous les employés.
   * Si false — uniquement travelWorkerIds / travelWorkerNames.
   */
  travelAllWorkers: boolean;
  /** IDs des employés éligibles aux נסיעות (si !travelAllWorkers). */
  travelWorkerIds: number[];
  /** Noms (fallback matching planning) si !travelAllWorkers. */
  travelWorkerNames: string[];
  /** אחוז לשעה ה־9 ביום (ברירת מחדל 125). */
  otHour9Percent: number;
  /** אחוז לשעה ה־10 ביום (ברירת מחדל 125). */
  otHour10Percent: number;
  /** אחוז משעה ה־11 ואילך ביום (ברירת מחדל 150). */
  otHour11Percent: number;
  /** Vendredi → dimanche (et Yom Tov). */
  weekendPremiumPercent: number;
  /** Heure début premium vendredi (défaut 16). */
  weekendStartHour: number;
  weekendStartMinute: number;
  /** Heure fin premium dimanche matin (défaut 4). */
  weekendEndHour: number;
  weekendEndMinute: number;
  yomTovPremiumPercent: number;
};

export const DEFAULT_SITE_SALARY_CONFIG: SiteSalaryConfig = {
  enabled: false,
  defaultHourlyRate: 0,
  ratesByRole: {},
  monthlyBonusByRole: {},
  defaultMonthlyBonus: 0,
  monthlyBonusAllWorkers: true,
  monthlyBonusWorkerIds: [],
  monthlyBonusWorkerNames: [],
  travelMode: "none",
  travelFixedPerShift: 0,
  travelHoursPerShift: 1,
  travelAllWorkers: true,
  travelWorkerIds: [],
  travelWorkerNames: [],
  otHour9Percent: 125,
  otHour10Percent: 125,
  otHour11Percent: 150,
  weekendPremiumPercent: 150,
  weekendStartHour: 16,
  weekendStartMinute: 0,
  weekendEndHour: 4,
  weekendEndMinute: 0,
  yomTovPremiumPercent: 150,
};

function normalizeNonNegRecord(raw: unknown): Record<string, number> {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(src)) {
    const name = String(k || "").trim();
    const n = Number(v);
    if (name && Number.isFinite(n) && n >= 0) out[name] = n;
  }
  return out;
}

function normalizeIdList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    const id = Math.trunc(n);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeNameList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const name = String(v || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

const SALARY_PERCENT_CHOICES: number[] = [100, 125, 150];

function snapSalaryPercent(v: unknown, fallback: number): number {
  const n = Number(v);
  const base = Number.isFinite(n) ? n : fallback;
  let best = SALARY_PERCENT_CHOICES[0] ?? 100;
  let bestDist = Math.abs(best - base);
  for (const x of SALARY_PERCENT_CHOICES) {
    const d = Math.abs(x - base);
    if (d < bestDist) {
      best = x;
      bestDist = d;
    }
  }
  return best;
}

export function normalizeSiteSalaryConfig(raw: unknown): SiteSalaryConfig {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const d = DEFAULT_SITE_SALARY_CONFIG;
  const modeRaw = String(src.travelMode || d.travelMode).trim();
  const travelMode: TravelAllowanceMode =
    modeRaw === "fixed" || modeRaw === "hours" || modeRaw === "none" ? modeRaw : "none";

  // Migration depuis l’ancien format (ot125Percent / ot150Percent)
  const legacy125 = num(src.ot125Percent, d.otHour9Percent);
  const legacy150 = num(src.ot150Percent, d.otHour11Percent);

  return {
    enabled: src.enabled === true,
    defaultHourlyRate: Math.max(0, num(src.defaultHourlyRate, d.defaultHourlyRate)),
    ratesByRole: normalizeNonNegRecord(src.ratesByRole),
    monthlyBonusByRole: normalizeNonNegRecord(src.monthlyBonusByRole),
    defaultMonthlyBonus: Math.max(0, num(src.defaultMonthlyBonus, d.defaultMonthlyBonus)),
    monthlyBonusAllWorkers: src.monthlyBonusAllWorkers === false ? false : true,
    monthlyBonusWorkerIds: normalizeIdList(src.monthlyBonusWorkerIds),
    monthlyBonusWorkerNames: normalizeNameList(src.monthlyBonusWorkerNames),
    travelMode,
    travelFixedPerShift: Math.max(0, num(src.travelFixedPerShift, d.travelFixedPerShift)),
    travelHoursPerShift: Math.max(0, num(src.travelHoursPerShift, d.travelHoursPerShift)),
    travelAllWorkers: src.travelAllWorkers === false ? false : true,
    travelWorkerIds: normalizeIdList(src.travelWorkerIds),
    travelWorkerNames: normalizeNameList(src.travelWorkerNames),
    otHour9Percent: snapSalaryPercent(src.otHour9Percent ?? legacy125, d.otHour9Percent),
    otHour10Percent: snapSalaryPercent(src.otHour10Percent ?? legacy125, d.otHour10Percent),
    otHour11Percent: snapSalaryPercent(src.otHour11Percent ?? legacy150, d.otHour11Percent),
    weekendPremiumPercent: snapSalaryPercent(src.weekendPremiumPercent, d.weekendPremiumPercent),
    weekendStartHour: Math.max(0, Math.min(23, Math.trunc(num(src.weekendStartHour, d.weekendStartHour)))),
    weekendStartMinute: Math.max(0, Math.min(59, Math.trunc(num(src.weekendStartMinute, d.weekendStartMinute)))),
    weekendEndHour: Math.max(0, Math.min(23, Math.trunc(num(src.weekendEndHour, d.weekendEndHour)))),
    weekendEndMinute: Math.max(0, Math.min(59, Math.trunc(num(src.weekendEndMinute, d.weekendEndMinute)))),
    yomTovPremiumPercent: snapSalaryPercent(src.yomTovPremiumPercent, d.yomTovPremiumPercent),
  };
}

export function isSiteSalaryEnabled(siteConfig: Record<string, unknown> | null | undefined): boolean {
  return normalizeSiteSalaryConfig(siteConfig?.salary).enabled;
}

/** Multiplicateur OT pour la N-ème heure travaillée dans la journée (1-based). */
export function otMultiplierForHourIndex(hourIndex1Based: number, salary: SiteSalaryConfig): number {
  if (hourIndex1Based >= 11) return salary.otHour11Percent / 100;
  if (hourIndex1Based === 10) return salary.otHour10Percent / 100;
  if (hourIndex1Based === 9) return salary.otHour9Percent / 100;
  return 1;
}

function workerInSelection(
  worker: { id?: number | null; name?: string | null } | null | undefined,
  allWorkers: boolean,
  ids: number[],
  names: string[],
): boolean {
  if (allWorkers) return true;
  const id = Number(worker?.id);
  if (Number.isFinite(id) && id > 0 && ids.includes(Math.trunc(id))) return true;
  const name = String(worker?.name || "").trim();
  if (name && names.includes(name)) return true;
  return false;
}

/** L’employé est-il éligible aux נסיעות ? */
export function workerEligibleForTravel(
  salary: SiteSalaryConfig,
  worker: { id?: number | null; name?: string | null } | null | undefined,
): boolean {
  if (salary.travelMode === "none") return false;
  return workerInSelection(
    worker,
    salary.travelAllWorkers,
    salary.travelWorkerIds,
    salary.travelWorkerNames,
  );
}

/** L’employé est-il éligible au מענק חודשי ? */
export function workerEligibleForMonthlyBonus(
  salary: SiteSalaryConfig,
  worker: { id?: number | null; name?: string | null } | null | undefined,
): boolean {
  return workerInSelection(
    worker,
    salary.monthlyBonusAllWorkers,
    salary.monthlyBonusWorkerIds,
    salary.monthlyBonusWorkerNames,
  );
}

export function collectRoleNamesFromSiteConfig(config: Record<string, unknown> | null | undefined): string[] {
  const names = new Set<string>();
  const stations = Array.isArray(config?.stations) ? (config!.stations as any[]) : [];
  for (const st of stations) {
    for (const r of st?.roles || []) {
      const n = String(r?.name || "").trim();
      // Exclure le pseudo-rôle salaire s’il a été sauvé par erreur dans les stations
      if (n && !isSalaryOnlyRoleName(n)) names.add(n);
    }
    for (const sh of st?.shifts || []) {
      for (const r of sh?.roles || []) {
        const n = String(r?.name || "").trim();
        if (n && !isSalaryOnlyRoleName(n)) names.add(n);
      }
    }
    if (st?.dayOverrides && typeof st.dayOverrides === "object") {
      for (const day of Object.values(st.dayOverrides as Record<string, any>)) {
        for (const sh of day?.shifts || []) {
          for (const r of sh?.roles || []) {
            const n = String(r?.name || "").trim();
            if (n && !isSalaryOnlyRoleName(n)) names.add(n);
          }
        }
      }
    }
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b, "he"));
}

/** Rôles affichés dans les réglages salaire : ללא תפקיד en premier + rôles du site. */
export function collectSalaryRoleNames(config: Record<string, unknown> | null | undefined): string[] {
  return [SALARY_NO_ROLE_LABEL, ...collectRoleNamesFromSiteConfig(config)];
}

export function hourlyRateForWorker(
  salary: SiteSalaryConfig,
  workerRoles: string[] | null | undefined,
): number {
  const roles = Array.isArray(workerRoles)
    ? workerRoles.map((r) => String(r || "").trim()).filter((r) => r && !isSalaryOnlyRoleName(r))
    : [];
  if (roles.length === 0) {
    const noRoleRate = salary.ratesByRole[SALARY_NO_ROLE_LABEL];
    if (Number.isFinite(noRoleRate) && noRoleRate >= 0) {
      // Si une valeur explicite est définie pour ללא תפקיד, elle prime
      if (Object.prototype.hasOwnProperty.call(salary.ratesByRole, SALARY_NO_ROLE_LABEL)) {
        return Math.max(0, noRoleRate);
      }
    }
    return Math.max(0, salary.defaultHourlyRate);
  }
  let best = salary.defaultHourlyRate;
  for (const role of roles) {
    const rate = salary.ratesByRole[role];
    if (Number.isFinite(rate) && rate > best) best = rate;
  }
  return best;
}

/** מענק חודשי : le plus élevé parmi les rôles du worker (ou défaut / ללא תפקיד). */
export function monthlyBonusForWorker(
  salary: SiteSalaryConfig,
  workerRoles: string[] | null | undefined,
  worker?: { id?: number | null; name?: string | null } | null,
): number {
  if (worker && !workerEligibleForMonthlyBonus(salary, worker)) return 0;
  // Sans worker fourni (appel legacy) — on calcule le montant ; l’éligibilité est filtrée ailleurs.
  const roles = Array.isArray(workerRoles)
    ? workerRoles.map((r) => String(r || "").trim()).filter((r) => r && !isSalaryOnlyRoleName(r))
    : [];
  if (roles.length === 0) {
    if (Object.prototype.hasOwnProperty.call(salary.monthlyBonusByRole, SALARY_NO_ROLE_LABEL)) {
      return Math.max(0, Number(salary.monthlyBonusByRole[SALARY_NO_ROLE_LABEL]) || 0);
    }
    return Math.max(0, salary.defaultMonthlyBonus);
  }
  let best = salary.defaultMonthlyBonus;
  for (const role of roles) {
    const bonus = salary.monthlyBonusByRole[role];
    if (Number.isFinite(bonus) && bonus > best) best = bonus;
  }
  return Math.max(0, best);
}

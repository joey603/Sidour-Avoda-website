/** Helpers alignés sur la section « גריד שבועי לפי עמדה » du planning director (lecture seule). */

export const DAY_COLS = [
  { key: "sun", label: "א'" },
  { key: "mon", label: "ב'" },
  { key: "tue", label: "ג'" },
  { key: "wed", label: "ד'" },
  { key: "thu", label: "ה'" },
  { key: "fri", label: "ו'" },
  { key: "sat", label: "ש'" },
] as const;

export function planningCellNames(cell: unknown): string[] {
  if (!Array.isArray(cell)) return [];
  return cell.map((name) => String(name ?? "").trim()).filter(Boolean);
}

export function getRequiredFor(st: any, shiftName: string, dayKey: string): number {
  if (!st) return 0;
  if (st.perDayCustom) {
    const dayCfg = st.dayOverrides?.[dayKey];
    if (!dayCfg || dayCfg.active === false) return 0;
    if (st.uniformRoles) {
      return Number(st.workers || 0);
    }
    const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
    if (!sh || !sh.enabled) return 0;
    return Number(sh.workers || 0);
  }
  if (st.days && st.days[dayKey] === false) return 0;
  if (st.uniformRoles) {
    return Number(st.workers || 0);
  }
  const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
  if (!sh || !sh.enabled) return 0;
  return Number(sh.workers || 0);
}

export function isDayActive(st: any, dayKey: string): boolean {
  if (!st) return false;
  if (st.perDayCustom) {
    const dayCfg = st.dayOverrides?.[dayKey];
    return !!(dayCfg && dayCfg.active);
  }
  if (st.days && Object.prototype.hasOwnProperty.call(st.days, dayKey)) {
    return st.days[dayKey] !== false;
  }
  return true;
}

export function hoursOf(sn: string): string | null {
  const s = String(sn || "");
  const m = s.match(/(\d{1,2})\s*[-:–]\s*(\d{1,2})/);
  if (m) {
    const a = m[1].padStart(2, "0");
    const b = m[2].padStart(2, "0");
    return `${a}-${b}`;
  }
  if (/בוקר/i.test(s)) return "06-14";
  if (/צהר(יים|י)ם?/i.test(s)) return "14-22";
  if (/לילה|night/i.test(s)) return "22-06";
  return null;
}

export function hoursFromConfig(station: any, shiftName: string): string | null {
  if (!station) return null;
  function fmt(start?: string, end?: string): string | null {
    if (!start || !end) return null;
    return `${start}-${end}`;
  }
  if (station.perDayCustom && station.dayOverrides) {
    const order = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    for (const key of order) {
      const dcfg = station.dayOverrides?.[key];
      if (!dcfg || dcfg.active === false) continue;
      const sh = (dcfg.shifts || []).find((x: any) => x?.name === shiftName);
      const f = fmt(sh?.start, sh?.end);
      if (f) return f;
    }
  }
  const base = (station.shifts || []).find((x: any) => x?.name === shiftName);
  return fmt(base?.start, base?.end);
}

export function shiftNamesFromSite(site: { config?: { stations?: unknown[] } } | null): string[] {
  return Array.from(
    new Set(
      ((site?.config?.stations || []) as { shifts?: Array<{ enabled?: boolean; name?: string }> }[])
        .flatMap((st) => (st?.shifts || []).filter((sh) => sh?.enabled).map((sh) => sh?.name))
        .filter(Boolean) as string[],
    ),
  );
}

/** Grille vide (מחרוזות ריקות) pour chaque תא actif — aligné sur איפוס / אפס גריד. */
export function buildEmptyAssignmentsForSite(site: { config?: { stations?: unknown[] } } | null): Record<
  string,
  Record<string, string[][]>
> {
  const stations = (site?.config?.stations || []) as any[];
  const shiftNames = shiftNamesFromSite(site);
  const out: Record<string, Record<string, string[][]>> = {};
  for (const d of DAY_COLS) {
    out[d.key] = {};
    for (const sn of shiftNames) {
      const col: string[][] = stations.map((st: any) => {
        const stationShift = (st.shifts || []).find((x: any) => x?.name === sn);
        if (!stationShift?.enabled) return [];
        const activeDay = isDayActive(st, d.key);
        const required = getRequiredFor(st, sn, d.key);
        if (!activeDay || required <= 0) return [];
        return Array.from({ length: required }, () => "");
      });
      out[d.key][sn] = col;
    }
  }
  return out;
}

/** Au moins un « trou » isolé (case vide entre deux cases remplies), pour activer משיכות — comme le planning classique. */
export function stationHasIsolatedHole(
  site: { config?: { stations?: unknown[] } } | null,
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
  stationIndex: number,
): boolean {
  const stations = (site?.config?.stations || []) as any[];
  const st = stations[stationIndex];
  if (!st) return false;
  const shiftNamesAll = shiftNamesFromSite(site);
  const shiftsCount = shiftNamesAll.length;

  const cellCount = (dayIdx: number, shiftIdx: number): number => {
    if (dayIdx < 0 || dayIdx > 6) return 0;
    if (shiftIdx < 0 || shiftIdx >= shiftsCount) return 0;
    const dayKey = DAY_COLS[dayIdx].key;
    const shiftName = shiftNamesAll[shiftIdx];
    const required = getRequiredFor(st, shiftName, dayKey);
    if (!required || required <= 0) return 0;
    if (!isDayActive(st, dayKey)) return 0;
    const stationShift = (st.shifts || []).find((x: any) => x?.name === shiftName);
    if (!stationShift?.enabled) return 0;
    const cell = assignments?.[dayKey]?.[shiftName]?.[stationIndex];
    const names = Array.isArray(cell) ? (cell as unknown[]).filter((x) => x && String(x).trim()) : [];
    return names.length;
  };

  for (let dayIdx = 0; dayIdx < DAY_COLS.length; dayIdx++) {
    for (let sIdx = 0; sIdx < shiftsCount; sIdx++) {
      const dayKey = DAY_COLS[dayIdx].key;
      const shiftName = shiftNamesAll[sIdx];
      const required = getRequiredFor(st, shiftName, dayKey);
      if (!required || required <= 0) continue;
      const stationShift = (st.shifts || []).find((x: any) => x?.name === shiftName);
      if (!stationShift?.enabled || !isDayActive(st, dayKey)) continue;
      const cur = cellCount(dayIdx, sIdx);
      if (cur !== 0) continue;
      const prev =
        dayIdx === 0 && sIdx === 0
          ? null
          : sIdx === 0
            ? { dayIdx: dayIdx - 1, sIdx: shiftsCount - 1 }
            : { dayIdx, sIdx: sIdx - 1 };
      const next =
        dayIdx === 6 && sIdx === shiftsCount - 1
          ? null
          : sIdx === shiftsCount - 1
            ? { dayIdx: dayIdx + 1, sIdx: 0 }
            : { dayIdx, sIdx: sIdx + 1 };
      if (!prev || !next) continue;
      const prevCount = cellCount(prev.dayIdx, prev.sIdx);
      const nextCount = cellCount(next.dayIdx, next.sIdx);
      if (prevCount > 0 && nextCount > 0) return true;
    }
  }
  return false;
}

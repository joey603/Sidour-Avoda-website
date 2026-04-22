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

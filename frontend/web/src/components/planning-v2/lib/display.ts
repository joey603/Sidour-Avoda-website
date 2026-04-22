export const DAY_DEFS = [
  { key: "sun", label: "א'" },
  { key: "mon", label: "ב'" },
  { key: "tue", label: "ג'" },
  { key: "wed", label: "ד'" },
  { key: "thu", label: "ה'" },
  { key: "fri", label: "ו'" },
  { key: "sat", label: "ש'" },
] as const;

export function isRtlName(s: string): boolean {
  return /[\u0590-\u05FF]/.test(String(s || ""));
}

export function displayShiftOrderIndex(sn: string): number {
  const s = String(sn || "");
  if (/בוקר|^0?6|06-14/i.test(s)) return 0;
  if (/צהר(יים|י)ם?|14-22|^1?4/i.test(s)) return 1;
  if (/לילה|22-06|^2?2|night/i.test(s)) return 2;
  return 3;
}

/** Rôles activés dans la config site (stations / shifts / dayOverrides). */
export function buildEnabledRoleNameSet(site: { config?: Record<string, unknown> } | null): Set<string> {
  const set = new Set<string>();
  const pushIfEnabled = (name?: string, enabled?: boolean) => {
    const nm = String(name || "").trim();
    if (!nm || !enabled) return;
    set.add(nm);
  };
  const stations = (site?.config as { stations?: unknown[] } | undefined)?.stations;
  if (!Array.isArray(stations)) return set;
  for (const st of stations as any[]) {
    for (const r of st?.roles || []) pushIfEnabled(r?.name, r?.enabled);
    for (const sh of st?.shifts || []) {
      for (const r of sh?.roles || []) pushIfEnabled(r?.name, r?.enabled);
    }
    for (const dayCfg of Object.values(st?.dayOverrides || {})) {
      const cfg = dayCfg as { shifts?: unknown[] };
      for (const sh of cfg?.shifts || []) {
        for (const r of (sh as any)?.roles || []) pushIfEnabled(r?.name, r?.enabled);
      }
    }
  }
  return set;
}

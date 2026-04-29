const GOLDEN = 137.508;

/** Même algo que `colorForName` (planning.tsx) hors carte d’identité par groupe — hash par chaîne. */
function planningColorForWorkerNameLikeLegacy(name: string): { bg: string; border: string; text: string } {
  const s = name || "";
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i));
    hash |= 0;
  }
  /** Même jeu que `colorForName` planning legacy — oranges + bleus/violets pour bien séparer les noms au hash de secours. */
  const allowedHues = [20, 30, 40, 50, 200, 210, 220, 230, 260, 270, 280, 290, 300, 310];
  const idx = Math.abs(hash) % allowedHues.length;
  const hue = allowedHues[idx];
  const lightVariants = [88, 84, 80] as const;
  const satVariants = [85, 80, 75] as const;
  const vIdx = Math.abs(hash >> 3) % lightVariants.length;
  const L = lightVariants[vIdx];
  const Sbg = satVariants[vIdx];
  const Sborder = 60;
  const bg = `hsl(${hue} ${Sbg}% ${L}%)`;
  const border = `hsl(${hue} ${Sborder}% ${Math.max(65, L - 10)}%)`;
  const text = "#1f2937";
  return { bg, border, text };
}

type StationCfg = {
  roles?: Array<{ name?: string }>;
  shifts?: Array<{ roles?: Array<{ name?: string }> }>;
  dayOverrides?: Record<string, { shifts?: Array<{ roles?: Array<{ name?: string }> }> }>;
};

/**
 * Comme `roleColorMap` dans la page planning classique (`planning-legacy-page.tsx` / `page.tsx`) :
 * uniquement `stations[].roles`, `stations[].shifts[].roles` et les rôles des employés —
 * pas les rôles dérivés de `dayOverrides`, sinon l’ensemble trié change et les teintes GOLDEN ne
 * correspondent plus au planning v1.
 */
export function buildPlanningRoleColorMapFromSite(
  site: { config?: { stations?: StationCfg[] } } | null | undefined,
  workers: Array<{ roles?: string[] }>,
): Map<string, { border: string; text: string }> {
  const set = new Set<string>();
  for (const st of site?.config?.stations || []) {
    for (const r of st?.roles || []) {
      const nm = String(r?.name || "").trim();
      if (nm) set.add(nm);
    }
    for (const sh of st?.shifts || []) {
      for (const r of sh?.roles || []) {
        const nm = String(r?.name || "").trim();
        if (nm) set.add(nm);
      }
    }
  }
  for (const w of workers || []) {
    for (const nm of w.roles || []) {
      const v = String(nm || "").trim();
      if (v) set.add(v);
    }
  }
  const roles = Array.from(set).sort((a, b) => a.localeCompare(b));
  const map = new Map<string, { border: string; text: string }>();
  roles.forEach((nm, i) => {
    let h = (i * GOLDEN) % 360;
    if (h >= 100 && h <= 150) h = (h + 40) % 360;
    const border = `hsl(${h} 70% 40%)`;
    const text = `hsl(${h} 60% 30%)`;
    map.set(nm, { border, text });
  });
  return map;
}

/** Comme `colorForRole(roleName)` dans planning.tsx. */
export function planningColorForRoleChip(
  roleName: string,
  roleMap: Map<string, { border: string; text: string }>,
): { border: string; text: string } {
  return roleMap.get(roleName) || { border: "#64748b", text: "#334155" };
}

/** Une entrée par nom — même tintes que les bulles נשמר sur la page planning (hash par chaîne). */
export function buildWorkerNameColorMap(namesInput: string[]): Map<string, { bg: string; border: string; text: string }> {
  const names = Array.from(
    new Set(
      (namesInput || [])
        .map((n) => String(n || "").trim())
        .filter(Boolean),
    ),
  );
  const map = new Map<string, { bg: string; border: string; text: string }>();
  names.forEach((name) => {
    map.set(name, planningColorForWorkerNameLikeLegacy(name));
  });
  return map;
}

/** Palette par nom ; `presetMap` depuis `buildWorkerNameColorMap`. */
export function workerNameChipColor(
  name: string,
  presetMap?: Map<string, { bg: string; border: string; text: string }>,
): { bg: string; border: string; text: string } {
  const preset = presetMap?.get(String(name || "").trim());
  if (preset) return preset;
  return planningColorForWorkerNameLikeLegacy(name);
}

/** Compatibilité : alias explicite. */
export function planningChipColorForWorkerName(name: string): { bg: string; border: string; text: string } {
  return planningColorForWorkerNameLikeLegacy(name);
}

/** Données employé minimales — comme `colorIdentityForWorker` sur la page planning. */
export type WorkerIdentityForColors = {
  name?: string;
  phone?: string | null;
  linkedSiteIds?: number[];
};

export function colorIdentityForWorker(worker: WorkerIdentityForColors): string {
  const phone = String(worker.phone || "").trim();
  if (phone) return `phone:${phone}`;
  const linkedIds = Array.isArray(worker.linkedSiteIds)
    ? worker.linkedSiteIds.map((id) => Number(id)).filter(Number.isFinite).sort((a, b) => a - b)
    : [];
  if (linkedIds.length > 1) return `linked:${linkedIds.join(",")}:${String(worker.name || "").trim()}`;
  return `name:${String(worker.name || "").trim()}`;
}

function collectAssignedNamesFromPlanningShape(
  assignments: Record<string, Record<string, string[][]>> | null | undefined,
): string[] {
  const out: string[] = [];
  if (!assignments || typeof assignments !== "object") return out;
  for (const day of Object.keys(assignments)) {
    const shiftsMap = assignments[day] || {};
    for (const sh of Object.keys(shiftsMap)) {
      const perStation = shiftsMap[sh] || [];
      for (const arr of perStation) {
        for (const nm of arr || []) {
          const v = String(nm || "").trim();
          if (v) out.push(v);
        }
      }
    }
  }
  return out;
}

/**
 * Comme `nameToColor` du planning legacy : une teinte stable par identité (téléphone / sites liés / nom),
 * répartition GOLDEN + contraste L/S ; inclut tous les שיבוצים et les חלופות pour des couleurs stables au changement d’alternative.
 */
export function buildDistinctWorkerColorMap(
  workers: WorkerIdentityForColors[],
  assignmentBundles: Array<Record<string, Record<string, string[][]>> | null | undefined>,
): Map<string, { bg: string; border: string; text: string }> {
  const namesSet = new Set<string>();
  for (const w of workers || []) {
    const nm = String(w?.name || "").trim();
    if (nm) namesSet.add(nm);
  }
  for (const bundle of assignmentBundles || []) {
    for (const n of collectAssignedNamesFromPlanningShape(bundle ?? undefined)) {
      namesSet.add(n);
    }
  }

  const names = Array.from(namesSet).sort((a, b) => a.localeCompare(b));

  const workerColorIdentityByName = new Map<string, string>();
  for (const worker of workers || []) {
    const name = String(worker?.name || "").trim();
    if (!name) continue;
    workerColorIdentityByName.set(name, colorIdentityForWorker(worker));
  }

  const identities = Array.from(
    new Set(names.map((name) => workerColorIdentityByName.get(name) || `name:${name}`)),
  ).sort((a, b) => a.localeCompare(b));

  function shiftForbidden(h: number) {
    let x = h;
    if (x < 20 || x >= 350) x = (x + 30) % 360;
    if (x >= 100 && x <= 150) x = (x + 40) % 360;
    return x;
  }

  const identityToColor = new Map<string, { bg: string; border: string; text: string }>();
  identities.forEach((identity, i) => {
    let h = (i * GOLDEN) % 360;
    h = shiftForbidden(h);
    const L = [88, 84, 80][i % 3];
    const Sbg = [85, 80, 75][(i >> 1) % 3];
    const bg = `hsl(${h} ${Sbg}% ${L}%)`;
    const border = `hsl(${h} 60% ${Math.max(65, L - 10)}%)`;
    const text = `#1f2937`;
    identityToColor.set(identity, { bg, border, text });
  });

  const map = new Map<string, { bg: string; border: string; text: string }>();
  names.forEach((name) => {
    const identity = workerColorIdentityByName.get(name) || `name:${name}`;
    const color = identityToColor.get(identity);
    if (color) map.set(name, color);
  });
  return map;
}

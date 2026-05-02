/**
 * Alignement affichage / indices de rôle sur la page planning classique
 * (`roleRequirements`, `roleHints`, `roleHintsExtended`, `roleForName`, `pullRoleMap`).
 */
import type { PlanningWorker } from "../types";
import { roleRequirementsForStation, workerHasRole } from "./planning-v2-manual-full-drop";

export function buildPullRoleMapForCell(
  pulls: Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!pulls) return out;
  const prefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  for (const [k, v] of Object.entries(pulls)) {
    if (!String(k).startsWith(prefix)) continue;
    const e = v as { roleName?: string; before?: { name?: string }; after?: { name?: string } };
    const rn = String(e?.roleName || "").trim();
    if (!rn) continue;
    const b = String(e?.before?.name || "").trim();
    const a = String(e?.after?.name || "").trim();
    if (b) out.set(b, rn);
    if (a) out.set(a, rn);
  }
  return out;
}

export function resolvePullRoleNameForWorker(
  pulls: Record<string, unknown> | null | undefined,
  dayKey: string,
  shiftName: string,
  stationIdx: number,
  workerName: string,
): string | null {
  if (!pulls) return null;
  const prefix = `${dayKey}|${shiftName}|${stationIdx}|`;
  const target = String(workerName || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  for (const [k, v] of Object.entries(pulls)) {
    if (!String(k).startsWith(prefix)) continue;
    const e = v as { roleName?: string; before?: { name?: string }; after?: { name?: string } };
    const b = String(e?.before?.name || "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
    const a = String(e?.after?.name || "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
    if (b === target || a === target) {
      const rn = String(e?.roleName || "").trim();
      return rn || null;
    }
  }
  return null;
}

/**
 * Comme le bloc manuel du planning (`roleHints`, `roleHintsExtended`, attribution aux noms).
 */
export function computeRoleDisplayForCell(
  workers: PlanningWorker[],
  st: any,
  shiftName: string,
  dayKey: string,
  assignedNamesBySlot: string[],
  pullRoleMap: Map<string, string>,
): {
  roleHints: string[];
  roleHintsExtended: (string | null)[];
  roleForSlot: (string | null)[];
  roleForName: Map<string, string | null>;
} {
  const reqRoles = roleRequirementsForStation(st, shiftName, dayKey);
  const roleHints: string[] = [];
  Object.entries(reqRoles || {}).forEach(([rName, rCount]) => {
    const n = Number(rCount || 0);
    for (let i = 0; i < n; i++) roleHints.push(String(rName));
  });

  const roleForName = new Map<string, string | null>();
  const roleForSlot: (string | null)[] = assignedNamesBySlot.map(() => null);
  const remaining = new Map<string, number>(
    Object.entries(reqRoles || {}).map(([rName, rCount]) => [String(rName), Number(rCount || 0)]),
  );

  assignedNamesBySlot.forEach((nm, idx) => {
    const nameTrimmed = String(nm || "").trim();
    if (!nameTrimmed) return;
    const pr = pullRoleMap.get(nameTrimmed) || null;
    if (pr && workerHasRole(workers, nameTrimmed, pr)) {
      roleForSlot[idx] = pr;
      if (!roleForName.has(nameTrimmed)) roleForName.set(nameTrimmed, pr);
      if (remaining.has(pr) && (remaining.get(pr) || 0) > 0) {
        remaining.set(pr, (remaining.get(pr) || 0) - 1);
      }
    }
  });

  // Priorité au rôle attendu du slot (indice), utile quand un עובד porte plusieurs rôles.
  assignedNamesBySlot.forEach((nm, idx) => {
    const nameTrimmed = String(nm || "").trim();
    if (!nameTrimmed) return;
    if (roleForSlot[idx]) return;
    const expectedRole = String(roleHints[idx] || "").trim();
    if (!expectedRole) return;
    if (!workerHasRole(workers, nameTrimmed, expectedRole)) return;
    roleForSlot[idx] = expectedRole;
    if (!roleForName.has(nameTrimmed)) roleForName.set(nameTrimmed, expectedRole);
    if (remaining.has(expectedRole) && (remaining.get(expectedRole) || 0) > 0) {
      remaining.set(expectedRole, (remaining.get(expectedRole) || 0) - 1);
    }
  });

  assignedNamesBySlot.forEach((nm, idx) => {
    const nameTrimmed = String(nm || "").trim();
    if (!nameTrimmed) return;
    if (roleForSlot[idx]) return;
    for (const [rName, cnt] of Array.from(remaining.entries())) {
      if ((cnt || 0) <= 0) continue;
      if (!workerHasRole(workers, nameTrimmed, rName)) continue;
      roleForSlot[idx] = rName;
      if (!roleForName.has(nameTrimmed)) roleForName.set(nameTrimmed, rName);
      remaining.set(rName, (cnt || 0) - 1);
      break;
    }
  });

  const roleHintsExtended: (string | null)[] = [
    ...roleHints,
    ...Array.from(remaining.entries()).flatMap(([rName, cnt]) =>
      Array.from({ length: Math.max(0, Number(cnt || 0)) }, () => String(rName)),
    ),
  ];

  return { roleHints, roleHintsExtended, roleForSlot, roleForName };
}

/**
 * Réordonne l'affichage des noms selon les sous-slots de rôles attendus.
 * Utile en mode auto quand l'ordre brut des noms n'est pas aligné avec l'ordre des rôles.
 */
export function alignNamesToRoleSlots(
  workers: PlanningWorker[],
  assignedNamesBySlot: string[],
  roleHints: string[],
  roleForSlot: (string | null)[] = [],
): string[] {
  /** Même nombre de sous-slots que la config (ex. חמוש + אחמש) même si l’API n’a qu’un seul nom dans le tableau. */
  const targetLen = Math.max(assignedNamesBySlot.length, roleHints.length);
  if (targetLen === 0) return [];
  const slots = Array.from({ length: targetLen }, (_, i) => String(assignedNamesBySlot[i] ?? ""));
  const entries = slots
    .map((nm, idx) => ({
      originalIndex: idx,
      name: String(nm || "").trim(),
      resolvedRole: String(roleForSlot[idx] || "").trim() || null,
    }))
    .filter((entry) => !!entry.name);
  if (entries.length === 0) return slots;

  const roleOrder = Array.from(
    new Set(
      roleHints
        .map((roleName) => String(roleName || "").trim())
        .filter(Boolean),
    ),
  );
  const roleRank = new Map<string, number>(roleOrder.map((roleName, idx) => [roleName, idx]));
  const inferRole = (entry: (typeof entries)[number]): string | null => {
    if (entry.resolvedRole) return entry.resolvedRole;
    for (const roleName of roleOrder) {
      if (workerHasRole(workers, entry.name, roleName)) return roleName;
    }
    return null;
  };

  const sorted = [...entries].sort((a, b) => {
    const roleA = inferRole(a);
    const roleB = inferRole(b);
    const rankA = roleA && roleRank.has(roleA) ? (roleRank.get(roleA) as number) : Number.MAX_SAFE_INTEGER;
    const rankB = roleB && roleRank.has(roleB) ? (roleRank.get(roleB) as number) : Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return a.originalIndex - b.originalIndex;
  });

  const out = Array.from({ length: targetLen }, () => "");
  for (let idx = 0; idx < sorted.length; idx++) {
    out[idx] = sorted[idx].name;
  }
  return out;
}

const GOLDEN = 137.508;

function shiftForbiddenHue(hue: number): number {
  let h = hue;
  // Eviter rouge et vert pour ne pas confondre avec états OK/KO
  if (h < 20 || h >= 350) h = (h + 30) % 360;
  if (h >= 100 && h <= 150) h = (h + 40) % 360;
  return h;
}

/** Mapping stable nom -> couleur, aligné sur la logique planning historique. */
export function buildWorkerNameColorMap(namesInput: string[]): Map<string, { bg: string; border: string; text: string }> {
  const names = Array.from(
    new Set(
      (namesInput || [])
        .map((n) => String(n || "").trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));

  const map = new Map<string, { bg: string; border: string; text: string }>();
  names.forEach((name, i) => {
    const hue = shiftForbiddenHue((i * GOLDEN) % 360);
    const L = [88, 84, 80][i % 3];
    const Sbg = [85, 80, 75][(i >> 1) % 3];
    const bg = `hsl(${hue} ${Sbg}% ${L}%)`;
    const border = `hsl(${hue} 60% ${Math.max(65, L - 10)}%)`;
    const text = "#1f2937";
    map.set(name, { bg, border, text });
  });
  return map;
}

/** Palette stable par nom — fallback hash identique au planning. */
export function workerNameChipColor(
  name: string,
  presetMap?: Map<string, { bg: string; border: string; text: string }>,
): { bg: string; border: string; text: string } {
  const preset = presetMap?.get(String(name || "").trim());
  if (preset) return preset;
  const s = name || "";
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash |= 0;
  }
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
  const text = `#1f2937`;
  return { bg, border, text };
}

/** Palette stable par nom — même logique que `colorForName` dans `planning/[id]/page.tsx` (fallback hash). */
export function workerNameChipColor(name: string): { bg: string; border: string; text: string } {
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

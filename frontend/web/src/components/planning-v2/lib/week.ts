/** Clé semaine alignée sur `planning/[id]` (date locale du dimanche de la semaine affichée). */
export function getWeekKeyISO(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function parseWeekQueryParam(raw: string | null): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

/** Semaine « affichage travailleur » : dimanche suivant (identique au planning). */
export function defaultPlanningWeekStart(): Date {
  const today = new Date();
  const currentDay = today.getDay();
  const daysUntilNextSunday = currentDay === 0 ? 7 : 7 - currentDay;
  const nextSunday = new Date(today);
  nextSunday.setDate(today.getDate() + daysUntilNextSunday);
  nextSunday.setHours(0, 0, 0, 0);
  return nextSunday;
}

export function calculateNextWeekSunday(): Date {
  return defaultPlanningWeekStart();
}

export function isNextWeekDisplayed(weekStart: Date): boolean {
  const next = calculateNextWeekSunday();
  const w = new Date(weekStart);
  w.setHours(0, 0, 0, 0);
  return w.getTime() === next.getTime();
}

export function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

export function formatHebDate(d: Date): string {
  return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export const HEBREW_MONTH_NAMES = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר",
] as const;

/** Dimanche (début de semaine planning) ≤ date. */
export function sundayOnOrBefore(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

/** Tous les dimanches de semaines qui intersectent le mois civil (0–11). */
export function weekStartsIntersectingMonth(year: number, monthIndex: number): Date[] {
  const first = new Date(year, monthIndex, 1);
  first.setHours(0, 0, 0, 0);
  const last = new Date(year, monthIndex + 1, 0);
  last.setHours(0, 0, 0, 0);
  let cur = sundayOnOrBefore(first);
  const out: Date[] = [];
  while (cur.getTime() <= last.getTime()) {
    const weekEnd = addDays(cur, 6);
    if (weekEnd.getTime() >= first.getTime() && cur.getTime() <= last.getTime()) {
      out.push(new Date(cur));
    }
    cur = addDays(cur, 7);
  }
  return out;
}

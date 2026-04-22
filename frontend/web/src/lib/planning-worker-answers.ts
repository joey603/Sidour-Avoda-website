/** Clé semaine (dimanche local), alignée sur planning-v2 / planning director. */
export function getWeekKeyISOForPlanning(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Extrait les réponses questionnaire pour la semaine `weekStart` (structure par semaine ou legacy).
 */
export function getAnswersForWeek(
  rawAnswers: unknown,
  weekStart: Date,
): { general: Record<string, unknown>; perDay: Record<string, unknown> } | null {
  if (!rawAnswers || typeof rawAnswers !== "object") return null;

  const weekKey = getWeekKeyISOForPlanning(weekStart);

  if (weekKey in (rawAnswers as Record<string, unknown>)) {
    const weekAnswers = (rawAnswers as Record<string, unknown>)[weekKey];
    if (weekAnswers && typeof weekAnswers === "object") {
      const w = weekAnswers as Record<string, unknown>;
      const general =
        w.general && typeof w.general === "object" ? (w.general as Record<string, unknown>) : {};
      const perDay =
        w.perDay && typeof w.perDay === "object" ? (w.perDay as Record<string, unknown>) : {};
      return { general, perDay };
    }
  }

  try {
    const ra = rawAnswers as Record<string, unknown>;
    const wk = String(ra?.week_key || ra?.week_iso || "").trim();
    if (wk && wk === weekKey && ("general" in ra || "perDay" in ra)) {
      const general =
        ra.general && typeof ra.general === "object" ? (ra.general as Record<string, unknown>) : {};
      const perDay =
        ra.perDay && typeof ra.perDay === "object" ? (ra.perDay as Record<string, unknown>) : {};
      return { general, perDay };
    }
  } catch {
    /* ignore */
  }

  if ("general" in (rawAnswers as object) || "perDay" in (rawAnswers as object)) {
    const today = new Date();
    const currentDay = today.getDay();
    const daysUntilNextSunday = currentDay === 0 ? 7 : 7 - currentDay;
    const nextSunday = new Date(today);
    nextSunday.setDate(today.getDate() + daysUntilNextSunday);
    nextSunday.setHours(0, 0, 0, 0);

    if (getWeekKeyISOForPlanning(weekStart) === getWeekKeyISOForPlanning(nextSunday)) {
      const ra = rawAnswers as Record<string, unknown>;
      const general =
        ra.general && typeof ra.general === "object" ? (ra.general as Record<string, unknown>) : (ra as Record<string, unknown>);
      const perDay =
        ra.perDay && typeof ra.perDay === "object" ? (ra.perDay as Record<string, unknown>) : {};
      return { general, perDay };
    }
  }

  return null;
}

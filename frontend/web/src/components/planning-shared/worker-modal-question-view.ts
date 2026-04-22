import { DAY_DEFS } from "@/components/planning-v2/lib/display";
import { getAnswersForWeek } from "@/lib/planning-worker-answers";

export type WorkerModalQuestionView = {
  hasWeekAnswers: boolean;
  generalItems: Array<{ id: string; label: string; value: string }>;
  perDayItems: Array<{
    id: string;
    label: string;
    items: Array<{ dayKey: string; dayLabel: string; value: string }>;
  }>;
};

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function formatHebDate(d: Date): string {
  return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function buildWorkerModalQuestionView(
  editingWorkerId: number | null,
  rawAnswers: unknown,
  weekStart: Date,
  questions: unknown[],
  dayDefs: typeof DAY_DEFS,
): WorkerModalQuestionView {
  if (!editingWorkerId) return { hasWeekAnswers: false, generalItems: [], perDayItems: [] };
  const weekAnswers = getAnswersForWeek(rawAnswers, weekStart);
  if (!weekAnswers) return { hasWeekAnswers: false, generalItems: [], perDayItems: [] };

  const qs: any[] = Array.isArray(questions) ? (questions as any[]) : [];
  const orderedQuestions = qs.filter(
    (question) => question && question.id && String(question.label || question.question || question.text || "").trim(),
  );
  const generalItems = orderedQuestions
    .filter((question) => !question.perDay)
    .map((question) => {
      const questionId = String(question.id);
      const value = ((weekAnswers.general || {}) as Record<string, unknown>)[questionId];
      if (value === undefined || value === null || String(value).trim() === "") return null;
      return {
        id: questionId,
        label: String(question.label || question.question || question.text || questionId),
        value: typeof value === "boolean" ? (value ? "כן" : "לא") : String(value),
      };
    })
    .filter(Boolean) as Array<{ id: string; label: string; value: string }>;

  const dayKeyToDate = new Map<string, string>();
  dayDefs.forEach((dayDef, index) => {
    const dt = addDays(weekStart, index);
    dayKeyToDate.set(dayDef.key, `${dayDef.label} (${formatHebDate(dt)})`);
  });

  const perDayItems = orderedQuestions
    .filter((question) => !!question.perDay)
    .map((question) => {
      const questionId = String(question.id);
      const perObj = ((((weekAnswers.perDay || {}) as Record<string, unknown>)[questionId] || {}) as Record<string, unknown>) || {};
      const items = dayDefs
        .map((dayDef) => {
          const value = perObj?.[dayDef.key];
          if (value === undefined || value === null || String(value).trim() === "") return null;
          return {
            dayKey: dayDef.key,
            dayLabel: dayKeyToDate.get(dayDef.key) || dayDef.key,
            value: typeof value === "boolean" ? (value ? "כן" : "לא") : String(value),
          };
        })
        .filter(Boolean) as Array<{ dayKey: string; dayLabel: string; value: string }>;
      if (!items.length) return null;
      return {
        id: questionId,
        label: String(question.label || question.question || question.text || questionId),
        items,
      };
    })
    .filter(Boolean) as Array<{
      id: string;
      label: string;
      items: Array<{ dayKey: string; dayLabel: string; value: string }>;
    }>;

  return {
    hasWeekAnswers: true,
    generalItems,
    perDayItems,
  };
}

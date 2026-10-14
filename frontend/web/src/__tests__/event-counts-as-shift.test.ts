import { countEventAssignmentsPerWorkerName } from "@/components/planning-v2/lib/event-availability-locks";
import { buildEventExportOccurrences } from "@/components/planning-v2/lib/event-export-tables";
import type { PlanningWorker, SiteEvent } from "@/components/planning-v2/types";

/** Dimanche local — évite les décalages UTC de `Date.parse`. */
const weekStart = new Date(2026, 9, 11);
const workers: PlanningWorker[] = [
  { id: 1, name: "דני", roles: ["מאבטח"] } as PlanningWorker,
  { id: 2, name: "יוסי", roles: ["מאבטח"] } as PlanningWorker,
];

function makeEvent(partial: Partial<SiteEvent> & Pick<SiteEvent, "id" | "title" | "dates" | "assignments">): SiteEvent {
  return {
    site_id: 1,
    created_at: 0,
    updated_at: 0,
    counts_as_shift: true,
    ...partial,
  };
}

describe("counts_as_shift sur אירועים", () => {
  it("compte les affectations quand counts_as_shift est true / absent", () => {
    const events = [
      makeEvent({
        id: 1,
        title: "אירוע רגיל",
        dates: ["2026-10-12", "2026-10-13"],
        assignments: { "2026-10-12": [1], "2026-10-13": [1, 2] },
      }),
      makeEvent({
        id: 2,
        title: "אירוע ללא דגל",
        dates: ["2026-10-14"],
        assignments: { "2026-10-14": [2] },
        counts_as_shift: undefined,
      }),
    ];
    const counts = countEventAssignmentsPerWorkerName(events, weekStart, workers);
    expect(counts.get("דני")).toBe(2);
    expect(counts.get("יוסי")).toBe(2);
  });

  it("ignore les événements avec counts_as_shift=false dans le סיכום", () => {
    const events = [
      makeEvent({
        id: 1,
        title: "נספר",
        dates: ["2026-10-12"],
        assignments: { "2026-10-12": [1] },
        counts_as_shift: true,
      }),
      makeEvent({
        id: 2,
        title: "לא נספר",
        dates: ["2026-10-13"],
        assignments: { "2026-10-13": [1] },
        counts_as_shift: false,
      }),
    ];
    const counts = countEventAssignmentsPerWorkerName(events, weekStart, workers);
    expect(counts.get("דני")).toBe(1);
  });

  it("affiche toujours les sous-tableaux dans צילום même si counts_as_shift=false", () => {
    const events = [
      makeEvent({
        id: 1,
        title: "נספר",
        dates: ["2026-10-12"],
        assignments: { "2026-10-12": [1] },
        counts_as_shift: true,
      }),
      makeEvent({
        id: 2,
        title: "לא נספר אבל מוצג",
        dates: ["2026-10-13"],
        assignments: { "2026-10-13": [2] },
        counts_as_shift: false,
      }),
    ];
    const occs = buildEventExportOccurrences({ events, weekStart, workers });
    expect(occs).toHaveLength(2);
    expect(occs.map((o) => o.title)).toEqual(["נספר", "לא נספר אבל מוצג"]);
    expect(occs[1].workerNames).toEqual(["יוסי"]);
  });
});

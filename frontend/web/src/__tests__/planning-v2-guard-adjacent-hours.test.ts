import {
  guardAdjacentBoundaryHours,
  resolveSlotExportHours,
  slotTimeMetaFromPulls,
} from "@/components/planning-v2/lib/planning-v2-pull-slot-display";

const shifts = ["בוקר", "צהריים", "לילה"];

describe("guardAdjacentBoundaryHours", () => {
  it("ajuste fin de la garde d'avant et début de la garde d'après (1 pers/garde)", () => {
    const assignments = {
      sun: {
        בוקר: [["Alice"]],
        צהריים: [["Bob"]],
        לילה: [["Carol"]],
      },
    };
    const pulls = {
      "sun|צהריים|0|0": { guardDisplay: { start: "16:00", end: "21:00" } },
    };

    // Matin : fin → 16:00 (début de midi)
    expect(
      guardAdjacentBoundaryHours(pulls, assignments, shifts, 0, "sun", "בוקר", 0, "07:00", "15:00"),
    ).toEqual({ from: "07:00", to: "16:00" });

    // Nuit : début → 21:00 (fin de midi)
    expect(
      guardAdjacentBoundaryHours(pulls, assignments, shifts, 0, "sun", "לילה", 0, "23:00", "07:00"),
    ).toEqual({ from: "21:00", to: "07:00" });

    // Midi lui-même : null (a déjà son guardDisplay)
    expect(
      guardAdjacentBoundaryHours(pulls, assignments, shifts, 0, "sun", "צהריים", 0, "15:00", "23:00"),
    ).toBeNull();
  });

  it("n'ajuste pas si une garde voisine a plus d'une personne", () => {
    const assignments = {
      sun: {
        בוקר: [["Alice", "Dave"]],
        צהריים: [["Bob"]],
        לילה: [["Carol"]],
      },
    };
    const pulls = {
      "sun|צהריים|0|0": { guardDisplay: { start: "16:00", end: "21:00" } },
    };

    expect(
      guardAdjacentBoundaryHours(pulls, assignments, shifts, 0, "sun", "בוקר", 0, "07:00", "15:00"),
    ).toBeNull();

    expect(
      guardAdjacentBoundaryHours(pulls, assignments, shifts, 0, "sun", "לילה", 0, "23:00", "07:00"),
    ).toEqual({ from: "21:00", to: "07:00" });
  });

  it("n'ajuste pas la cellule courante si elle a plusieurs personnes", () => {
    const assignments = {
      sun: {
        בוקר: [["Alice"]],
        צהריים: [["Bob", "Eve"]],
        לילה: [["Carol"]],
      },
    };
    const pulls = {
      "sun|בוקר|0|0": { guardDisplay: { start: "07:00", end: "16:00" } },
    };

    expect(
      guardAdjacentBoundaryHours(pulls, assignments, shifts, 0, "sun", "צהריים", 0, "15:00", "23:00"),
    ).toBeNull();
  });

  it("après-midi vide : nuit 18–06 → après-midi affiché 14–18", () => {
    // Lundi : matin 06–14, après-midi vide, nuit changée en 18–06
    const assignments = {
      mon: {
        בוקר: [["Alice"]],
        צהריים: [[]],
        לילה: [["Carol"]],
      },
    };
    const pulls = {
      "mon|לילה|0|0": { guardDisplay: { start: "18:00", end: "06:00" } },
    };

    expect(
      guardAdjacentBoundaryHours(pulls, assignments, shifts, 1, "mon", "צהריים", 0, "14:00", "22:00"),
    ).toEqual({ from: "14:00", to: "18:00" });

    // Le matin reste inchangé (voisin suivant = après-midi sans שינוי שעות)
    expect(
      guardAdjacentBoundaryHours(pulls, assignments, shifts, 1, "mon", "בוקר", 0, "06:00", "14:00"),
    ).toBeNull();
  });

  it("enchaîne nuit → matin du jour suivant", () => {
    const assignments = {
      sun: {
        בוקר: [["A"]],
        צהריים: [["B"]],
        לילה: [["C"]],
      },
      mon: {
        בוקר: [["D"]],
        צהריים: [["E"]],
        לילה: [["F"]],
      },
    };
    const pulls = {
      "sun|לילה|0|0": { guardDisplay: { start: "22:00", end: "08:00" } },
    };

    expect(
      guardAdjacentBoundaryHours(pulls, assignments, shifts, 1, "mon", "בוקר", 0, "07:00", "15:00"),
    ).toEqual({ from: "08:00", to: "15:00" });
  });
});

describe("slotTimeMetaFromPulls + resolveSlotExportHours (adjacent)", () => {
  it("expose les horaires ajustés en jaune pour la garde voisine", () => {
    const assignments = {
      sun: {
        בוקר: [["Alice"]],
        צהריים: [["Bob"]],
        לילה: [["Carol"]],
      },
    };
    const pulls = {
      "sun|צהריים|0|0": { guardDisplay: { start: "16:00", end: "21:00" } },
    };

    const meta = slotTimeMetaFromPulls(pulls, "sun", "בוקר", 0, 0, "Alice", {
      assignments,
      shiftNamesAll: shifts,
      dayIdx: 0,
      homeFrom: "07:00",
      homeTo: "15:00",
    });
    expect(meta).toEqual({ label: "07:00–16:00", red: true, highlight: "guard" });

    const resolved = resolveSlotExportHours(
      pulls,
      assignments,
      shifts,
      0,
      "sun",
      "בוקר",
      0,
      0,
      "Alice",
      "07:00",
      "15:00",
    );
    expect(resolved).toEqual({ highlight: true, from: "07:00", to: "16:00" });
  });

  it("priorité au guardDisplay propre sur l'ajustement adjacent", () => {
    const assignments = {
      sun: {
        בוקר: [["Alice"]],
        צהריים: [["Bob"]],
      },
    };
    const pulls = {
      "sun|בוקר|0|0": { guardDisplay: { start: "06:30", end: "14:30" } },
      "sun|צהריים|0|0": { guardDisplay: { start: "16:00", end: "21:00" } },
    };

    const meta = slotTimeMetaFromPulls(pulls, "sun", "בוקר", 0, 0, "Alice", {
      assignments,
      shiftNamesAll: shifts,
      dayIdx: 0,
      homeFrom: "07:00",
      homeTo: "15:00",
    });
    expect(meta).toEqual({ label: "06:30–14:30", red: true, highlight: "guard" });
  });
});

import {
  appendManualSlot,
  buildExportCellSlots,
  isManualExtraSlot,
  isManualSlotPullEntry,
  listRolesForStationShift,
  manualSlotKey,
  manualSlotRoleName,
  manualSlotSpanInCell,
  parseManualSlotKey,
  removeManualSlot,
  updateManualSlot,
} from "@/components/planning-v2/lib/planning-v2-manual-slot";
import { slotTimeMetaFromPulls } from "@/components/planning-v2/lib/planning-v2-pull-slot-display";

const target = { dayKey: "sun", shiftName: "בוקר", stationIndex: 0 };

function baseAssignments() {
  return { sun: { בוקר: [["Alice"]] } };
}

describe("manualSlotKey / parseManualSlotKey", () => {
  it("fait un aller-retour sur la clé de slot", () => {
    const key = manualSlotKey("sun", "בוקר", 2, 3);
    expect(key).toBe("sun|בוקר|2|3");
    expect(parseManualSlotKey(key)).toEqual({
      dayKey: "sun",
      shiftName: "בוקר",
      stationIndex: 2,
      slotIndex: 3,
    });
  });

  it("rejette les clés incomplètes", () => {
    expect(parseManualSlotKey("sun|בוקר")).toBeNull();
    expect(parseManualSlotKey("sun|בוקר|x|0")).toBeNull();
  });
});

describe("appendManualSlot", () => {
  it("ajoute un poste vacant avec horaires, sans toucher les affectations existantes", () => {
    const res = appendManualSlot(baseAssignments(), {}, {
      ...target,
      start: "07:00",
      end: "15:00",
    });

    expect(res.slotIndex).toBe(1);
    expect(res.assignments.sun["בוקר"][0]).toEqual(["Alice", ""]);
    expect(res.pulls["sun|בוקר|0|1"]).toEqual({
      manualSlot: {},
      guardDisplay: { start: "07:00", end: "15:00" },
    });
    expect(isManualSlotPullEntry(res.pulls["sun|בוקר|0|1"])).toBe(true);
  });

  it("ajoute un poste avec עובד et rôle", () => {
    const res = appendManualSlot(baseAssignments(), {}, {
      ...target,
      workerName: "Bob",
      roleName: "אחמש",
      start: "08:00",
      end: "16:00",
    });

    expect(res.assignments.sun["בוקר"][0]).toEqual(["Alice", "Bob"]);
    expect(manualSlotRoleName(res.pulls[res.key])).toBe("אחמש");
  });

  it("crée la cellule si le jour / la garde / l’עמדה n’existent pas encore", () => {
    const res = appendManualSlot({}, {}, { ...target, stationIndex: 2, workerName: "Bob" });
    expect(res.assignments.sun["בוקר"][2]).toEqual(["Bob"]);
    expect(res.slotIndex).toBe(0);
  });

  it("préserve les cellules normales vacantes en ajoutant le שיבוץ à l’index demandé", () => {
    const res = appendManualSlot({ sun: { בוקר: [[]] } }, {}, {
      ...target,
      slotIndex: 1,
      workerName: "Bob",
    });

    expect(res.slotIndex).toBe(1);
    expect(res.assignments.sun["בוקר"][0]).toEqual(["", "Bob"]);
    expect(res.pulls["sun|בוקר|0|0"]).toBeUndefined();
    expect(isManualSlotPullEntry(res.pulls["sun|בוקר|0|1"])).toBe(true);
  });
});

describe("updateManualSlot", () => {
  it("modifie nom, rôle et horaires d’un poste existant", () => {
    const created = appendManualSlot(baseAssignments(), {}, { ...target, workerName: "Bob" });
    const updated = updateManualSlot(created.assignments, created.pulls, {
      ...target,
      slotIndex: created.slotIndex,
      workerName: "Carol",
      roleName: "קב\"ט",
      start: "09:00",
      end: "17:00",
    });

    expect(updated.assignments.sun["בוקר"][0]).toEqual(["Alice", "Carol"]);
    expect(updated.pulls["sun|בוקר|0|1"]).toEqual({
      manualSlot: { roleName: 'קב"ט' },
      guardDisplay: { start: "09:00", end: "17:00" },
    });
  });

  it("vide le poste (cellule vacante) sans supprimer la métadonnée", () => {
    const created = appendManualSlot(baseAssignments(), {}, { ...target, workerName: "Bob" });
    const updated = updateManualSlot(created.assignments, created.pulls, {
      ...target,
      slotIndex: 1,
      workerName: "",
    });

    expect(updated.assignments.sun["בוקר"][0]).toEqual(["Alice", ""]);
    expect(isManualSlotPullEntry(updated.pulls["sun|בוקר|0|1"])).toBe(true);
  });
});

describe("removeManualSlot", () => {
  it("supprime un poste du milieu et réindexe les clés pulls suivantes", () => {
    let state = appendManualSlot(baseAssignments(), {}, {
      ...target,
      workerName: "Bob",
      roleName: "rôle-1",
    });
    state = appendManualSlot(state.assignments, state.pulls, {
      ...target,
      workerName: "Carol",
      roleName: "rôle-2",
    });
    expect(state.assignments.sun["בוקר"][0]).toEqual(["Alice", "Bob", "Carol"]);

    const removed = removeManualSlot(state.assignments, state.pulls, {
      ...target,
      slotIndex: 1,
    });

    expect(removed.assignments.sun["בוקר"][0]).toEqual(["Alice", "Carol"]);
    expect(removed.pulls["sun|בוקר|0|2"]).toBeUndefined();
    expect(manualSlotRoleName(removed.pulls["sun|בוקר|0|1"])).toBe("rôle-2");
  });

  it("ne touche pas aux clés des autres cellules", () => {
    const created = appendManualSlot(baseAssignments(), { "sun|לילה|0|0": { guardDisplay: { start: "23:00", end: "07:00" } } }, {
      ...target,
      workerName: "Bob",
    });
    const removed = removeManualSlot(created.assignments, created.pulls, { ...target, slotIndex: 1 });
    expect(removed.pulls["sun|לילה|0|0"]).toEqual({ guardDisplay: { start: "23:00", end: "07:00" } });
  });

  it("survit à un aller-retour JSON", () => {
    const created = appendManualSlot(baseAssignments(), {}, {
      ...target,
      workerName: "Bob",
      roleName: "אחמש",
      start: "07:00",
      end: "15:00",
    });
    const roundTrip = JSON.parse(JSON.stringify(created.pulls));
    expect(manualSlotRoleName(roundTrip["sun|בוקר|0|1"])).toBe("אחמש");
    expect(isManualExtraSlot(roundTrip, "sun", "בוקר", 0, 1, 1)).toBe(true);
  });
});

describe("isManualExtraSlot", () => {
  it("détecte un slot marqué manualSlot même sous la capacité requise", () => {
    const pulls = { "sun|בוקר|0|0": { manualSlot: {} } };
    expect(isManualExtraSlot(pulls, "sun", "בוקר", 0, 0, 2)).toBe(true);
  });

  it("ne considère pas une vraie משיכה comme poste manuel", () => {
    const pulls = {
      "sun|בוקר|0|2": { before: { name: "Alice" }, after: { name: "Bob" } },
    };
    expect(isManualExtraSlot(pulls, "sun", "בוקר", 0, 2, 1)).toBe(false);
  });

  it("considère un slot au-delà de la capacité comme extra", () => {
    expect(isManualExtraSlot({}, "sun", "בוקר", 0, 2, 1)).toBe(true);
    expect(isManualExtraSlot({}, "sun", "בוקר", 0, 0, 1)).toBe(false);
  });
});

describe("buildExportCellSlots", () => {
  it("expose les postes manuels, y compris vacants, avec rôle et horaires", () => {
    const created = appendManualSlot(baseAssignments(), {}, {
      ...target,
      roleName: "אחמש",
      start: "07:00",
      end: "15:00",
    });

    expect(manualSlotSpanInCell(created.pulls, "sun", "בוקר", 0)).toBe(2);
    expect(buildExportCellSlots(created.assignments, created.pulls, "sun", "בוקר", 0)).toEqual([
      { name: "Alice", slotIndex: 0, manual: false, roleName: null, start: "", end: "" },
      { name: "", slotIndex: 1, manual: true, roleName: "אחמש", start: "07:00", end: "15:00" },
    ]);
  });

  it("ignore les slots vides non manuels", () => {
    const assignments = { sun: { בוקר: [["Alice", "", "Bob"]] } };
    expect(
      buildExportCellSlots(assignments, {}, "sun", "בוקר", 0).map((s) => s.slotIndex),
    ).toEqual([0, 2]);
  });
});

describe("slotTimeMetaFromPulls avec poste שיבוץ", () => {
  it("retourne horaires + rôle du poste manuel", () => {
    const pulls = {
      "sun|בוקר|0|1": {
        manualSlot: { roleName: "אחמש" },
        guardDisplay: { start: "07:00", end: "15:00" },
      },
    };
    expect(slotTimeMetaFromPulls(pulls, "sun", "בוקר", 0, 1, "Bob")).toEqual({
      label: "07:00–15:00",
      red: true,
      highlight: "guard",
      roleName: "אחמש",
    });
  });

  it("retourne seulement le rôle si aucun horaire custom", () => {
    const pulls = { "sun|בוקר|0|1": { manualSlot: { roleName: "אחמש" } } };
    expect(slotTimeMetaFromPulls(pulls, "sun", "בוקר", 0, 1, "Bob")).toEqual({
      label: "",
      red: false,
      roleName: "אחמש",
    });
  });
});

describe("listRolesForStationShift", () => {
  it("agrège les rôles de la garde, du jour et de l’עמדה sans doublon ni rôle désactivé", () => {
    const station = {
      roles: [{ name: "כללי" }],
      shifts: [{ name: "בוקר", roles: [{ name: "אחמש" }, { name: "מושבת", enabled: false }] }],
      dayOverrides: { sun: { shifts: [{ name: "בוקר", roles: [{ name: 'קב"ט' }, { name: "אחמש" }] }] } },
    };
    expect(listRolesForStationShift(station, "בוקר", "sun")).toEqual(['קב"ט', "אחמש", "כללי"]);
  });
});

/** Jours (sun…sat) + métadonnées optionnelles pour le serveur. */
export type WorkerAvailability = Record<string, string[]> & {
  /** Indices d’עמדה autorisés pour cette semaine sur ce site (strings) ; absent ou vide = toutes. */
  _stations?: string[];
};

/** Aligné sur la page planning : liste עובדים. */
export type PlanningWorker = {
  id: number;
  name: string;
  maxShifts: number;
  roles: string[];
  availability: WorkerAvailability;
  answers: Record<string, unknown>;
  phone?: string | null;
  linkedSiteIds?: number[];
  linkedSiteNames?: string[];
  pendingApproval?: boolean;
  createdAt?: number;
  removedFromWeekIso?: string | null;
};

export type SiteSummary = {
  id: number;
  name: string;
  config?: Record<string, unknown>;
  /** epoch ms — site בגל לסוג soft-delete */
  deletedAt?: number | null;
};

/** משיכה — structure minimale alignée sur le planning principal / backend. */
export type PlanningV2PullEntry = {
  before?: { name?: string; start?: string; end?: string };
  after?: { name?: string; start?: string; end?: string };
  /** שינוי שעות — affichage (arrivée / fin de garde), sans être une משיכה à deux noms. */
  guardDisplay?: { start?: string; end?: string };
};

export type PlanningV2PullsMap = Record<string, PlanningV2PullEntry>;

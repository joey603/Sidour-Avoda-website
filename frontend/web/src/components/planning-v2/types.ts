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
  next_week_saved_plan_status?: {
    exists?: boolean;
    week_iso?: string | null;
    complete?: boolean | null;
    assigned_count?: number;
    required_count?: number;
    pulls_count?: number;
    scope?: "auto" | "director" | "shared" | null;
    requires_manual_save?: boolean;
  } | null;
  /** epoch ms — site בגל לסוג soft-delete */
  deletedAt?: number | null;
};

/** Métadonnée d’un poste שיבוץ ajouté manuellement (hors capacité config). */
export type PlanningV2ManualSlotMeta = {
  /** Rôle optionnel ; absent / vide = ללא תפקיד. */
  roleName?: string | null;
};

/** משיכה — structure minimale alignée sur le planning principal / backend. */
export type PlanningV2PullEntry = {
  before?: { name?: string; start?: string; end?: string };
  after?: { name?: string; start?: string; end?: string };
  /** שינוי שעות — affichage (arrivée / fin de garde), sans être une משיכה à deux noms. */
  guardDisplay?: { start?: string; end?: string };
  /** Rôle lié à une משיכה (runtime / legacy). */
  roleName?: string | null;
  /** Poste parallèle ajouté via le mode שיבוץ. */
  manualSlot?: PlanningV2ManualSlotMeta | true;
};

export type PlanningV2PullsMap = Record<string, PlanningV2PullEntry>;

/** אירוע אתר — affectations travailleurs par date. */
export type SiteEvent = {
  id: number;
  site_id: number;
  title: string;
  start_time?: string | null;
  end_time?: string | null;
  dates: string[];
  assignments: Record<string, number[]>;
  created_at: number;
  updated_at: number;
};

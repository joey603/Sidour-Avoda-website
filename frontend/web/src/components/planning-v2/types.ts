export type WorkerAvailability = Record<string, string[]>;

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
};

export type SiteSummary = {
  id: number;
  name: string;
  config?: Record<string, unknown>;
};

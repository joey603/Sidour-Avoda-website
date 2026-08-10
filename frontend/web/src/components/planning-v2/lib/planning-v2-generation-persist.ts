import { apiFetch } from "@/lib/api";
import type { PlanningV2PullsMap, PlanningWorker } from "../types";
import { assignmentsNonEmpty } from "./assignments-empty";
import {
  type DraftAlternative,
  buildSeenLinkedAlternativeSnapshots,
  uniqueDraftAlternatives,
} from "./planning-v2-draft-alternatives";
import { linkedPlansAltCounts } from "./planning-v2-max-shifts-prune";
import {
  buildPersistableLinkedPlans,
  readLinkedPlansFromMemory,
  saveLinkedPlansToMemory,
  type LinkedSitePlan,
} from "./multi-site-linked-memory";
import {
  buildWeekPlanDataPayload,
  buildWorkersSnapshotForSave,
  persistAutoWeekPlanDraftToApi,
} from "./week-plan-persist";

type AssignmentGrid = Record<string, Record<string, string[][]>>;
type RefLike<T> = { current: T };

export type PersistGeneratedAutoDraftToServerArgs = {
  linkedSitesLength: number;
  weekStart: Date;
  weekIso: string;
  siteId: string;
  assignmentVariants: AssignmentGrid[];
  draftAssignmentsRef: RefLike<AssignmentGrid | null>;
  draftPullsRef: RefLike<PlanningV2PullsMap>;
  draftAlternativesRef: RefLike<DraftAlternative[]>;
  weekPlanAssignmentsRef: RefLike<AssignmentGrid | undefined>;
  workersRef: RefLike<PlanningWorker[]>;
  seenLinkedAlternativeSnapshotsRef: RefLike<Set<string>>;
};

export async function persistGeneratedAutoDraftToServer({
  linkedSitesLength,
  weekStart,
  weekIso,
  siteId,
  assignmentVariants,
  draftAssignmentsRef,
  draftPullsRef,
  draftAlternativesRef,
  weekPlanAssignmentsRef,
  workersRef,
  seenLinkedAlternativeSnapshotsRef,
}: PersistGeneratedAutoDraftToServerArgs): Promise<void> {
  if (linkedSitesLength > 1) {
    const mem = readLinkedPlansFromMemory(weekStart);
    let persistablePlans = buildPersistableLinkedPlans(mem?.plansBySite);
    const currentSiteKey = String(siteId);
    const currentPersistablePlan = persistablePlans[currentSiteKey];
    const currentVisibleAssignments =
      draftAssignmentsRef.current ??
      weekPlanAssignmentsRef.current ??
      (assignmentVariants[0] && typeof assignmentVariants[0] === "object" ? assignmentVariants[0] : null);
    if (
      currentPersistablePlan &&
      !assignmentsNonEmpty(currentPersistablePlan.assignments ?? null) &&
      assignmentsNonEmpty(currentVisibleAssignments ?? null)
    ) {
      persistablePlans = {
        ...persistablePlans,
        [currentSiteKey]: {
          ...currentPersistablePlan,
          assignments: currentVisibleAssignments as Record<string, Record<string, string[][]>>,
          pulls:
            (draftPullsRef.current && typeof draftPullsRef.current === "object"
              ? draftPullsRef.current
              : {}) as Record<string, unknown>,
        },
      };
      console.warn("[planning-v2][multi-site][persist][hydrate-current-site-before-save]", {
        siteId: String(siteId),
        weekIso,
        beforeAltCounts: linkedPlansAltCounts(mem?.plansBySite),
        afterAltCounts: linkedPlansAltCounts(persistablePlans),
      });
    }
    const persistedSiteIds: string[] = [];
    for (const [sid, pl] of Object.entries(persistablePlans)) {
      const assignments = pl.assignments;
      if (!assignments || !assignmentsNonEmpty(assignments)) continue;
      const pulls = (pl.pulls && typeof pl.pulls === "object" ? pl.pulls : {}) as Record<string, unknown>;
      const altAsg = Array.isArray(pl.alternatives) ? pl.alternatives : [];
      const altPulls = Array.isArray(pl.alternative_pulls) ? pl.alternative_pulls : [];
      const w = String(sid) === String(siteId) ? workersRef.current : [];
      const base = buildWeekPlanDataPayload(
        Number(sid),
        weekStart,
        assignments as Record<string, Record<string, string[][]>>,
        pulls as PlanningV2PullsMap,
        buildWorkersSnapshotForSave(w),
        false,
      ) as Record<string, unknown>;
      if (altAsg.length > 0) {
        base.alternatives = altAsg;
        base.alternative_pulls = altPulls.map((x) => (x && typeof x === "object" ? x : {}));
      }
      await persistAutoWeekPlanDraftToApi(sid, weekStart, base);
      persistedSiteIds.push(String(sid));
    }
    if (persistedSiteIds.length > 0) {
      try {
        const refreshedEntries = await Promise.all(
          persistedSiteIds.map(async (sid) => {
            const payload = await apiFetch<LinkedSitePlan | null>(
              `/director/sites/${sid}/week-plan?week=${encodeURIComponent(weekIso)}&scope=auto`,
              {
                cache: "no-store" as RequestCache,
              },
            );
            return [sid, (payload && typeof payload === "object" ? payload : {}) as LinkedSitePlan] as const;
          }),
        );
        const refreshedPlans = Object.fromEntries(refreshedEntries);
        const nextPlans = buildPersistableLinkedPlans({
          ...persistablePlans,
          ...refreshedPlans,
        });
        const nextActiveAltIndex = Math.max(0, Number(mem?.activeAltIndex || 0));
        console.warn("[planning-v2][multi-site][persist][refreshed-auto-plans]", {
          siteId: String(siteId),
          weekIso,
          activeIdx: nextActiveAltIndex,
          savedSiteIds: persistedSiteIds,
          beforeAltCounts: linkedPlansAltCounts(persistablePlans),
          refreshedAltCounts: linkedPlansAltCounts(refreshedPlans),
          afterAltCounts: linkedPlansAltCounts(nextPlans),
        });
        saveLinkedPlansToMemory(weekStart, nextPlans, nextActiveAltIndex);
        seenLinkedAlternativeSnapshotsRef.current = buildSeenLinkedAlternativeSnapshots(nextPlans);
      } catch {
        /* ignore */
      }
    }
    return;
  }
  const asg = draftAssignmentsRef.current;
  if (!asg || !assignmentsNonEmpty(asg)) return;
  const pulls = draftPullsRef.current || {};
  const alts = uniqueDraftAlternatives(draftAlternativesRef.current || []);
  const base = buildWeekPlanDataPayload(
    Number(siteId),
    weekStart,
    asg,
    pulls,
    buildWorkersSnapshotForSave(workersRef.current),
    false,
  ) as Record<string, unknown>;
  if (alts.length > 0) {
    base.alternatives = alts.map((x) => x.assignments);
    base.alternative_pulls = alts.map((x) => x.pulls || {});
  }
  await persistAutoWeekPlanDraftToApi(siteId, weekStart, base);
}

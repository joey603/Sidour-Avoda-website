"use client";

import { PlanningV2AssignmentsSummary } from "./planning-v2-assignments-summary";
import { PlanningV2StationWeekGrid } from "./stations/planning-v2-station-week-grid";
import type { ManualDragSource } from "./lib/planning-v2-manual-drop";
import type { PlanningV2PullEntry, PlanningV2PullsMap, PlanningWorker, SiteSummary, WorkerAvailability } from "./types";

type AssignmentsMap = Record<string, Record<string, string[][]>>;
type AvailabilityOverlays = Record<string, Record<string, string[]>>;

type PlanningV2VisualizationContentProps = {
  site: SiteSummary | null;
  siteId: string;
  weekStart: Date;
  workers: PlanningWorker[];
  assignments: AssignmentsMap | null | undefined;
  assignmentVariants?: AssignmentsMap[] | null;
  assignmentHighlightBase: AssignmentsMap | null | undefined;
  pulls: PlanningV2PullsMap | null | undefined;
  draftFixedAssignmentsSnapshot: AssignmentsMap | null | undefined;
  isSavedMode: boolean;
  editingSaved: boolean;
  loading: boolean;
  isManual: boolean;
  manualEditable: boolean;
  pullsModeStationIdx: number | null;
  shiftHoursModeStationIdx: number | null;
  draggingWorkerName: string | null;
  selectedWorkerSource: ManualDragSource | null;
  onDraggingWorkerChange: (workerName: string | null) => void;
  onWorkerSelectToggle: (workerName: string, source?: ManualDragSource | null) => void;
  availabilityByWorkerName: Record<string, WorkerAvailability>;
  availabilityOverlays: AvailabilityOverlays;
  onTogglePullsModeStation: (stationIdx: number) => void;
  onToggleShiftHoursModeStation: (stationIdx: number) => void;
  onUpsertGuardDisplay: (key: string, start: string, end: string) => boolean | void | Promise<boolean | void>;
  onRemoveGuardDisplay: (key: string) => boolean | void | Promise<boolean | void>;
  onResetStation: (stationIdx: number) => void;
  onManualSlotDragOutside: (dragSource: ManualDragSource) => void | Promise<void>;
  onManualSlotDrop: (p: {
    dayKey: string;
    shiftName: string;
    stationIndex: number;
    slotIndex: number;
    workerName: string;
    dragSource: ManualDragSource | null;
  }) => void | Promise<void>;
  onUpsertPull: (key: string, entry: PlanningV2PullEntry) => boolean | void | Promise<boolean | void>;
  onRemovePull: (key: string) => void | boolean | Promise<boolean | void>;
  summaryHighlightWorkerName: string | null;
  pullVariants?: PlanningV2PullsMap[];
  alternativesEnabled: boolean;
  selectedAlternativeIndex: number;
  onSelectedAlternativeChange: (index: number) => void;
  onFilteredAlternativesChange: (payload: { indices: number[]; hasActiveFilters: boolean }) => void;
  generationRunning: boolean;
  onHighlightWorkerToggle: (workerName: string) => void;
  eventAssignmentCountsByName: Map<string, number>;
};

export function PlanningV2VisualizationContent({
  site,
  siteId,
  weekStart,
  workers,
  assignments,
  assignmentVariants,
  assignmentHighlightBase,
  pulls,
  draftFixedAssignmentsSnapshot,
  isSavedMode,
  editingSaved,
  loading,
  isManual,
  manualEditable,
  pullsModeStationIdx,
  shiftHoursModeStationIdx,
  draggingWorkerName,
  selectedWorkerSource,
  onDraggingWorkerChange,
  onWorkerSelectToggle,
  availabilityByWorkerName,
  availabilityOverlays,
  onTogglePullsModeStation,
  onToggleShiftHoursModeStation,
  onUpsertGuardDisplay,
  onRemoveGuardDisplay,
  onResetStation,
  onManualSlotDragOutside,
  onManualSlotDrop,
  onUpsertPull,
  onRemovePull,
  summaryHighlightWorkerName,
  pullVariants,
  alternativesEnabled,
  selectedAlternativeIndex,
  onSelectedAlternativeChange,
  onFilteredAlternativesChange,
  generationRunning,
  onHighlightWorkerToggle,
  eventAssignmentCountsByName,
}: PlanningV2VisualizationContentProps) {
  return (
    <div className="space-y-4">
      <PlanningV2StationWeekGrid
        site={site}
        siteId={siteId}
        weekStart={weekStart}
        workers={workers}
        assignments={assignments}
        assignmentVariants={assignmentVariants}
        assignmentHighlightBase={assignmentHighlightBase}
        pulls={pulls}
        draftFixedAssignmentsSnapshot={draftFixedAssignmentsSnapshot}
        isSavedMode={isSavedMode}
        editingSaved={editingSaved}
        loading={loading}
        isManual={isManual}
        manualEditable={manualEditable}
        pullsModeStationIdx={pullsModeStationIdx}
        shiftHoursModeStationIdx={shiftHoursModeStationIdx}
        draggingWorkerName={draggingWorkerName}
        selectedWorkerSource={selectedWorkerSource}
        onDraggingWorkerChange={onDraggingWorkerChange}
        onWorkerSelectToggle={onWorkerSelectToggle}
        availabilityByWorkerName={availabilityByWorkerName}
        availabilityOverlays={availabilityOverlays}
        onTogglePullsModeStation={onTogglePullsModeStation}
        onToggleShiftHoursModeStation={onToggleShiftHoursModeStation}
        onUpsertGuardDisplay={onUpsertGuardDisplay}
        onRemoveGuardDisplay={onRemoveGuardDisplay}
        onResetStation={onResetStation}
        onManualSlotDragOutside={onManualSlotDragOutside}
        onManualSlotDrop={onManualSlotDrop}
        onUpsertPull={onUpsertPull}
        onRemovePull={onRemovePull}
        summaryHighlightWorkerName={summaryHighlightWorkerName}
      />
      <PlanningV2AssignmentsSummary
        siteId={siteId}
        site={site}
        weekStart={weekStart}
        workers={workers}
        assignments={assignments}
        pulls={pulls}
        assignmentVariants={assignmentVariants ?? []}
        pullVariants={pullVariants}
        alternativesEnabled={alternativesEnabled}
        selectedAlternativeIndex={selectedAlternativeIndex}
        onSelectedAlternativeChange={onSelectedAlternativeChange}
        onFilteredAlternativesChange={onFilteredAlternativesChange}
        loading={loading}
        generationRunning={generationRunning}
        highlightedWorkerName={summaryHighlightWorkerName}
        onHighlightWorkerToggle={onHighlightWorkerToggle}
        eventAssignmentCountsByName={eventAssignmentCountsByName}
      />
    </div>
  );
}

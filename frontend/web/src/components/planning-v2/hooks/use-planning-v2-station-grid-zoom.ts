import { useCallback, useRef, useState, type RefObject } from "react";
import {
  MAX_STATION_GRID_ZOOM,
  MIN_STATION_GRID_ZOOM,
  STATION_GRID_ZOOM_STEP,
  roundStationZoom,
} from "../lib/planning-v2-station-week-grid-utils";

export function usePlanningV2StationGridZoom() {
  const [stationZoomByIdx, setStationZoomByIdx] = useState<Record<number, number>>({});
  const [stationZoomBaseSizeByIdx, setStationZoomBaseSizeByIdx] = useState<
    Record<number, { width: number; height: number }>
  >({});
  const stationGridScrollRefByIdx = useRef<Record<number, HTMLDivElement | null>>({});

  const getStationZoom = useCallback(
    (stationIdx: number) => stationZoomByIdx[stationIdx] ?? MIN_STATION_GRID_ZOOM,
    [stationZoomByIdx],
  );

  const adjustStationZoom = useCallback(
    (stationIdx: number, delta: number) => {
      const current = stationZoomByIdx[stationIdx] ?? MIN_STATION_GRID_ZOOM;
      const next = roundStationZoom(
        Math.min(MAX_STATION_GRID_ZOOM, Math.max(MIN_STATION_GRID_ZOOM, current + delta)),
      );
      if (next === current) return;

      if (current <= MIN_STATION_GRID_ZOOM && next > MIN_STATION_GRID_ZOOM) {
        const scroller = stationGridScrollRefByIdx.current[stationIdx];
        const table = scroller?.querySelector("table");
        const width = Math.round(table?.getBoundingClientRect().width || scroller?.clientWidth || 0);
        const height = Math.round(table?.getBoundingClientRect().height || scroller?.clientHeight || 0);
        if (width > 0 && height > 0) {
          setStationZoomBaseSizeByIdx((sizes) => {
            const prev = sizes[stationIdx];
            if (prev?.width === width && prev?.height === height) return sizes;
            return { ...sizes, [stationIdx]: { width, height } };
          });
        }
      }
      if (next <= MIN_STATION_GRID_ZOOM) {
        setStationZoomBaseSizeByIdx((sizes) => {
          if (sizes[stationIdx] == null) return sizes;
          const { [stationIdx]: _removed, ...rest } = sizes;
          return rest;
        });
      }

      setStationZoomByIdx((prev) => ({ ...prev, [stationIdx]: next }));
    },
    [stationZoomByIdx],
  );

  return {
    MIN_STATION_GRID_ZOOM,
    MAX_STATION_GRID_ZOOM,
    STATION_GRID_ZOOM_STEP,
    stationZoomBaseSizeByIdx,
    stationGridScrollRefByIdx: stationGridScrollRefByIdx as RefObject<
      Record<number, HTMLDivElement | null>
    >,
    getStationZoom,
    adjustStationZoom,
  };
}

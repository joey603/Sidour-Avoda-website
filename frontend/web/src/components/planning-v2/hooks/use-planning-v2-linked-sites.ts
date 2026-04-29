"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { getWeekKeyISO } from "../lib/week";

export type LinkedSiteRow = {
  id: number;
  name: string;
  /** Site retiré de la liste active (soft-delete) — affiché après les sites actifs. */
  site_deleted?: boolean;
  assigned_count?: number;
  required_count?: number;
};

function sortLinkedSitesForDisplay(rows: LinkedSiteRow[]): LinkedSiteRow[] {
  return [...rows].sort((a, b) => {
    const da = a.site_deleted ? 1 : 0;
    const db = b.site_deleted ? 1 : 0;
    if (da !== db) return da - db;
    return String(a.name || "").localeCompare(String(b.name || ""), "he");
  });
}

export function usePlanningV2LinkedSites(siteId: string, weekStart: Date) {
  const [linkedSites, setLinkedSites] = useState<LinkedSiteRow[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const id = Number(siteId);
    if (!Number.isFinite(id) || id <= 0) {
      setLinkedSites([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const wk = getWeekKeyISO(weekStart);
      const list = await apiFetch<LinkedSiteRow[]>(
        `/director/sites/${siteId}/linked-sites?week=${encodeURIComponent(wk)}`,
        {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          cache: "no-store",
        },
      );
      setLinkedSites(sortLinkedSitesForDisplay(Array.isArray(list) ? (list as LinkedSiteRow[]) : []));
    } catch {
      setLinkedSites([]);
    } finally {
      setLoading(false);
    }
  }, [siteId, weekStart]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { linkedSites, linkedSitesLoading: loading, reloadLinkedSites: reload };
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import LoadingAnimation from "@/components/loading-animation";
import { PlanningV2LayoutShell } from "@/components/planning-v2/planning-v2-layout-shell";
import { WorkerHomeSitePanels } from "@/components/worker/worker-home-site-panels";

interface Site {
  id: number;
  name: string;
  site_deleted?: boolean;
  config?: any;
}

const isRtlName = (s: string) => /[\u0590-\u05FF]/.test(String(s || ""));

function normWorkerKey(name: string): string {
  return String(name || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

function weekIsoLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function WorkerDashboard() {
  const router = useRouter();
  const [name, setName] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [sites, setSites] = useState<Site[]>([]);
  type SiteMessage = {
    id: number;
    site_id: number;
    text: string;
    scope: "global" | "week";
    created_week_iso: string;
    stopped_week_iso?: string | null;
    origin_id?: number | null;
    created_at: number;
    updated_at: number;
  };
  /** Surbrillance grille ↔ clic sur סיכום שיבוצים (clé `${siteId}_${weekIso}`). */
  const [workerSummaryHighlight, setWorkerSummaryHighlight] = useState<Record<string, string | null>>({});

  const [sitePlans, setSitePlans] = useState<
    Record<
      number,
      {
        currentWeek: any | null;
        nextWeek: any | null;
        config: any | null;
        messagesCurrent: SiteMessage[];
        messagesNext: SiteMessage[];
      }
    >
  >({});

  type NameColor = { bg: string; border: string; text: string };

  function hashColorForName(name: string): NameColor {
    const s = name || "";
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = (hash << 5) - hash + s.charCodeAt(i);
      hash |= 0;
    }
    const allowedHues = [20, 30, 40, 50, 200, 210, 220, 230, 260, 270, 280, 290, 300, 310];
    const idx = Math.abs(hash) % allowedHues.length;
    const hue = allowedHues[idx];
    const lightVariants = [88, 84, 80] as const;
    const satVariants = [85, 80, 75] as const;
    const vIdx = Math.abs(hash >> 3) % lightVariants.length;
    const L = lightVariants[vIdx];
    const Sbg = satVariants[vIdx];
    const Sborder = 60;
    const bg = `hsl(${hue} ${Sbg}% ${L}%)`;
    const border = `hsl(${hue} ${Sborder}% ${Math.max(65, L - 10)}%)`;
    const text = `#1f2937`;
    return { bg, border, text };
  }

  function buildNameColorMap(
    assignments: Record<string, Record<string, string[][]>> | undefined,
    workersList: Array<{ name: string }>,
  ): Map<string, NameColor> {
    const set = new Set<string>();
    (workersList || []).forEach((w) => {
      const nm = (w?.name || "").trim();
      if (nm) set.add(nm);
    });
    Object.keys(assignments || {}).forEach((dayKey) => {
      const shifts = (assignments as any)[dayKey] || {};
      Object.keys(shifts).forEach((shiftName) => {
        const perStation: string[][] = shifts[shiftName] || [];
        perStation.forEach((arr) => {
          (arr || []).forEach((nm) => {
            const v = (nm || "").trim();
            if (v) set.add(v);
          });
        });
      });
    });
    const names = Array.from(set).sort((a, b) => a.localeCompare(b));
    const GOLDEN = 137.508;
    const shiftForbidden = (h: number) => {
      if (h < 20 || h >= 350) h = (h + 30) % 360;
      if (h >= 100 && h <= 150) h = (h + 40) % 360;
      return h;
    };
    const map = new Map<string, NameColor>();
    names.forEach((nm, i) => {
      let h = (i * GOLDEN) % 360;
      h = shiftForbidden(h);
      const L = [88, 84, 80][i % 3];
      const Sbg = [85, 80, 75][(i >> 1) % 3];
      const bg = `hsl(${h} ${Sbg}% ${L}%)`;
      const border = `hsl(${h} 60% ${Math.max(65, L - 10)}%)`;
      map.set(nm, { bg, border, text: "#1f2937" });
    });
    return map;
  }

  function getColorForName(name: string, map?: Map<string, NameColor>): NameColor {
    if (map && map.has(name)) return map.get(name)!;
    return hashColorForName(name);
  }

  function calculateSummary(
    assignments: any,
    config: any,
    workers: Array<{ name: string; roles?: string[] }>,
  ): {
    items: Array<[string, number]>;
    totalRequired: number;
    totalAssigned: number;
  } {
    const counts = new Map<string, number>();
    const dayKeys = Object.keys(assignments || {});

    for (const dKey of dayKeys) {
      const shiftsMap = assignments[dKey] || {};
      for (const sn of Object.keys(shiftsMap)) {
        const perStation: string[][] = shiftsMap[sn] || [];
        for (const namesHere of perStation) {
          for (const nm of namesHere || []) {
            if (!nm) continue;
            counts.set(nm, (counts.get(nm) || 0) + 1);
          }
        }
      }
    }

    workers.forEach((w) => {
      if (!counts.has(w.name)) counts.set(w.name, 0);
    });

    const order = new Map<string, number>();
    workers.forEach((w, i) => order.set(w.name, i));
    const items = Array.from(counts.entries()).sort((a, b) => {
      const ia = order.has(a[0]) ? (order.get(a[0]) as number) : Number.MAX_SAFE_INTEGER;
      const ib = order.has(b[0]) ? (order.get(b[0]) as number) : Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      return a[0].localeCompare(b[0]);
    });

    const stationsCfgAll: any[] = (config?.stations || []) as any[];
    function requiredForSummary(st: any, shiftName: string, dayKey: string): number {
      if (!st) return 0;
      if (st.perDayCustom) {
        const dayCfg = st.dayOverrides?.[dayKey];
        if (!dayCfg || dayCfg.active === false) return 0;
        if (st.uniformRoles) return Number(st.workers || 0);
        const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
        if (!sh || !sh.enabled) return 0;
        return Number(sh.workers || 0);
      }
      if (st.days && st.days[dayKey] === false) return 0;
      if (st.uniformRoles) return Number(st.workers || 0);
      const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
      if (!sh || !sh.enabled) return 0;
      return Number(sh.workers || 0);
    }

    let totalRequired = 0;
    for (const dKey of dayKeys) {
      const shiftsMap = assignments[dKey] || {};
      for (const sn of Object.keys(shiftsMap)) {
        for (let tIdx = 0; tIdx < stationsCfgAll.length; tIdx++) {
          totalRequired += requiredForSummary(stationsCfgAll[tIdx], sn, dKey);
        }
      }
    }

    const totalAssigned = Array.from(counts.values()).reduce((a, b) => a + b, 0);

    return { items, totalRequired, totalAssigned };
  }

  function getCurrentWeekStart(): Date {
    const today = new Date();
    const day = today.getDay();
    const start = new Date(today);
    start.setDate(today.getDate() - day);
    start.setHours(0, 0, 0, 0);
    return start;
  }

  function getNextWeekStart(): Date {
    const currentWeekStart = getCurrentWeekStart();
    const nextWeekStart = new Date(currentWeekStart);
    nextWeekStart.setDate(currentWeekStart.getDate() + 7);
    return nextWeekStart;
  }

  async function loadWeekPlan(siteId: number, weekStart: Date): Promise<any | null> {
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const key = `plan_${siteId}_${iso(weekStart)}`;
    try {
      const wk = iso(weekStart);
      const fromApi = await apiFetch<any>(`/public/sites/${siteId}/week-plan?week=${encodeURIComponent(wk)}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        cache: "no-store" as any,
      });
      if (fromApi && typeof fromApi === "object" && fromApi.assignments) {
        try {
          localStorage.setItem(key, JSON.stringify(fromApi));
        } catch {
          /* ignore */
        }
        return fromApi;
      }
    } catch {
      /* ignore */
    }
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(key) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.assignments) return parsed;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  useEffect(() => {
    (async () => {
      const me = await fetchMe();
      if (!me) return router.replace("/login/worker");
      if (me.role !== "worker") return router.replace("/director");
      setName(me.full_name || "");

      try {
        const sitesList = await apiFetch<Array<{ id: number; name: string; site_deleted?: boolean }>>(
          "/public/sites/worker-sites",
          {
            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          },
        );
        const activeSites = (sitesList || []).filter((s) => !s.site_deleted);
        setSites(activeSites);

        const plans: Record<
          number,
          {
            currentWeek: any | null;
            nextWeek: any | null;
            config: any | null;
            messagesCurrent: SiteMessage[];
            messagesNext: SiteMessage[];
          }
        > = {};

        const iso = (d: Date) =>
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

        for (const site of activeSites) {
          try {
            const siteConfig = await apiFetch<{ id: number; name: string; config: any }>(
              `/public/sites/${site.id}/config`,
              {
                headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
              },
            );

            const currentWeekStart = getCurrentWeekStart();
            const nextWeekStart = getNextWeekStart();
            const currentPlan = await loadWeekPlan(site.id, currentWeekStart);
            const nextPlan = await loadWeekPlan(site.id, nextWeekStart);
            const messagesCurrent = await apiFetch<SiteMessage[]>(
              `/public/sites/${site.id}/messages?week=${encodeURIComponent(iso(currentWeekStart))}`,
              {
                headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
              },
            );
            const messagesNext = await apiFetch<SiteMessage[]>(
              `/public/sites/${site.id}/messages?week=${encodeURIComponent(iso(nextWeekStart))}`,
              {
                headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
              },
            );

            plans[site.id] = {
              currentWeek: currentPlan,
              nextWeek: nextPlan,
              config: siteConfig?.config || null,
              messagesCurrent: Array.isArray(messagesCurrent) ? messagesCurrent : [],
              messagesNext: Array.isArray(messagesNext) ? messagesNext : [],
            };
          } catch (e) {
            console.error(`Error loading site ${site.id}:`, e);
            plans[site.id] = {
              currentWeek: null,
              nextWeek: null,
              config: null,
              messagesCurrent: [],
              messagesNext: [],
            };
          }
        }

        setSitePlans(plans);
      } catch (e: any) {
        console.error("Error loading sites:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  function formatHebDate(d: Date): string {
    return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function formatWeekRange(weekStart: Date): string {
    const end = new Date(weekStart);
    end.setDate(weekStart.getDate() + 6);
    return `${formatHebDate(weekStart)} — ${formatHebDate(end)}`;
  }

  const toggleWorkerSummaryHighlight = useCallback((siteId: number, weekStart: Date, workerName: string) => {
    const k = `${siteId}_${weekIsoLocal(weekStart)}`;
    setWorkerSummaryHighlight((prev) => {
      const cur = prev[k] ?? null;
      const next = normWorkerKey(cur || "") === normWorkerKey(workerName) ? null : workerName;
      return { ...prev, [k]: next };
    });
  }, []);

  function stationSummaryBlock(
    siteId: number,
    weekStart: Date,
    weekPlan: any,
    config: any,
    highlightedWorkerName: string | null,
    onHighlightToggle: (name: string) => void,
  ) {
    if (!weekPlan?.assignments || !config) return null;
    const workersList = (weekPlan.workers || []) as Array<{ name: string; roles?: string[] }>;
    if (workersList.length === 0) {
      return (
        <div className="mt-4 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">סיכום שיבוצים לעמדה (כל העמדות)</div>
          <div className="text-sm text-zinc-500">אין שיבוצים</div>
        </div>
      );
    }
    const summary = calculateSummary(weekPlan.assignments, config, workersList);
    const summaryColorMap = buildNameColorMap(weekPlan.assignments, workersList);
    return (
      <div className="mt-4 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">סיכום שיבוצים לעמדה (כל העמדות)</div>
        <div className="mb-2 flex items-center justify-end gap-6 text-[10px] md:text-sm">
          <div>
            סה&quot;כ נדרש: <span className="font-medium">{summary.totalRequired}</span>
          </div>
          <div>
            סה&quot;כ שיבוצים: <span className="font-medium">{summary.totalAssigned}</span>
          </div>
        </div>
        <div className="overflow-x-hidden md:overflow-x-auto">
          <table className="w-full border-collapse text-[10px] md:text-sm table-fixed">
            <thead>
              <tr className="border-b dark:border-zinc-800">
                <th className="w-32 px-1 py-1 text-right md:w-64 md:px-2 md:py-2">עובד</th>
                <th className="w-16 whitespace-nowrap px-1 py-1 text-right md:w-28 md:px-2 md:py-2">מס&apos; משמרות</th>
              </tr>
            </thead>
            <tbody>
              {summary.items.map(([nm, c]) => {
                const col = getColorForName(nm, summaryColorMap);
                const rowSummaryHighlight =
                  !!highlightedWorkerName && normWorkerKey(nm) === normWorkerKey(highlightedWorkerName);
                return (
                  <tr key={nm} className="border-b last:border-0 dark:border-zinc-800">
                    <td
                      className={
                        "w-32 px-1 py-1 md:w-64 md:px-2 md:py-2 " +
                        "cursor-pointer touch-manipulation rounded-md outline-none transition-[background-color] duration-200 focus-visible:ring-2 focus-visible:ring-[#00A8E0] " +
                        (rowSummaryHighlight
                          ? "bg-sky-50 ring-1 ring-[#00A8E0]/50 dark:bg-sky-950/40 dark:ring-[#00A8E0]/40 "
                          : "hover:bg-zinc-50 dark:hover:bg-zinc-800/60 ")
                      }
                      role="button"
                      tabIndex={0}
                      aria-pressed={rowSummaryHighlight ? true : undefined}
                      onClick={() => onHighlightToggle(nm)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onHighlightToggle(nm);
                        }
                      }}
                    >
                      <span className="inline-flex max-w-full min-w-0 items-center justify-center">
                        <span
                          className="inline-flex max-w-full min-w-0 items-center rounded-full border px-2 py-0.5 text-[10px] shadow-sm md:px-3 md:py-1 md:text-sm"
                          style={{ backgroundColor: col.bg, borderColor: col.border, color: col.text }}
                        >
                          <span
                            className={"truncate min-w-0 " + (isRtlName(nm) ? "text-right" : "text-left")}
                            dir={isRtlName(nm) ? "rtl" : "ltr"}
                            title={nm}
                          >
                            {nm}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="w-16 px-1 py-1 md:w-28 md:px-2 md:py-2">{c}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingAnimation size={80} />
      </div>
    );
  }

  return (
    <div
      className="min-h-screen overflow-x-hidden px-3 py-6 pb-40 sm:px-4 lg:px-4 md:pb-40 [&_button]:touch-manipulation"
      dir="rtl"
    >
      <PlanningV2LayoutShell>
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">
            ברוך הבא,{" "}
            <span className="font-bold" style={{ color: "#00A8E0" }}>
              {name}
            </span>
          </h1>
        </header>

        {sites.length === 0 ? (
          <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-sm text-zinc-500">אין אתרים זמינים</p>
          </div>
        ) : (
          sites.map((site) => {
            const plan = sitePlans[site.id];
            const currentWeekStart = getCurrentWeekStart();
            const nextWeekStart = getNextWeekStart();
            const keyCur = `${site.id}_${weekIsoLocal(currentWeekStart)}`;
            const keyNext = `${site.id}_${weekIsoLocal(nextWeekStart)}`;
            return (
              <WorkerHomeSitePanels
                key={site.id}
                siteId={site.id}
                siteName={site.name}
                config={plan?.config ?? null}
                currentWeekStart={currentWeekStart}
                nextWeekStart={nextWeekStart}
                formatWeekRange={formatWeekRange}
                currentWeek={plan?.currentWeek ?? null}
                nextWeek={plan?.nextWeek ?? null}
                messagesCurrent={plan?.messagesCurrent ?? []}
                messagesNext={plan?.messagesNext ?? []}
                summaryHighlightWorkerNameCurrent={workerSummaryHighlight[keyCur] ?? null}
                summaryHighlightWorkerNameNext={workerSummaryHighlight[keyNext] ?? null}
                summaryCurrent={stationSummaryBlock(
                  site.id,
                  currentWeekStart,
                  plan?.currentWeek,
                  plan?.config,
                  workerSummaryHighlight[keyCur] ?? null,
                  (nm) => toggleWorkerSummaryHighlight(site.id, currentWeekStart, nm),
                )}
                summaryNext={stationSummaryBlock(
                  site.id,
                  nextWeekStart,
                  plan?.nextWeek,
                  plan?.config,
                  workerSummaryHighlight[keyNext] ?? null,
                  (nm) => toggleWorkerSummaryHighlight(site.id, nextWeekStart, nm),
                )}
              />
            );
          })
        )}
      </PlanningV2LayoutShell>
    </div>
  );
}

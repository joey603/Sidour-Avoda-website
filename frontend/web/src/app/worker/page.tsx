"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import DOMPurify from "dompurify";

interface Site {
  id: number;
  name: string;
  config?: any;
}

const dayLabels: Record<string, string> = {
  sun: "ראשון",
  mon: "שני",
  tue: "שלישי",
  wed: "רביעי",
  thu: "חמישי",
  fri: "שישי",
  sat: "שבת",
};

const isRtlName = (s: string) => /[\u0590-\u05FF]/.test(String(s || "")); // hébreu

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
  const [sitePlans, setSitePlans] = useState<Record<number, {
    currentWeek: any | null;
    nextWeek: any | null;
    config: any | null;
    messagesCurrent: SiteMessage[];
    messagesNext: SiteMessage[];
  }>>({});

  type NameColor = { bg: string; border: string; text: string };
  type RoleColor = { border: string; text: string };

  function hashColorForName(name: string): NameColor {
    const s = name || "";
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash) + s.charCodeAt(i);
      hash |= 0;
    }
    // Hues autorisées (éviter rouge ~0 et vert ~120)
    const allowedHues = [20, 30, 40, 50, 200, 210, 220, 230, 260, 270, 280, 290, 300, 310];
    const idx = Math.abs(hash) % allowedHues.length;
    const hue = allowedHues[idx];
    // Légère variation de luminosité/saturation pour augmenter la distinction
    const lightVariants = [88, 84, 80] as const;
    const satVariants = [85, 80, 75] as const;
    const vIdx = Math.abs((hash >> 3)) % lightVariants.length;
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
    workersList: Array<{ name: string }>
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

  function buildRoleColorMap(
    config: any,
    workersList: Array<{ roles?: string[] }> = []
  ): Map<string, RoleColor> {
    const set = new Set<string>();
    (config?.stations || []).forEach((st: any) => {
      (st?.roles || []).forEach((r: any) => {
        const nm = (r?.name || "").trim();
        if (nm) set.add(nm);
      });
      (st?.shifts || []).forEach((sh: any) => {
        (sh?.roles || []).forEach((r: any) => {
          const nm = (r?.name || "").trim();
          if (nm) set.add(nm);
        });
      });
    });
    (workersList || []).forEach((w) => {
      (w.roles || []).forEach((nm) => {
        const v = (nm || "").trim();
        if (v) set.add(v);
      });
    });
    const roles = Array.from(set).sort((a, b) => a.localeCompare(b));
    const GOLDEN = 137.508;
    const map = new Map<string, RoleColor>();
    roles.forEach((nm, i) => {
      let h = (i * GOLDEN) % 360;
      if (h >= 100 && h <= 150) h = (h + 40) % 360;
      const border = `hsl(${h} 70% 40%)`;
      const text = `hsl(${h} 60% 30%)`;
      map.set(nm, { border, text });
    });
    return map;
  }

  function hashColorForRole(roleName: string): RoleColor {
    const s = roleName || "";
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash) + s.charCodeAt(i);
      hash |= 0;
    }
    const GOLDEN = 137.508;
    let h = (Math.abs(hash) * GOLDEN) % 360;
    if (h >= 100 && h <= 150) h = (h + 40) % 360;
    const border = `hsl(${h} 70% 40%)`;
    const text = `hsl(${h} 60% 30%)`;
    return { border, text };
  }

  function getColorForRole(roleName: string, map?: Map<string, RoleColor>): RoleColor {
    if (map && map.has(roleName)) return map.get(roleName)!;
    return hashColorForRole(roleName);
  }

  // Fonction pour obtenir les rôles requis pour une station/shift/jour
  function roleRequirements(st: any, shiftName: string, dayKey: string): Record<string, number> {
    const req: Record<string, number> = {};
    // Vérifier les rôles globaux de la station
    if (Array.isArray(st?.roles)) {
      for (const r of st.roles) {
        if (r?.name && typeof r?.count === "number" && r.count > 0) {
          req[r.name] = (req[r.name] || 0) + r.count;
        }
      }
    }
    // Vérifier les rôles spécifiques au shift
    const shift = (st?.shifts || []).find((sh: any) => sh?.name === shiftName && sh?.enabled);
    if (shift && Array.isArray(shift?.roles)) {
      for (const r of shift.roles) {
        if (r?.name && typeof r?.count === "number" && r.count > 0) {
          req[r.name] = (req[r.name] || 0) + r.count;
        }
      }
    }
    // Vérifier les overrides par jour
    if (st?.perDayCustom && st?.dayOverrides?.[dayKey]?.active) {
      const dayOv = st.dayOverrides[dayKey];
      const dayShift = (dayOv?.shifts || []).find((sh: any) => sh?.name === shiftName && sh?.enabled);
      if (dayShift && Array.isArray(dayShift?.roles)) {
        for (const r of dayShift.roles) {
          if (r?.name && typeof r?.count === "number" && r.count > 0) {
            req[r.name] = (req[r.name] || 0) + r.count;
          }
        }
      }
    }
    return req;
  }

  // Fonction pour assigner les rôles aux travailleurs assignés
  function assignRoles(assignedNames: string[], workers: Array<{ name: string; roles?: string[] }>, st: any, shiftName: string, dayKey: string): Map<string, string | null> {
    const req = roleRequirements(st, shiftName, dayKey);
    const res = new Map<string, string | null>();
    const used = new Set<number>();
    
    // Normaliser les noms de rôles
    function normRole(r: string): string {
      return (r || "").trim().toLowerCase();
    }
    
    // Vérifier si un travailleur a un rôle
    function nameHasRole(name: string, roleName: string): boolean {
      const w = workers.find((x) => (x.name || "").trim() === (name || "").trim());
      if (!w) return false;
      const target = normRole(roleName);
      return (w.roles || []).some((r) => normRole(String(r)) === target);
    }
    
    // Prefill null
    assignedNames.forEach((nm) => res.set(nm, null));
    
    // Greedy fill per role
    for (const [rName, rCount] of Object.entries(req)) {
      let left = rCount;
      if (left <= 0) continue;
      for (let i = 0; i < assignedNames.length && left > 0; i++) {
        if (used.has(i)) continue;
        const nm = assignedNames[i];
        if (!nameHasRole(nm, rName)) continue;
        res.set(nm, rName);
        used.add(i);
        left--;
      }
    }
    return res;
  }

  // Fonction pour obtenir les couleurs des rôles
  function colorForRole(roleName: string, config: any): { border: string; text: string } {
    // Générer une couleur stable basée sur le nom du rôle
    const s = roleName || "";
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash) + s.charCodeAt(i);
      hash |= 0;
    }
    const GOLDEN = 137.508;
    let h = (Math.abs(hash) * GOLDEN) % 360;
    // éviter zones trop proches du vert
    if (h >= 100 && h <= 150) h = (h + 40) % 360;
    const border = `hsl(${h} 70% 40%)`;
    const text = `hsl(${h} 60% 30%)`;
    return { border, text };
  }

  // Calculer le début de la semaine actuelle (dimanche)
  function getCurrentWeekStart(): Date {
    const today = new Date();
    const day = today.getDay();
    const start = new Date(today);
    start.setDate(today.getDate() - day);
    start.setHours(0, 0, 0, 0);
    return start;
  }

  // Calculer le début de la semaine prochaine (dimanche prochain)
  function getNextWeekStart(): Date {
    const currentWeekStart = getCurrentWeekStart();
    const nextWeekStart = new Date(currentWeekStart);
    nextWeekStart.setDate(currentWeekStart.getDate() + 7);
    return nextWeekStart;
  }

  // Charger le planning pour une semaine donnée
  function loadWeekPlan(siteId: number, weekStart: Date): any | null {
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const key = `plan_${siteId}_${iso(weekStart)}`;
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(key) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.assignments) {
          return parsed;
        }
      }
    } catch {
      // Ignorer les erreurs
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
        // Charger les sites où le travailleur est enregistré
        const sitesList = await apiFetch<Array<{ id: number; name: string }>>("/public/sites/worker-sites", {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        });
        setSites(sitesList || []);

        // Charger les configs et plannings pour chaque site
        const plans: Record<number, {
          currentWeek: any | null;
          nextWeek: any | null;
          config: any | null;
          messagesCurrent: SiteMessage[];
          messagesNext: SiteMessage[];
        }> = {};

        for (const site of sitesList || []) {
          try {
            // Charger la config du site
            const siteConfig = await apiFetch<{ id: number; name: string; config: any }>(`/public/sites/${site.id}/config`, {
              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
            });

            // Charger les plannings
            const currentWeekStart = getCurrentWeekStart();
            const nextWeekStart = getNextWeekStart();
            const currentPlan = loadWeekPlan(site.id, currentWeekStart);
            const nextPlan = loadWeekPlan(site.id, nextWeekStart);
            const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
            const messagesCurrent = await apiFetch<SiteMessage[]>(`/public/sites/${site.id}/messages?week=${encodeURIComponent(iso(currentWeekStart))}`, {
              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
            });
            const messagesNext = await apiFetch<SiteMessage[]>(`/public/sites/${site.id}/messages?week=${encodeURIComponent(iso(nextWeekStart))}`, {
              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
            });

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

  function addDays(base: Date, days: number): Date {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
  }

  // Fonction pour obtenir les horaires d'un shift
  function hoursFromConfig(st: any, shiftName: string): string | null {
    if (!st) return null;
    const fmt = (start?: string, end?: string) => {
      if (!start || !end) return null;
      return `${start}-${end}`;
    };
    if (st.perDayCustom) {
      for (const dk of ["sun","mon","tue","wed","thu","fri","sat"]) {
        const dayCfg = st.dayOverrides?.[dk];
        if (!dayCfg || !dayCfg.active) continue;
        const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
        if (sh?.enabled) {
          const f = fmt(sh?.start, sh?.end);
          if (f) return f;
        }
      }
    }
    const base = (st.shifts || []).find((x: any) => x?.name === shiftName);
    return fmt(base?.start, base?.end);
  }

  function hoursOf(shiftName: string): string | null {
    // Extraire les heures du nom du shift si format "06-14"
    const match = shiftName.match(/(\d{2})-(\d{2})/);
    if (match) return match[0];
    return null;
  }

  // Fonction pour obtenir le nombre requis de travailleurs
  function getRequiredFor(st: any, shiftName: string, dayKey: string): number {
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

  // Fonction pour vérifier si un jour est actif
  function isDayActive(st: any, dayKey: string): boolean {
    if (!st) return false;
    if (st.perDayCustom) {
      const dayCfg = st.dayOverrides?.[dayKey];
      return dayCfg?.active === true;
    }
    if (st.days && st.days[dayKey] === false) return false;
    return true;
  }

  // Fonction pour calculer le résumé des assignations
  function calculateSummary(assignments: any, config: any, workers: Array<{ name: string; roles?: string[] }>): {
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
          for (const nm of (namesHere || [])) {
            if (!nm) continue;
            counts.set(nm, (counts.get(nm) || 0) + 1);
          }
        }
      }
    }

    // Ajouter tous les travailleurs avec 0 si non assignés
    workers.forEach((w) => {
      if (!counts.has(w.name)) counts.set(w.name, 0);
    });

    // Ordre stable basé sur l'ordre des travailleurs
    const order = new Map<string, number>();
    workers.forEach((w, i) => order.set(w.name, i));
    const items = Array.from(counts.entries()).sort((a, b) => {
      const ia = order.has(a[0]) ? (order.get(a[0]) as number) : Number.MAX_SAFE_INTEGER;
      const ib = order.has(b[0]) ? (order.get(b[0]) as number) : Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      return a[0].localeCompare(b[0]);
    });

    // Calculer le total requis
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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-lg">טוען...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">ברוך הבא, <span className="font-bold" style={{ color: '#00A8E0' }}>{name}</span></h1>
        </header>

        {sites.length === 0 ? (
        <div className="rounded-xl border p-4 dark:border-zinc-800">
            <p className="text-sm text-zinc-500">אין אתרים זמינים</p>
          </div>
        ) : (
          sites.map((site) => {
            const plan = sitePlans[site.id];
            const currentWeekStart = getCurrentWeekStart();
            const nextWeekStart = getNextWeekStart();

            return (
              <div key={site.id} className="space-y-6">
                <h2 className="text-xl font-semibold">{site.name}</h2>

                {/* Semaine actuelle */}
                <section className="rounded-xl border p-4 dark:border-zinc-800">
                  <h3 className="mb-3 text-lg font-semibold">
                    שבוע נוכחי: {formatWeekRange(currentWeekStart)}
                  </h3>
                  {!plan?.config || !plan?.currentWeek ? (
                    <p className="text-sm text-zinc-500">אין נתוני תכנון שמורים לשבוע זה.</p>
                  ) : (
                    <div className="space-y-6">
                      {(plan.config?.stations || []).map((st: any, idx: number) => {
                        const dayCols = [
                          { key: "sun", label: "א'" },
                          { key: "mon", label: "ב'" },
                          { key: "tue", label: "ג'" },
                          { key: "wed", label: "ד'" },
                          { key: "thu", label: "ה'" },
                          { key: "fri", label: "ו'" },
                          { key: "sat", label: "ש'" },
                        ];
                        const shiftNamesAll = Array.from(
                          new Set(
                            (plan.config?.stations || [])
                              .flatMap((station: any) => (station?.shifts || [])
                                .filter((sh: any) => sh?.enabled)
                                .map((sh: any) => sh?.name))
                              .filter(Boolean)
                          )
                        ).map(String);
                        const workersList = (plan.currentWeek.workers || []) as Array<{ name: string; roles?: string[] }>;
                        const nameColorMap = buildNameColorMap(plan.currentWeek.assignments, workersList);
                        const roleColorMap = buildRoleColorMap(plan.config, workersList);
                        return (
                          <div key={idx} className="rounded-xl border p-3 dark:border-zinc-800">
                            <div className="mb-2 flex items-center justify-between">
                              <div className="text-base font-medium">{st.name}</div>
                            </div>
                            <div className="overflow-x-auto">
                              <table className="w-full border-collapse text-sm table-fixed">
                                <thead>
                                  <tr className="border-b dark:border-zinc-800">
                                    <th className="px-2 py-2 text-right align-bottom w-28">משמרת</th>
                                    {dayCols.map((d, i) => {
                                      const date = addDays(currentWeekStart, i);
                                      return (
                                        <th key={d.key} className="px-2 py-2 text-center align-bottom">
                                          <div className="flex flex-col items-center leading-tight">
                                            <span className="text-xs text-zinc-500">{formatHebDate(date)}</span>
                                            <span className="mt-0.5">{d.label}</span>
                                          </div>
                                        </th>
                                      );
                                    })}
                                  </tr>
                                </thead>
                                <tbody>
                                  {shiftNamesAll.map((sn) => {
                                    const stationShift = (st.shifts || []).find((x: any) => x?.name === sn);
                                    const enabled = !!stationShift?.enabled;
                                    return (
                                      <tr key={sn} className="border-b last:border-0 dark:border-zinc-800">
                                        <td className="px-2 py-2 w-28">
                                          <div className="flex flex-col items-start">
                                            {(() => {
                                              const h = hoursFromConfig(st, sn) || hoursOf(sn);
                                              return h ? (
                                                <div className="text-[10px] leading-none text-zinc-500 mb-0.5">{h}</div>
                                              ) : null;
                                            })()}
                                            <div className="font-medium">{sn}</div>
                                          </div>
                                        </td>
                                        {dayCols.map((d, dayIdx) => {
                                          const required = getRequiredFor(st, sn, d.key);
                                          const dateCell = addDays(currentWeekStart, dayIdx);
                                          const today0 = new Date(); today0.setHours(0,0,0,0);
                                          const isPastDay = dateCell < today0;
                                          const names: string[] = (plan.currentWeek.assignments?.[d.key]?.[sn]?.[idx] || []) as any;
                                          const pulls = (plan.currentWeek as any)?.pulls || {};
                                          const roleMap = assignRoles(names, workersList, st, sn, d.key);
                                          const activeDay = isDayActive(st, d.key);
                                          return (
                                            <td
                                              key={d.key}
                                              className={
                                                "px-2 py-2 text-center " +
                                                (enabled ? "" : "text-zinc-400 ") +
                                                (!activeDay ? "bg-zinc-100 text-zinc-400 dark:bg-zinc-900/40 " : "") +
                                                (isPastDay ? " bg-zinc-100 dark:bg-zinc-900/40 " : "")
                                              }
                                            >
                                              {enabled ? (
                                                <div className="flex flex-col items-center">
                                                  {required > 0 && (
                                                    <div className="mb-1 flex flex-col items-center gap-1 min-w-full">
                                                      <div className="flex flex-col items-center gap-1 w-full px-2 py-1">
                                                        {(() => {
                                                          const cleanNames = (names || []).map(String).map((x) => x.trim()).filter(Boolean);
                                                          const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                          const pullsCount = Object.keys(pulls || {}).filter((k) => String(k).startsWith(cellPrefix)).length;
                                                          const slotCount = Math.max(required + pullsCount, cleanNames.length, 1);
                                                          return Array.from({ length: slotCount }).map((_, slotIdx) => {
                                                            const nm = cleanNames[slotIdx];
                                                            if (!nm) {
                                                              return (
                                                                <div key={`empty-${slotIdx}`} className="w-full flex justify-center py-0.5">
                                                                  <span className="inline-flex h-9 min-w-[4rem] max-w-[6rem] items-center justify-center rounded-full border px-3 py-1 text-xs text-zinc-500 bg-zinc-100 dark:bg-zinc-900 dark:border-zinc-700">
                                                                    —
                                                                  </span>
                                                                </div>
                                                              );
                                                            }
                                                            const c = getColorForName(nm, nameColorMap);
                                                            const rn = roleMap.get(nm) || null;
                                                            const rc = rn ? getColorForRole(rn, roleColorMap) : null;
                                                            const match = Object.entries(pulls || {}).find(([k, entry]) => {
                                                              if (!String(k).startsWith(cellPrefix)) return false;
                                                              const e: any = entry;
                                                              return e?.before?.name === nm || e?.after?.name === nm;
                                                            });
                                                            const pullTxt = match
                                                              ? (((match as any)[1]?.before?.name === nm)
                                                                ? `${(match as any)[1].before.start}-${(match as any)[1].before.end}`
                                                                : `${(match as any)[1].after.start}-${(match as any)[1].after.end}`)
                                                              : null;
                                                            const chipClass =
                                                              "inline-flex min-h-9 max-w-[6rem] items-start rounded-full border px-3 py-1 shadow-sm gap-2 " +
                                                              (pullTxt ? "ring-2 ring-orange-400 " : "");
                                                            return (
                                                              <div key={`nm-${nm}-${slotIdx}`} className="group relative w-full flex justify-center py-0.5">
                                                                <span
                                                                  className={chipClass}
                                                                  style={{ backgroundColor: c.bg, borderColor: (rc?.border || c.border), color: c.text }}
                                                                >
                                                                  <span className="flex flex-col items-center text-center leading-tight flex-1 min-w-0">
                                                                    {rn ? (
                                                                      <span className="text-[10px] font-medium text-zinc-700 dark:text-zinc-300 truncate mb-0.5">{rn}</span>
                                                                    ) : null}
                                                                    <span
                                                                      className={"text-sm truncate max-w-full leading-tight " + (isRtlName(nm) ? "text-right" : "text-left")}
                                                                      dir={isRtlName(nm) ? "rtl" : "ltr"}
                                                                    >
                                                                      {nm}
                                                                    </span>
                                                                    {pullTxt ? <span dir="ltr" className="text-[10px] leading-tight text-zinc-700/80 dark:text-zinc-300/80">{pullTxt}</span> : null}
                                                                  </span>
                                                                </span>

                                                                {/* Expansion animée au survol (menu worker) */}
                                                                <div
                                                                  aria-hidden
                                                                  className="pointer-events-none absolute inset-x-0 top-0.1 z-50 flex justify-center opacity-0 scale-95 group-hover:opacity-100 group-hover:scale-100 transition-all duration-200 ease-out"
                                                                >
                                                                  <span
                                                                    className={chipClass + " max-w-[6rem] group-hover:max-w-[18rem] transition-[max-width] duration-200 ease-out shadow-lg"}
                                                                    style={{ backgroundColor: c.bg, borderColor: (rc?.border || c.border), color: c.text }}
                                                                  >
                                                                    <span className="flex flex-col items-center text-center leading-tight flex-1 min-w-0">
                                                                      {rn ? (
                                                                        <span className="text-[10px] font-medium text-zinc-700 dark:text-zinc-300 truncate mb-0.5">{rn}</span>
                                                                      ) : null}
                                                                      <span
                                                                        className={"text-sm whitespace-nowrap leading-tight " + (isRtlName(nm) ? "text-right" : "text-left")}
                                                                        dir={isRtlName(nm) ? "rtl" : "ltr"}
                                                                      >
                                                                        {nm}
                                                                      </span>
                                                                      {pullTxt ? (
                                                                        <span dir="ltr" className="text-[10px] leading-tight text-zinc-700/80 dark:text-zinc-300/80 whitespace-nowrap">
                                                                          {pullTxt}
                                                                        </span>
                                                                      ) : null}
                                                                    </span>
                                                                  </span>
                                                                </div>
                                                              </div>
                                                            );
                                                          });
                                                        })()}
                                                      </div>
                                                    </div>
                                                  )}
                                                </div>
                                              ) : null}
                                            </td>
                                          );
                                        })}
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        );
                      })}
                      {/* סיכום שיבוצים לעמדה (כל העמדות) */}
                      {plan.currentWeek && plan.currentWeek.assignments && (
                        <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
                          <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">סיכום שיבוצים לעמדה (כל העמדות)</div>
                          {(() => {
                            const workersList = (plan.currentWeek.workers || []) as Array<{ name: string; roles?: string[] }>;
                            if (workersList.length === 0) {
                              return <div className="text-sm text-zinc-500">אין שיבוצים</div>;
                            }
                            const summary = calculateSummary(plan.currentWeek.assignments, plan.config, workersList);
                            const summaryColorMap = buildNameColorMap(plan.currentWeek.assignments, workersList);
                            return (
                              <>
                                <div className="mb-2 flex items-center justify-end gap-6 text-sm">
                                  <div>סה"כ נדרש: <span className="font-medium">{summary.totalRequired}</span></div>
                                  <div>סה"כ שיבוצים: <span className="font-medium">{summary.totalAssigned}</span></div>
                                </div>
                                <div className="overflow-x-auto">
                                  <table className="w-full border-collapse text-sm table-fixed">
                                    <thead>
                                      <tr className="border-b dark:border-zinc-800">
                                        <th className="px-2 py-2 text-right w-64">עובד</th>
                                        <th className="px-2 py-2 text-right w-28">מס' משמרות</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {summary.items.map(([nm, c]) => {
                                        const col = getColorForName(nm, summaryColorMap);
                                        return (
                                          <tr key={nm} className="border-b last:border-0 dark:border-zinc-800">
                                            <td className="px-2 py-2 w-64">
                                              <span
                                                className="inline-flex items-center rounded-full border px-3 py-1 text-sm shadow-sm max-w-full min-w-0"
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
                                            </td>
                                            <td className="px-2 py-2 w-28">{c}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
                    <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">הודעות</div>
                    {(plan?.messagesCurrent || []).length === 0 ? (
                      <div className="text-sm text-zinc-500">אין הודעות</div>
                    ) : (
                      <div className="space-y-2">
                        {(plan?.messagesCurrent || []).map((m) => (
                          <div key={m.id} className="rounded-md border p-3 dark:border-zinc-700" dir="rtl">
                            {(() => {
                              const raw = String(m.text || "");
                              const isHtml = /<\/?[a-z][\s\S]*>/i.test(raw);
                              if (isHtml) {
                                const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, ADD_TAGS: ["mark"], ADD_ATTR: ["style", "data-color"] });
                                return <div className="prose prose-sm max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: clean }} />;
                              }
                              return (
                                <ReactMarkdown
                                  remarkPlugins={[remarkGfm]}
                                  components={{
                                    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                                    ul: ({ children }) => <ul className="mb-2 list-disc pr-5">{children}</ul>,
                                    ol: ({ children }) => <ol className="mb-2 list-decimal pr-5">{children}</ol>,
                                    li: ({ children }) => <li className="mb-1 last:mb-0">{children}</li>,
                                    a: ({ children, href }) => (
                                      <a className="underline decoration-dotted" href={href} target="_blank" rel="noreferrer">
                                        {children}
                                      </a>
                                    ),
                                    table: ({ children }) => (
                                      <div className="overflow-x-auto">
                                        <table className="w-full border-collapse text-sm">{children}</table>
                                      </div>
                                    ),
                                    th: ({ children }) => <th className="border px-2 py-1 text-right bg-zinc-50 dark:bg-zinc-800">{children}</th>,
                                    td: ({ children }) => <td className="border px-2 py-1 text-right align-top">{children}</td>,
                                  }}
                                >
                                  {raw}
                                </ReactMarkdown>
                              );
                            })()}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </section>

                {/* Semaine prochaine */}
                <section className="rounded-xl border p-4 dark:border-zinc-800">
                  <h3 className="mb-3 text-lg font-semibold">
                    שבוע הבא: {formatWeekRange(nextWeekStart)}
                  </h3>
                  {!plan?.config || !plan?.nextWeek ? (
                    <p className="text-sm text-zinc-500">אין נתוני תכנון שמורים לשבוע זה.</p>
                  ) : (
                    <div className="space-y-6">
                      {(plan.config?.stations || []).map((st: any, idx: number) => {
                        const dayCols = [
                          { key: "sun", label: "א'" },
                          { key: "mon", label: "ב'" },
                          { key: "tue", label: "ג'" },
                          { key: "wed", label: "ד'" },
                          { key: "thu", label: "ה'" },
                          { key: "fri", label: "ו'" },
                          { key: "sat", label: "ש'" },
                        ];
                        const shiftNamesAll = Array.from(
                          new Set(
                            (plan.config?.stations || [])
                              .flatMap((station: any) => (station?.shifts || [])
                                .filter((sh: any) => sh?.enabled)
                                .map((sh: any) => sh?.name))
                              .filter(Boolean)
                          )
                        ).map(String);
                        const workersList = (plan.nextWeek.workers || []) as Array<{ name: string; roles?: string[] }>;
                        const nameColorMap = buildNameColorMap(plan.nextWeek.assignments, workersList);
                        const roleColorMap = buildRoleColorMap(plan.config, workersList);
                        return (
                          <div key={idx} className="rounded-xl border p-3 dark:border-zinc-800">
                            <div className="mb-2 flex items-center justify-between">
                              <div className="text-base font-medium">{st.name}</div>
                            </div>
                            <div className="overflow-x-auto">
                              <table className="w-full border-collapse text-sm table-fixed">
                                <thead>
                                  <tr className="border-b dark:border-zinc-800">
                                    <th className="px-2 py-2 text-right align-bottom w-28">משמרת</th>
                                    {dayCols.map((d, i) => {
                                      const date = addDays(nextWeekStart, i);
                                      return (
                                        <th key={d.key} className="px-2 py-2 text-center align-bottom">
                                          <div className="flex flex-col items-center leading-tight">
                                            <span className="text-xs text-zinc-500">{formatHebDate(date)}</span>
                                            <span className="mt-0.5">{d.label}</span>
                                          </div>
                                        </th>
                                      );
                                    })}
                                  </tr>
                                </thead>
                                <tbody>
                                  {shiftNamesAll.map((sn) => {
                                    const stationShift = (st.shifts || []).find((x: any) => x?.name === sn);
                                    const enabled = !!stationShift?.enabled;
                                    return (
                                      <tr key={sn} className="border-b last:border-0 dark:border-zinc-800">
                                        <td className="px-2 py-2 w-28">
                                          <div className="flex flex-col items-start">
                                            {(() => {
                                              const h = hoursFromConfig(st, sn) || hoursOf(sn);
                                              return h ? (
                                                <div className="text-[10px] leading-none text-zinc-500 mb-0.5">{h}</div>
                                              ) : null;
                                            })()}
                                            <div className="font-medium">{sn}</div>
                                          </div>
                                        </td>
                                        {dayCols.map((d, dayIdx) => {
                                          const required = getRequiredFor(st, sn, d.key);
                                          const dateCell = addDays(nextWeekStart, dayIdx);
                                          const today0 = new Date(); today0.setHours(0,0,0,0);
                                          const isPastDay = dateCell < today0;
                                          const names: string[] = (plan.nextWeek.assignments?.[d.key]?.[sn]?.[idx] || []) as any;
                                          const pulls = (plan.nextWeek as any)?.pulls || {};
                                          const roleMap = assignRoles(names, workersList, st, sn, d.key);
                                          const activeDay = isDayActive(st, d.key);
                                          return (
                                            <td
                                              key={d.key}
                                              className={
                                                "px-2 py-2 text-center " +
                                                (enabled ? "" : "text-zinc-400 ") +
                                                (!activeDay ? "bg-zinc-100 text-zinc-400 dark:bg-zinc-900/40 " : "") +
                                                (isPastDay ? " bg-zinc-100 dark:bg-zinc-900/40 " : "")
                                              }
                                            >
                                              {enabled ? (
                                                <div className="flex flex-col items-center">
                                                  {required > 0 && (
                                                    <div className="mb-1 flex flex-col items-center gap-1 min-w-full">
                                                      <div className="flex flex-col items-center gap-1 w-full px-2 py-1">
                                                        {(() => {
                                                          const cleanNames = (names || []).map(String).map((x) => x.trim()).filter(Boolean);
                                                          const cellPrefix = `${d.key}|${sn}|${idx}|`;
                                                          const pullsCount = Object.keys(pulls || {}).filter((k) => String(k).startsWith(cellPrefix)).length;
                                                          const slotCount = Math.max(required + pullsCount, cleanNames.length, 1);
                                                          return Array.from({ length: slotCount }).map((_, slotIdx) => {
                                                            const nm = cleanNames[slotIdx];
                                                            if (!nm) {
                                                              return (
                                                                <div key={`empty-${slotIdx}`} className="w-full flex justify-center py-0.5">
                                                                  <span className="inline-flex h-9 min-w-[4rem] max-w-[6rem] items-center justify-center rounded-full border px-3 py-1 text-xs text-zinc-500 bg-zinc-100 dark:bg-zinc-900 dark:border-zinc-700">
                                                                    —
                                                                  </span>
                                                                </div>
                                                              );
                                                            }
                                                            const c = getColorForName(nm, nameColorMap);
                                                            const rn = roleMap.get(nm) || null;
                                                            const rc = rn ? getColorForRole(rn, roleColorMap) : null;
                                                            const match = Object.entries(pulls || {}).find(([k, entry]) => {
                                                              if (!String(k).startsWith(cellPrefix)) return false;
                                                              const e: any = entry;
                                                              return e?.before?.name === nm || e?.after?.name === nm;
                                                            });
                                                            const pullTxt = match
                                                              ? (((match as any)[1]?.before?.name === nm)
                                                                ? `${(match as any)[1].before.start}-${(match as any)[1].before.end}`
                                                                : `${(match as any)[1].after.start}-${(match as any)[1].after.end}`)
                                                              : null;
                                                            const chipClass =
                                                              "inline-flex min-h-9 max-w-[6rem] items-start rounded-full border px-3 py-1 shadow-sm gap-2 " +
                                                              (pullTxt ? "ring-2 ring-orange-400 " : "");
                                                            return (
                                                              <div key={`nm-${nm}-${slotIdx}`} className="group relative w-full flex justify-center py-0.5">
                                                                <span
                                                                  className={chipClass}
                                                                  style={{ backgroundColor: c.bg, borderColor: (rc?.border || c.border), color: c.text }}
                                                                >
                                                                  <span className="flex flex-col items-center text-center leading-tight flex-1 min-w-0">
                                                                    {rn ? (
                                                                      <span className="text-[10px] font-medium text-zinc-700 dark:text-zinc-300 truncate mb-0.5">{rn}</span>
                                                                    ) : null}
                                                                    <span
                                                                      className={"text-sm truncate max-w-full leading-tight " + (isRtlName(nm) ? "text-right" : "text-left")}
                                                                      dir={isRtlName(nm) ? "rtl" : "ltr"}
                                                                    >
                                                                      {nm}
                                                                    </span>
                                                                    {pullTxt ? <span dir="ltr" className="text-[10px] leading-tight text-zinc-700/80 dark:text-zinc-300/80">{pullTxt}</span> : null}
                                                                  </span>
                                                                </span>

                                                                {/* Expansion animée au survol (menu worker) */}
                                                                <div
                                                                  aria-hidden
                                                                  className="pointer-events-none absolute inset-x-0 top-0.1 z-50 flex justify-center opacity-0 scale-95 group-hover:opacity-100 group-hover:scale-100 transition-all duration-200 ease-out"
                                                                >
                                                                  <span
                                                                    className={chipClass + " max-w-[6rem] group-hover:max-w-[18rem] transition-[max-width] duration-200 ease-out shadow-lg"}
                                                                    style={{ backgroundColor: c.bg, borderColor: (rc?.border || c.border), color: c.text }}
                                                                  >
                                                                    <span className="flex flex-col items-center text-center leading-tight flex-1 min-w-0">
                                                                      {rn ? (
                                                                        <span className="text-[10px] font-medium text-zinc-700 dark:text-zinc-300 truncate mb-0.5">{rn}</span>
                                                                      ) : null}
                                                                      <span
                                                                        className={"text-sm whitespace-nowrap leading-tight " + (isRtlName(nm) ? "text-right" : "text-left")}
                                                                        dir={isRtlName(nm) ? "rtl" : "ltr"}
                                                                      >
                                                                        {nm}
                                                                      </span>
                                                                      {pullTxt ? (
                                                                        <span dir="ltr" className="text-[10px] leading-tight text-zinc-700/80 dark:text-zinc-300/80 whitespace-nowrap">
                                                                          {pullTxt}
                                                                        </span>
                                                                      ) : null}
                                                                    </span>
                                                                  </span>
                                                                </div>
                                                              </div>
                                                            );
                                                          });
                                                        })()}
                                                      </div>
                                                    </div>
                                                  )}
                                                </div>
                                              ) : null}
                                            </td>
                                          );
                                        })}
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        );
                      })}
                      {/* סיכום שיבוצים לעמדה (כל העמדות) */}
                      {plan.nextWeek && plan.nextWeek.assignments && (
                        <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
                          <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">סיכום שיבוצים לעמדה (כל העמדות)</div>
                          {(() => {
                            const workersList = (plan.nextWeek.workers || []) as Array<{ name: string; roles?: string[] }>;
                            if (workersList.length === 0) {
                              return <div className="text-sm text-zinc-500">אין שיבוצים</div>;
                            }
                            const summary = calculateSummary(plan.nextWeek.assignments, plan.config, workersList);
                            const summaryColorMap = buildNameColorMap(plan.nextWeek.assignments, workersList);
                            return (
                              <>
                                <div className="mb-2 flex items-center justify-end gap-6 text-sm">
                                  <div>סה"כ נדרש: <span className="font-medium">{summary.totalRequired}</span></div>
                                  <div>סה"כ שיבוצים: <span className="font-medium">{summary.totalAssigned}</span></div>
                                </div>
                                <div className="overflow-x-auto">
                                  <table className="w-full border-collapse text-sm table-fixed">
                                    <thead>
                                      <tr className="border-b dark:border-zinc-800">
                                        <th className="px-2 py-2 text-right w-64">עובד</th>
                                        <th className="px-2 py-2 text-right w-28">מס' משמרות</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {summary.items.map(([nm, c]) => {
                                        const col = getColorForName(nm, summaryColorMap);
                                        return (
                                          <tr key={nm} className="border-b last:border-0 dark:border-zinc-800">
                                            <td className="px-2 py-2 w-64">
                                              <span
                                                className="inline-flex items-center rounded-full border px-3 py-1 text-sm shadow-sm max-w-full min-w-0"
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
                                            </td>
                                            <td className="px-2 py-2 w-28">{c}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
                    <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">הודעות</div>
                    {(plan?.messagesNext || []).length === 0 ? (
                      <div className="text-sm text-zinc-500">אין הודעות</div>
                    ) : (
                      <div className="space-y-2">
                        {(plan?.messagesNext || []).map((m) => (
                          <div key={m.id} className="rounded-md border p-3 dark:border-zinc-700" dir="rtl">
                            {(() => {
                              const raw = String(m.text || "");
                              const isHtml = /<\/?[a-z][\s\S]*>/i.test(raw);
                              if (isHtml) {
                                const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, ADD_TAGS: ["mark"], ADD_ATTR: ["style", "data-color"] });
                                return <div className="prose prose-sm max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: clean }} />;
                              }
                              return (
                                <ReactMarkdown
                                  remarkPlugins={[remarkGfm]}
                                  components={{
                                    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                                    ul: ({ children }) => <ul className="mb-2 list-disc pr-5">{children}</ul>,
                                    ol: ({ children }) => <ol className="mb-2 list-decimal pr-5">{children}</ol>,
                                    li: ({ children }) => <li className="mb-1 last:mb-0">{children}</li>,
                                    a: ({ children, href }) => (
                                      <a className="underline decoration-dotted" href={href} target="_blank" rel="noreferrer">
                                        {children}
                                      </a>
                                    ),
                                    table: ({ children }) => (
                                      <div className="overflow-x-auto">
                                        <table className="w-full border-collapse text-sm">{children}</table>
                                      </div>
                                    ),
                                    th: ({ children }) => <th className="border px-2 py-1 text-right bg-zinc-50 dark:bg-zinc-800">{children}</th>,
                                    td: ({ children }) => <td className="border px-2 py-1 text-right align-top">{children}</td>,
                                  }}
                                >
                                  {raw}
                                </ReactMarkdown>
                              );
                            })()}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
        </div>
            );
          })
        )}
      </div>
    </div>
  );
}



"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { fetchMe } from "@/lib/auth";
import { toast } from "sonner";

export default function PlanningPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [site, setSite] = useState<any>(null);
  type WorkerAvailability = Record<string, string[]>; // key: day key (sun..sat) -> enabled shift names
  type Worker = {
    id: number;
    name: string;
    maxShifts: number;
    roles: string[];
    availability: WorkerAvailability;
  };
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [newWorkerName, setNewWorkerName] = useState("");
  const [newWorkerMax, setNewWorkerMax] = useState<number>(5);
  const [newWorkerRoles, setNewWorkerRoles] = useState<string[]>([]);
  const [newWorkerAvailability, setNewWorkerAvailability] = useState<WorkerAvailability>({
    sun: [],
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
  });
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingWorkerId, setEditingWorkerId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [hiddenWorkerIds, setHiddenWorkerIds] = useState<number[]>([]);
  const [weekStart, setWeekStart] = useState<Date>(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = today.getDay(); // 0 = Sunday
    const startThisWeek = new Date(today);
    startThisWeek.setDate(today.getDate() - day);
    const nextWeek = new Date(startThisWeek);
    nextWeek.setDate(startThisWeek.getDate() + 7); // semaine prochaine par défaut
    return nextWeek;
  });

  // IA planning result
  const [aiLoading, setAiLoading] = useState(false);
  type AIPlan = {
    days: string[];
    shifts: string[];
    stations: string[];
    assignments: Record<string, Record<string, string[][]>>;
    alternatives?: Record<string, Record<string, string[][]>>[];
    status: string;
    objective: number;
  };
  const [aiPlan, setAiPlan] = useState<AIPlan | null>(null);
  const [altIndex, setAltIndex] = useState<number>(0);
  const baseAssignmentsRef = useRef<Record<string, Record<string, string[][]>> | null>(null);

  // Construire un mapping nom -> couleur distincte (éviter rouge/vert), stable et réparti (golden angle)
  const nameToColor = useMemo(() => {
    const set = new Set<string>();
    // depuis la liste des workers
    for (const w of workers) {
      const nm = (w.name || "").trim();
      if (nm) set.add(nm);
    }
    // depuis le plan IA courant
    if (aiPlan && aiPlan.assignments) {
      for (const day of Object.keys(aiPlan.assignments)) {
        const shiftsMap = (aiPlan.assignments as any)[day] || {};
        for (const sh of Object.keys(shiftsMap)) {
          const perStation: string[][] = shiftsMap[sh] || [];
          for (const arr of perStation) {
            for (const nm of arr || []) {
              const v = (nm || "").trim();
              if (v) set.add(v);
            }
          }
        }
      }
    }
    const names = Array.from(set).sort((a, b) => a.localeCompare(b));
    const GOLDEN = 137.508;
    function shiftForbidden(h: number) {
      // éviter rouge ~[350..360)∪[0..20], vert ~[100..150]
      if (h < 20 || h >= 350) h = (h + 30) % 360;
      if (h >= 100 && h <= 150) h = (h + 40) % 360;
      return h;
    }
    const map = new Map<string, { bg: string; border: string; text: string }>();
    names.forEach((nm, i) => {
      let h = (i * GOLDEN) % 360;
      h = shiftForbidden(h);
      // alterner saturation/luminosité pour plus de séparation perceptuelle
      const L = [88, 84, 80][i % 3];
      const Sbg = [85, 80, 75][(i >> 1) % 3];
      const bg = `hsl(${h} ${Sbg}% ${L}%)`;
      const border = `hsl(${h} 60% ${Math.max(65, L - 10)}%)`;
      const text = `#1f2937`;
      map.set(nm, { bg, border, text });
    });
    return map;
  }, [workers, aiPlan]);

  // Couleur stable par employé (palette sans rouge/vert) pour éviter confusion avec l'état שיבוצים
  function colorForName(name: string): { bg: string; border: string; text: string } {
    const preset = nameToColor.get(name);
    if (preset) return preset;
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

  function addDays(base: Date, days: number): Date {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
  }

  function formatHebDate(d: Date): string {
    return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" });
  }

  useEffect(() => {
    // Debug: workers/hiddenIds
    // eslint-disable-next-line no-console
    console.log("[Planning] workers state:", workers);
  }, [workers]);
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log("[Planning] hiddenWorkerIds:", hiddenWorkerIds);
  }, [hiddenWorkerIds]);

  // Référentiels communs (utilisés par la liste et la modale)
  const dayDefs = [
    { key: "sun", label: "א'" },
    { key: "mon", label: "ב'" },
    { key: "tue", label: "ג'" },
    { key: "wed", label: "ד'" },
    { key: "thu", label: "ה'" },
    { key: "fri", label: "ו'" },
    { key: "sat", label: "ש'" },
  ];

  const allShiftNames: string[] = Array.from(
    new Set(
      (site?.config?.stations || [])
        .flatMap((st: any) => (st?.shifts || [])
          .filter((sh: any) => sh?.enabled)
          .map((sh: any) => sh?.name))
        .filter(Boolean)
    )
  );

  const allRoleNames: string[] = Array.from(
    new Set(
      (site?.config?.stations || [])
        .flatMap((st: any) => (st?.roles || []).map((r: any) => r?.name))
        .filter(Boolean)
    )
  );

  function toggleNewAvailability(dayKey: string, shift: string) {
    setNewWorkerAvailability((prev) => {
      const cur = prev[dayKey] || [];
      return {
        ...prev,
        [dayKey]: cur.includes(shift) ? cur.filter((s) => s !== shift) : [...cur, shift],
      };
    });
  }

  useEffect(() => {
    (async () => {
      const me = await fetchMe();
      if (!me) return router.replace("/login");
      if (me.role !== "director") return router.replace("/worker");
      try {
        const data = await apiFetch(`/director/sites/${params.id}`, {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        });
        setSite(data);
      } catch (e: any) {
        // Fallback: tenter via la liste si la lecture directe 404 juste après création
        try {
          const list = await apiFetch<any[]>(`/director/sites/`, {
            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
            cache: "no-store" as any,
          });
          const found = list.find((s: any) => String(s.id) === String(params.id));
          if (found) setSite(found);
          else setError("אתר לא נמצא");
        } catch (err) {
          setError("שגיאה בטעינת אתר");
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [params.id, router]);

  async function loadWorkers() {
    try {
      // eslint-disable-next-line no-console
      console.log("[Planning] loadWorkers: fetching...");
      const list = await apiFetch<any[]>(`/director/sites/${params.id}/workers`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        cache: "no-store" as any,
      });
      // eslint-disable-next-line no-console
      console.log("[Planning] loadWorkers: fetched", list);
      const mapped: Worker[] = (list || []).map((w: any) => ({
        id: w.id,
        name: w.name,
        maxShifts: w.max_shifts ?? w.maxShifts ?? 0,
        roles: Array.isArray(w.roles) ? w.roles : [],
        availability: w.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
      }));
      // eslint-disable-next-line no-console
      console.log("[Planning] loadWorkers: mapped", mapped);
      setWorkers(mapped);
    } catch (e: any) {
      toast.error("שגיאה בטעינת עובדים", { description: e?.message || "נסה שוב מאוחר יותר." });
    }
  }

  useEffect(() => {
    loadWorkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <h1 className="text-2xl font-semibold">יצירת תכנון משמרות</h1>
        {loading ? (
          <p>טוען...</p>
        ) : error ? (
          <p className="text-red-600">{error}</p>
        ) : (
          <div className="rounded-2xl border p-4 dark:border-zinc-800 space-y-6">
            <div className="mb-2 relative">
              <div className="text-sm text-zinc-500">אתר</div>
              <div className="text-lg font-medium">{site?.name}</div>
              <button
                type="button"
                onClick={() => router.push(`/director/sites/${site?.id}/edit`)}
                className="absolute top-0 left-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75Z"/></svg>
                עדכן הגדרות
              </button>
            </div>

            {/* Tableau travailleurs */}
            <section className="space-y-3">
              <h2 className="text-lg font-semibold text-center">עובדים</h2>
              {(() => {
                const dayDefs = [
                  { key: "sun", label: "א'" },
                  { key: "mon", label: "ב'" },
                  { key: "tue", label: "ג'" },
                  { key: "wed", label: "ד'" },
                  { key: "thu", label: "ה'" },
                  { key: "fri", label: "ו'" },
                  { key: "sat", label: "ש'" },
                ];
                const allShiftNames: string[] = Array.from(
                  new Set(
                    (site?.config?.stations || [])
                      .flatMap((st: any) => (st?.shifts || [])
                        .filter((sh: any) => sh?.enabled)
                        .map((sh: any) => sh?.name))
                      .filter(Boolean)
                  )
                );
                const allRoleNames: string[] = Array.from(
                  new Set(
                    (site?.config?.stations || [])
                      .flatMap((st: any) => (st?.roles || []).map((r: any) => r?.name))
                      .filter(Boolean)
                  )
                );

                function toggleNewAvailability(dayKey: string, shift: string) {
                  setNewWorkerAvailability((prev) => {
                    const cur = prev[dayKey] || [];
                    return {
                      ...prev,
                      [dayKey]: cur.includes(shift)
                        ? cur.filter((s) => s !== shift)
                        : [...cur, shift],
                    };
                  });
                }

                return (
                  <div className="rounded-md border p-3 space-y-3 dark:border-zinc-700">
                    <div className="flex items-center justify-between">
                      <div className="text-sm text-zinc-500">רשימת עובדים</div>
                      <button
                        type="button"
                        onClick={() => {
                          // reset form for add
                          setEditingWorkerId(null);
                          setNewWorkerName("");
                          setNewWorkerMax(5);
                          setNewWorkerRoles([]);
                          setNewWorkerAvailability({ sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });
                          setIsAddModalOpen(true);
                        }}
                        className="inline-flex items-center gap-2 rounded-md border border-green-600 px-3 py-2 text-sm text-green-600 hover:bg-green-50 dark:border-green-500 dark:text-green-400 dark:hover:bg-green-900/30"
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>
                        הוסף עובד
                      </button>
                    </div>
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm">
                          <thead>
                            <tr className="border-b dark:border-zinc-800">
                              <th className="px-3 py-2 text-right">שם</th>
                              <th className="px-3 py-2 text-right">מקס' משמרות</th>
                              <th className="px-3 py-2 text-right">תפקידים</th>
                              <th className="px-3 py-2 text-right">זמינות</th>
                              <th className="px-3 py-2"></th>
                            </tr>
                          </thead>
                          <tbody>
                          {workers.filter((w) => !hiddenWorkerIds.includes(w.id)).length > 0 ? (
                            workers.filter((w) => !hiddenWorkerIds.includes(w.id)).map((w) => (
                              <tr key={w.id} className="border-b last:border-0 dark:border-zinc-800">
                                <td className="px-3 py-2">{w.name}</td>
                                <td className="px-3 py-2">{w.maxShifts}</td>
                                <td className="px-3 py-2">{w.roles.join(", ") || "—"}</td>
                                <td className="px-3 py-2">
                                  {dayDefs.map((d, i) => (
                                    <span key={d.key} className="inline-block ltr:mr-2 rtl:ml-2 text-zinc-600 dark:text-zinc-300">
                                      {d.label}:{" "}
                                      {(w.availability[d.key] || []).join("/") || "—"}
                                      {i < dayDefs.length - 1 ? "  " : ""}
                                    </span>
                                  ))}
                                </td>
                                <td className="px-3 py-2 text-left">
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingWorkerId(w.id);
                                        // eslint-disable-next-line no-console
                                        console.log("[Planning] edit worker", w);
                                        setNewWorkerName(w.name);
                                        setNewWorkerMax(w.maxShifts);
                                        setNewWorkerRoles([...w.roles]);
                                        setNewWorkerAvailability({ ...w.availability });
                                        setIsAddModalOpen(true);
                                      }}
                                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                                    >
                                      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75Z"/></svg>
                                      ערוך
                                    </button>
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        // eslint-disable-next-line no-console
                                        console.log("[Planning] delete click worker", w.id, w.name);
                                        if (!confirm(`למחוק את ${w.name}?`)) return;
                                        setDeletingId(w.id);
                                        setHiddenWorkerIds((prev) => (prev.includes(w.id) ? prev : [...prev, w.id]));
                                        const previousWorkers = workers;
                                        // Retrait immédiat (optimiste)
                                        setWorkers((prev) => prev.filter((x) => x.id !== w.id));
                                        try {
                                          // eslint-disable-next-line no-console
                                          console.log("[Planning] DELETE /workers/", w.id);
                                          await apiFetch(`/director/sites/${params.id}/workers/${w.id}`, {
                                            method: "DELETE",
                                            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                                          });
                                          toast.success("העובד נמחק בהצלחה");
                                          // Rechargement avec retries pour éviter la réapparition (latence DB)
                                          for (let i = 0; i < 3; i++) {
                                            try {
                                              // eslint-disable-next-line no-console
                                              console.log(`[Planning] reload workers attempt ${i + 1}`);
                                              const list = await apiFetch<any[]>(`/director/sites/${params.id}/workers`, {
                                                headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                                                cache: "no-store" as any,
                                              });
                                              // eslint-disable-next-line no-console
                                              console.log("[Planning] reloaded list:", list);
                                              const contains = (list || []).some((it: any) => Number(it?.id) === Number(w.id));
                                              // eslint-disable-next-line no-console
                                              console.log("[Planning] contains deleted?", contains);
                                              if (!contains) {
                                                const mapped: Worker[] = (list || []).map((rw: any) => ({
                                                  id: rw.id,
                                                  name: rw.name,
                                                  maxShifts: rw.max_shifts ?? rw.maxShifts ?? 0,
                                                  roles: Array.isArray(rw.roles) ? rw.roles : [],
                                                  availability: rw.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
                                                }));
                                                setWorkers(mapped);
                                                setHiddenWorkerIds((prev) => prev.filter((id) => id !== w.id));
                                                break;
                                              }
                                              await new Promise((r) => setTimeout(r, 250));
                                            } catch {}
                                          }
                                          // Si, malgré tout, le backend renvoie encore l'élément, on le masque côté UI
                                          setHiddenWorkerIds((prev) => prev.filter((id) => id !== w.id));
                                        } catch (e: any) {
                                          // eslint-disable-next-line no-console
                                          console.log("[Planning] DELETE failed", e);
                                          // Vérifier l'état réel côté serveur: si l'élément n'existe plus, considérer la suppression comme réussie
                                          try {
                                            const list = await apiFetch<any[]>(`/director/sites/${params.id}/workers`, {
                                              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                                              cache: "no-store" as any,
                                            });
                                            const stillThere = (list || []).some((it: any) => Number(it?.id) === Number(w.id));
                                            // eslint-disable-next-line no-console
                                            console.log("[Planning] verify after failed DELETE, stillThere=", stillThere);
                                            if (!stillThere) {
                                              toast.success("העובד נמחק בהצלחה");
                                              setHiddenWorkerIds((prev) => prev.filter((id) => id !== w.id));
                                              return;
                                            }
                                          } catch (verifyErr) {
                                            // eslint-disable-next-line no-console
                                            console.log("[Planning] verify after delete error failed", verifyErr);
                                          }
                                          // Rollback si réellement non supprimé
                                          setWorkers(previousWorkers);
                                          toast.error("שגיאה במחיקה", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
                                        } finally {
                                          // eslint-disable-next-line no-console
                                          console.log("[Planning] delete done", w.id);
                                          setDeletingId(null);
                                        }
                                      }}
                                      disabled={deletingId === w.id}
                                      className="inline-flex items-center gap-1 rounded-md border border-red-600 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/40"
                                    >
                                      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden><path d="M6 7h12v2H6Zm2 4h8l-1 9H9ZM9 4h6v2H9Z"/></svg>
                                      מחק
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan={5} className="px-3 py-6 text-center text-zinc-500">אין עובדים</td>
                            </tr>
                          )}
                          </tbody>
                        </table>
                      </div>
                  </div>
                );
              })()}
            </section>
            {/* removed global summary here, kept only below the grids */}

            {/* Modal d'ajout d'employé */}
            {isAddModalOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                <div className="w-full max-w-3xl rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="relative mb-3 flex items-center justify-center">
                    <h3 className="text-lg font-semibold text-center">{editingWorkerId ? "עריכת עובד" : "הוספת עובד"}</h3>
                    <button
                      type="button"
                      onClick={() => setIsAddModalOpen(false)}
                      className="absolute right-2 top-1.5 rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-4 justify-items-center text-center">
                    <div>
                      <label className="block text-sm font-semibold">שם</label>
                      <input
                        type="text"
                        value={newWorkerName}
                        onChange={(e) => setNewWorkerName(e.target.value)}
                        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold">מקס' משמרות בשבוע</label>
                      <input
                        type="number"
                        min={0}
                        value={newWorkerMax}
                        onChange={(e) => setNewWorkerMax(Math.max(0, parseInt(e.target.value || "0", 10)))}
                        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <div className="block text-sm font-semibold mb-1">תפקידים</div>
                      <div className="flex flex-wrap justify-center gap-2 text-sm">
                        {allRoleNames.length === 0 ? (
                          <span className="text-zinc-500">אין תפקידים מוגדרים</span>
                        ) : (
                          allRoleNames.map((rn) => (
                            <label key={rn} className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={newWorkerRoles.includes(rn)}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setNewWorkerRoles((prev) => (checked ? [...prev, rn] : prev.filter((x) => x !== rn)));
                                }}
                              />
                              {rn}
                            </label>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 text-center">
                    <div className="block text-sm font-semibold mb-1">זמינות לפי יום/משמרת</div>
                    <div className="space-y-2">
                      {(() => {
                        const morningName = allShiftNames.find((sn) => /בוקר|^0?6|06-14/i.test(sn || ""));
                        const noonName = allShiftNames.find((sn) => /צהריים|14-22|^1?4/i.test(sn || ""));
                        const nightName = allShiftNames.find((sn) => /לילה|22-06|^2?2|night/i.test(sn || ""));
                        function isAllSelected(shiftName?: string) {
                          if (!shiftName) return false;
                          return dayDefs.every((d) => (newWorkerAvailability[d.key] || []).includes(shiftName));
                        }
                        function toggleAll(shiftName?: string, checked?: boolean) {
                          if (!shiftName) return;
                          setNewWorkerAvailability((prev) => {
                            const next: WorkerAvailability = { ...prev } as any;
                            for (const d of dayDefs) {
                              const cur = new Set(next[d.key] || []);
                              if (checked) {
                                cur.add(shiftName);
                              } else {
                                cur.delete(shiftName);
                              }
                              next[d.key] = Array.from(cur);
                            }
                            return next;
                          });
                        }
                        const morningAll = isAllSelected(morningName);
                        const noonAll = isAllSelected(noonName);
                        const nightAll = isAllSelected(nightName);
                        return (
                          <div className="mb-2 flex flex-wrap items-center justify-center gap-4 text-sm">
                            <label className="inline-flex items-center gap-2 opacity-100">
                              <input
                                type="checkbox"
                                disabled={!morningName}
                                checked={!!morningName && morningAll}
                                onChange={(e) => toggleAll(morningName, e.target.checked)}
                              />
                              כל הבוקר
                            </label>
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                disabled={!noonName}
                                checked={!!noonName && noonAll}
                                onChange={(e) => toggleAll(noonName, e.target.checked)}
                              />
                              כל הצהריים
                            </label>
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                disabled={!nightName}
                                checked={!!nightName && nightAll}
                                onChange={(e) => toggleAll(nightName, e.target.checked)}
                              />
                              כל הלילה
                            </label>
                          </div>
                        );
                      })()}
                      {dayDefs.map((d) => (
                        <div key={d.key} className="flex flex-wrap items-center justify-center gap-3 text-sm">
                          <div className="w-10 text-zinc-600 dark:text-zinc-300">{d.label}</div>
                          {allShiftNames.length === 0 ? (
                            <span className="text-zinc-500">אין משמרות פעילות</span>
                          ) : (
                            allShiftNames.map((sn) => (
                              <label key={sn} className="inline-flex items-center gap-1">
                                <input
                                  type="checkbox"
                                  checked={(newWorkerAvailability[d.key] || []).includes(sn)}
                                  onChange={() => toggleNewAvailability(d.key, sn)}
                                />
                                {sn}
                              </label>
                            ))
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsAddModalOpen(false)}
                      className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                      ביטול
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const trimmed = newWorkerName.trim();
                        if (!trimmed) return;
                        const DUP_MSG = "שם עובד כבר קיים באתר";
                        // eslint-disable-next-line no-console
                        console.log("[Workers] save clicked", { editingWorkerId, trimmed });
                        // Pré-vérification côté client pour éviter un aller-retour inutile
                        if (!editingWorkerId) {
                          // eslint-disable-next-line no-console
                          console.log("[Workers] checking duplicate (create)", { trimmed, workers });
                          if (workers.some((w) => (w.name || "").trim().toLowerCase() === trimmed.toLowerCase())) {
                            // eslint-disable-next-line no-console
                            console.log("[Workers] duplicate detected (create)");
                            toast.info(DUP_MSG);
                            return;
                          }
                        } else {
                          // eslint-disable-next-line no-console
                          console.log("[Workers] checking duplicate (update)", { editingWorkerId, trimmed, workers });
                          if (workers.some((w) => w.id !== editingWorkerId && (w.name || "").trim().toLowerCase() === trimmed.toLowerCase())) {
                            // eslint-disable-next-line no-console
                            console.log("[Workers] duplicate detected (update)");
                            toast.info(DUP_MSG);
                            return;
                          }
                        }
                        try {
                          if (editingWorkerId) {
                            // eslint-disable-next-line no-console
                            console.log("[Workers] calling API (PUT)");
                            const updated = await apiFetch<any>(`/director/sites/${params.id}/workers/${editingWorkerId}`, {
                              method: "PUT",
                              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                              body: JSON.stringify({
                                name: trimmed,
                                max_shifts: newWorkerMax,
                                roles: newWorkerRoles,
                                availability: newWorkerAvailability,
                              }),
                            });
                            // eslint-disable-next-line no-console
                            console.log("[Workers] API ok (PUT)", updated);
                            const mapped: Worker = {
                              id: updated.id,
                              name: updated.name,
                              maxShifts: updated.max_shifts ?? updated.maxShifts ?? 0,
                              roles: Array.isArray(updated.roles) ? updated.roles : [],
                              availability: updated.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
                            };
                            setWorkers((prev) => prev.map((x) => (x.id === editingWorkerId ? mapped : x)));
                            toast.success("עובד עודכן בהצלחה!");
                          } else {
                            // eslint-disable-next-line no-console
                            console.log("[Workers] calling API (POST)");
                            const created = await apiFetch<any>(`/director/sites/${params.id}/workers`, {
                              method: "POST",
                              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                              body: JSON.stringify({
                                name: trimmed,
                                max_shifts: newWorkerMax,
                                roles: newWorkerRoles,
                                availability: newWorkerAvailability,
                              }),
                            });
                            // eslint-disable-next-line no-console
                            console.log("[Workers] API ok (POST)", created);
                            const mapped: Worker = {
                              id: created.id,
                              name: created.name,
                              maxShifts: created.max_shifts ?? created.maxShifts ?? 0,
                              roles: Array.isArray(created.roles) ? created.roles : [],
                              availability: created.availability || { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
                            };
                            setWorkers((prev) => [...prev, mapped]);
                            toast.success("עובד נוסף בהצלחה!");
                          }
                          setEditingWorkerId(null);
                          setNewWorkerName("");
                          setNewWorkerMax(5);
                          setNewWorkerRoles([]);
                          setNewWorkerAvailability({ sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });
                          setIsAddModalOpen(false);
                        } catch (e: any) {
                          const msg = String(e?.message || "");
                          // eslint-disable-next-line no-console
                          console.log("[Workers] save error", { status: e?.status, message: msg, raw: e });
                          if ((e?.status === 400 && msg.includes(DUP_MSG)) || msg.includes(DUP_MSG)) {
                            // eslint-disable-next-line no-console
                            console.log("[Workers] duplicate detected (backend)");
                            toast.info(DUP_MSG);
                            return;
                          }
                          toast.error("שמירה נכשלה", { description: msg || "נסה שוב מאוחר יותר." });
                        }
                      }}
                      className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6]"
                    >
                      שמור
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Grilles hebdomadaires par עמדה */}
            <section className="space-y-4">
              <h2 className="text-lg font-semibold text-center">
                גריד שבועי לפי עמדה
              </h2>
              <div className="flex items-center justify-center gap-3 text-sm text-zinc-600 dark:text-zinc-300">
                <button
                  type="button"
                  aria-label="שבוע קודם"
                  onClick={() => setWeekStart((prev) => addDays(prev, -7))}
                  className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
                </button>
                <span>
                  {(() => {
                    const end = addDays(weekStart, 6);
                    return `שבוע: ${formatHebDate(weekStart)} — ${formatHebDate(end)}`;
                  })()}
                </span>
                <button
                  type="button"
                  aria-label="שבוע הבא"
                  onClick={() => setWeekStart((prev) => addDays(prev, 7))}
                  className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                </button>
              </div>
              {(() => {
                const dayCols = [
                  { key: "sun", label: "א'" },
                  { key: "mon", label: "ב'" },
                  { key: "tue", label: "ג'" },
                  { key: "wed", label: "ד'" },
                  { key: "thu", label: "ה'" },
                  { key: "fri", label: "ו'" },
                  { key: "sat", label: "ש'" },
                ];
                function getRequiredFor(st: any, shiftName: string, dayKey: string): number {
                  if (!st) return 0;
                  // Mode personnalisation par jour
                  if (st.perDayCustom) {
                    const dayCfg = st.dayOverrides?.[dayKey];
                    if (!dayCfg || dayCfg.active === false) return 0;
                    if (st.uniformRoles) {
                      // En mode uniforme, le nombre d'employés requis est celui défini pour l'עמדה
                      return Number(st.workers || 0);
                    }
                    const sh = (dayCfg.shifts || []).find((x: any) => x?.name === shiftName);
                    if (!sh || !sh.enabled) return 0;
                    return Number(sh.workers || 0);
                  }
                  // Mode global (pas par jour)
                  if (st.days && st.days[dayKey] === false) return 0;
                  if (st.uniformRoles) {
                    return Number(st.workers || 0);
                  }
                  const sh = (st.shifts || []).find((x: any) => x?.name === shiftName);
                  if (!sh || !sh.enabled) return 0;
                  return Number(sh.workers || 0);
                }
                function isDayActive(st: any, dayKey: string): boolean {
                  if (!st) return false;
                  if (st.perDayCustom) {
                    const dayCfg = st.dayOverrides?.[dayKey];
                    return !!(dayCfg && dayCfg.active);
                  }
                  if (st.days && Object.prototype.hasOwnProperty.call(st.days, dayKey)) {
                    return st.days[dayKey] !== false;
                  }
                  return true; // par défaut actif si non précisé
                }
                const shiftNamesAll: string[] = Array.from(
                  new Set(
                    (site?.config?.stations || [])
                      .flatMap((st: any) => (st?.shifts || [])
                        .filter((sh: any) => sh?.enabled)
                        .map((sh: any) => sh?.name))
                      .filter(Boolean)
                  )
                );
                function hoursOf(sn: string): string | null {
                  const s = String(sn || "");
                  // direct numeric pattern like 06-14 or 14:22
                  const m = s.match(/(\d{1,2})\s*[-:–]\s*(\d{1,2})/);
                  if (m) {
                    const a = m[1].padStart(2, "0");
                    const b = m[2].padStart(2, "0");
                    return `${a}–${b}`;
                  }
                  // Hebrew/english names
                  if (/בוקר/i.test(s)) return "06–14";
                  if (/צהר(יים|י)ם?/i.test(s)) return "14–22";
                  if (/לילה|night/i.test(s)) return "22–06";
                  return null;
                }
                function hoursFromConfig(station: any, shiftName: string): string | null {
                  if (!station) return null;
                  function fmt(start?: string, end?: string): string | null {
                    if (!start || !end) return null;
                    return `${start}–${end}`;
                  }
                  if (station.perDayCustom && station.dayOverrides) {
                    const order = ["sun","mon","tue","wed","thu","fri","sat"];
                    for (const key of order) {
                      const dcfg = station.dayOverrides?.[key];
                      if (!dcfg || dcfg.active === false) continue;
                      const sh = (dcfg.shifts || []).find((x: any) => x?.name === shiftName);
                      const f = fmt(sh?.start, sh?.end);
                      if (f) return f;
                    }
                  }
                  const base = (station.shifts || []).find((x: any) => x?.name === shiftName);
                  return fmt(base?.start, base?.end);
                }
                return (
                  <div className="space-y-6">
                    {(site?.config?.stations || []).map((st: any, idx: number) => (
                      <div key={idx} className="rounded-xl border p-3 dark:border-zinc-800">
                        <div className="mb-2 text-base font-medium">{st.name}</div>
                        <div className="overflow-x-auto">
                          <table className="w-full border-collapse text-sm table-fixed">
                            <thead>
                              <tr className="border-b dark:border-zinc-800">
                                <th className="px-2 py-2 text-right align-bottom w-28">משמרת</th>
                                {dayCols.map((d, i) => {
                                  const date = addDays(weekStart, i);
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
                                    {dayCols.map((d) => {
                                      const required = getRequiredFor(st, sn, d.key);
                                      const assignedNames: string[] = (() => {
                                        if (!aiPlan) return [];
                                        const cell = aiPlan.assignments?.[d.key]?.[sn]?.[idx];
                                        if (!cell) return [];
                                        return cell;
                                      })();
                                      const activeDay = isDayActive(st, d.key);
                                      return (
                                        <td
                                          key={d.key}
                                          className={
                                            "px-2 py-2 text-center " +
                                            (enabled ? "" : "text-zinc-400 ") +
                                            (!activeDay ? "bg-zinc-100 text-zinc-400 dark:bg-zinc-900/40 " : "")
                                          }
                                        >
                                        {enabled ? (
                                            <div className="flex flex-col items-center">
                                              {aiPlan && required > 0 ? (
                                                <div className="mb-1 flex flex-col items-center gap-1">
                                                  {(() => {
                                                    const numEmpty = Math.max(0, required - assignedNames.length);
                                                    return (
                                                      <>
                                                        {Array.from({ length: numEmpty }).map((_, i) => (
                                                          <span
                                                            key={"empty-" + i}
                                                            className="inline-flex h-7 min-w-[2.5rem] items-center justify-center rounded-full border px-2 py-0.5 text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700"
                                                          >
                                                            —
                                                          </span>
                                                        ))}
                                                        {assignedNames.map((nm, i) => {
                                                          const c = colorForName(nm);
                                                          return (
                                                            <span
                                                              key={"nm-" + i}
                                                              className="inline-flex items-center rounded-full border px-3 py-1 text-sm shadow-sm"
                                                              style={{ backgroundColor: c.bg, borderColor: c.border, color: c.text }}
                                                            >
                                                              {nm}
                                                            </span>
                                                          );
                                                        })}
                                                      </>
                                                    );
                                                  })()}
                                                </div>
                                              ) : null}
                                              <span className={
                                                "text-xs " + (
                                                  aiPlan && assignedNames.length < required
                                                    ? "text-red-600 dark:text-red-400"
                                                    : (aiPlan && required > 0 && assignedNames.length >= required
                                                        ? "text-green-600 dark:text-green-400"
                                                        : "")
                                                )
                                              }>
                                                {"שיבוצים: "}{aiPlan ? assignedNames.length : 0}
                                              </span>
                                              <span className="text-xs text-zinc-500">נדרש: {required}</span>
                                          </div>
                                        ) : (
                                          <span className="text-xs">לא פעיל</span>
                                        )}
                                      </td>
                                      );
                                    })}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                    {/* per-station summary removed; replaced by global summary below */}
                      </div>
                    ))}
                  </div>
                );
              })()}
              {aiPlan && (
                <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
                  <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">סיכום שיבוצים לעמדה (כל העמדות)</div>
                  {(() => {
                    const counts = new Map<string, number>();
                    const days = Object.keys(aiPlan.assignments || {});
                    for (const dKey of days) {
                      const shiftsMap = (aiPlan.assignments as any)[dKey] || {};
                      for (const sn of Object.keys(shiftsMap)) {
                        const perStation: string[][] = shiftsMap[sn] || [];
                        for (const namesHere of perStation) {
                          for (const nm of (namesHere || [])) {
                            counts.set(nm, (counts.get(nm) || 0) + 1);
                          }
                        }
                      }
                    }
                    // Ordre stable: suivre l'ordre d'apparition dans la liste 'workers'
                    const order = new Map<string, number>();
                    workers.forEach((w, i) => order.set(w.name, i));
                    const items = Array.from(counts.entries())
                      .filter(([, c]) => c > 0)
                      .sort((a, b) => {
                        const ia = order.has(a[0]) ? (order.get(a[0]) as number) : Number.MAX_SAFE_INTEGER;
                        const ib = order.has(b[0]) ? (order.get(b[0]) as number) : Number.MAX_SAFE_INTEGER;
                        if (ia !== ib) return ia - ib;
                        return a[0].localeCompare(b[0]);
                      });
                    if (items.length === 0) {
                      return <div className="text-sm text-zinc-500">אין שיבוצים</div>;
                    }
                    return (
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm">
                          <thead>
                            <tr className="border-b dark:border-zinc-800">
                              <th className="px-2 py-2 text-right">עובד</th>
                              <th className="px-2 py-2 text-right">מס' משמרות</th>
                            </tr>
                          </thead>
                          <tbody>
                            {items.map(([nm, c]) => {
                              const col = colorForName(nm);
                              return (
                                <tr key={nm} className="border-b last:border-0 dark:border-zinc-800">
                                  <td className="px-2 py-2">
                                    <span className="inline-flex items-center rounded-full border px-3 py-1 text-sm shadow-sm" style={{ backgroundColor: col.bg, borderColor: col.border, color: col.text }}>
                                      {nm}
                                    </span>
                                  </td>
                                  <td className="px-2 py-2">{c}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    );
                  })()}
                </div>
              )}
              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      setAiLoading(true);
                      setAiPlan(null);
                      baseAssignmentsRef.current = null;
                      setAltIndex(0);
                      const resp = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/director/sites/${params.id}/ai-generate/stream`, {
                        method: "POST",
                        headers: {
                          Authorization: `Bearer ${localStorage.getItem("access_token")}`,
                          Accept: "text/event-stream",
                          "Content-Type": "application/json",
                        },
                        body: JSON.stringify({ num_alternatives: 500 }),
                      });
                      if (!resp.ok || !resp.body) {
                        throw new Error(`HTTP ${resp.status}`);
                      }
                      const reader = resp.body.getReader();
                      const decoder = new TextDecoder("utf-8");
                      let buffer = "";
                      // eslint-disable-next-line no-constant-condition
                      while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        let idx;
                        while ((idx = buffer.indexOf("\n\n")) !== -1) {
                          const frame = buffer.slice(0, idx).trim();
                          buffer = buffer.slice(idx + 2);
                          if (!frame.startsWith("data:")) continue;
                          try {
                            const jsonStr = frame.replace(/^data:\s*/, "");
                            const evt = JSON.parse(jsonStr);
                            if (evt?.type === "base") {
                              setAiPlan({
                                days: evt.days,
                                shifts: evt.shifts,
                                stations: evt.stations,
                                assignments: evt.assignments,
                                alternatives: [],
                                status: "STREAMING",
                                objective: 0,
                              } as any);
                              baseAssignmentsRef.current = evt.assignments;
                              toast.success("תכנון בסיסי מוכן");
                            } else if (evt?.type === "alternative") {
                              setAiPlan((prev) => {
                                if (!prev) return prev;
                                const alts = Array.isArray(prev.alternatives) ? prev.alternatives : [];
                                const next = { ...prev, alternatives: [...alts, evt.assignments] } as any;
                                // eslint-disable-next-line no-console
                                console.log("[AI][SSE] alternatives count:", next.alternatives.length);
                                return next;
                              });
                            } else if (evt?.type === "status") {
                              // eslint-disable-next-line no-console
                              console.log("[AI][SSE] status", evt);
                            } else if (evt?.type === "done") {
                              // eslint-disable-next-line no-console
                              console.log("[AI][SSE] done");
                            }
                          } catch (e) {
                            // eslint-disable-next-line no-console
                            console.log("[AI][SSE] parse error", e);
                          }
                        }
                      }
                    } catch (e: any) {
                      toast.error("יצירת תכנון נכשלה", { description: String(e?.message || "נסה שוב מאוחר יותר.") });
                    } finally {
                      setAiLoading(false);
                    }
                  }}
                  className="inline-flex items-center rounded-md bg-[#00A8E0] px-6 py-2 text-white hover:bg-[#0092c6] disabled:opacity-60"
                  disabled={aiLoading}
                >
                  {aiLoading ? "יוצר..." : "יצירת תכנון"}
                </button>
                {aiPlan && (
                  <div className="mt-3 flex items-center justify-center gap-2 text-sm">
                    {(() => {
                      const alts = aiPlan?.alternatives || [];
                      const total = 1 + (alts?.length || 0);
                      return (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              const next = (altIndex + 1) % total;
                              setAltIndex(next);
                              if (next === 0) {
                                setAiPlan((prev) => (prev ? { ...prev, assignments: baseAssignmentsRef.current || prev.assignments } : prev));
                              } else {
                                const alt = alts[next - 1];
                                setAiPlan((prev) => (prev ? { ...prev, assignments: alt } : prev));
                              }
                            }}
                            disabled={total <= 1}
                            className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          >
                            חלופה →
                          </button>
                          <span>
                            {altIndex + 1} / {total}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const next = (altIndex - 1 + total) % total;
                              setAltIndex(next);
                              if (next === 0) {
                                setAiPlan((prev) => (prev ? { ...prev, assignments: baseAssignmentsRef.current || prev.assignments } : prev));
                              } else {
                                const alt = alts[next - 1];
                                setAiPlan((prev) => (prev ? { ...prev, assignments: alt } : prev));
                              }
                            }}
                            disabled={total <= 1}
                            className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          >
                            ← חלופה
                          </button>
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}



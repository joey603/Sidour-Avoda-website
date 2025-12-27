"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import { apiFetch } from "@/lib/api";

export default function NewSitePage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [numStations, setNumStations] = useState<number>(1);
  type StationRole = { name: string; enabled: boolean; count: number };
  type StationShift = { name: string; enabled: boolean; start: string; end: string; workers: number; roles: StationRole[] };
  type StationDays = Record<string, boolean>;
  type QuestionType = "text" | "dropdown" | "yesno" | "slider";
  type SiteQuestion = {
    id: string;
    label: string;
    type: QuestionType;
    perDay?: boolean; // poser la question pour chaque jour
    options?: string[]; // dropdown
    slider?: { min: number; max: number; step: number }; // slider
  };
  type Station = {
    name: string;
    workers: number;
    roles: StationRole[];
    days: StationDays;
    shifts: StationShift[];
    uniformRoles: boolean;
    showDetails: boolean;
    perDayCustom?: boolean;
    dayOverrides?: Record<string, { active: boolean; shifts: StationShift[] }>;
  };
  const defaultRoles: StationRole[] = [
    { name: "חמוש", enabled: false, count: 1 },
    { name: "אחמש", enabled: false, count: 1 },
  ];
  const defaultStationDays: StationDays = {
    sun: true,
    mon: true,
    tue: true,
    wed: true,
    thu: true,
    fri: true,
    sat: true,
  };
  function buildDefaultStationShifts(roles: StationRole[]): StationShift[] {
    const base: Array<{ name: string; start: string; end: string }> = [
      { name: "בוקר", start: "07:00", end: "15:00" },
      { name: "צהריים", start: "15:00", end: "23:00" },
      { name: "לילה", start: "23:00", end: "07:00" },
    ];
    return base.map((b) => ({ name: b.name, enabled: true, start: b.start, end: b.end, workers: 0, roles: JSON.parse(JSON.stringify(roles)) }));
  }

  function buildDefaultDayOverrides(roles: StationRole[]): Record<string, { active: boolean; shifts: StationShift[] }> {
    const keys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const obj: Record<string, { active: boolean; shifts: StationShift[] }> = {};
    for (const k of keys) obj[k] = { active: true, shifts: buildDefaultStationShifts(JSON.parse(JSON.stringify(roles))) };
    return obj;
  }

  
  const [stations, setStations] = useState<Station[]>([{
    name: "עמדה 1",
    workers: 1,
    roles: JSON.parse(JSON.stringify(defaultRoles)),
    days: { ...defaultStationDays },
    shifts: buildDefaultStationShifts(JSON.parse(JSON.stringify(defaultRoles))),
    uniformRoles: true,
    showDetails: true,
    perDayCustom: false,
    dayOverrides: buildDefaultDayOverrides(JSON.parse(JSON.stringify(defaultRoles))),
  }]);
  
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [questions, setQuestions] = useState<SiteQuestion[]>([]);

  function newId(): string {
    try {
      if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    } catch {}
    return `q_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  useEffect(() => {
    fetchMe().then((me) => {
      if (!me) return router.replace("/login/director");
      if (me.role !== "director") return router.replace("/worker");
    });
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const created = await apiFetch<{ id: number }>("/director/sites/", {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        body: JSON.stringify({
          name: name.trim(),
          config: {
            stations,
            questions,
          },
        }),
      });
      if (created && created.id) {
        // Vérifie que le site est accessible avant redirection (éventuelle latence DB)
        let ok = false;
        for (let i = 0; i < 3; i++) {
          try {
            await apiFetch(`/director/sites/${created.id}`, {
              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
              cache: "no-store" as any,
            });
            ok = true;
            break;
          } catch (e) {
            await new Promise((r) => setTimeout(r, 300));
          }
        }
        router.replace(`/director/planning/${created.id}`);
      } else {
        router.replace("/director");
      }
    } catch (e: any) {
      setError("שגיאה ביצירת אתר");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto relative max-w-4xl rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="חזרה"
          className="absolute left-3 top-3 inline-flex items-center rounded-md border px-2.5 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path d="M14 6l-6 6 6 6V6z" />
          </svg>
        </button>
        <h1 className="mb-6 text-2xl font-semibold">הוספת אתר</h1>
        <form onSubmit={onSubmit} className="space-y-6">
          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-sm font-semibold">שם אתר</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                required
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-semibold">מספר עמדות</label>
              <input
                type="number"
                min={0}
                value={numStations}
                onChange={(e) => {
                  const n = Math.max(0, parseInt(e.target.value || "0", 10));
                  setNumStations(n);
                  setStations((prev) => {
                    const next = [...prev];
                    if (n > next.length) {
                      for (let i = next.length; i < n; i++) next.push({
                        name: `עמדה ${i + 1}`,
                        workers: 1,
                        roles: JSON.parse(JSON.stringify(defaultRoles)),
                        days: { ...defaultStationDays },
                        shifts: buildDefaultStationShifts(JSON.parse(JSON.stringify(defaultRoles))),
                        uniformRoles: true,
                        showDetails: true,
                        perDayCustom: false,
                        dayOverrides: buildDefaultDayOverrides(JSON.parse(JSON.stringify(defaultRoles))),
                      });
                    } else if (n < next.length) {
                      next.length = n;
                    }
                    return next;
                  });
                }}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              />
            </div>
          </section>

          {stations.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">פרטי עמדות</h2>
              <div className="space-y-3">
                {stations.map((st, idx) => (
                  <div key={idx} className="rounded-md border p-3 space-y-3 dark:border-zinc-700">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div>
                        <label className="block text-sm font-semibold">שם עמדה #{idx + 1}</label>
                        <input
                          type="text"
                          value={st.name}
                          onChange={(e) => {
                            const v = e.target.value;
                            setStations((prev) => prev.map((x, i) => (i === idx ? { ...x, name: v } : x)));
                          }}
                          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                        />
                      </div>
                      {st.uniformRoles && (
                        <div>
                          <label className="block text-sm font-semibold">מספר עובדים לעמדה #{idx + 1}</label>
                          <input
                            type="number"
                            min={0}
                            value={st.workers}
                            onChange={(e) => {
                              const v = Math.max(0, parseInt(e.target.value || "0", 10));
                              setStations((prev) => prev.map((x, i) => {
                                if (i !== idx) return x;
                                const clampedRoles = x.roles.map((r) => ({ ...r, count: Math.min(r.count, v) }));
                                const clampedShiftRoles = x.shifts.map((s) => ({
                                  ...s,
                                  roles: s.roles.map((r) => ({ ...r, count: Math.min(r.count, v) })),
                                }));
                                return { ...x, workers: v, roles: clampedRoles, shifts: clampedShiftRoles };
                              }));
                            }}
                            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                          />
                        </div>
                      )}
                    </div>
                    <div className="space-y-3">
                        <div className="flex items-center gap-4 text-sm">
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="radio"
                              name={`uniform-${idx}`}
                              checked={st.uniformRoles}
                              onChange={() => {
                                setStations((prev) => prev.map((x, i) => {
                                  if (i !== idx) return x;
                                  const syncedShifts = x.shifts.map((ss) => ({
                                    ...ss,
                                    roles: x.roles.map((r) => ({ ...r })),
                                  }));
                                  return { ...x, uniformRoles: true, shifts: syncedShifts };
                                }));
                              }}
                            />
                            אחידות לכל המשמרות
                          </label>
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="radio"
                              name={`uniform-${idx}`}
                              checked={!st.uniformRoles}
                              onChange={() => {
                                setStations((prev) => prev.map((x, i) => (i === idx ? { ...x, uniformRoles: false } : x)));
                              }}
                            />
                            התאמה לפי משמרת
                          </label>
                          <button
                            type="button"
                            onClick={() => {
                              setStations((prev) => prev.map((x, i) => (i === idx ? { ...x, showDetails: !x.showDetails } : x)));
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          >
                            {st.showDetails ? (
                              <>
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7 14l5-5 5 5H7z"/></svg>
                                הסתר פרטים
                              </>
                            ) : (
                              <>
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7 10l5 5 5-5H7z"/></svg>
                                הצג פרטים
                              </>
                            )}
                          </button>
                        </div>

                        {st.showDetails && (
                          <>
                      
                      
                      <div className="rounded-md border p-3 space-y-3 dark:border-zinc-700">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">תפקידים</span>
                          <button
                            type="button"
                            onClick={() => {
                              const value = typeof window !== "undefined" ? window.prompt("שם תפקיד") : null;
                              const trimmed = (value || "").trim();
                              if (!trimmed) return;
                              setStations((prev) => prev.map((x, i) => (i === idx ? {
                                ...x,
                                roles: [...x.roles, { name: trimmed, enabled: false, count: 0 }],
                                shifts: x.shifts.map((ss) => ({
                                  ...ss,
                                  roles: [...ss.roles, { name: trimmed, enabled: false, count: 0 }],
                                })),
                              } : x)));
                            }}
                            className="inline-flex items-center gap-2 rounded-md border border-green-600 px-3 py-1.5 text-sm text-green-600 hover:bg-green-50 dark:border-green-500 dark:text-green-400 dark:hover:bg-green-900/30"
                          >
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>
                            הוסף תפקיד
                          </button>
                        </div>
                        {st.uniformRoles ? (
                          <div className="space-y-2">
                            {st.roles.map((role, rIdx) => (
                              <div key={rIdx} className="grid grid-cols-1 gap-3 md:grid-cols-3 items-center">
                                <div className="text-sm font-medium">{role.name}</div>
                                <label className="inline-flex items-center">
                                  <span className="relative inline-block h-5 w-9">
                                    <input
                                      type="checkbox"
                                      checked={role.enabled}
                                      onChange={(e) => {
                                        const checked = e.target.checked;
                                        setStations((prev) => prev.map((x, i) => {
                                          if (i !== idx) return x;
                                          const roles = x.roles.map((rr, j) => (j === rIdx ? { ...rr, enabled: checked, count: checked ? rr.count : 0 } : rr));
                                          const shifts = x.shifts.map((ss) => ({
                                            ...ss,
                                            roles: ss.roles.map((rr, j) => (j === rIdx ? { ...rr, enabled: checked, count: checked ? rr.count : 0 } : rr)),
                                          }));
                                          return { ...x, roles, shifts };
                                        }));
                                      }}
                                      className="sr-only peer"
                                      aria-label="הפעל תפקיד"
                                    />
                                    <span className="absolute inset-0 rounded-full bg-zinc-300 peer-checked:bg-[#00A8E0] transition-colors" />
                                    <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform translate-x-4 peer-checked:translate-x-0" />
                                  </span>
                                </label>
                                {role.enabled && (
                                  <input
                                    type="number"
                                    min={0}
                                    max={st.workers}
                                    value={role.count}
                                    onChange={(e) => {
                                      const val = Math.max(0, Math.min(st.workers, parseInt(e.target.value || "0", 10)));
                                      setStations((prev) => prev.map((x, i) => {
                                        if (i !== idx) return x;
                                        const roles = x.roles.map((rr, j) => (j === rIdx ? { ...rr, count: val } : rr));
                                        const shifts = x.shifts.map((ss) => ({
                                          ...ss,
                                          roles: ss.roles.map((rr, j) => (j === rIdx ? { ...rr, count: val } : rr)),
                                        }));
                                        return { ...x, roles, shifts };
                                      }));
                                    }}
                                    className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                    placeholder="כמות לעמדה"
                                  />
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {st.roles.map((role, rIdx) => (
                              <span
                                key={rIdx}
                                className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm dark:border-zinc-700"
                              >
                                {role.name}
                                <button
                                  type="button"
                                  aria-label="הסר תפקיד"
                                  onClick={() => {
                                    setStations((prev) => prev.map((x, i) => {
                                      if (i !== idx) return x;
                                      const removedName = x.roles[rIdx]?.name;
                                      const roles = x.roles.filter((_, j) => j !== rIdx);
                                      const shifts = x.shifts.map((ss) => ({
                                        ...ss,
                                        roles: ss.roles.filter((rr) => rr.name !== removedName),
                                      }));
                                      return { ...x, roles, shifts };
                                    }));
                                  }}
                                  className="rounded-full border px-2 py-0.5 text-xs hover:bg-red-100 hover:text-red-800 dark:hover:bg-red-900 dark:hover:text-red-200"
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                          </>
                        )}
                    </div>
                    
                    {st.showDetails && (
                    <div className="md:col-span-2">
                      {!st.perDayCustom ? (
                        <div className="rounded-md border p-3 space-y-2 dark:border-zinc-700">
                          <div className="flex items-center justify-between">
                            <label className="block text-sm font-semibold">ימים פעילים (עמדה)</label>
                            <label className="inline-flex items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={!!st.perDayCustom}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setStations((prev) => prev.map((x, i) => (i === idx ? { ...x, perDayCustom: checked } : x)));
                                }}
                              />
                              התאמה לפי ימים
                            </label>
                          </div>
                          <div className="flex flex-wrap gap-3 text-sm">
                            {[
                              { key: "sun", label: "א'" },
                              { key: "mon", label: "ב'" },
                              { key: "tue", label: "ג'" },
                              { key: "wed", label: "ד'" },
                              { key: "thu", label: "ה'" },
                              { key: "fri", label: "ו'" },
                              { key: "sat", label: "ש'" },
                            ].map((d) => (
                              <label key={d.key} className="inline-flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={!!st.days?.[d.key]}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    setStations((prev) => prev.map((x, i) => (i === idx ? { ...x, days: { ...x.days, [d.key]: checked } } : x)));
                                  }}
                                />
                                {d.label}
                              </label>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between mb-1">
                          <label className="block text-sm font-semibold">ימים פעילים (עמדה)</label>
                          <label className="inline-flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={!!st.perDayCustom}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setStations((prev) => prev.map((x, i) => (i === idx ? { ...x, perDayCustom: checked } : x)));
                              }}
                            />
                            התאמה לפי ימים
                          </label>
                        </div>
                      )}
                    </div>
                    )}
                    {st.showDetails && (
                    <div className="md:col-span-2 space-y-2">
                      {!st.perDayCustom ? (
                        <div className="rounded-md border p-3 space-y-3 dark:border-zinc-700">
                          <div className="flex items-center justify-between">
                            <label className="block text-sm font-semibold">משמרות (עמדה)</label>
                          </div>
                          {st.shifts.map((sh, sIdx) => (
                          <div key={sIdx} className="grid grid-cols-1 gap-3 md:grid-cols-4 items-center">
                            <div className="text-sm font-medium">{sh.name}</div>
                            <label className="inline-flex items-center">
                              <span className="relative inline-block h-5 w-9">
                                <input
                                  type="checkbox"
                                  checked={sh.enabled}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    setStations((prev) => prev.map((x, i) => {
                                      if (i !== idx) return x;
                                      const shifts = x.shifts.map((ss, j) => (j === sIdx ? { ...ss, enabled: checked } : ss));
                                      return { ...x, shifts };
                                    }));
                                  }}
                                  className="sr-only peer"
                                  aria-label="הפעל משמרת"
                                />
                                <span className="absolute inset-0 rounded-full bg-zinc-300 peer-checked:bg-[#00A8E0] transition-colors" />
                                <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform translate-x-4 peer-checked:translate-x-0" />
                              </span>
                            </label>
                            {sh.enabled ? (
                              <>
                                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                  <div>
                                    <label className="block text-xs text-zinc-600 dark:text-zinc-300 mb-1">שעת התחלה</label>
                                    <input
                                      type="time"
                                      dir="ltr"
                                      value={sh.start}
                                      onChange={(e) => {
                                        const v = e.target.value;
                                        setStations((prev) => prev.map((x, i) => {
                                          if (i !== idx) return x;
                                          const shifts = x.shifts.map((ss, j) => {
                                            if (j !== sIdx) return ss;
                                            return { ...ss, start: v };
                                          });
                                          return { ...x, shifts };
                                        }));
                                      }}
                                      className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-xs text-zinc-600 dark:text-zinc-300 mb-1">שעת סיום</label>
                                    <input
                                      type="time"
                                      dir="ltr"
                                      value={sh.end}
                                      onChange={(e) => {
                                        const v = e.target.value;
                                        setStations((prev) => prev.map((x, i) => {
                                          if (i !== idx) return x;
                                          const isMorning = (name: string) => /בוקר/i.test(name) || /morning/i.test(name);
                                          const isNoon = (name: string) => /צהר(יים|י)ם?/i.test(name) || /noon|afternoon/i.test(name);
                                          const updated = x.shifts.map((ss, j) => (j === sIdx ? { ...ss, end: v } : ss));
                                          if (isMorning(x.shifts[sIdx]?.name)) {
                                            const noonIdx = updated.findIndex((u) => isNoon(u.name));
                                            if (noonIdx !== -1) updated[noonIdx] = { ...updated[noonIdx], start: v };
                                          }
                                          return { ...x, shifts: updated };
                                        }));
                                      }}
                                      className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                    />
                                  </div>
                                </div>
                                {!st.uniformRoles && (
                                  <div className="md:col-span-4 grid grid-cols-1 gap-3 md:grid-cols-3 items-center">
                                    <div className="text-sm font-medium">מספר עובדים למשמרת</div>
                                    <input
                                      type="number"
                                      min={0}
                                      value={sh.workers}
                                      onChange={(e) => {
                                        const val = Math.max(0, parseInt(e.target.value || "0", 10));
                                        setStations((prev) => prev.map((x, i) => {
                                          if (i !== idx) return x;
                                          const shifts = x.shifts.map((ss, j) => {
                                            if (j !== sIdx) return ss;
                                            const clampedRoles = ss.roles.map((rr) => ({ ...rr, count: Math.min(rr.count, val) }));
                                            return { ...ss, workers: val, roles: clampedRoles };
                                          });
                                          return { ...x, shifts };
                                        }));
                                      }}
                                      className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                    />
                                  </div>
                                )}
                                <div className="md:col-span-4 space-y-2">
                                  <div className="text-sm font-medium">תפקידים למשמרת</div>
                                  {st.uniformRoles ? (
                                    <div className="flex flex-wrap gap-2 text-sm">
                                      {st.roles.filter((r) => r.enabled).map((r, i2) => (
                                        <span key={i2} className="rounded-full border px-3 py-1 dark:border-zinc-700">
                                          {r.name}{r.count ? ` · ${r.count}` : ""}
                                        </span>
                                      ))}
                                      {st.roles.every((r) => !r.enabled) && (
                                        <span className="text-zinc-500">אין תפקידים פעילים</span>
                                      )}
                                    </div>
                                  ) : (
                                    <div className="space-y-2">
                                      {sh.roles.map((sr, rj) => (
                                        <div key={rj} className="grid grid-cols-1 gap-3 md:grid-cols-3 items-center">
                                          <div className="text-sm">{sr.name}</div>
                                          <label className="inline-flex items-center">
                                            <span className="relative inline-block h-5 w-9">
                                              <input
                                                type="checkbox"
                                                checked={sr.enabled}
                                                onChange={(e) => {
                                                  const checked = e.target.checked;
                                                  setStations((prev) => prev.map((x, i) => {
                                                    if (i !== idx) return x;
                                                    const shifts = x.shifts.map((ss, j) => (j === sIdx ? {
                                                      ...ss,
                                                      roles: ss.roles.map((rr, k) => (k === rj ? { ...rr, enabled: checked, count: checked ? rr.count : 0 } : rr)),
                                                    } : ss));
                                                    return { ...x, shifts };
                                                  }));
                                                }}
                                                className="sr-only peer"
                                                aria-label="הפעל תפקיד למשמרת"
                                              />
                                              <span className="absolute inset-0 rounded-full bg-zinc-300 peer-checked:bg-[#00A8E0] transition-colors" />
                                              <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform translate-x-4 peer-checked:translate-x-0" />
                                            </span>
                                          </label>
                                          {sr.enabled && (
                                            <input
                                              type="number"
                                              min={0}
                                              max={st.uniformRoles ? st.workers : sh.workers}
                                              value={sr.count}
                                              onChange={(e) => {
                                                const limit = st.uniformRoles ? st.workers : sh.workers;
                                                const val = Math.max(0, Math.min(limit, parseInt(e.target.value || "0", 10)));
                                                setStations((prev) => prev.map((x, i) => {
                                                  if (i !== idx) return x;
                                                  const shifts = x.shifts.map((ss, j) => (j === sIdx ? {
                                                    ...ss,
                                                    roles: ss.roles.map((rr, k) => (k === rj ? { ...rr, count: val } : rr)),
                                                  } : ss));
                                                  return { ...x, shifts };
                                                }));
                                              }}
                                              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                              placeholder="כמות למשמרת"
                                            />
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </>
                            ) : (
                              <div className="md:col-span-2 text-sm text-zinc-500">לא פעיל</div>
                            )}
                          </div>
                          ))}
                        </div>
                      ) : (
                        <div className="space-y-4">
                          {[
                            { key: "sun", label: "א'" },
                            { key: "mon", label: "ב'" },
                            { key: "tue", label: "ג'" },
                            { key: "wed", label: "ד'" },
                            { key: "thu", label: "ה'" },
                            { key: "fri", label: "ו'" },
                            { key: "sat", label: "ש'" },
                          ].map((d) => {
                            const dayCfg = st.dayOverrides?.[d.key] || { active: true, shifts: buildDefaultStationShifts(JSON.parse(JSON.stringify(st.roles))) };
                            return (
                              <div key={d.key} className="space-y-2 rounded-md border p-2 dark:border-zinc-700">
                                <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium">{d.label}</span>
                                  <label className="inline-flex items-center gap-2 text-xs">
                                    <input
                                      type="checkbox"
                                      checked={dayCfg.active}
                                      onChange={(e) => {
                                        const checked = e.target.checked;
                                        setStations((prev) => prev.map((x, i) => {
                                          if (i !== idx) return x;
                                          const next = { ...(x.dayOverrides || {}) } as Record<string, { active: boolean; shifts: StationShift[] }>;
                                          next[d.key] = { ...(next[d.key] || { active: true, shifts: buildDefaultStationShifts(JSON.parse(JSON.stringify(x.roles))) }), active: checked };
                                          return { ...x, dayOverrides: next };
                                        }));
                                      }}
                                    />
                                    פעיל
                                  </label>
                                </div>
                                {dayCfg.active && (
                                  <div className="space-y-3">
                                    {dayCfg.shifts.map((sh, sIdx) => (
                                      <div key={sIdx} className="grid grid-cols-1 gap-3 md:grid-cols-4 items-center">
                                        <div className="text-sm font-medium">{sh.name}</div>
                                          <label className="inline-flex items-center">
                                            <span className="relative inline-block h-5 w-9">
                                              <input
                                                type="checkbox"
                                                checked={sh.enabled}
                                                onChange={(e) => {
                                                  const checked = e.target.checked;
                                                  setStations((prev) => prev.map((x, i) => {
                                                    if (i !== idx) return x;
                                                    const next = { ...(x.dayOverrides || {}) } as Record<string, { active: boolean; shifts: StationShift[] }>;
                                                    const copy = next[d.key] ? { ...next[d.key] } : { active: true, shifts: buildDefaultStationShifts(JSON.parse(JSON.stringify(x.roles))) };
                                                    copy.shifts = copy.shifts.map((ss, j) => (j === sIdx ? { ...ss, enabled: checked } : ss));
                                                    next[d.key] = copy;
                                                    return { ...x, dayOverrides: next };
                                                  }));
                                                }}
                                                className="sr-only peer"
                                                aria-label="הפעל משמרת"
                                              />
                                              <span className="absolute inset-0 rounded-full bg-zinc-300 peer-checked:bg-[#00A8E0] transition-colors" />
                                              <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform translate-x-4 peer-checked:translate-x-0" />
                                            </span>
                                          </label>
                                        {sh.enabled ? (
                                          <>
                                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                              <div>
                                                <label className="block text-xs text-zinc-600 dark:text-zinc-300 mb-1">שעת התחלה</label>
                                                <input
                                                  type="time"
                                                  dir="ltr"
                                                  value={sh.start}
                                                  onChange={(e) => {
                                                    const v = e.target.value;
                                                    setStations((prev) => prev.map((x, i) => {
                                                      if (i !== idx) return x;
                                                      const next = { ...(x.dayOverrides || {}) } as Record<string, { active: boolean; shifts: StationShift[] }>;
                                                      const copy = next[d.key] ? { ...next[d.key] } : { active: true, shifts: buildDefaultStationShifts(JSON.parse(JSON.stringify(x.roles))) };
                                                      copy.shifts = copy.shifts.map((ss, j) => (j === sIdx ? { ...ss, start: v } : ss));
                                                      next[d.key] = copy;
                                                      return { ...x, dayOverrides: next };
                                                    }));
                                                  }}
                                                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                                />
                                              </div>
                                              <div>
                                                <label className="block text-xs text-zinc-600 dark:text-zinc-300 mb-1">שעת סיום</label>
                                                <input
                                                  type="time"
                                                  dir="ltr"
                                                  value={sh.end}
                                                  onChange={(e) => {
                                                    const v = e.target.value;
                                                    setStations((prev) => prev.map((x, i) => {
                                                      if (i !== idx) return x;
                                                      const isMorning = (name: string) => /בוקר/i.test(name) || /morning/i.test(name);
                                                      const isNoon = (name: string) => /צהר(יים|י)ם?/i.test(name) || /noon|afternoon/i.test(name);
                                                      const next = { ...(x.dayOverrides || {}) } as Record<string, { active: boolean; shifts: StationShift[] }>;
                                                      const copy = next[d.key] ? { ...next[d.key] } : { active: true, shifts: buildDefaultStationShifts(JSON.parse(JSON.stringify(x.roles))) };
                                                      const updated = copy.shifts.map((ss, j) => (j === sIdx ? { ...ss, end: v } : ss));
                                                      if (isMorning(copy.shifts[sIdx]?.name)) {
                                                        const noonIdx = updated.findIndex((u) => isNoon(u.name));
                                                        if (noonIdx !== -1) updated[noonIdx] = { ...updated[noonIdx], start: v };
                                                      }
                                                      copy.shifts = updated;
                                                      next[d.key] = copy;
                                                      return { ...x, dayOverrides: next };
                                                    }));
                                                  }}
                                                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                                />
                                              </div>
                                            </div>
                                            {!st.uniformRoles && (
                                              <div className="md:col-span-4 grid grid-cols-1 gap-3 md:grid-cols-3 items-center">
                                                <div className="text-sm font-medium">מספר עובדים למשמרת</div>
                                                <input
                                                  type="number"
                                                  min={0}
                                                  value={sh.workers}
                                                  onChange={(e) => {
                                                    const val = Math.max(0, parseInt(e.target.value || "0", 10));
                                                    setStations((prev) => prev.map((x, i) => {
                                                      if (i !== idx) return x;
                                                      const next = { ...(x.dayOverrides || {}) } as Record<string, { active: boolean; shifts: StationShift[] }>;
                                                      const copy = next[d.key] ? { ...next[d.key] } : { active: true, shifts: buildDefaultStationShifts(JSON.parse(JSON.stringify(x.roles))) };
                                                      copy.shifts = copy.shifts.map((ss, j) => (j === sIdx ? { ...ss, workers: val, roles: ss.roles.map((rr) => ({ ...rr, count: Math.min(rr.count, val) })) } : ss));
                                                      next[d.key] = copy;
                                                      return { ...x, dayOverrides: next };
                                                    }));
                                                  }}
                                                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                                />
                                              </div>
                                            )}
                                            <div className="md:col-span-4 space-y-2">
                                              <div className="text-sm font-medium">תפקידים למשמרת</div>
                                              {st.uniformRoles ? (
                                                <div className="flex flex-wrap gap-2 text-sm">
                                                  {st.roles.filter((r) => r.enabled).map((r, i2) => (
                                                    <span key={i2} className="rounded-full border px-3 py-1 dark:border-zinc-700">
                                                      {r.name}{r.count ? ` · ${r.count}` : ""}
                                                    </span>
                                                  ))}
                                                  {st.roles.every((r) => !r.enabled) && (
                                                    <span className="text-zinc-500">אין תפקידים פעילים</span>
                                                  )}
                                                </div>
                                              ) : (
                                                <div className="space-y-2">
                                                  {sh.roles.map((sr, rj) => (
                                                    <div key={rj} className="grid grid-cols-1 gap-3 md:grid-cols-3 items-center">
                                                      <div className="text-sm">{sr.name}</div>
                                                      <label className="inline-flex items-center">
                                                        <span className="relative inline-block h-5 w-9">
                                                        <input
                                                          type="checkbox"
                                                          checked={sr.enabled}
                                                          onChange={(e) => {
                                                            const checked = e.target.checked;
                                                            setStations((prev) => prev.map((x, i) => {
                                                              if (i !== idx) return x;
                                                              const next = { ...(x.dayOverrides || {}) } as Record<string, { active: boolean; shifts: StationShift[] }>;
                                                              const copy = next[d.key] ? { ...next[d.key] } : { active: true, shifts: buildDefaultStationShifts(JSON.parse(JSON.stringify(x.roles))) };
                                                              copy.shifts = copy.shifts.map((ss, j) => (j === sIdx ? {
                                                                ...ss,
                                                                roles: ss.roles.map((rr, k) => (k === rj ? { ...rr, enabled: checked, count: checked ? rr.count : 0 } : rr)),
                                                              } : ss));
                                                              next[d.key] = copy;
                                                              return { ...x, dayOverrides: next };
                                                            }));
                                                          }}
                                                            className="sr-only peer"
                                                            aria-label="הפעל תפקיד למשמרת"
                                                        />
                                                          <span className="absolute inset-0 rounded-full bg-zinc-300 peer-checked:bg-[#00A8E0] transition-colors" />
                                                          <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform translate-x-4 peer-checked:translate-x-0" />
                                                        </span>
                                                      </label>
                                                      {sr.enabled && (
                                                        <input
                                                          type="number"
                                                          min={0}
                                                          max={st.uniformRoles ? st.workers : sh.workers}
                                                          value={sr.count}
                                                          onChange={(e) => {
                                                            const limit = st.uniformRoles ? st.workers : sh.workers;
                                                            const val = Math.max(0, Math.min(limit, parseInt(e.target.value || "0", 10)));
                                                            setStations((prev) => prev.map((x, i) => {
                                                              if (i !== idx) return x;
                                                              const next = { ...(x.dayOverrides || {}) } as Record<string, { active: boolean; shifts: StationShift[] }>;
                                                              const copy = next[d.key] ? { ...next[d.key] } : { active: true, shifts: buildDefaultStationShifts(JSON.parse(JSON.stringify(x.roles))) };
                                                              copy.shifts = copy.shifts.map((ss, j) => (j === sIdx ? {
                                                                ...ss,
                                                                roles: ss.roles.map((rr, k) => (k === rj ? { ...rr, count: val } : rr)),
                                                              } : ss));
                                                              next[d.key] = copy;
                                                              return { ...x, dayOverrides: next };
                                                            }));
                                                          }}
                                                          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                                          placeholder="כמות למשמרת"
                                                        />
                                                      )}
                                                    </div>
                                                  ))}
                                                </div>
                                              )}
                                            </div>
                                          </>
                                        ) : (
                                          <div className="md:col-span-2 text-sm text-zinc-500">לא פעיל</div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    )}
                    
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* שאלות אופציונליות */}
          <section className="rounded-md border p-4 space-y-4 dark:border-zinc-700">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">שאלות אופציונליות</h2>
              <button
                type="button"
                onClick={() =>
                  setQuestions((prev) => [
                    ...prev,
                    { id: newId(), label: "", type: "text", perDay: false, options: [], slider: { min: 0, max: 10, step: 1 } },
                  ])
                }
                className="inline-flex items-center gap-2 rounded-md border border-green-600 px-3 py-1.5 text-sm text-green-700 hover:bg-green-50 dark:border-green-500 dark:text-green-300 dark:hover:bg-green-900/30"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                  <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
                </svg>
                הוסף שאלה
              </button>
            </div>

            {questions.length === 0 ? (
              <p className="text-sm text-zinc-500">אין שאלות</p>
            ) : (
              <div className="space-y-3">
                {questions.map((q, qIdx) => (
                  <div key={q.id} className="rounded-md border p-3 space-y-3 dark:border-zinc-700">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 space-y-2">
                        <label className="block text-sm font-semibold">שאלה</label>
                        <input
                          type="text"
                          value={q.label}
                          onChange={(e) => {
                            const v = e.target.value;
                            setQuestions((prev) => prev.map((x, i) => (i === qIdx ? { ...x, label: v } : x)));
                          }}
                          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                          placeholder="הזן שאלה"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setQuestions((prev) => prev.filter((_, i) => i !== qIdx))}
                        className="mt-7 inline-flex items-center gap-1 rounded-md border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/30"
                      >
                        מחק
                      </button>
                    </div>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <label className="block text-sm font-semibold">סוג שדה</label>
                        <select
                          value={q.type}
                          onChange={(e) => {
                            const t = e.target.value as QuestionType;
                            setQuestions((prev) =>
                              prev.map((x, i) =>
                                i === qIdx
                                  ? {
                                      ...x,
                                      type: t,
                                      options: t === "dropdown" ? (x.options?.length ? x.options : [""]) : [],
                                      slider: t === "slider" ? (x.slider || { min: 0, max: 10, step: 1 }) : undefined,
                                    }
                                  : x,
                              ),
                            );
                          }}
                          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                        >
                          <option value="text">טקסט</option>
                          <option value="dropdown">רשימה (Dropdown)</option>
                          <option value="yesno">כן / לא</option>
                          <option value="slider">סליידר</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <label className="block text-sm font-semibold">שאלה לכל יום</label>
                        <label className="inline-flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={!!q.perDay}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setQuestions((prev) => prev.map((x, i) => (i === qIdx ? { ...x, perDay: checked } : x)));
                            }}
                          />
                          הצג לכל יום
                        </label>
                      </div>
                    </div>

                    {q.type === "dropdown" && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="block text-sm font-semibold">אפשרויות</label>
                          <button
                            type="button"
                            onClick={() =>
                              setQuestions((prev) =>
                                prev.map((x, i) => (i === qIdx ? { ...x, options: [...(x.options || []), ""] } : x)),
                              )
                            }
                            className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                          >
                            הוסף אפשרות
                          </button>
                        </div>
                        <div className="space-y-2">
                          {(q.options || []).map((opt, oi) => (
                            <div key={oi} className="flex items-center gap-2">
                              <input
                                type="text"
                                value={opt}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setQuestions((prev) =>
                                    prev.map((x, i) => {
                                      if (i !== qIdx) return x;
                                      const next = [...(x.options || [])];
                                      next[oi] = v;
                                      return { ...x, options: next };
                                    }),
                                  );
                                }}
                                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                placeholder={`אפשרות ${oi + 1}`}
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  setQuestions((prev) =>
                                    prev.map((x, i) => {
                                      if (i !== qIdx) return x;
                                      const next = (x.options || []).filter((_, j) => j !== oi);
                                      return { ...x, options: next };
                                    }),
                                  )
                                }
                                className="rounded-md border px-2 py-2 text-sm hover:bg-red-50 dark:border-zinc-700 dark:hover:bg-red-900/30"
                                aria-label="מחק אפשרות"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {q.type === "slider" && (
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        <div className="space-y-2">
                          <label className="block text-sm font-semibold">מינימום</label>
                          <input
                            type="number"
                            value={q.slider?.min ?? 0}
                            onChange={(e) => {
                              const v = Number(e.target.value || 0);
                              setQuestions((prev) =>
                                prev.map((x, i) =>
                                  i === qIdx ? { ...x, slider: { ...(x.slider || { min: 0, max: 10, step: 1 }), min: v } } : x,
                                ),
                              );
                            }}
                            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="block text-sm font-semibold">מקסימום</label>
                          <input
                            type="number"
                            value={q.slider?.max ?? 10}
                            onChange={(e) => {
                              const v = Number(e.target.value || 10);
                              setQuestions((prev) =>
                                prev.map((x, i) =>
                                  i === qIdx ? { ...x, slider: { ...(x.slider || { min: 0, max: 10, step: 1 }), max: v } } : x,
                                ),
                              );
                            }}
                            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="block text-sm font-semibold">צעד</label>
                          <input
                            type="number"
                            value={q.slider?.step ?? 1}
                            onChange={(e) => {
                              const v = Number(e.target.value || 1);
                              setQuestions((prev) =>
                                prev.map((x, i) =>
                                  i === qIdx ? { ...x, slider: { ...(x.slider || { min: 0, max: 10, step: 1 }), step: v } } : x,
                                ),
                              );
                            }}
                            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none ring-0 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="sticky bottom-0 z-10 -mx-6 border-t bg-white/80 px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-white/60 dark:border-zinc-800 dark:bg-zinc-900/80">
            <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-md bg-[#00A8E0] px-4 py-2 text-white hover:bg-[#0092c6] disabled:opacity-60 dark:bg-[#00A8E0] dark:hover:bg-[#0092c6]"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M9 16.2l-3.5-3.5-1.4 1.4L9 19 20 8l-1.4-1.4z"/></svg>
              {loading ? "שומר..." : "שמור"}
            </button>
            <button
              type="button"
              onClick={() => setShowPreview(true)}
              className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
              תצוגה מקדימה
            </button>
            <button
              type="button"
              onClick={() => router.back()}
              className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M18.3 5.71L12 12l6.3 6.29-1.41 1.42L10.59 13.41 4.29 19.71 2.88 18.29 9.17 12 2.88 5.71 4.29 4.29 10.59 10.59 16.89 4.29z"/></svg>
              ביטול
            </button>
            </div>
          </div>
        </form>
      </div>

      {/* Modal Preview */}
      {showPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowPreview(false)}>
          <div className="w-full max-w-6xl max-h-[90vh] overflow-auto rounded-2xl border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-xl font-semibold">תצוגה מקדימה: {name || "אתר חדש"}</h2>
              <button
                type="button"
                onClick={() => setShowPreview(false)}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                ✕
              </button>
            </div>
            <div className="p-6">
              {stations.length === 0 ? (
                <p className="text-center text-zinc-500 py-8">אין עמדות להצגה</p>
              ) : (
                stations.map((station, stIdx) => {
                  const dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
                  const dayLabels = { sun: "א'", mon: "ב'", tue: "ג'", wed: "ד'", thu: "ה'", fri: "ו'", sat: "ש'" };
                  
                  // Collecter tous les shifts uniques (depuis shifts uniformes ou dayOverrides)
                  const allShifts = new Set<string>();
                  if (!station.perDayCustom && station.shifts) {
                    station.shifts.filter((s) => s.enabled).forEach((s) => allShifts.add(s.name));
                  } else if (station.perDayCustom && station.dayOverrides) {
                    Object.values(station.dayOverrides).forEach((dayCfg) => {
                      if (dayCfg.active) {
                        dayCfg.shifts.filter((s) => s.enabled).forEach((s) => allShifts.add(s.name));
                      }
                    });
                  }
                  const shiftNames = Array.from(allShifts);

                  return (
                    <div key={stIdx} className="mb-8 last:mb-0">
                      <h3 className="mb-4 text-lg font-semibold border-b pb-2">{station.name}</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm">
                          <thead>
                            <tr className="border-b dark:border-zinc-800">
                              <th className="px-2 py-2 text-center border-r dark:border-zinc-800">עמדה / יום</th>
                              {shiftNames.map((sn) => (
                                <th key={sn} className="px-2 py-2 text-center border-r dark:border-zinc-800 last:border-r-0">
                                  {sn}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {dayKeys.map((dayKey) => {
                              const isDayActive = station.perDayCustom
                                ? station.dayOverrides?.[dayKey]?.active ?? true
                                : station.days?.[dayKey] ?? true;
                              
                              if (!isDayActive) return null;

                              const dayShifts = station.perDayCustom
                                ? station.dayOverrides?.[dayKey]?.shifts || []
                                : station.shifts || [];

                              return (
                                <tr key={dayKey} className="border-b dark:border-zinc-800">
                                  <td className="px-2 py-2 text-center font-medium border-r dark:border-zinc-800">
                                    {dayLabels[dayKey]}
                                  </td>
                                  {shiftNames.map((sn) => {
                                    const shift = dayShifts.find((s) => s.name === sn && s.enabled);
                                    if (!shift) {
                                      return (
                                        <td key={sn} className="px-2 py-2 text-center border-r dark:border-zinc-800 last:border-r-0">
                                          <span className="text-zinc-400">—</span>
                                        </td>
                                      );
                                    }
                                    const workersCount = shift.workers || 0;
                                    const activeRoles = shift.roles?.filter((r) => r.enabled) || [];
                                    const rolesText = activeRoles.length > 0
                                      ? activeRoles.map((r) => `${r.name}${r.count > 0 ? ` (${r.count})` : ""}`).join(", ")
                                      : "ללא תפקידים";
                                    return (
                                      <td key={sn} className="px-2 py-2 text-center border-r dark:border-zinc-800 last:border-r-0">
                                        <div className="space-y-1">
                                          <div className="font-medium">{shift.start} - {shift.end}</div>
                                          <div className="text-xs text-zinc-600 dark:text-zinc-400">
                                            {workersCount} עובד{workersCount !== 1 ? "ים" : ""}
                                          </div>
                                          {activeRoles.length > 0 && (
                                            <div className="text-xs text-zinc-500 dark:text-zinc-500">
                                              {rolesText}
                                            </div>
                                          )}
                                        </div>
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
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



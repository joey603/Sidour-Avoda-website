"use client";
import type { Dispatch, SetStateAction } from "react";
import { getAnswersForWeek } from "@/lib/planning-worker-answers";

export type FilterWorkersAnswersModalProps = {
  open: boolean;
  onClose: () => void;
  workers: any[];
  site: any;
  weekStart: Date;
  questionFilters: Record<string, string | undefined>;
  setQuestionFilters: Dispatch<SetStateAction<Record<string, string | undefined>>>;
  filterByWorkDays: boolean;
  setFilterByWorkDays: Dispatch<SetStateAction<boolean>>;
  questionVisibility: Record<string, boolean | undefined>;
  setQuestionVisibility: Dispatch<SetStateAction<Record<string, boolean | undefined>>>;
  isSavedMode: boolean;
  savedWeekPlan: any;
  /** Même carte que le planning (משיכות) pour surligner cellule / avant / après. */
  displayedPullsByHoleKey?: Record<string, unknown> | null;
};

export function FilterWorkersAnswersModal({
  open,
  onClose,
  workers,
  site,
  weekStart,
  questionFilters,
  setQuestionFilters,
  filterByWorkDays,
  setFilterByWorkDays,
  questionVisibility,
  setQuestionVisibility,
  isSavedMode,
  savedWeekPlan,
  displayedPullsByHoleKey = null,
}: FilterWorkersAnswersModalProps) {
  if (!open) return null;

  return (

              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-lg border bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                  <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-6 py-4 dark:border-zinc-700 dark:bg-zinc-900">
                    <h3 className="text-lg font-semibold">סינון תשובות לשאלות</h3>
                    <button
                      type="button"
                      onClick={() => {
                        onClose()
                      }}
                      className="rounded-md p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden>
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                      </svg>
                    </button>
                  </div>
                  <div className="p-6 space-y-6">
                    {/* Section de filtrage */}
                    {(() => {
                      const qs: any[] = (site?.config?.questions || []) as any[];
                      if (qs.length === 0) {
                        return (
                          <div className="text-center text-zinc-500 py-8">
                            אין שאלות אופציונליות מוגדרות
                          </div>
                        );
                      }

                      const qsOrdered = qs.filter((q) => q && q.id && String(q.label || "").trim());
                      
                      return (
                        <div className="space-y-4">
                          <div className="flex items-center justify-between">
                            <h4 className="font-semibold text-zinc-800 dark:text-zinc-200">פילטרים</h4>
                            {isSavedMode && savedWeekPlan?.assignments && (
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={filterByWorkDays}
                                  onChange={(e) => setFilterByWorkDays(e.target.checked)}
                                  className="rounded"
                                />
                                <span className="text-sm text-zinc-700 dark:text-zinc-300">
                                  הצג רק ימים שעובדים
                                </span>
                              </label>
                            )}
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {qsOrdered.map((q: any) => {
                              const qid = String(q.id);
                              const label = String(q.label || q.question || q.text || qid);
                              const type = String(q.type || "text");
                              const isPerDay = !!q.perDay;

                              // Collecter toutes les valeurs possibles pour cette question depuis tous les workers (pour la semaine actuelle)
                              const allValues = new Set<string>();
                              workers.forEach((w) => {
                                const rawAnswers = (w as any)?.answers || {};
                                const weekAnswers = getAnswersForWeek(rawAnswers, weekStart);
                                if (!weekAnswers) return; // Pas de réponses pour cette semaine
                                
                                const answersGeneral = weekAnswers.general;
                                const answersPerDay = weekAnswers.perDay;
                                
                                if (isPerDay) {
                                  const perObj = (answersPerDay || {})[qid] || {};
                                  Object.values(perObj).forEach((v: any) => {
                                    if (v !== undefined && v !== null && String(v).trim() !== "") {
                                      allValues.add(String(v));
                                    }
                                  });
                                } else {
                                  const v = (answersGeneral || {})[qid];
                                  if (v !== undefined && v !== null && String(v).trim() !== "") {
                                    allValues.add(String(v));
                                  }
                                }
                              });

                              const uniqueValues = Array.from(allValues).sort();

                              // Initialiser la visibilité par défaut à true si pas encore définie
                              const isVisible = questionVisibility[qid] !== false; // true par défaut
                              
                              return (
                                <div key={qid} className="rounded-md border p-3 dark:border-zinc-700">
                                  <div className="flex items-center justify-between mb-2">
                                    <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                                      {label} {isPerDay && <span className="text-xs text-zinc-500">(לכל יום)</span>}
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={isVisible}
                                        onChange={(e) => {
                                          setQuestionVisibility((prev) => ({
                                            ...prev,
                                            [qid]: e.target.checked,
                                          }));
                                        }}
                                        className="rounded"
                                      />
                                      <span className="text-xs text-zinc-600 dark:text-zinc-400">
                                        הצג תשובות
                                      </span>
                                    </label>
                                  </div>
                                  {type === "dropdown" && q.options && Array.isArray(q.options) ? (
                                    <select
                                      value={questionFilters[qid] || ""}
                                      onChange={(e) => {
                                        setQuestionFilters((prev) => ({
                                          ...prev,
                                          [qid]: e.target.value || undefined,
                                        }));
                                      }}
                                      className="w-full rounded-md border px-3 py-2 text-base md:text-sm dark:border-zinc-600 dark:bg-zinc-800"
                                    >
                                      <option value="">כל התשובות</option>
                                      {q.options.map((opt: string) => (
                                        <option key={opt} value={opt}>{opt}</option>
                                      ))}
                                    </select>
                                  ) : type === "yesno" || type === "yes_no" ? (
                                    <select
                                      value={questionFilters[qid] || ""}
                                      onChange={(e) => {
                                        setQuestionFilters((prev) => ({
                                          ...prev,
                                          [qid]: e.target.value || undefined,
                                        }));
                                      }}
                                      className="w-full rounded-md border px-3 py-2 text-base md:text-sm dark:border-zinc-600 dark:bg-zinc-800"
                                    >
                                      <option value="">כל התשובות</option>
                                      <option value="true">כן</option>
                                      <option value="false">לא</option>
                                    </select>
                                  ) : uniqueValues.length > 0 ? (
                                    <select
                                      value={questionFilters[qid] || ""}
                                      onChange={(e) => {
                                        setQuestionFilters((prev) => ({
                                          ...prev,
                                          [qid]: e.target.value || undefined,
                                        }));
                                      }}
                                      className="w-full rounded-md border px-3 py-2 text-base md:text-sm dark:border-zinc-600 dark:bg-zinc-800"
                                    >
                                      <option value="">כל התשובות</option>
                                      {uniqueValues.map((val) => (
                                        <option key={val} value={val}>{val}</option>
                                      ))}
                                    </select>
                                  ) : (
                                    <input
                                      type="text"
                                      value={questionFilters[qid] || ""}
                                      onChange={(e) => {
                                        setQuestionFilters((prev) => ({
                                          ...prev,
                                          [qid]: e.target.value.trim() || undefined,
                                        }));
                                      }}
                                      placeholder="הזן ערך לחיפוש..."
                                      className="w-full rounded-md border px-3 py-2 text-base md:text-sm dark:border-zinc-600 dark:bg-zinc-800"
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Liste des travailleurs filtrés */}
                    <div className="space-y-4">
                      <h4 className="font-semibold text-zinc-800 dark:text-zinc-200">
                        רשימת עובדים ({(() => {
                          // Filtrer les workers selon les filtres et qui ont des réponses pour cette semaine
                          const filtered = workers.filter((w) => {
                            const rawAnswers = (w as any)?.answers || {};
                            const weekAnswers = getAnswersForWeek(rawAnswers, weekStart);
                            if (!weekAnswers) return false; // Exclure les workers sans réponses pour cette semaine
                            
                            const answersGeneral = weekAnswers.general;
                            const answersPerDay = weekAnswers.perDay;
                            
                            const qs: any[] = (site?.config?.questions || []) as any[];
                            
                            // Vérifier chaque filtre
                            for (const [qid, filterValue] of Object.entries(questionFilters)) {
                              if (!filterValue) continue; // Pas de filtre pour cette question
                              
                              const q = qs.find((q) => String(q.id) === qid);
                              if (!q) continue;
                              
                              const isPerDay = !!q.perDay;
                              
                              if (isPerDay) {
                                const perObj = (answersPerDay || {})[qid] || {};
                                const hasMatch = Object.values(perObj).some((v: any) => {
                                  const strVal = String(v);
                                  const filterStr = String(filterValue);
                                  if (q.type === "yesno" || q.type === "yes_no") {
                                    return (filterStr === "true" && (v === true || strVal === "true" || strVal === "כן")) ||
                                           (filterStr === "false" && (v === false || strVal === "false" || strVal === "לא"));
                                  }
                                  return strVal.toLowerCase().includes(filterStr.toLowerCase()) || strVal === filterStr;
                                });
                                if (!hasMatch) return false;
                              } else {
                                const v = (answersGeneral || {})[qid];
                                const strVal = v !== undefined && v !== null ? String(v) : "";
                                const filterStr = String(filterValue);
                                if (q.type === "yesno" || q.type === "yes_no") {
                                  const matches = (filterStr === "true" && (v === true || strVal === "true" || strVal === "כן")) ||
                                                 (filterStr === "false" && (v === false || strVal === "false" || strVal === "לא"));
                                  if (!matches) return false;
                                } else {
                                  if (!strVal.toLowerCase().includes(filterStr.toLowerCase()) && strVal !== filterStr) {
                                    return false;
                                  }
                                }
                              }
                            }
                            return true;
                          });
                          return filtered.length;
                        })()})
                      </h4>
                      <div className="space-y-2 max-h-96 overflow-y-auto">
                        {(() => {
                          // Filtrer les workers selon les filtres et qui ont des réponses pour cette semaine
                          const filtered = workers.filter((w) => {
                            const rawAnswers = (w as any)?.answers || {};
                            const weekAnswers = getAnswersForWeek(rawAnswers, weekStart);
                            if (!weekAnswers) return false; // Exclure les workers sans réponses pour cette semaine
                            
                            const answersGeneral = weekAnswers.general;
                            const answersPerDay = weekAnswers.perDay;
                            
                            const qs: any[] = (site?.config?.questions || []) as any[];
                            
                            // Vérifier chaque filtre
                            for (const [qid, filterValue] of Object.entries(questionFilters)) {
                              if (!filterValue) continue; // Pas de filtre pour cette question
                              
                              const q = qs.find((q) => String(q.id) === qid);
                              if (!q) continue;
                              
                              const isPerDay = !!q.perDay;
                              
                              if (isPerDay) {
                                const perObj = (answersPerDay || {})[qid] || {};
                                const hasMatch = Object.values(perObj).some((v: any) => {
                                  const strVal = String(v);
                                  const filterStr = String(filterValue);
                                  if (q.type === "yesno" || q.type === "yes_no") {
                                    return (filterStr === "true" && (v === true || strVal === "true" || strVal === "כן")) ||
                                           (filterStr === "false" && (v === false || strVal === "false" || strVal === "לא"));
                                  }
                                  return strVal.toLowerCase().includes(filterStr.toLowerCase()) || strVal === filterStr;
                                });
                                if (!hasMatch) return false;
                              } else {
                                const v = (answersGeneral || {})[qid];
                                const strVal = v !== undefined && v !== null ? String(v) : "";
                                const filterStr = String(filterValue);
                                if (q.type === "yesno" || q.type === "yes_no") {
                                  const matches = (filterStr === "true" && (v === true || strVal === "true" || strVal === "כן")) ||
                                                 (filterStr === "false" && (v === false || strVal === "false" || strVal === "לא"));
                                  if (!matches) return false;
                                } else {
                                  if (!strVal.toLowerCase().includes(filterStr.toLowerCase()) && strVal !== filterStr) {
                                    return false;
                                  }
                                }
                              }
                            }
                            return true;
                          });

                          if (filtered.length === 0) {
                            return (
                              <div className="text-center text-zinc-500 py-8">
                                אין עובדים התואמים לפילטרים
                              </div>
                            );
                          }

                          return filtered.map((w) => {
                            const rawAnswers = (w as any)?.answers || {};
                            // Extraire les réponses de la semaine actuelle
                            const weekAnswers = getAnswersForWeek(rawAnswers, weekStart);
                            if (!weekAnswers) return null; // Pas de réponses pour cette semaine
                            
                            const answersGeneral = weekAnswers.general;
                            const answersPerDay = weekAnswers.perDay;
                            const qs: any[] = (site?.config?.questions || []) as any[];
                            const labelById = new Map<string, string>();
                            qs.forEach((q: any) => {
                              if (q && q.id) {
                                labelById.set(String(q.id), String(q.label || q.question || q.text || q.id));
                              }
                            });

                            return (
                              <div key={w.id} className="rounded-md border p-4 dark:border-zinc-700">
                                <div className="font-semibold text-zinc-900 dark:text-zinc-100 mb-3">{w.name}</div>
                                <div className="space-y-2 text-sm">
                                  {qs.filter((q) => q && q.id).map((q: any) => {
                                    const qid = String(q.id);
                                    // Vérifier si la question est visible (par défaut true)
                                    const isVisible = questionVisibility[qid] !== false;
                                    if (!isVisible) return null; // Ne pas afficher si le toggle est désactivé
                                    
                                    const label = labelById.get(qid) || qid;
                                    const isPerDay = !!q.perDay;
                                    
                                    if (isPerDay) {
                                      const perObj = (answersPerDay || {})[qid] || {};
                                      const hasAny = Object.values(perObj).some((v: any) => v !== undefined && v !== null && String(v).trim() !== "");
                                      if (!hasAny) return null;
                                      
                                      // Fonction pour extraire l'horaire depuis le nom du shift
                                      const hoursOf = (sn: string): string | null => {
                                        const s = String(sn || "");
                                        // direct numeric pattern like 06-14 or 14:22
                                        const m = s.match(/(\d{1,2})\s*[-:–]\s*(\d{1,2})/);
                                        if (m) {
                                          const a = m[1].padStart(2, "0");
                                          const b = m[2].padStart(2, "0");
                                          return `${a}-${b}`;
                                        }
                                        // Hebrew/english names
                                        if (/בוקר/i.test(s)) return "06-14";
                                        if (/צהר(יים|י)ם?/i.test(s)) return "14-22";
                                        if (/לילה|night/i.test(s)) return "22-06";
                                        return null;
                                      };
                                      
                                      // Fonction pour extraire l'horaire depuis la config de la station
                                      const hoursFromConfig = (station: any, shiftName: string): string | null => {
                                        if (!station) return null;
                                        function fmt(start?: string, end?: string): string | null {
                                          if (!start || !end) return null;
                                          return `${start}-${end}`;
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
                                      };
                                      
                                      // Extraire les jours travaillés avec station, shift et horaire si le filtre est activé
                                      const getWorkDays = (): Array<{ dayKey: string; station: string; shift: string; hours: string | null; pullHighlightKind?: "cell" | "before" | "after" | null }> => {
                                        if (!filterByWorkDays || !isSavedMode || !savedWeekPlan?.assignments) return [];
                                        
                                        const assignments = savedWeekPlan.assignments;
                                        const stations = (site?.config?.stations || []) as any[];
                                        const workDays: Array<{ dayKey: string; station: string; shift: string; hours: string | null; pullHighlightKind?: "cell" | "before" | "after" | null }> = [];
                                        const workerNameTrimmed = (w.name || "").trim();
                                        const dayKeysOrdered = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
                                        const shiftNamesOrdered: string[] = Array.from(
                                          new Set(
                                            (site?.config?.stations || [])
                                              .flatMap((stationCfg: any) => (stationCfg?.shifts || [])
                                                .filter((sh: any) => sh?.enabled)
                                                .map((sh: any) => sh?.name))
                                              .filter(Boolean),
                                          ),
                                        );
                                        const getPullHighlightKindForEntry = (
                                          dayKey: string,
                                          shiftName: string,
                                          stationIndex: number,
                                        ): "cell" | "before" | "after" | null => {
                                          const dayIdx = dayKeysOrdered.indexOf(dayKey);
                                          const shiftIdx = shiftNamesOrdered.indexOf(shiftName);
                                          if (dayIdx < 0 || shiftIdx < 0) return null;
                                          let found: "cell" | "before" | "after" | null = null;
                                          Object.entries(displayedPullsByHoleKey || {}).forEach(([pullKey, entryAny]) => {
                                            if (found === "cell") return;
                                            const parts = String(pullKey || "").split("|");
                                            if (parts.length < 3) return;
                                            const [pullDayKey, pullShiftName, pullStationIdxRaw] = parts;
                                            if (Number(pullStationIdxRaw) !== Number(stationIndex)) return;
                                            const entry = entryAny as any;
                                            const beforeName = String(entry?.before?.name || "").trim();
                                            const afterName = String(entry?.after?.name || "").trim();
                                            const pullDayIdx = dayKeysOrdered.indexOf(pullDayKey);
                                            const pullShiftIdx = shiftNamesOrdered.indexOf(pullShiftName);
                                            if (pullDayIdx < 0 || pullShiftIdx < 0) return;
                                            const pullPrevCoord = (pullDayIdx === 0 && pullShiftIdx === 0)
                                              ? null
                                              : (pullShiftIdx === 0 ? { dayIdx: pullDayIdx - 1, shiftIdx: shiftNamesOrdered.length - 1 } : { dayIdx: pullDayIdx, shiftIdx: pullShiftIdx - 1 });
                                            const pullNextCoord = (pullDayIdx === dayKeysOrdered.length - 1 && pullShiftIdx === shiftNamesOrdered.length - 1)
                                              ? null
                                              : (pullShiftIdx === shiftNamesOrdered.length - 1 ? { dayIdx: pullDayIdx + 1, shiftIdx: 0 } : { dayIdx: pullDayIdx, shiftIdx: pullShiftIdx + 1 });
                                            if (pullDayKey === dayKey && pullShiftName === shiftName) {
                                              if (beforeName === workerNameTrimmed || afterName === workerNameTrimmed) {
                                                found = "cell";
                                              }
                                              return;
                                            }
                                            if (!found && beforeName === workerNameTrimmed && pullPrevCoord && pullPrevCoord.dayIdx === dayIdx && pullPrevCoord.shiftIdx === shiftIdx) {
                                              found = "before";
                                            }
                                            if (!found && afterName === workerNameTrimmed && pullNextCoord && pullNextCoord.dayIdx === dayIdx && pullNextCoord.shiftIdx === shiftIdx) {
                                              found = "after";
                                            }
                                          });
                                          return found;
                                        };
                                        
                                        dayKeysOrdered.forEach((dayKey) => {
                                          const dayAssignments = assignments[dayKey] || {};
                                          Object.entries(dayAssignments).forEach(([shiftName, stationArray]) => {
                                            if (!Array.isArray(stationArray)) return;
                                            stationArray.forEach((workerArray, stationIndex) => {
                                              if (!Array.isArray(workerArray)) return;
                                              // Vérifier si le worker est dans ce tableau
                                              const hasWorker = workerArray.some((wn: any) => String(wn || "").trim() === workerNameTrimmed);
                                              if (hasWorker) {
                                                const stationConfig = stations[stationIndex];
                                                const stationName = stationConfig?.name || `עמדה ${stationIndex + 1}`;
                                                // Extraire l'horaire depuis la config ou depuis le nom du shift
                                                const hours = hoursFromConfig(stationConfig, shiftName) || hoursOf(shiftName) || shiftName;
                                                const pullHighlightKind = getPullHighlightKindForEntry(dayKey, shiftName, stationIndex);
                                                // Ajouter chaque assignation (même jour peut avoir plusieurs shifts/stations)
                                                workDays.push({ dayKey, station: stationName, shift: shiftName, hours, pullHighlightKind });
                                              }
                                            });
                                          });
                                        });
                                        
                                        return workDays;
                                      };
                                      
                                      const workDays = getWorkDays();
                                      
                                      // Si le filtre est activé mais qu'il n'y a pas de jours travaillés, ne rien afficher
                                      if (filterByWorkDays && workDays.length === 0) {
                                        return null;
                                      }
                                      
                                      const dayKeysToShow = filterByWorkDays && workDays.length > 0
                                        ? workDays.map(wd => wd.dayKey)
                                        : ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
                                      
                                      return (
                                        <div key={qid} className="rounded-md border border-zinc-100 p-2 dark:border-zinc-800">
                                          <div className="font-medium text-zinc-800 dark:text-zinc-200 mb-1">{label}</div>
                                          <div className="space-y-1 text-xs">
                                            {dayKeysToShow.map((dayKey) => {
                                              const v = (perObj as Record<string, unknown>)[dayKey];
                                              // Si le filtre est activé, on n'affiche que si il y a une réponse ET une assignation
                                              if (filterByWorkDays) {
                                                const workDayInfos = workDays.filter(wd => wd.dayKey === dayKey);
                                                if (workDayInfos.length === 0) return null; // Pas d'assignation pour ce jour
                                                if (v === undefined || v === null || String(v).trim() === "") return null; // Pas de réponse
                                              } else {
                                                // Sans filtre, on affiche seulement si il y a une réponse
                                                if (v === undefined || v === null || String(v).trim() === "") return null;
                                              }
                                              
                                              const dayLabels: Record<string, string> = { sun: "א'", mon: "ב'", tue: "ג'", wed: "ד'", thu: "ה'", fri: "ו'", sat: "ש'" };
                                              
                                              // Trouver toutes les stations et shifts pour ce jour si le filtre est activé
                                              const workDayInfos = filterByWorkDays ? workDays.filter(wd => wd.dayKey === dayKey) : [];
                                              
                                              return (
                                                <div key={dayKey} className="flex justify-between items-start gap-2">
                                                  <div className="flex flex-col flex-1">
                                                    <span className="text-zinc-600 dark:text-zinc-300">{dayLabels[dayKey]}</span>
                                                    {workDayInfos.length > 0 && (
                                                      <div className="mt-1 space-y-0.5">
                                                        {workDayInfos.map((wdi, idx) => (
                                                          <span
                                                            key={idx}
                                                            className={
                                                              "block text-xs " +
                                                              (wdi.pullHighlightKind
                                                                ? "rounded-md border border-orange-400 px-1.5 py-0.5 text-zinc-700 dark:border-orange-400 dark:text-zinc-200"
                                                                : "text-zinc-500 dark:text-zinc-400")
                                                            }
                                                          >
                                                            {wdi.station} - {wdi.shift} {wdi.hours && `(${wdi.hours})`}
                                                          </span>
                                                        ))}
                                                      </div>
                                                    )}
                                                  </div>
                                                  <span className="font-medium text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
                                                    {typeof v === "boolean" ? (v ? "כן" : "לא") : String(v)}
                                                  </span>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        </div>
                                      );
                                    } else {
                                      const v = (answersGeneral || {})[qid];
                                      if (v === undefined || v === null || String(v).trim() === "") return null;
                                      
                                      return (
                                        <div key={qid} className="flex justify-between">
                                          <span className="text-zinc-700 dark:text-zinc-200">{label}</span>
                                          <span className="font-medium text-zinc-900 dark:text-zinc-100">
                                            {typeof v === "boolean" ? (v ? "כן" : "לא") : String(v)}
                                          </span>
                                        </div>
                                      );
                                    }
                                  })}
                                </div>
                              </div>
                            );
                          });
                        })()}
                      </div>
                    </div>
                  </div>
                  <div className="sticky bottom-0 flex items-center gap-2 border-t bg-white px-6 py-4 dark:border-zinc-700 dark:bg-zinc-900">
                    {/* Section gauche : סגור */}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          onClose()
                        }}
                        className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                      >
                        סגור
                      </button>
                    </div>
                    
                    {/* Section milieu : boutons de téléchargement et partage (centrés) */}
                    <div className="flex-1 flex items-center justify-center gap-2">
                      {/* Fonction pour générer le contenu des travailleurs avec leurs réponses */}
                      {(() => {
                        const generateWorkersContent = () => {
                          // Filtrer les workers selon les filtres actifs
                          const filtered = workers.filter((w) => {
                            const rawAnswers = (w as any)?.answers || {};
                            // Extraire les réponses de la semaine actuelle
                            const weekAnswers = getAnswersForWeek(rawAnswers, weekStart);
                            if (!weekAnswers) return false; // Pas de réponses pour cette semaine
                            
                            const answersGeneral = weekAnswers.general;
                            const answersPerDay = weekAnswers.perDay;
                            
                            const qs: any[] = (site?.config?.questions || []) as any[];
                            
                            // Vérifier chaque filtre
                            for (const [qid, filterValue] of Object.entries(questionFilters)) {
                              if (!filterValue) continue;
                              
                              const q = qs.find((q) => String(q.id) === qid);
                              if (!q) continue;
                              
                              const isPerDay = !!q.perDay;
                              
                              if (isPerDay) {
                                const perObj = (answersPerDay || {})[qid] || {};
                                const hasMatch = Object.values(perObj).some((v: any) => {
                                  const strVal = String(v);
                                  const filterStr = String(filterValue);
                                  if (q.type === "yesno" || q.type === "yes_no") {
                                    return (filterStr === "true" && (v === true || strVal === "true" || strVal === "כן")) ||
                                           (filterStr === "false" && (v === false || strVal === "false" || strVal === "לא"));
                                  }
                                  return strVal.toLowerCase().includes(filterStr.toLowerCase()) || strVal === filterStr;
                                });
                                if (!hasMatch) return false;
                              } else {
                                const v = (answersGeneral || {})[qid];
                                const strVal = v !== undefined && v !== null ? String(v) : "";
                                const filterStr = String(filterValue);
                                if (q.type === "yesno" || q.type === "yes_no") {
                                  const matches = (filterStr === "true" && (v === true || strVal === "true" || strVal === "כן")) ||
                                                 (filterStr === "false" && (v === false || strVal === "false" || strVal === "לא"));
                                  if (!matches) return false;
                                } else {
                                  if (!strVal.toLowerCase().includes(filterStr.toLowerCase()) && strVal !== filterStr) {
                                    return false;
                                  }
                                }
                              }
                            }
                            return true;
                          });

                          const qs: any[] = (site?.config?.questions || []) as any[];
                          const labelById = new Map<string, string>();
                          qs.forEach((q: any) => {
                            if (q && q.id) {
                              labelById.set(String(q.id), String(q.label || q.question || q.text || q.id));
                            }
                          });

                          // Fonctions pour extraire les horaires (réutilisées)
                          const hoursOf = (sn: string): string | null => {
                            const s = String(sn || "");
                            const m = s.match(/(\d{1,2})\s*[-:–]\s*(\d{1,2})/);
                            if (m) {
                              const a = m[1].padStart(2, "0");
                              const b = m[2].padStart(2, "0");
                              return `${a}-${b}`;
                            }
                            if (/בוקר/i.test(s)) return "06-14";
                            if (/צהר(יים|י)ם?/i.test(s)) return "14-22";
                            if (/לילה|night/i.test(s)) return "22-06";
                            return null;
                          };
                          
                          const hoursFromConfig = (station: any, shiftName: string): string | null => {
                            if (!station) return null;
                            function fmt(start?: string, end?: string): string | null {
                              if (!start || !end) return null;
                              return `${start}-${end}`;
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
                          };

                          const getWorkDays = (w: any) => {
                            if (!filterByWorkDays || !isSavedMode || !savedWeekPlan?.assignments) return [];
                            
                            const assignments = savedWeekPlan.assignments;
                            const stations = (site?.config?.stations || []) as any[];
                            const workDays: Array<{ dayKey: string; station: string; shift: string; hours: string | null }> = [];
                            const workerNameTrimmed = (w.name || "").trim();
                            
                            const dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
                            dayKeys.forEach((dayKey) => {
                              const dayAssignments = assignments[dayKey] || {};
                              Object.entries(dayAssignments).forEach(([shiftName, stationArray]) => {
                                if (!Array.isArray(stationArray)) return;
                                stationArray.forEach((workerArray, stationIndex) => {
                                  if (!Array.isArray(workerArray)) return;
                                  const hasWorker = workerArray.some((wn: any) => String(wn || "").trim() === workerNameTrimmed);
                                  if (hasWorker) {
                                    const stationConfig = stations[stationIndex];
                                    const stationName = stationConfig?.name || `עמדה ${stationIndex + 1}`;
                                    const hours = hoursFromConfig(stationConfig, shiftName) || hoursOf(shiftName) || shiftName;
                                    workDays.push({ dayKey, station: stationName, shift: shiftName, hours });
                                  }
                                });
                              });
                            });
                            
                            return workDays;
                          };

                          // Générer le contenu texte
                          let content = `רשימת עובדים - ${site?.name || "אתר"}\n`;
                          content += `תאריך: ${new Date().toLocaleDateString('he-IL')}\n`;
                          content += `\n${"=".repeat(50)}\n\n`;

                          filtered.forEach((w) => {
                            content += `עובד: ${w.name}\n`;
                            content += `מקס' משמרות: ${w.maxShifts}\n`;
                            if (w.roles && w.roles.length > 0) {
                              content += `תפקידים: ${w.roles.join(", ")}\n`;
                            }
                            content += `\n`;

                            const rawAnswers = (w as any)?.answers || {};
                            // Extraire les réponses de la semaine actuelle
                            const weekAnswers = getAnswersForWeek(rawAnswers, weekStart);
                            if (!weekAnswers) return; // Pas de réponses pour cette semaine, ne pas inclure dans le contenu
                            
                            const answersGeneral = weekAnswers.general;
                            const answersPerDay = weekAnswers.perDay;

                            // Questions visibles uniquement
                            const visibleQuestions = qs.filter((q) => {
                              const qid = String(q.id);
                              return questionVisibility[qid] !== false; // true par défaut
                            });

                            visibleQuestions.forEach((q: any) => {
                              const qid = String(q.id);
                              const label = labelById.get(qid) || qid;
                              const isPerDay = !!q.perDay;

                              if (isPerDay) {
                                const perObj = (answersPerDay || {})[qid] || {};
                                const workDays = getWorkDays(w);
                                const dayKeysToShow = filterByWorkDays && workDays.length > 0
                                  ? workDays.map(wd => wd.dayKey)
                                  : ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

                                const dayLabels: Record<string, string> = { sun: "א'", mon: "ב'", tue: "ג'", wed: "ד'", thu: "ה'", fri: "ו'", sat: "ש'" };
                                
                                let hasAnswer = false;
                                let answerText = `${label}:\n`;
                                
                                dayKeysToShow.forEach((dayKey) => {
                                  const v = (perObj as Record<string, unknown>)[dayKey];
                                  if (filterByWorkDays) {
                                    const workDayInfos = workDays.filter(wd => wd.dayKey === dayKey);
                                    if (workDayInfos.length === 0) return;
                                    if (v === undefined || v === null || String(v).trim() === "") return;
                                  } else {
                                    if (v === undefined || v === null || String(v).trim() === "") return;
                                  }
                                  
                                  hasAnswer = true;
                                  const dayLabel = dayLabels[dayKey];
                                  const answerValue = typeof v === "boolean" ? (v ? "כן" : "לא") : String(v);
                                  
                                  if (filterByWorkDays) {
                                    const workDayInfos = workDays.filter(wd => wd.dayKey === dayKey);
                                    workDayInfos.forEach((wdi) => {
                                      answerText += `  ${dayLabel}: ${answerValue} (${wdi.station} - ${wdi.shift}${wdi.hours ? ` ${wdi.hours}` : ""})\n`;
                                    });
                                  } else {
                                    answerText += `  ${dayLabel}: ${answerValue}\n`;
                                  }
                                });

                                if (hasAnswer) {
                                  content += answerText + "\n";
                                }
                              } else {
                                const v = (answersGeneral || {})[qid];
                                if (v !== undefined && v !== null && String(v).trim() !== "") {
                                  const answerValue = typeof v === "boolean" ? (v ? "כן" : "לא") : String(v);
                                  content += `${label}: ${answerValue}\n`;
                                }
                              }
                            });

                            content += `\n${"-".repeat(50)}\n\n`;
                          });

                          return content;
                        };

                        const handleDownload = () => {
                          const content = generateWorkersContent();
                          const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `רשימת_עובדים_${new Date().toISOString().split('T')[0]}.txt`;
                          document.body.appendChild(a);
                          a.click();
                          document.body.removeChild(a);
                          URL.revokeObjectURL(url);
                        };

                        const handleShareEmail = () => {
                          const content = generateWorkersContent();
                          const subject = encodeURIComponent(`רשימת עובדים - ${site?.name || "אתר"}`);
                          const body = encodeURIComponent(content);
                          window.location.href = `mailto:?subject=${subject}&body=${body}`;
                        };

                        const handleShareWhatsApp = () => {
                          const content = generateWorkersContent();
                          // Limiter la longueur pour WhatsApp (environ 4096 caractères)
                          const maxLength = 4000;
                          const truncatedContent = content.length > maxLength 
                            ? content.substring(0, maxLength) + "\n\n... (תוכן מקוצר)"
                            : content;
                          const text = encodeURIComponent(truncatedContent);
                          window.open(`https://wa.me/?text=${text}`, '_blank');
                        };

                        return (
                          <>
                            <button
                              type="button"
                              onClick={handleDownload}
                              className="inline-flex items-center gap-2 rounded-md border border-blue-600 bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 dark:border-blue-500 dark:bg-blue-500 dark:hover:bg-blue-600"
                            >
                              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                              </svg>
                              הורד
                            </button>
                            <button
                              type="button"
                              onClick={handleShareEmail}
                              className="inline-flex items-center gap-2 rounded-md border border-green-600 bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700 dark:border-green-500 dark:bg-green-500 dark:hover:bg-green-600"
                            >
                              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                                <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
                              </svg>
                              אימייל
                            </button>
                            <button
                              type="button"
                              onClick={handleShareWhatsApp}
                              className="inline-flex items-center gap-2 rounded-md border border-[#25D366] bg-[#25D366] px-3 py-2 text-sm text-white hover:bg-[#20BA5A] dark:bg-[#25D366] dark:hover:bg-[#20BA5A]"
                            >
                              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
                              </svg>
                              WhatsApp
                            </button>
                          </>
                        );
                      })()}
                    </div>
                    
                    {/* Section droite : נקה פילטרים */}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setQuestionFilters({});
                          setFilterByWorkDays(false);
                          setQuestionVisibility({}); // Réinitialiser la visibilité
                        }}
                        className="rounded-md border border-orange-600 bg-orange-600 px-4 py-2 text-sm text-white hover:bg-orange-700 dark:border-orange-500 dark:bg-orange-500 dark:hover:bg-orange-600"
                      >
                        נקה פילטרים
                      </button>
                    </div>
                  </div>
                </div>
              </div>
  );
}


"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import { apiFetch } from "@/lib/api";

interface Site {
  id: number;
  name: string;
  workers_count: number;
}

export default function SitesList() {
  const router = useRouter();
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [query, setQuery] = useState<string>("");
  const [viewMode, setViewMode] = useState<"list" | "cards">("list");

  async function fetchSites() {
    try {
      const list = await apiFetch<Site[]>("/director/sites/", {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        cache: "no-store" as any,
      });
      setSites(list);
    } catch (e: any) {
      setError("שגיאה בטעינת אתרים");
    }
  }

  useEffect(() => {
    (async () => {
      const me = await fetchMe();
      if (!me) return router.replace("/login/director");
      if (me.role !== "director") return router.replace("/worker");
      try {
        await fetchSites();
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  async function onAddClick() {
    router.push("/director/sites/new");
  }

  async function onDelete(id: number) {
    if (typeof window !== "undefined") {
      const ok = window.confirm("למחוק את האתר?");
      if (!ok) return;
    }
    setDeletingId(id);
    // suppression optimiste immédiate
    setSites((prev) => prev.filter((s) => s.id !== id));
    let deleteOk = false;
    try {
      await apiFetch(`/director/sites/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
      });
      deleteOk = true;
      toast.success("האתר נמחק בהצלחה");
    } catch (e: any) {
      // Vérifier l'état réel: si le site n'existe plus, considérer comme succès
      try {
        const list = await apiFetch<Site[]>("/director/sites/", {
          headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
          cache: "no-store" as any,
        });
        const stillThere = (list || []).some((s) => Number(s.id) === Number(id));
        if (!stillThere) {
          toast.success("האתר נמחק בהצלחה");
          setSites(list || []);
          deleteOk = true;
        } else {
          toast.error("שגיאה במחיקה", { description: String(e?.message || "") });
          setSites(list || []);
        }
      } catch {
        // Impossible de vérifier: afficher erreur générique et resynchroniser
        toast.error("שגיאה במחיקה");
        await fetchSites();
      }
    } finally {
      setDeletingId(null);
    }
    // rafraîchir la liste en arrière-plan si la suppression a réussi
    if (deleteOk) {
      try { await fetchSites(); } catch { /* ignorer erreur d'actualisation */ }
    }
  }

  const filteredSites = useMemo(() => {
    const q = (query || "").trim().toLowerCase();
    if (!q) return sites;
    return (sites || []).filter((s) => (s?.name || "").toLowerCase().includes(q));
  }, [sites, query]);

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Carte statistiques: nombre de sites */}
        <section className="grid grid-cols-1 gap-3">
          <div className="rounded-xl border p-4 shadow-sm bg-[#E6F7FF] border-[#B3ECFF]">
            <div className="text-sm text-[#006C8A]">מספר אתרים</div>
            <div className="mt-1 text-3xl font-bold text-[#004B63]">{sites.length}</div>
          </div>
        </section>

        <div className="rounded-xl border p-4 dark:border-zinc-800">
          <div className="mb-2 grid grid-cols-3 items-center gap-3">
            <h2 className="text-lg font-semibold justify-self-start">רשימת אתרים</h2>
            <div className="justify-self-center w-full flex justify-center">
              <div className="relative w-56 md:w-64">
                <svg
                  className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="חיפוש אתר לפי שם"
                aria-label="חיפוש אתר"
                  className="h-9 w-full rounded-md border pl-3 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-700 bg-white dark:bg-zinc-900"
              />
              </div>
            </div>
            <div className="justify-self-end flex items-center gap-2">
              <button onClick={onAddClick} className="inline-flex items-center gap-2 rounded-md bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-600">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>
                הוסף אתר
              </button>
            </div>
          </div>
          <div className="mb-4 flex items-center justify-start">
            <div className="inline-flex rounded-md border dark:border-zinc-700 overflow-hidden">
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={`px-3 py-1.5 text-sm ${viewMode === "list" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-white text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"}`}
                aria-label="תצוגת רשימה"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h16v2H4v-2Z"/>
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("cards")}
                className={`px-3 py-1.5 text-sm ${viewMode === "cards" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-white text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"}`}
                aria-label="תצוגת כרטיסים"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z"/>
                </svg>
              </button>
            </div>
          </div>
          {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
          {loading ? (
            <p>טוען...</p>
          ) : (
            <>
              {filteredSites.length === 0 ? (
                <p className="py-6 text-sm text-zinc-500">אין אתרים עדיין</p>
              ) : viewMode === "list" ? (
                <div className="divide-y">
                  {filteredSites.map((s) => (
                    <div key={s.id} className="flex items-center justify-between py-3">
                      <div className="flex flex-col">
                        <span className="font-medium">{s.name}</span>
                        <span className="text-sm text-zinc-500">מספר עובדים: {s.workers_count}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => router.push(`/director/planning/${s.id}`)}
                          className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41ל-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75Z"/>
                          </svg>
                          עדכן
                        </button>
                        <button
                          onClick={() => onDelete(s.id)}
                          disabled={deletingId === s.id}
                          className="inline-flex items-center gap-1 rounded-md border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900"
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                            <path d="M6 7h12v2H6Zm2 4h8l-1 9H9ZM9 4h6v2H9Z"/>
                          </svg>
                          {deletingId === s.id ? "מוחק..." : "מחק"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {filteredSites.map((s) => (
                    <div key={s.id} className="rounded-xl border p-4 dark:border-zinc-800">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-base font-semibold">{s.name}</span>
                        <span className="text-sm text-zinc-500">{s.workers_count} עובדים</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => router.push(`/director/planning/${s.id}`)}
                          className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75Z"/>
                          </svg>
                          עדכן
                        </button>
                        <button
                          onClick={() => onDelete(s.id)}
                          disabled={deletingId === s.id}
                          className="inline-flex items-center gap-1 rounded-md border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900"
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                            <path d="M6 7h12v2H6Zm2 4h8l-1 9H9ZM9 4h6v2H9Z"/>
                          </svg>
                          {deletingId === s.id ? "מוחק..." : "מחק"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}


"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import { apiFetch } from "@/lib/api";

interface Worker {
  id: number;
  site_id: number;
  name: string;
  max_shifts: number;
  roles: string[];
  availability: Record<string, string[]>;
}

interface Site {
  id: number;
  name: string;
  workers_count: number;
}

export default function WorkersList() {
  const router = useRouter();
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<string>("");
  const [viewMode, setViewMode] = useState<"list" | "cards">("list");

  async function fetchWorkers() {
    try {
      const list = await apiFetch<Worker[]>("/director/sites/all-workers", {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        cache: "no-store" as any,
      });
      setWorkers(list || []);
    } catch (e: any) {
      setError("שגיאה בטעינת עובדים");
    }
  }

  async function fetchSites() {
    try {
      const list = await apiFetch<Site[]>("/director/sites/", {
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        cache: "no-store" as any,
      });
      setSites(list || []);
    } catch (e: any) {
      // Ignorer l'erreur pour les sites car on peut afficher les travailleurs sans
    }
  }

  useEffect(() => {
    (async () => {
      const me = await fetchMe();
      if (!me) return router.replace("/login");
      if (me.role !== "director") return router.replace("/worker");
      try {
        await Promise.all([fetchWorkers(), fetchSites()]);
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  const getSiteName = (siteId: number): string => {
    const site = sites.find((s) => s.id === siteId);
    return site?.name || `אתר #${siteId}`;
  };

  const filteredWorkers = useMemo(() => {
    const q = (query || "").trim().toLowerCase();
    if (!q) return workers;
    return (workers || []).filter((w) => (w?.name || "").toLowerCase().includes(q));
  }, [workers, query]);

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Stat card: total workers */}
        <section className="grid grid-cols-1 gap-3">
          <div className="rounded-xl border p-4 shadow-sm bg-[#E6F7FF] border-[#B3ECFF]">
            <div className="text-sm text-[#006C8A]">מספר עובדים</div>
            <div className="mt-1 text-3xl font-bold text-[#004B63]">{workers.length}</div>
          </div>
        </section>

        <div className="rounded-xl border p-4 dark:border-zinc-800">
          <div className="mb-2 grid grid-cols-3 items-center gap-3">
            <h2 className="text-lg font-semibold justify-self-start">רשימת עובדים</h2>
            <div className="justify-self-center w-full flex justify-center">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="חיפוש עובד לפי שם"
                aria-label="חיפוש עובד"
                className="h-9 w-56 md:w-64 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-700 bg-white dark:bg-zinc-900"
              />
            </div>
            <div />
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
              {filteredWorkers.length === 0 ? (
                <p className="py-6 text-sm text-zinc-500">אין עובדים עדיין</p>
              ) : viewMode === "list" ? (
                <div className="divide-y">
                  {filteredWorkers.map((worker) => (
                    <div key={worker.id} className="flex items-center justify-between py-3">
                      <div className="flex flex-col gap-1">
                        <span className="font-medium">{worker.name}</span>
                        <span className="text-sm text-zinc-500">אתר: {getSiteName(worker.site_id)}</span>
                        {worker.roles && worker.roles.length > 0 && (
                          <span className="text-sm text-zinc-500">תפקידים: {worker.roles.join(", ")}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            router.push(`/director/workers/${worker.id}`);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75Z"/>
                          </svg>
                          ערוך
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {filteredWorkers.map((worker) => (
                    <div key={worker.id} className="rounded-xl border p-4 dark:border-zinc-800">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-base font-semibold">{worker.name}</span>
                        <span className="text-sm text-zinc-500">{getSiteName(worker.site_id)}</span>
                      </div>
                      {worker.roles && worker.roles.length > 0 && (
                        <div className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">תפקידים: {worker.roles.join(", ")}</div>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            router.push(`/director/workers/${worker.id}`);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75Z"/>
                          </svg>
                          ערוך
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


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
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const [newWorkerName, setNewWorkerName] = useState("");
  const [newWorkerPhone, setNewWorkerPhone] = useState("");
  const [addingWorker, setAddingWorker] = useState(false);

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
      if (!me) return router.replace("/login/director");
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

  async function handleAddWorker() {
    if (!selectedSiteId || !newWorkerName.trim() || !newWorkerPhone.trim()) {
      toast.error("נא למלא את כל השדות");
      return;
    }
    setAddingWorker(true);
    try {
      // Créer d'abord le User worker
      await apiFetch(`/director/sites/${selectedSiteId}/create-worker-user`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        body: JSON.stringify({
          name: newWorkerName.trim(),
          phone: newWorkerPhone.trim(),
        }),
      });
      
      // Ensuite créer le SiteWorker
      await apiFetch(`/director/sites/${selectedSiteId}/workers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
        body: JSON.stringify({
          name: newWorkerName.trim(),
          max_shifts: 5, // Valeur par défaut
          roles: [],
          availability: {},
        }),
      });
      
      toast.success("העובד נוסף בהצלחה");
      setIsAddModalOpen(false);
      setNewWorkerName("");
      setNewWorkerPhone("");
      setSelectedSiteId(null);
      await fetchWorkers();
    } catch (e: any) {
      toast.error("שגיאה בהוספת עובד", { description: e?.message || "נסה שוב מאוחר יותר." });
    } finally {
      setAddingWorker(false);
    }
  }

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
            <div className="justify-self-end flex items-center gap-2">
              <button
                onClick={() => setIsAddModalOpen(true)}
                className="inline-flex items-center gap-2 rounded-md bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-600"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                  <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>
                </svg>
                הוסף עובד
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

      {/* Modal pour ajouter un travailleur */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setIsAddModalOpen(false)}>
          <div className="w-full max-w-md rounded-xl border bg-white p-6 shadow-lg dark:border-zinc-700 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-lg font-semibold">הוסף עובד חדש</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">אתר</label>
                <select
                  value={selectedSiteId || ""}
                  onChange={(e) => setSelectedSiteId(Number(e.target.value) || null)}
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
                >
                  <option value="">בחר אתר</option>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">שם העובד</label>
                <input
                  type="text"
                  value={newWorkerName}
                  onChange={(e) => setNewWorkerName(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
                  placeholder="הזן שם עובד"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">מספר טלפון</label>
                <input
                  type="tel"
                  dir="ltr"
                  value={newWorkerPhone}
                  onChange={(e) => setNewWorkerPhone(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
                  placeholder="הזן מספר טלפון"
                />
              </div>
            </div>
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsAddModalOpen(false);
                  setNewWorkerName("");
                  setNewWorkerPhone("");
                  setSelectedSiteId(null);
                }}
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                ביטול
              </button>
              <button
                type="button"
                onClick={handleAddWorker}
                disabled={addingWorker || !selectedSiteId || !newWorkerName.trim() || !newWorkerPhone.trim()}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {addingWorker ? "מוסיף..." : "הוסף"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


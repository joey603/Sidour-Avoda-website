"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";
import { apiFetch } from "@/lib/api";

interface Site {
  id: number;
  name: string;
  workers_count: number;
}

export default function DirectorDashboard() {
  const router = useRouter();
  const [name, setName] = useState<string>("");
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

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
      setName(me.full_name);
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

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">ברוך הבא, <span className="font-bold" style={{ color: '#00A8E0' }}>{name}</span></h1>
        </header>

        {/* Cartes de statistiques */}
        <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-xl border p-4 shadow-sm bg-[#E6F7FF] border-[#B3ECFF]">
            <div className="text-sm text-[#006C8A]">מספר אתרים</div>
            <div className="mt-1 text-3xl font-bold text-[#004B63]">{sites.length}</div>
          </div>
          <div className="rounded-xl border p-4 shadow-sm bg-[#F3E8FF] border-[#E9D5FF]">
            <div className="text-sm text-[#6B21A8]">מספר עובדים</div>
            <div className="mt-1 text-3xl font-bold text-[#581C87]">{sites.reduce((sum, s) => sum + (s.workers_count || 0), 0)}</div>
          </div>
        </section>

        <div className="rounded-xl border p-4 dark:border-zinc-800">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">רשימת אתרים</h2>
            <button onClick={onAddClick} className="inline-flex items-center gap-2 rounded-md bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-600">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>
              הוסף אתר
            </button>
          </div>
          {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
          {loading ? (
            <p>טוען...</p>
          ) : (
            <div className="divide-y">
              {sites.length === 0 ? (
                <p className="py-6 text-sm text-zinc-500">אין אתרים עדיין</p>
              ) : (
                sites.map((s) => (
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
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}



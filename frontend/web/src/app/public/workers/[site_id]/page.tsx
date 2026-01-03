"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { fetchMe } from "@/lib/auth";
import { toast } from "sonner";
import LoadingAnimation from "@/components/loading-animation";

type WorkerAvailability = Record<string, string[]>; // key: day key (sun..sat) -> enabled shift names

export default function PublicWorkerRegistrationPage() {
  const params = useParams<{ site_id: string }>();
  const router = useRouter();
  const siteId = Number(params.site_id);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [siteName, setSiteName] = useState<string>("");
  const [workerName, setWorkerName] = useState<string>("");
  const [shifts, setShifts] = useState<string[]>([]);
  const [availability, setAvailability] = useState<WorkerAvailability>({
    sun: [],
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
  });
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    async function checkAuthAndFetch() {
      // Vérifier si l'utilisateur est connecté
      const me = await fetchMe();
      const returnUrl = `/public/workers/${siteId}`;
      
      if (!me) {
        // Rediriger vers la page de login travailleur
        router.replace(`/login/worker?returnUrl=${encodeURIComponent(returnUrl)}`);
        return;
      }
      
      // Vérifier que l'utilisateur est un travailleur
      if (me.role !== "worker") {
        // Rediriger vers la page de login travailleur pour qu'il puisse se connecter avec un compte travailleur
        router.replace(`/login/worker?returnUrl=${encodeURIComponent(returnUrl)}`);
        return;
      }

      // Charger les informations du site
      try {
        const info = await apiFetch<{ id: number; name: string; shifts: string[] }>(`/public/sites/${siteId}/info`);
        setSiteName(info.name || "");
        setShifts(info.shifts || ["06-14", "14-22", "22-06"]);
      } catch (e: any) {
        toast.error("שגיאה בטעינת פרטי האתר", { description: e?.message || "נסה שוב מאוחר יותר." });
      } finally {
        setLoading(false);
      }
    }
    
    if (siteId && !isNaN(siteId)) {
      checkAuthAndFetch();
    } else {
      setLoading(false);
    }
  }, [siteId, router]);

  const dayDefs = [
    { key: "sun", label: "א'" },
    { key: "mon", label: "ב'" },
    { key: "tue", label: "ג'" },
    { key: "wed", label: "ד'" },
    { key: "thu", label: "ה'" },
    { key: "fri", label: "ו'" },
    { key: "sat", label: "ש'" },
  ];

  function toggleAvailability(dayKey: string, shiftName: string) {
    setAvailability((prev) => {
      const dayShifts = prev[dayKey] || [];
      const hasShift = dayShifts.includes(shiftName);
      return {
        ...prev,
        [dayKey]: hasShift ? dayShifts.filter((s) => s !== shiftName) : [...dayShifts, shiftName],
      };
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!workerName.trim()) {
      toast.error("נא להזין שם");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch(`/public/sites/${siteId}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: workerName.trim(),
          max_shifts: 5,
          roles: [],
          availability: availability,
        }),
      });
      setSuccess(true);
      toast.success("הזמינות נשמרה בהצלחה!");
      // Réinitialiser le formulaire après 2 secondes
      setTimeout(() => {
        setWorkerName("");
        setAvailability({
          sun: [],
          mon: [],
          tue: [],
          wed: [],
          thu: [],
          fri: [],
          sat: [],
        });
        setSuccess(false);
      }, 2000);
    } catch (e: any) {
      toast.error("שגיאה בשמירה", { description: e?.message || "נסה שוב מאוחר יותר." });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingAnimation size={80} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-zinc-900 dark:to-zinc-800 p-6">
      <div className="mx-auto max-w-2xl">
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
              רישום זמינות - {siteName}
            </h1>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              הזן את שמך ובחר את זמינותך השבועית
            </p>
          </div>

          {success && (
            <div className="mb-4 rounded-lg bg-green-50 border border-green-200 p-4 text-center text-green-800 dark:bg-green-900/20 dark:border-green-800 dark:text-green-200">
              ✓ הזמינות נשמרה בהצלחה!
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="worker-name" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                שם העובד
              </label>
              <input
                id="worker-name"
                type="text"
                value={workerName}
                onChange={(e) => setWorkerName(e.target.value)}
                required
                disabled={submitting || success}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 disabled:opacity-60"
                placeholder="הזן את שמך"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">
                זמינות שבועית
              </label>
              <div className="space-y-4">
                {dayDefs.map((day) => (
                  <div key={day.key} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
                    <div className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                      {day.label}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {shifts.map((shift) => {
                        const isSelected = (availability[day.key] || []).includes(shift);
                        return (
                          <button
                            key={shift}
                            type="button"
                            onClick={() => toggleAvailability(day.key, shift)}
                            disabled={submitting || success}
                            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                              isSelected
                                ? "bg-blue-600 text-white hover:bg-blue-700"
                                : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                            } disabled:opacity-60 disabled:cursor-not-allowed`}
                          >
                            {shift}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-center gap-3 pt-4">
              <button
                type="submit"
                disabled={submitting || success || !workerName.trim()}
                className="rounded-md bg-blue-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? "שומר..." : success ? "נשמר!" : "שמור זמינות"}
              </button>
            </div>
          </form>

          <div className="mt-6 text-center">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              ניתן לעדכן את הזמינות בכל עת על ידי מילוי הטופס מחדש
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}


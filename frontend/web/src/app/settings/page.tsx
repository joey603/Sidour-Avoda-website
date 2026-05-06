"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { type AuthMe, fetchMe, notifyAuthSessionChanged } from "@/lib/auth";
import LoadingAnimation from "@/components/loading-animation";

type SettingsForm = {
  fullName: string;
  email: string;
  phone: string;
  currentPassword: string;
  newPassword: string;
};

export default function SettingsPage() {
  const router = useRouter();
  const [me, setMe] = useState<AuthMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [form, setForm] = useState<SettingsForm>({
    fullName: "",
    email: "",
    phone: "",
    currentPassword: "",
    newPassword: "",
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const user = await fetchMe();
      if (cancelled) return;
      if (!user) {
        router.replace("/login/director");
        return;
      }
      setMe(user);
      setForm({
        fullName: user.full_name || "",
        email: user.email || "",
        phone: user.phone || "",
        currentPassword: "",
        newPassword: "",
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const saveProfile = async () => {
    if (!me) return;
    const fullName = form.fullName.trim();
    if (!fullName) {
      toast.error("שם חובה");
      return;
    }
    setSavingProfile(true);
    try {
      const updated = await apiFetch<AuthMe>("/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({
          full_name: fullName,
          email: me.role === "director" ? form.email.trim() || null : undefined,
        }),
      });
      setMe(updated);
      setForm((prev) => ({
        ...prev,
        fullName: updated.full_name || "",
        email: updated.email || "",
        phone: updated.phone || "",
      }));
      notifyAuthSessionChanged();
      toast.success("הפרופיל עודכן");
    } catch (e: unknown) {
      toast.error("עדכון הפרופיל נכשל", { description: String((e as Error)?.message || "") });
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async () => {
    if (!form.currentPassword || !form.newPassword) {
      toast.error("נא למלא סיסמה נוכחית וסיסמה חדשה");
      return;
    }
    if (form.newPassword.length < 8) {
      toast.error("הסיסמה החדשה חייבת להכיל לפחות 8 תווים");
      return;
    }
    setSavingPassword(true);
    try {
      await apiFetch("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          current_password: form.currentPassword,
          new_password: form.newPassword,
        }),
      });
      setForm((prev) => ({ ...prev, currentPassword: "", newPassword: "" }));
      toast.success("הסיסמה עודכנה");
    } catch (e: unknown) {
      toast.error("עדכון הסיסמה נכשל", { description: String((e as Error)?.message || "") });
    } finally {
      setSavingPassword(false);
    }
  };

  if (loading) {
    return <LoadingAnimation className="py-12" size={96} />;
  }

  if (!me) return null;

  return (
    <main className="min-h-screen bg-zinc-50 p-6 dark:bg-zinc-950" dir="rtl">
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold">הגדרות</h1>
          <p className="mt-1 text-sm text-zinc-500">
            ניהול פרטי הפרופיל והסיסמה של החשבון.
          </p>
        </div>

        <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-lg font-semibold">פרטי פרופיל</h2>
          <div className="mt-4 grid gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium">שם מלא</label>
              <input
                value={form.fullName}
                onChange={(event) => setForm((prev) => ({ ...prev, fullName: event.target.value }))}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </div>

            {me.role === "director" ? (
              <div>
                <label className="mb-1 block text-sm font-medium">אימייל</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                />
              </div>
            ) : (
              <div>
                <label className="mb-1 block text-sm font-medium">טלפון</label>
                <input
                  type="tel"
                  dir="ltr"
                  value={form.phone}
                  readOnly
                  className="w-full rounded-md border border-zinc-300 bg-zinc-100 px-3 py-2 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                />
                <p className="mt-1 text-xs text-zinc-500">
                  מספר הטלפון מנוהל על ידי המנהל ואינו ניתן לשינוי כאן.
                </p>
              </div>
            )}

            <div className="text-xs text-zinc-500">
              סוג חשבון: {me.role === "director" ? "מנהל" : "עובד"}
            </div>

            <button
              type="button"
              disabled={savingProfile}
              onClick={saveProfile}
              className="w-fit rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6] disabled:opacity-60"
            >
              {savingProfile ? "שומר..." : "שמור פרופיל"}
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-lg font-semibold">שינוי סיסמה</h2>
          <div className="mt-4 grid gap-4">
            <input
              type="password"
              value={form.currentPassword}
              onChange={(event) => setForm((prev) => ({ ...prev, currentPassword: event.target.value }))}
              placeholder="סיסמה נוכחית"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
            <input
              type="password"
              value={form.newPassword}
              onChange={(event) => setForm((prev) => ({ ...prev, newPassword: event.target.value }))}
              placeholder="סיסמה חדשה"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
            <button
              type="button"
              disabled={savingPassword}
              onClick={savePassword}
              className="w-fit rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              {savingPassword ? "מעדכן..." : "שנה סיסמה"}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

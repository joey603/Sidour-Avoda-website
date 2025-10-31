"use client";

export default function PresentationPage() {
  return (
    <div className="min-h-screen">
      <section className="mx-auto max-w-5xl px-6 py-16 text-center">
        <h1 className="text-3xl font-bold mb-4">ברוכים הבאים ל-G1 Scheduler</h1>
        <p className="text-zinc-600 dark:text-zinc-300 max-w-2xl mx-auto">
          מערכת חכמה לניהול משמרות, התאמות תפקידים ויצירת תכניות עבודה אוטומטיות או ידניות.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <a href="/login" className="rounded-md bg-[#00A8E0] px-4 py-2 text-white text-sm">התחברות</a>
          <a href="/register" className="rounded-md border px-4 py-2 text-sm dark:border-zinc-700">יצירת משתמש</a>
        </div>
      </section>

      <section className="bg-zinc-50 dark:bg-zinc-900/40 border-y py-12">
        <div className="mx-auto max-w-5xl px-6 grid gap-6 md:grid-cols-3 text-center">
          <div className="rounded-xl border p-6 dark:border-zinc-800">
            <h3 className="font-semibold mb-2">תכנון אוטומטי</h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-300">אלגוריתם AI חכם למילוי משמרות לפי דרישות ותפקידים.</p>
          </div>
          <div className="rounded-xl border p-6 dark:border-zinc-800">
            <h3 className="font-semibold mb-2">תכנון ידני</h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-300">גרירה ושחרור עובדים, שמירת סדר תאים ותפקידים.</p>
          </div>
          <div className="rounded-xl border p-6 dark:border-zinc-800">
            <h3 className="font-semibold mb-2">דוחות והתראות</h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-300">מבט כולל על כיסוי משמרות, תפקידים וחוסרים.</p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 py-12 text-center">
        <h2 className="text-xl font-semibold mb-3">להתחיל לעבוד מהר</h2>
        <p className="text-zinc-600 dark:text-zinc-300 max-w-2xl mx-auto">
          הוספת אתר, הגדרת עמדות ותפקידים, הזנת עובדים והפקת תכנון בלחיצה.
        </p>
        <div className="mt-6">
          <a href="/director/sites" className="rounded-md border px-4 py-2 text-sm dark:border-zinc-700">ניהול אתרים</a>
        </div>
      </section>
    </div>
  );
}

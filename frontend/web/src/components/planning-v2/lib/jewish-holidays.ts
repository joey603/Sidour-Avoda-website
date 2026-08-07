/**
 * Fêtes juives (Yom Tov) Israël via @hebcal/core — affichage calendrier + premium salaire.
 */

import { HebrewCalendar, flags } from "@hebcal/core";

export type JewishHolidayMark = {
  /** YYYY-MM-DD civil */
  iso: string;
  /** Nom hébreu / anglais */
  title: string;
  /** Jour de Yom Tov (CHAG) */
  isYomTov: boolean;
  /**
   * Jour férié pour le salaire 150% :
   * Yom Tov + jours fériés nationaux (עצמאות, זיכרון, …).
   */
  isPremiumHoliday: boolean;
  /** Veille de fête */
  isErev: boolean;
};

/** Jours fériés nationaux israéliens (hors « journées » symboliques type Herzl / Family Day). */
const PUBLIC_HOLIDAY_DESC_RE =
  /Yom HaAtzma|Yom HaZikaron|Yom HaShoah|\bSigd\b|Independence Day|Memorial Day|Holocaust/i;

const holidayCache = new Map<string, JewishHolidayMark[]>();

function toIsoLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseIsoLocal(iso: string): Date {
  const [y, m, d] = iso.split("-").map((x) => Number(x));
  return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
}

function eventMask(ev: { getFlags?: () => number; mask?: number }): number {
  return Number(ev.getFlags?.() ?? ev.mask ?? 0);
}

/**
 * Yom Tov « vrai » (יום טוב) :
 * flag CHAG, hors חול המועד.
 */
export function isYomTovMask(mask: number): boolean {
  const hasChag = (mask & flags.CHAG) !== 0;
  const isCholHaMoed = (mask & flags.CHOL_HAMOED) !== 0;
  return hasChag && !isCholHaMoed;
}

function isPublicHolidayEvent(mask: number, desc: string): boolean {
  if ((mask & flags.MODERN_HOLIDAY) === 0) return false;
  return PUBLIC_HOLIDAY_DESC_RE.test(desc);
}

/** Liste des fêtes pour un mois civil (cache mémoire). */
export function getJewishHolidaysForMonth(year: number, monthIndex: number): JewishHolidayMark[] {
  const key = `v3-${year}-${monthIndex}`;
  const cached = holidayCache.get(key);
  if (cached) return cached;

  const start = new Date(year, monthIndex, 1);
  const end = new Date(year, monthIndex + 1, 0);
  const events = HebrewCalendar.calendar({
    start,
    end,
    il: true,
    candlelighting: false,
    sedrot: false,
    omer: false,
    molad: false,
    yomKippurKatan: false,
  });

  const byIso = new Map<string, JewishHolidayMark>();
  for (const ev of events) {
    const mask = eventMask(ev);
    const desc = String(ev.getDesc?.() || "");
    const isYomTov = isYomTovMask(mask);
    const isPublic = isPublicHolidayEvent(mask, desc);
    const isPremiumHoliday = isYomTov || isPublic;
    const isErev = (mask & flags.EREV) !== 0;
    // Affichage calendrier : Yom Tov + fériés + erev + chol hamoed + autres.
    // Premium salaire = isPremiumHoliday (voir getYomTovIsoSet).
    const isChol = (mask & flags.CHOL_HAMOED) !== 0;
    const isModern = (mask & flags.MODERN_HOLIDAY) !== 0;
    const isRoshChodesh = (mask & flags.ROSH_CHODESH) !== 0;
    const isMinor = (mask & flags.MINOR_HOLIDAY) !== 0;
    const isFast = (mask & flags.MAJOR_FAST) !== 0 || (mask & flags.MINOR_FAST) !== 0;
    if (!isYomTov && !isErev && !isChol && !isModern && !isRoshChodesh && !isMinor && !isFast) continue;

    const greg = ev.getDate().greg();
    const iso = toIsoLocal(greg);
    let title = "";
    try {
      title = String(ev.render("he") || desc || "").trim();
    } catch {
      title = desc.trim();
    }
    if (!title) continue;

    const prev = byIso.get(iso);
    if (!prev) {
      byIso.set(iso, { iso, title, isYomTov, isPremiumHoliday, isErev });
    } else {
      byIso.set(iso, {
        iso,
        title: prev.isPremiumHoliday ? prev.title : isPremiumHoliday ? title : `${prev.title} · ${title}`,
        isYomTov: prev.isYomTov || isYomTov,
        isPremiumHoliday: prev.isPremiumHoliday || isPremiumHoliday,
        isErev: prev.isErev || isErev,
      });
    }
  }

  const list = Array.from(byIso.values()).sort((a, b) => a.iso.localeCompare(b.iso));
  holidayCache.set(key, list);
  return list;
}

/**
 * Jours fériés premium (Yom Tov + יום העצמאות / זיכרון / …) dans [startIso, endIso].
 * Nom historique getYomTovIsoSet — utilisé aussi par le calcul salaire.
 */
export function getYomTovIsoSet(startIso: string, endIso: string): Set<string> {
  const start = parseIsoLocal(startIso);
  const end = parseIsoLocal(endIso);
  const out = new Set<string>();
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return out;

  let y = start.getFullYear();
  let m = start.getMonth();
  const endY = end.getFullYear();
  const endM = end.getMonth();
  while (y < endY || (y === endY && m <= endM)) {
    for (const h of getJewishHolidaysForMonth(y, m)) {
      if (!h.isPremiumHoliday) continue;
      if (h.iso >= startIso && h.iso <= endIso) out.add(h.iso);
    }
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

export function holidayTitleForIso(iso: string): string | null {
  const d = parseIsoLocal(iso);
  if (Number.isNaN(d.getTime())) return null;
  const list = getJewishHolidaysForMonth(d.getFullYear(), d.getMonth());
  const hit = list.find((h) => h.iso === iso);
  return hit?.title || null;
}

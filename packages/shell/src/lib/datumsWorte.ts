/** A date in words — the single shared implementation.
 *
 * Why shared: apps used to phrase the same day differently (e.g. "Do., 20. Aug."
 * in one place and "20. August 2026" in another). One helper keeps the wording
 * consistent across the whole shell.
 *
 * Important: the calculation works at DAY granularity. Comparing milliseconds
 * would turn a task due today at 9:00 into "yesterday" at 10:00.
 */
import { regionLocale } from "@claraos/core";

/** Distance in whole days: today = 0, tomorrow = 1, yesterday = −1. */
export function tagesDiff(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const heute = new Date();
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const b = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate()).getTime();
  return Math.round((a - b) / 86400000);
}

/** "Heute", "Morgen", "Gestern", "Do., 20. Aug.", "vor 3 Tagen", "20. Aug 2027".
 *  Empty string if the date cannot be parsed. */
export function datumInWorten(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const tage = tagesDiff(iso);
  if (tage === null) return "";
  if (tage === 0) return "Heute";
  if (tage === 1) return "Morgen";
  if (tage === -1) return "Gestern";
  // The coming week with weekday — that is what people actually ask for day to day.
  if (tage > 1 && tage <= 7) {
    return d.toLocaleDateString(regionLocale(), { weekday: "short", day: "numeric", month: "short" });
  }
  if (tage < -1 && tage >= -13) return `vor ${-tage} Tagen`;
  const gleichesJahr = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(regionLocale(), gleichesJahr
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" });
}

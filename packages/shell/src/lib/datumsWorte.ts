/** A date in words — the single shared implementation.
 *
 * Why shared: apps used to phrase the same day differently (e.g. "Do., 20. Aug."
 * in one place and "20. August 2026" in another). One helper keeps the wording
 * consistent across the whole shell.
 *
 * Important: the calculation works at DAY granularity. Comparing milliseconds
 * would turn a task due today at 9:00 into "yesterday" at 10:00.
 */
import { i18n, regionLocale } from "@claraos/core";

/** Distance in whole days: today = 0, tomorrow = 1, yesterday = −1. */
export function tagesDiff(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const heute = new Date();
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const b = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate()).getTime();
  return Math.round((a - b) / 86400000);
}

/** "Today", "Tomorrow", "Yesterday", "Thu, Aug 20", "3 days ago", "Aug 20, 2027"
 *  (words in the UI language, dates in the region format).
 *  Empty string if the date cannot be parsed. */
export function datumInWorten(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const tage = tagesDiff(iso);
  if (tage === null) return "";
  if (tage === 0) return i18n.t("common:dateWords.today");
  if (tage === 1) return i18n.t("common:dateWords.tomorrow");
  if (tage === -1) return i18n.t("common:dateWords.yesterday");
  // The coming week with weekday — that is what people actually ask for day to day.
  if (tage > 1 && tage <= 7) {
    return d.toLocaleDateString(regionLocale(), { weekday: "short", day: "numeric", month: "short" });
  }
  if (tage < -1 && tage >= -13) return i18n.t("common:dateWords.daysAgo", { count: -tage });
  const gleichesJahr = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(regionLocale(), gleichesJahr
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" });
}

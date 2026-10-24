/** The ONE place where values become text.
 *
 * Why this exists: the same collection used to show three date formats at once.
 *   · Table cell      `07/20/2026`  — `<input type="date">` uses the BROWSER's
 *     format, not the app's, so there was no control over it at all.
 *   · Mobile card     `2026-07-20`  — `propDisplay` simply returned `String(value)`.
 *   · Modified column `17.8.2026`   — `toLocaleDateString("de-DE")`.
 * Numbers also went through `String()`: no thousands separator, no unit.
 *
 * Rule: anything that displays a value calls in here. Nothing formats on its
 * own, and no input field doubles as a display.
 */
import { regionLocale } from "@claraos/core";


/** Date as "20. Juli 2026". Unparseable input is returned unchanged. */
export function formatDatum(wert: unknown, lang = true): string {
  const s = String(wert ?? "").trim();
  if (!s) return "";
  const d = new Date(s.length <= 10 ? `${s}T00:00:00` : s);
  if (Number.isNaN(d.getTime())) return s;      // raw is better than wrong
  return d.toLocaleDateString(regionLocale(), lang
    ? { day: "numeric", month: "long", year: "numeric" }
    : { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Short form for narrow columns: "20.07.2026". */
export function formatDatumKurz(wert: unknown): string {
  return formatDatum(wert, false);
}

/** Number with German separators; integers without decimals. */
export function formatZahl(wert: unknown, einheit?: string): string {
  const n = typeof wert === "number" ? wert : Number(String(wert ?? "").replace(",", "."));
  if (!Number.isFinite(n)) return String(wert ?? "");
  const txt = n.toLocaleString(regionLocale(), {
    minimumFractionDigits: 0,
    maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
  });
  return einheit ? `${txt} ${einheit}` : txt;
}

/** Timestamp for metadata ("17.08.2026"). */
export function formatZeitpunkt(wert: unknown): string {
  return formatDatumKurz(wert);
}

/** What a cell shows when it is empty. */
export const LEER = "—";

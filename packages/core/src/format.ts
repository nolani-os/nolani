/**
 * Formatting according to user preferences.
 *
 * KDE separates language and formats into two axes — and that is exactly the
 * part that works right away without translation infrastructure: numbers,
 * dates, times, currency and file sizes follow the region while the UI
 * language stays unchanged.
 *
 * Pure functions over `Intl` — no store access, hence testable in Node.
 */

export interface FormatPrefs {
  locale: string;
  /** "region" follows the locale, otherwise forced */
  timeFormat: "region" | "24h" | "12h";
  firstDayOfWeek: "region" | "monday" | "sunday";
  currency: string;
  binaryDialect: "iec" | "metric" | "jedec";
}

export const DEFAULT_FORMAT_PREFS: FormatPrefs = {
  locale: "de-DE",
  timeFormat: "region",
  firstDayOfWeek: "region",
  currency: "EUR",
  binaryDialect: "iec",
};

export function formatNumber(value: number, p: FormatPrefs, digits?: number): string {
  return new Intl.NumberFormat(p.locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits ?? 3,
  }).format(value);
}

export function formatCurrency(value: number, p: FormatPrefs): string {
  return new Intl.NumberFormat(p.locale, {
    style: "currency",
    currency: p.currency || "EUR",
  }).format(value);
}

export function formatDate(date: Date, p: FormatPrefs, style: "short" | "medium" | "long" = "medium"): string {
  return new Intl.DateTimeFormat(p.locale, { dateStyle: style }).format(date);
}

export function formatTime(date: Date, p: FormatPrefs, withSeconds = false): string {
  const opts: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  };
  if (p.timeFormat === "24h") opts.hour12 = false;
  if (p.timeFormat === "12h") opts.hour12 = true;
  return new Intl.DateTimeFormat(p.locale, opts).format(date);
}

export function formatDateTime(date: Date, p: FormatPrefs): string {
  return `${formatDate(date, p, "short")}, ${formatTime(date, p)}`;
}

/**
 * Weekday on which the week starts: 0 = Sunday … 6 = Saturday.
 * "region" uses the locale information where the browser provides it,
 * otherwise Monday (the European expectation — Sunday would be the surprise).
 */
export function firstDayOfWeek(p: FormatPrefs): number {
  if (p.firstDayOfWeek === "monday") return 1;
  if (p.firstDayOfWeek === "sunday") return 0;
  try {
    const loc = new Intl.Locale(p.locale) as Intl.Locale & {
      weekInfo?: { firstDay: number };
      getWeekInfo?: () => { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7; // Intl: 1=Mon … 7=Sun
  } catch {
    /* older engine — default below */
  }
  return 1;
}

const UNITS = {
  iec: { base: 1024, names: ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] },
  jedec: { base: 1024, names: ["B", "KB", "MB", "GB", "TB", "PB"] },
  metric: { base: 1000, names: ["B", "kB", "MB", "GB", "TB", "PB"] },
} as const;

/** File size in the chosen dialect (IEC/JEDEC/metric). */
export function formatBytes(bytes: number, p: FormatPrefs): string {
  const { base, names } = UNITS[p.binaryDialect] ?? UNITS.iec;
  if (!Number.isFinite(bytes)) return "—";
  const sign = bytes < 0 ? "-" : "";
  let n = Math.abs(bytes);
  let i = 0;
  while (n >= base && i < names.length - 1) {
    n /= base;
    i++;
  }
  // Whole values without decimals ("1 KiB", not "1.0 KiB"), fractional ones
  // with one decimal as long as they are small ("1.5 KiB").
  const digits = i === 0 || Number.isInteger(n) ? 0 : n < 10 ? 1 : 0;
  return `${sign}${formatNumber(n, p, digits)} ${names[i]}`;
}

/** Relative time ("3 minutes ago"), falls back to a date. */
export function formatRelative(date: Date, p: FormatPrefs, now = new Date()): string {
  const diffSec = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(p.locale, { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(diffSec), "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 7 * 86400) return rtf.format(Math.round(diffSec / 86400), "day");
  return formatDate(date, p, "medium");
}

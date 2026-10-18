/** KPI status states: a single source for color, icon and text.
 *
 * "Blind" is deliberately its own GRAY state, not green: the most common
 * failure is not a missed target but a measurement that has gone stale. The
 * rule lives in services/kpi_progress.py; the UI recomputes nothing, it only
 * colors. */
import type { KpiStatus } from "./types";
import type { IconName } from "../../components/Icon";

export interface StatusDef {
  key: KpiStatus;
  label: string;
  /** Legacy: emoji. Kept as a fallback where plain text is still expected. */
  icon: string;
  /** Drawn icon: distinguishable EVEN without color. */
  iconName: IconName;
  color: string;
}

export const KPI_STATUS: StatusDef[] = [
  { key: "done", label: "Erreicht", icon: "✅", iconName: "done", color: "#16a34a" },
  { key: "on_track", label: "Auf Kurs", icon: "🟢", iconName: "on_track", color: "#22c55e" },
  { key: "at_risk", label: "Wackelt", icon: "🟡", iconName: "at_risk", color: "#eab308" },
  { key: "blind", label: "Blind", icon: "⚪", iconName: "blind", color: "#94a3b8" },
  { key: "behind", label: "Hinterher", icon: "🔴", iconName: "behind", color: "#ef4444" },
  // Important: "observing" is NOT "blind". The KPI is measuring but still
  // collecting baseline values. Without this entry `statusOf()` fell back to
  // "Blind" and mislabeled exactly the distinction that matters.
  { key: "observing", label: "In Beobachtung", icon: "🔵", iconName: "blind", color: "#38bdf8" },
];

export const STATUS_BY_KEY: Record<string, StatusDef> =
  Object.fromEntries(KPI_STATUS.map((s) => [s.key, s]));

export function statusOf(key: string | null | undefined): StatusDef {
  return STATUS_BY_KEY[key ?? "blind"] ?? STATUS_BY_KEY.blind;
}

/** Status color as a CSS variable instead of a fixed value.
 *
 * The values in `KPI_STATUS` above are the DARK-MODE variant. On a light
 * background they fail text contrast (measured: yellow 1.92:1, green 2.28:1;
 * 4.5:1 is required). No single color satisfies both (it must be dark for
 * white and light for black). So the concrete value comes from the stylesheet,
 * which knows the mode; the value here remains as a fallback.
 */
export function statusColor(key: string | null | undefined): string {
  const s = statusOf(key);
  return `var(--kpi-st-${s.key}, ${s.color})`;
}

/** Human-friendly number: no 12 decimals, but no invented zeros either. */
export function fmtNum(v: number | null | undefined, unit = ""): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  const s = v.toLocaleString("de-DE", { maximumFractionDigits: digits });
  return unit ? `${s} ${unit}` : s;
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${Math.round(v * 100)} %`;
}

/** Human-friendly deadline: `2026-12-31` → `31.12.26`.
 *
 * On phones the ISO date wrapped over THREE lines ("bis / 2026- / 12-31") and
 * made the row three times as tall, for secondary information. The short form
 * with a two-digit year fits on one line and is unambiguous enough in practice.
 * Unparseable input is returned unchanged instead of silently disappearing. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1].slice(2)}`;
}

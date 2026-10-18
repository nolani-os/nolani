/** Calendar layout — pure functions (no React): week grid, time snapping,
 * overlap layout (greedy columns + clusters, classic two-pass). */
import type { CalEventFull } from "../../api";

export const MS_DAY = 86400000;

export function ymdOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Monday of d's week (local time). */
export function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const wd = (x.getDay() + 6) % 7; // Mon=0
  x.setDate(x.getDate() - wd);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function snapTo15(minutes: number): number {
  return Math.max(0, Math.min(24 * 60 - 15, Math.round(minutes / 15) * 15));
}

/** Minutes since midnight (local) of an ISO timestamp on a given day;
 * clipped to [0, 1440] if the event extends beyond the day. */
export function minutesOnDay(iso: string, dayKey: string): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  const key = ymdOf(d);
  if (key === dayKey) return d.getHours() * 60 + d.getMinutes();
  return key < dayKey ? 0 : 1440;
}

export interface PlacedEvent {
  ev: CalEventFull;
  startMin: number; // clipped to the day
  endMin: number;
  col: number;
  cols: number; // column count of the cluster
}

/** Lay out a day's timed events in columns. O(n log n). */
export function layoutDay(events: CalEventFull[], dayKey: string): PlacedEvent[] {
  const items = events
    .map((ev) => {
      const s = minutesOnDay(ev.start, dayKey);
      let e = ev.end ? minutesOnDay(ev.end, dayKey) : null;
      if (s == null) return null;
      if (e == null || e <= s) e = s + 30;
      return { ev, startMin: s, endMin: Math.min(e, 1440) };
    })
    .filter((x): x is { ev: CalEventFull; startMin: number; endMin: number } => x !== null)
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  const placed: PlacedEvent[] = [];
  let cluster: PlacedEvent[] = [];
  let colEnd: number[] = [];
  let clusterEnd = -1;

  const flush = () => {
    const cols = colEnd.length || 1;
    cluster.forEach((p) => { p.cols = cols; });
    placed.push(...cluster);
    cluster = [];
    colEnd = [];
  };

  for (const it of items) {
    if (cluster.length > 0 && it.startMin >= clusterEnd) flush();
    let col = colEnd.findIndex((end) => end <= it.startMin);
    if (col === -1) {
      col = colEnd.length;
      colEnd.push(it.endMin);
    } else {
      colEnd[col] = it.endMin;
    }
    cluster.push({ ...it, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  flush();
  return placed;
}

/** Distribute a range's events by day (multi-day events appear on every day). */
export function eventsByDay(events: CalEventFull[], days: string[]): Map<string, CalEventFull[]> {
  const m = new Map<string, CalEventFull[]>();
  days.forEach((d) => m.set(d, []));
  for (const ev of events) {
    if (!ev.start) continue;
    const startKey = ev.all_day ? ev.start.slice(0, 10) : ymdOf(new Date(ev.start));
    let endKey = startKey;
    if (ev.end) {
      if (ev.all_day) {
        // DTEND is exclusive → last day = end - 1
        const e = new Date(`${ev.end.slice(0, 10)}T00:00:00`);
        e.setDate(e.getDate() - 1);
        endKey = ymdOf(e);
      } else {
        const e = new Date(ev.end);
        // Ends exactly at midnight do not count toward the next day
        if (e.getHours() === 0 && e.getMinutes() === 0 && ymdOf(e) > startKey) e.setMinutes(-1);
        endKey = ymdOf(e);
      }
    }
    if (endKey < startKey) endKey = startKey;
    for (const day of days) {
      if (day >= startKey && day <= endKey) m.get(day)!.push(ev);
    }
  }
  return m;
}

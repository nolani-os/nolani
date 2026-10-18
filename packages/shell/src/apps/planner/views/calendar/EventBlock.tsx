/** Positioned event block in the time grid — Outlook look via the left
 * edge: free = hollow, busy = solid colour, tentative = hatched,
 * out of office = violet. */
import styles from "../../PlannerApp.module.css";
import { Icon } from "../../../../components/Icon";
import type { CalEventFull } from "../../api";
import type { PlacedEvent } from "./calLayout";

const BUSY_CLASS: Record<string, string> = {
  free: "evFree",
  tentative: "evTentative",
  oof: "evOof",
  busy: "",
};

export function busyClassOf(ev: CalEventFull): string {
  const key = BUSY_CLASS[ev.busy_status] ?? "";
  const klassen = key ? [(styles as Record<string, string>)[key] ?? ""] : [];
  // Warning: when the organiser cancels, Sabre delivers the cancellation to
  //    the invitee (STATUS:CANCELLED) — but ClaraOS kept showing the event
  //    unchanged. Important: showing up to a cancelled meeting is not a display
  //    bug, it's a lost morning. This function is the only place that decides
  //    on the rendering — which is why it lives here and not in each view.
  if (ev.cancelled) klassen.push(styles.evAbgesagt ?? "");
  return klassen.filter(Boolean).join(" ");
}

export function eventTimeLabel(ev: CalEventFull): string {
  if (ev.all_day) return "ganztägig";
  const f = (iso: string) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return `${f(ev.start)}${ev.end ? `–${f(ev.end)}` : ""}`;
}

export function EventBlock({
  placed, hourPx, onClick, onMoveStart, onResizeStart,
}: {
  placed: PlacedEvent;
  hourPx: number;
  onClick: (ev: CalEventFull) => void;
  onMoveStart?: (e: React.PointerEvent, placed: PlacedEvent) => void;
  onResizeStart?: (e: React.PointerEvent, placed: PlacedEvent) => void;
}) {
  const { ev, startMin, endMin, col, cols } = placed;
  const top = (startMin / 60) * hourPx;
  const height = Math.max(((endMin - startMin) / 60) * hourPx, 18);
  const width = 100 / cols;
  const draggable = !ev.is_recurring && !!onMoveStart;
  return (
    <div
      className={`${styles.evBlock} ${busyClassOf(ev)}`}
      style={{
        top, height,
        left: `${col * width}%`, width: `calc(${width}% - 2px)`,
        borderLeftColor: ev.color || undefined,
        cursor: draggable ? "grab" : "pointer",
      }}
      title={`${ev.summary} (${ev.calendar}) — ${eventTimeLabel(ev)}${ev.is_recurring ? " · Serie (im Editor ändern)" : ""}`}
      onClick={(e) => { e.stopPropagation(); onClick(ev); }}
      onPointerDown={(e) => draggable && onMoveStart!(e, placed)}
    >
      <span className={styles.evTime}>{eventTimeLabel(ev)}</span>
      <span className={styles.evTitle}>
        {ev.task_id != null ? <Icon name="collections" size={11} /> : null}{ev.is_recurring ? <Icon name="repeat" size={11} /> : null}
        {ev.attendees.length > 0 ? <Icon name="people" size={11} /> : null}{ev.summary}
      </span>
      {onResizeStart && !ev.is_recurring && (
        <div className={styles.evResizeHandle}
             onPointerDown={(e) => { e.stopPropagation(); onResizeStart(e, placed); }} />
      )}
    </div>
  );
}

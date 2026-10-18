/** Shared Planner building blocks: date helpers (native, no dayjs — house style),
 * TaskRow for list views, label chips, priority badge. */

import { useState } from "react";
import styles from "./PlannerApp.module.css";
import { Icon } from "../../components/Icon";
import { PopupMenu } from "../../components/PopupMenu";
import { Chip } from "../../components/Chip";
import { hasDate, type VikTask } from "./types";
import { checklistProgress, parseChecklist } from "./checklist";
import { datumInWorten } from "../../lib/datumsWorte";

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Due date, the way a person would say it.
 *
 * Important: the wording itself lives in `lib/datumsWorte.ts` — the knowledge
 * home page uses the same phrasing. Previously the Planner said
 * "Do., 20. Aug." and the home page said "20. August 2026" for the same day.
 */
export const dueLabel = (iso?: string): string =>
  hasDate(iso) ? datumInWorten(iso) : "";

export function isOverdue(t: VikTask): boolean {
  if (t.done || !hasDate(t.due_date)) return false;
  return new Date(t.due_date!).getTime() < Date.now() && ymd(new Date(t.due_date!)) !== ymd(new Date());
}

export function isDueToday(t: VikTask): boolean {
  return !t.done && hasDate(t.due_date) && ymd(new Date(t.due_date!)) === ymd(new Date());
}

/** Cost formatter (lifted from CostsView — TaskDetail/overview use it too). */
/** Warning: this used `toFixed`, which writes American style — the cost
 *  view read "0.0000 €". Dot instead of comma, and four decimal places for
 *  zero are pure noise. The four places remain where they are needed (token
 *  fractions below 1 cent), but never for a plain zero. */
export function fmtEur(v: number | null | undefined): string {
  if (v == null) return "—";
  const stellen = v !== 0 && Math.abs(v) < 0.01 ? 4 : 2;
  return v.toLocaleString("de-DE", {
    style: "currency", currency: "EUR",
    minimumFractionDigits: stellen, maximumFractionDigits: stellen,
  });
}
export function fmtTokens(v: number | null | undefined): string {
  return v == null ? "—" : v.toLocaleString("de-DE");
}
export function fmtMins(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v < 60) return `${Math.round(v)} min`;
  const h = Math.floor(v / 60);
  return `${h} h ${Math.round(v % 60)} min`;
}

const PRIO_LABELS: Record<number, string> = { 3: "Hoch", 4: "Dringend", 5: "SOFORT" };

export function PrioBadge({ priority }: { priority?: number }) {
  if (!priority || priority < 3) return null;
  return (
    <span className={`${styles.prioBadge} ${priority >= 4 ? styles.prioUrgent : ""}`}>
      <Icon name="flag" size={13} /> {PRIO_LABELS[priority] ?? priority}
    </span>
  );
}

export function LabelChips({ task }: { task: VikTask }) {
  if (!task.labels?.length) return null;
  return (
    <span className={styles.labelChips}>
      {task.labels.map((l) => (
        <span
          key={l.id}
          className={styles.labelChip}
          style={l.hex_color ? { borderColor: `#${l.hex_color}`, color: `#${l.hex_color}` } : undefined}
        >
          {l.title}
        </span>
      ))}
    </span>
  );
}

export function ChecklistBadge({ task }: { task: VikTask }) {
  const { items } = parseChecklist(task.description);
  if (!items.length) return null;
  const p = checklistProgress(items);
  return (
    <span className={styles.metaBadge} title="Checkliste">
      <Icon name="done" size={13} /> {p.done}/{p.total}
    </span>
  );
}

export function InWorkBadge({ task }: { task: VikTask }) {
  if (!task._meta?.in_work_by) return null;
  return (
    <span className={styles.inWorkBadge} title={`in Arbeit seit ${task._meta.in_work_since ?? "?"}`}>
      ● {task._meta.in_work_by === "clara" || task._meta.in_work_by === "clara-agent" ? "Clara arbeitet" : task._meta.in_work_by}
    </span>
  );
}

function toLocalDateInput(iso?: string): string {
  if (!hasDate(iso)) return "";
  return ymd(new Date(iso!));
}

/** Set the due date to a day while keeping the time (otherwise 18:00). */
function mitUhrzeit(tag: Date, bisher?: string): string {
  const prev = hasDate(bisher) ? new Date(bisher!) : null;
  const d = new Date(tag);
  d.setHours(prev?.getHours() ?? 18, prev?.getMinutes() ?? 0, 0, 0);
  return d.toISOString();
}

const KEIN_DATUM = "0001-01-01T00:00:00Z";
const PRIOS: { wert: number; label: string }[] = [
  { wert: 0, label: "Keine" }, { wert: 1, label: "Niedrig" }, { wert: 2, label: "Mittel" },
  { wert: 3, label: "Hoch" }, { wert: 4, label: "Dringend" }, { wert: 5, label: "SOFORT" },
];

/** Warning: EVERY row used to contain a native `<select>` and an
 * `<input type="date">` — forty controls for twenty tasks, and the date was
 * shown in the BROWSER's format, not ours. The same disease the knowledge
 * table used to have.
 * Now: a badge that DISPLAYS the value, and only a click opens the picker.
 * The menu is `components/PopupMenu` — the house menu, not a third custom one. */
function PrioPlakette({ task, onInlineEdit }: {
  task: VikTask; onInlineEdit: (t: VikTask, patch: Partial<VikTask>) => void;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const p = task.priority ?? 0;
  return (
    <>
      <Chip
        className={p >= 4 ? styles.prioUrgent : p >= 3 ? styles.prioHoch : ""}
        title="Priorität ändern"
        icon={p >= 1 ? <Icon name="flag" size={12} /> : undefined}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPos({ x: r.left, y: r.bottom + 4 });
        }}
      >
        {p >= 1 ? PRIOS[p].label : <span className={styles.zellLeer}>Prio</span>}
      </Chip>
      {pos && (
        <PopupMenu
          x={pos.x} y={pos.y}
          onClose={() => setPos(null)}
          items={PRIOS.map((o) => ({
            id: String(o.wert),
            label: o.label,
            checked: p === o.wert,
            onSelect: () => onInlineEdit(task, { priority: o.wert }),
          }))}
        />
      )}
    </>
  );
}

function DuePlakette({ task, onInlineEdit }: {
  task: VikTask; onInlineEdit: (t: VikTask, patch: Partial<VikTask>) => void;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [kalender, setKalender] = useState(false);
  const overdue = isOverdue(task);
  const setzen = (tage: number) => {
    const d = new Date();
    d.setDate(d.getDate() + tage);
    onInlineEdit(task, { due_date: mitUhrzeit(d, task.due_date) });
  };
  // Next Monday — in everyday use that is exactly what "next week" means.
  const naechsterMontag = () => {
    const d = new Date();
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    onInlineEdit(task, { due_date: mitUhrzeit(d, task.due_date) });
  };

  if (kalender) {
    // Important: ONE native date field — but only once someone says "pick date",
    // not permanently in twenty rows.
    return (
      <input
        type="date"
        autoFocus
        className={styles.inlineDate}
        value={toLocalDateInput(task.due_date)}
        onBlur={() => setKalender(false)}
        onChange={(e) => {
          if (!e.target.value) onInlineEdit(task, { due_date: KEIN_DATUM });
          else onInlineEdit(task, { due_date: mitUhrzeit(new Date(`${e.target.value}T00:00:00`), task.due_date) });
          setKalender(false);
        }}
      />
    );
  }
  return (
    <>
      <Chip
        className={overdue ? styles.overdue : ""}
        title="Fälligkeit ändern"
        icon={hasDate(task.due_date) ? <Icon name="calendar" size={12} /> : undefined}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPos({ x: r.left, y: r.bottom + 4 });
        }}
      >
        {hasDate(task.due_date)
          ? dueLabel(task.due_date)
          : <span className={styles.zellLeer}>Kein Datum</span>}
      </Chip>
      {pos && (
        <PopupMenu
          x={pos.x} y={pos.y}
          onClose={() => setPos(null)}
          items={[
            { id: "heute", label: "Heute", icon: "•", onSelect: () => setzen(0) },
            { id: "morgen", label: "Morgen", icon: "›", onSelect: () => setzen(1) },
            { id: "woche", label: "Nächsten Montag", icon: "»", onSelect: naechsterMontag },
            { id: "sep", label: "---" },
            { id: "waehlen", label: "Datum wählen…", onSelect: () => setKalender(true) },
            {
              id: "keins", label: "Kein Datum", variant: "destructive" as const,
              disabled: !hasDate(task.due_date),
              onSelect: () => onInlineEdit(task, { due_date: KEIN_DATUM }),
            },
          ]}
        />
      )}
    </>
  );
}

export function TaskRow({
  task, projectTitle, onToggle, onOpen, selected, onSelectToggle, onInlineEdit,
}: {
  task: VikTask;
  projectTitle?: string;
  onToggle: (t: VikTask) => void;
  onOpen: (t: VikTask) => void;
  /** Tasks view v2 (optional, additive): multi-select + inline edit. */
  selected?: boolean;
  onSelectToggle?: (t: VikTask) => void;
  onInlineEdit?: (t: VikTask, patch: Partial<VikTask>) => void;
}) {
  const overdue = isOverdue(task);
  return (
    <div className={`${styles.taskRow} ${task.done ? styles.taskDone : ""} ${selected ? styles.taskRowSelected : ""}`}>
      {onSelectToggle && (
        <input
          type="checkbox"
          className={styles.selectCheck}
          checked={!!selected}
          title="Auswählen"
          onClick={(e) => e.stopPropagation()}
          onChange={() => onSelectToggle(task)}
        />
      )}
      <button
        className={`${styles.checkBtn} ${task.done ? styles.checkBtnDone : ""}`}
        title={task.done ? "Als offen markieren" : "Erledigen"}
        onClick={(e) => { e.stopPropagation(); onToggle(task); }}
      >
        {task.done ? <Icon name="check" size={14} /> : null}
      </button>
      <div className={styles.taskRowMain} onClick={() => onOpen(task)}>
        <div className={styles.taskRowTitle}>
          {task.title}
          {!onInlineEdit && <PrioBadge priority={task.priority} />}
          <InWorkBadge task={task} />
        </div>
        <div className={styles.taskRowSub}>
          {projectTitle && <span className={styles.metaBadge}>{projectTitle}</span>}
          {onInlineEdit ? (
            <span className={styles.inlineEdits} onClick={(e) => e.stopPropagation()}>
              <PrioPlakette task={task} onInlineEdit={onInlineEdit} />
              <DuePlakette task={task} onInlineEdit={onInlineEdit} />
            </span>
          ) : (
            hasDate(task.due_date) && (
              <span className={`${styles.metaBadge} ${overdue ? styles.overdue : ""}`}>
                <Icon name="calendar" size={12} /> {dueLabel(task.due_date)}
              </span>
            )
          )}
          {!!task.repeat_after && <span className={styles.metaBadge} title="wiederkehrend"><Icon name="repeat" size={12} title="wiederkehrend" /></span>}
          <ChecklistBadge task={task} />
          <LabelChips task={task} />
        </div>
      </div>
    </div>
  );
}

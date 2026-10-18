/** Collapsible task sidebar for time-blocking: drag open tasks
 * (dataTransfer "claraos/task" = "taskId:projectId:estimateMinutes") onto
 * a time slot. */
import { useMemo, useState } from "react";
import styles from "../../PlannerApp.module.css";
import { hasDate, type VikTask } from "../../types";
import { dueLabel } from "../../shared";

export function TaskSidebar({
  tasks, onOpenTask,
}: {
  tasks: VikTask[];
  onOpenTask: (t: VikTask) => void;
}) {
  const [open, setOpen] = useState(true);
  const openTasks = useMemo(() =>
    tasks.filter((t) => !t.done).sort((a, b) =>
      (hasDate(a.due_date) ? a.due_date! : "9999").localeCompare(hasDate(b.due_date) ? b.due_date! : "9999")),
    [tasks]);

  if (!open) {
    return (
      <button className={styles.taskSidebarToggle} title="Aufgaben-Leiste öffnen" onClick={() => setOpen(true)}>
        ◂ Aufgaben
      </button>
    );
  }
  return (
    <aside className={styles.taskSidebar}>
      <div className={styles.taskSidebarHead}>
        <span>Aufgaben einplanen</span>
        <button className={styles.btn} title="Einklappen" onClick={() => setOpen(false)}>▸</button>
      </div>
      <div className={styles.taskSidebarHint}>Auf einen Zeit-Slot ziehen</div>
      <div className={styles.taskSidebarList}>
        {openTasks.map((t) => (
          <div key={t.id}
               className={styles.taskSidebarItem}
               draggable
               onDragStart={(e) => {
                 e.dataTransfer.setData("claraos/task",
                   `${t.id}:${t.project_id}:${t._meta?.estimate_minutes ?? 60}`);
                 e.dataTransfer.effectAllowed = "copy";
               }}
               onClick={() => onOpenTask(t)}
               title={t.title}>
            <span className={styles.taskSidebarTitle}>
              {t._meta?.event_uid ? "🗂️ " : "○ "}{t.title}
            </span>
            {hasDate(t.due_date) && <span className={styles.metaBadge}>📅 {dueLabel(t.due_date)}</span>}
          </div>
        ))}
        {openTasks.length === 0 && <div className={styles.empty}>Keine offenen Aufgaben.</div>}
      </div>
    </aside>
  );
}

/** Collapsible task sidebar for time-blocking: drag open tasks
 * (dataTransfer "claraos/task" = "taskId:projectId:estimateMinutes") onto
 * a time slot. */
import { useMemo, useState } from "react";
import styles from "../../PlannerApp.module.css";
import { hasDate, type VikTask } from "../../types";
import { dueLabel } from "../../shared";
import { useTranslation } from "@claraos/core";

export function TaskSidebar({
  tasks, onOpenTask,
}: {
  tasks: VikTask[];
  onOpenTask: (t: VikTask) => void;
}) {
  const { t } = useTranslation("planner");
  const [open, setOpen] = useState(true);
  const openTasks = useMemo(() =>
    tasks.filter((task) => !task.done).sort((a, b) =>
      (hasDate(a.due_date) ? a.due_date! : "9999").localeCompare(hasDate(b.due_date) ? b.due_date! : "9999")),
    [tasks]);

  if (!open) {
    return (
      <button className={styles.taskSidebarToggle} title={t("calendar.sidebar.open")} onClick={() => setOpen(true)}>
        ◂ {t("calendar.sidebar.tasks")}
      </button>
    );
  }
  return (
    <aside className={styles.taskSidebar}>
      <div className={styles.taskSidebarHead}>
        <span>{t("calendar.sidebar.title")}</span>
        <button className={styles.btn} title={t("calendar.sidebar.collapse")} onClick={() => setOpen(false)}>▸</button>
      </div>
      <div className={styles.taskSidebarHint}>{t("calendar.sidebar.hint")}</div>
      <div className={styles.taskSidebarList}>
        {openTasks.map((task) => (
          <div key={task.id}
               className={styles.taskSidebarItem}
               draggable
               onDragStart={(e) => {
                 e.dataTransfer.setData("claraos/task",
                   `${task.id}:${task.project_id}:${task._meta?.estimate_minutes ?? 60}`);
                 e.dataTransfer.effectAllowed = "copy";
               }}
               onClick={() => onOpenTask(task)}
               title={task.title}>
            <span className={styles.taskSidebarTitle}>
              {task._meta?.event_uid ? "🗂️ " : "○ "}{task.title}
            </span>
            {hasDate(task.due_date) && <span className={styles.metaBadge}>📅 {dueLabel(task.due_date)}</span>}
          </div>
        ))}
        {openTasks.length === 0 && <div className={styles.empty}>{t("calendar.sidebar.empty")}</div>}
      </div>
    </aside>
  );
}

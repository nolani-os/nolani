/** My Day — Microsoft To Do feel: overdue / due today / in progress. */
import { useMemo, useState, useRef, useEffect } from "react";
import styles from "../PlannerApp.module.css";
import { Icon } from "../../../components/Icon";
import { IconButton } from "../../../components/Button";
import { plannerApi } from "../api";
import type { VikTask } from "../types";
import { TaskRow, isDueToday, isOverdue } from "../shared";
import { regionLocale, useTranslation } from "@claraos/core";

export function MyDayView({
  tasks, projectTitles, onToggle, onOpen, onReload,
}: {
  tasks: VikTask[];
  projectTitles: Map<number, string>;
  onToggle: (t: VikTask) => void;
  onOpen: (t: VikTask) => void;
  onReload: () => void;
}) {
  const { t } = useTranslation("planner");
  const [quickTitle, setQuickTitle] = useState("");
  // "New task" FAB of the phone toolbar → put the cursor here.
  const eingabe = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const auf = () => { eingabe.current?.focus(); eingabe.current?.scrollIntoView({ block: "center" }); };
    window.addEventListener("claraos-planner-neu", auf);
    return () => window.removeEventListener("claraos-planner-neu", auf);
  }, []);
  const [busy, setBusy] = useState(false);

  const overdue = useMemo(() => tasks.filter(isOverdue), [tasks]);
  const today = useMemo(() => tasks.filter(isDueToday), [tasks]);
  const inWork = useMemo(
    () => tasks.filter((t) => !t.done && t._meta?.in_work_by),
    [tasks],
  );

  const addQuick = async () => {
    const title = quickTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      // Inbox = the user's first project (Vikunja creates "Inbox"); due today.
      const projects = await plannerApi.listProjects();
      const inbox = projects.find((p) => p.title.toLowerCase() === "inbox") ?? projects[0];
      if (!inbox) throw new Error(t("errors.noProject"));
      const due = new Date();
      due.setHours(18, 0, 0, 0);
      await plannerApi.createTask(inbox.id, { title, due_date: due.toISOString() });
      setQuickTitle("");
      onReload();
    } finally {
      setBusy(false);
    }
  };

  const section = (label: string, items: VikTask[], cls?: string) =>
    items.length > 0 && (
      <section className={styles.section}>
        <h3 className={`${styles.sectionTitle} ${cls ?? ""}`}>{label} <span className={styles.count}>{items.length}</span></h3>
        {items.map((task) => (
          <TaskRow key={task.id} task={task} projectTitle={projectTitles.get(task.project_id)}
                   onToggle={onToggle} onOpen={onOpen} />
        ))}
      </section>
    );

  const empty = !overdue.length && !today.length && !inWork.length;

  return (
    <div className={styles.view}>
      <header className={styles.viewHeader}>
        <h2><Icon name="today" size={18} /> {t("nav.myDay")}</h2>
        <span className={styles.viewSub}>
          {new Date().toLocaleDateString(regionLocale(), { weekday: "long", day: "numeric", month: "long" })}
        </span>
      </header>
      <div className={styles.quickAdd}>
        <input
          ref={eingabe}
          className={styles.input}
          placeholder={t("myDay.quickAddPlaceholder")}
          value={quickTitle}
          onChange={(e) => setQuickTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addQuick()}
        />
        <IconButton label={t("task.add")} icon="arrowRight" stufe="filled" groesse="s"
                    disabled={!quickTitle.trim() || busy} onClick={addQuick} />
      </div>
      {section(t("dates.overdue"), overdue, styles.overdue)}
      {section(t("dates.today"), today)}
      {section(t("myDay.inWork"), inWork)}
      {empty && <div className={styles.empty}>{t("myDay.empty")}</div>}
    </div>
  );
}

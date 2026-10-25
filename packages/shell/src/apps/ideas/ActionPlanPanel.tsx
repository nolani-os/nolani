/** Action plan of a goal.
 *
 * Shows only what is in the planner; nothing is mirrored here. Status, due
 * date and assignee live exclusively in Vikunja; the ideas suite holds the
 * link and the "why".
 *
 * Task progress is deliberately shown NEXT TO KPI progress and not combined
 * with it: "80 % of tasks done, but only 20 % of the goal reached" is exactly
 * the information you want to see. */
import { useCallback, useEffect, useState } from "react";
import styles from "./IdeasApp.module.css";
import { Icon } from "../../components/Icon";
import { ideasApi } from "./api";
import type { ActionPlan } from "./types";
import { useWindowsStore, useTranslation, i18n } from "@claraos/core";
import { dispatchLocalAction } from "../../Chat/actionBus";
import { regionLocale } from "@claraos/core";

interface Props {
  goalId: string;
  canEdit: boolean;
  /** Increments when something was changed externally. */
  reloadTick?: number;
}

/** Open the planner and jump straight to the right project.
 *  The window is opened, then the existing action handler
 *  `planner.open_project` takes over; it also works if the window was already open. */
function openInPlanner(projectId: number | null, taskId?: number) {
  useWindowsStore.getState().openWindow("planner");
  setTimeout(() => {
    if (taskId) dispatchLocalAction("planner", "open_task", { task_id: taskId });
    else if (projectId) dispatchLocalAction("planner", "open_project", { project_id: projectId });
  }, 150);
}

export function ActionPlanPanel({ goalId, canEdit, reloadTick }: Props) {
  const { t } = useTranslation("wissen");
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPlan(await ideasApi.actionPlan(goalId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : i18n.t("wissen:actionPlan.loadFailed"));
    }
  }, [goalId]);

  useEffect(() => { void load(); }, [load, reloadTick]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await ideasApi.createActionPlan(goalId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : i18n.t("wissen:actionPlan.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (!plan) return null;

  const nothing = !plan.project_id && plan.total === 0;

  return (
    <div className={styles.planPanel}>
      <div className={styles.planHead}>
        <span><Icon name="plan" size={16} className={styles.inlineIcon} />{t("actionPlan.title")}</span>
        {plan.total > 0 && (
          <span className={styles.metaHint}>
            {t("actionPlan.progress", { done: plan.done, total: plan.total })}
            {plan.next_due && t("actionPlan.nextDue", { date: new Date(plan.next_due).toLocaleDateString(regionLocale()) })}
          </span>
        )}
        {plan.project_id && (
          <button className={styles.linkBtn} onClick={() => openInPlanner(plan.project_id)}>
            {t("actionPlan.openPlanner")}
          </button>
        )}
      </div>

      {/* An unreadable project is not an empty plan; that must be visible. */}
      {plan.warning && <p className={styles.kpiSourceError}><Icon name="warning" size={15} className={styles.inlineIcon} />{plan.warning}</p>}
      {error && <div className={styles.error}>{error}</div>}

      {plan.total > 0 && (
        <div className={styles.planBar} title={t("actionPlan.barTitle", { done: plan.done, total: plan.total })}>
          <span style={{ width: `${(plan.done / plan.total) * 100}%` }} />
        </div>
      )}

      {nothing && (
        <p className={styles.metaHint}>
          {t("actionPlan.none")}{" "}
          {canEdit && (
            <button className={styles.linkBtn} disabled={busy} onClick={() => void create()}>
              {t("actionPlan.createProject")}
            </button>
          )}
        </p>
      )}

      {plan.tasks.length > 0 && (
        <ul className={styles.planTasks}>
          {plan.tasks.slice(0, 6).map((task) => (
            <li key={`${task.project_id}-${task.task_id}`} className={task.done ? styles.planDone : ""}>
              <span><Icon name={task.done ? "done" : "blind"} size={15} /></span>
              <button className={styles.linkBtn} onClick={() => openInPlanner(task.project_id, task.task_id)}>
                {task.title}
              </button>
              {task.missing && <span className={styles.metaHint}>{t("actionPlan.missing")}</span>}
              {canEdit && task.project_id !== plan.project_id && (
                <button className={styles.iconBtn} title={t("actionPlan.unlink")}
                        onClick={async () => {
                          await ideasApi.unlinkTaskFromGoal(goalId, task.project_id, task.task_id);
                          await load();
                        }}><Icon name="close" size={14} title={t("actionPlan.remove")} /></button>
              )}
            </li>
          ))}
          {plan.tasks.length > 6 && (
            <li className={styles.metaHint}>{t("actionPlan.more", { count: plan.tasks.length - 6 })}</li>
          )}
        </ul>
      )}
    </div>
  );
}

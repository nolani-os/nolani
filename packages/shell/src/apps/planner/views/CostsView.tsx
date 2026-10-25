/** Cost/time transparency: actual costs (clara-agent cost_events, per
 * task) vs. estimate (sidecar) + time worked (worklog). Read-only table in
 * house style; estimates are set by Clara via set_estimate or by hand in TaskDetail. */
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "../PlannerApp.module.css";
import { plannerApi } from "../api";
import type { ProjectCosts, TaskCost, VikProject, VikTask } from "../types";
import { i18n, regionLocale, useTranslation } from "@claraos/core";

/** Technical name of the cost-tracking service (not translated). */
const COST_SERVICE = "clara-agent";

function eur(v: number | null | undefined): string {
  return v == null ? "—" : `${v.toFixed(v < 1 ? 4 : 2)} €`;
}
function tok(v: number | null | undefined): string {
  return v == null ? "—" : v.toLocaleString(regionLocale());
}
function mins(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v < 60) return i18n.t("planner:costs.unit.minutes", { value: Math.round(v) });
  const h = Math.floor(v / 60);
  return i18n.t("planner:costs.unit.hoursMinutes", { hours: h, minutes: Math.round(v % 60) });
}

export function CostsView({ project, onOpen }: { project: VikProject; onOpen: (t: VikTask) => void }) {
  const { t } = useTranslation("planner");
  const [costs, setCosts] = useState<ProjectCosts | null>(null);
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [c, tasks] = await Promise.all([
        plannerApi.projectCosts(project.id),
        plannerApi.listProjectTasks(project.id).catch(() => [] as VikTask[]),
      ]);
      setCosts(c);
      setTitles(Object.fromEntries((tasks || []).map((task) => [task.id, task.title])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const totalWorked = useMemo(
    () => (costs?.tasks || []).reduce((s, tc) => s + (tc.worked_minutes || 0), 0),
    [costs],
  );

  if (loading) return <div className={styles.loading}>{t("costs.loading")}</div>;
  if (error) return <div className={styles.errorBox}>{error} <button aria-label={t("costs.reload")} title={t("costs.reload")} onClick={load}>↻</button></div>;
  if (!costs) return null;

  const est = costs.project_estimate;
  const openTask = (tid: number) => {
    // TaskDetail expects a VikTask; the id is enough, the detail loads the rest itself.
    onOpen({ id: tid, title: titles[tid] ?? `#${tid}`, project_id: project.id } as VikTask);
  };

  return (
    <div className={styles.costsWrap}>
      <header className={styles.costsHead}>
        <div className={styles.costsCards}>
          <div className={styles.costCard}>
            <span className={styles.costCardLabel}>{t("costs.project.actual")}</span>
            <span className={styles.costCardValue}>
              {costs.cost_available ? eur(costs.total?.cost_eur ?? 0) : t("costs.unavailable")}
            </span>
            {costs.cost_available && costs.total && (
              <span className={styles.costCardSub}>
                {t("costs.usage", { tokens: tok(costs.total.input_tokens + costs.total.output_tokens), count: costs.total.events })}
              </span>
            )}
          </div>
          <div className={styles.costCard}>
            <span className={styles.costCardLabel}>{t("costs.project.estimate")}</span>
            <span className={styles.costCardValue}>{eur(est?.estimate_eur)}</span>
            <span className={styles.costCardSub}>
              {est?.estimate_minutes != null ? mins(est.estimate_minutes) : "—"} · {t("costs.tokens", { tokens: tok(est?.estimate_tokens) })}
            </span>
          </div>
          <div className={styles.costCard}>
            <span className={styles.costCardLabel}>{t("costs.project.worked")}</span>
            <span className={styles.costCardValue}>{mins(totalWorked)}</span>
            <span className={styles.costCardSub}>{t("costs.project.fromWorklog")}</span>
          </div>
        </div>
        <button className={styles.btn} onClick={load} title={t("costs.refresh")}>↻</button>
      </header>

      {!costs.cost_available && (
        <div className={styles.hint}>
          {t("costs.unavailableHint", { service: COST_SERVICE })}
        </div>
      )}

      {costs.tasks.length === 0 ? (
        <div className={styles.emptyHint}>
          {t("costs.project.empty")}
        </div>
      ) : (
        <div className={styles.costsTableWrap}>
          <table className={styles.costsTable}>
            <thead>
              <tr>
                <th>{t("costs.col.task")}</th>
                <th className={styles.num}>{t("costs.col.actualEur")}</th>
                <th className={styles.num}>{t("costs.col.estimateEur")}</th>
                <th className={styles.num}>{t("costs.col.tokens")}</th>
                <th className={styles.num}>{t("costs.col.time")}</th>
              </tr>
            </thead>
            <tbody>
              {costs.tasks.map((tc: TaskCost) => {
                const over = tc.estimate_eur != null && tc.cost_eur != null && tc.cost_eur > tc.estimate_eur;
                return (
                  <tr key={tc.task_id} className={styles.costRow} onClick={() => openTask(tc.task_id)}>
                    <td className={styles.costTitle}>
                      {titles[tc.task_id] ?? `#${tc.task_id}`}
                      {tc.open_sessions > 0 && <span className={styles.costWorking}>● {t("costs.working")}</span>}
                    </td>
                    <td className={`${styles.num} ${over ? styles.costOver : ""}`}>{eur(tc.cost_eur)}</td>
                    <td className={styles.num}>{eur(tc.estimate_eur)}</td>
                    <td className={styles.num}>
                      {tc.input_tokens != null ? tok((tc.input_tokens || 0) + (tc.output_tokens || 0)) : "—"}
                    </td>
                    <td className={styles.num}>{mins(tc.worked_minutes)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

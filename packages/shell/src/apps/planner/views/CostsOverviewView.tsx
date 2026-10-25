/** Global cost overview — all of the user's projects: period totals,
 * project table, top tasks. Source: BFF /costs/overview (clara-agent
 * by-ref + sidecar estimates + worklog, graceful degradation). */
import { useCallback, useEffect, useState } from "react";
import styles from "../PlannerApp.module.css";
import { plannerApi } from "../api";
import type { CostsOverview, VikTask } from "../types";
import { fmtEur, fmtMins, fmtTokens } from "../shared";
import { useTranslation } from "@claraos/core";

/** Technical name of the cost-tracking service (not translated). */
const COST_SERVICE = "clara-agent";

/** Period options in days; 3650 = "all time". */
const RANGES = [7, 30, 90, 3650];
const RANGE_ALL = 3650;

export function CostsOverviewView({
  allTasks, onOpenTask, onOpenProject,
}: {
  allTasks: VikTask[];
  onOpenTask: (t: VikTask) => void;
  onOpenProject: (projectId: number) => void;
}) {
  const { t } = useTranslation("planner");
  const [days, setDays] = useState(30);
  const [data, setData] = useState<CostsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await plannerApi.costsOverview(days));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const taskTitle = (id: number) => allTasks.find((task) => task.id === id)?.title ?? `#${id}`;
  const openTask = (projectId: number, taskId: number) =>
    onOpenTask({ id: taskId, project_id: projectId, title: taskTitle(taskId) } as VikTask);

  if (loading) return <div className={styles.loading}>{t("costs.loading")}</div>;

  const totalWorked = (data?.projects ?? []).reduce((s, p) => s + (p.worked_minutes || 0), 0);
  const totalEstimate = (data?.projects ?? []).reduce((s, p) => s + (p.estimate_eur || 0), 0);

  return (
    <div className={styles.view} style={{ maxWidth: "none" }}>
      <header className={styles.viewHeader}>
        <h2>💶 {t("costs.overview.title")}</h2>
        <div className={styles.viewTools}>
          <select className={styles.select} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGES.map((d) => (
              <option key={d} value={d}>
                {d === RANGE_ALL ? t("costs.overview.rangeAll") : t("costs.overview.rangeDays", { count: d })}
              </option>
            ))}
          </select>
          <button className={styles.btn} onClick={() => { setLoading(true); load(); }} title={t("costs.refresh")}>↻</button>
        </div>
      </header>
      {error && <div className={styles.errorBox}>{error} <button aria-label={t("costs.reload")} title={t("costs.reload")} className={styles.btn} onClick={load}>↻</button></div>}
      {data && (
        <>
          <div className={styles.costsCards}>
            <div className={styles.costCard}>
              <span className={styles.costCardLabel}>{t("costs.overview.costRange")}</span>
              <span className={styles.costCardValue}>
                {data.cost_available ? fmtEur(data.range_total?.cost_eur ?? 0) : t("costs.unavailable")}
              </span>
              {data.cost_available && data.range_total && (
                <span className={styles.costCardSub}>
                  {t("costs.usage", { tokens: fmtTokens(data.range_total.tokens), count: data.range_total.events })}
                </span>
              )}
            </div>
            <div className={styles.costCard}>
              <span className={styles.costCardLabel}>{t("costs.overview.costTotal")}</span>
              <span className={styles.costCardValue}>
                {data.cost_available ? fmtEur(data.total?.cost_eur ?? 0) : "—"}
              </span>
              {data.cost_available && data.total && (
                <span className={styles.costCardSub}>{t("costs.tokens", { tokens: fmtTokens(data.total.tokens) })}</span>
              )}
            </div>
            <div className={styles.costCard}>
              <span className={styles.costCardLabel}>{t("costs.overview.worked")}</span>
              <span className={styles.costCardValue}>{fmtMins(totalWorked)}</span>
              <span className={styles.costCardSub}>{t("costs.overview.fromWorklogAll")}</span>
            </div>
            <div className={styles.costCard}>
              <span className={styles.costCardLabel}>{t("costs.overview.estimatesTotal")}</span>
              <span className={styles.costCardValue}>{totalEstimate > 0 ? fmtEur(totalEstimate) : "—"}</span>
            </div>
          </div>

          {!data.cost_available && (
            <div className={styles.hint}>
              {t("costs.unavailableHint", { service: COST_SERVICE })}
            </div>
          )}

          <div className={styles.costsTableWrap}>
            <table className={styles.costsTable}>
              <thead>
                <tr>
                  <th>{t("costs.col.project")}</th>
                  <th className={styles.num}>{t("costs.col.eurRange")}</th>
                  <th className={styles.num}>{t("costs.col.eurTotal")}</th>
                  <th className={styles.num}>{t("costs.col.tokens")}</th>
                  <th className={styles.num}>{t("costs.col.estimateEur")}</th>
                  <th className={styles.num}>{t("costs.col.time")}</th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((p) => (
                  <tr key={p.project_id} className={styles.costRow} onClick={() => onOpenProject(p.project_id)}>
                    <td className={styles.costTitle}>
                      {p.title}{p.is_archived ? " 🗄" : ""}
                      {p.open_sessions > 0 && <span className={styles.costWorking}>● {t("costs.working")}</span>}
                    </td>
                    <td className={styles.num}>{fmtEur(p.range_cost_eur)}</td>
                    <td className={styles.num}>{fmtEur(p.cost_eur)}</td>
                    <td className={styles.num}>{fmtTokens(p.tokens)}</td>
                    <td className={styles.num}>{fmtEur(p.estimate_eur)}</td>
                    <td className={styles.num}>{fmtMins(p.worked_minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.top_tasks.length > 0 && (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>{t("costs.overview.topTasks")}</h3>
              <div className={styles.costsTableWrap}>
                <table className={styles.costsTable}>
                  <thead>
                    <tr>
                      <th>{t("costs.col.task")}</th><th className={styles.num}>{t("costs.col.eur")}</th>
                      <th className={styles.num}>{t("costs.col.tokens")}</th><th className={styles.num}>{t("costs.col.runs")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top_tasks.map((tt) => (
                      <tr key={`${tt.project_id}-${tt.task_id}`} className={styles.costRow}
                          onClick={() => openTask(tt.project_id, tt.task_id)}>
                        <td className={styles.costTitle}>{taskTitle(tt.task_id)}</td>
                        <td className={styles.num}>{fmtEur(tt.cost_eur)}</td>
                        <td className={styles.num}>{fmtTokens(tt.tokens)}</td>
                        <td className={styles.num}>{tt.events ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

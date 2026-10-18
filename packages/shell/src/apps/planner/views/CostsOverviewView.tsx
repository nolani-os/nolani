/** Global cost overview — all of the user's projects: period totals,
 * project table, top tasks. Source: BFF /costs/overview (clara-agent
 * by-ref + sidecar estimates + worklog, graceful degradation). */
import { useCallback, useEffect, useState } from "react";
import styles from "../PlannerApp.module.css";
import { plannerApi } from "../api";
import type { CostsOverview, VikTask } from "../types";
import { fmtEur, fmtMins, fmtTokens } from "../shared";

const RANGES = [
  { days: 7, label: "7 Tage" },
  { days: 30, label: "30 Tage" },
  { days: 90, label: "90 Tage" },
  { days: 3650, label: "Gesamt" },
];

export function CostsOverviewView({
  allTasks, onOpenTask, onOpenProject,
}: {
  allTasks: VikTask[];
  onOpenTask: (t: VikTask) => void;
  onOpenProject: (projectId: number) => void;
}) {
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

  const taskTitle = (id: number) => allTasks.find((t) => t.id === id)?.title ?? `#${id}`;
  const openTask = (projectId: number, taskId: number) =>
    onOpenTask({ id: taskId, project_id: projectId, title: taskTitle(taskId) } as VikTask);

  if (loading) return <div className={styles.loading}>Lade Kosten…</div>;

  const totalWorked = (data?.projects ?? []).reduce((s, p) => s + (p.worked_minutes || 0), 0);
  const totalEstimate = (data?.projects ?? []).reduce((s, p) => s + (p.estimate_eur || 0), 0);

  return (
    <div className={styles.view} style={{ maxWidth: "none" }}>
      <header className={styles.viewHeader}>
        <h2>💶 Kosten</h2>
        <div className={styles.viewTools}>
          <select className={styles.select} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
          </select>
          <button className={styles.btn} onClick={() => { setLoading(true); load(); }} title="Aktualisieren">↻</button>
        </div>
      </header>
      {error && <div className={styles.errorBox}>{error} <button aria-label="Neu laden" title="Neu laden" className={styles.btn} onClick={load}>↻</button></div>}
      {data && (
        <>
          <div className={styles.costsCards}>
            <div className={styles.costCard}>
              <span className={styles.costCardLabel}>Kosten (Zeitraum)</span>
              <span className={styles.costCardValue}>
                {data.cost_available ? fmtEur(data.range_total?.cost_eur ?? 0) : "nicht verfügbar"}
              </span>
              {data.cost_available && data.range_total && (
                <span className={styles.costCardSub}>
                  {fmtTokens(data.range_total.tokens)} Tokens · {data.range_total.events} Läufe
                </span>
              )}
            </div>
            <div className={styles.costCard}>
              <span className={styles.costCardLabel}>Kosten gesamt</span>
              <span className={styles.costCardValue}>
                {data.cost_available ? fmtEur(data.total?.cost_eur ?? 0) : "—"}
              </span>
              {data.cost_available && data.total && (
                <span className={styles.costCardSub}>{fmtTokens(data.total.tokens)} Tokens</span>
              )}
            </div>
            <div className={styles.costCard}>
              <span className={styles.costCardLabel}>Gearbeitete Zeit</span>
              <span className={styles.costCardValue}>{fmtMins(totalWorked)}</span>
              <span className={styles.costCardSub}>aus Worklog (alle Projekte)</span>
            </div>
            <div className={styles.costCard}>
              <span className={styles.costCardLabel}>Schätzungen gesamt</span>
              <span className={styles.costCardValue}>{totalEstimate > 0 ? fmtEur(totalEstimate) : "—"}</span>
            </div>
          </div>

          {!data.cost_available && (
            <div className={styles.hint}>
              Die Kostenerfassung (clara-agent) ist gerade nicht erreichbar — Schätzungen und
              Zeiten werden trotzdem angezeigt.
            </div>
          )}

          <div className={styles.costsTableWrap}>
            <table className={styles.costsTable}>
              <thead>
                <tr>
                  <th>Projekt</th>
                  <th className={styles.num}>€ (Zeitraum)</th>
                  <th className={styles.num}>€ gesamt</th>
                  <th className={styles.num}>Tokens</th>
                  <th className={styles.num}>Schätzung €</th>
                  <th className={styles.num}>Zeit</th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((p) => (
                  <tr key={p.project_id} className={styles.costRow} onClick={() => onOpenProject(p.project_id)}>
                    <td className={styles.costTitle}>
                      {p.title}{p.is_archived ? " 🗄" : ""}
                      {p.open_sessions > 0 && <span className={styles.costWorking}>● arbeitet</span>}
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
              <h3 className={styles.sectionTitle}>Top-Aufgaben (gesamt)</h3>
              <div className={styles.costsTableWrap}>
                <table className={styles.costsTable}>
                  <thead>
                    <tr><th>Aufgabe</th><th className={styles.num}>€</th><th className={styles.num}>Tokens</th><th className={styles.num}>Läufe</th></tr>
                  </thead>
                  <tbody>
                    {data.top_tasks.map((t) => (
                      <tr key={`${t.project_id}-${t.task_id}`} className={styles.costRow}
                          onClick={() => openTask(t.project_id, t.task_id)}>
                        <td className={styles.costTitle}>{taskTitle(t.task_id)}</td>
                        <td className={styles.num}>{fmtEur(t.cost_eur)}</td>
                        <td className={styles.num}>{fmtTokens(t.tokens)}</td>
                        <td className={styles.num}>{t.events ?? "—"}</td>
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

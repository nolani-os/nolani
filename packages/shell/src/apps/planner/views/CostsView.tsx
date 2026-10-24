/** Cost/time transparency: actual costs (clara-agent cost_events, per
 * task) vs. estimate (sidecar) + time worked (worklog). Read-only table in
 * house style; estimates are set by Clara via set_estimate or by hand in TaskDetail. */
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "../PlannerApp.module.css";
import { plannerApi } from "../api";
import type { ProjectCosts, TaskCost, VikProject, VikTask } from "../types";
import { regionLocale, getBrand } from "@claraos/core";

function eur(v: number | null | undefined): string {
  return v == null ? "—" : `${v.toFixed(v < 1 ? 4 : 2)} €`;
}
function tok(v: number | null | undefined): string {
  return v == null ? "—" : v.toLocaleString(regionLocale());
}
function mins(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v < 60) return `${Math.round(v)} min`;
  const h = Math.floor(v / 60);
  return `${h} h ${Math.round(v % 60)} min`;
}

export function CostsView({ project, onOpen }: { project: VikProject; onOpen: (t: VikTask) => void }) {
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
      setTitles(Object.fromEntries((tasks || []).map((t) => [t.id, t.title])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const totalWorked = useMemo(
    () => (costs?.tasks || []).reduce((s, t) => s + (t.worked_minutes || 0), 0),
    [costs],
  );

  if (loading) return <div className={styles.loading}>Lade Kosten…</div>;
  if (error) return <div className={styles.errorBox}>{error} <button aria-label="Neu laden" title="Neu laden" onClick={load}>↻</button></div>;
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
            <span className={styles.costCardLabel}>Ist-Kosten (Projekt)</span>
            <span className={styles.costCardValue}>
              {costs.cost_available ? eur(costs.total?.cost_eur ?? 0) : "nicht verfügbar"}
            </span>
            {costs.cost_available && costs.total && (
              <span className={styles.costCardSub}>
                {tok(costs.total.input_tokens + costs.total.output_tokens)} Tokens · {costs.total.events} Läufe
              </span>
            )}
          </div>
          <div className={styles.costCard}>
            <span className={styles.costCardLabel}>Schätzung</span>
            <span className={styles.costCardValue}>{eur(est?.estimate_eur)}</span>
            <span className={styles.costCardSub}>
              {est?.estimate_minutes != null ? mins(est.estimate_minutes) : "—"} · {tok(est?.estimate_tokens)} Tokens
            </span>
          </div>
          <div className={styles.costCard}>
            <span className={styles.costCardLabel}>Gearbeitete Zeit</span>
            <span className={styles.costCardValue}>{mins(totalWorked)}</span>
            <span className={styles.costCardSub}>aus Worklog (start/finish)</span>
          </div>
        </div>
        <button className={styles.btn} onClick={load} title="Aktualisieren">↻</button>
      </header>

      {!costs.cost_available && (
        <div className={styles.hint}>
          Die Kostenerfassung (clara-agent) ist gerade nicht erreichbar — Schätzungen und Zeiten
          werden trotzdem angezeigt.
        </div>
      )}

      {costs.tasks.length === 0 ? (
        <div className={styles.emptyHint}>
          Noch keine Kosten, Schätzungen oder Zeiten erfasst. Sobald {getBrand().assistant} an Aufgaben dieses
          Projekts arbeitet, erscheinen hier die realen Kosten pro Aufgabe.
        </div>
      ) : (
        <div className={styles.costsTableWrap}>
          <table className={styles.costsTable}>
            <thead>
              <tr>
                <th>Aufgabe</th>
                <th className={styles.num}>Ist €</th>
                <th className={styles.num}>Schätzung €</th>
                <th className={styles.num}>Tokens</th>
                <th className={styles.num}>Zeit</th>
              </tr>
            </thead>
            <tbody>
              {costs.tasks.map((t: TaskCost) => {
                const over = t.estimate_eur != null && t.cost_eur != null && t.cost_eur > t.estimate_eur;
                return (
                  <tr key={t.task_id} className={styles.costRow} onClick={() => openTask(t.task_id)}>
                    <td className={styles.costTitle}>
                      {titles[t.task_id] ?? `#${t.task_id}`}
                      {t.open_sessions > 0 && <span className={styles.costWorking}>● arbeitet</span>}
                    </td>
                    <td className={`${styles.num} ${over ? styles.costOver : ""}`}>{eur(t.cost_eur)}</td>
                    <td className={styles.num}>{eur(t.estimate_eur)}</td>
                    <td className={styles.num}>
                      {t.input_tokens != null ? tok((t.input_tokens || 0) + (t.output_tokens || 0)) : "—"}
                    </td>
                    <td className={styles.num}>{mins(t.worked_minutes)}</td>
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

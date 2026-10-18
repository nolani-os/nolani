/** Overview: all KPIs as tiles.
 *
 * The goal tree answers "how does this fit together". This view answers
 * "where do I stand right now" — without expanding anything.
 *
 * Important: the order comes from the server and puts PROBLEMS first. A screen
 * that shows "all achieved" at the top left and hides the red items at the bottom
 * is a sedative; the eye goes to the top left first.
 *
 * Important: exactly ONE big number per view. If every tile shouts, none does —
 * so the tiles carry medium-sized values and the headline figure sits at the top.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "../IdeasApp.module.css";
import { ideasApi } from "../api";
import type { KpiProgress } from "../types";
import { Sparkline } from "../KpiChart";
import { Icon } from "../../../components/Icon";
import { fmtDate, fmtNum, fmtPct, statusColor, statusOf } from "../kpiStatus";

interface DashKpi {
  id: string;
  title: string;
  goal: { id: string; title: string } | null;
  progress: KpiProgress;
  series: { ts: string; value: number }[];
  updated_at: string | null;
}

interface Props {
  onOpen: (id: string) => void;
  reloadTick: number;
}

const ZEITRAEUME = [
  { tage: 30, label: "30 Tage" },
  { tage: 90, label: "90 Tage" },
  { tage: 365, label: "1 Jahr" },
];

const TREND_ICON = { up: "trendUp", down: "trendDown", flat: "trendFlat" } as const;

/** Change over the displayed period — the baseline is named, otherwise a
 *  number without reference is mere decoration. */
function delta(reihe: { value: number }[]): number | null {
  if (reihe.length < 2) return null;
  return reihe[reihe.length - 1].value - reihe[0].value;
}

function Kachel({ k, onOpen }: { k: DashKpi; onOpen: (id: string) => void }) {
  const p = k.progress;
  const st = statusOf(p.status);
  const d = delta(k.series);
  const richtung = p.trend ?? null;

  return (
    <button className={styles.tile} onClick={() => onOpen(k.id)}
            title={p.reason}>
      <span className={styles.tileLabel}>
        {k.title}
        {k.goal && <em className={styles.tileGoal}> · {k.goal.title}</em>}
      </span>

      <span className={styles.tileValueRow}>
        <span className={styles.tileValue}>{fmtNum(p.current, p.unit)}</span>
        <Sparkline punkte={k.series} />
      </span>

      <span className={styles.tileMeta}>
        {/* Status always with a word — never colour alone. */}
        <span style={{ color: statusColor(p.status) }}>
          <Icon name={st.iconName} size={14} /> {st.label}
        </span>
        {p.target != null && <> · Ziel {fmtNum(p.target, p.unit)}</>}
        {p.attainment != null && <> · {fmtPct(p.attainment)}</>}
      </span>

      <span className={styles.tileMeta}>
        {richtung ? (
          <span className={
            p.trend_good === true ? styles.trendGut
              : p.trend_good === false ? styles.trendSchlecht : styles.trendNeutral
          }>
            <Icon name={TREND_ICON[richtung]} size={14} />{" "}
            {d != null ? `${d > 0 ? "+" : "−"}${fmtNum(Math.abs(d), p.unit)}` : "—"}
          </span>
        ) : (
          <span className={styles.trendNeutral}>keine Richtung</span>
        )}
        {p.behind_by != null && Math.abs(p.behind_by) > 0.001 && (
          <span className={p.behind_by > 0 ? styles.trendSchlecht : styles.trendGut}>
            {" · "}{fmtNum(Math.abs(p.behind_by), p.unit)}
            {p.behind_by > 0 ? " hinter Plan" : " vor Plan"}
          </span>
        )}
      </span>

      {/* Data freshness: without it nobody knows whether the number is from
          today or from last quarter. */}
      <span className={styles.tileStamp}>
        {p.current_ts ? `Stand ${fmtDate(p.current_ts.slice(0, 10))}` : "nie gemessen"}
      </span>
    </button>
  );
}

export function DashboardView({ onOpen, reloadTick }: Props) {
  const [kpis, setKpis] = useState<DashKpi[]>([]);
  const [tage, setTage] = useState(90);
  const [stand, setStand] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await ideasApi.kpiDashboard(tage);
      setKpis(r.kpis);
      setStand(r.generated_at);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Übersicht nicht ladbar");
    } finally {
      setLoading(false);
    }
  }, [tage]);

  useEffect(() => { void load(); }, [load, reloadTick]);

  const zahlen = useMemo(() => {
    const gut = kpis.filter((k) => ["on_track", "done"].includes(k.progress.status)).length;
    const schlecht = kpis.filter((k) => ["behind", "at_risk"].includes(k.progress.status)).length;
    const blind = kpis.filter((k) => k.progress.status === "blind").length;
    return { gut, schlecht, blind, gesamt: kpis.length };
  }, [kpis]);

  return (
    <div className={styles.dash}>
      <div className={styles.dashHead}>
        <h3>Übersicht</h3>
        <div className={styles.dashFilter} role="group" aria-label="Zeitraum">
          {ZEITRAEUME.map((z) => (
            <button key={z.tage}
                    className={`${styles.chip} ${tage === z.tage ? styles.chipAktiv : ""}`}
                    aria-pressed={tage === z.tage}
                    onClick={() => setTage(z.tage)}>{z.label}</button>
          ))}
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {loading && kpis.length === 0 && <div className={styles.empty}>Lade…</div>}

      {!loading && kpis.length === 0 && !error && (
        <div className={styles.empty}>
          Noch keine Kennzahl. Leg im Reiter <strong>Ziele</strong> eine an — ohne
          Kennzahl kann niemand sagen, ob es vorangeht.
        </div>
      )}

      {kpis.length > 0 && (
        <>
          {/* The one big number of the view.
              Read aloud, "2/4" becomes "two slash four" or "two quarters"
              depending on the screen reader — neither is meant. Hence a
              spelled-out version for speech output and the digits for the
              eye only. */}
          <div className={styles.hero}>
            <span className={styles.srOnly}>
              {zahlen.gut} von {zahlen.gesamt} Kennzahlen auf Kurs
              {zahlen.schlecht > 0 && `, ${zahlen.schlecht} hinter Plan`}
              {zahlen.blind > 0 && `, ${zahlen.blind} ohne Messung`}
            </span>
            <span className={styles.heroFigure} aria-hidden="true">
              {zahlen.gut}<span className={styles.heroOf}>/{zahlen.gesamt}</span>
            </span>
            <span className={styles.heroLabel} aria-hidden="true">
              auf Kurs
              {zahlen.schlecht > 0 && <> · <b className={styles.trendSchlecht}>
                {zahlen.schlecht} hinter Plan</b></>}
              {zahlen.blind > 0 && <> · {zahlen.blind} ohne Messung</>}
            </span>
          </div>

          <div className={styles.tiles}>
            {kpis.map((k) => <Kachel key={k.id} k={k} onOpen={onOpen} />)}
          </div>
        </>
      )}

      {stand && (
        <p className={styles.metaHint}>
          Stand: {new Date(stand).toLocaleString("de-DE")} · Zeitraum {tage} Tage
        </p>
      )}
    </div>
  );
}

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
import { regionLocale, useTranslation, i18n, Trans } from "@claraos/core";

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
  { tage: 30, key: "days30" },
  { tage: 90, key: "days90" },
  { tage: 365, key: "year" },
];

const TREND_ICON = { up: "trendUp", down: "trendDown", flat: "trendFlat" } as const;

/** Change over the displayed period — the baseline is named, otherwise a
 *  number without reference is mere decoration. */
function delta(reihe: { value: number }[]): number | null {
  if (reihe.length < 2) return null;
  return reihe[reihe.length - 1].value - reihe[0].value;
}

function Kachel({ k, onOpen }: { k: DashKpi; onOpen: (id: string) => void }) {
  const { t } = useTranslation("wissen");
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
        {p.target != null && <>{t("views.dash.target", { value: fmtNum(p.target, p.unit) })}</>}
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
          <span className={styles.trendNeutral}>{t("views.dash.noDirection")}</span>
        )}
        {p.behind_by != null && Math.abs(p.behind_by) > 0.001 && (
          <span className={p.behind_by > 0 ? styles.trendSchlecht : styles.trendGut}>
            {" · "}{fmtNum(Math.abs(p.behind_by), p.unit)}
            {p.behind_by > 0 ? t("views.dash.behind") : t("views.dash.ahead")}
          </span>
        )}
      </span>

      {/* Data freshness: without it nobody knows whether the number is from
          today or from last quarter. */}
      <span className={styles.tileStamp}>
        {p.current_ts ? t("views.dash.asOf", { date: fmtDate(p.current_ts.slice(0, 10)) }) : t("views.dash.never")}
      </span>
    </button>
  );
}

export function DashboardView({ onOpen, reloadTick }: Props) {
  const { t } = useTranslation("wissen");
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
      setError(e instanceof Error ? e.message : i18n.t("wissen:views.dash.loadFailed"));
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
        <h3>{t("views.dash.title")}</h3>
        <div className={styles.dashFilter} role="group" aria-label={t("views.dash.period")}>
          {ZEITRAEUME.map((z) => (
            <button key={z.tage}
                    className={`${styles.chip} ${tage === z.tage ? styles.chipAktiv : ""}`}
                    aria-pressed={tage === z.tage}
                    onClick={() => setTage(z.tage)}>{t(`views.dash.${z.key}`)}</button>
          ))}
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {loading && kpis.length === 0 && <div className={styles.empty}>{t("views.dash.loading")}</div>}

      {!loading && kpis.length === 0 && !error && (
        <div className={styles.empty}>
          <Trans t={t} i18nKey="views.dash.empty" components={{ b: <strong /> }} />
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
              {t("views.dash.srOnTrack", { good: zahlen.gut, total: zahlen.gesamt })}
              {zahlen.schlecht > 0 && t("views.dash.srBehind", { count: zahlen.schlecht })}
              {zahlen.blind > 0 && t("views.dash.srBlind", { count: zahlen.blind })}
            </span>
            <span className={styles.heroFigure} aria-hidden="true">
              {zahlen.gut}<span className={styles.heroOf}>/{zahlen.gesamt}</span>
            </span>
            <span className={styles.heroLabel} aria-hidden="true">
              {t("views.dash.onTrack")}
              {zahlen.schlecht > 0 && <> · <b className={styles.trendSchlecht}>
                {t("views.dash.behindN", { count: zahlen.schlecht })}</b></>}
              {zahlen.blind > 0 && <> · {t("views.dash.blindN", { count: zahlen.blind })}</>}
            </span>
          </div>

          <div className={styles.tiles}>
            {kpis.map((k) => <Kachel key={k.id} k={k} onOpen={onOpen} />)}
          </div>
        </>
      )}

      {stand && (
        <p className={styles.metaHint}>
          {t("views.dash.footer", { when: new Date(stand).toLocaleString(regionLocale()), days: tage })}
        </p>
      )}
    </div>
  );
}

/** Trend chart for a KPI.
 *
 * Two series on ONE axis: the measured history and the planned path
 * (start → milestones → deadline). Both share the same unit; a second y-axis
 * would be the classic charting mistake and make any gap between the lines
 * meaningless.
 *
 * Hand-drawn SVG instead of a chart library: the shell bundle is shared by
 * all apps, and two lines do not justify a package. Same pattern as the
 * existing sparkline.
 *
 * The planned path arrives precomputed from the server (`progress.plan_path`).
 * If the UI built it from baseline, milestones and deadline itself, there
 * would be two computations for the same line, and bar and chart would
 * drift apart.
 */
import { useMemo, useState } from "react";
import styles from "./IdeasApp.module.css";
import { fmtNum } from "./kpiStatus";
import { regionLocale, useTranslation } from "@claraos/core";

export interface ChartPoint { t: number; v: number }

interface Props {
  ist: { ts: string; value: number }[];
  plan?: { date: string; value: number }[];
  unit: string;
  /** Target value: horizontal reference line. */
  target?: number | null;
  label: string;
}

const W = 320;
const H = 150;
const PAD = { oben: 10, rechts: 10, unten: 22, links: 42 };

/** Round axis values: 0/5/10 is readable, 3.7284 is not. */
function ticks(min: number, max: number, wunsch = 4): number[] {
  const spanne = max - min;
  if (spanne <= 0) return [min];
  const roh = spanne / wunsch;
  const gr = Math.pow(10, Math.floor(Math.log10(roh)));
  const schritt = [1, 2, 2.5, 5, 10].map((f) => f * gr).find((s) => s >= roh) ?? gr * 10;
  const out: number[] = [];
  for (let v = Math.ceil(min / schritt) * schritt; v <= max + 1e-9; v += schritt) {
    out.push(Number(v.toFixed(6)));
  }
  return out;
}

const tag = (ms: number) =>
  new Date(ms).toLocaleDateString(regionLocale(), { day: "2-digit", month: "2-digit" });

/** Small axis-less chart for the tiles.
 *
 * At most 12 points: a sparkline should show the shape, not every
 * measurement. 200 points in 90 px turn into an ink blot. The MOST RECENT are
 * used: the present is the question, not the history.
 */
export function Sparkline({ punkte, hoehe = 28 }: {
  punkte: { ts: string; value: number }[]; hoehe?: number;
}) {
  const p = punkte.slice(-12)
    .map((q) => ({ t: new Date(q.ts).getTime(), v: q.value }))
    .filter((q) => Number.isFinite(q.t) && Number.isFinite(q.v));
  if (p.length < 2) return null;
  const w = 90;
  const vs = p.map((q) => q.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const spanne = max - min || 1;
  const x = (i: number) => (i / (p.length - 1)) * w;
  const y = (v: number) => hoehe - 3 - ((v - min) / spanne) * (hoehe - 6);
  const d = p.map((q, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(q.v).toFixed(1)}`).join(" ");
  return (
    <svg className={styles.tileSpark} viewBox={`0 0 ${w} ${hoehe}`} preserveAspectRatio="none"
         aria-hidden="true" focusable="false">
      <path d={d} fill="none" />
      <circle cx={x(p.length - 1)} cy={y(p[p.length - 1].v)} r="2.5" />
    </svg>
  );
}

export function KpiChart({ ist, plan, unit, target, label }: Props) {
  const { t } = useTranslation("wissen");
  const [hover, setHover] = useState<number | null>(null);
  const [tabelle, setTabelle] = useState(false);

  const daten = useMemo(() => {
    const i: ChartPoint[] = ist
      .map((p) => ({ t: new Date(p.ts).getTime(), v: p.value }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);
    const p: ChartPoint[] = (plan ?? [])
      .map((q) => ({ t: new Date(q.date).getTime(), v: q.value }))
      .filter((q) => Number.isFinite(q.t) && Number.isFinite(q.v))
      .sort((a, b) => a.t - b.t);
    return { i, p };
  }, [ist, plan]);

  if (daten.i.length < 2) return null;

  const alle = [...daten.i, ...daten.p];
  const tMin = Math.min(...alle.map((p) => p.t));
  const tMax = Math.max(...alle.map((p) => p.t));
  const werte = [...alle.map((p) => p.v), ...(target != null ? [target] : [])];
  let vMin = Math.min(...werte);
  let vMax = Math.max(...werte);
  if (vMin === vMax) { vMin -= 1; vMax += 1; }
  const luft = (vMax - vMin) * 0.08;
  vMin -= luft; vMax += luft;

  const x = (t: number) =>
    PAD.links + ((t - tMin) / (tMax - tMin || 1)) * (W - PAD.links - PAD.rechts);
  const y = (v: number) =>
    PAD.oben + (1 - (v - vMin) / (vMax - vMin || 1)) * (H - PAD.oben - PAD.unten);

  const pfad = (pts: ChartPoint[]) =>
    pts.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");

  const yTicks = ticks(vMin, vMax);
  const letzter = daten.i[daten.i.length - 1];
  const hp = hover != null ? daten.i[hover] : null;

  /** Nearest data point to the pointer; the hit area is the full height. */
  const beiBewegung = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    let dist = Infinity;
    daten.i.forEach((p, k) => {
      const d = Math.abs(x(p.t) - px);
      if (d < dist) { dist = d; best = k; }
    });
    setHover(best);
  };

  return (
    <div className={styles.chartWrap}>
      <div className={styles.chartHead}>
        {/* Two series ⇒ a legend is mandatory; color must never be the only
            difference. */}
        <span className={styles.legend}>
          <i className={styles.legendIst} /> {t("chart.measured")}
        </span>
        <span className={styles.legend}>
          <i className={styles.legendPlan} /> {t("chart.planned")}
        </span>
        <button className={styles.linkBtn} onClick={() => setTabelle((v) => !v)}>
          {tabelle ? t("chart.chart") : t("chart.table")}
        </button>
      </div>

      {tabelle ? (
        <table className={styles.chartTable}>
          <caption className={styles.srOnly}>{t("chart.values", { label })}</caption>
          <thead><tr><th scope="col">{t("chart.date")}</th><th scope="col">{t("chart.value")}</th></tr></thead>
          <tbody>
            {[...daten.i].reverse().map((p) => (
              <tr key={p.t}>
                <td>{new Date(p.t).toLocaleDateString(regionLocale())}</td>
                <td>{fmtNum(p.v, unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <svg className={styles.chart} viewBox={`0 0 ${W} ${H}`} role="img"
             aria-label={t("chart.aria", { label, count: daten.i.length })}
             onMouseMove={beiBewegung} onMouseLeave={() => setHover(null)}>
          {yTicks.map((v) => (
            <g key={v}>
              <line className={styles.chartGrid} x1={PAD.links} x2={W - PAD.rechts}
                    y1={y(v)} y2={y(v)} />
              <text className={styles.chartTick} x={PAD.links - 6} y={y(v) + 3}
                    textAnchor="end">{v.toLocaleString(regionLocale())}</text>
            </g>
          ))}

          {target != null && (
            <line className={styles.chartTarget} x1={PAD.links} x2={W - PAD.rechts}
                  y1={y(target)} y2={y(target)} />
          )}

          {daten.p.length >= 2 && (
            <path className={styles.chartPlan} d={pfad(daten.p)} fill="none" />
          )}
          <path className={styles.chartIst} d={pfad(daten.i)} fill="none" />

          {/* Label the end point, not every point (nobody reads those). */}
          <circle className={styles.chartEnd} cx={x(letzter.t)} cy={y(letzter.v)} r="4" />

          {hp && (
            <g>
              <line className={styles.chartCross} x1={x(hp.t)} x2={x(hp.t)}
                    y1={PAD.oben} y2={H - PAD.unten} />
              <circle className={styles.chartEnd} cx={x(hp.t)} cy={y(hp.v)} r="4" />
            </g>
          )}

          <text className={styles.chartTick} x={PAD.links} y={H - 6}>{tag(tMin)}</text>
          <text className={styles.chartTick} x={W - PAD.rechts} y={H - 6}
                textAnchor="end">{tag(tMax)}</text>
        </svg>
      )}

      {!tabelle && (
        <p className={styles.chartHint} aria-live="polite">
          {hp
            ? `${new Date(hp.t).toLocaleDateString(regionLocale())}: ${fmtNum(hp.v, unit)}`
            : t("chart.last", { value: fmtNum(letzter.v, unit), date: new Date(letzter.t).toLocaleDateString(regionLocale()) })}
        </p>
      )}
    </div>
  );
}

/** KPI card: current value, target, trend chart, value entry.
 *
 * The chart is deliberately hand-drawn SVG: a chart library would add more
 * bundle weight than value for a sparkline (the shell bundle is shared by all
 * apps). The series is only loaded when the card is expanded; the goal tree
 * does without it. */
import { useCallback, useEffect, useState } from "react";
import styles from "./IdeasApp.module.css";
import { ideasApi } from "./api";
import type { KpiNode, KpiValue } from "./types";
import { KpiChart } from "./KpiChart";
import { Icon } from "../../components/Icon";
import { fmtNum, fmtPct, statusColor, statusOf } from "./kpiStatus";
import { regionLocale } from "@claraos/core";

interface Props {
  kpi: KpiNode;
  currentUser: string;
  onOpen: (id: string) => void;
  onChanged: () => void;
}

const SOURCE_LABEL: Record<string, string> = {
  planner: "Planner",
  formula: "Formel",
  manual: "von Hand",
};
// Optional site-specific data sources may register their labels here (heim/kpiSources.tsx).
for (const mod of Object.values(
  import.meta.glob<{ heimKpiSourceLabels?: Record<string, string> }>("../../heim/kpiSources.tsx", { eager: true }),
)) Object.assign(SOURCE_LABEL, mod.heimKpiSourceLabels ?? {});

const TREND_ICON = { up: "trendUp", down: "trendDown", flat: "trendFlat" } as const;
const TREND_WORT = { up: "steigend", down: "fallend", flat: "stagnierend" } as const;

/** Direction over recent weeks plus distance to the expected value.
 *
 * Without enough data this explicitly says "no direction yet", not
 * "stagnant". A KPI you know too little about must not look like one that
 * demonstrably is not moving; that is the more expensive mistake (same rule
 * as for sources: failure ≠ measurement).
 */
function TrendRow({ p }: { p: KpiNode["progress"] }) {
  const richtung = p.trend ?? null;
  const abstand = p.behind_by ?? null;
  if (!richtung && abstand == null) return null;

  const proWoche = p.trend_per_week;
  // A zigzag with a steep slope is not a trend; in that case name only the
  // direction, not the number.
  const belastbar = (p.trend_r2 ?? 0) >= 0.5;

  return (
    <p className={styles.kpiTrend}>
      {richtung ? (
        <span className={
          p.trend_good === true ? styles.trendGut
            : p.trend_good === false ? styles.trendSchlecht : styles.trendNeutral
        }>
          <Icon name={TREND_ICON[richtung]} size={15} /> {TREND_WORT[richtung]}
          {belastbar && proWoche != null && richtung !== "flat"
            ? ` · ${fmtNum(Math.abs(proWoche), p.unit)} pro Woche`
            : ""}
        </span>
      ) : (
        <span className={styles.trendNeutral}>
          Noch keine Richtung — zu wenige Messwerte
        </span>
      )}

      {abstand != null && Math.abs(abstand) > 0.001 && (
        <>
          {" · "}
          <span className={abstand > 0 ? styles.trendSchlecht : styles.trendGut}>
            {fmtNum(Math.abs(abstand), p.unit)} {abstand > 0 ? "hinter Plan" : "vor Plan"}
          </span>
        </>
      )}
    </p>
  );
}

export function KpiCard({ kpi, currentUser, onOpen, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [series, setSeries] = useState<{ ts: string; value: number }[]>([]);
  const [recent, setRecent] = useState<KpiValue[]>([]);
  const [input, setInput] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [msDate, setMsDate] = useState("");
  const [msValue, setMsValue] = useState("");

  const p = kpi.progress;
  const st = statusOf(p.status);
  const canEdit = kpi.owner === currentUser;

  const load = useCallback(async () => {
    try {
      const [prog, vals] = await Promise.all([
        ideasApi.kpiProgress(kpi.id),
        ideasApi.kpiValues(kpi.id, 20),
      ]);
      setSeries(prog.series);
      setRecent(vals);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verlauf nicht ladbar");
    }
  }, [kpi.id]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  /** Fetch the value now. The result is ALWAYS reported, including "nothing
   *  fetched", so a failure does not look like a success. */
  const collectNow = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await ideasApi.collectKpi(kpi.id);
      if (r.error) setError(r.error);
      else if (r.skipped) setNote(`Nichts geholt: ${r.skipped}`);
      else setNote(`Neuer Wert: ${fmtNum(r.value, p.unit)}`);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Abruf fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const num = Number(input.replace(",", "."));
    if (!input.trim() || Number.isNaN(num)) {
      setError("Bitte eine Zahl eingeben");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await ideasApi.addKpiValue(kpi.id, {
        value: num,
        // Date without time: use noon so time zones don't shift the day.
        ts: when ? new Date(`${when}T12:00:00`).toISOString() : undefined,
      });
      setInput("");
      setWhen("");
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Speichern fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.kpiCard} style={{ borderLeftColor: statusColor(p.status) }}>
      <div className={styles.kpiHead}>
        <button className={styles.kpiTitle} onClick={() => onOpen(kpi.id)} title="Kennzahl öffnen">
          <Icon name="kpi" size={16} className={styles.inlineIcon} />{kpi.title}
        </button>
        <span className={styles.kpiStatus} title={p.reason} style={{ color: statusColor(p.status) }}>
          <Icon name={st.iconName} size={15} /> {st.label}
        </span>
        <button className={styles.iconBtn} onClick={() => setOpen((v) => !v)}
                title={open ? "Zuklappen" : "Verlauf und Eingabe"}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={16}
                title={open ? "Zuklappen" : "Verlauf und Eingabe"} />
        </button>
      </div>

      <div className={styles.kpiFigures}>
        <strong>{fmtNum(p.current, p.unit)}</strong>
        <span className={styles.metaHint}>
          {p.target !== null ? `Ziel ${fmtNum(p.target, p.unit)}` : "kein Zielwert"}
          {p.attainment !== null && ` · ${fmtPct(p.attainment)} erreicht`}
        </span>
      </div>

      {p.attainment !== null && (
        <div className={styles.kpiBar} title={p.reason}>
          <span style={{
            width: `${Math.max(0, Math.min(100, p.attainment * 100))}%`,
            background: statusColor(p.status),
          }} />
          {/* Milestones as notches: the planned path, not just the end. */}
          {(p.milestones ?? []).map((m) => (
            m.attainment == null ? null : (
              <i key={m.date} className={styles.kpiMilestone}
                 style={{ left: `${Math.max(0, Math.min(100, m.attainment * 100))}%` }}
                 title={`Zwischenziel ${fmtNum(m.value, p.unit)} bis ${new Date(m.date).toLocaleDateString(regionLocale())}${m.label ? ` — ${m.label}` : ""}`} />
            )
          ))}
          {/* Expectation marker: where you should be today. */}
          {p.expected !== null && (
            <i className={styles.kpiExpected}
               style={{ left: `${Math.max(0, Math.min(100, p.expected * 100))}%` }}
               title={`Erwartet: ${fmtPct(p.expected)}`
                      + (p.expected_value != null ? ` (${fmtNum(p.expected_value, p.unit)})` : "")} />
          )}
        </div>
      )}

      {/* Direction and distance to plan: the two questions a current value
          alone does not answer: "where is it heading" and "how far off am I".
          Both arrive precomputed from the server and are already loaded with
          the goal tree, so they cost no extra request here. */}
      <TrendRow p={p} />

      {p.next_milestone && (
        <p className={styles.metaHint}>
          Nächstes Zwischenziel: <strong>{fmtNum(p.next_milestone.value, p.unit)}</strong>
          {" "}bis {new Date(p.next_milestone.date).toLocaleDateString(regionLocale())}
        </p>
      )}

      {/* A source failure is ALWAYS shown, even when collapsed; otherwise a
          silent adapter looks like "not measured yet". */}
      {kpi.source_error && (
        <p className={styles.kpiSourceError}
           title={`seit ${new Date(kpi.source_error.at).toLocaleString(regionLocale())}`}>
          <Icon name="warning" size={15} className={styles.inlineIcon} />{kpi.source_error.message}
        </p>
      )}

      {open && (
        <div className={styles.kpiBody}>
          {series.length >= 2 ? (
            <KpiChart ist={series} plan={p.plan_path} unit={p.unit}
                      target={p.target} label={kpi.title} />
          ) : (
            <p className={styles.metaHint}>Noch zu wenige Messwerte für eine Kurve.</p>
          )}

          {kpi.source && kpi.source.kind !== "manual" && (
            <div className={styles.kpiSourceRow}>
              <span className={styles.metaHint}>
                Quelle: <strong>{SOURCE_LABEL[kpi.source.kind] ?? kpi.source.kind}</strong>
                {kpi.source.every_minutes ? ` · alle ${kpi.source.every_minutes} min` : ""}
              </span>
              {canEdit && (
                <button className={styles.btnGhost} disabled={busy}
                        onClick={() => void collectNow()}>Jetzt abrufen</button>
              )}
            </div>
          )}
          {note && <p className={styles.metaHint}>{note}</p>}

          {canEdit ? (
            <div className={styles.kpiEntry}>
              <input className={styles.input} inputMode="decimal" placeholder={`Wert${p.unit ? ` in ${p.unit}` : ""}`}
                     value={input} onChange={(e) => setInput(e.target.value)}
                     onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
              <input className={styles.input} type="date" value={when} title="Zeitpunkt (leer = jetzt)"
                     onChange={(e) => setWhen(e.target.value)} />
              <button className={styles.btnPrimary} disabled={busy} onClick={() => void save()}>
                Eintragen
              </button>
            </div>
          ) : (
            <p className={styles.metaHint}>Nur {kpi.owner} kann Werte eintragen.</p>
          )}

          {/* Manage milestones */}
          {canEdit && (
            <div className={styles.kpiEntry}>
              <input className={styles.input} type="date" value={msDate} title="Zwischenziel bis"
                     onChange={(e) => setMsDate(e.target.value)} />
              <input className={styles.input} inputMode="decimal" value={msValue}
                     placeholder={`Zwischenziel${p.unit ? ` in ${p.unit}` : ""}`}
                     onChange={(e) => setMsValue(e.target.value)} />
              <button className={styles.btnGhost} disabled={busy || !msDate || !msValue.trim()}
                      onClick={async () => {
                        const num = Number(msValue.replace(",", "."));
                        if (Number.isNaN(num)) { setError("Bitte eine Zahl eingeben"); return; }
                        setBusy(true);
                        try {
                          await ideasApi.addMilestone(kpi.id, msDate, num);
                          setMsDate(""); setMsValue("");
                          onChanged();
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Zwischenziel nicht gespeichert");
                        } finally { setBusy(false); }
                      }}>Zwischenziel setzen</button>
            </div>
          )}
          {(p.milestones ?? []).length > 0 && (
            <ul className={styles.kpiValues}>
              {(p.milestones ?? []).map((m) => (
                <li key={m.date}>
                  <span>{new Date(m.date).toLocaleDateString(regionLocale())}</span>
                  <strong>{fmtNum(m.value, p.unit)}</strong>
                  <span className={styles.metaHint}>Zwischenziel</span>
                  {canEdit && (
                    <button className={styles.iconBtn} title="Zwischenziel entfernen"
                            onClick={async () => {
                              await ideasApi.deleteMilestone(kpi.id, m.date);
                              onChanged();
                            }}><Icon name="close" size={14} title="Entfernen" /></button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {recent.length > 0 && (
            <ul className={styles.kpiValues}>
              {recent.slice(0, 5).map((v) => (
                <li key={v.id}>
                  <span>{new Date(v.ts).toLocaleDateString(regionLocale())}</span>
                  <strong>{fmtNum(v.value, p.unit)}</strong>
                  <span className={styles.metaHint}>
                    {v.source === "manual" ? "von Hand" : v.source}
                  </span>
                  {canEdit && (
                    <button className={styles.iconBtn} title="Messwert löschen"
                            onClick={async () => {
                              await ideasApi.deleteKpiValue(kpi.id, v.id);
                              await load();
                              onChanged();
                            }}><Icon name="close" size={14} title="Entfernen" /></button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {error && <div className={styles.error}>{error}</div>}
        </div>
      )}
    </div>
  );
}

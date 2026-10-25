/** Pareto analysis.
 *
 * Clara suggests the causes; **the person enters the numbers**. An automatic
 * distribution would be show without substance: the data for it simply does
 * not exist in the system. This is a structured questionnaire with a
 * calculator, and it is labeled exactly as such. */
import { useTranslation, i18n, Trans } from "@claraos/core";
import { useState } from "react";
import styles from "./IdeasApp.module.css";
import { Icon } from "../../components/Icon";
import { ideasApi } from "./api";
import type { GoalNode, ParetoRow } from "./types";

interface Props {
  goal: GoalNode;
  onClose: () => void;
  onDone: () => void;
}

interface Row { cause: string; value: string }

export function ParetoModal({ goal, onClose, onDone }: Props) {
  const { t } = useTranslation("wissen");
  const [problem, setProblem] = useState("");
  const [unit, setUnit] = useState("");
  const [rows, setRows] = useState<Row[]>([{ cause: "", value: "" }, { cause: "", value: "" }]);
  const [preview, setPreview] = useState<ParetoRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const askClara = async () => {
    if (!problem.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await ideasApi.paretoCauses(goal.id, problem);
      if (r.unit) setUnit(r.unit);
      setRows(r.causes.map((c) => ({ cause: c, value: "" })));
    } catch (e) {
      setError(e instanceof Error ? e.message : i18n.t("wissen:fiveWhy.noAnswer"));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const items = rows
      .filter((r) => r.cause.trim() && r.value.trim())
      .map((r) => ({ cause: r.cause.trim(), value: r.value.trim(), unit }));
    if (items.length < 2) {
      setError(i18n.t("wissen:pareto.tooFew"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await ideasApi.pareto(goal.id, problem, items);
      setPreview(r.result.items);
      setTimeout(onDone, 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : i18n.t("wissen:fiveWhy.evalFailed"));
    } finally {
      setBusy(false);
    }
  };

  const max = preview ? Math.max(...preview.map((p) => p.value)) : 1;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <h3>{t("pareto.title", { goal: goal.title })}</h3>
          <button className={styles.iconBtn} onClick={onClose}><Icon name="close" size={14} title={t("app.close")} /></button>
        </div>

        {!preview ? (
          <>
            <p className={styles.metaHint}>
              <Trans t={t} i18nKey="pareto.intro" components={{ b: <strong /> }} />
            </p>
            <input className={styles.input} value={problem} autoFocus
                   placeholder={t("pareto.problem")}
                   onChange={(e) => setProblem(e.target.value)} />
            <div className={styles.paretoTools}>
              <button className={styles.btnGhost} disabled={busy || !problem.trim()}
                      onClick={() => void askClara()}>{t("pareto.suggest")}</button>
              <label className={styles.paretoUnit}>{t("pareto.unit")}
                <input className={styles.input} value={unit} placeholder={t("pareto.unitPlaceholder")}
                       onChange={(e) => setUnit(e.target.value)} />
              </label>
            </div>

            <ul className={styles.paretoRows}>
              {rows.map((r, i) => (
                <li key={i}>
                  <input className={styles.input} value={r.cause} placeholder={t("pareto.cause")}
                         onChange={(e) => setRow(i, { cause: e.target.value })} />
                  <input className={styles.input} inputMode="decimal" value={r.value}
                         placeholder={t("pareto.value")} style={{ maxWidth: 110 }}
                         onChange={(e) => setRow(i, { value: e.target.value })} />
                  <button className={styles.iconBtn} title={t("pareto.removeRow")}
                          onClick={() => setRows((p) => p.filter((_, j) => j !== i))}><Icon name="close" size={14} title={t("app.close")} /></button>
                </li>
              ))}
            </ul>
            <button className={styles.btnGhost}
                    onClick={() => setRows((p) => [...p, { cause: "", value: "" }])}>
              {t("pareto.addRow")}
            </button>

            {error && <div className={styles.error}>{error}</div>}
            <div className={styles.modalFoot}>
              <button className={styles.btnPrimary} disabled={busy} onClick={() => void save()}>
                {t("pareto.save")}
              </button>
            </div>
          </>
        ) : (
          <div className={styles.paretoResult}>
            {preview.map((p, i) => (
              <div key={p.cause} className={styles.paretoBarRow}>
                <span className={styles.paretoLabel}>{p.cause}</span>
                <span className={styles.paretoBar}>
                  <i style={{ width: `${(p.value / max) * 100}%` }}
                     className={p.cumulative <= 0.8 ? styles.paretoVital : ""} />
                </span>
                <span className={styles.metaHint}>
                  {p.value}{unit && ` ${unit}`} · {Math.round(p.share * 100)} %
                  {" "}{t("pareto.cumulative", { pct: Math.round(p.cumulative * 100) })}
                </span>
                {i === 0 && <span className={styles.metaHint}>{t("pareto.biggest")}</span>}
              </div>
            ))}
            <p className={styles.metaHint}>{t("pareto.saved")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

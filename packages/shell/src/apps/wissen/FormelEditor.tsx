/** Formula editor.
 *
 * "Half a formula editor is worse than none." True — so this one has the three
 * things without which it would not really be one:
 *   1. **Clickable columns.** Nobody types `prop("faellig")` correctly without
 *      knowing the key — and the keys are not shown anywhere.
 *   2. **The function list with examples**, not just names.
 *   3. **A preview on real rows.** A formula is the only column whose result
 *      cannot be seen before it exists. Evaluation happens server-side, the
 *      same way as when reading the table — a preview that computed
 *      differently from the table would be worse than none.
 */
import { useEffect, useMemo, useState } from "react";
import styles from "./Wissen.module.css";
import geteilt from "../ideas/IdeasApp.module.css";
import { ideasApi } from "../ideas/api";
import { FieldType } from "../ideas/types";
import type { KbField } from "../ideas/types";
import { useTranslation } from "@claraos/core";

/** Exactly the functions that `services/kb_formula.py` knows. This list mirrors
 *  the server: if it lists something the server cannot do, the user gets an
 *  error instead of a formula. If something is missing here, it is unusable —
 *  but never unsafe, because the server remains the authority. */
const FUNKTIONEN: { id: string; ruf: string }[] = [
  { id: "prop", ruf: 'prop("schlüssel")' },
  { id: "rollup", ruf: 'rollup("schlüssel")' },
  { id: "if", ruf: "if(bedingung, dann, sonst)" },
  { id: "round", ruf: "round(zahl, stellen)" },
  { id: "abs", ruf: "abs(zahl)" },
  { id: "min", ruf: "min(a, b, …)" },
  { id: "max", ruf: "max(a, b, …)" },
  { id: "num", ruf: "num(wert)" },
  { id: "len", ruf: "len(text)" },
  { id: "concat", ruf: 'concat(a, " ", b)' },
  { id: "contains", ruf: 'contains(text, "wort")' },
  { id: "empty", ruf: "empty(wert)" },
  { id: "today", ruf: "today()" },
  { id: "days_between", ruf: "days_between(a, b)" },
  { id: "days_until", ruf: "days_until(datum)" },
];

const BEISPIELE = [
  'if(prop("kosten") > 1000, "teuer", "geht")',
  'days_until(prop("faellig"))',
  'concat(prop("wer"), " — ", prop("status"))',
];

interface Props {
  feld: KbField;
  sammlungId: string;
  felder: KbField[];
  onFertig: (ausdruck: string) => void;
  onAbbrechen: () => void;
}

export function FormelEditor({ feld, sammlungId, felder, onFertig, onAbbrechen }: Props) {
  const { t } = useTranslation("wissen");
  const [ausdruck, setAusdruck] = useState(String(feld.type_option?.expression ?? ""));
  const [pruefung, setPruefung] = useState<{
    ok: boolean; fehler: string | null; proben: { titel: string; wert: unknown }[];
  } | null>(null);
  const [laeuft, setLaeuft] = useState(false);

  const spalten = useMemo(
    () => felder.filter((f) => f.key !== feld.key && f.field_type !== FieldType.Formula),
    [felder, feld.key]);

  // Validate debounced, not on every keystroke: the server evaluates the
  // formula on real rows, which should not happen every second.
  useEffect(() => {
    if (!ausdruck.trim()) { setPruefung(null); return; }
    let weg = false;
    setLaeuft(true);
    const t = window.setTimeout(() => {
      void ideasApi.formelVorschau(sammlungId, ausdruck)
        .then((r) => { if (!weg) setPruefung(r); })
        .catch((e) => { if (!weg) setPruefung({ ok: false, fehler: String(e), proben: [] }); })
        .finally(() => { if (!weg) setLaeuft(false); });
    }, 600);
    return () => { weg = true; window.clearTimeout(t); };
  }, [ausdruck, sammlungId]);

  const einfuegen = (text: string) => setAusdruck((a) => (a ? `${a} ${text}` : text));

  return (
    <div className={geteilt.modalBackdrop} onClick={onAbbrechen}>
      <div className={`${geteilt.modal} ${styles.formelModal}`} onClick={(e) => e.stopPropagation()}>
        <h3>{t("formula.title", { name: feld.name })}</h3>

        <textarea
          className={styles.formelFeld}
          autoFocus
          spellCheck={false}
          rows={3}
          value={ausdruck}
          placeholder={BEISPIELE[0]}
          onChange={(e) => setAusdruck(e.target.value)}
        />

        <div className={styles.formelStatus}>
          {!ausdruck.trim() ? (
            <span className={geteilt.metaHint}>
              {t("formula.startWith")}{" "}
              {BEISPIELE.map((b) => (
                <button key={b} className={styles.leisteChip} style={{ marginRight: 4 }}
                        onClick={() => setAusdruck(b)}>{b}</button>
              ))}
            </span>
          ) : laeuft ? (
            <span className={geteilt.metaHint}>{t("formula.checking")}</span>
          ) : pruefung && !pruefung.ok ? (
            <span className={styles.formelFehler}>⚠ {pruefung.fehler}</span>
          ) : pruefung ? (
            <div className={styles.formelProben}>
              <span className={geteilt.metaHint}>{t("formula.preview")}</span>
              {pruefung.proben.map((pb, i) => (
                <div key={i} className={styles.formelProbe}>
                  <span className={styles.formelProbeTitel}>{pb.titel}</span>
                  <span className={styles.formelProbeWert}>
                    {pb.wert === null || pb.wert === undefined || pb.wert === ""
                      ? "—" : String(pb.wert)}
                  </span>
                </div>
              ))}
              {pruefung.proben.length === 0 && (
                <span className={geteilt.metaHint}>
                  {t("formula.noRow")}
                </span>
              )}
            </div>
          ) : null}
        </div>

        <div className={styles.formelHilfe}>
          <div>
            <h4 className={styles.leisteTitel}>{t("formula.columns")}</h4>
            <div className={styles.leisteChips}>
              {spalten.map((f) => (
                <button key={f.key} className={styles.leisteChip}
                        title={`prop("${f.key}")`}
                        onClick={() => einfuegen(`prop("${f.key}")`)}>{f.name}</button>
              ))}
              {spalten.length === 0 && (
                <span className={geteilt.metaHint}>{t("formula.noColumns")}</span>
              )}
            </div>
          </div>
          <div>
            <h4 className={styles.leisteTitel}>{t("formula.functions")}</h4>
            <div className={styles.formelFunktionen}>
              {FUNKTIONEN.map((fn) => (
                <button key={fn.ruf} className={styles.formelFunktion}
                        onClick={() => einfuegen(fn.ruf)}>
                  <code>{fn.ruf}</code>
                  <span>{t(`formula.fn.${fn.id}`)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={geteilt.modalFoot}>
          <button className={geteilt.btnSecondary} onClick={onAbbrechen}>{t("common.cancel")}</button>
          <button className={geteilt.btnPrimary}
                  disabled={!ausdruck.trim() || laeuft || (pruefung ? !pruefung.ok : true)}
                  onClick={() => onFertig(ausdruck.trim())}>
            {t("common.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}

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

/** Exactly the functions that `services/kb_formula.py` knows. This list mirrors
 *  the server: if it lists something the server cannot do, the user gets an
 *  error instead of a formula. If something is missing here, it is unusable —
 *  but never unsafe, because the server remains the authority. */
const FUNKTIONEN: { ruf: string; was: string }[] = [
  { ruf: 'prop("schlüssel")', was: "Wert einer Spalte dieser Zeile" },
  { ruf: 'rollup("schlüssel")', was: "Wert einer Rollup-Spalte" },
  { ruf: "if(bedingung, dann, sonst)", was: "Fallunterscheidung" },
  { ruf: "round(zahl, stellen)", was: "runden" },
  { ruf: "abs(zahl)", was: "Betrag" },
  { ruf: "min(a, b, …)", was: "kleinster Wert" },
  { ruf: "max(a, b, …)", was: "größter Wert" },
  { ruf: "num(wert)", was: "als Zahl lesen" },
  { ruf: "len(text)", was: "Anzahl Zeichen" },
  { ruf: 'concat(a, " ", b)', was: "aneinanderhängen" },
  { ruf: 'contains(text, "wort")', was: "enthält?" },
  { ruf: "empty(wert)", was: "leer?" },
  { ruf: "today()", was: "heutiges Datum" },
  { ruf: "days_between(a, b)", was: "Tage zwischen zwei Daten" },
  { ruf: "days_until(datum)", was: "Tage bis dahin" },
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
        <h3>Formel für „{feld.name}"</h3>

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
              Fang mit einem Beispiel an:{" "}
              {BEISPIELE.map((b) => (
                <button key={b} className={styles.leisteChip} style={{ marginRight: 4 }}
                        onClick={() => setAusdruck(b)}>{b}</button>
              ))}
            </span>
          ) : laeuft ? (
            <span className={geteilt.metaHint}>prüft…</span>
          ) : pruefung && !pruefung.ok ? (
            <span className={styles.formelFehler}>⚠ {pruefung.fehler}</span>
          ) : pruefung ? (
            <div className={styles.formelProben}>
              <span className={geteilt.metaHint}>So sähe es aus:</span>
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
                  Noch keine Zeile da, an der man es zeigen könnte.
                </span>
              )}
            </div>
          ) : null}
        </div>

        <div className={styles.formelHilfe}>
          <div>
            <h4 className={styles.leisteTitel}>Spalten</h4>
            <div className={styles.leisteChips}>
              {spalten.map((f) => (
                <button key={f.key} className={styles.leisteChip}
                        title={`prop("${f.key}")`}
                        onClick={() => einfuegen(`prop("${f.key}")`)}>{f.name}</button>
              ))}
              {spalten.length === 0 && (
                <span className={geteilt.metaHint}>Diese Sammlung hat noch keine Spalten.</span>
              )}
            </div>
          </div>
          <div>
            <h4 className={styles.leisteTitel}>Funktionen</h4>
            <div className={styles.formelFunktionen}>
              {FUNKTIONEN.map((fn) => (
                <button key={fn.ruf} className={styles.formelFunktion}
                        onClick={() => einfuegen(fn.ruf)}>
                  <code>{fn.ruf}</code>
                  <span>{fn.was}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={geteilt.modalFoot}>
          <button className={geteilt.btnSecondary} onClick={onAbbrechen}>Abbrechen</button>
          <button className={geteilt.btnPrimary}
                  disabled={!ausdruck.trim() || laeuft || (pruefung ? !pruefung.ok : true)}
                  onClick={() => onFertig(ausdruck.trim())}>
            Übernehmen
          </button>
        </div>
      </div>
    </div>
  );
}

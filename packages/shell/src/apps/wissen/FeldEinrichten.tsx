/** Set up relation and rollup.
 *
 * Why this exists: restricting type changes to "simple types only", on the
 * grounds that relation, rollup and formula need configuration, has the right
 * premise but the wrong conclusion. **Notion does it differently**: "Change
 * type" has no exceptions, and choosing "Relation" asks for the target
 * database. Needing configuration is not a reason to leave something out but
 * a reason to ask. Without this dialog a related table could **not be created
 * at all** in the UI — only via Clara.
 *
 * Deliberately ONLY relation and rollup. The formula needs an expression
 * editor with syntax checking; that is a separate piece of work and does not
 * belong in a dialog built on the side.
 */
import { useEffect, useMemo, useState } from "react";
import styles from "./Wissen.module.css";
import geteilt from "../ideas/IdeasApp.module.css";
import { ideasApi } from "../ideas/api";
import { FieldType } from "../ideas/types";
import type { KbCollection, KbField } from "../ideas/types";
import { AGGREGATE } from "./feldTypen";

interface Props {
  /** Column to be converted. */
  feld: KbField;
  /** Target type: relation or rollup. */
  zielTyp: number;
  /** Collection containing the column — the rollup needs its relation columns. */
  sammlungId: string;
  felder: KbField[];
  onFertig: (typ: number, option: Record<string, unknown>) => void;
  onAbbrechen: () => void;
}

export function FeldEinrichten({ feld, zielTyp, sammlungId, felder, onFertig, onAbbrechen }: Props) {
  const [sammlungen, setSammlungen] = useState<KbCollection[]>([]);
  const [ziel, setZiel] = useState<string>(String(feld.type_option?.target_collection ?? ""));
  const [relFeld, setRelFeld] = useState<string>(String(feld.type_option?.relation_field ?? ""));
  const [zielFeld, setZielFeld] = useState<string>(String(feld.type_option?.target_field ?? ""));
  const [aggregat, setAggregat] = useState<string>(String(feld.type_option?.aggregate ?? "sum"));
  const [zielFelder, setZielFelder] = useState<KbField[]>([]);

  useEffect(() => {
    void ideasApi.listCollections()
      .then((cs) => setSammlungen(cs.filter((c) => c.id !== sammlungId)))
      .catch(() => setSammlungen([]));
  }, [sammlungId]);

  // Relation columns of THIS collection — a rollup can only compute through them.
  const relSpalten = useMemo(
    () => felder.filter((f) => f.field_type === FieldType.Relation),
    [felder]);

  // For the rollup: which columns does the collection at the other end have?
  const relZiel = useMemo(() => {
    const r = relSpalten.find((f) => f.key === relFeld);
    return r ? String(r.type_option?.target_collection ?? "") : "";
  }, [relSpalten, relFeld]);

  useEffect(() => {
    if (zielTyp !== FieldType.Rollup || !relZiel) { setZielFelder([]); return; }
    void ideasApi.listFields(relZiel).then(setZielFelder).catch(() => setZielFelder([]));
  }, [zielTyp, relZiel]);

  const istVerknuepfung = zielTyp === FieldType.Relation;
  const bereit = istVerknuepfung ? !!ziel : !!relFeld && !!zielFeld && !!aggregat;

  return (
    <div className={geteilt.modalBackdrop} onClick={onAbbrechen}>
      <div className={geteilt.modal} onClick={(e) => e.stopPropagation()}>
        <h3>{istVerknuepfung ? "Verknüpfung einrichten" : "Rollup einrichten"}</h3>
        <p className={geteilt.metaHint}>
          {istVerknuepfung
            ? `„${feld.name}" zeigt dann auf Einträge einer anderen Sammlung — wie ein `
              + "Verweis von Rezept auf Zutat."
            : `„${feld.name}" rechnet dann mit Werten aus den verknüpften Einträgen — `
              + "zum Beispiel die Summe der Kosten."}
        </p>

        {istVerknuepfung ? (
          <div className={styles.leisteFeld}>
            <label className={geteilt.metaHint}>Zeigt auf die Sammlung</label>
            {sammlungen.length === 0 ? (
              <p className={geteilt.metaHint}>
                Es gibt noch keine zweite Sammlung, auf die verwiesen werden könnte.
              </p>
            ) : (
              <div className={styles.leisteChips}>
                {sammlungen.map((c) => (
                  <button key={c.id}
                          className={`${styles.leisteChip} ${ziel === c.id ? styles.leisteChipAn : ""}`}
                          onClick={() => setZiel(c.id)}>
                    {c.icon ?? "🗂️"} {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className={styles.leisteFeld}>
              <label className={geteilt.metaHint}>Über die Verknüpfung</label>
              {relSpalten.length === 0 ? (
                <p className={geteilt.metaHint}>
                  Diese Sammlung hat noch keine Verknüpfungsspalte. Lege zuerst eine an —
                  ein Rollup rechnet immer <em>durch</em> eine Verknüpfung.
                </p>
              ) : (
                <div className={styles.leisteChips}>
                  {relSpalten.map((f) => (
                    <button key={f.key}
                            className={`${styles.leisteChip} ${relFeld === f.key ? styles.leisteChipAn : ""}`}
                            onClick={() => { setRelFeld(f.key); setZielFeld(""); }}>
                      {f.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {relFeld && (
              <div className={styles.leisteFeld}>
                <label className={geteilt.metaHint}>Rechnet mit der Spalte</label>
                <div className={styles.leisteChips}>
                  {zielFelder.map((f) => (
                    <button key={f.key}
                            className={`${styles.leisteChip} ${zielFeld === f.key ? styles.leisteChipAn : ""}`}
                            onClick={() => setZielFeld(f.key)}>
                      {f.name}
                    </button>
                  ))}
                  {zielFelder.length === 0 && (
                    <span className={geteilt.metaHint}>Die verknüpfte Sammlung hat keine Spalten.</span>
                  )}
                </div>
              </div>
            )}
            {zielFeld && (
              <div className={styles.leisteFeld}>
                <label className={geteilt.metaHint}>Und zwar</label>
                <div className={styles.leisteChips}>
                  {AGGREGATE.filter((a) => a.key).map((a) => (
                    <button key={a.key}
                            className={`${styles.leisteChip} ${aggregat === a.key ? styles.leisteChipAn : ""}`}
                            onClick={() => setAggregat(a.key)}>
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <div className={geteilt.modalFoot}>
          <button className={geteilt.btnSecondary} onClick={onAbbrechen}>Abbrechen</button>
          <button className={geteilt.btnPrimary} disabled={!bereit}
                  onClick={() => onFertig(zielTyp, istVerknuepfung
                    ? { target_collection: ziel }
                    : { relation_field: relFeld, target_field: zielFeld, aggregate: aggregat })}>
            Übernehmen
          </button>
        </div>
      </div>
    </div>
  );
}

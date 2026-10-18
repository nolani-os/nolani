/** All columns of a collection in one place.
 *
 * Why: the column menu hangs on the column header — and on phones there is
 * none, because the table shows cards there. Without this panel **not a single
 * column action is reachable** on phones: no create, rename, retype or hide.
 *
 * Notion solves this not via the header but via the **view settings**:
 * "Property visibility" and "Edit properties" sit in the right-hand panel and
 * are thus independent of whether a table with headers is currently visible.
 * That is exactly what we do here — reachable via the active view's menu.
 */
import { useState } from "react";
import styles from "./Wissen.module.css";
import geteilt from "../ideas/IdeasApp.module.css";
import { Icon } from "../../components/Icon";
import { FieldType } from "../ideas/types";
import type { KbField, KbView } from "../ideas/types";
import { MIT_RUECKFRAGE, TYP_MARKE, UMSCHALTBAR } from "./feldTypen";

interface Props {
  felder: KbField[];
  ansicht: KbView | null;
  onUmbenennen: (f: KbField, name: string) => void;
  onTypWechsel: (f: KbField, typ: number) => void;
  onSichtbar: (f: KbField, sichtbar: boolean) => void;
  onLoeschen: (f: KbField) => void;
  onNeu: () => void;
  onSchliessen: () => void;
}

export function SpaltenPanel({
  felder, ansicht, onUmbenennen, onTypWechsel, onSichtbar, onLoeschen, onNeu, onSchliessen,
}: Props) {
  const [offen, setOffen] = useState<string | null>(null);
  const typListe = [...UMSCHALTBAR, ...MIT_RUECKFRAGE];

  return (
    <div className={geteilt.modalBackdrop} onClick={onSchliessen}>
      <div className={geteilt.modal} onClick={(e) => e.stopPropagation()}>
        <h3>Spalten</h3>
        <p className={geteilt.metaHint}>
          Was die Sammlung erfasst. Das Auge blendet eine Spalte nur in dieser
          Ansicht aus — die Werte bleiben.
        </p>

        <div className={styles.spaltenListe}>
          {felder.map((f) => {
            const sichtbar = ansicht?.field_settings?.[f.key]?.visible !== false;
            const marke = TYP_MARKE[f.field_type];
            return (
              <div key={f.key} className={styles.spaltenEintrag}>
                <div className={styles.spaltenKopfZeile}>
                  <span className={styles.leisteSymbol}>
                    {marke?.icon ? <Icon name={marke.icon} size={14} /> : marke?.glyph}
                  </span>
                  <input
                    className={styles.spaltenNameFeld}
                    defaultValue={f.name}
                    onBlur={(e) => {
                      const n = e.target.value.trim();
                      if (n && n !== f.name) onUmbenennen(f, n);
                    }}
                  />
                  <button className={styles.leisteWeg} title={sichtbar ? "Ausblenden" : "Einblenden"}
                          onClick={() => onSichtbar(f, !sichtbar)}>
                    <Icon name={sichtbar ? "blind" : "check"} size={14} />
                  </button>
                  <button className={styles.leisteWeg}
                          title={f.field_type === FieldType.Formula
                            ? "Formeln lassen sich hier nicht umschalten"
                            : "Typ ändern"}
                          disabled={f.field_type === FieldType.Formula}
                          onClick={() => setOffen(offen === f.key ? null : f.key)}>⌄</button>
                  <button className={styles.leisteWeg} title="Spalte löschen"
                          onClick={() => {
                            if (window.confirm(`Spalte „${f.name}" löschen?\n\n`
                              + "Die Werte in dieser Spalte gehen dabei verloren."))
                              onLoeschen(f);
                          }}><Icon name="trash" size={14} /></button>
                </div>
                {offen === f.key && (
                  <div className={styles.leisteChips}>
                    {typListe.map((t) => (
                      <button key={t}
                              className={`${styles.leisteChip} ${t === f.field_type ? styles.leisteChipAn : ""}`}
                              onClick={() => { onTypWechsel(f, t); setOffen(null); }}>
                        {TYP_MARKE[t].label}{MIT_RUECKFRAGE.includes(t) ? "…" : ""}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className={geteilt.modalFoot}>
          <button className={geteilt.btnSecondary} onClick={onNeu}>＋ Spalte</button>
          <button className={geteilt.btnPrimary} onClick={onSchliessen}>Fertig</button>
        </div>
      </div>
    </div>
  );
}

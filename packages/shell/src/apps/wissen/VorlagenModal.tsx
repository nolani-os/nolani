/** "What do you want to start with?" — template picker instead of an empty form.
 *
 * The path for everyone: click a card, done. The collection then exists with
 * columns, views and two examples and can be used right away. The classic
 * dialog (name, icon, type, schema editor) stays reachable as "Start empty" —
 * useful for power users, just not the first impression for everyone else.
 */
import { useState } from "react";
import styles from "../ideas/IdeasApp.module.css";
import eigen from "./Wissen.module.css";
import { Icon } from "../../components/Icon";
import { CollectionModal } from "../ideas/CollectionModal";
import type { KbType, Visibility } from "../ideas/types";
import { VORLAGEN, vorlageAnwenden, type Vorlage } from "./vorlagen";

interface Props {
  types: KbType[];
  /** After creating: reload the list. */
  onDone: () => void;
  /** Open the freshly created collection directly. */
  onOpenCollection: (id: string) => void;
  onClose: () => void;
}

export function VorlagenModal({ types, onDone, onOpenCollection, onClose }: Props) {
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [leer, setLeer] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (leer) {
    return <CollectionModal types={types} onDone={onDone} onClose={onClose} />;
  }

  const anlegen = async (v: Vorlage) => {
    if (busy) return;
    setBusy(v.id);
    setError(null);
    try {
      const { id, warnungen } = await vorlageAnwenden(v, visibility);
      onDone();
      onClose();
      onOpenCollection(id);
      if (warnungen.length) {
        // Half succeeded is not succeeded — that must be said, not swallowed.
        window.alert(`„${v.name}" ist angelegt, aber nicht ganz vollständig:\n\n`
          + warnungen.join("\n"));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={`${styles.modal} ${eigen.vorlagenModal}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <h3>
            <Icon name="collections" size={16} className={styles.inlineIcon} />
            Womit fängst du an?
          </h3>
          <button className={styles.iconBtn} onClick={onClose}>
            <Icon name="close" size={14} title="Schließen" />
          </button>
        </div>

        <p className={styles.metaHint}>
          Jede Vorlage bringt fertige Spalten, passende Ansichten und zwei Beispiele mit.
          Ändern kannst du danach alles.
        </p>

        {error && (
          <div className={styles.error}>
            <span>{error}</span>
            <button className={styles.btnSecondary} onClick={() => setError(null)}>OK</button>
          </div>
        )}

        <div className={eigen.vorlagenGitter}>
          {VORLAGEN.map((v) => (
            <button
              key={v.id}
              className={eigen.vorlagenKarte}
              disabled={!!busy}
              onClick={() => void anlegen(v)}
            >
              <span className={eigen.vorlagenIcon}>{v.icon}</span>
              <span className={eigen.vorlagenName}>{v.name}</span>
              <span className={eigen.vorlagenWofuer}>{v.wofuer}</span>
              <span className={eigen.vorlagenFelder}>
                {v.felder.map((f) => f.name).join(" · ")}
              </span>
              {busy === v.id && <span className={eigen.vorlagenBusy}>wird angelegt …</span>}
            </button>
          ))}

          <button
            className={`${eigen.vorlagenKarte} ${eigen.vorlagenLeer}`}
            disabled={!!busy}
            onClick={() => setLeer(true)}
          >
            <span className={eigen.vorlagenIcon}>＋</span>
            <span className={eigen.vorlagenName}>Leer anfangen</span>
            <span className={eigen.vorlagenWofuer}>
              Eigene Spalten festlegen — für alles, was oben nicht passt.
            </span>
          </button>
        </div>

        <div className={styles.modalFoot}>
          <span className={styles.metaHint} style={{ marginRight: "auto" }}>
            Wer darf hineinsehen?
          </span>
          <div className={styles.segmented}>
            <button className={visibility === "private" ? styles.segActive : ""}
                    onClick={() => setVisibility("private")}>🔒 Nur ich</button>
            <button className={visibility === "family" ? styles.segActive : ""}
                    onClick={() => setVisibility("family")}>👪 Familie</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Empty state with a call to action.
 *
 * The difference from a plain grey sentence is the **button**. "Still empty."
 * describes a state; "＋ Create first entry" describes the next step. Someone
 * standing in a collection for the first time needs the latter.
 *
 * Deliberately WITHOUT an illustration and without encouraging text. An empty
 * state is a passage, not a destination — the faster it disappears, the
 * better it has done its job.
 */
import type { ReactNode } from "react";
import styles from "./Leerzustand.module.css";

export interface LeerAktion {
  label: string;
  onClick: () => void;
  /** Secondary path (e.g. "Reset filter") — rendered more quietly. */
  zweitrangig?: boolean;
}

interface Props {
  /** Emoji or drawn icon. May be omitted. */
  symbol?: ReactNode;
  /** What is missing — in a short phrase, without a trailing period. */
  titel: string;
  /** Why it is empty, or what belongs in it. */
  hinweis?: string;
  /** Up to two actions; the first is the primary path. */
  aktionen?: LeerAktion[];
}

export function Leerzustand({ symbol, titel, hinweis, aktionen = [] }: Props) {
  return (
    <div className={styles.leer}>
      {symbol && <div className={styles.symbol}>{symbol}</div>}
      <div className={styles.titel}>{titel}</div>
      {hinweis && <div className={styles.hinweis}>{hinweis}</div>}
      {aktionen.length > 0 && (
        <div className={styles.knopfReihe}>
          {aktionen.map((a) => (
            <button key={a.label}
                    className={`${styles.knopf} ${a.zweitrangig ? styles.zweitKnopf : ""}`}
                    onClick={a.onClick}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

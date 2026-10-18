/** Colored chip for select values.
 *
 * Why this is more than cosmetics: if every select cell is a `<select>` with an
 * arrow, six rows produce two dozen controls — the eye then sees a form, not
 * data. In Notion the value is a colored tag and the cell only becomes a
 * control on click. That is exactly the difference between "reading a table"
 * and "filling in a form".
 *
 * The look lives in the shared `components/Chip` — the Planner uses the same
 * chip. What stays here is what is specific to Knowledge: the color choice from
 * the option position (`plakettenTon`) and the rule that when space is short,
 * values are counted rather than crammed.
 */
import styles from "./Wissen.module.css";
import { Chip } from "../../components/Chip";
import { plakettenTon } from "./feldTypen";

export function Plakette({ wert, klein, optionen }: {
  wert: string; klein?: boolean; optionen?: string[];
}) {
  return <Chip ton={plakettenTon(wert, optionen)} klein={klein}>{wert}</Chip>;
}

/** Multiple values (multi-select) — when space is short, count instead of cramming. */
export function Plaketten({ werte, max = 3, optionen }: {
  werte: string[]; max?: number; optionen?: string[];
}) {
  if (!werte.length) return <span className={styles.leerZeichen}>—</span>;
  const sichtbar = werte.slice(0, max);
  const rest = werte.length - sichtbar.length;
  return (
    <span className={styles.plakettenReihe}>
      {sichtbar.map((w) => <Plakette key={w} wert={w} klein optionen={optionen} />)}
      {rest > 0 && <span className={styles.plakettenRest}>+{rest}</span>}
    </span>
  );
}

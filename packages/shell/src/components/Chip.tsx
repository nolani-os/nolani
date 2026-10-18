/** Chip — the shared building block.
 *
 * A chip displays a value and makes it distinguishable at a glance. It is NOT
 * the same as a button: without `onClick` it is pure display and rendered as a
 * `<span>` — only with `onClick` does it become a `<button>`, so keyboard and
 * screen readers see the right thing.
 *
 * Why it must exist: it replaces four implementations of the same idea in
 * three files. Every improvement — color choice, touch target, truncation —
 * would otherwise have to be made four times, and next time you forget the
 * fourth.
 */
import type { ReactNode } from "react";
import styles from "./Chip.module.css";

interface Props {
  children: ReactNode;
  /** 1–6 = one of the six color tones, otherwise neutral. */
  ton?: number;
  klein?: boolean;
  /** Icon or character before the text. */
  icon?: ReactNode;
  title?: string;
  /** With a click handler, the display becomes a control. */
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Additional class from the caller (e.g. red for "overdue"). */
  className?: string;
}

export function Chip({ children, ton, klein, icon, title, onClick, className = "" }: Props) {
  const tonKlasse = ton && ton >= 1 && ton <= 6
    ? styles[`ton${ton}`]
    : styles.neutral;
  const klassen = `${styles.chip} ${tonKlasse} ${klein ? styles.klein : ""} `
    + `${onClick ? styles.knopf : ""} ${className}`;
  const inhalt = <>{icon}{children}</>;
  return onClick
    ? <button type="button" className={klassen} title={title} onClick={onClick}>{inhalt}</button>
    : <span className={klassen} title={title}>{inhalt}</span>;
}

/** Button — the shared building block.
 *
 * Why it must exist: without a shared button component, 35 apps ended up with
 * four conventions (plain tokens, tokens with hex fallback, foreign token
 * names with Catppuccin hex, a separate app-specific token system) and radii of
 * 6/8/10/12/16/999 px side by side — on phones it looked "plain and clunky".
 * A building block that looks the same everywhere is the only way to fix
 * that permanently.
 *
 * Sizes follow Material 3 Expressive (androidx source, not guessed):
 *   · heights s 40 · m 48 (phone default) · l 56 — never below 44 as a target
 *   · pill as base shape; `form="eckig"` = --radius-lg
 *   · pressed: the SHAPE contracts (smaller radius, scale .98), no
 *     opacity — opacity makes a button look "broken", not "pressed"
 *   · five variants: filled (ONE primary action per view) · tonal (default) ·
 *     outlined · text · danger (traffic-light set, never the accent)
 *
 * Colors only from tokens (`tokens.css`, skin manifest). No hex, no `white` —
 * `--on-accent` is the only text color on the accent.
 */
import { createContext, useContext, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import styles from "./Button.module.css";

export type KnopfStufe = "filled" | "tonal" | "outlined" | "text" | "danger";

/** Environment: the same building blocks, two sizings.
 *  The desktop shell sets "desktop" — then s/m/l are 28/32/36 px and the base
 *  shape is `--radius-md` (10 px) instead of the pill; the pill stays for chips.
 *  The phone shell keeps the default "handy" (40/48/56, pill). Apps need not
 *  know anything — a `<Button>` looks right on both. */
export type KnopfUmgebungWert = "handy" | "desktop";
export const KnopfUmgebung = createContext<KnopfUmgebungWert>("handy");
export type KnopfGroesse = "s" | "m" | "l";
export type KnopfForm = "rund" | "eckig";

interface BasisProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  stufe?: KnopfStufe;
  groesse?: KnopfGroesse;
  form?: KnopfForm;
  /** Icon name from the own set or a ready-made element. */
  icon?: IconName | ReactNode;
  type?: "button" | "submit" | "reset";
}

function symbol(icon: IconName | ReactNode | undefined, groesse: KnopfGroesse) {
  if (!icon) return null;
  const px = groesse === "l" ? 24 : 20;
  return typeof icon === "string"
    ? <Icon name={icon as IconName} size={px} className={styles.symbol} />
    : <span className={styles.symbol}>{icon}</span>;
}

export function Button({
  stufe = "tonal", groesse = "m", form, icon, className = "",
  children, type = "button", ...rest
}: BasisProps & { children?: ReactNode }) {
  const umgebung = useContext(KnopfUmgebung);
  const eckig = form ? form === "eckig" : umgebung === "desktop";
  return (
    <button
      type={type}
      className={`${styles.knopf} ${umgebung === "desktop" ? styles.desk : ""} ${styles[stufe]} ${styles[`g_${groesse}`]} ${eckig ? styles.eckig : ""} ${className}`}
      data-knopf={stufe}
      {...rest}
    >
      {symbol(icon, groesse)}
      {children != null && <span className={styles.beschriftung}>{children}</span>}
    </button>
  );
}

/** Round icon-only button. `label` is mandatory — without a word next to it
 *  the button needs a name for screen readers and the tooltip. */
export function IconButton({
  label, icon, stufe = "text", groesse = "m", className = "", type = "button", ...rest
}: Omit<BasisProps, "form" | "icon"> & { label: string; icon: IconName | ReactNode }) {
  const umgebung = useContext(KnopfUmgebung);
  return (
    <button
      type={type}
      className={`${styles.knopf} ${umgebung === "desktop" ? styles.desk : ""} ${styles.rundknopf} ${styles[stufe]} ${styles[`g_${groesse}`]} ${className}`}
      aria-label={label}
      title={label}
      data-knopf={`icon-${stufe}`}
      {...rest}
    >
      {symbol(icon, groesse)}
    </button>
  );
}

/** Floating primary action — 56 px, slightly squared (M3: 16 dp), ONE per view. */
export function Fab({
  label, icon = "plus", className = "", type = "button", ...rest
}: Omit<BasisProps, "form" | "icon" | "stufe" | "groesse"> & { label: string; icon?: IconName | ReactNode }) {
  const umgebung = useContext(KnopfUmgebung);
  return (
    <button
      type={type}
      className={`${styles.knopf} ${umgebung === "desktop" ? styles.desk : ""} ${styles.fab} ${className}`}
      aria-label={label}
      title={label}
      data-knopf="fab"
      {...rest}
    >
      {symbol(icon, "l")}
    </button>
  );
}

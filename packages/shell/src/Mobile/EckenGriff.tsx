import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "@claraos/core";
import styles from "./EckenGriff.module.css";

/**
 * Corner grip in the bottom screen corner — modelled on the lock-screen
 * camera.
 *
 * Why at all: the floating Clara button sat bottom right, i.e. **exactly
 * where apps have their main button**. Measured, it covered a control in several
 * apps — "New / Upload" in Files, "Show keyboard" in the terminal. Moving
 * it did not help: any fixed position in the bottom area hits something
 * somewhere.
 *
 * The corner is the only spot no app uses. The grip also sits INSIDE the
 * navigation bar, not above it — so it cannot cover anything any more.
 *
 * Important: **tap AND swipe.** A pure gesture would be more elegant, but
 * undiscoverable: whoever does not know it would never find Clara again. The
 * visible arc invites a tap; the swipe is the faster shortcut for everyone who
 * has learned it once. Both lead to the same place.
 */

export function EckenGriff({
  seite,
  label,
  icon,
  onAusloesen,
  signal = null,
}: {
  seite: "links" | "rechts";
  label: string;
  icon: React.ReactNode;
  /** `tipp` = short tap, `wisch` = full gesture toward the center
   *  (tap opens the text chat, swipe opens voice). */
  onAusloesen: (art: "tipp" | "wisch") => void;
  /** Glow: "arbeitet" = Clara is computing while the sheet is closed (arc
   *  pulses), "fertig" = an unread answer is waiting (calm dot). */
  signal?: "arbeitet" | "fertig" | null;
}) {
  // 0 = at rest, 1 = trigger threshold reached. Drives the bloom animation.
  const [zug, setZug] = useState(0);
  const { t } = useTranslation("mobile");
  const start = useRef<{ x: number; y: number } | null>(null);
  const gezogen = useRef(false);

  const SCHWELLE = 44;   // finger width — below that it would be a shaky tap

  const runter = (e: ReactPointerEvent) => {
    start.current = { x: e.clientX, y: e.clientY };
    gezogen.current = false;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const bewegen = (e: ReactPointerEvent) => {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    const dy = start.current.y - e.clientY;          // upward is positive
    // Direction toward the screen center: from the left grip to the right,
    // from the right grip to the left. Upward counts on both sides.
    const hin = seite === "links" ? dx : -dx;
    const weg = Math.max(0, hin) + Math.max(0, dy);
    if (weg > 6) gezogen.current = true;
    setZug(Math.min(1, weg / SCHWELLE));
  };

  const hoch = () => {
    const wisch = zug >= 1;
    const ausgeloest = wisch || !gezogen.current;      // full gesture OR tap
    start.current = null;
    setZug(0);
    if (ausgeloest) {
      // Short haptic echo so the gesture feels confirmed.
      try { navigator.vibrate?.(12); } catch { /* device without vibration */ }
      onAusloesen(wisch ? "wisch" : "tipp");
    }
  };

  // Warning: ghost click (measured with a touch probe: mouse 0/1, touch 2/2).
  // The grip triggers on `pointerup` and the sheet mounts immediately — and
  // after `touchend` the browser still synthesizes a `click` that hits the
  // freshly mounted attach button at the same spot. `preventDefault` on
  // `touchend` suppresses exactly this trailing click.
  const touchEnde = (e: React.TouchEvent) => { e.preventDefault(); };

  return (
    <button
      className={`${styles.griff} ${seite === "links" ? styles.links : styles.rechts}`}
      style={{ ["--zug" as string]: zug }}
      aria-label={signal === "arbeitet" ? t("grip.working", { label }) : signal === "fertig" ? t("grip.ready", { label }) : label}
      title={label}
      data-signal={signal ?? undefined}
      onPointerDown={runter}
      onPointerMove={bewegen}
      onPointerUp={hoch}
      onTouchEnd={touchEnde}
      onPointerCancel={() => { start.current = null; setZug(0); }}
    >
      <span className={styles.bogen} aria-hidden="true" />
      <span className={styles.symbol}>{icon}</span>
    </button>
  );
}

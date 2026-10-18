import { useMatrixStore } from "@claraos/core";
import { usePraesenz, type Zustand } from "../praesenzStore";
import styles from "./PresenceDot.module.css";

/**
 * Presence icon.
 *
 * Important: do not fall back to `"offline"` when nothing is known. That would
 * claim absence for anyone whose client hasn't reported recently — and
 * "offline" discourages people from writing to someone.
 *
 * Rules:
 *   1. **ClaraOS leads.** Anyone with the UI open is present — regardless of
 *      what their Matrix client thinks.
 *   2. Matrix only fills in where ClaraOS knows nothing (e.g. for room
 *      members who are not ClaraOS users).
 *   3. **Unknown means no icon.** Not grey — none at all.
 *
 * The shapes follow Fluent 2 (MS Teams): the state is recognisable without
 * colour — check mark, bar, clock, cross. Telling states apart by red alone is
 * exactly what colour-blind users cannot do.
 */

const TITEL: Record<Zustand, string> = {
  verfuegbar: "Verfügbar",
  beschaeftigt: "Beschäftigt",
  nicht_stoeren: "Nicht stören",
  abwesend: "Abwesend",
  offline: "Offline",
  unbekannt: "Status unbekannt",
};

function Symbol({ zustand }: { zustand: Zustand }) {
  switch (zustand) {
    case "verfuegbar":
      return <path d="M3.2 5.3 4.6 6.8 7 3.9" className={styles.strich} />;
    case "nicht_stoeren":
      return <path d="M2.9 5.2h4.4" className={styles.strich} />;
    case "abwesend":
      // clock hands
      return <path d="M5 2.9v2.4l1.7 1" className={styles.strich} />;
    case "offline":
      return <path d="M3.3 3.3 6.7 6.7M6.7 3.3 3.3 6.7" className={styles.strich} />;
    default:
      return null; // busy = filled, no glyph (as in Fluent 2)
  }
}

export function PresenceDot({
  userId,
  username,
}: {
  /** Matrix MXID — only a fallback when ClaraOS knows nothing. */
  userId?: string;
  /** ClaraOS username — the primary source. */
  username?: string;
}) {
  const claraos = usePraesenz(username);
  const matrix = useMatrixStore((s) => (userId ? s.presence[userId] : undefined));

  let zustand: Zustand = "unbekannt";
  if (claraos && claraos.zustand !== "unbekannt") {
    zustand = claraos.zustand;
  } else if (matrix === "online") {
    zustand = "verfuegbar";
  } else if (matrix === "unavailable") {
    zustand = "abwesend";
  }
  // Important: `matrix === "offline"` is DELIBERATELY ignored: Matrix reports it
  // for accounts that simply don't use the service. Anyone with ClaraOS open
  // counts as present — and anyone reported nowhere stays unknown.

  if (zustand === "unbekannt") return null;

  const titel = claraos?.selbst_gesetzt
    ? `${TITEL[zustand]} (selbst gesetzt)`
    : TITEL[zustand];

  return (
    <svg
      className={`${styles.dot} ${styles[zustand]}`}
      viewBox="0 0 10 10"
      role="img"
      aria-label={titel}
    >
      <title>{titel}</title>
      <circle cx="5" cy="5" r="4.2" className={styles.grund} />
      <Symbol zustand={zustand} />
    </svg>
  );
}

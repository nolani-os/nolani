import { useEffect } from "react";
import { ActiveAgentsPanel, useClaraWorkCount } from "../../Chat";
import styles from "./TrayPopover.module.css";

/**
 * "Clara is working" indicator in the system tray.
 *
 * This used to sit in the middle of the start menu and pushed the menu content
 * down whenever it appeared. In the tray it is what it really is: system
 * state — visible without moving anything else.
 */
export function ClaraWorkTray({ onClose }: { onClose: () => void }) {
  const anzahl = useClaraWorkCount();

  // If nothing is running any more while the popover is open, it closes
  // itself — otherwise an empty window would remain above a button that no
  // longer exists.
  useEffect(() => {
    if (anzahl === 0) onClose();
  }, [anzahl, onClose]);

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={`aeroWidget ${styles.panel}`} role="dialog" aria-label="Clara arbeitet"
        data-tray-popover="clara-work">
        <div className={styles.header}>
          <span className={styles.title}>Clara arbeitet</span>
        </div>
        <section className={styles.section}>
          <ActiveAgentsPanel hideHeader />
        </section>
      </div>
    </>
  );
}

/** Glyph: the Clara spark with a pulsing dot while something is running. */
export function ClaraWorkTrayIcon() {
  return (
    <span className={styles.claraWorkGlyph} aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      </svg>
    </span>
  );
}

/** Visibility: the entry only exists while something is actually running. */
export function useClaraWorkVisible(): boolean {
  return useClaraWorkCount() > 0;
}

/** Show a counter only from two tasks upward.
 *
 * With exactly one, the number says nothing the icon does not already say —
 * in visual testing it just appeared as a second "1" next to the bell and made
 * the bar look busy. That busyness was the reason to move the panel out of the
 * start menu; recreating it in the taskbar would be silly.
 */
export function useClaraWorkBadge(): number {
  const n = useClaraWorkCount();
  return n > 1 ? n : 0;
}

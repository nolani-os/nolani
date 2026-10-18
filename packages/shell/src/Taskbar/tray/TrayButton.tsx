import { useUIStore } from "@claraos/core";
import type { TrayItemDef } from "./registry";
import styles from "../Taskbar.module.css";

/**
 * A system tray button. Uses the existing taskbar classes
 * (trayBtn/notifBadge) so skins keep coloring it without changes.
 * data-tray-item = stable hook for E2E tests + skins.
 */
export function TrayButton({ item }: { item: TrayItemDef }) {
  const active = useUIStore((s) => s.trayPopover === item.id);
  const setTrayPopover = useUIStore((s) => s.setTrayPopover);
  const badge = item.useBadge ? item.useBadge() : 0;
  // Visibility from live data: `visibleWhen` in Taskbar.tsx cannot call a
  // hook, so the button decides about itself here.
  const sichtbar = item.useVisible ? item.useVisible() : true;

  if (!sichtbar) return null;

  return (
    <button
      className={styles.trayBtn}
      onClick={() => setTrayPopover(item.id)}
      title={item.title}
      aria-expanded={active}
      data-tray-item={item.id}
      data-ctx={item.ctxId}
      data-tour={item.tourId}
    >
      <item.TrayIcon />
      {badge > 0 && <span className={styles.notifBadge}>{badge}</span>}
    </button>
  );
}

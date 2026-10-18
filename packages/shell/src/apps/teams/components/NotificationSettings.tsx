import { useMatrixStore } from "@claraos/core";
import styles from "./NotificationSettings.module.css";

export function NotificationSettings({ onClose }: { onClose: () => void }) {
  const rooms = useMatrixStore((s) => s.rooms);
  const mutedRooms = useMatrixStore((s) => s.mutedRooms);
  const toggleMute = useMatrixStore((s) => s.toggleMuteRoom);

  const channels = Object.values(rooms).filter((r) => !r.isSpace && r.membership === "join");

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span>Benachrichtigungen</span>
        <button aria-label="Schließen" title="Schließen" className={styles.closeBtn} onClick={onClose}>×</button>
      </div>
      <div className={styles.list}>
        {channels.map((r) => (
          <div key={r.roomId} className={styles.item}>
            <span className={styles.name}>#{r.name}</span>
            <button
              className={`${styles.muteBtn} ${mutedRooms.includes(r.roomId) ? styles.muted : ""}`}
              onClick={() => toggleMute(r.roomId)}
            >
              {mutedRooms.includes(r.roomId) ? "🔇 Stumm" : "🔔 Aktiv"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

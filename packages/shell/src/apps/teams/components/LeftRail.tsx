import { useMatrixStore } from "@claraos/core";
import type { RailView } from "@claraos/core";
import {
  BellIcon, MessageIcon, UsersIcon, CalendarIcon, PhoneIcon, FolderIcon, SearchIcon,
} from "./icons";
import styles from "./LeftRail.module.css";

const RAIL_ITEMS: { id: RailView; icon: React.ReactNode; label: string }[] = [
  { id: "activity", icon: <BellIcon size={20} />, label: "Activity" },
  { id: "chat", icon: <MessageIcon size={20} />, label: "Chat" },
  { id: "teams", icon: <UsersIcon size={20} />, label: "Teams" },
  { id: "calendar", icon: <CalendarIcon size={20} />, label: "Calendar" },
  { id: "calls", icon: <PhoneIcon size={20} />, label: "Calls" },
  { id: "files", icon: <FolderIcon size={20} />, label: "Files" },
];

export function LeftRail({
  onSearchToggle,
  searchActive,
}: {
  onSearchToggle: () => void;
  searchActive: boolean;
}) {
  const railView = useMatrixStore((s) => s.railView);
  const setRailView = useMatrixStore((s) => s.setRailView);
  const rooms = useMatrixStore((s) => s.rooms);

  const totalUnread = Object.values(rooms).reduce((sum, r) => sum + r.unreadCount, 0);

  return (
    <nav className={styles.rail}>
      <button
        className={`${styles.railItem} ${searchActive ? styles.active : ""}`}
        onClick={onSearchToggle}
        title="Suchen (Strg+K)"
      >
        <span className={styles.icon}><SearchIcon size={20} /></span>
        <span className={styles.label}>Suche</span>
      </button>

      <div className={styles.divider} />

      {RAIL_ITEMS.map((item) => (
        <button
          key={item.id}
          className={`${styles.railItem} ${!searchActive && railView === item.id ? styles.active : ""}`}
          onClick={() => {
            if (searchActive) onSearchToggle();
            setRailView(item.id);
          }}
          title={item.label}
        >
          <span className={styles.icon}>{item.icon}</span>
          <span className={styles.label}>{item.label}</span>
          {item.id === "activity" && totalUnread > 0 && (
            <span className={styles.badge}>{totalUnread > 99 ? "99+" : totalUnread}</span>
          )}
        </button>
      ))}
    </nav>
  );
}

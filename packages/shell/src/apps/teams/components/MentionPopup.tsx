import { useState, useEffect } from "react";
import { getRoomMembersList } from "../matrixClient";
import type { MatrixMember } from "../matrixClient";
import styles from "./MentionPopup.module.css";

export function MentionPopup({
  roomId,
  query,
  onSelect,
  onClose,
}: {
  roomId: string;
  query: string;
  onSelect: (member: MatrixMember) => void;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<MatrixMember[]>([]);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const all = getRoomMembersList(roomId);
    const filtered = query
      ? all.filter((m) => m.displayName.toLowerCase().includes(query.toLowerCase()) || m.userId.toLowerCase().includes(query.toLowerCase()))
      : all;
    setMembers(filtered.slice(0, 8));
    setSelected(0);
  }, [roomId, query]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, members.length - 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
      if (e.key === "Enter" && members[selected]) { e.preventDefault(); onSelect(members[selected]); }
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [members, selected, onSelect, onClose]);

  if (members.length === 0) return null;

  return (
    <div className={styles.popup}>
      {members.map((m, i) => (
        <button
          key={m.userId}
          className={`${styles.item} ${i === selected ? styles.selected : ""}`}
          onClick={() => onSelect(m)}
          onMouseEnter={() => setSelected(i)}
        >
          <span className={styles.name}>{m.displayName}</span>
          <span className={styles.id}>{m.userId}</span>
        </button>
      ))}
    </div>
  );
}

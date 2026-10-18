import { useState } from "react";
import { useMatrixStore } from "@claraos/core";
import type { MatrixMessage } from "@claraos/core";
import { forwardMessage } from "../matrixClient";
import styles from "./ForwardDialog.module.css";

export function ForwardDialog({ msg, onClose }: { msg: MatrixMessage; onClose: () => void }) {
  const rooms = useMatrixStore((s) => s.rooms);
  const [filter, setFilter] = useState("");
  const [sending, setSending] = useState(false);

  const candidates = Object.values(rooms)
    .filter((r) => !r.isSpace && r.membership === "join" && r.roomId !== msg.roomId)
    .filter((r) => !filter || r.name.toLowerCase().includes(filter.toLowerCase()));

  const handleForward = async (toRoomId: string) => {
    setSending(true);
    await forwardMessage(msg.roomId, msg.eventId, toRoomId);
    onClose();
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>Nachricht weiterleiten</h3>
          <button aria-label="Schließen" title="Schließen" className={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        <input
          autoFocus
          className={styles.search}
          placeholder="Kanäle suchen…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className={styles.list}>
          {candidates.map((r) => (
            <button key={r.roomId} className={styles.room} onClick={() => handleForward(r.roomId)} disabled={sending}>
              <span># {r.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect } from "react";
import { useMatrixStore } from "@claraos/core";
import { setRoomTopic, deleteRoom, getMatrixClient } from "../matrixClient";
import styles from "./ChannelSettings.module.css";

export function ChannelSettings({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const room = useMatrixStore((s) => s.rooms[roomId]);
  const [topic, setTopic] = useState(room?.topic ?? "");
  const [saving, setSaving] = useState(false);

  const handleSaveTopic = async () => {
    setSaving(true);
    await setRoomTopic(roomId, topic);
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm(`Delete channel "${room?.name}"? This cannot be undone.`)) return;
    await deleteRoom(roomId);
    useMatrixStore.getState().setActiveRoom(null);
    onClose();
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>Channel Settings — #{room?.name}</h3>
          <button aria-label="Schließen" title="Schließen" className={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        <div className={styles.body}>
          <label className={styles.label}>Thema</label>
          <textarea
            className={styles.input}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            rows={3}
            placeholder="Worum geht es in diesem Kanal?"
          />
          <button className={styles.saveBtn} onClick={handleSaveTopic} disabled={saving}>
            {saving ? "Saving..." : "Save Topic"}
          </button>

          <div className={styles.info}>
            <div>Encrypted: {room?.isEncrypted ? "Yes 🔒" : "No"}</div>
            <div>Members: {room?.members.length}</div>
            <div>Raum-Kennung: <code>{roomId}</code></div>
          </div>

          <button className={styles.deleteBtn} onClick={handleDelete}>
            Delete Channel
          </button>
        </div>
      </div>
    </div>
  );
}

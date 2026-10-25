import { useState, useEffect } from "react";
import { useMatrixStore, useTranslation } from "@claraos/core";
import { setRoomTopic, deleteRoom, getMatrixClient } from "../matrixClient";
import styles from "./ChannelSettings.module.css";

export function ChannelSettings({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const { t } = useTranslation("teams");
  const room = useMatrixStore((s) => s.rooms[roomId]);
  const [topic, setTopic] = useState(room?.topic ?? "");
  const [saving, setSaving] = useState(false);

  const handleSaveTopic = async () => {
    setSaving(true);
    await setRoomTopic(roomId, topic);
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm(t("channelSettings.confirmDelete", { name: room?.name ?? "" }))) return;
    await deleteRoom(roomId);
    useMatrixStore.getState().setActiveRoom(null);
    onClose();
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>Channel Settings — #{room?.name}</h3>
          <button aria-label={t("common.close")} title={t("common.close")} className={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        <div className={styles.body}>
          <label className={styles.label}>{t("channelSettings.topic")}</label>
          <textarea
            className={styles.input}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            rows={3}
            placeholder={t("channelSettings.topicPlaceholder")}
          />
          <button className={styles.saveBtn} onClick={handleSaveTopic} disabled={saving}>
            {saving ? t("channelSettings.saving") : t("channelSettings.saveTopic")}
          </button>

          <div className={styles.info}>
            <div>{t("channelSettings.encrypted")} {room?.isEncrypted ? t("channelSettings.yes") : t("channelSettings.no")}</div>
            <div>Members: {room?.members.length}</div>
            <div>{t("channelSettings.roomId")} <code>{roomId}</code></div>
          </div>

          <button className={styles.deleteBtn} onClick={handleDelete}>
            {t("channelSettings.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}

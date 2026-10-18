import { useMemo } from "react";
import { getRoomMembersList } from "../matrixClient";
import { Avatar } from "./Avatar";
import { PresenceDot } from "./PresenceDot";
import styles from "./MemberPanel.module.css";

const ROLE_NAMES: Record<number, string> = { 100: "Admin", 50: "Moderator", 0: "Member" };

export function MemberPanel({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const members = useMemo(() => getRoomMembersList(roomId), [roomId]);
  const sorted = useMemo(() => [...members].sort((a, b) => b.powerLevel - a.powerLevel), [members]);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span>Members ({members.length})</span>
        <button aria-label="Schließen" title="Schließen" className={styles.closeBtn} onClick={onClose}>×</button>
      </div>
      <div className={styles.list}>
        {sorted.map((m) => (
          <div key={m.userId} className={styles.member}>
            <Avatar name={m.displayName} url={m.avatarUrl} size={28} />
            <div className={styles.info}>
              <div className={styles.name}>
                {m.displayName}
                <PresenceDot userId={m.userId} />
              </div>
              <span className={styles.role}>
                {ROLE_NAMES[m.powerLevel] ?? `Level ${m.powerLevel}`}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

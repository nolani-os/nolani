import { useMemo } from "react";
import { getRoomMembersList } from "../matrixClient";
import { Avatar } from "./Avatar";
import { PresenceDot } from "./PresenceDot";
import styles from "./MemberPanel.module.css";
import { useTranslation } from "@claraos/core";

const ROLE_KEYS: Record<number, string> = { 100: "admin", 50: "moderator", 0: "member" };

export function MemberPanel({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const { t } = useTranslation("teams");
  const members = useMemo(() => getRoomMembersList(roomId), [roomId]);
  const sorted = useMemo(() => [...members].sort((a, b) => b.powerLevel - a.powerLevel), [members]);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span>{t("roles.membersTitle", { count: members.length })}</span>
        <button aria-label={t("common.close")} title={t("common.close")} className={styles.closeBtn} onClick={onClose}>×</button>
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
                {ROLE_KEYS[m.powerLevel] ? t(`roles.${ROLE_KEYS[m.powerLevel]}`) : t("roles.level", { level: m.powerLevel })}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

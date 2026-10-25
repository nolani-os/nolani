import { useState } from "react";
import { searchUsers, inviteMember } from "../matrixClient";
import styles from "./InviteMemberDialog.module.css";
import { useTranslation } from "@claraos/core";

export function InviteMemberDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const { t } = useTranslation("teams");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ userId: string; displayName: string }[]>([]);
  const [invited, setInvited] = useState<string[]>([]);

  const handleSearch = async (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) { setResults([]); return; }
    const found = await searchUsers(q);
    setResults(found);
  };

  const handleInvite = async (userId: string) => {
    await inviteMember(roomId, userId);
    setInvited((prev) => [...prev, userId]);
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>{t("inviteMember.title")}</h3>
          <button aria-label={t("common.close")} title={t("common.close")} className={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        <input
          autoFocus
          className={styles.search}
          placeholder={t("inviteMember.search")}
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
        />
        <div className={styles.list}>
          {results.map((r) => (
            <div key={r.userId} className={styles.user}>
              <span className={styles.name}>{r.displayName}</span>
              <span className={styles.id}>{r.userId}</span>
              {invited.includes(r.userId) ? (
                <span className={styles.check}>✓</span>
              ) : (
                <button className={styles.inviteBtn} onClick={() => handleInvite(r.userId)}>{t("inviteMember.invite")}</button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

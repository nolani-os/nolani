import type { MatrixMessage } from "@claraos/core";
import { useMatrixStore, useTranslation } from "@claraos/core";
import styles from "./ReplyPreview.module.css";

export function ReplyPreview() {
  const replyTo = useMatrixStore((s) => s.replyTo);
  const setReplyTo = useMatrixStore((s) => s.setReplyTo);
  if (!replyTo) return null;

  return (
    <div className={styles.preview}>
      <div className={styles.bar} />
      <div className={styles.content}>
        <span className={styles.sender}>{replyTo.senderName}</span>
        <span className={styles.body}>{replyTo.body.slice(0, 100)}</span>
      </div>
      <button className={styles.close} onClick={() => setReplyTo(null)}>×</button>
    </div>
  );
}

export function EditPreview() {
  const { t } = useTranslation("teams");
  const editing = useMatrixStore((s) => s.editingEvent);
  const setEditing = useMatrixStore((s) => s.setEditingEvent);
  if (!editing) return null;

  return (
    <div className={`${styles.preview} ${styles.editing}`}>
      <div className={styles.bar} />
      <div className={styles.content}>
        <span className={styles.sender}>{t("reply.editing")}</span>
        <span className={styles.body}>{editing.body.slice(0, 100)}</span>
      </div>
      <button className={styles.close} onClick={() => setEditing(null)}>×</button>
    </div>
  );
}

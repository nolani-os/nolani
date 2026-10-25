import { useMatrixStore, useTranslation } from "@claraos/core";
import type { MatrixMessage } from "@claraos/core";
import { sendReaction, deleteMessage, pinMessage } from "../matrixClient";
import { ThreadIcon } from "./icons";
import styles from "./MessageActions.module.css";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "👎"];

export function MessageActions({
  msg,
  onReply,
  onEdit,
  onForward,
  onSave,
  onThread,
  showEmojiPicker,
}: {
  msg: MatrixMessage;
  onReply: () => void;
  onEdit: () => void;
  onForward: () => void;
  onSave: () => void;
  onThread?: () => void;
  showEmojiPicker: () => void;
}) {
  const { t } = useTranslation("teams");
  const userId = useMatrixStore((s) => s.userId);
  const isOwn = msg.sender === userId;

  return (
    <div className={styles.actions}>
      <div className={styles.quickReactions}>
        {QUICK_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            className={styles.reactionBtn}
            onClick={() => sendReaction(msg.roomId, msg.eventId, emoji)}
            title={t("actions.react", { emoji })}
          >
            {emoji}
          </button>
        ))}
        <button className={styles.reactionBtn} onClick={showEmojiPicker} title={t("actions.moreReactions")}>
          +
        </button>
      </div>
      <div className={styles.separator} />
      {onThread && (
        <button className={styles.actionBtn} onClick={onThread} title={t("actions.thread")}>
          <ThreadIcon size={14} />
        </button>
      )}
      <button className={styles.actionBtn} onClick={onReply} title={t("actions.reply")}>↩</button>
      {isOwn && <button className={styles.actionBtn} onClick={onEdit} title={t("actions.edit")}>✏️</button>}
      {isOwn && (
        <button
          className={styles.actionBtn}
          onClick={() => { if (confirm(t("actions.confirmDelete"))) deleteMessage(msg.roomId, msg.eventId); }}
          title={t("actions.delete")}
        >🗑️</button>
      )}
      <button className={styles.actionBtn} onClick={onForward} title={t("actions.forward")}>↗️</button>
      <button className={styles.actionBtn} onClick={onSave} title={t("actions.save")}>🔖</button>
      <button
        className={styles.actionBtn}
        onClick={() => pinMessage(msg.roomId, msg.eventId)}
        title={t("actions.pin")}
      >📌</button>
    </div>
  );
}

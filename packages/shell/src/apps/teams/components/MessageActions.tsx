import { useMatrixStore } from "@claraos/core";
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
            title={`React with ${emoji}`}
          >
            {emoji}
          </button>
        ))}
        <button className={styles.reactionBtn} onClick={showEmojiPicker} title="Weitere Reaktionen">
          +
        </button>
      </div>
      <div className={styles.separator} />
      {onThread && (
        <button className={styles.actionBtn} onClick={onThread} title="Im Thread antworten">
          <ThreadIcon size={14} />
        </button>
      )}
      <button className={styles.actionBtn} onClick={onReply} title="Antworten">↩</button>
      {isOwn && <button className={styles.actionBtn} onClick={onEdit} title="Bearbeiten">✏️</button>}
      {isOwn && (
        <button
          className={styles.actionBtn}
          onClick={() => { if (confirm("Diese Nachricht wirklich löschen?")) deleteMessage(msg.roomId, msg.eventId); }}
          title="Löschen"
        >🗑️</button>
      )}
      <button className={styles.actionBtn} onClick={onForward} title="Weiterleiten">↗️</button>
      <button className={styles.actionBtn} onClick={onSave} title="Merken">🔖</button>
      <button
        className={styles.actionBtn}
        onClick={() => pinMessage(msg.roomId, msg.eventId)}
        title="Pin"
      >📌</button>
    </div>
  );
}

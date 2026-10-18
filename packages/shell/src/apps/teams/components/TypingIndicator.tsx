import { useMatrixStore } from "@claraos/core";
import styles from "./TypingIndicator.module.css";

const EMPTY: string[] = [];

export function TypingIndicator({ roomId }: { roomId: string }) {
  const typingUsers = useMatrixStore((s) => s.typing[roomId]) ?? EMPTY;
  if (typingUsers.length === 0) return null;

  const text =
    typingUsers.length === 1
      ? `${typingUsers[0]} is typing`
      : typingUsers.length === 2
        ? `${typingUsers[0]} and ${typingUsers[1]} are typing`
        : `${typingUsers[0]} and ${typingUsers.length - 1} others are typing`;

  return (
    <div className={styles.typing}>
      <span className={styles.dots}>
        <span /><span /><span />
      </span>
      <span className={styles.text}>{text}</span>
    </div>
  );
}

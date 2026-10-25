import { useMatrixStore, useTranslation } from "@claraos/core";
import styles from "./TypingIndicator.module.css";

const EMPTY: string[] = [];

export function TypingIndicator({ roomId }: { roomId: string }) {
  const { t } = useTranslation("teams");
  const typingUsers = useMatrixStore((s) => s.typing[roomId]) ?? EMPTY;
  if (typingUsers.length === 0) return null;

  const text =
    typingUsers.length === 1
      ? t("typing.one", { name: typingUsers[0] })
      : typingUsers.length === 2
        ? t("typing.two", { a: typingUsers[0], b: typingUsers[1] })
        : t("typing.many", { name: typingUsers[0], count: typingUsers.length - 1 });

  return (
    <div className={styles.typing}>
      <span className={styles.dots}>
        <span /><span /><span />
      </span>
      <span className={styles.text}>{text}</span>
    </div>
  );
}

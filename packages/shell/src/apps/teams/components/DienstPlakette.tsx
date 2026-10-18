/**
 * Small badge at the bottom right of the round image: which service does this
 * chat run over? Chats should be distinguishable by the icons for Signal,
 * ClaraOS, etc.
 *
 * Important: it is NOT shown for native ClaraOS conversations. A marker that
 * is on everything marks nothing — the point is to notice that a chat comes
 * from outside.
 */
import { ClaraIcon, SignalIcon, WhatsAppIcon, TelegramIcon } from "./icons";
import { DIENST_NAME, type Dienst } from "../dienste";
import styles from "./DienstPlakette.module.css";

const SYMBOL: Record<Dienst, (p: { size?: number }) => React.ReactElement> = {
  claraos: ClaraIcon,
  signal: SignalIcon,
  whatsapp: WhatsAppIcon,
  telegram: TelegramIcon,
};

export function DienstPlakette({
  dienst,
  immer = false,
  size = 12,
}: {
  dienst: Dienst;
  /** Mark ClaraOS chats anyway (e.g. in a mixed list, where the difference
   *  is the actual information). */
  immer?: boolean;
  size?: number;
}) {
  if (dienst === "claraos" && !immer) return null;
  const Symbol = SYMBOL[dienst];
  return (
    <span
      className={`${styles.plakette} ${styles[dienst]}`}
      title={DIENST_NAME[dienst]}
      aria-label={DIENST_NAME[dienst]}
    >
      <Symbol size={size} />
    </span>
  );
}

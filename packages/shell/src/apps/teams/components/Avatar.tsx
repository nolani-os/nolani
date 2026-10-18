import { PresenceDot } from "./PresenceDot";
import styles from "./Avatar.module.css";

const COLORS = ["#f38ba8", "#fab387", "#f9e2af", "#a6e3a1", "#89b4fa", "#cba6f7", "#f5c2e7", "#94e2d5"];

function hashColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return COLORS[Math.abs(hash) % COLORS.length];
}

// Fluent 2 pattern: presence as an overlapping badge at the bottom right of the
// avatar (instead of a free-floating dot next to the name).
export function Avatar({
  name,
  url,
  size = 32,
  presenceUserId,
  praesenzUser,
}: {
  name: string;
  url?: string;
  size?: number;
  /** Matrix MXID — fallback when ClaraOS has no status. */
  presenceUserId?: string;
  /** ClaraOS username — the primary status source. */
  praesenzUser?: string;
}) {
  const initials = name.replace(/^@/, "").slice(0, 2).toUpperCase();
  const bg = hashColor(name);

  const core = url ? (
    <img className={styles.avatar} src={url} alt={name} style={{ width: size, height: size }} />
  ) : (
    <span className={styles.avatar} style={{ width: size, height: size, background: bg, fontSize: size * 0.4 }}>
      {initials}
    </span>
  );

  if (!presenceUserId && !praesenzUser) return core;
  return (
    <span className={styles.withPresence} style={{ width: size, height: size }}>
      {core}
      <span className={styles.presenceBadge}>
        <PresenceDot userId={presenceUserId} username={praesenzUser} />
      </span>
    </span>
  );
}

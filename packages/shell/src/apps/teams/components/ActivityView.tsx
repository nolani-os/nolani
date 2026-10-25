import { useMemo, useState } from "react";
import { useMatrixStore, useTranslation, i18n } from "@claraos/core";
import type { MatrixMessage } from "@claraos/core";
import { Avatar } from "./Avatar";
import styles from "./ActivityView.module.css";

// Activity v2 — filter pills instead of a plain room list (like the
// consolidated @mentions view in MS Teams, or Saved Items in Slack).

type Filter = "all" | "unread" | "mentions" | "saved";

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return i18n.t("teams:activity.justNow");
  if (diff < 3600000) return i18n.t("teams:activity.minutes", { count: Math.floor(diff / 60000) });
  if (diff < 86400000) return i18n.t("teams:activity.hours", { count: Math.floor(diff / 3600000) });
  return i18n.t("teams:activity.days", { count: Math.floor(diff / 86400000) });
}

const FILTERS: Filter[] = ["all", "unread", "mentions", "saved"];

export function ActivityView() {
  const { t } = useTranslation("teams");
  const rooms = useMatrixStore((s) => s.rooms);
  const timeline = useMatrixStore((s) => s.timeline);
  const userId = useMatrixStore((s) => s.userId);
  const displayName = useMatrixStore((s) => s.displayName);
  const savedMessages = useMatrixStore((s) => s.savedMessages);
  const removeSavedMessage = useMatrixStore((s) => s.removeSavedMessage);
  const setActiveRoom = useMatrixStore((s) => s.setActiveRoom);
  const setRailView = useMatrixStore((s) => s.setRailView);
  const clearUnread = useMatrixStore((s) => s.clearUnread);

  const [filter, setFilter] = useState<Filter>("all");

  const openRoom = (roomId: string) => {
    setActiveRoom(roomId);
    clearUnread(roomId);
    const room = useMatrixStore.getState().rooms[roomId];
    setRailView(room?.isDirect ? "chat" : "teams");
  };

  // @mentions from all loaded timelines (good enough at household scale;
  // a server-side mentions index would be the next step)
  const mentions = useMemo(() => {
    if (!userId) return [] as MatrixMessage[];
    const localpart = userId.split(":")[0].replace(/^@/, "").toLowerCase();
    const dn = (displayName ?? "").toLowerCase();
    const hits: MatrixMessage[] = [];
    for (const msgs of Object.values(timeline)) {
      for (const m of msgs) {
        if (m.sender === userId || m.redacted) continue;
        const body = m.body.toLowerCase();
        if (body.includes(`@${localpart}`) || (dn && body.includes(`@${dn}`)) || body.includes(userId.toLowerCase())) {
          hits.push(m);
        }
      }
    }
    return hits.sort((a, b) => b.ts - a.ts).slice(0, 50);
  }, [timeline, userId, displayName]);

  const roomList = useMemo(
    () =>
      Object.values(rooms)
        .filter((r) => r.lastMessage && r.membership === "join" && !r.isSpace)
        .filter((r) => (filter === "unread" ? r.unreadCount > 0 : true))
        .sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0))
        .slice(0, 30),
    [rooms, filter],
  );

  const renderMessageItem = (m: MatrixMessage, extra?: React.ReactNode) => (
    <button key={m.eventId} className={styles.activityItem} onClick={() => openRoom(m.roomId)}>
      <div className={styles.activityTop}>
        <span className={styles.roomName}>
          <Avatar name={m.senderName} size={18} /> {m.senderName}
          <span className={styles.inRoom}> in {rooms[m.roomId]?.name ?? m.roomId}</span>
        </span>
        <span className={styles.time}>{formatTimeAgo(m.ts)}</span>
      </div>
      <div className={styles.preview}>
        <span className={styles.body}>{m.body.slice(0, 140)}</span>
      </div>
      {extra}
    </button>
  );

  return (
    <div className={styles.activityView}>
      <div className={styles.header}>{t("activity.title")}</div>
      <div className={styles.pills}>
        {FILTERS.map((f) => (
          <button
            key={f}
            className={`${styles.pill} ${filter === f ? styles.activePill : ""}`}
            onClick={() => setFilter(f)}
          >
            {t(`activity.${f}`)}
            {f === "mentions" && mentions.length > 0 && (
              <span className={styles.pillBadge}>{mentions.length}</span>
            )}
          </button>
        ))}
      </div>

      {filter === "mentions" ? (
        mentions.length === 0 ? (
          <div className={styles.empty}>{t("activity.noMentions")}</div>
        ) : (
          mentions.map((m) => renderMessageItem(m))
        )
      ) : filter === "saved" ? (
        savedMessages.length === 0 ? (
          <div className={styles.empty}>{t("activity.noSaved")}</div>
        ) : (
          savedMessages.map((m) =>
            renderMessageItem(
              m,
              <span
                className={styles.unsave}
                onClick={(e) => { e.stopPropagation(); removeSavedMessage(m.eventId); }}
              >
                {t("common.remove")}
              </span>,
            ),
          )
        )
      ) : roomList.length === 0 ? (
        <div className={styles.empty}>{filter === "unread" ? t("activity.allRead") : t("activity.none")}</div>
      ) : (
        roomList.map((room) => (
          <button key={room.roomId} className={styles.activityItem} onClick={() => openRoom(room.roomId)}>
            <div className={styles.activityTop}>
              <span className={styles.roomName}>{room.name}</span>
              <span className={styles.time}>
                {room.lastMessage ? formatTimeAgo(room.lastMessage.ts) : ""}
              </span>
            </div>
            <div className={styles.preview}>
              {room.lastMessage && (
                <>
                  <span className={styles.sender}>{room.lastMessage.sender}:</span>
                  <span className={styles.body}>{room.lastMessage.body.slice(0, 140)}</span>
                </>
              )}
            </div>
            {room.unreadCount > 0 && <span className={styles.badge}>{room.unreadCount}</span>}
          </button>
        ))
      )}
    </div>
  );
}

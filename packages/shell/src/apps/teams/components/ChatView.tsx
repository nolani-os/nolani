/**
 * Chat (person or group).
 *
 * Why a separate view: opening a chat in the same `ChannelView` as a team
 * channel gives it a `#` icon, member count, invite buttons and the whole tab
 * bar (Posts | Files | Calendar | Plan | +). A one-to-one conversation then
 * looks like a team — and shows team content it doesn't have.
 *
 * Chat = **just the conversation**. Header with round image, name, service
 * badge and call button; the timeline below. No tabs.
 */
import { useEffect, useState } from "react";
import { useMatrixStore } from "@claraos/core";
import { startCall, markAsRead } from "../matrixClient";
import { Avatar } from "./Avatar";
import { ChatTimeline } from "./ChatTimeline";
import { ThreadPane } from "./ThreadPane";
import { MemberPanel } from "./MemberPanel";
import { DienstPlakette } from "./DienstPlakette";
import { dienstDesRaums } from "../dienste";
import { PhoneIcon, PanelUsersIcon, LockIcon } from "./icons";
import styles from "./ChatView.module.css";

export function ChatView({ roomId }: { roomId: string }) {
  const room = useMatrixStore((s) => s.rooms[roomId]);
  const activeThreadRootId = useMatrixStore((s) => s.activeThreadRootId);
  const setActiveThreadRoot = useMatrixStore((s) => s.setActiveThreadRoot);
  const setCallToJoin = useMatrixStore((s) => s.setCallToJoin);
  const setRailView = useMatrixStore((s) => s.setRailView);
  const [showMembers, setShowMembers] = useState(false);

  useEffect(() => {
    const msgs = useMatrixStore.getState().timeline[roomId] ?? [];
    if (msgs.length > 0) markAsRead(roomId, msgs[msgs.length - 1].eventId);
  }, [roomId]);

  const dienst = dienstDesRaums(room?.members);
  // A group is recognised by member count, not a flag: `isDirect` only says
  // that Matrix tracks the room as a direct message.
  const istGruppe = (room?.members.length ?? 0) > 2;

  const anrufen = async () => {
    await startCall(roomId);
    setCallToJoin(roomId);
    setRailView("calls");
  };

  return (
    <div className={styles.chat}>
      <div className={styles.kopf}>
        <span className={styles.bild}>
          <Avatar name={room?.name ?? "?"} url={room?.avatarUrl} size={32} />
          <DienstPlakette dienst={dienst} />
        </span>
        <span className={styles.name}>{room?.name ?? "Unbekannt"}</span>
        {room?.isEncrypted && (
          <span className={styles.schloss} title="Ende-zu-Ende-verschlüsselt">
            <LockIcon size={13} />
          </span>
        )}
        <span className={styles.fueller} />
        <button className={styles.knopf} onClick={anrufen} title="Anrufen">
          <PhoneIcon size={17} />
        </button>
        {istGruppe && (
          <button
            className={`${styles.knopf} ${showMembers ? styles.knopfAktiv : ""}`}
            onClick={() => {
              setActiveThreadRoot(null); // side panel is exclusive
              setShowMembers(!showMembers);
            }}
            title="Teilnehmer"
          >
            <PanelUsersIcon size={17} />
            <span className={styles.zahl}>{room?.members.length ?? 0}</span>
          </button>
        )}
      </div>

      <div className={styles.koerper}>
        <div className={styles.verlauf}>
          <ChatTimeline roomId={roomId} />
        </div>
        {activeThreadRootId ? (
          <div className={styles.seite}><ThreadPane roomId={roomId} /></div>
        ) : showMembers && istGruppe ? (
          <div className={styles.seite}>
            <MemberPanel roomId={roomId} onClose={() => setShowMembers(false)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

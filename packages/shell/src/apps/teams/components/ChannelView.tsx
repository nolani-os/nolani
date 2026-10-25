/**
 * Team channel — just the conversation.
 *
 * What is NOT here, and why: a tab bar (Files | Calendar | Plan | Wiki | +) on
 * every single channel would show the **same** team content everywhere — four
 * channels, the same group folder four times. Shared content belongs to the
 * team, once. It lives in `TeamView`, reachable via the team name in the
 * sidebar.
 *
 * Chats go through `ChatView` and have no tabs at all, so a "Plan" tab must
 * never be attached unconditionally here (it would show up on one-to-one chats).
 *
 * There is no `#` before the channel name; instead a round image as in
 * MS Teams. The lock icon stays next to it — it conveys something different
 * from the image and must not get lost.
 */
import { useEffect, useState } from "react";
import { useMatrixStore, useIstZelle, useTranslation } from "@claraos/core";
import { startCall } from "../matrixClient";
import { Avatar } from "./Avatar";
import { ChatTimeline } from "./ChatTimeline";
import { MemberPanel } from "./MemberPanel";
import { ThreadPane } from "./ThreadPane";
import { InviteDialog } from "./InviteDialog";
import { InviteMemberDialog } from "./InviteMemberDialog";
import { ChannelSettings } from "./ChannelSettings";
import { LockIcon, PhoneIcon, UserPlusIcon, LinkIcon, PanelUsersIcon } from "./icons";
import styles from "./ChannelView.module.css";

export function ChannelView({ roomId }: { roomId: string }) {
  const { t } = useTranslation("teams");
  const room = useMatrixStore((s) => s.rooms[roomId]);
  const setRailView = useMatrixStore((s) => s.setRailView);
  const setCallToJoin = useMatrixStore((s) => s.setCallToJoin);
  const activeThreadRootId = useMatrixStore((s) => s.activeThreadRootId);
  const setActiveThreadRoot = useMatrixStore((s) => s.setActiveThreadRoot);

  const [showMembers, setShowMembers] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const istZelle = useIstZelle();
  const [showInviteMember, setShowInviteMember] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    setActiveThreadRoot(null);
    setShowMembers(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  const handleStartCall = async () => {
    await startCall(roomId);
    setCallToJoin(roomId);
    setRailView("calls");
  };

  return (
    <div className={styles.channelView}>
      <div className={styles.header}>
        <span className={styles.roomIcon}>
          <Avatar name={room?.name ?? "?"} url={room?.avatarUrl} size={28} />
        </span>
        <button className={styles.roomNameBtn} onClick={() => setShowSettings(true)}>
          {room?.name ?? t("common.unknown")}
        </button>
        {room?.isEncrypted && (
          <span className={styles.schloss} title={t("common.encrypted")}>
            <LockIcon size={13} />
          </span>
        )}
        {room?.topic && <span className={styles.topic}>{room.topic}</span>}
        <div className={styles.actions}>
          <button className={styles.headerBtn} onClick={handleStartCall} title={t("channel.startCall")}>
            <PhoneIcon size={17} />
          </button>
          <button className={styles.headerBtn} onClick={() => setShowInviteMember(true)} title={t("channel.inviteMember")}>
            <UserPlusIcon size={17} />
          </button>
          {/* Guest invites run through the VPN control server — a cell has no VPN. */}
          {!istZelle && (
            <button className={styles.headerBtn} onClick={() => setShowInvite(true)} title={t("channel.inviteGuest")}>
              <LinkIcon size={17} />
            </button>
          )}
          <button
            className={`${styles.headerBtn} ${showMembers ? styles.headerBtnActive : ""}`}
            onClick={() => {
              setActiveThreadRoot(null); // side panel is exclusive
              setShowMembers((v) => !v);
            }}
            title={t("channel.members")}
          >
            <PanelUsersIcon size={17} />
            <span className={styles.memberCount}>{room?.members.length ?? 0}</span>
          </button>
        </div>
      </div>

      <div className={styles.body}>
        <div className={styles.content}>
          <ChatTimeline roomId={roomId} />
        </div>
        {activeThreadRootId ? (
          <div className={styles.sidePanel}>
            <ThreadPane roomId={roomId} />
          </div>
        ) : showMembers ? (
          <div className={styles.sidePanel}>
            <MemberPanel roomId={roomId} onClose={() => setShowMembers(false)} />
          </div>
        ) : null}
      </div>

      {showInvite && <InviteDialog roomId={roomId} roomName={room?.name ?? ""} onClose={() => setShowInvite(false)} />}
      {showInviteMember && <InviteMemberDialog roomId={roomId} onClose={() => setShowInviteMember(false)} />}
      {showSettings && <ChannelSettings roomId={roomId} onClose={() => setShowSettings(false)} />}
    </div>
  );
}

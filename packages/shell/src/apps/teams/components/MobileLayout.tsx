import { useState, useRef, useEffect } from "react";
import { useMatrixStore, useTranslation, i18n } from "@claraos/core";
import type { RailView, MatrixMessage } from "@claraos/core";
import {
  loadRoomTimeline, sendFormattedMessage, sendReply, editMessage,
  sendTypingIndicator, markAsRead, startCall, sendReaction,
} from "../matrixClient";
import { Avatar } from "./Avatar";
import { DienstPlakette } from "./DienstPlakette";
import { dienstDesRaums } from "../dienste";
import { TypingIndicator } from "./TypingIndicator";
import { ReplyPreview, EditPreview } from "./ReplyPreview";
import { sanitizeHtml } from "../sanitizeHtml";
import { getMatrixClient } from "../matrixClient";
import { ThreadPane } from "./ThreadPane";
import { CallsView } from "./CallsView";
import { KalenderView } from "./KalenderView";
import { TeamView } from "./TeamView";
import { ProfilKarte } from "./ProfilKarte";
import { personenSuchen, fremdGespraeche, TALK_ANZEIGEN, type Person, type FremdGespraech } from "../personenApi";
import {
  BellIcon, MessageIcon, UsersIcon, CalendarIcon, PhoneIcon, LockIcon, HashIcon, SendIcon,
  TalkIcon, SearchIcon,
} from "./icons";
import styles from "./MobileLayout.module.css";
import { Werkzeugleiste } from "../../../components/Werkzeugleiste";
import { IconButton } from "../../../components/Button";
import { regionLocale } from "@claraos/core";

// "team" = the shared content of a team.
type MobileView = "list" | "detail" | "profil" | "team";

const TABS: { id: RailView; icon: React.ReactNode; label: string }[] = [
  { id: "activity", icon: <BellIcon size={20} />, label: "Aktivität" },
  { id: "chat", icon: <MessageIcon size={20} />, label: "Chat" },
  { id: "teams", icon: <UsersIcon size={20} />, label: "Teams" },
  { id: "calendar", icon: <CalendarIcon size={20} />, label: "Kalender" },
  { id: "calls", icon: <PhoneIcon size={20} />, label: "Anrufe" },
];

const EMPTY_MSGS: MatrixMessage[] = [];

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60000) return i18n.t("teams:mobile.now");
  if (d < 3600000) return `${Math.floor(d / 60000)}m`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h`;
  return `${Math.floor(d / 86400000)}d`;
}

function RoomListItem({
  roomId,
  onSelect,
  mitDienst,
}: {
  roomId: string;
  onSelect: () => void;
  /** Service badge on the round image — only in the mixed chat list, where
   *  "which messenger" is the actual question. */
  mitDienst?: boolean;
}) {
  const { t } = useTranslation("teams");
  const room = useMatrixStore((s) => s.rooms[roomId]);
  if (!room || room.isSpace) return null;

  return (
    <button className={styles.roomItem} onClick={onSelect}>
      <span className={styles.bildTraeger}>
        <Avatar name={room.name} url={room.avatarUrl} size={40} />
        {mitDienst && <DienstPlakette dienst={dienstDesRaums(room.members)} immer />}
      </span>
      <div className={styles.roomInfo}>
        <div className={styles.roomTop}>
          <span className={styles.roomName}>
            {room.name}
          </span>
          {room.lastMessage && <span className={styles.roomTime}>{timeAgo(room.lastMessage.ts)}</span>}
        </div>
        <div className={styles.roomPreview}>
          {room.lastMessage?.body?.trim()
            ? `${room.lastMessage.sender.replace(/^@/, "").split(":")[0]}: ${room.lastMessage.body}`
            : t("mobile.noMessages")}
        </div>
      </div>
      {room.unreadCount > 0 && <span className={styles.badge}>{room.unreadCount}</span>}
    </button>
  );
}

function MobileChatView({ roomId, onBack }: { roomId: string; onBack: () => void }) {
  const { t } = useTranslation("teams");
  const room = useMatrixStore((s) => s.rooms[roomId]);
  const allMessages = useMatrixStore((s) => s.timeline[roomId]) ?? EMPTY_MSGS;
  const meineId = getMatrixClient()?.getUserId() ?? "";
  // Thread replies belong in the overlay, not the main flow
  const messages = allMessages.filter((m) => !m.threadRootId || m.threadRootId === m.eventId);
  const activeThreadRootId = useMatrixStore((s) => s.activeThreadRootId);
  const setActiveThreadRoot = useMatrixStore((s) => s.setActiveThreadRoot);
  const replyTo = useMatrixStore((s) => s.replyTo);
  const editingEvent = useMatrixStore((s) => s.editingEvent);
  const setReplyTo = useMatrixStore((s) => s.setReplyTo);
  const setEditingEvent = useMatrixStore((s) => s.setEditingEvent);

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadRoomTimeline(roomId); }, [roomId]);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);
  useEffect(() => {
    const msgs = useMatrixStore.getState().timeline[roomId] ?? [];
    if (msgs.length > 0) markAsRead(roomId, msgs[msgs.length - 1].eventId);
  }, [roomId]);
  useEffect(() => {
    if (editingEvent) setInput(editingEvent.body);
  }, [editingEvent]);

  const handleSend = async () => {
    if (!input.trim()) return;
    const text = input;
    setInput("");
    if (editingEvent) await editMessage(roomId, editingEvent.eventId, text);
    else if (replyTo) await sendReply(roomId, text, replyTo);
    else await sendFormattedMessage(roomId, text);
  };

  let lastSender = "";

  // No tab bar (Files | Calendar | Plan | Wiki) in the phone chat view: a chat
  // shows only the conversation, and a team's shared content lives in the
  // team view.

  if (activeThreadRootId) {
    return (
      <div className={styles.chatView} data-teams-app>
        <div className={styles.chatHeader}>
          <IconButton label={t("mobile.back")} icon="back" groesse="s" onClick={() => setActiveThreadRoot(null)} />
          <span className={styles.chatTitle}>{t("mobile.thread")}</span>
        </div>
        <ThreadPane roomId={roomId} />
      </div>
    );
  }

  return (
    <div className={styles.chatView} data-teams-app>
      <div className={styles.chatHeader}>
        <IconButton label={t("mobile.back")} icon="back" groesse="s" onClick={onBack} />
        <span className={styles.chatTitle}>
          {room?.isEncrypted ? <LockIcon size={14} /> : <HashIcon size={14} />} {room?.name}
        </span>
        <IconButton label={t("mobile.startCall")} icon={<PhoneIcon size={20} />} groesse="s" onClick={() => startCall(roomId)} />
      </div>

      <>
      <div className={styles.chatMessages} ref={scrollRef}>
        {messages.map((msg) => {
          if (msg.redacted) return <div key={msg.eventId} className={styles.deleted}>Nachricht gelöscht</div>;
          const showSender = msg.sender !== lastSender;
          lastSender = msg.sender;
          // Bubbles — own messages right in accent colour, others left on surface 2.
          // The sender name appears only above the first bubble of a run and
          // never above one's own (you know who you are).
          const eigen = msg.sender === meineId;
          const zeit = new Date(msg.ts).toLocaleTimeString(regionLocale(), { hour: "2-digit", minute: "2-digit" });
          return (
            <div key={msg.eventId} className={`${styles.msg} ${eigen ? styles.msgEigen : ""} ${showSender ? styles.msgErste : ""}`}>
              {showSender && !eigen && (
                <div className={styles.msgSender}>
                  <Avatar name={msg.senderName} size={22} />
                  <span>{msg.senderName}</span>
                </div>
              )}
              <div className={styles.msgBody}>
                {msg.formattedBody
                  ? <span dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.formattedBody) }} />
                  : msg.body}
                <span className={styles.msgZeit}>
                  {zeit}{msg.isEdited && <span className={styles.edited}>· bearbeitet</span>}
                </span>
              </div>
              {Object.keys(msg.reactions || {}).length > 0 && (
                <div className={styles.msgReactions}>
                  {Object.entries(msg.reactions).map(([emoji, senders]) => (
                    <button key={emoji} className={styles.reactionChip}
                      onClick={() => sendReaction(roomId, msg.eventId, emoji)}>
                      {emoji} {senders.length}
                    </button>
                  ))}
                </div>
              )}
              {(() => {
                const replies = allMessages.filter(
                  (m2) => m2.threadRootId === msg.eventId && m2.eventId !== msg.eventId,
                ).length;
                const count = Math.max(replies, msg.threadReplyCount ?? 0);
                return count > 0 ? (
                  <button className={styles.threadIndicator} onClick={() => setActiveThreadRoot(msg.eventId)}>
                    {t("mobile.replies", { count })}
                  </button>
                ) : null;
              })()}
            </div>
          );
        })}
      </div>

      <TypingIndicator roomId={roomId} />
      {replyTo && <ReplyPreview />}
      {editingEvent && <EditPreview />}

      <div className={styles.chatComposer}>
        <input
          ref={inputRef}
          className={`${styles.chatInput} ${editingEvent ? styles.editMode : ""}`}
          placeholder={t("mobile.placeholder", { room: room?.name ?? "" })}
          value={input}
          onChange={(e) => { setInput(e.target.value); sendTypingIndicator(roomId); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); handleSend(); }
            if (e.key === "Escape") { setReplyTo(null); setEditingEvent(null); }
          }}
        />
        <IconButton label={editingEvent ? t("mobile.saveEdit") : t("mobile.send")} stufe="filled"
                    icon={editingEvent ? "check" : <SendIcon size={18} />}
                    onClick={handleSend} disabled={!input.trim()} />
      </div>
      </>
    </div>
  );
}

export function MobileLayout({ windowId }: { windowId: string }) {
  const { t } = useTranslation("teams");
  const railView = useMatrixStore((s) => s.railView);
  const setRailView = useMatrixStore((s) => s.setRailView);
  const rooms = useMatrixStore((s) => s.rooms);
  const spaces = useMatrixStore((s) => s.spaces);
  const activeRoomId = useMatrixStore((s) => s.activeRoomId);
  const setActiveRoom = useMatrixStore((s) => s.setActiveRoom);
  const clearUnread = useMatrixStore((s) => s.clearUnread);
  const expandedSpaces = useMatrixStore((s) => s.expandedSpaces);
  const toggleSpaceExpanded = useMatrixStore((s) => s.toggleSpaceExpanded);

  const [mobileView, setMobileView] = useState<MobileView>("list");
  // People search and Talk conversations — the desktop view has them; this
  // layout is a separate branch, so they must be wired up here as well.
  const [suche, setSuche] = useState("");
  const [personen, setPersonen] = useState<Person[]>([]);
  const [offenesProfil, setOffenesProfil] = useState<string | null>(null);
  const [offenesTeam, setOffenesTeam] = useState<string | null>(null);
  const [talk, setTalk] = useState<FremdGespraech[]>([]);

  useEffect(() => {
    let weg = false;
    const t = setTimeout(() => {
      personenSuchen(suche)
        .then((p) => !weg && setPersonen(p))
        .catch(() => !weg && setPersonen([]));
    }, 200);
    return () => { weg = true; clearTimeout(t); };
  }, [suche]);

  useEffect(() => {
    let weg = false;
    // see TALK_ANZEIGEN in personenApi.ts
    const holen = () => TALK_ANZEIGEN && fremdGespraeche().then((g) => !weg && setTalk(g));
    void holen();
    const t = window.setInterval(holen, 60_000);
    return () => { weg = true; window.clearInterval(t); };
  }, []);

  const handleSelectRoom = (roomId: string) => {
    setActiveRoom(roomId);
    clearUnread(roomId);
    setMobileView("detail");
  };

  const handleBack = () => {
    setMobileView("list");
    setActiveRoom(null);
  };

  const handleTabChange = (tab: RailView) => {
    setRailView(tab);
    setMobileView("list");
    setActiveRoom(null);
  };

  // Auto-switch to detail when activeRoomId is set externally (e.g. via store)
  useEffect(() => {
    if (activeRoomId && mobileView === "list") setMobileView("detail");
  }, [activeRoomId]);

  // A person's profile — full-screen on phones instead of a side column.
  if (mobileView === "profil" && offenesProfil) {
    return (
      <div className={styles.mobile} data-teams-app>
        <div className={styles.profilVollbild}>
          <ProfilKarte
            username={offenesProfil}
            onSchliessen={() => { setOffenesProfil(null); setMobileView("list"); }}
          />
        </div>
      </div>
    );
  }

  // Team view — full-screen on phones, with a back bar.
  if (mobileView === "team" && offenesTeam) {
    return (
      <div className={styles.mobile} data-teams-app>
        <div className={styles.chatHeader}>
          <IconButton label={t("mobile.back")} icon="back" groesse="s"
                      onClick={() => { setOffenesTeam(null); setMobileView("list"); }} />
          <span className={styles.chatTitle}>{spaces[offenesTeam]?.name ?? t("mobile.team")}</span>
        </div>
        <div className={styles.content}>
          <TeamView spaceId={offenesTeam} windowId={windowId} />
        </div>
      </div>
    );
  }

  // Detail view: full-screen chat
  if (mobileView === "detail" && activeRoomId) {
    return <MobileChatView roomId={activeRoomId} onBack={handleBack} />;
  }

  // List views
  const renderList = () => {
    switch (railView) {
      case "activity": {
        const recent = Object.values(rooms)
          .filter((r) => r.lastMessage && !r.isSpace && r.membership === "join")
          .sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0))
          .slice(0, 30);
        return (
          <div className={styles.list}>
            <h2 className={styles.listTitle}>{t("mobile.activity")}</h2>
            {recent.map((r) => (
              <RoomListItem key={r.roomId} roomId={r.roomId} onSelect={() => handleSelectRoom(r.roomId)} />
            ))}
            {recent.length === 0 && <div className={styles.empty}>{t("mobile.noActivity")}</div>}
          </div>
        );
      }
      case "chat": {
        // Same rule as on desktop — everything joined that is neither a space nor
        // a team channel. That includes group conversations and bridged chats,
        // without special cases.
        const kanalIds = new Set(Object.values(spaces).flatMap((sp) => sp.childRoomIds));
        const dms = Object.values(rooms)
          .filter((r) => !r.isSpace && r.membership === "join"
                      && !kanalIds.has(r.roomId) && !r.parentSpaceId)
          .sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0));
        return (
          <div className={styles.list}>
            <h2 className={styles.listTitle}>{t("mobile.chat")}</h2>
            {dms.map((r) => (
              <RoomListItem
                key={r.roomId}
                roomId={r.roomId}
                onSelect={() => handleSelectRoom(r.roomId)}
                mitDienst
              />
            ))}
            {/* Talk conversations in the same list — only then does the
                messenger marker answer a real question. */}
            {TALK_ANZEIGEN && talk.map((g) => (
              <button
                key={g.id}
                className={styles.roomItem}
                onClick={() => window.open(g.url, "_blank", "noopener")}
              >
                <Avatar name={g.name} size={40} />
                <div className={styles.roomInfo}>
                  <div className={styles.roomTop}>
                    <span className={styles.roomName}>
                      <span className={styles.dienstMarke} title="Nextcloud Talk">
                        <TalkIcon size={13} />
                      </span>
                      {g.name}
                    </span>
                  </div>
                  <div className={styles.roomPreview}>{g.letzte_nachricht || "Nextcloud Talk"}</div>
                </div>
                {g.ungelesen > 0 && <span className={styles.unreadBadge}>{g.ungelesen}</span>}
              </button>
            ))}
            {dms.length === 0 && talk.length === 0 && (
              <div className={styles.empty}>{t("mobile.noDms")}</div>
            )}
          </div>
        );
      }
      case "teams": {
        const spaceList = Object.values(spaces);
        return (
          <div className={styles.list}>
            <h2 className={styles.listTitle}>{t("mobile.teams")}</h2>
            {spaceList.map((space) => (
              <div key={space.spaceId}>
                <div className={styles.spaceHeader}>
                  <button
                    className={styles.spaceChevron}
                    onClick={() => toggleSpaceExpanded(space.spaceId)}
                    aria-label={expandedSpaces[space.spaceId] ? t("mobile.collapse") : t("mobile.expand")}
                  >{expandedSpaces[space.spaceId] ? "▾" : "▸"}</button>
                  {/* Tapping the name opens the team view with files, calendar
                      and plan — on phones as on desktop. */}
                  <button
                    className={styles.spaceNameBtn}
                    onClick={() => { setOffenesTeam(space.spaceId); setMobileView("team"); }}
                  >
                    <Avatar name={space.name} url={space.avatarUrl} size={32} />
                    <span className={styles.spaceName}>{space.name}</span>
                  </button>
                </div>
                {expandedSpaces[space.spaceId] && space.childRoomIds.map((id) => {
                  const r = rooms[id];
                  if (!r || r.isSpace) return null;
                  return <RoomListItem key={id} roomId={id} onSelect={() => handleSelectRoom(id)} />;
                })}
              </div>
            ))}
          </div>
        );
      }
      case "calendar":
        // Native calendar view (not the Nextcloud UI in an iframe); it handles
        // the phone case itself (agenda instead of week, bottom sheet).
        return <KalenderView />;
      case "calls":
        // Warning: do not embed the bare Element Call start page (without
        // widgetId/parentUrl). Then EC is NOT a widget but a standalone app
        // without a session, showing Element's login screen ("Join as guest" /
        // Sign in) inside the Teams app. The native calls section does the same
        // (ongoing calls, instant meeting) and signs in via the widget bridge.
        return <CallsView />;
      default:
        return null;
    }
  };

  const trefferSichtbar = suche.trim().length > 0;

  return (
    <div className={styles.mobile} data-teams-app>
      {/* Search — at the top on phones, as in MS Teams. This layout is a
          separate branch and the desktop search is never rendered here, so it
          needs its own. */}
      <div className={styles.sucheLeiste}>
        <span className={styles.sucheSymbol}><SearchIcon size={16} /></span>
        <input
          className={styles.sucheFeld}
          placeholder={t("mobile.searchPeople")}
          value={suche}
          onChange={(e) => setSuche(e.target.value)}
        />
        {trefferSichtbar && (
          <button className={styles.sucheLeeren} onClick={() => setSuche("")} aria-label={t("mobile.clearSearch")}>
            ✕
          </button>
        )}
      </div>

      <div className={styles.content}>
        {trefferSichtbar ? (
          <div className={styles.list}>
            <h2 className={styles.listTitle}>{t("mobile.people")}</h2>
            {personen.map((p) => (
              <button
                key={p.username}
                className={styles.roomItem}
                onClick={() => { setOffenesProfil(p.username); setMobileView("profil"); }}
              >
                <Avatar name={p.name} size={40} praesenzUser={p.username} />
                <div className={styles.roomInfo}>
                  <div className={styles.roomTop}>
                    <span className={styles.roomName}>{p.name}</span>
                  </div>
                  <div className={styles.roomPreview}>{p.teams.join(" · ") || p.email}</div>
                </div>
              </button>
            ))}
            {personen.length === 0 && (
              <div className={styles.empty}>{t("mobile.nobody", { term: suche })}</div>
            )}
          </div>
        ) : (
          renderList()
        )}
      </div>
      {/* Shared floating toolbar instead of a separate tab bar */}
      <Werkzeugleiste
        eintraege={TABS.map((tab) => ({
          key: tab.id,
          label: t(`mobile.tabs.${tab.id}`),
          icon: tab.icon,
          active: railView === tab.id,
          badge: tab.id === "activity"
            ? Object.values(rooms).reduce((n, r) => n + r.unreadCount, 0)
            : 0,
          onClick: () => handleTabChange(tab.id),
        }))}
      />
    </div>
  );
}

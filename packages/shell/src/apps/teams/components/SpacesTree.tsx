/**
 * Sidebar — two separate lists, depending on the section.
 *
 * Previously the separation was only half there: the list did distinguish
 * (Chat = direct messages, Teams = spaces), but group conversations without a
 * team ended up as "Other channels" under **Teams**, and both sections opened
 * the same channel view. Chats and team channels are now kept strictly apart:
 *  - **Chat** = one-to-one and group conversations, round avatar in front, service
 *    badge (ClaraOS, Signal, …). No "#", nothing team-related.
 *  - **Teams** = team with round avatar; clicking the name opens the team view
 *    (files/calendar/plan), with the channels below — without "#".
 */
import { useState } from "react";
import { useMatrixStore, useTranslation, Trans } from "@claraos/core";
import { createSpace, createChannel, startDM, searchUsers } from "../matrixClient";
import { Avatar } from "./Avatar";
import { DienstPlakette } from "./DienstPlakette";
import { dienstDesRaums } from "../dienste";
import { LockIcon, PhoneIcon, PlusIcon } from "./icons";
import styles from "./SpacesTree.module.css";

function NewDmForm({ onDone }: { onDone: (roomId: string | null) => void }) {
  const { t } = useTranslation("teams");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ userId: string; displayName: string }[]>([]);
  const [busy, setBusy] = useState(false);

  // Warning: Synapse does NOT list appservice users in the user directory
  // (`track_appservice_users` is off by default). A search for a bridge bot
  // therefore returned nothing — the bridge bot was unreachable from the app
  // even though it was running. Instead of reconfiguring Synapse (which would
  // also flood the directory with all the bridge ghosts) we accept a full
  // Matrix ID directly, just like Element does.
  const istMxid = (q: string) => /^@[^\s:]+:[^\s:]+\.[^\s:]+$/.test(q.trim());

  const suchen = (q: string) => {
    setQuery(q);
    const t = q.trim();
    if (!t) { setResults([]); return; }
    if (istMxid(t)) {
      setResults([{ userId: t, displayName: t }]);
      return;
    }
    void searchUsers(t).then(setResults);
  };

  const pick = async (userId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      onDone(await startDM(userId));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.createForm}>
      <input
        autoFocus
        placeholder={t("tree.dmSearch")}
        value={query}
        onChange={(e) => suchen(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onDone(null)}
        className={styles.input}
      />
      {results.map((r) => (
        <button key={r.userId} className={styles.room} onClick={() => pick(r.userId)} disabled={busy}>
          <span className={styles.bild}><Avatar name={r.displayName} size={26} /></span>
          <span className={styles.roomName}>{r.displayName}</span>
        </button>
      ))}
      {query.trim() && results.length === 0 && (
        <div className={styles.sectionLabel}>
          <Trans t={t} i18nKey="tree.noHits" components={{ code: <code /> }} />
        </div>
      )}
    </div>
  );
}

/** Short form of a sender for the preview: "Du" (you) for oneself, otherwise the
 *  display name or the part before the colon. Raw, the row looked like
 *  "@sso-smoke:example.com:" — the full Matrix ID in a chat list is not
 *  information but noise. */
function absenderKurz(sender: string, ich: string | null): string {
  if (ich && sender === ich) return "Du";
  if (!sender.startsWith("@")) return sender;
  return sender.slice(1).split(":")[0];
}

export function SpacesTree() {
  const { t } = useTranslation("teams");
  const spaces = useMatrixStore((s) => s.spaces);
  const rooms = useMatrixStore((s) => s.rooms);
  const activeRoomId = useMatrixStore((s) => s.activeRoomId);
  const activeSpaceId = useMatrixStore((s) => s.activeSpaceId);
  const expandedSpaces = useMatrixStore((s) => s.expandedSpaces);
  const railView = useMatrixStore((s) => s.railView);
  const setActiveRoom = useMatrixStore((s) => s.setActiveRoom);
  const setActiveSpace = useMatrixStore((s) => s.setActiveSpace);
  const toggleSpaceExpanded = useMatrixStore((s) => s.toggleSpaceExpanded);
  const clearUnread = useMatrixStore((s) => s.clearUnread);
  const ich = useMatrixStore((s) => s.userId);

  const [showCreateSpace, setShowCreateSpace] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState("");
  const [showCreateChannel, setShowCreateChannel] = useState<string | null>(null);
  const [newChannelName, setNewChannelName] = useState("");
  const [showNewDm, setShowNewDm] = useState(false);

  const raumWaehlen = (roomId: string) => {
    setActiveRoom(roomId);
    clearUnread(roomId);
  };

  const handleCreateSpace = async () => {
    if (!newSpaceName.trim()) return;
    await createSpace(newSpaceName.trim());
    setNewSpaceName("");
    setShowCreateSpace(false);
  };

  const handleCreateChannel = async (spaceId: string) => {
    if (!newChannelName.trim()) return;
    await createChannel(spaceId, newChannelName.trim());
    setNewChannelName("");
    setShowCreateChannel(null);
  };

  // ── Chat ────────────────────────────────────────────────────────────────
  if (railView === "chat") {
    // What counts as a chat is defined by exclusion: everything joined that is
    // neither a space nor a team's channel. That way group conversations without
    // a team land here instead of under "Other channels" in Teams — and a bridged
    // Signal chat automatically does too, without a special rule.
    const kanalIds = new Set(
      Object.values(spaces).flatMap((sp) => sp.childRoomIds),
    );
    const chats = Object.values(rooms)
      .filter((r) => !r.isSpace && r.membership === "join" && !kanalIds.has(r.roomId) && !r.parentSpaceId)
      .sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0));

    return (
      <div className={styles.tree}>
        <div className={styles.header}>
          <span>{t("tree.chat")}</span>
          <button className={styles.addBtn} onClick={() => setShowNewDm(true)} title={t("tree.newMessage")}>
            <PlusIcon size={14} />
          </button>
        </div>
        {showNewDm && (
          <NewDmForm
            onDone={(roomId) => {
              setShowNewDm(false);
              if (roomId) raumWaehlen(roomId);
            }}
          />
        )}
        {chats.map((room) => (
          <button
            key={room.roomId}
            className={`${styles.room} ${activeRoomId === room.roomId ? styles.activeRoom : ""}`}
            onClick={() => raumWaehlen(room.roomId)}
            title={room.lastMessage?.body?.trim()
              ? `${absenderKurz(room.lastMessage.sender, ich)}: ${room.lastMessage.body}`
              : room.name}
          >
            <span className={styles.bild}>
              <Avatar name={room.name} url={room.avatarUrl} size={30} />
              {/* `immer`: in this list "which service" IS the question —
                  here ClaraOS may show its badge too. */}
              <DienstPlakette dienst={dienstDesRaums(room.members)} immer />
            </span>
            <span className={styles.zeilenText}>
              <span className={styles.roomName}>{room.name}</span>
              {room.lastMessage?.body?.trim() && (
                <span className={styles.vorschau}>
                  {absenderKurz(room.lastMessage.sender, ich)}: {room.lastMessage.body}
                </span>
              )}
            </span>
            {room.isEncrypted && (
              <span className={styles.schloss} title="Ende-zu-Ende-verschlüsselt">
                <LockIcon size={11} />
              </span>
            )}
            {room.unreadCount > 0 && <span className={styles.badge}>{room.unreadCount}</span>}
          </button>
        ))}
        {chats.length === 0 && !showNewDm && (
          <button className={styles.emptyCta} onClick={() => setShowNewDm(true)}>
            {t("tree.noChats")}
            <span>{t("tree.startMessage")}</span>
          </button>
        )}
      </div>
    );
  }

  // ── Teams ───────────────────────────────────────────────────────────────
  const spaceList = Object.values(spaces);

  return (
    <div className={styles.tree}>
      <div className={styles.header}>
        <span>{t("tree.teams")}</span>
        <button className={styles.addBtn} onClick={() => setShowCreateSpace(true)} title={t("tree.createTeam")}>
          <PlusIcon size={14} />
        </button>
      </div>

      {showCreateSpace && (
        <div className={styles.createForm}>
          <input
            autoFocus
            placeholder={t("tree.teamName")}
            value={newSpaceName}
            onChange={(e) => setNewSpaceName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateSpace()}
            className={styles.input}
          />
          <div className={styles.formActions}>
            <button onClick={handleCreateSpace} className={styles.confirmBtn}>Anlegen</button>
            <button onClick={() => setShowCreateSpace(false)} className={styles.cancelBtn}>Abbrechen</button>
          </div>
        </div>
      )}

      {spaceList.map((space) => {
        const teamOffen = activeSpaceId === space.spaceId && !activeRoomId;
        return (
          <div key={space.spaceId} className={styles.spaceGroup}>
            <div className={`${styles.spaceHeader} ${teamOffen ? styles.activeRoom : ""}`}>
              <button
                className={styles.chevronBtn}
                onClick={(e) => { e.stopPropagation(); toggleSpaceExpanded(space.spaceId); }}
                title={expandedSpaces[space.spaceId] ? t("tree.collapse") : t("tree.expand")}
              >
                {expandedSpaces[space.spaceId] ? "▾" : "▸"}
              </button>
              {/* Clicking the team name opens the team view: that is where
                  the shared files, the calendar and the plan live. */}
              <button
                className={styles.spaceNameBtn}
                onClick={() => {
                  setActiveSpace(space.spaceId);
                  setActiveRoom(null);
                  // Like MS Teams: clicking the team shows it AND expands its
                  // channels. Otherwise you have to click twice.
                  if (!expandedSpaces[space.spaceId]) toggleSpaceExpanded(space.spaceId);
                }}
              >
                <span className={styles.bild}>
                  <Avatar name={space.name} url={space.avatarUrl} size={28} />
                </span>
                <span className={styles.spaceName}>{space.name}</span>
              </button>
              <button
                className={styles.addChannelBtn}
                onClick={(e) => { e.stopPropagation(); setShowCreateChannel(space.spaceId); }}
                title={t("tree.addChannel")}
              >
                <PlusIcon size={13} />
              </button>
            </div>

            {showCreateChannel === space.spaceId && (
              <div className={styles.createForm}>
                <input
                  autoFocus
                  placeholder={t("tree.channelName")}
                  value={newChannelName}
                  onChange={(e) => setNewChannelName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreateChannel(space.spaceId)}
                  className={styles.input}
                />
                <div className={styles.formActions}>
                  <button onClick={() => handleCreateChannel(space.spaceId)} className={styles.confirmBtn}>Anlegen</button>
                  <button onClick={() => setShowCreateChannel(null)} className={styles.cancelBtn}>Abbrechen</button>
                </div>
              </div>
            )}

            {expandedSpaces[space.spaceId] &&
              space.childRoomIds.map((childId) => {
                const room = rooms[childId];
                if (!room || room.isSpace) return null;
                return (
                  <button
                    key={childId}
                    className={`${styles.room} ${styles.nested} ${activeRoomId === childId ? styles.activeRoom : ""}`}
                    onClick={() => { setActiveSpace(space.spaceId); raumWaehlen(childId); }}
                  >
                    {/* Channels have no avatar — like MS Teams. And no "#". */}
                    <span className={styles.kanalName}>{room.name}</span>
                    {room.activeCall && (
                      <span className={styles.schloss} title="Anruf läuft"><PhoneIcon size={12} /></span>
                    )}
                    {room.isEncrypted && (
                      <span className={styles.schloss} title="Ende-zu-Ende-verschlüsselt"><LockIcon size={11} /></span>
                    )}
                    {room.unreadCount > 0 && <span className={styles.badge}>{room.unreadCount}</span>}
                  </button>
                );
              })}
          </div>
        );
      })}

      {spaceList.length === 0 && !showCreateSpace && (
        <button className={styles.emptyCta} onClick={() => setShowCreateSpace(true)}>
          {t("tree.noTeam")}
          <span>{t("tree.createTeamCta")}</span>
        </button>
      )}
    </div>
  );
}

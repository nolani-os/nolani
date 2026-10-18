import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useMatrixStore } from "@claraos/core";
import type { MatrixMessage } from "@claraos/core";
import {
  loadRoomTimeline, loadOlderMessages, sendFormattedMessage, sendReply, editMessage,
  sendTypingIndicator, sendReaction, uploadAndSendFile, markAsRead, getUrlPreview,
} from "../matrixClient";
import { MessageActions } from "./MessageActions";
import { TypingIndicator } from "./TypingIndicator";
import { ReplyPreview, EditPreview } from "./ReplyPreview";
import { MentionPopup } from "./MentionPopup";
import { Avatar } from "./Avatar";
import { ForwardDialog } from "./ForwardDialog";
import EmojiPicker, { Theme } from "emoji-picker-react";
import { sanitizeHtml } from "../sanitizeHtml";
import {
  PaperclipIcon, SmileIcon, SendIcon, PinIcon, ArrowDownIcon, ThreadIcon,
} from "./icons";
import styles from "./ChatTimeline.module.css";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}
function formatDate(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Heute";
  const y = new Date(today); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Gestern";
  return d.toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" });
}

const EMPTY_MSGS: MatrixMessage[] = [];
const DRAFT_KEY = (roomId: string) => `claraos-teams-draft:${roomId}`;

// Link preview cache (module-wide — previews don't change within a session)
const previewCache = new Map<string, { title?: string; description?: string; imageUrl?: string } | null>();
const URL_RE = /https?:\/\/[^\s<>"']+/;

function LinkPreview({ url }: { url: string }) {
  const [data, setData] = useState(previewCache.get(url));
  useEffect(() => {
    if (previewCache.has(url)) return;
    let alive = true;
    getUrlPreview(url).then((p) => {
      previewCache.set(url, p);
      if (alive) setData(p);
    });
    return () => { alive = false; };
  }, [url]);
  if (!data?.title) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className={styles.linkPreview}>
      {data.imageUrl && <img src={data.imageUrl} alt="" className={styles.linkPreviewImg} />}
      <span className={styles.linkPreviewText}>
        <span className={styles.linkPreviewTitle}>{data.title}</span>
        {data.description && <span className={styles.linkPreviewDesc}>{data.description.slice(0, 140)}</span>}
      </span>
    </a>
  );
}

export function ChatTimeline({ roomId }: { roomId: string }) {
  const allMessages = useMatrixStore((s) => s.timeline[roomId]) ?? EMPTY_MSGS;
  const loading = useMatrixStore((s) => !!s.timelineLoading[roomId]);
  const room = useMatrixStore((s) => s.rooms[roomId]);
  const userId = useMatrixStore((s) => s.userId);
  const receipts = useMatrixStore((s) => s.receipts[roomId]);
  const replyTo = useMatrixStore((s) => s.replyTo);
  const editingEvent = useMatrixStore((s) => s.editingEvent);
  const setReplyTo = useMatrixStore((s) => s.setReplyTo);
  const setEditingEvent = useMatrixStore((s) => s.setEditingEvent);
  const addSavedMessage = useMatrixStore((s) => s.addSavedMessage);
  const setActiveThreadRoot = useMatrixStore((s) => s.setActiveThreadRoot);

  const [input, setInput] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const [hoveredMsg, setHoveredMsg] = useState<string | null>(null);
  const [forwardMsg, setForwardMsg] = useState<MatrixMessage | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [missedCount, setMissedCount] = useState(0);
  const [newMarkerAfter, setNewMarkerAfter] = useState<string | null>(null);
  const [showPinned, setShowPinned] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const paginating = useRef(false);

  // Main timeline: thread replies belong in the side pane, not in the flow
  const messages = useMemo(
    () => allMessages.filter((m) => !m.threadRootId || m.threadRootId === m.eventId),
    [allMessages],
  );

  // Thread reply counts: store replies + server summary (unsigned)
  const threadCounts = useMemo(() => {
    const counts = new Map<string, { count: number; latestTs: number }>();
    for (const m of allMessages) {
      if (m.threadRootId && m.threadRootId !== m.eventId) {
        const e = counts.get(m.threadRootId) ?? { count: 0, latestTs: 0 };
        e.count += 1;
        e.latestTs = Math.max(e.latestTs, m.ts);
        counts.set(m.threadRootId, e);
      }
    }
    for (const m of allMessages) {
      if (m.threadReplyCount && (counts.get(m.eventId)?.count ?? 0) < m.threadReplyCount) {
        const e = counts.get(m.eventId) ?? { count: 0, latestTs: m.ts };
        e.count = m.threadReplyCount;
        counts.set(m.eventId, e);
      }
    }
    return counts;
  }, [allMessages]);

  const pinnedMessages = useMemo(
    () => (room?.pinnedEventIds ?? [])
      .map((id) => allMessages.find((m) => m.eventId === id))
      .filter((m): m is MatrixMessage => !!m && !m.redacted),
    [room?.pinnedEventIds, allMessages],
  );

  // Read receipts of other users (small rooms only, MS Teams rule: ≤20)
  const receiptsByEvent = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!receipts || (room?.members.length ?? 0) > 20) return map;
    for (const [uid, evId] of Object.entries(receipts)) {
      if (uid === userId) continue;
      map.set(evId, [...(map.get(evId) ?? []), uid]);
    }
    return map;
  }, [receipts, room?.members.length, userId]);

  useEffect(() => { loadRoomTimeline(roomId); }, [roomId]);

  // Room switch: freeze the unread boundary BEFORE markAsRead, load draft
  useEffect(() => {
    const s = useMatrixStore.getState();
    const myReceipt = s.receipts[roomId]?.[s.userId ?? ""];
    const unread = s.rooms[roomId]?.unreadCount ?? 0;
    setNewMarkerAfter(unread > 0 && myReceipt ? myReceipt : null);
    setInput(localStorage.getItem(DRAFT_KEY(roomId)) ?? "");
    setAtBottom(true);
    setMissedCount(0);
    setShowPinned(false);
    inputRef.current?.focus();
    const msgs = s.timeline[roomId] ?? [];
    if (msgs.length > 0) markAsRead(roomId, msgs[msgs.length - 1].eventId);
  }, [roomId]);

  // Autoscroll only when the user is "stuck" to the bottom — otherwise count for the button
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottom) {
      el.scrollTop = el.scrollHeight;
      setMissedCount(0);
    } else {
      setMissedCount((c) => c + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  useEffect(() => {
    if (editingEvent) { setInput(editingEvent.body); inputRef.current?.focus(); }
  }, [editingEvent]);

  const handleScroll = useCallback(async () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAtBottom(nearBottom);
    if (nearBottom) setMissedCount(0);

    // Infinite scroll: at the top → load older messages, keep the scroll anchor
    if (el.scrollTop < 60 && !paginating.current) {
      paginating.current = true;
      const prevHeight = el.scrollHeight;
      const got = await loadOlderMessages(roomId);
      if (got) {
        requestAnimationFrame(() => {
          el.scrollTop += el.scrollHeight - prevHeight;
          paginating.current = false;
        });
      } else {
        paginating.current = false;
      }
    }
  }, [roomId]);

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
    setMissedCount(0);
    const msgs = useMatrixStore.getState().timeline[roomId] ?? [];
    if (msgs.length > 0) markAsRead(roomId, msgs[msgs.length - 1].eventId);
  };

  const scrollToEvent = (eventId: string) => {
    const el = scrollRef.current?.querySelector(`[data-event-id="${CSS.escape(eventId)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlighted(eventId);
      setTimeout(() => setHighlighted(null), 1600);
    }
  };

  const handleSend = async () => {
    if (!input.trim()) return;
    const text = input;
    setInput("");
    localStorage.removeItem(DRAFT_KEY(roomId));

    if (editingEvent) {
      await editMessage(roomId, editingEvent.eventId, text);
    } else if (replyTo) {
      await sendReply(roomId, text, replyTo);
    } else {
      await sendFormattedMessage(roomId, text);
    }
    setAtBottom(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); return; }
    if (e.key === "Escape") { setReplyTo(null); setEditingEvent(null); setMentionQuery(null); return; }
    sendTypingIndicator(roomId);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    if (val) localStorage.setItem(DRAFT_KEY(roomId), val);
    else localStorage.removeItem(DRAFT_KEY(roomId));
    const cursor = e.target.selectionStart;
    const atMatch = val.slice(0, cursor).match(/@(\w*)$/);
    setMentionQuery(atMatch ? atMatch[1] : null);
  };

  const handleMentionSelect = (member: { userId: string; displayName: string }) => {
    const cursor = inputRef.current?.selectionStart ?? input.length;
    const newBefore = input.slice(0, cursor).replace(/@\w*$/, `@${member.displayName} `);
    setInput(newBefore + input.slice(cursor));
    setMentionQuery(null);
    inputRef.current?.focus();
  };

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    Array.from(e.dataTransfer.files).forEach((f) => uploadAndSendFile(roomId, f));
  }, [roomId]);

  const handleFileSelect = () => {
    const files = fileInputRef.current?.files;
    if (files) Array.from(files).forEach((f) => uploadAndSendFile(roomId, f));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  let lastDate = "";
  const markerIndex = newMarkerAfter
    ? messages.findIndex((m) => m.eventId === newMarkerAfter)
    : -1;

  return (
    <div className={styles.timeline} onDrop={handleFileDrop} onDragOver={(e) => e.preventDefault()}>
      {pinnedMessages.length > 0 && (
        <div className={styles.pinnedBar}>
          <button className={styles.pinnedToggle} onClick={() => setShowPinned((v) => !v)}>
            <PinIcon size={13} />
            {pinnedMessages.length} angepinnt
          </button>
          {showPinned && (
            <div className={styles.pinnedList}>
              {pinnedMessages.map((m) => (
                <button key={m.eventId} className={styles.pinnedItem} onClick={() => { setShowPinned(false); scrollToEvent(m.eventId); }}>
                  <span className={styles.pinnedSender}>{m.senderName}:</span> {m.body.slice(0, 80)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={styles.messages} ref={scrollRef} onScroll={handleScroll}>
        {loading && <div className={styles.loadingIndicator}>Lade Nachrichten…</div>}
        {messages.map((msg, i) => {
          if (msg.redacted) {
            return <div key={msg.eventId} className={styles.redacted}>[Nachricht gelöscht]</div>;
          }
          const dateStr = formatDate(msg.ts);
          const showDate = dateStr !== lastDate;
          lastDate = dateStr;
          const isOwn = msg.sender === userId;
          const showSender = i === 0 || messages[i - 1].sender !== msg.sender || msg.ts - messages[i - 1].ts > 300000;
          const reactionEntries = Object.entries(msg.reactions || {});
          const replyOriginal = msg.replyTo ? allMessages.find((m) => m.eventId === msg.replyTo) : null;
          const thread = threadCounts.get(msg.eventId);
          const readBy = receiptsByEvent.get(msg.eventId);
          const bodyUrl = !msg.fileUrl ? msg.body.match(URL_RE)?.[0] : null;

          return (
            <div key={msg.eventId} data-event-id={msg.eventId}>
              {showDate && <div className={styles.dateSeparator}><span>{dateStr}</span></div>}
              {markerIndex === i - 1 && markerIndex >= 0 && (
                <div className={styles.newMarker}><span>Neu</span></div>
              )}
              <div
                className={`${styles.message} ${isOwn ? styles.own : ""} ${highlighted === msg.eventId ? styles.highlighted : ""}`}
                onMouseEnter={() => setHoveredMsg(msg.eventId)}
                onMouseLeave={() => setHoveredMsg(null)}
              >
                {hoveredMsg === msg.eventId && (
                  <MessageActions
                    msg={msg}
                    onReply={() => { setReplyTo(msg); setEditingEvent(null); inputRef.current?.focus(); }}
                    onEdit={() => { setEditingEvent(msg); setReplyTo(null); }}
                    onForward={() => setForwardMsg(msg)}
                    onSave={() => addSavedMessage(msg)}
                    onThread={() => setActiveThreadRoot(msg.eventId)}
                    showEmojiPicker={() => setShowEmoji(true)}
                  />
                )}
                {showSender && (
                  <div className={styles.senderLine}>
                    <Avatar name={msg.senderName} size={24} presenceUserId={msg.sender} />
                    <span className={styles.senderName}>{msg.senderName}</span>
                    <span className={styles.time}>{formatTime(msg.ts)}</span>
                  </div>
                )}
                {msg.replyTo && (
                  <button
                    className={styles.replyRef}
                    onClick={() => replyOriginal && scrollToEvent(replyOriginal.eventId)}
                    title={replyOriginal ? "Zum Original springen" : undefined}
                  >
                    {replyOriginal ? (
                      <>
                        <span className={styles.replySender}>{replyOriginal.senderName}</span>
                        <span className={styles.replyBody}>
                          {(replyOriginal.redacted ? "[gelöscht]" : replyOriginal.body).slice(0, 120)}
                        </span>
                      </>
                    ) : (
                      <span className={styles.replyBody}>↩ Antwort auf frühere Nachricht</span>
                    )}
                  </button>
                )}
                <div className={styles.body}>
                  {msg.fileUrl && msg.fileMimeType?.startsWith("image/") ? (
                    <img src={msg.fileUrl} alt={msg.fileName} className={styles.inlineImage} />
                  ) : msg.fileUrl ? (
                    <a href={msg.fileUrl} target="_blank" rel="noopener" className={styles.fileLink}>
                      <PaperclipIcon size={14} /> {msg.fileName} ({((msg.fileSize ?? 0) / 1024).toFixed(0)} KB)
                    </a>
                  ) : msg.formattedBody ? (
                    <span dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.formattedBody) }} />
                  ) : (
                    msg.body
                  )}
                  {msg.isEdited && <span className={styles.edited}>(bearbeitet)</span>}
                </div>
                {bodyUrl && <LinkPreview url={bodyUrl} />}
                {reactionEntries.length > 0 && (
                  <div className={styles.reactions}>
                    {reactionEntries.map(([emoji, senders]) => (
                      <button
                        key={emoji}
                        className={`${styles.reactionChip} ${senders.includes(userId!) ? styles.ownReaction : ""}`}
                        onClick={() => sendReaction(roomId, msg.eventId, emoji)}
                        title={senders.join(", ")}
                      >
                        {emoji} {senders.length}
                      </button>
                    ))}
                  </div>
                )}
                {thread && thread.count > 0 && (
                  <button className={styles.threadIndicator} onClick={() => setActiveThreadRoot(msg.eventId)}>
                    <ThreadIcon size={13} />
                    {thread.count} {thread.count === 1 ? "Antwort" : "Antworten"}
                    {thread.latestTs > 0 && <span className={styles.threadTime}>· {formatTime(thread.latestTs)}</span>}
                  </button>
                )}
                {readBy && readBy.length > 0 && (
                  <div className={styles.readReceipts} title={`Gelesen von ${readBy.join(", ")}`}>
                    {readBy.slice(0, 5).map((uid) => (
                      <Avatar key={uid} name={uid.split(":")[0].replace(/^@/, "")} size={14} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!atBottom && (
        <button className={styles.jumpToBottom} onClick={jumpToBottom} title="Nach unten">
          <ArrowDownIcon size={15} />
          {missedCount > 0 && <span className={styles.jumpCount}>{missedCount}</span>}
        </button>
      )}

      <TypingIndicator roomId={roomId} />

      {replyTo && <ReplyPreview />}
      {editingEvent && <EditPreview />}

      <div className={styles.composer}>
        {mentionQuery !== null && (
          <MentionPopup
            roomId={roomId}
            query={mentionQuery}
            onSelect={handleMentionSelect}
            onClose={() => setMentionQuery(null)}
          />
        )}
        <button className={styles.composerBtn} onClick={() => fileInputRef.current?.click()} title="Datei anhängen">
          <PaperclipIcon size={18} />
        </button>
        <input type="file" ref={fileInputRef} onChange={handleFileSelect} style={{ display: "none" }} multiple />
        <textarea
          ref={inputRef}
          className={`${styles.input} ${editingEvent ? styles.editMode : ""}`}
          placeholder={editingEvent ? "Nachricht bearbeiten…" : `Nachricht an ${room?.name ?? ""}…`}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <button className={styles.composerBtn} onClick={() => setShowEmoji(!showEmoji)} title="Emoji">
          <SmileIcon size={18} />
        </button>
        <button className={styles.sendBtn} onClick={handleSend} disabled={!input.trim()} title={editingEvent ? "Speichern" : "Senden"}>
          {editingEvent ? "✓" : <SendIcon size={16} />}
        </button>
      </div>

      {showEmoji && (
        <div className={styles.emojiPicker}>
          <EmojiPicker
            theme={Theme.DARK}
            onEmojiClick={(e) => { setInput((prev) => prev + e.emoji); setShowEmoji(false); inputRef.current?.focus(); }}
            width={320}
            height={400}
          />
        </div>
      )}

      {forwardMsg && <ForwardDialog msg={forwardMsg} onClose={() => setForwardMsg(null)} />}
    </div>
  );
}

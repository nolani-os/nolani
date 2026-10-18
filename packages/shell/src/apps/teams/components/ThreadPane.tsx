import { useEffect, useRef, useState } from "react";
import { useMatrixStore } from "@claraos/core";
import type { MatrixMessage } from "@claraos/core";
import { loadThreadTimeline, sendThreadReply } from "../matrixClient";
import { sanitizeHtml } from "../sanitizeHtml";
import { Avatar } from "./Avatar";
import { XIcon, SendIcon, ThreadIcon } from "./icons";
import styles from "./ThreadPane.module.css";

// Thread side pane (MS Teams 2025 threads layout / Slack pattern).
// Deliberately exactly ONE reply mode: replies go ONLY into the thread —
// MS's "in thread and channel" dual mode is known to be confusing.

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

export function ThreadPane({ roomId }: { roomId: string }) {
  const rootId = useMatrixStore((s) => s.activeThreadRootId);
  const setActiveThreadRoot = useMatrixStore((s) => s.setActiveThreadRoot);
  const messages = useMatrixStore((s) => s.timeline[roomId]) ?? [];
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const root = messages.find((m) => m.eventId === rootId);
  const replies = messages
    .filter((m) => m.threadRootId === rootId && m.eventId !== rootId)
    .sort((a, b) => a.ts - b.ts);

  useEffect(() => {
    if (!rootId) return;
    setLoading(true);
    loadThreadTimeline(roomId, rootId).finally(() => setLoading(false));
  }, [roomId, rootId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [replies.length]);

  if (!rootId) return null;

  const handleSend = async () => {
    if (!input.trim()) return;
    const text = input;
    setInput("");
    await sendThreadReply(roomId, rootId, text);
  };

  const renderMsg = (msg: MatrixMessage, isRoot = false) => (
    <div key={msg.eventId} className={`${styles.msg} ${isRoot ? styles.rootMsg : ""}`}>
      <div className={styles.senderLine}>
        <Avatar name={msg.senderName} size={22} presenceUserId={msg.sender} />
        <span className={styles.senderName}>{msg.senderName}</span>
        <span className={styles.time}>{formatTime(msg.ts)}</span>
      </div>
      <div className={styles.body}>
        {msg.redacted ? (
          <span className={styles.redacted}>[gelöscht]</span>
        ) : msg.formattedBody ? (
          <span dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.formattedBody) }} />
        ) : (
          msg.body
        )}
      </div>
    </div>
  );

  return (
    <div className={styles.pane}>
      <div className={styles.header}>
        <ThreadIcon size={15} />
        <span className={styles.title}>Thread</span>
        <span className={styles.count}>
          {replies.length} {replies.length === 1 ? "Antwort" : "Antworten"}
        </span>
        <button className={styles.closeBtn} onClick={() => setActiveThreadRoot(null)} title="Schließen">
          <XIcon size={15} />
        </button>
      </div>

      <div className={styles.messages} ref={scrollRef}>
        {root && renderMsg(root, true)}
        {loading && replies.length === 0 && <div className={styles.loading}>Lade Thread…</div>}
        {replies.map((m) => renderMsg(m))}
        {!loading && replies.length === 0 && (
          <div className={styles.empty}>Noch keine Antworten — starte den Thread.</div>
        )}
      </div>

      <div className={styles.composer}>
        <textarea
          className={styles.input}
          placeholder="Im Thread antworten…"
          value={input}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button className={styles.sendBtn} onClick={handleSend} disabled={!input.trim()} title="Senden">
          <SendIcon size={15} />
        </button>
      </div>
    </div>
  );
}

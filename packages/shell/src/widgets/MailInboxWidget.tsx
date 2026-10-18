// Desktop widget: mail inbox (Stalwart via /api/claraos/mail, per-user).
// Shows the newest INBOX messages; unread rows are bold with a dot. A row
// click expands the message inline (body via get_message = BODY.PEEK, so we
// mark it read explicitly). Without a stored credential the API answers 409
// — surfaced as a friendly connect hint.
import { useCallback, useEffect, useRef, useState } from "react";
import type { WidgetProps } from "./registry";
import s from "./MailInbox.module.css";

interface MailMsg {
  uid: string;
  from: string;
  subject: string;
  date: string;
  seen: boolean;
}

const POLL_MS = 3 * 60 * 1000;

/** "Max Mustermann <max@…>" → "Max Mustermann"; bare address → localpart. */
function fromName(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  if (m) return m[1];
  return from.split("@")[0] || from;
}

function shortDate(rfc: string): string {
  const d = new Date(rfc);
  if (isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("de-DE", { day: "numeric", month: "numeric" });
}

export default function MailInboxWidget(_: WidgetProps) {
  const [messages, setMessages] = useState<MailMsg[] | null>(null);
  const [state, setState] = useState<"ok" | "noaccount" | "error">("ok");
  const [account, setAccount] = useState("");
  const [openUid, setOpenUid] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/claraos/mail/list_messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mailbox: "INBOX", limit: 12 }),
      });
      if (!aliveRef.current) return;
      if (r.status === 409) {
        setMessages([]);
        setState("noaccount");
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      setAccount(typeof data.account === "string" ? data.account : "");
      setState("ok");
    } catch {
      if (aliveRef.current) setState("error");
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    load();
    const iv = setInterval(load, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      aliveRef.current = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const toggleOpen = useCallback(
    async (msg: MailMsg) => {
      if (openUid === msg.uid) {
        setOpenUid(null);
        return;
      }
      setOpenUid(msg.uid);
      if (!(msg.uid in bodies)) {
        try {
          const r = await fetch("/api/claraos/mail/get_message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uid: msg.uid, mailbox: "INBOX" }),
          });
          if (r.ok) {
            const d = await r.json();
            if (aliveRef.current)
              setBodies((b) => ({ ...b, [msg.uid]: typeof d.body === "string" ? d.body : "" }));
          }
        } catch {
          /* preview stays empty; the row is expanded anyway */
        }
      }
      if (!msg.seen) {
        // optimistic: remove the dot right away, the server catches up
        setMessages((prev) =>
          (prev ?? []).map((m) => (m.uid === msg.uid ? { ...m, seen: true } : m)),
        );
        fetch("/api/claraos/mail/mark_read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uid: msg.uid, mailbox: "INBOX" }),
        }).catch(() => {});
      }
    },
    [openUid, bodies],
  );

  const unread = (messages ?? []).filter((m) => !m.seen).length;

  return (
    <div className={s.widget}>
      <div className={s.header}>
        <span className={s.title}>Posteingang</span>
        {unread > 0 && <span className={s.badge}>{unread}</span>}
        <span className={s.account}>{account}</span>
        <button
          className={s.iconBtn}
          data-no-drag
          onClick={load}
          aria-label="Aktualisieren"
        >
          ⟳
        </button>
      </div>
      <div className={s.scroll} data-no-drag>
        {messages === null && state === "ok" && <div className={s.empty}>Lade E-Mails…</div>}
        {state === "noaccount" && (
          <div className={s.empty}>
            Kein Mail-Konto verbunden.
            <span className={s.emptySub}>Apps → Mail-Zugang hinterlegen</span>
          </div>
        )}
        {state === "error" && <div className={s.empty}>Postfach nicht erreichbar</div>}
        {state === "ok" && messages !== null && messages.length === 0 && (
          <div className={s.empty}>Keine E-Mails</div>
        )}
        {state === "ok" &&
          (messages ?? []).map((m) => (
            <div key={m.uid}>
              <div
                className={`${s.row} ${m.seen ? "" : s.unread}`}
                onClick={() => toggleOpen(m)}
              >
                <span className={s.dot} aria-hidden />
                <span className={s.rowMain}>
                  <span className={s.from}>{fromName(m.from)}</span>
                  <span className={s.subject}>{m.subject || "(kein Betreff)"}</span>
                </span>
                <span className={s.date}>{shortDate(m.date)}</span>
              </div>
              {openUid === m.uid && (
                <div className={s.body}>{bodies[m.uid] ?? "Lade Nachricht…"}</div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}

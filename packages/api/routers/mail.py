"""Mail tools (Stalwart mail server).

Per-user IMAP/SMTP against the Stalwart server: every ClaraOS user acts with
their OWN mail account (claraos_app_credentials, app_id='mail', fields
username/password holding the full address; the SSO username is not
necessarily the mail localpart, e.g. `jdoe` vs `jane.doe@example.com`).
No service-account fallback: mail is personal, so without stored credentials
the user gets a clear "connect your account" hint instead of someone else's
mailbox.

As in nc_pim, the caller comes from the trusted `X-Claraos-User` header (set
out-of-band by the clara-tools gateway, never by the LLM).

Transport: IMAP 993 / SMTP 465 (implicit TLS, internal self-signed
certificate, so verification is off by default). imaplib/smtplib are
synchronous, so all calls run in asyncio.to_thread.
"""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME, heim_default  # external deployment: no silent home-server fallback
import asyncio
import email
import email.header
import email.utils
import imaplib
import io
import logging
import os
import re
import smtplib
import ssl
import zipfile
import zlib
from email.message import EmailMessage
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from auth import require_browser_user, require_caller
from database import user_tx
from encryption import decrypt_credentials

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/mail", tags=["mail"])

MAIL_IMAP_HOST = heim_default("MAIL_IMAP_HOST")
MAIL_IMAP_PORT = int(os.environ.get("MAIL_IMAP_PORT", "993"))
MAIL_SMTP_HOST = heim_default("MAIL_SMTP_HOST")
MAIL_SMTP_PORT = int(os.environ.get("MAIL_SMTP_PORT", "465"))
# internal self-signed certificate (requestTlsCertificate:false)
MAIL_TLS_VERIFY = os.environ.get("MAIL_TLS_VERIFY", "false").lower() == "true"

_BODY_CHAR_LIMIT = 8000


def _ssl_ctx() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if not MAIL_TLS_VERIFY:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _caller(request: Request) -> str:
    """Authenticated caller (service token or reverse-proxy secret) instead of
    a bare header; see `auth.require_caller`."""
    return require_caller(request)


async def _mail_credentials(username: str) -> tuple[str, str]:
    row = None
    if username:
        async with user_tx(username) as conn:   # row-level security (migrations/042)
            row = await conn.fetchrow(
                """
                SELECT credentials FROM claraos_app_credentials
                WHERE username = $1 AND app_id = 'mail' AND is_active = TRUE
                """,
                username,
            )
    if not row:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Kein Mail-Konto für {username!r} verbunden — in {PRODUCT_NAME} unter "
                "Apps → Mail verbinden (app_id 'mail': username = volle Adresse, password)."
            ),
        )
    creds = decrypt_credentials(row["credentials"])
    addr, pw = creds.get("username", ""), creds.get("password", "")
    # Relay account: sending without login via the trusted-IP relay (Stalwart
    # allows the internal app hosts with the product's sender domain). The
    # password is deliberately empty in that case.
    if addr and not pw and str(creds.get("relay", "")).lower() in ("1", "true", "yes"):
        return addr, ""
    if not addr or not pw:
        raise HTTPException(status_code=409, detail="Mail-Credential unvollständig (username/password)")
    return addr, pw


def _decode_hdr(value: Optional[str]) -> str:
    if not value:
        return ""
    parts = email.header.decode_header(value)
    out = []
    for text, enc in parts:
        if isinstance(text, bytes):
            out.append(text.decode(enc or "utf-8", errors="replace"))
        else:
            out.append(text)
    return "".join(out)


def _plain_body(msg: email.message.Message) -> str:
    """Extract the best text/plain part (fallback: HTML with tags roughly stripped)."""
    def _decode(part: email.message.Message) -> str:
        payload = part.get_payload(decode=True) or b""
        charset = part.get_content_charset() or "utf-8"
        return payload.decode(charset, errors="replace")

    if msg.is_multipart():
        html = None
        for part in msg.walk():
            if part.get_content_disposition() == "attachment":
                continue
            if part.get_content_type() == "text/plain":
                return _decode(part)
            if part.get_content_type() == "text/html" and html is None:
                html = _decode(part)
        if html is not None:
            import re
            return re.sub(r"<[^>]+>", " ", html)
        return ""
    if msg.get_content_type() == "text/html":
        import re
        return re.sub(r"<[^>]+>", " ", _decode(msg))
    return _decode(msg)


def _html_links(msg: email.message.Message) -> list[dict]:
    """Extract links from the HTML part as a separate field, independent of the body text.

    Warning: `_plain_body()` unconditionally takes the first `text/plain` part.
    Some senders put only a footer/imprint there, while the confirmation link
    lives exclusively in the HTML part. It was then invisible to the mail app
    (not clickable) and unreachable for `otp_link`. The HTML fallback did not
    help either: `re.sub(r"<[^>]+>", " ", ...)` strips tags including `href`,
    leaving link text without a target.
    This affects every service that sends HTML-only mail.

    Deliberately additive: `body` stays unchanged so existing views are unaffected.
    """
    import html as _htmlmod
    import re as _re

    roh = ""
    teile = msg.walk() if msg.is_multipart() else [msg]
    for part in teile:
        if part.get_content_disposition() == "attachment":
            continue
        if part.get_content_type() == "text/html":
            payload = part.get_payload(decode=True) or b""
            roh = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
            break
    if not roh:
        return []
    # Soft line breaks from quoted-printable would otherwise split long token URLs.
    roh = _re.sub(r"=\r?\n", "", roh)
    out: list[dict] = []
    gesehen: set[str] = set()
    for treffer in _re.finditer(r"<a\b[^>]*?href=[\"\']([^\"\']+)[\"\'][^>]*>(.*?)</a>",
                                roh, _re.I | _re.S):
        href = _htmlmod.unescape(treffer.group(1).strip())
        if not href.lower().startswith(("http://", "https://")) or href in gesehen:
            continue
        gesehen.add(href)
        text = _htmlmod.unescape(_re.sub(r"<[^>]+>", " ", treffer.group(2)))
        out.append({"text": " ".join(text.split())[:80], "href": href})
        if len(out) >= 40:      # marketing mails have dozens; cap to keep it bounded
            break
    return out


# ── IMAP sync helpers (run in to_thread) ──────────────────────────────────

def _imap_connect(addr: str, pw: str) -> imaplib.IMAP4_SSL:
    if not pw:
        # Relay accounts (the OIDC directory no longer issues SMTP/IMAP
        # passwords) can only SEND; reading would need a master user.
        raise HTTPException(status_code=409,
                            detail=f"{addr}: reines Versand-Konto (Trusted-IP-Relay) — "
                                   "kein IMAP-Zugriff.")
    M = imaplib.IMAP4_SSL(MAIL_IMAP_HOST, MAIL_IMAP_PORT, ssl_context=_ssl_ctx(), timeout=20)
    M.login(addr, pw)
    return M


def _parse_mailbox_list(boxes) -> list[str]:
    out = []
    for raw in boxes or []:
        # b'(\\Subscribed) "." "Sent Items"' -> last quoted/atom part
        s = raw.decode(errors="replace")
        name = s.rsplit(' "', 1)[-1].rstrip('"') if ' "' in s else s.rsplit(" ", 1)[-1]
        out.append(name.strip('"'))
    return out


def _list_mailboxes_sync(addr: str, pw: str) -> list[str]:
    M = _imap_connect(addr, pw)
    try:
        return _parse_mailbox_list(M.list()[1])
    finally:
        M.logout()


def _fetch_overview_sync(addr: str, pw: str, mailbox: str, limit: int,
                         unread_only: bool, query: str | None,
                         total: list[int] | None = None) -> list[dict[str, Any]]:
    """Newest `limit` matches; `total[0]` receives the number of ALL matches."""
    total = total if total is not None else [0]
    M = _imap_connect(addr, pw)
    try:
        typ, _ = M.select(f'"{mailbox}"', readonly=True)
        if typ != "OK":
            raise HTTPException(status_code=422, detail=f"Postfach {mailbox!r} nicht gefunden")
        criteria: list[str] = ["UNSEEN"] if unread_only else ["ALL"]
        if query:
            # OR SUBJECT/FROM covers the everyday search case; unread_only still applies
            q = query.replace('"', "")
            criteria = (["UNSEEN"] if unread_only else []) + ["OR", f'SUBJECT "{q}"', f'FROM "{q}"']
        typ, data = M.uid("SEARCH", None, *criteria)
        uids = (data[0] or b"").split()
        total[0] = len(uids)
        uids = uids[-limit:][::-1]  # newest first
        out: list[dict[str, Any]] = []
        for uid in uids:
            typ, msg_data = M.uid("FETCH", uid, "(FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])")
            if typ != "OK" or not msg_data or msg_data[0] is None:
                continue
            # FLAGS are in the first element of the FETCH tuple, not in the
            # top-level bytes (those only hold the closing b')')
            raw_flags = b" ".join(
                p[0] for p in msg_data if isinstance(p, tuple) and p and isinstance(p[0], bytes)
            ) + b" " + b" ".join(p for p in msg_data if isinstance(p, bytes))
            header_blob = next((p[1] for p in msg_data if isinstance(p, tuple)), b"")
            msg = email.message_from_bytes(header_blob)
            out.append({
                "uid": uid.decode(),
                "from": _decode_hdr(msg.get("From")),
                "to": _decode_hdr(msg.get("To")),
                "subject": _decode_hdr(msg.get("Subject")),
                "date": msg.get("Date", ""),
                "seen": b"\\Seen" in raw_flags,
            })
        return out
    finally:
        M.logout()


def _get_message_sync(addr: str, pw: str, mailbox: str, uid: str) -> dict[str, Any]:
    M = _imap_connect(addr, pw)
    try:
        typ, _ = M.select(f'"{mailbox}"', readonly=True)
        if typ != "OK":
            raise HTTPException(status_code=422, detail=f"Postfach {mailbox!r} nicht gefunden")
        typ, msg_data = M.uid("FETCH", uid.encode(), "(BODY.PEEK[])")
        blob = next((p[1] for p in (msg_data or []) if isinstance(p, tuple)), None)
        if typ != "OK" or blob is None:
            raise HTTPException(status_code=404, detail=f"Mail uid={uid} nicht gefunden")
        msg = email.message_from_bytes(blob)
        body = _plain_body(msg).strip()
        truncated = len(body) > _BODY_CHAR_LIMIT
        attachments = [
            _decode_hdr(part.get_filename() or "unnamed")
            for part in msg.walk()
            if part.get_content_disposition() == "attachment"
        ]
        return {
            "uid": uid,
            "from": _decode_hdr(msg.get("From")),
            "to": _decode_hdr(msg.get("To")),
            "cc": _decode_hdr(msg.get("Cc")),
            "subject": _decode_hdr(msg.get("Subject")),
            "date": msg.get("Date", ""),
            "body": body[:_BODY_CHAR_LIMIT],
            "body_truncated": truncated,
            "links": _html_links(msg),
            "attachments": attachments,
        }
    finally:
        M.logout()


# Anyone can mail a few-MB archive that inflates to gigabytes; the caller only
# keeps a few thousand characters anyway, so unpacking stops here.
_ENTPACKT_MAX = 2 * 1024 * 1024


def _entpacken(name: str, roh: bytes) -> tuple[str, str]:
    """Unpack ZIP/GZIP attachments, interpret everything else as text.

    Why: DMARC reports arrive as `.zip`/`.gz` containing XML, and `get_message`
    only returns the attachment *filename*, so the content was unreachable for
    the assistant.
    Returns: (text, note). Binary data that cannot be read as text is NOT
    returned; the endpoint is meant for text attachments.
    """
    klein = name.lower()
    if klein.endswith(".zip"):
        teile, rest = [], _ENTPACKT_MAX
        with zipfile.ZipFile(io.BytesIO(roh)) as z:
            for info in z.infolist():
                if info.is_dir() or rest <= 0:
                    continue
                # Read with a limit instead of trusting the header sizes: an
                # attacker writes those too.
                with z.open(info) as f:
                    stueck = f.read(rest)
                rest -= len(stueck)
                teile.append(stueck.decode("utf-8", "replace"))
        return "\n".join(teile), f"aus ZIP entpackt ({len(teile)} Datei(en))"
    if klein.endswith(".gz"):
        d = zlib.decompressobj(16 + zlib.MAX_WBITS)
        return d.decompress(roh, _ENTPACKT_MAX).decode("utf-8", "replace"), "aus GZIP entpackt"
    return roh.decode("utf-8", "replace"), "unverändert als Text gelesen"


def _get_attachment_sync(addr: str, pw: str, mailbox: str, uid: str,
                         filename: Optional[str]) -> dict[str, Any]:
    M = _imap_connect(addr, pw)
    try:
        typ, _ = M.select(f'"{mailbox}"', readonly=True)
        if typ != "OK":
            raise HTTPException(status_code=422, detail=f"Postfach {mailbox!r} nicht gefunden")
        typ, msg_data = M.uid("FETCH", uid.encode(), "(BODY.PEEK[])")
        blob = next((p[1] for p in (msg_data or []) if isinstance(p, tuple)), None)
        if typ != "OK" or blob is None:
            raise HTTPException(status_code=404, detail=f"Mail uid={uid} nicht gefunden")
        msg = email.message_from_bytes(blob)
        teile = [p for p in msg.walk() if p.get_content_disposition() == "attachment"]
        namen = [_decode_hdr(p.get_filename() or "unnamed") for p in teile]
        if not teile:
            raise HTTPException(status_code=404, detail=f"Mail uid={uid} hat keine Anhänge")
        if filename:
            nadel = filename.strip().lower()
            treffer = [(p, n) for p, n in zip(teile, namen) if n.lower() == nadel] \
                or [(p, n) for p, n in zip(teile, namen) if nadel in n.lower()]
            if not treffer:
                raise HTTPException(
                    status_code=404,
                    detail=f"kein Anhang {filename!r} in uid={uid} — vorhanden: {namen}")
            if len(treffer) > 1:
                raise HTTPException(
                    status_code=409,
                    detail=f"{len(treffer)} Anhänge passen auf {filename!r}: "
                           f"{[n for _, n in treffer]}")
            teil, name = treffer[0]
        elif len(teile) == 1:
            teil, name = teile[0], namen[0]
        else:
            raise HTTPException(
                status_code=409,
                detail=f"uid={uid} hat {len(teile)} Anhänge — filename angeben: {namen}")
        roh = teil.get_payload(decode=True) or b""
        try:
            text, hinweis = _entpacken(name, roh)
        except Exception as e:
            raise HTTPException(status_code=422,
                                detail=f"Anhang {name!r} nicht lesbar: {e}")
        return {
            "uid": uid,
            "filename": name,
            "content_type": teil.get_content_type(),
            "bytes": len(roh),
            "note": hinweis,
            "attachments_available": namen,
            "text": text[:_BODY_CHAR_LIMIT],
            "text_truncated": len(text) > _BODY_CHAR_LIMIT,
        }
    finally:
        M.logout()


def _create_mailbox_sync(addr: str, pw: str, name: str) -> dict[str, Any]:
    """Create and subscribe to a mailbox folder.

    Why: otherwise there is no way in the stack to create a mail folder
    (`/post/mailboxes` is GET only), so no mail rule could be built, because
    Sieve `fileinto :mailboxid` requires an existing folder.
    Idempotent: an existing folder is not an error.
    """
    sauber = name.strip().strip('"')
    if not sauber or any(c in sauber for c in '"\r\n'):
        raise HTTPException(status_code=422, detail=f"unzulaessiger Ordnername {name!r}")
    M = _imap_connect(addr, pw)
    try:
        typ, dat = M.create(f'"{sauber}"')
        schon = typ != "OK" and b"alreadyexists" in (b"".join(dat or [])).lower().replace(b" ", b"")
        if typ != "OK" and not schon:
            raise HTTPException(
                status_code=422,
                detail=f"Ordner {sauber!r} nicht angelegt: {(dat or [b''])[0].decode('utf-8', 'replace')}")
        M.subscribe(f'"{sauber}"')
        boxes = _parse_mailbox_list(M.list()[1])
        return {"mailbox": sauber, "created": not schon, "existed": bool(schon),
                "mailboxes": boxes}
    finally:
        M.logout()


def _mark_message_sync(addr: str, pw: str, mailbox: str, uid: str, seen: bool) -> None:
    M = _imap_connect(addr, pw)
    try:
        typ, _ = M.select(f'"{mailbox}"')
        if typ != "OK":
            raise HTTPException(status_code=422, detail=f"Postfach {mailbox!r} nicht gefunden")
        op = "+FLAGS" if seen else "-FLAGS"
        typ, _ = M.uid("STORE", uid.encode(), op, r"(\Seen)")
        if typ != "OK":
            raise HTTPException(status_code=404, detail=f"Mail uid={uid} nicht gefunden")
    finally:
        M.logout()


def _delete_message_sync(addr: str, pw: str, mailbox: str, uid: str) -> None:
    M = _imap_connect(addr, pw)
    try:
        typ, _ = M.select(f'"{mailbox}"')
        if typ != "OK":
            raise HTTPException(status_code=422, detail=f"Postfach {mailbox!r} nicht gefunden")
        typ, _ = M.uid("STORE", uid.encode(), "+FLAGS", r"(\Deleted)")
        if typ != "OK":
            raise HTTPException(status_code=404, detail=f"Mail uid={uid} nicht gefunden")
        M.expunge()
    finally:
        M.logout()


_STATUS_RE = re.compile(r"(MESSAGES|UNSEEN) (\d+)")


def _status_counts(M: imaplib.IMAP4_SSL, box: str) -> dict[str, Any]:
    typ, data = M.status(f'"{box}"', "(MESSAGES UNSEEN)")
    if typ != "OK" or not data or not data[0]:
        return {"mailbox": box, "error": "STATUS failed"}
    raw = data[0].decode(errors="replace") if isinstance(data[0], bytes) else str(data[0])
    found = dict(_STATUS_RE.findall(raw))
    return {"mailbox": box,
            "total": int(found["MESSAGES"]) if "MESSAGES" in found else None,
            "unread": int(found["UNSEEN"]) if "UNSEEN" in found else None}


def _count_sync(addr: str, pw: str, mailbox: str | None) -> list[dict[str, Any]]:
    """Exact counts per folder via IMAP STATUS: no listing, no cap."""
    M = _imap_connect(addr, pw)
    try:
        boxes = [mailbox] if mailbox else _parse_mailbox_list(M.list()[1])
        out = [_status_counts(M, b) for b in boxes]
        if mailbox and out[0].get("error"):
            raise HTTPException(status_code=404,
                                detail=f"Ordner {mailbox!r} nicht gefunden — list_mailboxes zeigt die Ordner")
        return out
    finally:
        M.logout()


_DRAFT_NAMES = ("Drafts", "Entwürfe", "INBOX.Drafts", "INBOX/Drafts")


def _drafts_box(M: imaplib.IMAP4_SSL) -> str:
    r"""The folder flagged \Drafts (RFC 6154 special use), else a usual name."""
    _typ, raw = M.list()
    names = _parse_mailbox_list(raw)
    for line, name in zip(raw or [], names):
        if isinstance(line, bytes) and b"\\drafts" in line.lower():
            return name
    for cand in _DRAFT_NAMES:
        if cand in names:
            return cand
    raise HTTPException(status_code=404, detail=f"Kein Entwürfe-Ordner gefunden (Ordner: {names})")


def _create_draft_sync(addr: str, pw: str, body: "CreateDraftIn") -> dict[str, Any]:
    r"""Store a draft via IMAP APPEND (flag \Draft). Nothing is sent."""
    msg = EmailMessage()
    msg["From"] = addr
    to = _draft_recipients(body.to, addr, body.an_mich_selbst)
    if to:
        msg["To"] = ", ".join(to)
    if body.cc:
        msg["Cc"] = ", ".join(body.cc)
    msg["Subject"] = body.subject
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg_id = email.utils.make_msgid(domain=addr.split("@", 1)[-1])
    msg["Message-ID"] = msg_id
    msg.set_content(body.body)
    M = _imap_connect(addr, pw)
    try:
        box = _drafts_box(M)
        typ, dat = M.append(f'"{box}"', r"(\Draft \Seen)",
                            imaplib.Time2Internaldate(email.utils.localtime()), msg.as_bytes())
        if typ != "OK":
            raise HTTPException(status_code=502, detail=f"Entwurf nicht gespeichert: {(dat or [b''])[0]!r}")
        # Read back: the server names the new UID (UIDPLUS "APPENDUID"); fetch that
        # message and compare its Message-ID. HEADER search is not reliable on
        # every server (Stalwart found nothing), the UID is.
        M.select(f'"{box}"', readonly=True)
        m = re.search(rb"APPENDUID \d+ (\d+)", b" ".join(x for x in (dat or []) if isinstance(x, bytes)))
        uids: list[bytes] = []
        if m:
            uids = [m.group(1)]
        else:
            typ, data = M.uid("SEARCH", None, "SUBJECT", f'"{body.subject.replace(chr(34), "")}"')
            uids = (data[0] or b"").split()[-5:] if typ == "OK" else []
        found = []
        for u in uids:
            typ, md = M.uid("FETCH", u, "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
            blob = next((p[1] for p in (md or []) if isinstance(p, tuple)), b"")
            if msg_id.encode() in (blob or b""):
                found.append(u)
        uids = found
        verified = len(uids) == 1
        # `kind` + `draft_id` come FIRST: the agent's tool.end event carries only
        # the first ~120 characters, and the chat proxy turns exactly these
        # into the draft card (Send / Open in Post / Discard).
        out: dict[str, Any] = {
            "kind": "mail_draft", "draft_id": uids[0].decode() if uids else None,
            "ok": verified, "id": uids[0].decode() if uids else None, "verified": verified,
            "mailbox": box, "subject": body.subject, "to": to, "cc": body.cc,
            "sent": False, "link": "/?app=post"}
        if not verified:
            out.update({"error": f"Draft stored but found {len(uids)}x when reading it back.",
                        "hint": "Check the drafts folder with list_messages before confirming."})
        return out
    finally:
        M.logout()


def _send_mail_sync(addr: str, pw: str, to: list[str], subject: str, body: str,
                    cc: list[str]) -> None:
    msg = EmailMessage()
    msg["From"] = addr
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = subject
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["Message-ID"] = email.utils.make_msgid(domain=addr.split("@", 1)[-1])
    msg.set_content(body)
    if not pw:
        # Trusted-IP relay (port 25, no auth). Stalwart only allows the internal
        # app hosts AND the product's sender domain. No Sent copy (no IMAP login).
        with smtplib.SMTP(MAIL_SMTP_HOST, 25, timeout=25) as S:
            S.send_message(msg)
        return
    with smtplib.SMTP_SSL(MAIL_SMTP_HOST, MAIL_SMTP_PORT, context=_ssl_ctx(), timeout=25) as S:
        S.login(addr, pw)
        S.send_message(msg)
    # Best-effort copy into the Sent folder (Stalwart: "Sent Items");
    # failure is not fatal
    try:
        M = _imap_connect(addr, pw)
        try:
            for sent_box in ('"Sent Items"', '"Sent"'):
                typ, _ = M.append(sent_box, r"(\Seen)",
                                  imaplib.Time2Internaldate(email.utils.localtime()),
                                  msg.as_bytes())
                if typ == "OK":
                    break
        finally:
            M.logout()
    except Exception:
        logger.info("mail: Sent-Kopie fehlgeschlagen (nicht fatal)")


def _uid_ok(uid: str) -> bytes:
    if not re.fullmatch(r"\d{1,12}", uid or ""):
        raise HTTPException(status_code=422, detail="Ungültige Entwurfs-ID")
    return uid.encode()


def _fetch_draft(M: imaplib.IMAP4_SSL, uid: str) -> tuple[str, email.message.Message]:
    r"""(drafts folder, message) for a UID in the drafts folder; must carry \Draft."""
    box = _drafts_box(M)
    typ, _ = M.select(f'"{box}"')
    if typ != "OK":
        raise HTTPException(status_code=404, detail="Entwürfe-Ordner nicht lesbar")
    typ, data = M.uid("FETCH", _uid_ok(uid), "(FLAGS BODY.PEEK[])")
    blob, flags = None, b""
    for part in data or []:
        if isinstance(part, tuple):
            flags, blob = part[0] or b"", part[1]
    if typ != "OK" or blob is None:
        raise HTTPException(status_code=404,
                            detail="Entwurf nicht mehr vorhanden (in Post geändert, gesendet oder gelöscht).")
    if b"\\draft" not in flags.lower():
        raise HTTPException(status_code=409, detail="Diese Nachricht ist kein Entwurf.")
    return box, email.message_from_bytes(blob)


def _expunge_uid(M: imaplib.IMAP4_SSL, uid: str) -> None:
    """Remove exactly this UID (UID EXPUNGE, RFC 4315), never other deleted mails."""
    M.uid("STORE", _uid_ok(uid), "+FLAGS", r"(\Deleted)")
    typ, _ = M.uid("EXPUNGE", _uid_ok(uid))
    if typ != "OK":
        raise HTTPException(status_code=502, detail="Entwurf konnte nicht entfernt werden")


def _draft_view(uid: str, msg: email.message.Message, box: str) -> dict[str, Any]:
    body = _plain_body(msg).strip()
    return {"draft_id": uid, "mailbox": box,
            "to": _decode_hdr(msg.get("To")), "cc": _decode_hdr(msg.get("Cc")),
            "subject": _decode_hdr(msg.get("Subject")),
            "preview": body[:600], "length": len(body)}


def _draft_preview_sync(addr: str, secret: str, uid: str) -> dict[str, Any]:
    M = _imap_connect(addr, secret)
    try:
        box, msg = _fetch_draft(M, uid)
        return _draft_view(uid, msg, box)
    finally:
        M.logout()


async def draft_preview(username: str, uid: str) -> dict[str, Any] | None:
    """Card data for a stored draft (used by the chat proxy); None if unreadable."""
    try:
        addr, secret = await _mail_credentials(username)
        return await asyncio.to_thread(_draft_preview_sync, addr, secret, uid)
    except Exception as exc:  # noqa: BLE001 — a card is optional, the chat is not
        logger.info("mail: draft preview %s for %s failed: %s", uid, username, exc)
        return None


def _send_draft_sync(addr: str, secret: str, uid: str) -> dict[str, Any]:
    """Send the stored draft as it is, file a copy in Sent, remove the draft."""
    M = _imap_connect(addr, secret)
    try:
        box, msg = _fetch_draft(M, uid)
        sender = email.utils.parseaddr(msg.get("From") or "")[1].lower()
        if sender and sender != addr.lower():
            raise HTTPException(status_code=409, detail="Absender des Entwurfs ist nicht dein Konto.")
        rcpts = [a for _n, a in email.utils.getaddresses(
            msg.get_all("To", []) + msg.get_all("Cc", []) + msg.get_all("Bcc", [])) if a]
        if not rcpts:
            raise HTTPException(status_code=422, detail="Der Entwurf hat keinen Empfänger — in Post ergänzen.")
        view = _draft_view(uid, msg, box)
        del msg["Date"]
        msg["Date"] = email.utils.formatdate(localtime=True)
        if not msg.get("From"):
            msg["From"] = addr
        if "Bcc" in msg:
            del msg["Bcc"]
        with smtplib.SMTP_SSL(MAIL_SMTP_HOST, MAIL_SMTP_PORT, context=_ssl_ctx(), timeout=25) as S:
            S.login(addr, secret)
            S.send_message(msg, from_addr=addr, to_addrs=rcpts)
        for sent_box in ('"Sent Items"', '"Sent"'):
            try:
                typ, _ = M.append(sent_box, r"(\Seen)",
                                  imaplib.Time2Internaldate(email.utils.localtime()), msg.as_bytes())
                if typ == "OK":
                    break
            except imaplib.IMAP4.error:
                continue
        try:
            _expunge_uid(M, uid)
            view["draft_removed"] = True
        except Exception:  # noqa: BLE001 — sent is sent; a leftover draft stays visible
            view["draft_removed"] = False
        return {**view, "ok": True, "sent": True, "recipients": len(rcpts)}
    finally:
        M.logout()


def _discard_draft_sync(addr: str, secret: str, uid: str) -> dict[str, Any]:
    M = _imap_connect(addr, secret)
    try:
        _fetch_draft(M, uid)
        _expunge_uid(M, uid)
        return {"ok": True, "draft_id": uid, "discarded": True}
    finally:
        M.logout()


# ── Schemas ──────────────────────────────────────────────────────────────────
class ListMessagesIn(BaseModel):
    mailbox: str = "INBOX"
    limit: int = 10
    unread_only: bool = False
    query: Optional[str] = None


class GetMessageIn(BaseModel):
    uid: str
    mailbox: str = "INBOX"


class CreateMailboxIn(BaseModel):
    name: str


class GetAttachmentIn(BaseModel):
    uid: str
    mailbox: str = "INBOX"
    filename: Optional[str] = None


class DeleteMessageIn(BaseModel):
    uid: str
    mailbox: str = "INBOX"


class SendMailIn(BaseModel):
    to: list[str]
    subject: str
    body: str
    cc: list[str] = []


class CountMessagesIn(BaseModel):
    mailbox: Optional[str] = None   # None = every folder


class CreateDraftIn(BaseModel):
    to: list[str] = []
    subject: str
    body: str
    cc: list[str] = []
    # True = addressed to the account itself (the agent knows no own address)
    an_mich_selbst: bool = False


def _draft_recipients(to: list[str], addr: str, an_mich_selbst: bool) -> list[str]:
    """`To` of a draft: with an_mich_selbst the account's own address comes first.

    Without the flag `to` stays as given; an empty `to` means no recipient.
    """
    if not an_mich_selbst or not addr:
        return list(to)
    rest = [a for a in to if a.strip().lower() != addr.lower()]
    return [addr, *rest]


# ── Routes ───────────────────────────────────────────────────────────────────
@router.post("/list_mailboxes")
async def list_mailboxes(request: Request) -> dict:
    addr, pw = await _mail_credentials(_caller(request))
    boxes = await asyncio.to_thread(_list_mailboxes_sync, addr, pw)
    return {"account": addr, "mailboxes": boxes}


@router.post("/list_messages")
async def list_messages(body: ListMessagesIn, request: Request) -> dict:
    addr, pw = await _mail_credentials(_caller(request))
    total = [0]
    msgs = await asyncio.to_thread(
        _fetch_overview_sync, addr, pw, body.mailbox, max(1, min(body.limit, 50)),
        body.unread_only, (body.query or "").strip() or None, total,
    )
    out = {"account": addr, "mailbox": body.mailbox, "total": total[0],
           "returned": len(msgs), "messages": msgs}
    if total[0] > len(msgs):
        # A capped list must say so; otherwise "how many?" gets the cap as the answer.
        out["more"] = (f"{total[0] - len(msgs)} weitere passende Mails nicht aufgelistet. "
                       "Für Anzahlen count_messages benutzen, nicht die Liste zählen.")
    return out


@router.post("/count_messages")
async def count_messages(body: CountMessagesIn, request: Request) -> dict:
    addr, pw = await _mail_credentials(_caller(request))
    rows = await asyncio.to_thread(_count_sync, addr, pw, (body.mailbox or "").strip() or None)
    out: dict[str, Any] = {"account": addr, "folders": rows}
    if not body.mailbox:
        out["total_unread"] = sum(r.get("unread") or 0 for r in rows)
    return out


@router.post("/create_draft")
async def create_draft(body: CreateDraftIn, request: Request) -> dict:
    """Save an e-mail as a draft in the user's own drafts folder. Never sends."""
    addr, pw = await _mail_credentials(_caller(request))
    res = await asyncio.to_thread(_create_draft_sync, addr, pw, body)
    logger.info("mail: draft stored for %s in %s (verified=%s)", addr, res.get("mailbox"),
                res.get("verified"))
    return res


@router.post("/get_message")
async def get_message(body: GetMessageIn, request: Request) -> dict:
    addr, pw = await _mail_credentials(_caller(request))
    return await asyncio.to_thread(_get_message_sync, addr, pw, body.mailbox, body.uid)


@router.post("/create_mailbox")
async def create_mailbox(body: CreateMailboxIn, request: Request) -> dict:
    addr, pw = await _mail_credentials(_caller(request))
    return await asyncio.to_thread(_create_mailbox_sync, addr, pw, body.name)


@router.post("/get_attachment")
async def get_attachment(body: GetAttachmentIn, request: Request) -> dict:
    addr, pw = await _mail_credentials(_caller(request))
    return await asyncio.to_thread(
        _get_attachment_sync, addr, pw, body.mailbox, body.uid, body.filename
    )


@router.post("/mark_read")
async def mark_read(body: GetMessageIn, request: Request) -> dict:
    addr, pw = await _mail_credentials(_caller(request))
    await asyncio.to_thread(_mark_message_sync, addr, pw, body.mailbox, body.uid, True)
    return {"status": "marked_read", "uid": body.uid}


@router.post("/mark_unread")
async def mark_unread(body: GetMessageIn, request: Request) -> dict:
    addr, pw = await _mail_credentials(_caller(request))
    await asyncio.to_thread(_mark_message_sync, addr, pw, body.mailbox, body.uid, False)
    return {"status": "marked_unread", "uid": body.uid}


@router.post("/delete_message")
async def delete_message(body: DeleteMessageIn, request: Request) -> dict:
    addr, pw = await _mail_credentials(_caller(request))
    await asyncio.to_thread(_delete_message_sync, addr, pw, body.mailbox, body.uid)
    return {"status": "deleted", "uid": body.uid, "mailbox": body.mailbox}


@router.post("/send_mail")
async def send_mail(body: SendMailIn, request: Request) -> dict:
    if not body.to:
        raise HTTPException(status_code=422, detail="Empfänger fehlt")
    addr, pw = await _mail_credentials(_caller(request))
    await asyncio.to_thread(_send_mail_sync, addr, pw, body.to, body.subject, body.body, body.cc)
    logger.info("mail: %s → %s (%r)", addr, body.to, body.subject[:60])
    return {"status": "sent", "from": addr, "to": body.to, "subject": body.subject}


# ── Draft buttons in the chat card (human only) ─────────────────────────────
# Sending a stored draft is the step the assistant must NOT be able to take:
# it prepares the draft (create_draft), the person presses "Senden". These
# routes are therefore no tool and refuse the service token outright.

@router.post("/drafts/{draft_id}/send")
async def send_draft(draft_id: str, request: Request) -> dict:
    user = require_browser_user(request)
    addr, secret = await _mail_credentials(user)
    res = await asyncio.to_thread(_send_draft_sync, addr, secret, draft_id)
    logger.info("mail: draft %s sent by %s via button (%d recipients)", draft_id, addr,
                res.get("recipients", 0))
    return res


@router.post("/drafts/{draft_id}/discard")
async def discard_draft(draft_id: str, request: Request) -> dict:
    user = require_browser_user(request)
    addr, secret = await _mail_credentials(user)
    return await asyncio.to_thread(_discard_draft_sync, addr, secret, draft_id)

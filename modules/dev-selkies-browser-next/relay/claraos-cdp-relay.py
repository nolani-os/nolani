#!/usr/bin/env python3
"""ClaraOS CDP input relay v2.

Runs as a custom service INSIDE the Selkies Chromium container (same network
namespace, talks to 127.0.0.1:9222). Responsibilities:

1. WebSocket endpoint (0.0.0.0:9226, path /claraos-cdp) for the chromeless dashboard:
   CDP commands restricted by a METHOD ALLOWLIST (input/emulation/layout/navigation
   only) plus ClaraOS.* verbs of its own (probes, tabs). No raw Runtime/Target access.
2. ONE browser-level connection with flat sessions (Target.attachToTarget with
   flatten) instead of one upstream connection per client. This gives:
   - Input always goes to the ACTIVE (visible) tab. A per-client connection would
     stay bound to the tab that was active at connect time (window.open would
     then mean invisible typing into the old tab).
   - Tabs: list/create/activate/close/thumb via Target.* / Page.captureScreenshot,
     encapsulated on the server side.
   - Mobile profile (UA/touch) per target via the persistent session: CDP
     overrides die with their session, the browser connection lives on.
3. Probes (fixed expressions; the client supplies ONLY coordinates/IDs, never free
   JS): probeFocus, probeElementAt, selectWordAt, getSelection, selectAll,
   deleteSelection, clearData, setDesktopMode.

Security: the endpoint sits behind the reverse proxy (authenticated, IP allowlist)
and is published only on a host port restricted by a firewall rule. The allowlist
and the verb encapsulation prevent full browser access even if the endpoint is reached.
"""
import asyncio
import json
import logging
import mimetypes
import os
import re
import time
import urllib.request

import websockets

import human_input  # real keyboard input (wtype) inside the container

CDP_HTTP = "http://127.0.0.1:9222"
LISTEN_PORT = int(os.environ.get("CLARAOS_RELAY_PORT", "9226"))
MOBILE_PROFILE = os.environ.get("CLARAOS_MOBILE_PROFILE", "0") == "1"
HOME_URL = os.environ.get("CLARAOS_HOME_URL", "https://start.duckduckgo.com")

# ── Download hand-over: kiosk downloads → Files app ──
# Chromium downloads into DOWNLOAD_DIR (allowAndName = file name == GUID); the relay
# listens for Browser.download* events and pushes finished files via claraos-api
# (WebDAV → Nextcloud) into the user's Files app.
# No default: the deployment sets it (empty = no upload at all, files stay in the browser).
CLARAOS_API_URL = os.environ.get("CLARAOS_API_URL", "")
# Narrow key of THIS browser (routers/browser_ablage.py): may only put files into
# its owner's download folder. Never the API's service token.
UPLOAD_KEY = os.environ.get("CLARAOS_UPLOAD_KEY", "").strip()
DOWNLOAD_USER = os.environ.get("CLARAOS_DOWNLOAD_USER", "")
DOWNLOAD_DIR = os.environ.get("CLARAOS_DOWNLOAD_DIR", "/config/Downloads/claraos")
TARGET_FOLDER = os.environ.get("CLARAOS_DOWNLOAD_TARGET", "/Downloads/Clara Browser")
MAX_UPLOAD = 10 * 1024 * 1024  # must match the API's MAX_FILE_SIZE

MOBILE_UA = (
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36"
)
MOBILE_UA_METADATA = {
    "brands": [
        {"brand": "Chromium", "version": "148"},
        {"brand": "Google Chrome", "version": "148"},
    ],
    "fullVersion": "148.0.0.0",
    "platform": "Android",
    "platformVersion": "14",
    "architecture": "",
    "model": "Pixel 8",
    "mobile": True,
}

# CDP methods that clients may send 1:1 (to the active tab).
ALLOWED_METHODS = {
    "Input.dispatchTouchEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
    "Input.imeSetComposition",
    "Input.dispatchMouseEvent",
    "Input.synthesizeScrollGesture",
    "Input.synthesizePinchGesture",
    "Input.synthesizeTapGesture",
    "Emulation.setDeviceMetricsOverride",
    "Emulation.setTouchEmulationEnabled",
    "Page.getLayoutMetrics",
    "Page.navigate",
    "Page.reload",
    "Page.getNavigationHistory",
    "Page.navigateToHistoryEntry",
}

TARGET_ID_RE = re.compile(r"^[A-F0-9]{8,64}$")

log = logging.getLogger("claraos-cdp-relay")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")


def http_json(path, method="GET"):
    req = urllib.request.Request(CDP_HTTP + path, method=method)
    with urllib.request.urlopen(req, timeout=8) as r:
        body = r.read()
    try:
        return json.loads(body) if body else None
    except json.JSONDecodeError:
        return body.decode(errors="replace")


def safe_url(url, fallback=None):
    url = str(url or "")
    if url.startswith("https://") or url.startswith("http://"):
        return url
    return fallback


# ── Fixed probe expressions (placeholders are filled with VALIDATED values) ──
JS_FOCUS_PROBE = (
    "(function(){var e=document.activeElement;if(!e)return false;"
    "var t=(e.tagName||'').toUpperCase();"
    "if(t==='TEXTAREA')return true;"
    "if(e.isContentEditable)return true;"
    "if(t!=='INPUT')return false;"
    "var ty=(e.type||'text').toLowerCase();"
    "return ['text','search','url','email','password','tel','number','date',"
    "'time','datetime-local','month','week'].indexOf(ty)!==-1;})()"
)

JS_ELEMENT_AT = """
(function(x,y){
  var e=document.elementFromPoint(x,y);
  if(!e) return {kind:'none'};
  function editable(t){var tg=(t.tagName||'').toUpperCase();
    return t.isContentEditable||tg==='TEXTAREA'||tg==='INPUT';}
  var out={kind:'text'};
  var a=e.closest?e.closest('a[href]'):null;
  if(editable(e)) out={kind:'input'};
  else if(a) out={kind:'link',href:a.href,
    label:(a.textContent||'').replace(/\\s+/g,' ').trim().slice(0,120)};
  else if((e.tagName||'').toUpperCase()==='IMG')
    out={kind:'image',src:e.currentSrc||e.src||''};
  else {
    var r=document.caretRangeFromPoint?document.caretRangeFromPoint(x,y):null;
    if(!(r&&r.startContainer&&r.startContainer.nodeType===3)) out={kind:'none'};
  }
  if((e.tagName||'').toUpperCase()==='IMG'&&out.kind==='link')
    out.src=e.currentSrc||e.src||'';
  var ae=document.activeElement;
  if(ae&&typeof ae.selectionStart==='number'&&ae.selectionStart!==ae.selectionEnd)
    out.selection=String(ae.value).substring(ae.selectionStart,ae.selectionEnd).slice(0,2000);
  else out.selection=String(getSelection()||'').slice(0,2000);
  return out;
})(%X%,%Y%)
"""

# Shared return block: selection + caret rects (CSS px in the stream) for the
# client's drag handles. First/last client rect = visual ends; bound = overall
# box for positioning the toolbar.
JS_SEL_INFO_SNIPPET = """
  function selInfo(){
    var sel=getSelection();
    if(!sel||sel.rangeCount===0||sel.isCollapsed) return {ok:false};
    var r=sel.getRangeAt(0);
    var rects=Array.prototype.slice.call(r.getClientRects());
    if(!rects.length){rects=[r.getBoundingClientRect()];}
    var f=rects[0], l=rects[rects.length-1];
    var b=r.getBoundingClientRect();
    return {ok:true,text:String(sel).slice(0,20000),
      start:{x:f.left,y:f.top,h:f.height},
      end:{x:l.right,y:l.top,h:l.height},
      bound:{x:b.left,y:b.top,w:b.width,h:b.height}};
  }
"""

JS_SELECT_WORD = """
(function(x,y){
""" + JS_SEL_INFO_SNIPPET + """
  var r=document.caretRangeFromPoint?document.caretRangeFromPoint(x,y):null;
  if(!r) return {ok:false};
  var sel=getSelection();
  sel.removeAllRanges(); sel.addRange(r);
  if(sel.modify){sel.modify('move','backward','word');sel.modify('extend','forward','word');}
  var t=String(sel);
  if(!t.trim()){sel.removeAllRanges();return {ok:false};}
  return selInfo();
})(%X%,%Y%)
"""

JS_SELECTION_INFO = """
(function(){
""" + JS_SEL_INFO_SNIPPET + """
  return selInfo();
})()
"""

# Dragging a handle: fixed anchor = the OPPOSITE end of the current selection,
# focus = caret at the finger position. getRangeAt(0) is always in document
# order, so the anchor choice also works after the user reverses direction.
JS_EXTEND_SELECTION = """
(function(x,y,edge){
""" + JS_SEL_INFO_SNIPPET + """
  var sel=getSelection();
  if(!sel||sel.rangeCount===0) return {ok:false};
  var pos=document.caretRangeFromPoint?document.caretRangeFromPoint(x,y):null;
  if(!pos) return selInfo();
  var r=sel.getRangeAt(0);
  var anchorNode, anchorOffset;
  if(edge==='start'){anchorNode=r.endContainer;anchorOffset=r.endOffset;}
  else {anchorNode=r.startContainer;anchorOffset=r.startOffset;}
  try{sel.setBaseAndExtent(anchorNode,anchorOffset,pos.startContainer,pos.startOffset);}
  catch(e){return selInfo();}
  if(sel.isCollapsed){
    try{sel.setBaseAndExtent(anchorNode,anchorOffset,pos.startContainer,Math.min(pos.startOffset+1,(pos.startContainer.length||pos.startOffset+1)));}
    catch(e2){}
  }
  return selInfo();
})(%X%,%Y%,'%EDGE%')
"""

JS_CLEAR_SELECTION = "(getSelection().removeAllRanges(), true)"

# Find in page: window.find highlights the match (visible in the stream) and
# scrolls to it. %Q% is inserted as a JSON string (no room for injection).
JS_FIND = """
(function(q,back){
  if(!q) return {found:false};
  var found=window.find(q,false,back,true,false,true,false);
  return {found:!!found};
})(%Q%,%BACK%)
"""

JS_GET_SELECTION = (
    "(function(){var ae=document.activeElement;"
    "if(ae&&typeof ae.selectionStart==='number'&&ae.selectionStart!==ae.selectionEnd)"
    "return String(ae.value).substring(ae.selectionStart,ae.selectionEnd).slice(0,20000);"
    "return String(getSelection()||'').slice(0,20000);})()"
)

JS_SELECT_ALL = "(document.execCommand('selectAll'), true)"
JS_DELETE_SELECTION = "(document.execCommand('delete'), true)"


class Browser:
    """One persistent browser-level CDP connection with flat sessions."""

    def __init__(self):
        self.ws = None
        self.next_id = 0
        self.pending = {}          # id -> Future
        self.sessions = {}         # target_id -> session_id
        self.desktop_mode = {}     # target_id -> bool
        self.current_target = None
        self.lock = asyncio.Lock()

    async def connect(self):
        ver = http_json("/json/version")
        self.ws = await websockets.connect(
            ver["webSocketDebuggerUrl"], max_size=64 * 2**20,
            ping_interval=20, ping_timeout=20)
        asyncio.get_event_loop().create_task(self._recv_loop())
        await self.cmd("Target.setDiscoverTargets", {"discover": True})
        try:
            os.makedirs(DOWNLOAD_DIR, exist_ok=True)
            # The relay runs as root, Chromium as abc (PUID 1000); without the
            # chown Chromium cancels every download ("canceled", 0 bytes).
            for d in (os.path.dirname(DOWNLOAD_DIR), DOWNLOAD_DIR):
                try:
                    os.chown(d, 1000, 1000)
                except OSError:
                    pass
            r = await self.cmd("Browser.setDownloadBehavior", {
                "behavior": "allowAndName", "downloadPath": DOWNLOAD_DIR,
                "eventsEnabled": True})
            log.info("download-bridge aktiv (dir=%s, ziel=%s, api=%s): %s",
                     DOWNLOAD_DIR, TARGET_FOLDER, CLARAOS_API_URL,
                     "ok" if "result" in r else r.get("error"))
        except Exception as exc:  # noqa: BLE001
            log.warning("download-bridge setup: %s", exc)
        log.info("browser-verbindung steht")

    async def _recv_loop(self):
        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                mid = msg.get("id")
                if mid is not None and mid in self.pending:
                    fut = self.pending.pop(mid)
                    if not fut.done():
                        fut.set_result(msg)
                    continue
                method = msg.get("method")
                if method == "Target.detachedFromTarget":
                    sid = msg.get("params", {}).get("sessionId")
                    for tid, s in list(self.sessions.items()):
                        if s == sid:
                            self.sessions.pop(tid, None)
                elif method == "Target.targetDestroyed":
                    tid = msg.get("params", {}).get("targetId")
                    self.sessions.pop(tid, None)
                    self.desktop_mode.pop(tid, None)
                elif method == "Browser.downloadWillBegin":
                    p = msg.get("params", {})
                    download_begin(p.get("guid", ""),
                                   p.get("suggestedFilename") or "download",
                                   p.get("url", ""))
                elif method == "Browser.downloadProgress":
                    p = msg.get("params", {})
                    download_progress(p.get("guid", ""), p.get("state", ""),
                                      p.get("receivedBytes") or 0)
        except Exception as exc:  # noqa: BLE001
            log.warning("browser recv-loop endet: %s", exc)

    async def send_cmd(self, method, params=None, session_id=None):
        """SEND a command (order is preserved) and return a future for the reply.
        Important for input bursts: sending does not block on the reply."""
        self.next_id += 1
        mid = self.next_id
        msg = {"id": mid, "method": method, "params": params or {}}
        if session_id:
            msg["sessionId"] = session_id
        fut = asyncio.get_event_loop().create_future()
        self.pending[mid] = fut
        await self.ws.send(json.dumps(msg))
        return mid, fut

    async def cmd(self, method, params=None, session_id=None, timeout=15):
        mid, fut = await self.send_cmd(method, params, session_id)
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self.pending.pop(mid, None)
            return {"error": {"code": -32000, "message": f"timeout: {method}"}}

    async def session_for(self, target_id, reload_after_profile=True):
        async with self.lock:
            sid = self.sessions.get(target_id)
            if sid:
                return sid
            r = await self.cmd("Target.attachToTarget",
                               {"targetId": target_id, "flatten": True})
            sid = r.get("result", {}).get("sessionId")
            if not sid:
                return None
            self.sessions[target_id] = sid
            await self._apply_profile(target_id, sid)
            # First attach: the target's FIRST request still went out with the
            # desktop UA (the profile is only applied after attaching), so sites
            # such as Wikipedia serve their desktop variant. A single reload fetches
            # the page with the mobile profile (applies to the kiosk start tab and
            # window.open popups; tabs.create avoids it via about:blank).
            if reload_after_profile and MOBILE_PROFILE:
                try:
                    info = [t for t in await self.pages() if t["id"] == target_id]
                    url = info[0].get("url", "") if info else ""
                    if url and not url.startswith("about:"):
                        await self.cmd("Page.reload", {}, session_id=sid)
                except Exception:  # noqa: BLE001
                    pass
            return sid

    async def _apply_profile(self, target_id, sid):
        """Apply the mobile profile (or desktop mode) to a session.
        The session stays open, so the overrides persist (they die with the session)."""
        if not MOBILE_PROFILE:
            return
        if self.desktop_mode.get(target_id):
            await self.cmd("Emulation.setUserAgentOverride",
                           {"userAgent": ""}, session_id=sid)
            await self.cmd("Emulation.clearDeviceMetricsOverride", {},
                           session_id=sid)
        else:
            await self.cmd("Emulation.setUserAgentOverride",
                           {"userAgent": MOBILE_UA,
                            "userAgentMetadata": MOBILE_UA_METADATA},
                           session_id=sid)
            # Mobile VIEWPORT emulation belongs to EVERY tab: if only the client
            # sets the metrics, they apply to the tab active at connect time and
            # new tabs get a desktop layout. 0/0/0 = the window size stays
            # authoritative, only the behaviour (viewport meta etc.) is mobile.
            await self.cmd("Emulation.setDeviceMetricsOverride",
                           {"width": 0, "height": 0, "deviceScaleFactor": 0,
                            "mobile": True}, session_id=sid)
        await self.cmd("Emulation.setTouchEmulationEnabled",
                       {"enabled": True, "maxTouchPoints": 5}, session_id=sid)

    async def pages(self):
        """Visible order: /json/list lists the active tab first."""
        try:
            return [t for t in http_json("/json/list") if t.get("type") == "page"]
        except Exception:  # noqa: BLE001
            return []

    async def active_session(self):
        if self.current_target:
            sid = self.sessions.get(self.current_target)
            if sid:
                return self.current_target, sid
        pages = await self.pages()
        if not pages:
            return None, None
        tid = pages[0]["id"]
        self.current_target = tid
        return tid, await self.session_for(tid)

    async def evaluate(self, expression, session_id, timeout=8):
        r = await self.cmd("Runtime.evaluate",
                           {"expression": expression, "returnByValue": True},
                           session_id=session_id, timeout=timeout)
        return r.get("result", {}).get("result", {}).get("value")


browser = Browser()

# ── Download tracking ──────────────────────────────────────────────────────
# seq = monotonic number so the client can spot new entries (toast) without
# comparing timestamps.
downloads = {}          # guid -> record
downloads_order = []    # guids, oldest first (max 30)
download_seq = [0]
clients = []            # connected dashboard clients: {user, last_input}


def download_owner():
    """Who owns a download that is just starting?

    A shared browser instance can be watched by several signed-in users at once.
    The relay sees EVERY input command, so the client with the most recent input
    wins: whoever clicked/typed triggered the download. With exactly one connected
    client the answer is unambiguous anyway.
    The identity comes from `X-Authentik-Username` (set by the reverse proxy's
    forward_auth; the port is firewalled to the proxy). No header (e.g. a direct
    call without auth) ⇒ the configured default.
    With one instance per user the owner is fixed: the default applies and this
    heuristic is idle.
    """
    best, best_ts = None, -1.0
    for client in list(clients):
        if client.get("user") and client.get("last_input", 0) > best_ts:
            best, best_ts = client["user"], client["last_input"]
    if best:
        return best
    for client in list(clients):      # nobody has typed yet: the only client counts
        if client.get("user"):
            return client["user"]
    return DOWNLOAD_USER


def download_begin(guid, filename, url):
    if not guid:
        return
    download_seq[0] += 1
    downloads[guid] = {
        "seq": download_seq[0], "name": filename, "url": url[:300],
        "state": "läuft", "bytes": 0, "ts": time.time(),
        "owner": download_owner(),
    }
    downloads_order.append(guid)
    while len(downloads_order) > 30:
        downloads.pop(downloads_order.pop(0), None)
    log.info("download begonnen: %s", filename)


def download_progress(guid, state, received):
    rec = downloads.get(guid)
    if not rec:
        return
    rec["bytes"] = received
    if state == "completed":
        download_seq[0] += 1
        rec["seq"] = download_seq[0]
        rec["state"] = "lädt hoch"
        asyncio.get_event_loop().create_task(upload_download(guid))
    elif state == "canceled":
        download_seq[0] += 1
        rec["seq"] = download_seq[0]
        rec["state"] = "abgebrochen"


def _set_state(guid, state):
    rec = downloads.get(guid)
    if rec:
        download_seq[0] += 1
        rec["seq"] = download_seq[0]
        rec["state"] = state


async def upload_download(guid):
    """Push a finished download into the Files app (claraos-api → Nextcloud)."""
    import httpx
    rec = downloads.get(guid)
    path = os.path.join(DOWNLOAD_DIR, guid)
    if not rec or not os.path.isfile(path):
        _set_state(guid, "Fehler: Datei fehlt")
        return
    if not CLARAOS_API_URL:
        # Deployment without a hand-over to Files (e.g. a cell): the file stays here.
        _set_state(guid, "Im Browser gespeichert (keine Übergabe an Dateien)")
        return
    if not UPLOAD_KEY:
        _set_state(guid, "Im Browser gespeichert (kein Ablage-Schlüssel)")
        return
    size = os.path.getsize(path)
    if size > MAX_UPLOAD:
        _set_state(guid, "zu groß für Files (>10 MB)")
        return
    mime = mimetypes.guess_type(rec["name"])[0] or "application/octet-stream"
    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            with open(path, "rb") as fh:
                # The key decides WHOSE Files — the API creates the folder itself.
                resp = await client.post(
                    CLARAOS_API_URL + "/api/claraos/browser-ablage/upload",
                    headers={"X-Browser-Upload-Key": UPLOAD_KEY},
                    files={"file": (rec["name"], fh, mime)})
        if resp.status_code == 200:
            _set_state(guid, "in Files")
            os.unlink(path)
            log.info("download hochgeladen: %s (%d Bytes)", rec["name"], size)
        else:
            _set_state(guid, f"Fehler: API {resp.status_code}")
            log.warning("download-upload %s: HTTP %s %s",
                        rec["name"], resp.status_code, resp.text[:150])
    except Exception as exc:  # noqa: BLE001
        _set_state(guid, "Fehler: Upload")
        log.warning("download-upload %s: %s", rec["name"], exc)


async def verb_downloads_recent(_params):
    out = []
    for guid in reversed(downloads_order):
        rec = downloads.get(guid)
        if rec:
            out.append({"seq": rec["seq"], "name": rec["name"],
                        "state": rec["state"], "bytes": rec["bytes"],
                        "owner": rec.get("owner") or DOWNLOAD_USER})
    return {"downloads": out[:20], "target": TARGET_FOLDER}


async def track_active_target():
    """Track the active tab (polling; /json/list lists the visible tab first)
    and keep sessions + profile ready for all page targets."""
    while True:
        try:
            pages = await browser.pages()
            if pages:
                browser.current_target = pages[0]["id"]
                for p in pages:
                    await browser.session_for(p["id"])
        except Exception as exc:  # noqa: BLE001
            log.warning("target-tracker: %s", exc)
        await asyncio.sleep(1.5)


def num(v, lo, hi):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if lo <= f <= hi else None


# ── ClaraOS verbs ──────────────────────────────────────────────────────────

async def verb_tabs_list(_params):
    pages = await browser.pages()
    active = pages[0]["id"] if pages else None
    return [{"id": p["id"], "url": p.get("url", ""),
             "title": p.get("title", ""), "active": p["id"] == active}
            for p in pages]


async def verb_tabs_create(params):
    url = safe_url((params or {}).get("url"), HOME_URL)
    # about:blank first: the profile (mobile UA/viewport) MUST be in place before
    # the first real request, otherwise the server delivers the desktop variant.
    r = await browser.cmd("Target.createTarget", {"url": "about:blank"})
    tid = r.get("result", {}).get("targetId")
    if tid:
        browser.current_target = tid
        sid = await browser.session_for(tid, reload_after_profile=False)
        if sid:
            await browser.cmd("Page.navigate", {"url": url}, session_id=sid)
    return {"id": tid}


async def verb_tabs_activate(params):
    tid = str((params or {}).get("id", ""))
    if not TARGET_ID_RE.match(tid):
        return {"ok": False}
    await browser.cmd("Target.activateTarget", {"targetId": tid})
    browser.current_target = tid
    await browser.session_for(tid)
    return {"ok": True}


async def verb_tabs_close(params):
    tid = str((params or {}).get("id", ""))
    if not TARGET_ID_RE.match(tid):
        return {"ok": False}
    pages = await browser.pages()
    if len(pages) <= 1:
        # last tab: open a replacement first, otherwise the kiosk dies
        await verb_tabs_create({"url": HOME_URL})
    await browser.cmd("Target.closeTarget", {"targetId": tid})
    await asyncio.sleep(0.3)
    pages = await browser.pages()
    if pages:
        browser.current_target = pages[0]["id"]
    return {"ok": True, "tabs": await verb_tabs_list(None)}


async def verb_tabs_thumb(params):
    tid = str((params or {}).get("id", ""))
    if not TARGET_ID_RE.match(tid):
        return {"data": None}
    sid = await browser.session_for(tid)
    if not sid:
        return {"data": None}
    r = await browser.cmd("Page.captureScreenshot",
                          {"format": "jpeg", "quality": 40},
                          session_id=sid, timeout=6)
    return {"data": r.get("result", {}).get("data")}


async def verb_probe_element(params):
    x = num((params or {}).get("x"), 0, 20000)
    y = num((params or {}).get("y"), 0, 20000)
    if x is None or y is None:
        return {"kind": "none"}
    _tid, sid = await browser.active_session()
    if not sid:
        return {"kind": "none"}
    expr = JS_ELEMENT_AT.replace("%X%", str(x)).replace("%Y%", str(y))
    return await browser.evaluate(expr, sid) or {"kind": "none"}


async def verb_select_word(params):
    x = num((params or {}).get("x"), 0, 20000)
    y = num((params or {}).get("y"), 0, 20000)
    if x is None or y is None:
        return {"ok": False}
    _tid, sid = await browser.active_session()
    if not sid:
        return {"ok": False}
    expr = JS_SELECT_WORD.replace("%X%", str(x)).replace("%Y%", str(y))
    return await browser.evaluate(expr, sid) or {"ok": False}


async def verb_selection_info(_params):
    _tid, sid = await browser.active_session()
    if not sid:
        return {"ok": False}
    return await browser.evaluate(JS_SELECTION_INFO, sid) or {"ok": False}


async def verb_extend_selection(params):
    x = num((params or {}).get("x"), -2000, 20000)
    y = num((params or {}).get("y"), -2000, 20000)
    edge = "start" if (params or {}).get("edge") == "start" else "end"
    if x is None or y is None:
        return {"ok": False}
    _tid, sid = await browser.active_session()
    if not sid:
        return {"ok": False}
    expr = (JS_EXTEND_SELECTION.replace("%X%", str(x))
            .replace("%Y%", str(y)).replace("%EDGE%", edge))
    return await browser.evaluate(expr, sid) or {"ok": False}


async def verb_clear_selection(_params):
    _tid, sid = await browser.active_session()
    if sid:
        await browser.evaluate(JS_CLEAR_SELECTION, sid)
    return {"ok": True}


async def verb_find(params):
    query = str((params or {}).get("query", ""))[:200]
    if not query.strip():
        return {"found": False}
    back = bool((params or {}).get("backwards"))
    _tid, sid = await browser.active_session()
    if not sid:
        return {"found": False}
    expr = (JS_FIND.replace("%Q%", json.dumps(query))
            .replace("%BACK%", "true" if back else "false"))
    return await browser.evaluate(expr, sid) or {"found": False}


async def verb_get_selection(_params):
    _tid, sid = await browser.active_session()
    return {"text": (await browser.evaluate(JS_GET_SELECTION, sid)) or ""}


async def verb_select_all(_params):
    _tid, sid = await browser.active_session()
    await browser.evaluate(JS_SELECT_ALL, sid)
    return {"text": (await browser.evaluate(JS_GET_SELECTION, sid)) or ""}


async def verb_delete_selection(_params):
    _tid, sid = await browser.active_session()
    await browser.evaluate(JS_DELETE_SELECTION, sid)
    return {"ok": True}


async def verb_probe_focus(_params):
    _tid, sid = await browser.active_session()
    val = await browser.evaluate(JS_FOCUS_PROBE, sid)
    return {"focused": bool(val)}


async def verb_clear_data(_params):
    _tid, sid = await browser.active_session()
    await browser.cmd("Network.clearBrowserCookies", {}, session_id=sid)
    await browser.cmd("Network.clearBrowserCache", {}, session_id=sid)
    return {"ok": True}


async def verb_desktop_mode(params):
    on = bool((params or {}).get("enabled"))
    tid, sid = await browser.active_session()
    if not sid:
        return {"ok": False}
    browser.desktop_mode[tid] = on
    await browser._apply_profile(tid, sid)
    await browser.cmd("Page.reload", {}, session_id=sid)
    return {"ok": True, "enabled": on}


# ── Human-like input ──────────────────────────────────────────────
# Why here and not in the API container: `xdotool`/`wtype` must run INSIDE the
# browser container. The relay is the only service that already lives there, is
# already routed per user and already has a verb allowlist.
# Operation is COORDINATE-FREE (Tab instead of click): the pointer cannot be driven
# this way — `xdotool` does not reach the Wayland window (neither click nor key),
# only `wtype` gets through. Keyboard navigation is more robust than coordinates
# anyway, which go stale after every scroll.

JS_FOCUS_INFO = (
    "(function(){var e=document.activeElement;if(!e)return null;"
    "var l='';try{if(e.labels&&e.labels.length)l=e.labels[0].innerText;}catch(x){}"
    "return JSON.stringify({tag:(e.tagName||'').toLowerCase(),id:e.id||'',"
    "name:e.name||'',type:(e.type||'').toLowerCase(),label:(l||'').trim().slice(0,60),"
    "len:(e.value||'').length});})()"
)


async def _focus_info():
    _tid, sid = await browser.active_session()
    val = await browser.evaluate(JS_FOCUS_INFO, sid)
    try:
        return json.loads(val) if val else None
    except (TypeError, ValueError):
        return None


async def verb_human_available(_params):
    return await human_input.available()


async def verb_human_focus_info(_params):
    return {"focus": await _focus_info()}


async def verb_human_key(params):
    return {"key": await human_input.key(params.get("key", ""))}


async def verb_human_type(params):
    """`text` is never logged: passwords pass through here as well."""
    n = await human_input.type_text(params.get("text", ""),
                                    delay_ms=int(params.get("delayMs", 90)))
    return {"chars": n}


async def verb_human_tab_to(params):
    """Move with Tab from field to field until id/name/label matches.

    Replaces clicking: independent of scroll position and layout, and every key
    press is a real event.
    """
    want = {k: str(params.get(k, "")).lower() for k in ("id", "name", "label")}
    want = {k: v for k, v in want.items() if v}
    if not want:
        raise ValueError("id, name oder label angeben")
    limit = max(1, min(int(params.get("max", 25)), 60))
    back = bool(params.get("backwards"))
    seen = []
    for i in range(limit):
        info = await _focus_info()
        if info:
            seen.append(info.get("id") or info.get("name") or info.get("label") or info.get("tag"))
            if all(v in str(info.get(k, "")).lower() for k, v in want.items()):
                return {"found": True, "steps": i, "focus": info}
        await human_input.key("shift+Tab" if back else "Tab")
        await asyncio.sleep(0.12)
    return {"found": False, "steps": limit, "seen": seen[-12:]}


async def verb_human_fill_focused(params):
    """Clear the focused field and type. `text` is never logged."""
    if params.get("clear", True):
        await human_input.clear_field()
        await asyncio.sleep(0.12)
    n = await human_input.type_text(params.get("text", ""),
                                    delay_ms=int(params.get("delayMs", 90)))
    return {"chars": n, "focus": await _focus_info()}


VERBS = {
    "ClaraOS.human.available": verb_human_available,
    "ClaraOS.human.focusInfo": verb_human_focus_info,
    "ClaraOS.human.key": verb_human_key,
    "ClaraOS.human.type": verb_human_type,
    "ClaraOS.human.tabTo": verb_human_tab_to,
    "ClaraOS.human.fillFocused": verb_human_fill_focused,
    "ClaraOS.probeFocus": verb_probe_focus,
    "ClaraOS.probeElementAt": verb_probe_element,
    "ClaraOS.selectWordAt": verb_select_word,
    "ClaraOS.selectionInfo": verb_selection_info,
    "ClaraOS.extendSelection": verb_extend_selection,
    "ClaraOS.clearSelection": verb_clear_selection,
    "ClaraOS.findInPage": verb_find,
    "ClaraOS.getSelection": verb_get_selection,
    "ClaraOS.selectAll": verb_select_all,
    "ClaraOS.deleteSelection": verb_delete_selection,
    "ClaraOS.clearData": verb_clear_data,
    "ClaraOS.setDesktopMode": verb_desktop_mode,
    "ClaraOS.tabs.list": verb_tabs_list,
    "ClaraOS.tabs.create": verb_tabs_create,
    "ClaraOS.tabs.activate": verb_tabs_activate,
    "ClaraOS.tabs.close": verb_tabs_close,
    "ClaraOS.tabs.thumb": verb_tabs_thumb,
    "ClaraOS.downloads.recent": verb_downloads_recent,
}


async def handle_client(client):
    request = getattr(client, "request", None)
    path = request.path if request else "/"
    if not path.startswith("/claraos-cdp"):
        await client.close(code=4404, reason="unknown path")
        return
    # Identity from the header set by the reverse proxy (forward_auth). The vhost
    # drops incoming X-Authentik-* headers before Authentik sets the real ones,
    # otherwise a client could claim someone else's identity.
    user = ""
    if request is not None:
        try:
            user = (request.headers.get("X-Authentik-Username") or "").strip()[:64]
        except Exception:  # noqa: BLE001
            user = ""
    me = {"user": user, "last_input": 0.0}
    clients.append(me)
    log.info("client verbunden (user=%s)", user or "—")
    touch_active = False
    try:
        async for raw in client:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            method = msg.get("method")
            cid = msg.get("id")

            if method in VERBS:
                try:
                    result = await VERBS[method](msg.get("params"))
                except Exception as exc:  # noqa: BLE001
                    log.warning("verb %s: %s", method, exc)
                    result = {"error": str(exc)[:200]}
                await client.send(json.dumps({"id": cid, "result": result}))
                continue

            if method not in ALLOWED_METHODS:
                await client.send(json.dumps({
                    "id": cid,
                    "error": {"code": -32601,
                              "message": f"method not allowed: {method}"},
                }))
                continue

            if method == "Page.navigate":
                url = safe_url((msg.get("params") or {}).get("url"))
                if url is None:
                    await client.send(json.dumps({
                        "id": cid,
                        "error": {"code": -32602, "message": "nur http(s)-URLs"},
                    }))
                    continue
                msg["params"] = {"url": url}

            if method.startswith("Input."):
                # "Who acted last": the basis for attributing downloads.
                me["last_input"] = time.time()
            if method == "Input.dispatchTouchEvent":
                t = (msg.get("params") or {}).get("type")
                touch_active = t in ("touchStart", "touchMove")

            _tid, sid = await browser.active_session()
            if not sid:
                await client.send(json.dumps({
                    "id": cid,
                    "error": {"code": -32000, "message": "kein aktiver Tab"},
                }))
                continue
            # Send in arrival order (touch sequences!) and hand the reply back
            # asynchronously, otherwise input bursts pile up.
            _mid, fut = await browser.send_cmd(method, msg.get("params"),
                                               session_id=sid)

            async def reply(fut=fut, cid=cid):
                try:
                    r = await asyncio.wait_for(fut, timeout=15)
                except asyncio.TimeoutError:
                    r = {"error": {"code": -32000, "message": "timeout"}}
                out = {"id": cid}
                if "result" in r:
                    out["result"] = r["result"]
                if "error" in r:
                    out["error"] = r["error"]
                try:
                    await client.send(json.dumps(out))
                except Exception:  # noqa: BLE001
                    pass
            asyncio.get_event_loop().create_task(reply())
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        try:
            clients.remove(me)
        except ValueError:
            pass
        # Hygiene: cancel dangling touch sequences (Chromium is strict about them).
        if touch_active:
            try:
                _tid, sid = await browser.active_session()
                if sid:
                    await browser.cmd("Input.dispatchTouchEvent",
                                      {"type": "touchCancel", "touchPoints": []},
                                      session_id=sid)
            except Exception:  # noqa: BLE001
                pass
        log.info("client getrennt")


async def main():
    # Wait for Chromium, then start the browser connection + tracker.
    for _ in range(60):
        try:
            http_json("/json/version")
            break
        except Exception:  # noqa: BLE001
            await asyncio.sleep(2)
    await browser.connect()
    asyncio.get_event_loop().create_task(track_active_target())
    async with websockets.serve(handle_client, "0.0.0.0", LISTEN_PORT,
                                max_size=64 * 2**20):
        log.info("relay lauscht auf :%s (mobile_profile=%s)",
                 LISTEN_PORT, MOBILE_PROFILE)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())

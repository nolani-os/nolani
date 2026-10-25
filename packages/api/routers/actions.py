"""ClaraOS Action-Bus.

Lets backend code (in particular MCP tools called by the Clara agent) push
imperative commands to the user's running ClaraOS frontend over a WebSocket.
The frontend listens once at the Shell level and dispatches each action to
the appropriate per-app handler (e.g. wrapp-store mutations for a wrapp app).

Flow:

    Clara LLM → an app's MCP tool call
                       │ (HTTP)
                       ▼
            POST /api/claraos/actions/dispatch
            { target_user, app_id, action, args, instance_id?, window_id? }
                       │
                       ▼
            BUS broadcasts to all live WS connections for `target_user`
                       │
                       ▼
            Frontend useActionBus(...) receives → dispatches to app handler

Auth:
* WebSocket: trusted X-Authentik-Username forward-auth header (Caddy outpost).
  In dev mode (no Authentik) we accept anonymous → "dev" channel.
* /dispatch: no auth on the endpoint itself — it's only reachable from inside
  the docker network (claraos-api isn't exposed externally), and the MCP
  forwards `target_user` from the chat-context. This is intentionally tight
  to keep the V1 implementation simple. Tighten later if we expose the API
  to anything other than internal MCP servers.

Ephemeral, in-memory only — actions are best-effort fire-and-forget. If the
user reconnects, missed actions are lost. That's fine for the use cases
(select_node, set_active_tab, etc. — all idempotent UI hints).
"""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME
import asyncio
import json
import logging
import re
import time
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect, status
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/actions", tags=["actions"])

# MCP-Token: shared secret that intra-docker MCP servers send via header to
# /dispatch. Empty by default → dispatch is then implicitly trusted to any
# intra-docker caller (V1 behaviour). Setting CLARAOS_MCP_TOKEN locks dispatch
# down so only callers with the matching `X-Claraos-MCP-Token` header succeed
# OR the request originates from an authenticated user dispatching to themself.
import os as _os
_MCP_TOKEN = _os.environ.get("CLARAOS_MCP_TOKEN", "")

from urllib.parse import urlsplit

from app_seeds import BUILTIN_APPS
from auth import ENFORCE, PROXY_SECRET, SERVICE_TOKEN, _matches, require_caller
from app_url_patterns import URL_PATTERNS, PatternError, known_patterns, resolve_path


def _app_origin(app_id: str) -> str | None:
    """scheme://host[:port] for an app, derived from its registry config.url.

    The full config.url may point at an SSO-login path (e.g. mautic's
    /s/saml/login) — for deep-links we only want the origin and append the
    resolved pattern path ourselves.
    """
    for app in BUILTIN_APPS:
        if app.get("id") == app_id:
            url = (app.get("config") or {}).get("url")
            if not url:
                return None
            parts = urlsplit(url)
            if not parts.scheme or not parts.netloc:
                return None
            return f"{parts.scheme}://{parts.netloc}"
    return None


def _app_is_internal(app_id: str) -> bool:
    """Internal (native) apps have no iframe origin — deep links are broadcast
    as a relative path and parsed by the app's own navigator."""
    for app in BUILTIN_APPS:
        if app.get("id") == app_id:
            return app.get("type") == "internal"
    return False


# ── In-memory pubsub ────────────────────────────────────────────────────────

# username (lowercased) → set of live WebSocket objects
_subscribers: dict[str, set[WebSocket]] = defaultdict(set)
_lock = asyncio.Lock()

# ── Acknowledgements ───────────────────────────────────────────────────────
# action_id → (collected acks, event that fires on the first one).
#
# Why this exists: `delivered: N` only means "sent to N browsers". The agent
# used to read that as "the user sees it" and report success while an empty
# window was on screen. The browser now acknowledges WHAT actually happened,
# and /dispatch returns that to the caller.
_ACK_FRIST = 4.0  # max seconds /dispatch waits for an acknowledgement
_ACK_NACHFRIST = 1.5  # extra seconds for the remaining browsers after the first ack
_acks: dict[str, list[dict[str, Any]]] = {}
_ack_events: dict[str, asyncio.Event] = {}
_ack_zaehler = 0


def _ack_merken(action_id: str, ack: dict[str, Any]) -> None:
    """Store an acknowledgement and wake up the waiter (if any)."""
    liste = _acks.get(action_id)
    if liste is None:
        return  # nobody is waiting for it (any more)
    liste.append(ack)
    ereignis = _ack_events.get(action_id)
    if ereignis is not None:
        ereignis.set()


async def _broadcast(target_user: str, payload: dict[str, Any], _from_bus: bool = False) -> int:
    """Send `payload` JSON to every live WS for `target_user`. Returns how
    many connections received it. Closed sockets are pruned silently.

    Also relays via pg_bus to other API instances — their local WS clients
    receive the event through the bus handler."""
    target_user = (target_user or "").lower()
    if not _from_bus:
        from services import pg_bus
        await pg_bus.publish("actions.push", {"user": target_user, "payload": payload})
    sockets = list(_subscribers.get(target_user, ()))
    nur_form = payload.get("nur_form") if isinstance(payload, dict) else None
    if nur_form:
        # Only shells of that form (a phone page must not pop up the laptop's browser).
        sockets = [ws for ws in sockets if _ws_form.get(id(ws)) in (nur_form, None)]
    if not sockets:
        return 0
    delivered = 0
    dead: list[WebSocket] = []
    msg = json.dumps(payload)
    for ws in sockets:
        try:
            await ws.send_text(msg)
            delivered += 1
        except Exception:  # noqa: BLE001
            dead.append(ws)
    if dead:
        async with _lock:
            for ws in dead:
                _subscribers.get(target_user, set()).discard(ws)
    return delivered


# ── WebSocket: frontend listener ────────────────────────────────────────────

# Which shell form ("mobile" | "desktop") the user used LAST: set on connect and
# whenever a shell reports it came to the front (visible, focus, touch). That is
# where the user's browser must open a page (routers/apps.py selkies_open).
_letzte_form: dict[str, str] = {}
# Form per live connection (id(ws)), for broadcasts to one form only (`nur_form`).
_ws_form: dict[int, str] = {}


def aktuelle_form(username: str) -> str | None:
    """Form of the shell the user connected last, None if unknown."""
    return _letzte_form.get((username or "").lower())


def _ws_username(ws: WebSocket) -> str:
    """The signed-in user of a WebSocket, "" if not authenticated.

    The identity header counts only next to the reverse proxy's secret — the API
    is reachable on internal networks (e.g. the personal browsers'), where anyone
    could set it. The "dev" fallback is for dev mode without any trust anchor.
    """
    if not ENFORCE:
        return (ws.headers.get("x-authentik-username") or "").lower() or "dev"
    if not _matches(ws.headers.get("x-claraos-proxy-secret", ""), PROXY_SECRET):
        return ""
    return (ws.headers.get("x-authentik-username") or "").strip().lower()


@router.websocket("/ws")
async def actions_ws(websocket: WebSocket) -> None:
    """Frontend connects once and stays subscribed for the session.

    Server pushes JSON action messages of the shape::

        {
          "type": "action",
          "app_id": "my-wrapp",
          "action": "select_node",
          "args": {"instance_id": "...", "node_id": "..."},
          "instance_id": "wrapp-3",     // optional, copied to top level
          "window_id": "win-12",        // optional
          "from": "my-wrapp-mcp",       // who dispatched it
          "ts": 1734019200.123
        }

    Frontend is expected to ack with `{"type":"ack","id":...}` if id present,
    but currently we don't require acks (fire-and-forget).
    """
    await websocket.accept()
    user = _ws_username(websocket)
    form = websocket.query_params.get("form")
    if form in ("mobile", "desktop"):
        _letzte_form[user] = form
        _ws_form[id(websocket)] = form
    async with _lock:
        _subscribers[user].add(websocket)
    logger.info("actions ws: %s connected (total: %d)", user, len(_subscribers[user]))
    try:
        # Send a hello so the client can verify auth / reset state
        await websocket.send_text(json.dumps({"type": "hello", "user": user, "ts": time.time()}))
        # Hold open; we mostly don't expect inbound traffic. Drain client
        # messages so the loop doesn't spin.
        while True:
            try:
                msg = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            # Echo pings so the client can keep the connection alive
            try:
                data = json.loads(msg) if msg else {}
            except Exception:
                data = {}
            if data.get("type") == "ping":
                await websocket.send_text(json.dumps({"type": "pong", "ts": time.time()}))
            elif data.get("type") == "aktiv" and form in ("mobile", "desktop"):
                _letzte_form[user] = form  # this device came to the front
            elif data.get("type") == "ack" and data.get("action_id"):
                ack = {
                    "ok": bool(data.get("ok")),
                    # 4000 rather than 500: the screen report (shell.read_screen) carries
                    # the window text back here, which is how the agent sees the error.
                    "detail": str(data.get("detail") or "")[:4000],
                    "user": user,
                }
                _ack_merken(str(data["action_id"]), ack)
                # Other API instances may be waiting for the same action.
                from services import pg_bus as _bus
                await _bus.publish("actions.ack",
                                   {"action_id": str(data["action_id"]), "ack": ack})
    except WebSocketDisconnect:
        pass
    finally:
        async with _lock:
            _subscribers.get(user, set()).discard(websocket)
        _ws_form.pop(id(websocket), None)
        logger.info("actions ws: %s disconnected (remaining: %d)", user, len(_subscribers.get(user, ())))


# ── REST: dispatch endpoint (called by MCPs) ────────────────────────────────

def _dispatch_authorised(request: Request, target_user: str) -> bool:
    """Authorise a /dispatch call. Allow if EITHER:

    1. Caller carries the MCP-shared-secret (intra-network MCPs do this), OR
    2. Caller is an authenticated ClaraOS user dispatching to themself
       (so a Clara session can self-dispatch but can't impersonate others).

    Security: there is deliberately no fallback of "no CLARAOS_MCP_TOKEN set ⇒
    allow everything". With such a fallback `/dispatch` would accept ANY request
    from the local network and could push arbitrary UI actions (open windows,
    navigate, show artifacts) into EVERY user's session. The real callers
    (claraos_action MCP, app MCP servers) send the service token; the shell itself
    comes through the reverse proxy.
    """
    if _matches(request.headers.get("x-claraos-service-token", ""), SERVICE_TOKEN):
        return True
    if _matches(request.headers.get("x-claraos-mcp-token") or "", _MCP_TOKEN):
        return True
    # A user authenticated via the reverse proxy may send to THEMSELF — never to others.
    if _matches(request.headers.get("x-claraos-proxy-secret", ""), PROXY_SECRET):
        sender = (request.headers.get("x-authentik-username") or "").lower()
        if sender and sender == (target_user or "").lower():
            return True
    if not ENFORCE:  # dev mode without any trust anchor
        return True
    return False


@router.post("/dispatch")
async def dispatch(request: Request) -> JSONResponse:
    """Push an action to all live frontend connections of `target_user`.

    Auth (when `CLARAOS_MCP_TOKEN` env is set):
      * Send `X-Claraos-MCP-Token: <secret>` header (used by MCP servers), OR
      * Caller is an authenticated user and `target_user == self`.

    Body:
        {
          "target_user": "alice",     // required
          "app_id": "my-wrapp",        // required (the app handler key)
          "action": "select_node",     // required (the app-specific verb)
          "args": {...},               // required (app-specific payload)
          "instance_id": "...",        // optional (wrapp/window addressee)
          "window_id": "...",          // optional
          "from": "my-wrapp-mcp"       // optional, for telemetry
        }

    Returns:
        { "delivered": N }    where N is the number of receiving connections.
        Returns 200 even if N=0 (no listener) — it's still "accepted".
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"error": "invalid_json"}, status_code=400)

    target = body.get("target_user")
    if not _dispatch_authorised(request, target or ""):
        return JSONResponse(content={"error": "forbidden"}, status_code=403)

    app_id = body.get("app_id")
    action = body.get("action")
    if not target or not app_id or not action:
        return JSONResponse(
            content={"error": "missing_fields", "required": ["target_user", "app_id", "action"]},
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    return JSONResponse(content=await zustellen(
        target, app_id, action, body.get("args") or {},
        instance_id=body.get("instance_id"), window_id=body.get("window_id"),
        sender=body.get("from"),
    ))


async def zustellen(target: str, app_id: str, action: str, args: dict[str, Any],
                    instance_id: str | None = None, window_id: str | None = None,
                    sender: str | None = None) -> dict[str, Any]:
    """Push one action to `target`'s browsers and wait for what they report back.

    Returns {"delivered", "target_user", "rendered", "detail"}: `rendered` counts the
    browsers that confirmed the action, which is what a caller may report to the user.
    """
    global _ack_zaehler
    _ack_zaehler += 1
    action_id = f"{int(time.time() * 1000)}-{_ack_zaehler}"

    payload = {
        "type": "action",
        "app_id": app_id,
        "action": action,
        "args": args,
        "instance_id": instance_id,
        "window_id": window_id,
        "from": sender,
        "action_id": action_id,
        "ts": time.time(),
    }

    _acks[action_id] = []
    _ack_events[action_id] = asyncio.Event()
    try:
        delivered = await _broadcast(target, payload)
        antwort: dict[str, Any] = {"delivered": delivered, "target_user": target}
        if not delivered:
            antwort["rendered"] = 0
            antwort["detail"] = (
                f"Kein Browser mit offenem {PRODUCT_NAME} verbunden — es wurde NICHTS "
                "angezeigt. Dem Nutzer das so sagen, nicht Erfolg melden."
            )
            return antwort
        try:
            await asyncio.wait_for(_ack_events[action_id].wait(), timeout=_ACK_FRIST)
        except asyncio.TimeoutError:
            pass
        # Several browsers (phone + desktop) do not acknowledge at the same time.
        # Give the others a short grace period: with only the first answer, a
        # read_screen reported the desktop's open PDF while the phone the user
        # was holding showed an empty desktop — and the agent believed it.
        nachfrist = time.monotonic() + _ACK_NACHFRIST
        while 0 < len(_acks.get(action_id) or []) < delivered:
            rest = nachfrist - time.monotonic()
            if rest <= 0:
                break
            _ack_events[action_id].clear()
            if len(_acks.get(action_id) or []) >= delivered:
                break
            try:
                await asyncio.wait_for(_ack_events[action_id].wait(), timeout=rest)
            except asyncio.TimeoutError:
                break
        eingang = list(_acks.get(action_id) or [])
        gute = [a for a in eingang if a.get("ok")]
        antwort["rendered"] = len(gute)
        if len(eingang) > 1:
            # Hand over every device's answer — they can legitimately differ.
            zeilen = [
                f"[Browser {i}{'' if a.get('ok') else ', abgelehnt'}] {a.get('detail') or '-'}"
                for i, a in enumerate(eingang, 1)
            ]
            antwort["detail"] = (
                f"{len(eingang)} Browser des Nutzers haben geantwortet (z. B. Handy und Rechner) — "
                "sie können Verschiedenes zeigen. Gilt die Aussage für das Gerät, an dem der "
                "Nutzer gerade ist?\n" + "\n".join(zeilen)
            )
            if not gute:
                antwort["detail"] += "\nDem Nutzer NICHT Erfolg melden."
        elif gute:
            antwort["detail"] = gute[0].get("detail") or "angezeigt"
        elif eingang:
            antwort["detail"] = (
                (eingang[0].get("detail") or "Die Oberflaeche hat die Aktion abgelehnt.")
                + " Dem Nutzer NICHT Erfolg melden."
            )
        else:
            antwort["detail"] = (
                "Der Browser hat innerhalb von "
                f"{_ACK_FRIST:.0f} s nicht quittiert — unklar, ob etwas zu sehen ist. "
                "Beim Nutzer nachfragen statt Erfolg zu melden."
            )
        return antwort
    finally:
        _acks.pop(action_id, None)
        _ack_events.pop(action_id, None)


@router.post("/navigate")
async def navigate(request: Request) -> JSONResponse:
    """Deep-link an iframe-app to a specific view (Clara-Chat L2.5).

    Resolves `(app_id, pattern_key, params)` → relative path via the
    URL-pattern registry, prepends the app's origin, and broadcasts a
    shell `navigate_to` action. The frontend opens the app-window if it
    isn't already and points its iframe at the resolved URL.

    Body:
        {
          "target_user": "alice",          // required
          "app_id": "mautic",               // required (registry id)
          "pattern_key": "contact_view",    // required (see app_url_patterns)
          "params": {"id": 123},            // pattern placeholders
          "from": "navigate_to-mcp"          // optional telemetry
        }

    Returns: { "delivered": N, "url": "...", "app_id": ... } on success,
             400 on unknown app/pattern or missing params.
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"error": "invalid_json"}, status_code=400)

    target = body.get("target_user")
    if not _dispatch_authorised(request, target or ""):
        return JSONResponse(content={"error": "forbidden"}, status_code=403)

    app_id = body.get("app_id")
    pattern_key = body.get("pattern_key")
    if not target or not app_id or not pattern_key:
        return JSONResponse(
            content={"error": "missing_fields",
                     "required": ["target_user", "app_id", "pattern_key"]},
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    antwort, code = await deep_link(target, app_id, pattern_key, body.get("params") or {},
                                    sender=body.get("from"))
    return JSONResponse(content=antwort, status_code=code)


async def deep_link(target: str, app_id: str, pattern_key: str, params: dict[str, Any],
                    sender: str | None = None) -> tuple[dict[str, Any], int]:
    """Point `target`'s window of `app_id` at a registered view. Returns (answer, status)."""
    origin = _app_origin(app_id)
    if not origin:
        # Internal apps: no origin — a relative path is enough as long as the app
        # has registered patterns (the app navigator in the frontend parses it).
        if _app_is_internal(app_id) and known_patterns(app_id):
            origin = ""
        else:
            return {"error": "unknown_app_origin", "app_id": app_id}, status.HTTP_400_BAD_REQUEST

    try:
        path = resolve_path(app_id, pattern_key, params)
    except PatternError as e:
        return ({"error": "pattern_error", "detail": str(e),
                 "known_patterns": known_patterns(app_id)}, status.HTTP_400_BAD_REQUEST)

    url = origin + path
    payload = {
        "type": "action",
        "app_id": "shell",
        "action": "navigate_to",
        "args": {"app_id": app_id, "url": url, "pattern_key": pattern_key},
        "from": sender,
        "ts": time.time(),
    }
    delivered = await _broadcast(target, payload)
    return {"delivered": delivered, "url": url, "app_id": app_id}, 200


@router.get("/status")
async def status_endpoint() -> JSONResponse:
    """Lightweight introspection — how many frontends are currently subscribed."""
    return JSONResponse(
        content={
            "subscriber_counts": {u: len(socks) for u, socks in _subscribers.items() if socks},
            "total_connections": sum(len(s) for s in _subscribers.values()),
        }
    )


# ── Assistant tools: drive the caller's own screen ──────────────────────────
#
# The tool gateway (routers/clara_tools.py, clara-tools.d/action.yaml) calls these
# with the user of the running chat turn in `X-Claraos-User`. The screen that is
# driven is always that user's: a `target_user` in the body is ignored, so neither
# the model nor injected text can reach another user's session.

# Viewer apps the shell registers; any other `viewer_hint` is ignored.
_BETRACHTER = frozenset({
    "image-viewer", "pdf-viewer", "video-player", "text-editor",
    "office-viewer", "model-viewer", "files",
})
_NEBEN_CHAT = "anchor-chat-right"
_KEIN_BROWSER = (f"Kein Browser mit offenem {PRODUCT_NAME} verbunden — es wurde NICHTS "
                 "angezeigt. Dem Nutzer das so sagen, nicht Erfolg melden.")


def _bericht(antwort: dict[str, Any], app_id: str, action: str) -> dict[str, Any]:
    """Tool answer: `ok` follows what the browser confirmed, not the transport."""
    rendered = antwort.get("rendered")
    ergebnis: dict[str, Any] = {
        "ok": bool(rendered) if rendered is not None else bool(antwort.get("delivered")),
        "delivered": antwort.get("delivered", 0),
        "action": action,
        "app_id": app_id,
    }
    if rendered is not None:
        ergebnis["rendered"] = rendered
    if antwort.get("detail"):
        ergebnis["detail"] = antwort["detail"]
    return ergebnis


async def _shell(user: str, action: str, args: dict[str, Any]) -> dict[str, Any]:
    return _bericht(await zustellen(user, "shell", action, args, sender="assistant"), "shell", action)


def _text(body: dict[str, Any], key: str) -> str:
    wert = body.get(key)
    return wert.strip() if isinstance(wert, str) else ""


@router.post("/clara/{werkzeug}")
async def clara_werkzeug(werkzeug: str, request: Request) -> JSONResponse:
    """One UI tool of the assistant, executed on the calling user's screen."""
    user = require_caller(request).lower()
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        return JSONResponse(content={"error": "invalid_json"}, status_code=400)

    if werkzeug == "open_window":
        app_id = _text(body, "app_id")
        if not app_id:
            return JSONResponse(content={"ok": False, "error": "app_id fehlt"}, status_code=422)
        opts = body.get("opts") if isinstance(body.get("opts"), dict) else {}
        opts.setdefault("position", _NEBEN_CHAT)
        ergebnis = await _shell(user, "open_window", {"app_id": app_id, "opts": opts})
    elif werkzeug == "close_window":
        ergebnis = await _shell(user, "close_window", {"app_id": _text(body, "app_id") or "*"})
    elif werkzeug == "navigate_files":
        args = {"source": _text(body, "source") or "nextcloud", "path": _text(body, "path") or "/"}
        if _text(body, "select_filename"):
            args["select_filename"] = _text(body, "select_filename")
        ergebnis = _bericht(await zustellen(user, "files", "navigate", args, sender="assistant"),
                            "files", "navigate")
    elif werkzeug == "open_in_viewer":
        pfad = _text(body, "path")
        if not pfad:
            return JSONResponse(content={"ok": False, "error": "path fehlt"}, status_code=422)
        quelle = _text(body, "source") or "nextcloud"
        titel = pfad.rsplit("/", 1)[-1] or pfad
        hint = _text(body, "viewer_hint")
        if hint in _BETRACHTER:
            ergebnis = await _shell(user, "open_window", {"app_id": hint, "opts": {
                "path": pfad, "source": quelle, "position": _NEBEN_CHAT, "title": titel}})
        else:
            ergebnis = await _shell(user, "open_in_viewer",
                                    {"path": pfad, "source": quelle, "title": titel})
            if hint:
                ergebnis["hinweis"] = (
                    f"viewer_hint '{hint}' gibt es nicht (erlaubt: {sorted(_BETRACHTER)}); "
                    "der Betrachter wurde nach Dateiendung gewählt.")
    elif werkzeug == "read_screen":
        ergebnis = await _shell(user, "read_screen", {})
    elif werkzeug == "show_artifact":
        args = {"kind": _text(body, "kind") or "markdown", "content": str(body.get("content") or "")}
        for key in ("mime", "title"):
            if _text(body, key):
                args[key] = _text(body, key)
        ergebnis = await _shell(user, "show_artifact", args)
    elif werkzeug == "office_insert":
        args = {"content": str(body.get("content") or ""),
                "mime": _text(body, "mime") or "text/plain;charset=utf-8",
                "save": bool(body.get("save"))}
        if _text(body, "position") == "end":
            args["position"] = "end"
        ergebnis = _bericht(await zustellen(user, "office-viewer", "insert", args,
                                            window_id=_text(body, "window_id") or None,
                                            sender="assistant"), "office-viewer", "insert")
    elif werkzeug == "navigate_to":
        params = body.get("params")
        if isinstance(params, str):  # models often send the object as a JSON string
            try:
                params = json.loads(params) if params.strip() else {}
            except ValueError:
                params = {}
        params = dict(params) if isinstance(params, dict) else {}
        if body.get("id") not in (None, "") and "id" not in params:
            params["id"] = body["id"]
        # The model names the id loosely ("id", "album_id", "taskId"); the pattern
        # wants its own placeholder. One id given → it fills the missing placeholder.
        ids = [k for k in params if k.lower().endswith("id")]
        for platz in re.findall(r"\{(\w+)\}", URL_PATTERNS.get(_text(body, "app_id"), {})
                                .get(_text(body, "pattern_key"), "")):
            if platz not in params and len(ids) == 1:
                params[platz] = params[ids[0]]
        antwort, code = await deep_link(user, _text(body, "app_id"), _text(body, "pattern_key"),
                                        params, sender="assistant")
        return JSONResponse(content=antwort, status_code=code)
    elif werkzeug == "dispatch":
        app_id, action = _text(body, "app_id"), _text(body, "action")
        if not app_id or not action:
            return JSONResponse(content={"ok": False, "error": "app_id und action nötig"},
                                status_code=422)
        args = body.get("args") if isinstance(body.get("args"), dict) else {}
        ergebnis = _bericht(await zustellen(
            user, app_id, action, args,
            instance_id=_text(body, "instance_id") or None,
            window_id=_text(body, "window_id") or None, sender="assistant"), app_id, action)
    else:
        return JSONResponse(content={"error": "unknown_tool", "tool": werkzeug}, status_code=404)

    if not ergebnis.get("delivered"):
        ergebnis["detail"] = _KEIN_BROWSER
    return JSONResponse(content=ergebnis)


# Bus handlers — deliver events from other instances locally
async def _bus_actions_push(data: dict) -> None:
    await _broadcast(data.get("user", ""), data.get("payload") or {}, _from_bus=True)

async def _bus_actions_ack(data: dict) -> None:
    """Acknowledgement from another API instance."""
    action_id = str(data.get("action_id") or "")
    if action_id:
        _ack_merken(action_id, data.get("ack") or {})


from services import pg_bus as _pg_bus  # noqa: E402
_pg_bus.register("actions.push", _bus_actions_push)
_pg_bus.register("actions.ack", _bus_actions_ack)

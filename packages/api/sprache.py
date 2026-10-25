"""Language of server-generated texts (error details, confirmations, hints).

The shell translates everything it renders itself. What the server writes —
an error detail, "3 mails back in the inbox", the name of a default view — is
translated here, from small JSON catalogs in the same format as the shell's:
`locales/<lang>/server.json`, nested keys, `{name}` placeholders.

Which language: the user's `region-formats.uiLanguage` setting. Its default
"system" means "like the browser", and the browser states that in every
request (`Accept-Language`), so the server needs nothing extra. Unknown →
German, the product's fallback language.

Texts the model reads (Clara's tools) are not translated: they are input,
not interface.
"""
from __future__ import annotations

import json
import logging
from contextvars import ContextVar
from functools import lru_cache
from pathlib import Path

from fastapi import Request

log = logging.getLogger(__name__)

# Codes as in packages/core/src/i18n/languages.ts.
SPRACHEN = ("de", "en")
STANDARD = "de"
_LOCALES = Path(__file__).with_name("locales")


@lru_cache(maxsize=None)
def _katalog(lang: str) -> dict:
    try:
        return json.loads((_LOCALES / lang / "server.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def fehlende_kataloge() -> list[str]:
    """Languages whose catalog file is missing or empty. Without the German
    one every server text shows as its raw key — a packaging mistake that must
    not stay silent (it shipped once: the export copied only imported .py)."""
    return [lang for lang in SPRACHEN if not _katalog(lang)]


if fehlende_kataloge():
    log.error("server text catalogs missing for %s in %s — texts will show as raw keys",
              ", ".join(fehlende_kataloge()), _LOCALES)


def _suche(katalog: dict, key: str) -> str | None:
    node: object = katalog
    for teil in key.split("."):
        if not isinstance(node, dict) or teil not in node:
            return None
        node = node[teil]
    return node if isinstance(node, str) else None


def t(lang: str, key: str, default: str | None = None, **werte: object) -> str:
    """Text for `key` in `lang`, falling back to German, then to `default`
    (for tables where only some entries have text), then to the key."""
    text = _suche(_katalog(lang), key) or _suche(_katalog(STANDARD), key)
    if text is None:
        if default is not None:
            return default
        log.warning("server text missing: %s", key)
        return key
    # A Text inside the values (a reason, a formula error) follows the same language.
    werte = {k: t(lang, v.key, **v.werte) if isinstance(v, Text) else v for k, v in werte.items()}
    try:
        return text.format(**werte)
    except (KeyError, IndexError, ValueError):
        log.warning("server text %s: placeholders do not match %s", key, sorted(werte))
        return text


class Text(str):
    """A server text that is translated when the response is written.

    Use as an HTTPException detail where the raising code has no request at
    hand: `raise HTTPException(409, detail=Text("post.noAccount"))`. Its str
    value is the German text, so code that reads `.detail` — and any path
    without the handler from `einbinden` — keeps working unchanged.
    """

    key: str
    werte: dict

    def __new__(cls, key: str, **werte: object) -> "Text":
        obj = super().__new__(cls, t(STANDARD, key, **werte))
        obj.key = key
        obj.werte = werte
        return obj


_scope: ContextVar[dict | None] = ContextVar("sprache_scope", default=None)


class _AnfrageMerken:
    """Pure ASGI middleware: remembers the current HTTP scope for `tx`."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        token = _scope.set(scope)
        try:
            return await self.app(scope, receive, send)
        finally:
            _scope.reset(token)


async def sprache_jetzt() -> str:
    """Language of the request being served (German outside one)."""
    scope = _scope.get()
    return await sprache_von(Request(scope)) if scope else STANDARD


async def tx(key: str, **werte: object) -> str:
    """`t` in the language of the request being served (German outside one).

    For texts built deep inside helpers that never see the request, e.g. the
    confirmation "Contact created" shared by the app and the Outlook bridge.
    """
    return t(await sprache_jetzt(), key, **werte)


def einbinden(app) -> None:
    """Translate `Text` details of HTTP errors into the caller's language and
    make `tx` work inside requests."""
    from fastapi.exception_handlers import http_exception_handler
    from starlette.exceptions import HTTPException as StarletteHTTPException

    app.add_middleware(_AnfrageMerken)

    @app.exception_handler(StarletteHTTPException)
    async def _uebersetzt(request: Request, exc: StarletteHTTPException):
        if isinstance(exc.detail, Text):
            exc.detail = t(await sprache_von(request), exc.detail.key, **exc.detail.werte)
        elif isinstance(exc.detail, dict) and any(isinstance(v, Text) for v in exc.detail.values()):
            # {"code": …, "message": Text(…)} — the code stays, the message is translated
            lang = await sprache_von(request)
            exc.detail = {k: fuer(lang, v) if isinstance(v, Text) else v for k, v in exc.detail.items()}
        return await http_exception_handler(request, exc)


def tn(lang: str, key: str, n: int, **werte: object) -> str:
    """Plural form like the shell's i18next: `<key>_one` for 1, else `<key>_other`."""
    return t(lang, f"{key}_{'one' if n == 1 else 'other'}", n=n, **werte)


def aus_accept_language(header: str | None) -> str | None:
    """First supported language in an Accept-Language header (by weight)."""
    if not header:
        return None
    kandidaten = []
    for i, teil in enumerate(header.split(",")):
        tag, _, rest = teil.strip().partition(";")
        q = 1.0
        if rest.strip().startswith("q="):
            try:
                q = float(rest.strip()[2:])
            except ValueError:
                q = 0.0
        kandidaten.append((-q, i, tag.strip().lower()[:2]))
    for _, _, code in sorted(kandidaten):
        if code in SPRACHEN:
            return code
    return None


def aus_einstellung(wert: object) -> str | None:
    """The stored uiLanguage if it names a language ("system" does not)."""
    return wert if isinstance(wert, str) and wert in SPRACHEN else None


async def _gespeichert(username: str) -> object:
    from database import user_tx  # late import: keeps this module testable without a DB

    async with user_tx(username) as conn:
        roh = await conn.fetchval(
            "SELECT value FROM claraos_user_settings "
            "WHERE username=$1 AND module='region-formats' AND key='uiLanguage'",
            username,
        )
    return json.loads(roh) if roh else None


# Browser language last seen per user, for texts sent without a request
# (pushes, reminders) to users whose setting is "system". In memory only: after
# a restart it is German until the user's next request — good enough for a
# push, and no write per request.
_zuletzt: dict[str, str] = {}


async def sprache_von(request: Request) -> str:
    """Language for texts in the response to `request` (cached per request)."""
    schon = getattr(request.state, "sprache", None)
    if schon:
        return schon
    lang = None
    username = None
    try:
        from auth import get_current_user

        username = get_current_user(request).get("username")
        if username:
            lang = aus_einstellung(await _gespeichert(username))
    except Exception as exc:  # a text must never break the response
        log.debug("uiLanguage not readable: %s", exc)
    if not lang:
        lang = aus_accept_language(request.headers.get("accept-language"))
        if lang and username:
            _zuletzt[username] = lang
    lang = lang or STANDARD
    request.state.sprache = lang
    return lang


async def sprache_fuer(username: str) -> str:
    """Language for a text to `username` outside a request (push, reminder):
    the stored setting, else the browser language last seen, else German."""
    try:
        lang = aus_einstellung(await _gespeichert(username))
    except Exception as exc:
        log.debug("uiLanguage of %s not readable: %s", username, exc)
        lang = None
    return lang or _zuletzt.get(username) or STANDARD


def fuer(lang: str, text: object) -> str:
    """Resolve a text meant for one recipient: a `Text`, a `lang -> str`
    callable, or a plain str (returned as is)."""
    if isinstance(text, Text):
        return t(lang, text.key, **text.werte)
    if callable(text):
        return text(lang)
    return str(text)

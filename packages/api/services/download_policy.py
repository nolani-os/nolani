"""Response policy for user-supplied files served from the shell origin.

Mail attachments and cloud files are content a stranger can choose: the sender
of a mail sets the MIME type of an attachment, a colleague decides what lands in
a shared folder. Everything the API streams is served from `home.<domain>`, the
origin that holds the user's session. A `text/html` or `image/svg+xml` file that
the browser renders as a page there runs its scripts with that session.

So only types that cannot carry script render inline; every other type is
served as a download with a neutral content type. On top of that every response
carries `nosniff` (no guessing HTML from the bytes) and a sandboxing CSP, so even
a file that reaches a browser tab cannot run script on the shell origin.
"""
from __future__ import annotations

# Rendered inline. Deliberately NO text/html, image/svg+xml, application/xhtml+xml,
# text/xml or anything else that a browser executes as a document.
INLINE_SAFE_TYPES = frozenset({
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp",
    "video/mp4", "video/webm", "video/ogg", "video/quicktime",
    "audio/mpeg", "audio/ogg", "audio/wav", "audio/x-wav", "audio/webm", "audio/mp4",
    "audio/aac", "audio/flac",
    "application/pdf",
    "text/plain",
})

# SVG is needed by the image viewer (fetched or used as <img>, where scripts never
# run), but must not open as a page: it keeps its type for <img> and goes out as
# a download for top-level navigation.
_SVG = "image/svg+xml"

# `sandbox` without `allow-scripts` turns the response into an opaque origin
# without script, even if a tab renders it. The PDF viewer of Chromium does not
# render inside a sandboxed document, so PDF gets only `nosniff`; its own viewer
# runs PDF scripts isolated from the page origin.
_SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'"


def base_type(content_type: str | None) -> str:
    """`text/html; charset=utf-8` -> `text/html`; missing -> octet-stream."""
    value = (content_type or "").split(";", 1)[0].strip().lower()
    return value or "application/octet-stream"


def is_inline_safe(content_type: str | None) -> bool:
    return base_type(content_type) in INLINE_SAFE_TYPES


def safe_media(content_type: str | None, want_inline: bool) -> tuple[str, bool, dict[str, str]]:
    """Content type, inline flag and security headers for one response.

    `want_inline` is what the caller asked for; the result is inline only when
    the type is in the allowlist as well.
    """
    ctype = base_type(content_type)
    headers = {"X-Content-Type-Options": "nosniff"}
    if ctype != "application/pdf":
        headers["Content-Security-Policy"] = _SANDBOX_CSP
    if ctype in INLINE_SAFE_TYPES:
        return ctype, want_inline, headers
    if ctype == _SVG:
        return ctype, False, headers
    return "application/octet-stream", False, headers

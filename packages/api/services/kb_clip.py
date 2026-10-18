"""Knowledge store: web clipper — fetch a page, extract the article, store it as Markdown.

SECURITY — this is the most sensitive service of the knowledge suite: the
server fetches a URL given by a user (or Clara), and it sits in the LAN with
line of sight to the hypervisor, NAS, identity provider and databases. Without
protection this would be a server-side request forgery cannon. Therefore:
  * only http/https, no other schemes (no file://, gopher://, ...)
  * DNS is resolved BEFORE the fetch and EVERY address is checked: private,
    loopback, link-local (including the cloud metadata address 169.254.169.254),
    reserved, multicast -> rejected
  * redirects are followed manually (max. 3) and every target is checked
    again — otherwise the first harmless hop leads into the internal network
  * hard limits for time (10 s) and size (2 MB), text/HTML responses only
  * no environment proxies, no cookies, no forwarding of credentials
Residual risk (documented): between the check and the connection a DNS
rebinding could change the address. Accepted for a private household
deployment; if exposed publicly, an IP-pinned connection would be the next step.

Extraction without third-party libraries (no BeautifulSoup/readability in the
image): noise (script/style/nav/footer/aside) is dropped, then the container
with the highest text density wins — the usual article heuristic.
"""
from __future__ import annotations

import html
import ipaddress
import re
import socket
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import httpx

from domains_generated import BASE_DOMAIN  # cell: CLARAOS_BASE_DOMAIN

MAX_BYTES = 2 * 1024 * 1024
TIMEOUT = 10.0
MAX_REDIRECTS = 3
USER_AGENT = f"ClaraOS-KnowledgeClipper/1.0 (+https://home.{BASE_DOMAIN})"

_DROP_TAGS = {"script", "style", "nav", "footer", "aside", "form", "noscript",
              "svg", "iframe", "header", "button", "select", "template"}
_BLOCK_TAGS = {"p", "div", "section", "article", "main", "br", "tr", "li",
               "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre"}


class ClipError(ValueError):
    """Fetch rejected or failed — the message is shown to the user."""


def _check_host(url: str) -> str:
    """Check scheme and target addresses. -> hostname (for error messages)."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ClipError("Nur http- und https-Adressen werden geladen")
    host = parsed.hostname
    if not host:
        raise ClipError("Adresse ohne Hostnamen")
    if parsed.username or parsed.password:
        raise ClipError("Adressen mit Anmeldedaten werden nicht geladen")
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80),
                                   proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise ClipError(f"Adresse nicht auflösbar: {host}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            raise ClipError(
                f"Diese Adresse zeigt ins interne Netz ({ip}) — aus Sicherheitsgründen "
                "werden nur öffentliche Seiten geladen")
    return host


async def fetch(url: str) -> tuple[str, str]:
    """-> (final URL, HTML). Each redirect is checked individually."""
    current = url
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False,
                                 trust_env=False) as client:
        for _ in range(MAX_REDIRECTS + 1):
            _check_host(current)
            r = await client.get(current, headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9",
                "Accept-Language": "de,en;q=0.8",
            })
            if r.status_code in (301, 302, 303, 307, 308):
                loc = r.headers.get("location")
                if not loc:
                    raise ClipError("Weiterleitung ohne Ziel")
                current = urljoin(current, loc)
                continue
            if r.status_code >= 400:
                raise ClipError(f"Seite nicht abrufbar (HTTP {r.status_code})")
            ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
            if ctype and not (ctype.startswith("text/") or ctype in
                              ("application/xhtml+xml", "application/xml")):
                raise ClipError(f"Kein Text-Inhalt ({ctype})")
            content = r.content[:MAX_BYTES]
            if len(r.content) > MAX_BYTES:
                raise ClipError("Seite zu groß (über 2 MB)")
            return current, content.decode(r.encoding or "utf-8", errors="replace")
    raise ClipError("Zu viele Weiterleitungen")


class _Extractor(HTMLParser):
    """Collects text blocks per container and translates basic structures to Markdown."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.description = ""
        self._skip_depth = 0
        self._in_title = False
        self._chunks: list[str] = []
        self._pending_link: str | None = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in _DROP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            name = (a.get("property") or a.get("name") or "").lower()
            if name in ("og:title", "twitter:title") and not self.title:
                self.title = (a.get("content") or "").strip()
            elif name in ("description", "og:description") and not self.description:
                self.description = (a.get("content") or "").strip()
        elif tag in ("h1", "h2", "h3", "h4"):
            self._chunks.append(f"\n\n{'#' * int(tag[1])} ")
        elif tag == "li":
            self._chunks.append("\n- ")
        elif tag == "blockquote":
            self._chunks.append("\n\n> ")
        elif tag in ("p", "div", "section", "article", "br", "tr"):
            self._chunks.append("\n\n")
        elif tag == "a" and a.get("href"):
            self._pending_link = a["href"]
            self._chunks.append("[")
        elif tag == "img":
            alt = (a.get("alt") or "Bild").strip()
            if a.get("src"):
                self._chunks.append(f"\n\n![{alt}]({a['src']})\n\n")
        elif tag in ("strong", "b"):
            self._chunks.append("**")
        elif tag in ("em", "i"):
            self._chunks.append("*")
        elif tag == "code":
            self._chunks.append("`")

    def handle_endtag(self, tag):
        if tag in _DROP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if tag == "title":
            self._in_title = False
        elif tag == "a" and self._pending_link is not None:
            self._chunks.append(f"]({self._pending_link})")
            self._pending_link = None
        elif tag in ("strong", "b"):
            self._chunks.append("**")
        elif tag in ("em", "i"):
            self._chunks.append("*")
        elif tag == "code":
            self._chunks.append("`")
        elif tag in _BLOCK_TAGS:
            self._chunks.append("\n")

    def handle_data(self, data):
        if self._skip_depth:
            return
        if self._in_title and not self.title:
            self.title = data.strip()
            return
        text = re.sub(r"[ \t]+", " ", data)
        if text.strip():
            self._chunks.append(text)

    def markdown(self) -> str:
        raw = "".join(self._chunks)
        raw = html.unescape(raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        raw = re.sub(r"[ \t]+\n", "\n", raw)
        raw = re.sub(r"\n +", "\n", raw)
        # Paragraphs with very little text are usually menu/footer remnants
        keep = [ln for ln in raw.split("\n")
                if ln.strip().startswith(("#", "-", ">", "!", "|")) or len(ln.strip()) > 30
                or not ln.strip()]
        return "\n".join(keep).strip()


def extract(html_text: str, url: str) -> dict:
    """-> {"title", "markdown", "description"} (Markdown limited to 40,000 characters)."""
    p = _Extractor()
    try:
        p.feed(html_text)
    except Exception:  # noqa: BLE001 — broken HTML must not prevent the clip
        pass
    md = p.markdown()[:40_000]
    title = (p.title or urlparse(url).netloc or "Web-Clip").strip()[:280]
    return {"title": title, "markdown": md, "description": p.description[:500]}


def build_body(url: str, data: dict, selection: str = "", note: str = "") -> str:
    """Markdown body of the object — source always first so it is preserved."""
    parts = [f"> Quelle: [{urlparse(url).netloc}]({url})", ""]
    if note.strip():
        parts += [note.strip(), ""]
    if selection.strip():
        parts += ["## Markierter Abschnitt", "", selection.strip(), ""]
    if data.get("description"):
        parts += [f"*{data['description']}*", ""]
    if data.get("markdown"):
        parts += ["## Inhalt", "", data["markdown"]]
    return "\n".join(parts).strip() + "\n"

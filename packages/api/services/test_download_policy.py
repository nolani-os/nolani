"""Download policy: which user-supplied files may render on the shell origin.

The dangerous direction is the one that silently works: a sender-chosen
`text/html` attachment that opens as a page of `home.<domain>`. These tests pin
that every type outside the allowlist leaves as a neutral download, and that the
attachment endpoint of the mail app applies the policy end to end.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest
import respx

from routers import post
from services.download_policy import base_type, is_inline_safe, safe_media


@pytest.mark.parametrize("ctype", [
    "text/html", "text/html; charset=utf-8", "application/xhtml+xml", "text/xml",
    "application/javascript", "TEXT/HTML", "", None,
])
def test_script_capable_types_become_downloads(ctype):
    media_type, inline, headers = safe_media(ctype, want_inline=True)
    assert media_type == "application/octet-stream"
    assert inline is False
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["Content-Security-Policy"].startswith("sandbox")


def test_svg_keeps_its_type_for_img_but_never_renders_as_page():
    media_type, inline, headers = safe_media("image/svg+xml", want_inline=True)
    assert media_type == "image/svg+xml"
    assert inline is False
    assert "sandbox" in headers["Content-Security-Policy"]


@pytest.mark.parametrize("ctype", ["image/png", "image/jpeg; foo=bar", "video/mp4", "text/plain; charset=utf-8"])
def test_allowlisted_types_stay_inline_when_asked(ctype):
    media_type, inline, _ = safe_media(ctype, want_inline=True)
    assert media_type == base_type(ctype)
    assert inline is True
    assert safe_media(ctype, want_inline=False)[1] is False


def test_pdf_is_inline_without_sandbox_because_the_viewer_needs_it():
    media_type, inline, headers = safe_media("application/pdf", want_inline=True)
    assert (media_type, inline) == ("application/pdf", True)
    assert "Content-Security-Policy" not in headers
    assert headers["X-Content-Type-Options"] == "nosniff"


def test_is_inline_safe_normalises_parameters_and_case():
    assert is_inline_safe("Image/PNG; q=1")
    assert not is_inline_safe("text/html")


DOWNLOAD = "https://jmap.example.org/download/{accountId}/{blobId}/{name}?accept={type}"


def _blob(monkeypatch, upstream_type: str, query_type: str):
    async def session(user):
        return {"download_url": DOWNLOAD, "headers": {"Authorization": "Basic x"}}

    async def konto(user, account_id):
        return "acc1"

    monkeypatch.setattr(post, "require_caller", lambda request: "alice")
    monkeypatch.setattr(post, "_jmap_session", session)
    monkeypatch.setattr(post, "_konto", konto)

    async def run():
        with respx.mock(assert_all_called=True) as mock:
            route = mock.get(url__startswith="https://jmap.example.org/download/acc1/b1/").mock(
                return_value=httpx.Response(200, content=b"<p id=x>", headers={"content-type": upstream_type}))
            resp = await post.post_blob("b1", request=None, name="rechnung.html", type=query_type, account_id=None)
            body = b"".join([chunk async for chunk in resp.body_iterator])
            return resp, body, str(route.calls.last.request.url)

    return asyncio.run(run())


def test_html_mail_attachment_is_downloaded_not_rendered(monkeypatch):
    resp, body, upstream_url = _blob(monkeypatch, "text/html", "text/html")
    assert resp.media_type == "application/octet-stream"
    assert resp.headers["content-disposition"].startswith("attachment;")
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["content-security-policy"].startswith("sandbox")
    assert "text%2Fhtml" not in upstream_url  # the sender's type is not echoed back
    assert body == b"<p id=x>"


def test_image_attachment_stays_inline_for_the_reading_pane(monkeypatch):
    resp, _, upstream_url = _blob(monkeypatch, "image/png", "image/png")
    assert resp.media_type == "image/png"
    assert resp.headers["content-disposition"].startswith("inline;")
    assert "image%2Fpng" in upstream_url

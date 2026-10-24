"""Small HTML/DoS sinks reachable from the shell origin.

- mail attachments: a tiny archive must not inflate into gigabytes in the API
- iframe bootstrap: user name and manifest values are escaped, also inside <script>
- auth proxy: error pages never echo request data unescaped
"""
from __future__ import annotations

import asyncio
import gzip
import io
import time
import zipfile

from routers import auth_proxy, iframe_bootstrap, mail


def test_gzip_bomb_is_cut_off():
    bomb = gzip.compress(b"\0" * (64 * 1024 * 1024), compresslevel=9)   # ~64 KB -> 64 MB
    start = time.monotonic()
    text, _ = mail._entpacken("report.xml.gz", bomb)
    assert len(text) <= mail._ENTPACKT_MAX
    assert time.monotonic() - start < 5


def test_zip_bomb_is_cut_off_across_members():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for i in range(4):
            z.writestr(f"part{i}.xml", b"A" * (8 * 1024 * 1024))
    text, _ = mail._entpacken("report.zip", buf.getvalue())
    assert len(text) <= mail._ENTPACKT_MAX + 4   # + separators


def test_small_archives_unpack_unchanged():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("a.xml", "<feedback/>")
        z.writestr("dir/", "")
    assert mail._entpacken("r.zip", buf.getvalue())[0] == "<feedback/>"
    assert mail._entpacken("r.gz", gzip.compress(b"<x/>"))[0] == "<x/>"
    assert mail._entpacken("r.txt", b"plain")[0] == "plain"


def test_bootstrap_page_escapes_user_and_manifest_values():
    page = iframe_bootstrap._build_bootstrap_html(
        service_url="https://app.example.org/</script><script>window.__x=1</script>",
        logout_url=None, login_url="https://app.example.org/login",
        session_cookies=["sid</script>"], user_hint="<b>alice</b>", app_id="<i>app</i>")
    assert "<b>alice</b>" not in page and "&lt;b&gt;alice&lt;/b&gt;" in page
    assert "<i>app</i>" not in page
    assert page.count("</script>") == 1          # only the real closing tag
    assert "\\u003c/script>" in page


def test_nc_editor_does_not_reflect_the_doctype(monkeypatch):
    async def creds(user, app):
        return {"username": "alice", "password": "pw"}

    monkeypatch.setattr(auth_proxy, "get_current_user", lambda request: {"username": "alice"})
    monkeypatch.setattr(auth_proxy, "_get_active_credentials", creds)
    resp = asyncio.run(auth_proxy.nc_editor("<img src=x onerror=window.__x=1>", request=None))
    assert resp.status_code == 400
    assert b"<img" not in resp.body and b"&lt;img" in resp.body

"""HEAD follows GET's download policy without consuming an upstream stream."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
import pytest
import respx

from routers import files_v2 as files


URL = "/api/claraos/files/v2/download"
UPSTREAM = "https://cloud.example.com/file"


class TrackedStream(httpx.AsyncByteStream):
    def __init__(self):
        self.read = False
        self.closed = False

    async def __aiter__(self):
        self.read = True
        yield b"file bytes"

    async def aclose(self):
        self.closed = True


@pytest.fixture
def download(monkeypatch):
    backend = SimpleNamespace(is_nc=True, nc_user="alice", nc_pass="synthetic",
                              kind=AsyncMock(return_value="file"))
    monkeypatch.setattr(files, "get_current_user", lambda request: "alice")
    monkeypatch.setattr(files._Backend, "open", AsyncMock(return_value=backend))
    monkeypatch.setattr(files, "_webdav_url", lambda *args: UPSTREAM)
    app = FastAPI()
    app.include_router(files.router)
    with TestClient(app) as client:
        yield client, backend


@pytest.mark.parametrize("kind,ctype,extra", [
    ("file", "text/plain", {"Content-Length": "10"}),
    ("file", "text/html", {}),
    ("file", "video/mp4", {"Content-Length": "10", "Content-Range": "bytes 0-9/100"}),
    ("dir", "application/zip", {"Content-Length": "10"}),
])
def test_head_preserves_get_headers_without_reading(download, kind, ctype, extra):
    client, backend = download
    backend.kind.return_value = kind
    streams = []
    def upstream(request):
        stream = TrackedStream()
        streams.append(stream)
        return httpx.Response(206 if "Content-Range" in extra else 200,
                              headers={"Content-Type": ctype, "ETag": '"fixture"', **extra},
                              stream=stream)
    with respx.mock:
        respx.get(UPSTREAM).mock(side_effect=upstream)
        params = {"path": "/résumé.txt", "inline": "true"}
        get = client.get(URL, params=params)
        head = client.head(URL, params=params)
    assert head.status_code == get.status_code
    assert head.headers == get.headers
    assert head.content == b""
    assert streams[0].read and streams[0].closed
    assert not streams[1].read and streams[1].closed


def test_head_sftp_does_not_start_stream(download, monkeypatch):
    client, backend = download
    backend.is_nc = False
    backend.src = {"host": "sftp.example.com", "port": 22, "user": "alice"}
    started = []
    async def stream(*args, **kwargs):
        started.append(True)
        yield b"file bytes"
    monkeypatch.setattr(files.sftp_client, "stream_file", stream)
    get = client.get(URL, params={"path": "/file.txt"})
    started.clear()
    head = client.head(URL, params={"path": "/file.txt"})
    assert head.status_code == 200
    assert head.headers == get.headers
    assert head.content == b"" and not started


def test_head_fallback_zip_keeps_length(download):
    client, backend = download
    backend.is_nc = False
    backend.read = AsyncMock(return_value=b"file bytes")
    params = [("path", "/a.txt"), ("path", "/b.txt")]
    get = client.get(URL, params=params)
    head = client.head(URL, params=params)
    assert head.status_code == 200
    assert head.headers == get.headers
    assert int(head.headers["content-length"]) == len(get.content)
    assert head.content == b""


def test_head_missing_file(download):
    client, backend = download
    backend.kind.return_value = None
    assert client.head(URL, params={"path": "/missing"}).status_code == 404

"""Directory lookup for users named by a machine caller (chat proxy).

`python3 -m pytest routers/test_chat_v2_directory.py`
"""
from __future__ import annotations

import asyncio

from routers import chat_v2


class _Resp:
    def __init__(self, status: int, data: dict):
        self.status_code = status
        self._data = data

    def json(self) -> dict:
        return self._data


def _fake_client(resp: _Resp, calls: list):
    class _Client:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, params=None, headers=None):
            calls.append(params)
            return resp

    return _Client


def _setup(monkeypatch, resp: _Resp) -> list:
    calls: list = []
    monkeypatch.setenv("AUTHENTIK_API_TOKEN", "t")
    monkeypatch.setattr(chat_v2, "_AUTHENTIK_URL", "http://directory")
    monkeypatch.setattr(chat_v2, "_directory", {})
    monkeypatch.setattr(chat_v2.httpx, "AsyncClient", _fake_client(resp, calls))
    return calls


def test_service_user_gets_email_and_role_from_directory(monkeypatch):
    calls = _setup(monkeypatch, _Resp(200, {"results": [
        {"username": "alice", "email": "alice@example.org",
         "groups_obj": [{"name": "clara-admins"}]}]}))
    user = {"username": "alice", "email": "", "groups": [], "role": "guest"}
    out = asyncio.run(chat_v2._with_directory_identity(user))
    assert out["email"] == "alice@example.org" and out["role"] == "admin"
    assert calls == [{"username": "alice", "is_active": "true"}]
    # cached: no second request
    asyncio.run(chat_v2._with_directory_identity(user))
    assert len(calls) == 1


def test_no_exact_match_leaves_user_unchanged(monkeypatch):
    _setup(monkeypatch, _Resp(200, {"results": [
        {"username": "alice2", "email": "x@example.org", "groups_obj": []}]}))
    user = {"username": "alice", "email": "", "groups": [], "role": "guest"}
    assert asyncio.run(chat_v2._with_directory_identity(user)) == user


def test_directory_error_or_missing_token_leaves_user_unchanged(monkeypatch):
    _setup(monkeypatch, _Resp(500, {}))
    user = {"username": "alice", "email": "", "groups": [], "role": "guest"}
    assert asyncio.run(chat_v2._with_directory_identity(user)) == user
    monkeypatch.delenv("AUTHENTIK_API_TOKEN")
    monkeypatch.setattr(chat_v2, "_directory", {})
    assert asyncio.run(chat_v2._with_directory_identity(user)) == user


def test_user_with_email_is_not_looked_up(monkeypatch):
    calls = _setup(monkeypatch, _Resp(200, {"results": []}))
    user = {"username": "bob", "email": "bob@example.org", "groups": [], "role": "user"}
    assert asyncio.run(chat_v2._with_directory_identity(user)) is user
    assert calls == []


def test_live_voice_users_from_env(monkeypatch):
    monkeypatch.setenv("CLARAOS_LIVE_VOICE_USERS", " Alice, bob ,,")
    assert chat_v2.live_voice_users() == {"alice", "bob"}
    monkeypatch.setenv("CLARAOS_LIVE_VOICE_USERS", "")
    assert chat_v2.live_voice_users() == set()

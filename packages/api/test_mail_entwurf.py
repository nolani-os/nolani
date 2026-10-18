"""Draft recipients: `an_mich_selbst` addresses the draft to the account itself.

Runs without IMAP (fake connection): `python3 -m pytest test_mail_entwurf.py`
or `python3 test_mail_entwurf.py`.
"""

import email
import re

from routers import mail

ADDR = "nutzer@example.org"


class _FakeImap:
    """Just enough IMAP for _create_draft_sync: APPEND, SELECT, UID FETCH."""

    def __init__(self):
        self.raw = b""

    def list(self):
        return "OK", [b'(\\HasNoChildren) "/" "Drafts"']

    def append(self, box, flags, date, raw):
        self.raw = raw
        return "OK", [b"[APPENDUID 1 7] APPEND completed"]

    def select(self, box, readonly=False):
        return "OK", [b"1"]

    def uid(self, cmd, uid, *args):
        mid = email.message_from_bytes(self.raw)["Message-ID"]
        return "OK", [(b"7 (BODY[HEADER.FIELDS (MESSAGE-ID)]", f"Message-ID: {mid}\r\n".encode())]

    def logout(self):
        pass


def _entwurf(monkeypatch, **felder):
    fake = _FakeImap()
    monkeypatch.setattr(mail, "_imap_connect", lambda addr, pw: fake)
    monkeypatch.setattr(mail, "_drafts_box", lambda M: "Drafts")
    body = mail.CreateDraftIn(subject="Merkzettel", body="Text", **felder)
    out = mail._create_draft_sync(ADDR, "pw", body)
    return out, email.message_from_bytes(fake.raw)


def test_an_mich_selbst_setzt_eigene_adresse(monkeypatch):
    out, msg = _entwurf(monkeypatch, an_mich_selbst=True)
    assert msg["To"] == ADDR
    assert out["to"] == [ADDR] and out["ok"] is True


def test_leeres_to_ohne_flag_bleibt_ohne_empfaenger(monkeypatch):
    out, msg = _entwurf(monkeypatch)
    assert msg["To"] is None
    assert out["to"] == []


def test_flag_mit_weiteren_empfaengern_ohne_doppelte_eigene(monkeypatch):
    out, msg = _entwurf(monkeypatch, an_mich_selbst=True, to=["a@example.org", ADDR.upper()])
    assert out["to"] == [ADDR, "a@example.org"]
    assert re.sub(r"\s+", " ", msg["To"]) == f"{ADDR}, a@example.org"


def test_ohne_flag_bleibt_to_unveraendert(monkeypatch):
    out, _ = _entwurf(monkeypatch, to=["a@example.org"])
    assert out["to"] == ["a@example.org"]


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))

"""Last connected shell form per user (routers/actions.py), used by selkies_open.

`python3 -m pytest routers/test_actions_form.py`
"""
from routers import actions


def test_form_unknown_then_last_connect_wins(monkeypatch):
    monkeypatch.setattr(actions, "_letzte_form", {})
    assert actions.aktuelle_form("alice") is None
    actions._letzte_form["alice"] = "desktop"
    actions._letzte_form["alice"] = "mobile"
    assert actions.aktuelle_form("Alice") == "mobile"

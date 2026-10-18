"""Routines: schedule matching, the read list, and the turn marking the gateway relies on."""
import datetime as dt

from services import brain_turns, routinen


def _t(wochentag: int, h: int, m: int) -> dt.datetime:
    # 2026-10-05 is a Monday
    return dt.datetime(2026, 10, 5 + wochentag, h, m)


def test_faellig():
    r = {"rhythmus": "taeglich", "uhrzeit": "07:30"}
    assert routinen.faellig(r, _t(0, 7, 30)) and routinen.faellig(r, _t(6, 7, 30))
    assert not routinen.faellig(r, _t(0, 7, 31))
    w = {"rhythmus": "werktags", "uhrzeit": "07:00"}
    assert routinen.faellig(w, _t(4, 7, 0)) and not routinen.faellig(w, _t(5, 7, 0))
    wo = {"rhythmus": "woechentlich", "uhrzeit": "18:00", "wochentag": 2}
    assert routinen.faellig(wo, _t(2, 18, 0)) and not routinen.faellig(wo, _t(3, 18, 0))
    s = {"rhythmus": "stuendlich", "uhrzeit": "09:15"}
    assert routinen.faellig(s, _t(1, 3, 15)) and not routinen.faellig(s, _t(1, 3, 16))


def test_nur_bekannte_lesende_werkzeuge():
    assert routinen.ist_lesend("planner", "list_tasks")
    assert routinen.ist_lesend("mail", "get_message")
    # changing tools and anything nobody classified need approval
    for modul, werkzeug in (("planner", "create_task"), ("mail", "send_mail"),
                            ("mail", "delete_message"), ("nc-pim", "add_event"),
                            ("planner", "neues_werkzeug"), ("unbekannt", "list_x")):
        assert not routinen.ist_lesend(modul, werkzeug), (modul, werkzeug)


def test_markierung_kommt_von_der_zelle_und_endet():
    t = brain_turns.issue("anna", {"art": "routine", "lauf": "L1"})
    assert brain_turns.resolve(t) == "anna"
    assert brain_turns.meta(t) == {"art": "routine", "lauf": "L1"}
    m = brain_turns.meta(t)
    m["art"] = "chat"                       # a copy — the stored marking stays
    assert brain_turns.meta(t)["art"] == "routine"
    brain_turns.end(t)
    assert brain_turns.resolve(t) is None and brain_turns.meta(t) == {}
    chat = brain_turns.issue("anna")
    assert brain_turns.meta(chat) == {}
    assert brain_turns.meta("erfunden") == {}

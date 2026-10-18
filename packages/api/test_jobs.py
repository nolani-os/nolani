"""Job events -> status card (pure, no database)."""
from services import chat_lauf, jobs


def test_normalisieren_und_aliase():
    j = jobs.normalisieren({"type": "job.done", "id": "abc-1", "title": "Recherche",
                            "result_url": "https://example.org/x", "username": "Anna"})
    assert j == {"job_id": "abc-1", "status": "fertig", "titel": "Recherche", "chat_id": "",
                 "ergebnis_url": "https://example.org/x", "fehler": "", "user": "anna"}


def test_ungueltiges_wird_verworfen():
    assert jobs.normalisieren({"type": "job.done", "job_id": "a b"}) is None
    assert jobs.normalisieren({"type": "tool.end", "job_id": "x"}) is None
    j = jobs.normalisieren({"type": "job.done", "job_id": "x", "ergebnis_url": "javascript:alert(1)"})
    assert j["ergebnis_url"] == ""
    assert jobs.normalisieren({"type": "job.done", "job_id": "x", "url": "//evil.example"})["ergebnis_url"] == ""
    assert jobs.normalisieren({"type": "job.done", "job_id": "x", "url": "/?app=files"})["ergebnis_url"] == "/?app=files"


def test_gespeicherte_antwort_traegt_die_karte():
    a = chat_lauf.Antwort()
    a.apply_event({"type": "job.started", "job_id": "j1", "titel": "Video"})
    a.apply_event({"type": "job.done", "job_id": "j1", "ergebnis_url": "/?app=files"})
    msg = a.as_message()
    assert msg["blocks"] == [{"id": "job-j1", "kind": "job",
                              "props": {"job_id": "j1", "status": "fertig", "titel": "Video",
                                        "ergebnis_url": "/?app=files"}}]
    assert a.has_content()

"""Query-string credentials never reach the access log.

`python3 -m pytest test_log_redaction.py`
"""
import logging

from log_redaction import RedactQueryTokens


def test_access_log_args_are_masked():
    rec = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                            '%s - "%s %s HTTP/%s" %d',
                            ("192.0.2.1:5", "GET",
                             "/api/claraos/wopi/files/7/contents?access_token=GEHEIM&access_token_ttl=0",
                             "1.1", 200), None)
    RedactQueryTokens().filter(rec)
    zeile = rec.getMessage()
    assert "GEHEIM" not in zeile
    assert "access_token=***" in zeile and "access_token_ttl=0" in zeile

"""Keep credentials out of the request log."""
from __future__ import annotations

import logging
import re


class RedactQueryTokens(logging.Filter):
    """Mask credentials passed in query strings before uvicorn logs the request line.

    WOPI (Collabora) can only authenticate with `?access_token=…`, so every document
    request carried a working token into the access log — and from there into any
    log excerpt somebody copies.
    """

    _MUSTER = re.compile(r"((?:access_token|token|api_key|key)=)[^&\s\"]+", re.IGNORECASE)

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(self._MUSTER.sub(r"\1***", a) if isinstance(a, str) else a
                                for a in record.args)
        elif isinstance(record.msg, str):
            record.msg = self._MUSTER.sub(r"\1***", record.msg)
        return True

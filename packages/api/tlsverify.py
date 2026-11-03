"""Central TLS verification for the API's outgoing HTTPS calls.

Every httpx client in the API takes `verify=TLS_VERIFY` from here instead of a
literal "verify off". The default verifies against the system trust store;
an installation whose internal services use their own CA points
`CLARAOS_TLS_CA` at a PEM bundle (verification stays on, against that bundle),
and only a deliberate `CLARAOS_TLS_VERIFY=0` switches verification off
altogether — visible in the environment, never hidden in a call site.

    CLARAOS_TLS_VERIFY   1 (default) | 0
    CLARAOS_TLS_CA       path to a PEM bundle (implies verification on)
"""
from __future__ import annotations

import os

_OFF = {"0", "false", "no", "off"}


def _resolve() -> bool | str:
    ca = os.environ.get("CLARAOS_TLS_CA", "").strip()
    if ca:
        return ca
    raw = os.environ.get("CLARAOS_TLS_VERIFY", "").strip().lower()
    return raw not in _OFF if raw else True


# bool, or the path of the CA bundle — both are what httpx's `verify=` takes
TLS_VERIFY: bool | str = _resolve()


def tls_verify_enabled() -> bool:
    """True unless verification was switched off explicitly."""
    return TLS_VERIFY is not False


def tls_ca_path() -> str | None:
    """The CA bundle, if one is configured."""
    return TLS_VERIFY if isinstance(TLS_VERIFY, str) else None

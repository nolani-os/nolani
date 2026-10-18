"""Credential encryption using Fernet (AES-128-CBC with HMAC)."""

import json
import os
from cryptography.fernet import Fernet

# Key from environment variable. Generate once with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
_KEY = os.environ.get("CLARAOS_CREDENTIAL_KEY", "")
_fernet: Fernet | None = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        if not _KEY:
            raise ValueError("CLARAOS_CREDENTIAL_KEY environment variable not set")
        _fernet = Fernet(_KEY.encode() if isinstance(_KEY, str) else _KEY)
    return _fernet


def encrypt_credentials(data: dict) -> bytes:
    """Encrypt a dict of credentials to bytes."""
    return _get_fernet().encrypt(json.dumps(data).encode())


def decrypt_credentials(data: bytes) -> dict:
    """Decrypt bytes back to a dict of credentials."""
    return json.loads(_get_fernet().decrypt(data).decode())

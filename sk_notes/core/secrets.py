"""Small secrets of sk_notes (the password or token of Git sync).

Kept in the system keyring (Secret Service / KWallet). When no keyring service runs (a
minimal window manager), they go to a Fernet-encrypted file in the data directory, with
its key in a separate file readable by the user only; a warning is logged once. Never in
settings, never inside a vault.
"""

from __future__ import annotations

import json
import logging
import os
import threading

from ..app import config

log = logging.getLogger(__name__)
SERVICE = "sk_notes"
_lock = threading.Lock()
_warned = False


def _keyring():
    try:
        import keyring
        from keyring.backends import fail
    except ImportError:
        return None
    try:
        kr = keyring.get_keyring()
    except Exception:  # noqa: BLE001 - a broken backend counts as none
        return None
    if isinstance(kr, fail.Keyring) or getattr(kr, "priority", 1) <= 0:
        return None
    return keyring


def _fallback_paths():
    d = config.data_dir()
    return d / "secrets.bin", d / "secrets.key"


def _fernet():
    from cryptography.fernet import Fernet
    _, key_file = _fallback_paths()
    if not key_file.exists():
        key_file.write_bytes(Fernet.generate_key())
        os.chmod(key_file, 0o600)
    return Fernet(key_file.read_bytes().strip())


def _load() -> dict:
    data_file, _ = _fallback_paths()
    if not data_file.exists():
        return {}
    try:
        return json.loads(_fernet().decrypt(data_file.read_bytes()).decode("utf-8"))
    except Exception:  # noqa: BLE001 - unreadable: the user signs in again
        log.warning("stored secrets could not be read")
        return {}


def _store(values: dict) -> None:
    data_file, _ = _fallback_paths()
    tmp = data_file.with_suffix(".tmp")
    tmp.write_bytes(_fernet().encrypt(json.dumps(values).encode("utf-8")))
    os.chmod(tmp, 0o600)
    os.replace(tmp, data_file)


def _warn_once() -> None:
    global _warned
    if not _warned:
        _warned = True
        log.warning("no keyring service: secrets are kept in an encrypted file in %s", config.data_dir())


def set_secret(name: str, value: str) -> None:
    kr = _keyring()
    if kr is not None:
        try:
            kr.set_password(SERVICE, name, value)
            return
        except Exception:  # noqa: BLE001
            log.debug("keyring refused the secret", exc_info=True)
    _warn_once()
    with _lock:
        values = _load()
        values[name] = value
        _store(values)


def get_secret(name: str) -> str | None:
    kr = _keyring()
    if kr is not None:
        try:
            v = kr.get_password(SERVICE, name)
            if v is not None:
                return v
        except Exception:  # noqa: BLE001
            log.debug("keyring could not be read", exc_info=True)
    with _lock:
        return _load().get(name)


def delete_secret(name: str) -> None:
    kr = _keyring()
    if kr is not None:
        try:
            kr.delete_password(SERVICE, name)
        except Exception:  # noqa: BLE001 - not there
            pass
    with _lock:
        values = _load()
        if values.pop(name, None) is not None:
            _store(values)

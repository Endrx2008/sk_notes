"""Interface to the shared memory of SKAI (the SKAI_ Memory vault, library skai_memory).

sk_notes talks to it only through this interface. Without the vault it stores nothing.

A backend must implement:
    available() -> bool
    remember(kind: str, text: str, source: str, meta: dict) -> None
    recall(query: str, k: int) -> list[dict]   # {"text", "source", "score"}
    forget(source: str) -> None
"""

from __future__ import annotations

import logging
import sys
from typing import Protocol

log = logging.getLogger(__name__)


class SharedMemory(Protocol):
    def available(self) -> bool: ...
    def remember(self, kind: str, text: str, source: str, meta: dict) -> None: ...
    def recall(self, query: str, k: int = 5) -> list[dict]: ...
    def forget(self, source: str) -> None: ...


class NullMemory:
    """No shared memory: everything is a no-op."""

    def available(self) -> bool:
        return False

    def remember(self, kind: str, text: str, source: str, meta: dict) -> None:
        return None

    def recall(self, query: str, k: int = 5) -> list[dict]:
        return []

    def forget(self, source: str) -> None:
        return None


class VaultMemory:
    """SKAI_ Memory: the shared Markdown vault (see skai_memory). Reading is plain file reading;
    writing goes through the privileged helper and is skipped (logged) when this user may not."""

    APP = "sk_notes"

    def __init__(self, lib):
        self.mem = lib.Memory(self.APP)
        self._warned = False

    def available(self) -> bool:
        return self.mem.available()

    def remember(self, kind: str, text: str, source: str, meta: dict) -> None:
        links = [l for l in (meta or {}).get("links", []) if l]
        try:
            self.mem.remember((meta or {}).get("chat") or kind, text, links=links)
        except Exception as exc:  # noqa: BLE001 - memory must never break the chat
            if not self._warned:
                log.warning("SKAI memory not written: %s", exc)
                self._warned = True

    def recall(self, query: str, k: int = 5) -> list[dict]:
        try:
            hits = self.mem.search(query, hops=1, limit=k)
        except Exception as exc:  # noqa: BLE001
            log.info("SKAI memory unavailable: %s", exc)
            return []
        out = []
        for h in hits[:k]:
            ext = f" Links: {', '.join(h['external'][:5])}" if h["external"] else ""
            out.append({"text": f"[{h['title']}] ({h['path']}) {h['snippet']}{ext}", "source": h["path"], "score": h["score"]})
        return out

    def forget(self, source: str) -> None:
        return None


def _load_lib():
    try:
        import skai_memory
        return skai_memory
    except ImportError:
        sys.path.append("/usr/lib/skai")
        try:
            import skai_memory
            return skai_memory
        except ImportError:
            return None


def get_memory() -> SharedMemory:
    """The shared SKAI_ Memory vault when it exists on this machine, otherwise a no-op."""
    lib = _load_lib()
    if lib is not None:
        mem = VaultMemory(lib)
        if mem.available():
            return mem
    return NullMemory()

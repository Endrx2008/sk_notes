"""Interface to the future shared memory of SKAI.

SKAI does not provide a shared memory service yet. sk_notes talks to it only through
this interface, so a real backend can be plugged in later without touching the rest
of the app. The default implementation stores nothing.

A backend must implement:
    available() -> bool
    remember(kind: str, text: str, source: str, meta: dict) -> None
    recall(query: str, k: int) -> list[dict]   # {"text", "source", "score"}
    forget(source: str) -> None
"""

from __future__ import annotations

from typing import Protocol


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


def get_memory() -> SharedMemory:
    """Hook for a future SKAI memory service (e.g. a local socket under ~/.config/skai)."""
    return NullMemory()

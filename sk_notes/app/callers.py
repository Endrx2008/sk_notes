"""Who is calling the skn:// API: the app page or a community plugin.

Plugins run in the page's JavaScript context, so a plugin id sent by the page proves
nothing. Instead every plugin gets a random token that only its own Node/Obsidian shims
hold (in closures), sent as the ``c=`` URL parameter:

1. Python gives each page it opens a one-time *boot secret*, injected before any page
   script runs (see application.Page). Pages opened by ``window.open()`` get none.
2. Before loading plugins, the plugin manager trades the boot secret, once, for one
   token per installed plugin plus a private *page key*.
3. The page key gets tokens for plugins installed later, one per plugin and page.

A call without a known token is the app itself; it can do what the app's UI can do
inside the vault, but never run programs, reach outside the vault or the network for a
plugin, or change permissions without a native confirmation (see plugins/permissions).
"""

from __future__ import annotations

import secrets
import threading


class Callers:
    def __init__(self):
        self._lock = threading.Lock()
        self._boot: dict[str, str] = {}  # boot secret -> page id
        self._pages: dict[str, dict] = {}  # page id -> {"key": str|None, "ids": {plugin: token}}
        self._tokens: dict[str, str] = {}  # token -> plugin id

    def new_page(self, page_id: str) -> str:
        """A page (re)starts loading: forget what it had and give it a new boot secret."""
        with self._lock:
            self._drop(page_id)
            boot = secrets.token_urlsafe(24)
            self._boot[boot] = page_id
            self._pages[page_id] = {"key": None, "ids": {}}
            return boot

    def drop_page(self, page_id: str) -> None:
        with self._lock:
            self._drop(page_id)

    def _drop(self, page_id: str) -> None:
        for b, p in list(self._boot.items()):
            if p == page_id:
                del self._boot[b]
        page = self._pages.pop(page_id, None)
        if page:
            for tok in page["ids"].values():
                self._tokens.pop(tok, None)

    def exchange(self, boot: str, plugin_ids: list[str]) -> dict | None:
        """Boot secret -> page key and tokens; works once per page load."""
        with self._lock:
            page_id = self._boot.pop(boot or "", None)
            if page_id is None:
                return None
            page = self._pages[page_id]
            page["key"] = secrets.token_urlsafe(24)
            tokens = {pid: self._issue(page, pid) for pid in plugin_ids}
            return {"key": page["key"], "tokens": tokens}

    def token(self, key: str, plugin_id: str) -> str | None:
        """Token for a plugin installed after the exchange; one per plugin and page."""
        with self._lock:
            page = next((p for p in self._pages.values() if key and p["key"] == key), None)
            if page is None or plugin_id in page["ids"]:
                return None
            return self._issue(page, plugin_id)

    def _issue(self, page: dict, plugin_id: str) -> str:
        tok = secrets.token_urlsafe(24)
        page["ids"][plugin_id] = tok
        self._tokens[tok] = plugin_id
        return tok

    def plugin_for(self, token: str | None) -> str | None:
        if not token:
            return None
        with self._lock:
            return self._tokens.get(token)

"""Who is calling the skn:// API: the app, a community plugin, or nobody.

Plugins and notes share the page's JavaScript context and DOM, so neither a plugin id nor
"being the page" proves anything: a note's rendered HTML can load skn://api/... through
<img>, <iframe> or a form (B3-1). Every API call must therefore carry a secret:

1. Python gives each page it opens a one-time *boot secret*, injected before any page
   script runs (see application.Page). Pages opened by ``window.open()`` get none.
2. core/api.js trades it once (``app.auth``) for the page's *app key* and keeps it in a
   module-private variable. App calls carry it as ``a=``.
3. The plugin manager asks (with the app key) for one *token* per enabled, trusted plugin;
   only that plugin's own shims hold it (``c=``). Plugin calls get that plugin's rights.

A call with neither a valid app key nor a valid token is refused.
"""

from __future__ import annotations

import secrets
import threading


class Callers:
    def __init__(self):
        self._lock = threading.Lock()
        self._boot: dict[str, str] = {}  # boot secret -> page id
        self._apps: dict[str, str] = {}  # app key -> page id
        self._pages: dict[str, dict] = {}  # page id -> {"app": key|None, "ids": {plugin: token}}
        self._tokens: dict[str, str] = {}  # plugin token -> plugin id

    def new_page(self, page_id: str) -> str:
        """A page (re)starts loading: forget what it had and give it a new boot secret."""
        with self._lock:
            self._drop(page_id)
            boot = secrets.token_urlsafe(24)
            self._boot[boot] = page_id
            self._pages[page_id] = {"app": None, "ids": {}}
            return boot

    def drop_page(self, page_id: str) -> None:
        with self._lock:
            self._drop(page_id)

    def _drop(self, page_id: str) -> None:
        for table in (self._boot, self._apps):
            for k, p in list(table.items()):
                if p == page_id:
                    del table[k]
        page = self._pages.pop(page_id, None)
        if page:
            for tok in page["ids"].values():
                self._tokens.pop(tok, None)

    def auth(self, boot: str) -> str | None:
        """Boot secret -> app key; works once per page load."""
        with self._lock:
            page_id = self._boot.pop(boot or "", None)
            if page_id is None:
                return None
            key = secrets.token_urlsafe(24)
            self._apps[key] = page_id
            self._pages[page_id]["app"] = key
            return key

    def is_app(self, key: str | None) -> bool:
        with self._lock:
            return bool(key) and key in self._apps

    def issue(self, app_key: str, plugin_id: str) -> str | None:
        """Token for a plugin, one per plugin and page (the app key must be valid)."""
        with self._lock:
            page_id = self._apps.get(app_key or "")
            page = self._pages.get(page_id) if page_id else None
            if page is None or plugin_id in page["ids"]:
                return None
            tok = secrets.token_urlsafe(24)
            page["ids"][plugin_id] = tok
            self._tokens[tok] = plugin_id
            return tok

    def plugin_for(self, token: str | None) -> str | None:
        if not token:
            return None
        with self._lock:
            return self._tokens.get(token)

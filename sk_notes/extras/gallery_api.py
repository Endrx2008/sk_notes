"""Community directories in the desktop app: themes, plugins, note templates.

Same API as sk_notes for Android (themes.*, plugins.catalog / plugins.checkUpdates,
templates.*): the lists come from the public directories on GitHub and are cached for a
day; templates also come with sk_notes (community/templates) for use without a network.
Downloads are made here, by Python: the page itself stays offline.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from ..app import config
from ..app.bridge import ApiError

log = logging.getLogger(__name__)
TEMPLATES_URL = "https://raw.githubusercontent.com/Endrx2008/sk_notes/main/community/templates/"
_HERE = Path(__file__).resolve().parent.parent
TEMPLATES_LOCAL = next((p for p in (_HERE / "web" / "dist" / "community" / "templates", _HERE.parent / "community" / "templates")
                        if (p / "index.json").exists()), _HERE.parent / "community" / "templates")
THEMES_URL = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-css-themes.json"
PLUGINS_URL = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugins.json"
STATS_URL = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugin-stats.json"
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,60}$", re.I)
FILE_RE = re.compile(r"^[A-Za-z0-9_-]+(/[A-Za-z0-9 _.-]+)*\.md$")
BAD_NAME = re.compile(r'[\\/:*?"<>|\x00]')
MAX_TEMPLATE = 512 * 1024
MAX_THEME = 8 * 1024 * 1024
MAX_LIST = 16 * 1024 * 1024
MAX_AGE = 24 * 3600


def fetch(url: str, *, timeout: int = 30, max_bytes: int = MAX_THEME) -> bytes | None:
    """Bytes of an address; None for 404."""
    req = urllib.request.Request(url, headers={"User-Agent": "sk_notes"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 - fixed https addresses
            data = res.read(max_bytes + 1)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise ApiError("download-failed", f"HTTP {exc.code}") from exc
    except (urllib.error.URLError, OSError) as exc:
        raise ApiError("download-failed", str(getattr(exc, "reason", exc))) from exc
    if len(data) > max_bytes:
        raise ApiError("too-large", url)
    return data


def _ok_name(name: str) -> bool:
    return bool(name) and not BAD_NAME.search(name) and name not in (".", "..") and not name.startswith(".") and len(name.encode()) <= 255


def _cached(name: str, refresh: bool, load):
    """A list kept in the cache folder for a day; an old copy is used when offline."""
    path = config.cache_dir() / name
    cached = None
    try:
        cached = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cached = None
    if cached and not refresh and time.time() - cached.get("ts", 0) < MAX_AGE:
        return cached["items"], False
    try:
        items = load()
    except ApiError:
        if cached:
            return cached["items"], True
        raise
    try:
        path.write_text(json.dumps({"ts": time.time(), "items": items}), encoding="utf-8")
    except OSError:
        pass
    return items, False


def clean_templates(data) -> list:
    out = []
    for x in (data or {}).get("templates", []) if isinstance(data, dict) else []:
        if not isinstance(x, dict) or not ID_RE.match(str(x.get("id", ""))) or not FILE_RE.match(str(x.get("file", ""))) or ".." in str(x.get("file")).split("/"):
            continue
        name = str(x.get("name", "")).strip()[:80]
        if not _ok_name(name):
            continue
        out.append({"id": x["id"], "name": name, "description": str(x.get("description", ""))[:300], "lang": str(x.get("lang", "en"))[:8],
                    "file": x["file"], "author": str(x.get("author", ""))[:80]})
    return out


def register(app) -> None:
    r = app.api.route
    memo: dict = {}

    def svc():
        if app.service is None:
            raise ApiError("no-vault")
        return app.service

    def app_only(fn):
        def run(p, ctx):
            if ctx.plugin:
                raise ApiError("permission-denied")
            return fn(p)
        return run

    # ------------------------------------------------------------- templates
    def template_list(refresh: bool) -> tuple[list, bool]:
        if "templates" in memo and not refresh:
            return memo["templates"]
        items, online = None, False
        try:
            data = fetch(TEMPLATES_URL + "index.json", timeout=8, max_bytes=MAX_TEMPLATE)
            if data:
                items = clean_templates(json.loads(data.decode("utf-8")))
                online = bool(items)
        except (ApiError, ValueError):
            items = None
        if not items:
            try:
                items = clean_templates(json.loads((TEMPLATES_LOCAL / "index.json").read_text(encoding="utf-8")))
            except (OSError, ValueError):
                items = []
        memo["templates"] = (items, online)
        return memo["templates"]

    @r("templates.catalog", slow=True)
    @app_only
    def templates_catalog(p):
        items, online = template_list(bool(p.get("refresh")))
        return {"templates": items, "online": online}

    @r("templates.install", slow=True)
    @app_only
    def templates_install(p):
        items, online = template_list(False)
        item = next((x for x in items if x["id"] == p.get("id")), None)
        if not item:
            raise ApiError("not-found", str(p.get("id")))
        text = None
        if online:
            try:
                data = fetch(TEMPLATES_URL + "/".join(urllib.parse.quote(x) for x in item["file"].split("/")), timeout=15, max_bytes=MAX_TEMPLATE)
                text = data.decode("utf-8") if data else None
            except (ApiError, UnicodeDecodeError):
                text = None
        if text is None:
            try:
                text = (TEMPLATES_LOCAL / item["file"]).read_text(encoding="utf-8")
            except OSError as exc:
                raise ApiError("not-found", item["file"]) from exc
        folder = str(p.get("folder") or "Templates").strip("/")
        if not folder or any(x in ("..", "") or x.startswith(".") for x in folder.split("/")):
            raise ApiError("bad-path", folder)
        s = svc()
        path = f"{folder}/{item['name']}.md"
        if s.vault.exists(path):
            return {"path": path, "existed": True}
        if not s.vault.exists(folder):
            s.mkdir(folder)
        s.write(path, text)
        return {"path": path, "existed": False}

    # ------------------------------------------------------------- themes
    def load_themes() -> list:
        data = fetch(THEMES_URL, max_bytes=MAX_LIST)
        lst = json.loads((data or b"[]").decode("utf-8"))
        if not isinstance(lst, list):
            raise ApiError("download-failed", "list")
        out, seen = [], set()
        for x in lst:
            if not isinstance(x, dict) or not REPO_RE.match(str(x.get("repo", ""))):
                continue
            name = str(x.get("name", "")).strip()[:80]
            if not _ok_name(name) or name.lower() in seen:
                continue
            seen.add(name.lower())
            out.append({"name": name, "author": str(x.get("author", ""))[:80], "repo": x["repo"],
                        "modes": [m for m in (x.get("modes") or []) if m in ("dark", "light")], "legacy": bool(x.get("legacy"))})
        out.sort(key=lambda t: t["name"].lower())
        return out

    @r("themes.catalog", slow=True)
    @app_only
    def themes_catalog(p):
        items, stale = _cached("community-themes.json", bool(p.get("refresh")), load_themes)
        return {"themes": items, **({"stale": True} if stale else {})}

    @r("themes.install", slow=True)
    @app_only
    def themes_install(p):
        items, _ = _cached("community-themes.json", False, load_themes)
        theme = next((t for t in items if t["name"] == p.get("name")), None)
        if not theme:
            raise ApiError("not-found", str(p.get("name")))
        base = f"https://raw.githubusercontent.com/{theme['repo']}/HEAD/"
        css = fetch(base + "theme.css") or fetch(base + "obsidian.css")  # first-generation themes
        if css is None:
            raise ApiError("download-failed", "theme.css")
        d = Path(svc().vault.config_dir) / "themes" / theme["name"]
        d.mkdir(parents=True, exist_ok=True)
        (d / "theme.css").write_bytes(css)
        (d / "manifest.json").write_text(json.dumps({"name": theme["name"], "author": theme["author"], "repo": theme["repo"]}, indent=2), encoding="utf-8")
        return {"name": theme["name"]}

    @r("themes.remove")
    @app_only
    def themes_remove(p):
        name = str(p.get("name", ""))
        if not _ok_name(name):
            raise ApiError("bad-name", name)
        d = Path(svc().vault.config_dir) / "themes" / name
        if not (d / "theme.css").exists():
            return False
        shutil.rmtree(d, ignore_errors=True)
        return True

    # ------------------------------------------------------------- plugins
    def load_plugins() -> list:
        lst = json.loads((fetch(PLUGINS_URL, max_bytes=MAX_LIST) or b"[]").decode("utf-8"))
        if not isinstance(lst, list):
            raise ApiError("download-failed", "list")
        try:
            stats = json.loads((fetch(STATS_URL, max_bytes=MAX_LIST) or b"{}").decode("utf-8")) or {}
        except (ApiError, ValueError):
            stats = {}  # the counts are optional
        out = []
        for x in lst:
            if not isinstance(x, dict) or not ID_RE.match(str(x.get("id", ""))) or not REPO_RE.match(str(x.get("repo", ""))):
                continue
            st = stats.get(x["id"]) or {}
            out.append({"id": x["id"], "name": str(x.get("name") or x["id"])[:120], "author": str(x.get("author", ""))[:120],
                        "description": str(x.get("description", ""))[:400], "repo": x["repo"],
                        "downloads": int(st.get("downloads") or 0), "updated": int(st.get("updated") or 0)})
        out.sort(key=lambda x: (-x["downloads"], x["name"]))
        return out

    @r("plugins.catalog", slow=True)
    @app_only
    def plugins_catalog(p):
        items, stale = _cached("community-plugins.json", bool(p.get("refresh")), load_plugins)
        return {"plugins": items, "cached": True, **({"stale": True} if stale else {})}

    @r("plugins.checkUpdates", slow=True)
    @app_only
    def plugins_check_updates(p):
        items, _ = _cached("community-plugins.json", False, load_plugins)
        by_id = {x["id"]: x for x in items}
        out = []
        pdir = Path(svc().vault.config_dir) / "plugins"
        for d in sorted(pdir.iterdir()) if pdir.is_dir() else []:
            entry = by_id.get(d.name)
            try:
                m = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not entry:
                continue
            try:
                latest = json.loads((fetch(f"https://github.com/{entry['repo']}/releases/latest/download/manifest.json", timeout=20) or b"{}").decode("utf-8"))
            except (ApiError, ValueError):
                continue
            if latest.get("version") and latest["version"] != m.get("version"):
                out.append({"id": d.name, "name": m.get("name") or d.name, "repo": entry["repo"], "installed": m.get("version", ""), "latest": latest["version"]})
        return out

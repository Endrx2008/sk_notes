"""Coming from another Markdown app: read (never write) the vault's ".obsidian"
settings folder and offer to import settings, hotkeys, CSS and plugins into
".sk_notes". The original files and folders are opened read-only and left untouched."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

SOURCE_DIR = ".obsidian"  # folder name used by vaults made with that app

# settings that map 1:1 (names in its app.json → sk_notes app.json)
APP_KEYS = {
    "alwaysUpdateLinks": "alwaysUpdateLinks", "newFileLocation": "newFileLocation", "newFileFolderPath": "newFileFolderPath",
    "attachmentFolderPath": "attachmentFolderPath", "useMarkdownLinks": "useMarkdownLinks", "readableLineLength": "readableLineLength",
    "showInlineTitle": "showInlineTitle", "spellcheck": "spellcheck", "livePreview": "livePreview", "defaultViewMode": "defaultViewMode",
    "tabSize": "tabSize", "promptDelete": "promptDelete", "trashOption": "trashOption", "foldHeading": "foldGutter",
    "autoPairBrackets": "autoPair", "propertiesInDocument": "propertiesInDocument",
}
APPEARANCE_KEYS = {"baseFontSize": "baseFontSize", "textFontFamily": "textFont", "monospaceFontFamily": "monospaceFont",
                   "cssTheme": "cssTheme", "enabledCssSnippets": "enabledCssSnippets", "showRibbon": "showRibbon"}
# hotkey command ids that differ
COMMAND_IDS = {"app:open-help": None, "app:reload": None, "workspace:toggle-pin": "workspace:toggle-pin"}


def _read_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def scan(vault_root: Path) -> dict:
    src = vault_root / SOURCE_DIR
    if not src.is_dir():
        return {"found": False}
    out: dict = {"found": True, "items": []}
    app = _read_json(src / "app.json") or {}
    appearance = _read_json(src / "appearance.json") or {}
    settings = {APP_KEYS[k]: v for k, v in app.items() if k in APP_KEYS}
    if app.get("trashOption") == "none":
        settings["trashOption"] = "none"
    settings.update({APPEARANCE_KEYS[k]: v for k, v in appearance.items() if k in APPEARANCE_KEYS})
    if appearance.get("theme") in ("obsidian", "moonstone"):
        settings["theme"] = "dark" if appearance["theme"] == "obsidian" else "light"
    for name, keymap in (("daily-notes.json", {"folder": "dailyNoteFolder", "format": "dailyNoteFormat", "template": "dailyNoteTemplate"}),
                         ("templates.json", {"folder": "templatesFolder", "dateFormat": "templateDateFormat", "timeFormat": "templateTimeFormat"}),
                         ("zk-prefixer.json", {"format": "uniqueNotePrefix", "folder": "uniqueNoteFolder"})):
        data = _read_json(src / name) or {}
        settings.update({v: data[k] for k, v in keymap.items() if data.get(k)})
    if settings:
        out["items"].append({"id": "settings", "count": len(settings), "data": settings})
    hotkeys = _read_json(src / "hotkeys.json") or {}
    if hotkeys:
        mapped = {}
        for cmd, keys in hotkeys.items():
            target = COMMAND_IDS.get(cmd, cmd)
            if target and isinstance(keys, list):
                mapped[target] = [{"modifiers": k.get("modifiers", []), "key": k.get("key", "")} for k in keys if isinstance(k, dict)]
        out["items"].append({"id": "hotkeys", "count": len(mapped), "data": mapped})
    snippets = sorted(p.name for p in (src / "snippets").glob("*.css")) if (src / "snippets").is_dir() else []
    if snippets:
        out["items"].append({"id": "snippets", "count": len(snippets), "data": snippets})
    themes = sorted(p.name for p in (src / "themes").iterdir() if (p / "theme.css").exists()) if (src / "themes").is_dir() else []
    if themes:
        out["items"].append({"id": "themes", "count": len(themes), "data": themes})
    plugins = []
    enabled = _read_json(src / "community-plugins.json") or []
    if (src / "plugins").is_dir():
        for d in sorted((src / "plugins").iterdir()):
            m = _read_json(d / "manifest.json")
            if m and (d / "main.js").exists():
                plugins.append({"dir": d.name, "id": m.get("id"), "name": m.get("name"), "enabled": d.name in enabled or m.get("id") in enabled,
                                "desktopOnly": bool(m.get("isDesktopOnly"))})
    if plugins:
        out["items"].append({"id": "plugins", "count": len(plugins), "data": plugins})
    bookmarks = _read_json(src / "bookmarks.json")
    if bookmarks and bookmarks.get("items"):
        out["items"].append({"id": "bookmarks", "count": len(bookmarks["items"]), "data": bookmarks})
    graph = _read_json(src / "graph.json")
    if graph:
        out["items"].append({"id": "graph", "count": 1, "data": _graph_options(graph)})
    return out


def _graph_options(g: dict) -> dict:
    o = {"search": g.get("search", ""), "showTags": g.get("showTags", False), "showAttachments": g.get("showAttachments", False),
         "hideUnresolved": g.get("hideUnresolved", True), "showOrphans": g.get("showOrphans", True), "showArrow": g.get("showArrow", False),
         "textFadeMultiplier": g.get("textFadeMultiplier", 0), "nodeSizeMultiplier": g.get("nodeSizeMultiplier", 1),
         "lineSizeMultiplier": g.get("lineSizeMultiplier", 1), "centerStrength": g.get("centerStrength", 0.5),
         "repelStrength": g.get("repelStrength", 10), "linkStrength": g.get("linkStrength", 1), "linkDistance": g.get("linkDistance", 250)}
    groups = []
    for grp in g.get("colorGroups", []):
        rgb = (grp.get("color") or {}).get("rgb")
        if isinstance(rgb, int):
            groups.append({"query": grp.get("query", ""), "color": f"#{rgb:06x}"})
    o["colorGroups"] = groups
    return o


def apply(service, item_ids: list[str]) -> dict:
    """Copy the chosen items into .sk_notes. Reads from the source folder only."""
    root = service.vault.root
    src = root / SOURCE_DIR
    found = {i["id"]: i for i in scan(root).get("items", [])}
    dest = service.vault.config_dir
    done = {}
    for item_id in item_ids:
        item = found.get(item_id)
        if not item:
            continue
        if item_id == "settings":
            appearance_keys = set(APPEARANCE_KEYS.values()) | {"theme"}
            app_cfg = service.config_read("app.json", {}) or {}
            app_look = service.config_read("appearance.json", {}) or {}
            for k, v in item["data"].items():
                (app_look if k in appearance_keys else app_cfg)[k] = v
            service.config_write("app.json", app_cfg)
            service.config_write("appearance.json", app_look)
        elif item_id == "hotkeys":
            cur = service.config_read("hotkeys.json", {}) or {}
            cur.update(item["data"])
            service.config_write("hotkeys.json", cur)
        elif item_id == "snippets":
            (dest / "snippets").mkdir(exist_ok=True)
            for name in item["data"]:
                shutil.copy2(src / "snippets" / name, dest / "snippets" / name)
        elif item_id == "themes":
            (dest / "themes").mkdir(exist_ok=True)
            for name in item["data"]:
                shutil.copytree(src / "themes" / name, dest / "themes" / name, dirs_exist_ok=True)
        elif item_id == "plugins":
            (dest / "plugins").mkdir(exist_ok=True)
            enabled = list(service.config_read("community-plugins.json", []) or [])
            for p in item["data"]:
                target = dest / "plugins" / p["dir"]
                shutil.copytree(src / "plugins" / p["dir"], target, dirs_exist_ok=True)
                if p["enabled"] and p["dir"] not in enabled:
                    enabled.append(p["dir"])
            service.config_write("community-plugins.json", enabled)
        elif item_id == "bookmarks":
            service.config_write("bookmarks.json", item["data"])
        elif item_id == "graph":
            service.config_write("graph.json", item["data"])
        done[item_id] = item["count"]
    return done

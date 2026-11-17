#!/usr/bin/env python3
"""List translation keys used in sk_notes/web/src (t('key'), tn('key', n)) and
optionally check a locale file for missing/unused keys.

Usage: tools/i18n_keys.py [--check sk_notes/locales/en.json]"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "sk_notes" / "web" / "src"
KEY_RE = re.compile(r"""\b(t|tn|tr)\(\s*(['"`])([a-z0-9][a-z0-9._-]*)\2""")
LITERAL_RE = re.compile(r"""['"]([a-z]+\.[a-z0-9][a-z0-9.-]*)['"]""")
# keys built at run time with template strings: list their possible values here
DYNAMIC = {
    "explorer.sort.": ["alphabetical", "alphabeticalReverse", "byModifiedTime", "byModifiedTimeReverse", "byCreatedTime", "byCreatedTimeReverse"],
    "history.reason.": ["edit", "delete", "rename", "external", "restore", "link-update", "manual", "skai"],
    "properties.type.": ["text", "multitext", "number", "checkbox", "date", "datetime", "tags", "aliases"],
    "skai.status.": ["unknown", "online", "offline", "thinking", "disabled"],
    "skai.error.": ["unreachable", "no_model", "model_missing", "timeout", "interrupted", "server", "empty", "invalid", "cancelled", "disabled", "bug"],
    "skai.style.": ["clearer", "shorter", "longer", "formal", "friendly", "bullets"],
    "import.format.": ["markdown", "enex", "notion", "html", "textbundle", "logseq", "roam", "keep", "csv"],
    "import.hint.": ["markdown", "enex", "notion", "html", "textbundle", "logseq", "roam", "keep", "csv"],
    "migration.item.": ["settings", "hotkeys", "snippets", "themes", "plugins", "bookmarks", "graph"],
    "perm.": ["title", "question", "warning", "once", "always", "deny", "fs-outside-vault", "exec", "network", "open-external", "clipboard"],
}
# API method names (Python routes) and base-property ids are not translation keys
ROUTE_RE = re.compile(r"""(?:route|r|guard)\(\s*["']([a-zA-Z.]+)["']""")  # guard(): routes of extras/sync_api.py
NOT_KEYS_RE = re.compile(r"^(file\.(name|path|ext|size|ctime|mtime|tags|folder|links|backlinks|basename|properties)|graph\.png)$")


def used_keys() -> set[str]:
    keys: set[str] = set()
    namespaces: list[str] = []
    for f in SRC.rglob("*.js"):
        text = f.read_text(encoding="utf-8")
        for fn, _q, key in KEY_RE.findall(text):
            if fn == "tn":
                keys.update({f"{key}.one", f"{key}.other"})
            elif not key.endswith("."):
                keys.add(key)
        namespaces.append(text)
    routes = set()
    for f in (ROOT / "sk_notes").rglob("*.py"):
        routes.update(ROUTE_RE.findall(f.read_text(encoding="utf-8")))
    first = {k.split(".")[0] for k in keys}
    for text in namespaces:
        for lit in LITERAL_RE.findall(text):
            if lit.split(".")[0] in first and not lit.endswith((".js", ".md", ".json", ".css")) \
                    and lit not in routes and not NOT_KEYS_RE.match(lit):
                keys.add(lit)
    # plural bases (tn) are not keys themselves
    plural = {k.rsplit(".", 1)[0] for k in keys if k.endswith(".other")}
    keys -= plural
    for prefix, values in DYNAMIC.items():
        keys.update(prefix + v for v in values)
    return keys


def main() -> int:
    keys = used_keys()
    if len(sys.argv) > 2 and sys.argv[1] == "--check":
        data = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
        missing = sorted(k for k in keys if k not in data)
        for k in missing:
            print("missing", k)
        return 1 if missing else 0
    for k in sorted(keys):
        print(k)
    return 0


if __name__ == "__main__":
    sys.exit(main())

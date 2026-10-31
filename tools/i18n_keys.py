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
}


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
    first = {k.split(".")[0] for k in keys}
    for text in namespaces:
        for lit in LITERAL_RE.findall(text):
            if lit.split(".")[0] in first and not lit.endswith((".js", ".md", ".json", ".css")):
                keys.add(lit)
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

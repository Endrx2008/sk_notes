"""Translations: one JSON file per language in sk_notes/locales/ (flat "key": "text").

English is the base; a missing key in another language falls back to English.
Adding a language = adding one file (``<code>.json`` with a ``_meta`` entry)."""

from __future__ import annotations

import json
import locale
import os
from functools import lru_cache
from pathlib import Path

LOCALES_DIR = Path(__file__).resolve().parent.parent / "locales"
BASE = "en"


@lru_cache(maxsize=None)
def load(lang: str) -> dict:
    path = LOCALES_DIR / f"{lang}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def available() -> list[dict]:
    out = []
    for f in sorted(LOCALES_DIR.glob("*.json")):
        meta = load(f.stem).get("_meta", {})
        out.append({"code": f.stem, "name": meta.get("name", f.stem), "review": bool(meta.get("needsReview"))})
    return out


def system_language() -> str:
    codes = {item["code"] for item in available()}
    candidates = [os.environ.get(v, "") for v in ("LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG")]
    try:
        candidates.append(locale.getlocale()[0] or "")
    except ValueError:
        pass
    for raw in candidates:
        for part in raw.split(":"):
            tag = part.split(".")[0].replace("_", "-")
            if not tag or tag in ("C", "POSIX"):
                continue
            if tag in codes:
                return tag
            if tag.lower().startswith("zh"):
                return "zh-CN" if "zh-CN" in codes else BASE
            short = tag.split("-")[0].lower()
            if short in codes:
                return short
    return BASE


def strings(lang: str) -> dict:
    """Merged dictionary (base + language) used by the UI."""
    merged = dict(load(BASE))
    if lang != BASE:
        merged.update({k: v for k, v in load(lang).items() if isinstance(v, str) and v})
    merged.pop("_meta", None)
    return merged

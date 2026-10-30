"""Link text generation and link rewriting after renames/moves."""

from __future__ import annotations

import posixpath
import re
from urllib.parse import quote

from . import parser
from .index import VaultIndex, basename_no_ext, ext_of


def utf16_to_index(text: str, offset16: int) -> int:
    """Convert a UTF-16 offset (as stored in metadata) into a Python str index."""
    if offset16 <= 0:
        return 0
    if all(ord(c) <= 0xFFFF for c in text[:offset16]):
        return offset16
    units = 0
    for i, c in enumerate(text):
        if units >= offset16:
            return i
        units += 2 if ord(c) > 0xFFFF else 1
    return len(text)


def linkpath_for(index: VaultIndex, target: str, source: str, *, prefer_full: bool = False) -> str:
    """Shortest link path that resolves to ``target`` from ``source``."""
    no_ext = target[:-3] if ext_of(target) == "md" else target
    if not prefer_full:
        short = basename_no_ext(target) if ext_of(target) == "md" else target.rsplit("/", 1)[-1]
        if index.resolve(short, source) == target:
            return short
    return no_ext


def markdown_url_for(target: str, source: str, *, relative: bool) -> str:
    if relative:
        folder = posixpath.dirname(source)
        path = posixpath.relpath(target, folder or ".")
    else:
        path = target
    return quote(path, safe="/#^")


def generate_markdown_link(index: VaultIndex, target: str, source: str, subpath: str = "",
                           alias: str = "", *, wikilinks: bool = True) -> str:
    """What "insert link" produces (wikilink by default, like the reference app)."""
    if wikilinks:
        lp = linkpath_for(index, target, source)
        inner = lp + subpath
        if alias and alias != lp:
            inner += "|" + alias
        prefix = "!" if ext_of(target) not in ("md", "") and ext_of(target) in IMAGE_EXT else ""
        return f"{prefix}[[{inner}]]"
    text = alias or basename_no_ext(target)
    return f"[{text}]({markdown_url_for(target, source, relative=False)}{quote(subpath, safe='#^')})"


IMAGE_EXT = {"png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif"}
WIKI_INNER_RE = re.compile(r"^(!?)\[\[([^\]|]*)(\|[^\]]*)?\]\]$")
MD_RE = re.compile(r"^(!?)\[(.*)\]\(\s*(<[^>]*>|[^\s)]*)(\s+[\"'][^\"']*[\"'])?\s*\)$", re.S)


def rewrite_reference(original: str, new_target: str, index: VaultIndex, source: str) -> str | None:
    """Return the reference text pointing to ``new_target`` keeping alias/subpath/style."""
    m = WIKI_INNER_RE.match(original)
    if m:
        bang, linktext, alias = m.group(1), m.group(2), m.group(3) or ""
        old_path, subpath = parser.parse_linktext(linktext)
        prefer_full = "/" in old_path
        lp = linkpath_for(index, new_target, source, prefer_full=prefer_full)
        if ext_of(old_path) == "md" and ext_of(new_target) == "md":
            lp += ".md"
        return f"{bang}[[{lp}{subpath}{alias}]]"
    m = MD_RE.match(original)
    if m:
        bang, text, dest, title = m.group(1), m.group(2), m.group(3), m.group(4) or ""
        bracketed = dest.startswith("<")
        raw = dest[1:-1] if bracketed else dest
        from urllib.parse import unquote
        path_part, _, frag = unquote(raw).partition("#")
        relative = not index.files.get(path_part) and not path_part.startswith("/")
        url = markdown_url_for(new_target, source, relative=relative and "/" in source)
        if frag:
            url += "#" + quote(frag, safe="^")
        if bracketed:
            url = "<" + url.replace("%20", " ") + ">"
        return f"{bang}[{text}]({url}{title})"
    return None


def collect_references(index: VaultIndex, moved: dict[str, str]) -> dict[str, list[tuple[dict, str]]]:
    """Before a rename: for every note, the references (metadata entries) whose
    resolved target is one of the moved files → [(entry, new_target)]."""
    out: dict[str, list[tuple[dict, str]]] = {}
    sources = set()
    for old in moved:
        sources |= index.backlinks.get(old, set())
    for src in sources:
        meta = index.meta.get(src) or {}
        for ref in meta.get("links", []) + meta.get("embeds", []):
            target, _ = parser.parse_linktext(ref["link"])
            dest = index.resolve(target, src) if target else None
            if dest in moved:
                out.setdefault(src, []).append((ref, moved[dest]))
        for ref in meta.get("frontmatterLinks", []):
            target, _ = parser.parse_linktext(ref["link"])
            dest = index.resolve(target, src) if target else None
            if dest in moved:
                out.setdefault(src, []).append((ref, moved[dest]))
    return out


def apply_rewrites(text: str, refs: list[tuple[dict, str]], index: VaultIndex, source: str) -> str:
    """Rewrite the given references in ``text`` (positions from metadata; frontmatter
    links have no position and are replaced by their original text inside the YAML)."""
    positioned = [(r, t) for r, t in refs if "position" in r]
    floating = [(r, t) for r, t in refs if "position" not in r]
    for ref, new_target in sorted(positioned, key=lambda x: -x[0]["position"]["start"]["offset"]):
        a = utf16_to_index(text, ref["position"]["start"]["offset"])
        b = utf16_to_index(text, ref["position"]["end"]["offset"])
        if text[a:b] != ref["original"]:
            idx = text.find(ref["original"])  # file changed since parse: fall back to search
            if idx == -1:
                continue
            a, b = idx, idx + len(ref["original"])
        new = rewrite_reference(ref["original"], new_target, index, source)
        if new is not None:
            text = text[:a] + new + text[b:]
    if floating:
        yaml_text, _, end = parser.split_frontmatter(text)
        if yaml_text is not None:
            head = text[:end]
            for ref, new_target in floating:
                new = rewrite_reference(ref["original"], new_target, index, source)
                if new:
                    head = head.replace(ref["original"], new)
            text = head + text[end:]
    return text


def relink_moved_note(text: str, old_path: str, new_path: str, index: VaultIndex) -> str:
    """A note moved to another folder: fix its own *relative* markdown links."""
    if posixpath.dirname(old_path) == posixpath.dirname(new_path):
        return text
    meta = parser.parse(text)
    refs = []
    for ref in meta.get("links", []) + meta.get("embeds", []):
        if not MD_RE.match(ref["original"]):
            continue
        target, _ = parser.parse_linktext(ref["link"])
        if target in index.files:
            continue  # absolute vault path: still valid
        old_abs = posixpath.normpath(posixpath.join(posixpath.dirname(old_path), target))
        if old_abs in index.files:
            refs.append((ref, old_abs))
    return apply_rewrites(text, refs, index, new_path) if refs else text

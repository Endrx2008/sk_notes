"""Markdown metadata parser.

Produces the metadata the rest of sk_notes needs (and that the plugin API exposes as
``CachedMetadata``): frontmatter, links, embeds, tags, headings, sections, list items
(tasks), block ids and footnotes, each with a position
``{"start": {"line", "col", "offset"}, "end": {...}}``.

Offsets and columns are counted in UTF-16 code units, because the editor and the
plugins run in JavaScript, where string indices are UTF-16.

Everything inside fenced/indented code, inline code, math blocks, inline math,
HTML comments and ``%% comments %%`` is ignored when looking for links and tags.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import yaml

__all__ = ["parse", "parse_frontmatter", "parse_linktext", "split_frontmatter", "FrontmatterLoader"]


# --------------------------------------------------------------------------- YAML

class FrontmatterLoader(yaml.SafeLoader):
    """Safe YAML loader that keeps dates/times as plain strings (like the JS side)."""


FrontmatterLoader.yaml_implicit_resolvers = {
    key: [(tag, rx) for tag, rx in value if tag != "tag:yaml.org,2002:timestamp"]
    for key, value in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        if isinstance(value, float) and value != value:  # NaN is not valid JSON
            return None
        return value
    return str(value)


def split_frontmatter(text: str) -> tuple[str | None, int, int]:
    """Return (yaml_text, end_line, end_offset) of a leading frontmatter block.

    end_line is the index of the closing ``---`` line; end_offset is the code-point
    offset just after it. ``(None, -1, 0)`` when there is no frontmatter.
    """
    if not text.startswith("---"):
        return None, -1, 0
    first_nl = text.find("\n")
    if first_nl == -1 or text[:first_nl].rstrip("\r ") != "---":
        return None, -1, 0
    pos = first_nl + 1
    line = 1
    while pos <= len(text):
        nl = text.find("\n", pos)
        end = len(text) if nl == -1 else nl
        stripped = text[pos:end].rstrip("\r ")
        if stripped in ("---", "..."):
            return text[first_nl + 1:pos], line, end
        if nl == -1:
            break
        pos = nl + 1
        line += 1
    return None, -1, 0


def parse_frontmatter(yaml_text: str) -> tuple[dict | None, str | None]:
    """Parse frontmatter YAML. Returns (data, error). Non-mapping YAML → error."""
    if not yaml_text.strip():
        return {}, None
    try:
        data = yaml.load(yaml_text, Loader=FrontmatterLoader)  # noqa: S506 - SafeLoader subclass
    except yaml.YAMLError as exc:
        return None, str(exc).splitlines()[0]
    if data is None:
        return {}, None
    if not isinstance(data, dict):
        return None, "frontmatter is not a key/value mapping"
    return _jsonable(data), None


# --------------------------------------------------------------------------- helpers

def parse_linktext(linktext: str) -> tuple[str, str]:
    """Split ``path#subpath`` → (path, '#subpath'); subpath keeps its leading '#'."""
    idx = linktext.find("#")
    if idx == -1:
        return linktext, ""
    return linktext[:idx], linktext[idx:]


class _Positions:
    """Converts code-point offsets into {line, col, offset} with UTF-16 units."""

    def __init__(self, text: str):
        self.text = text
        self.line_starts = [0]
        for m in re.finditer("\n", text):
            self.line_starts.append(m.end())
        self.wide = any(ord(c) > 0xFFFF for c in text)
        if self.wide:
            acc, self.u16 = 0, [0] * (len(text) + 1)
            for i, c in enumerate(text):
                self.u16[i] = acc
                acc += 2 if ord(c) > 0xFFFF else 1
            self.u16[len(text)] = acc

    def _u(self, offset: int) -> int:
        return self.u16[offset] if self.wide else offset

    def loc(self, offset: int) -> dict:
        lo, hi = 0, len(self.line_starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.line_starts[mid] <= offset:
                lo = mid
            else:
                hi = mid - 1
        return {"line": lo, "col": self._u(offset) - self._u(self.line_starts[lo]), "offset": self._u(offset)}

    def span(self, start: int, end: int) -> dict:
        return {"start": self.loc(start), "end": self.loc(end)}


# --------------------------------------------------------------------------- block scan

FENCE_RE = re.compile(r"^( {0,3})(`{3,}|~{3,})(.*)$")
HEADING_RE = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$")
SETEXT_RE = re.compile(r"^ {0,3}(=+|-+)[ \t]*$")
LIST_RE = re.compile(r"^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)(\[(.)\][ \t]+)?")
QUOTE_RE = re.compile(r"^ {0,3}>")
CALLOUT_RE = re.compile(r"^ {0,3}>\s*\[!([^\]]+)\]([+-]?)")
HR_RE = re.compile(r"^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$")
TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$")
BLOCK_ID_RE = re.compile(r"(?:^|\s)\^([A-Za-z0-9-]+)\s*$")
FOOTNOTE_DEF_RE = re.compile(r"^\[\^([^\]\s]+)\]:")
MATH_FENCE_RE = re.compile(r"^\s*\$\$")
HTML_BLOCK_RE = re.compile(r"^ {0,3}<(?:[A-Za-z][A-Za-z0-9-]*|!--)")


@dataclass
class _Line:
    start: int  # offset of first char
    end: int  # offset after last char (without \n)
    text: str


def _lines(text: str) -> list[_Line]:
    out, pos = [], 0
    for raw in text.split("\n"):
        out.append(_Line(pos, pos + len(raw), raw))
        pos += len(raw) + 1
    return out


def _indent_width(s: str) -> int:
    w = 0
    for c in s:
        if c == " ":
            w += 1
        elif c == "\t":
            w += 4 - (w % 4)
        else:
            break
    return w


# --------------------------------------------------------------------------- inline scan

WIKI_RE = re.compile(r"(!?)\[\[([^\[\]\n]+?)\]\]")
MDLINK_RE = re.compile(r"(!?)\[((?:[^\[\]\n]|\[[^\[\]\n]*\])*)\]\(\s*(<[^>\n]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+(?:\"[^\"\n]*\"|'[^'\n]*'))?\s*\)")
TAG_RE = re.compile(r"(?<![\w#/&])#([^\s!\"#$%&'()*+,.:;<=>?@\[\\\]^`{|}~　-〿！-／]+)")
INLINE_CODE_RE = re.compile(r"(`+)(?:.|\n)*?(?<!`)\1(?!`)")
INLINE_MATH_RE = re.compile(r"(?<![\\$])\$(?!\s)([^$\n]+?)(?<![\s\\])\$(?!\d)")
URL_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
# scheme start anchored and bounded: an unbounded scheme is quadratic on long words
URL_RE = re.compile(r"(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}://\S+")


def _mask(text: str, spans: list[tuple[int, int]]) -> str:
    if not spans:
        return text
    chars = list(text)
    for s, e in spans:
        for i in range(s, min(e, len(chars))):
            if chars[i] != "\n":
                chars[i] = " "
    return "".join(chars)


def _is_valid_tag(body: str) -> bool:
    body = body.rstrip("/")
    return bool(body) and not body.isdigit() and not re.fullmatch(r"[\d/]+", body)


def _url_decode(s: str) -> str:
    from urllib.parse import unquote
    return unquote(s)


# --------------------------------------------------------------------------- main parse

def parse(text: str) -> dict:
    """Parse a Markdown note and return its metadata (JSON-serialisable)."""
    text = text.replace("\r\n", "\n").replace("\r", "\n") if "\r" in text else text
    pos = _Positions(text)
    lines = _lines(text)
    meta: dict[str, Any] = {}

    # ---- frontmatter
    body_start_line = 0
    yaml_text, fm_end_line, fm_end_off = split_frontmatter(text)
    if yaml_text is not None:
        data, error = parse_frontmatter(yaml_text)
        meta["frontmatterPosition"] = pos.span(0, fm_end_off)
        if data is not None:
            meta["frontmatter"] = data
            fm_links = _frontmatter_links(data)
            if fm_links:
                meta["frontmatterLinks"] = fm_links
        else:
            meta["frontmatterError"] = error
        body_start_line = fm_end_line + 1
        sections = [{"type": "yaml", "position": pos.span(0, fm_end_off)}]
    else:
        sections = []

    # ---- block pass: code/math/comment ranges, headings, lists, sections
    masked_ranges: list[tuple[int, int]] = []
    headings, list_items, blocks, footnotes = [], [], {}, []
    i = body_start_line
    n = len(lines)
    list_stack: list[tuple[int, int]] = []  # (indent, line)
    list_root = None
    in_comment_block = False

    def add_section(kind: str, a: int, b: int):
        sections.append({"type": kind, "position": pos.span(lines[a].start, lines[b].end)})

    while i < n:
        ln = lines[i]
        s = ln.text
        if not s.strip():
            list_stack, list_root = [], None
            i += 1
            continue

        # %% comment blocks %%
        if s.strip().startswith("%%") and not in_comment_block:
            rest = s.strip()[2:]
            if "%%" not in rest:
                j = i + 1
                while j < n and "%%" not in lines[j].text:
                    j += 1
                j = min(j, n - 1)
                masked_ranges.append((ln.start, lines[j].end))
                add_section("comment", i, j)
                i = j + 1
                continue

        fence = FENCE_RE.match(s)
        if fence and not (fence.group(2)[0] == "`" and "`" in fence.group(3)):
            marker = fence.group(2)
            j = i + 1
            while j < n:
                close = FENCE_RE.match(lines[j].text)
                if close and close.group(2)[0] == marker[0] and len(close.group(2)) >= len(marker) and not close.group(3).strip():
                    break
                j += 1
            j = min(j, n - 1)
            masked_ranges.append((ln.start, lines[j].end))
            add_section("code", i, j)
            list_stack, list_root = [], None
            i = j + 1
            continue

        if MATH_FENCE_RE.match(s) and not list_stack:
            rest = s.strip()[2:]
            if "$$" in rest:
                masked_ranges.append((ln.start, ln.end))
                add_section("math", i, i)
                i += 1
                continue
            j = i + 1
            while j < n and "$$" not in lines[j].text:
                j += 1
            j = min(j, n - 1)
            masked_ranges.append((ln.start, lines[j].end))
            add_section("math", i, j)
            i = j + 1
            continue

        if s.lstrip().startswith("<!--"):
            j = i
            while j < n and "-->" not in lines[j].text:
                j += 1
            j = min(j, n - 1)
            masked_ranges.append((ln.start, lines[j].end))
            add_section("html", i, j)
            i = j + 1
            continue

        h = HEADING_RE.match(s)
        if h:
            title = (h.group(2) or "").strip()
            headings.append({"heading": title, "level": len(h.group(1)), "position": pos.span(ln.start, ln.end)})
            add_section("heading", i, i)
            list_stack, list_root = [], None
            i += 1
            continue

        if HR_RE.match(s) and not LIST_RE.match(s.replace("- - -", "")):
            add_section("thematicBreak", i, i)
            i += 1
            continue

        fn = FOOTNOTE_DEF_RE.match(s)
        if fn:
            footnotes.append({"id": fn.group(1), "position": pos.span(ln.start, ln.end)})
            add_section("footnoteDefinition", i, i)
            i += 1
            continue

        lm = LIST_RE.match(s)
        indent = _indent_width(s)
        if lm and (indent < 4 or list_stack):
            # one paragraph-like run of a list: consume item + its continuation lines
            j = i
            while j + 1 < n and lines[j + 1].text.strip():
                nxt = lines[j + 1].text
                if HEADING_RE.match(nxt) or FENCE_RE.match(nxt):
                    break
                j += 1
            # each line that starts an item becomes a list item
            start_section = i
            for k in range(i, j + 1):
                t = lines[k].text
                m = LIST_RE.match(t)
                if not m:
                    if list_items:
                        list_items[-1]["position"]["end"] = pos.loc(lines[k].end)
                    continue
                ind = _indent_width(m.group(1))
                while list_stack and list_stack[-1][0] >= ind:
                    list_stack.pop()
                if not list_stack and list_root is None:
                    list_root = k
                root = list_root if list_root is not None else k
                # root items: negative line of the list start (-1 for line 0, -0 is not < 0)
                parent = list_stack[-1][1] if list_stack else (-root if root else -1)
                item: dict[str, Any] = {"position": pos.span(lines[k].start, lines[k].end), "parent": parent}
                if m.group(4):
                    item["task"] = m.group(5)
                bid = BLOCK_ID_RE.search(t)
                if bid:
                    item["id"] = bid.group(1)
                list_items.append(item)
                list_stack.append((ind, k))
            add_section("list", start_section, j)
            _block_ids(lines, i, j, blocks, pos)
            i = j + 1
            continue

        callout = CALLOUT_RE.match(s)
        if QUOTE_RE.match(s):
            j = i
            while j + 1 < n and QUOTE_RE.match(lines[j + 1].text):
                j += 1
            add_section("callout" if callout else "blockquote", i, j)
            _block_ids(lines, i, j, blocks, pos)
            i = j + 1
            continue

        # table
        if "|" in s and i + 1 < n and TABLE_SEP_RE.match(lines[i + 1].text) and "-" in lines[i + 1].text:
            j = i + 1
            while j + 1 < n and "|" in lines[j + 1].text and lines[j + 1].text.strip():
                j += 1
            add_section("table", i, j)
            _block_ids(lines, j, j, blocks, pos, after_line=True)
            i = j + 1
            continue

        if HTML_BLOCK_RE.match(s):
            j = i
            while j + 1 < n and lines[j + 1].text.strip():
                j += 1
            add_section("html", i, j)
            i = j + 1
            continue

        # paragraph (setext headings too)
        j = i
        while j + 1 < n:
            nxt = lines[j + 1].text
            if not nxt.strip() or HEADING_RE.match(nxt) or FENCE_RE.match(nxt) or QUOTE_RE.match(nxt) \
                    or (LIST_RE.match(nxt) and _indent_width(nxt) < 4) or MATH_FENCE_RE.match(nxt):
                break
            if SETEXT_RE.match(nxt):
                level = 1 if nxt.strip()[0] == "=" else 2
                title = " ".join(lines[k].text.strip() for k in range(i, j + 1))
                headings.append({"heading": title, "level": level, "position": pos.span(lines[i].start, lines[j + 1].end)})
                add_section("heading", i, j + 1)
                j += 1
                break
            j += 1
        if not sections or sections[-1]["position"]["start"]["line"] != i:
            add_section("paragraph", i, j)
        _block_ids(lines, i, j, blocks, pos)
        i = j + 1

    # ---- inline pass over the text with code/math/comments masked
    body_offset = lines[body_start_line].start if body_start_line < n else len(text)
    scan = _mask(text, masked_ranges)
    if body_offset:
        scan = _mask(scan, [(0, body_offset)])
    inline_masks = [m.span() for m in INLINE_CODE_RE.finditer(scan)]
    inline_masks += [m.span() for m in re.finditer(r"%%.*?%%", scan, re.S)]
    inline_masks += [m.span() for m in re.finditer(r"<!--.*?-->", scan, re.S)]
    scan = _mask(scan, inline_masks)
    math_masks = [m.span() for m in INLINE_MATH_RE.finditer(scan)]
    scan_no_math = _mask(scan, math_masks)

    links, embeds = [], []
    wiki_spans = []
    for m in WIKI_RE.finditer(scan_no_math):
        inner = text[m.start(2):m.end(2)]
        target, _, alias = inner.partition("|")
        target = target.strip()
        if not target:
            continue
        entry: dict[str, Any] = {"link": target, "original": text[m.start():m.end()], "position": pos.span(m.start(), m.end())}
        entry["displayText"] = alias if alias else target
        (embeds if m.group(1) else links).append(entry)
        wiki_spans.append(m.span())
    md_scan = _mask(scan_no_math, wiki_spans)
    for m in MDLINK_RE.finditer(md_scan):
        dest = m.group(3).strip()
        if dest.startswith("<") and dest.endswith(">"):
            dest = dest[1:-1]
        if not dest or URL_SCHEME_RE.match(dest) or dest.startswith("#") and not dest[1:]:
            continue
        entry = {"link": _url_decode(dest), "original": text[m.start():m.end()],
                 "displayText": text[m.start(2):m.end(2)], "position": pos.span(m.start(), m.end())}
        (embeds if m.group(1) else links).append(entry)
    links.sort(key=lambda e: e["position"]["start"]["offset"])
    embeds.sort(key=lambda e: e["position"]["start"]["offset"])

    tag_scan = _mask(scan_no_math, [m.span() for m in MDLINK_RE.finditer(scan_no_math)] + wiki_spans)
    # URLs like http://x.y/#frag must not produce tags
    tag_scan = _mask(tag_scan, [m.span() for m in URL_RE.finditer(tag_scan)])
    tags = []
    for m in TAG_RE.finditer(tag_scan):
        body = m.group(1)
        if not _is_valid_tag(body):
            continue
        tags.append({"tag": "#" + body, "position": pos.span(m.start(), m.end())})

    if links:
        meta["links"] = links
    if embeds:
        meta["embeds"] = embeds
    if tags:
        meta["tags"] = tags
    if headings:
        meta["headings"] = headings
    if sections:
        meta["sections"] = sections
    if list_items:
        meta["listItems"] = list_items
    if blocks:
        meta["blocks"] = blocks
    if footnotes:
        meta["footnotes"] = footnotes
    return meta


def _block_ids(lines, a, b, blocks, pos, after_line=False):
    """Register a ``^block-id`` at the end of the block a..b (or on the line after a table)."""
    k = b + 1 if after_line else b
    if k >= len(lines):
        return
    m = BLOCK_ID_RE.search(lines[k].text)
    if m and not (after_line and lines[k].text.strip() != "^" + m.group(1)):
        bid = m.group(1)
        blocks[bid.lower()] = {"id": bid, "position": pos.span(lines[a].start, lines[k].end)}


def _frontmatter_links(data: dict, prefix: str = "") -> list[dict]:
    out = []
    for key, value in data.items():
        values = value if isinstance(value, list) else [value]
        for idx, v in enumerate(values):
            if not isinstance(v, str):
                continue
            for m in WIKI_RE.finditer(v):
                target, _, alias = m.group(2).partition("|")
                if target.strip() and not m.group(1):
                    k = f"{prefix}{key}" + (f".{idx}" if isinstance(value, list) else "")
                    out.append({"key": k, "link": target.strip(), "original": m.group(0),
                                "displayText": alias or target.strip()})
    return out


def all_tags(meta: dict) -> list[str]:
    """Tags of a note from both the body (``#tag``) and the ``tags`` property."""
    out = [t["tag"] for t in meta.get("tags", [])]
    fm = meta.get("frontmatter") or {}
    for key in ("tags", "tag"):
        val = fm.get(key)
        if isinstance(val, str):
            val = [v for v in re.split(r"[,\s]+", val) if v]
        if isinstance(val, list):
            for v in val:
                if isinstance(v, (str, int)) and str(v).strip():
                    v = str(v).strip()
                    out.append(v if v.startswith("#") else "#" + v)
    return out


def aliases(meta: dict) -> list[str]:
    fm = meta.get("frontmatter") or {}
    out = []
    for key in ("aliases", "alias"):
        val = fm.get(key)
        if isinstance(val, str):
            val = [v.strip() for v in val.split(",")]
        if isinstance(val, list):
            out += [str(v).strip() for v in val if v is not None and str(v).strip()]
    return out

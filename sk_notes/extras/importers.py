"""Importers from other note apps. Everything is converted locally; nothing is sent
anywhere. Each importer yields (relative path, bytes) pairs that the caller writes
into a target folder of the vault (never overwriting: names get " 1", " 2"...)."""

from __future__ import annotations

import base64
import csv
import html
import io
import json
import mimetypes
import re
import zipfile
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterator
from xml.etree import ElementTree

Item = tuple[str, bytes]
SAFE_RE = re.compile(r'[\\/:*?"<>|#^\[\]]+')


def safe_name(name: str, fallback: str = "Untitled") -> str:
    name = SAFE_RE.sub(" ", name or "").strip().strip(".")
    name = re.sub(r"\s+", " ", name)[:120]
    return name or fallback


def frontmatter(data: dict) -> str:
    import yaml
    clean = {k: v for k, v in data.items() if v not in (None, "", [])}
    if not clean:
        return ""
    return "---\n" + yaml.safe_dump(clean, allow_unicode=True, sort_keys=False).strip() + "\n---\n"


# --------------------------------------------------------------------------- HTML → Markdown
class _Html2Md(HTMLParser):
    BLOCK = {"p", "div", "section", "article", "header", "footer", "table", "tr", "blockquote", "pre", "ul", "ol", "li",
             "h1", "h2", "h3", "h4", "h5", "h6", "hr", "br", "en-note"}

    def __init__(self, resource_link=None):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.stack: list[str] = []
        self.list_stack: list[list] = []
        self.href: list[str | None] = []
        self.in_pre = 0
        self.row: list[str] | None = None
        self.table: list[list[str]] | None = None
        self.cell: list[str] | None = None
        self.resource_link = resource_link

    def _emit(self, s: str):
        if self.cell is not None:
            self.cell.append(s)
        else:
            self.out.append(s)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self.stack.append(tag)
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._emit("\n\n" + "#" * int(tag[1]) + " ")
        elif tag in ("p", "div", "section", "article"):
            self._emit("\n\n")
        elif tag == "br":
            self._emit("\n")
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag in ("s", "del", "strike"):
            self._emit("~~")
        elif tag == "mark":
            self._emit("==")
        elif tag == "code" and not self.in_pre:
            self._emit("`")
        elif tag == "pre":
            self.in_pre += 1
            self._emit("\n\n```\n")
        elif tag == "blockquote":
            self._emit("\n\n> ")
        elif tag in ("ul", "ol"):
            self.list_stack.append([tag, 0])
            self._emit("\n")
        elif tag == "li":
            depth = max(0, len(self.list_stack) - 1)
            kind = self.list_stack[-1] if self.list_stack else ["ul", 0]
            kind[1] += 1
            bullet = f"{kind[1]}." if kind[0] == "ol" else "-"
            self._emit("\n" + "    " * depth + bullet + " ")
        elif tag == "input" and a.get("type") == "checkbox":
            self._emit("[x] " if "checked" in a else "[ ] ")
        elif tag == "en-todo":
            self._emit("[x] " if a.get("checked") == "true" else "[ ] ")
        elif tag == "a":
            self.href.append(a.get("href"))
            self._emit("[")
        elif tag == "img":
            src = a.get("src", "")
            self._emit(f"![{a.get('alt', '')}]({src})")
        elif tag == "en-media" and self.resource_link:
            self._emit(self.resource_link(a.get("hash", ""), a.get("type", "")))
        elif tag == "hr":
            self._emit("\n\n---\n\n")
        elif tag == "table":
            self.table = []
        elif tag == "tr" and self.table is not None:
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = []

    def handle_endtag(self, tag):
        if self.stack and self.stack[-1] == tag:
            self.stack.pop()
        if tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag in ("s", "del", "strike"):
            self._emit("~~")
        elif tag == "mark":
            self._emit("==")
        elif tag == "code" and not self.in_pre:
            self._emit("`")
        elif tag == "pre":
            self.in_pre = max(0, self.in_pre - 1)
            self._emit("\n```\n\n")
        elif tag in ("ul", "ol"):
            if self.list_stack:
                self.list_stack.pop()
            self._emit("\n")
        elif tag == "a":
            href = self.href.pop() if self.href else None
            self._emit(f"]({href})" if href else "]")
        elif tag in ("td", "th") and self.cell is not None and self.row is not None:
            self.row.append("".join(self.cell).strip().replace("|", "\\|").replace("\n", " "))
            self.cell = None
        elif tag == "tr" and self.row is not None and self.table is not None:
            self.table.append(self.row)
            self.row = None
        elif tag == "table" and self.table is not None:
            rows = self.table
            self.table = None
            if rows:
                width = max(len(r) for r in rows)
                rows = [r + [""] * (width - len(r)) for r in rows]
                lines = ["| " + " | ".join(rows[0]) + " |", "|" + " --- |" * width] + ["| " + " | ".join(r) + " |" for r in rows[1:]]
                self._emit("\n\n" + "\n".join(lines) + "\n\n")

    def handle_data(self, data):
        if self.in_pre:
            self._emit(data)
        else:
            self._emit(re.sub(r"\s+", " ", data))

    def markdown(self) -> str:
        text = "".join(self.out)
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip() + "\n"


def html_to_markdown(src: str, resource_link=None) -> str:
    p = _Html2Md(resource_link)
    p.feed(src)
    p.close()
    return p.markdown()


# --------------------------------------------------------------------------- formats
def import_markdown_folder(src: Path) -> Iterator[Item]:
    for f in sorted(src.rglob("*")):
        if f.is_file() and not any(part.startswith(".") for part in f.relative_to(src).parts):
            yield f.relative_to(src).as_posix(), f.read_bytes()


def import_html(src: Path) -> Iterator[Item]:
    files = [src] if src.is_file() else sorted(src.rglob("*.htm*"))
    base = src.parent if src.is_file() else src
    for f in files:
        text = f.read_text(encoding="utf-8", errors="replace")
        title = re.search(r"<title>(.*?)</title>", text, re.I | re.S)
        md = html_to_markdown(re.sub(r"(?is)<(script|style|head)[^>]*>.*?</\1>", "", text))
        name = safe_name(html.unescape(title.group(1)) if title else f.stem)
        rel = f.relative_to(base).parent.as_posix()
        yield (f"{rel}/{name}.md" if rel != "." else f"{name}.md"), md.encode()


def import_enex(src: Path) -> Iterator[Item]:
    files = [src] if src.is_file() else sorted(src.rglob("*.enex"))
    for f in files:
        notebook = safe_name(f.stem)
        root = ElementTree.parse(f).getroot()
        for note in root.iter("note"):
            title = safe_name(note.findtext("title") or "Untitled")
            resources = {}
            for res in note.iter("resource"):
                data_el = res.find("data")
                if data_el is None or not data_el.text:
                    continue
                raw = base64.b64decode(data_el.text)
                import hashlib
                h = hashlib.md5(raw).hexdigest()  # noqa: S324 - Evernote uses md5 to reference resources
                mime = res.findtext("mime") or "application/octet-stream"
                fname = res.findtext("resource-attributes/file-name") or f"{h[:8]}{mimetypes.guess_extension(mime) or ''}"
                resources[h] = (safe_name(fname, h), raw, mime)

            def link(h, mime, _res=resources, _nb=notebook):
                if h not in _res:
                    return ""
                name, _raw, _mime = _res[h]
                return f"![[{name}]]" if mime.startswith("image/") else f"[[{name}]]"

            content = note.findtext("content") or ""
            md = html_to_markdown(content, link)
            meta = {"tags": [t.text for t in note.findall("tag") if t.text],
                    "created": _enex_date(note.findtext("created")), "updated": _enex_date(note.findtext("updated")),
                    "source": note.findtext("note-attributes/source-url")}
            yield f"{notebook}/{title}.md", (frontmatter(meta) + md).encode()
            for name, raw, _mime in resources.values():
                yield f"{notebook}/attachments/{name}", raw


def _enex_date(v: str | None) -> str | None:
    if not v:
        return None
    try:
        return datetime.strptime(v, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None


NOTION_ID = re.compile(r"\s[0-9a-f]{32}(?=\.|/|$)")


def import_notion(src: Path) -> Iterator[Item]:
    """Notion "Markdown & CSV" export (zip or extracted folder)."""
    entries: list[tuple[str, bytes]] = []
    if src.is_file() and src.suffix == ".zip":
        with zipfile.ZipFile(src) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                data = z.read(info)
                if info.filename.endswith(".zip"):  # nested export parts
                    with zipfile.ZipFile(io.BytesIO(data)) as inner:
                        entries += [(i.filename, inner.read(i)) for i in inner.infolist() if not i.is_dir()]
                else:
                    entries.append((info.filename, data))
    else:
        entries = [(f.relative_to(src).as_posix(), f.read_bytes()) for f in src.rglob("*") if f.is_file()]
    for path, data in entries:
        clean = NOTION_ID.sub("", path)
        if clean.endswith(".md"):
            text = data.decode("utf-8", errors="replace")

            def fix(m):
                target = re.sub(r"%20", " ", m.group(2))
                target = NOTION_ID.sub("", target.replace("%20", " "))
                target = re.sub(r"\.md$", "", target)
                if re.match(r"^[a-z]+://", target):
                    return m.group(0)
                return f"[[{target.split('/')[-1]}|{m.group(1)}]]" if m.group(1) else f"[[{target.split('/')[-1]}]]"

            text = re.sub(r"(?<!!)\[([^\]]*)\]\(([^)]+\.md)\)", fix, text)
            text = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", lambda m: f"![{m.group(1)}]({NOTION_ID.sub('', m.group(2).replace('%20', ' '))})", text)
            yield clean, text.encode()
        else:
            yield clean, data


def import_textbundle(src: Path) -> Iterator[Item]:
    bundles = [src] if src.suffix in (".textbundle", ".textpack") else sorted(src.rglob("*.textbundle"))
    for b in bundles:
        if b.is_file() and zipfile.is_zipfile(b):
            with zipfile.ZipFile(b) as z:
                names = z.namelist()
                text_name = next((n for n in names if re.search(r"text\.(md|markdown|txt)$", n)), None)
                if not text_name:
                    continue
                text = z.read(text_name).decode("utf-8", errors="replace")
                title = safe_name((text.strip().splitlines() or [b.stem])[0].lstrip("# "), b.stem)
                yield f"{title}.md", text.replace("](assets/", "](attachments/").encode()
                for n in names:
                    if "/assets/" in n and not n.endswith("/"):
                        yield f"attachments/{n.split('/assets/')[-1]}", z.read(n)
            continue
        text_file = next((p for p in b.iterdir() if p.name.startswith("text.")), None)
        if not text_file:
            continue
        text = text_file.read_text(encoding="utf-8", errors="replace")
        title = safe_name((text.strip().splitlines() or [b.stem])[0].lstrip("# "), b.stem)
        yield f"{title}.md", text.replace("](assets/", "](attachments/").encode()
        if (b / "assets").is_dir():
            for a in (b / "assets").iterdir():
                yield f"attachments/{a.name}", a.read_bytes()


def import_logseq(src: Path) -> Iterator[Item]:
    for sub in ("pages", "journals"):
        d = src / sub
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.md")):
            text = f.read_text(encoding="utf-8", errors="replace")
            props = {}
            lines = text.splitlines()
            while lines and re.match(r"^[\w-]+:: ", lines[0]):
                k, v = lines.pop(0).split(":: ", 1)
                props[k] = [x.strip() for x in v.split(",")] if k in ("tags", "alias") else v.strip()
            if "alias" in props:
                props["aliases"] = props.pop("alias")
            body = "\n".join(lines)
            body = re.sub(r"^(\s*)- ([\w-]+):: (.*)$", r"\1- **\2**: \3", body, flags=re.M)
            name = f.stem.replace("___", "/").replace("%2F", "/")
            if sub == "journals":
                m = re.match(r"(\d{4})_(\d{2})_(\d{2})", f.stem)
                name = f"Journal/{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else f"Journal/{f.stem}"
            yield f"{name}.md", (frontmatter(props) + body + "\n").encode()
    assets = src / "assets"
    if assets.is_dir():
        for a in assets.iterdir():
            if a.is_file():
                yield f"assets/{a.name}", a.read_bytes()


def import_roam(src: Path) -> Iterator[Item]:
    data = json.loads(src.read_text(encoding="utf-8"))

    def blocks(children, depth=0):
        out = []
        for c in children or []:
            s = c.get("string", "")
            s = re.sub(r"\{\{\[\[TODO\]\]\}\}", "[ ]", s)
            s = re.sub(r"\{\{\[\[DONE\]\]\}\}", "[x]", s)
            out.append("    " * depth + "- " + s)
            out += blocks(c.get("children"), depth + 1)
        return out

    for page in data:
        title = page.get("title") or "Untitled"
        body = "\n".join(blocks(page.get("children")))
        meta = {}
        if page.get("create-time"):
            meta["created"] = datetime.fromtimestamp(page["create-time"] / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
        yield f"{safe_name(title)}.md", (frontmatter(meta) + body + "\n").encode()


def import_keep(src: Path) -> Iterator[Item]:
    files = sorted(src.rglob("*.json")) if src.is_dir() else [src]
    for f in files:
        try:
            note = json.loads(f.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        if not isinstance(note, dict) or "textContent" not in note and "listContent" not in note:
            continue
        if note.get("isTrashed"):
            continue
        title = safe_name(note.get("title") or f.stem)
        body = note.get("textContent", "")
        if note.get("listContent"):
            body += "\n".join(f"- [{'x' if i.get('isChecked') else ' '}] {i.get('text', '')}" for i in note["listContent"])
        meta = {"tags": [lbl.get("name") for lbl in note.get("labels", []) if lbl.get("name")],
                "archived": True if note.get("isArchived") else None, "pinned": True if note.get("isPinned") else None}
        if note.get("userEditedTimestampUsec"):
            meta["updated"] = datetime.fromtimestamp(note["userEditedTimestampUsec"] / 1e6, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
        for att in note.get("attachments", []):
            p = f.parent / att.get("filePath", "")
            if p.is_file():
                yield f"attachments/{p.name}", p.read_bytes()
                body += f"\n\n![[{p.name}]]"
        yield f"{title}.md", (frontmatter(meta) + body + "\n").encode()


def import_csv(src: Path, title_column: str | None = None) -> Iterator[Item]:
    text = src.read_text(encoding="utf-8-sig", errors="replace")
    dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t") if text.strip() else csv.excel
    rows = list(csv.DictReader(io.StringIO(text), dialect=dialect))
    if not rows:
        return
    title_column = title_column or next(iter(rows[0].keys()))
    for i, row in enumerate(rows, 1):
        title = safe_name(row.get(title_column) or f"{src.stem} {i}")
        props = {k: _typed(v) for k, v in row.items() if k and k != title_column and v not in (None, "")}
        yield f"{title}.md", frontmatter(props).encode()


def _typed(v: str):
    v = v.strip()
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    if re.fullmatch(r"-?\d+\.\d+", v):
        return float(v)
    if v.lower() in ("true", "false"):
        return v.lower() == "true"
    return v


IMPORTERS = {
    "markdown": import_markdown_folder,
    "html": import_html,
    "enex": import_enex,
    "notion": import_notion,
    "textbundle": import_textbundle,
    "logseq": import_logseq,
    "roam": import_roam,
    "keep": import_keep,
    "csv": import_csv,
}

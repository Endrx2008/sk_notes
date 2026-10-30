"""Search query language and evaluation.

Syntax (same operators as the reference app's search, documented publicly):
  words (AND), "exact phrase", OR, -negation, ( grouping ), /regex/,
  file: path: content: tag: line:( ) block:( ) section:( ) task: task-todo: task-done:
  match-case: ignore-case: [property] [property:value]
Matching is case-insensitive by default and works on substrings.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

from . import parser
from .index import VaultIndex, basename_no_ext, ext_of

OPERATORS = {"file", "path", "content", "tag", "line", "block", "section", "task", "task-todo",
             "task-done", "match-case", "ignore-case"}
SCOPED = {"line", "block", "section", "task", "task-todo", "task-done"}


class QueryError(ValueError):
    pass


# ----------------------------------------------------------------------------- AST
@dataclass
class Term:
    text: str
    regex: bool = False
    phrase: bool = False
    field: str = "default"
    case: bool | None = None  # None = inherit

    def compile(self, case_sensitive: bool) -> re.Pattern:
        cs = self.case if self.case is not None else case_sensitive
        flags = 0 if cs else re.IGNORECASE
        if self.regex:
            try:
                return re.compile(self.text, flags | re.MULTILINE)
            except re.error as exc:
                raise QueryError(f"regex: {exc}") from exc
        return re.compile(re.escape(self.text), flags)


@dataclass
class Prop:
    name: str
    value: "Node | None" = None


@dataclass
class Scoped:
    field: str
    node: "Node"


@dataclass
class Not:
    node: "Node"


@dataclass
class And:
    items: list = field(default_factory=list)


@dataclass
class Or:
    items: list = field(default_factory=list)


Node = Term | Prop | Scoped | Not | And | Or


# ----------------------------------------------------------------------------- parser
TOKEN_RE = re.compile(r'''
    (?P<ws>\s+)
  | (?P<lp>\()
  | (?P<rp>\))
  | (?P<lb>\[)
  | (?P<quote>"(?:[^"\\]|\\.)*"?)
  | (?P<regex>/(?:[^/\\]|\\.)+/)
  | (?P<word>[^\s()"\[]+)
''', re.X)


class _Parser:
    def __init__(self, q: str):
        self.q = q
        self.i = 0

    def peek_char(self) -> str:
        while self.i < len(self.q) and self.q[self.i].isspace():
            self.i += 1
        return self.q[self.i] if self.i < len(self.q) else ""

    def parse(self) -> Node:
        node = self.parse_or()
        if self.peek_char() == ")":
            self.i += 1  # tolerate stray ')'
            rest = self.parse()
            return And([node, rest])
        return node

    def parse_or(self) -> Node:
        items = [self.parse_and()]
        while True:
            save = self.i
            c = self.peek_char()
            if self.q[self.i:self.i + 2] == "OR" and (self.i + 2 == len(self.q) or self.q[self.i + 2].isspace() or self.q[self.i + 2] == "("):
                self.i += 2
                items.append(self.parse_and())
            else:
                self.i = save
                break
            if not c:
                break
        return items[0] if len(items) == 1 else Or(items)

    def parse_and(self) -> Node:
        items = []
        while True:
            c = self.peek_char()
            if not c or c == ")":
                break
            if self.q[self.i:self.i + 2] == "OR" and (self.i + 2 == len(self.q) or self.q[self.i + 2] in " (\t"):
                break
            items.append(self.parse_unary())
        if not items:
            return And([])
        return items[0] if len(items) == 1 else And(items)

    def parse_unary(self) -> Node:
        c = self.peek_char()
        if c == "-" and self.i + 1 < len(self.q) and not self.q[self.i + 1].isspace():
            self.i += 1
            return Not(self.parse_unary())
        return self.parse_atom()

    def parse_atom(self, field: str = "default") -> Node:
        c = self.peek_char()
        if c == "(":
            self.i += 1
            node = self.parse_or()
            if self.peek_char() == ")":
                self.i += 1
            return node
        if c == "[":
            return self.parse_prop()
        m = TOKEN_RE.match(self.q, self.i)
        if not m:
            raise QueryError("syntax")
        self.i = m.end()
        if m.group("quote"):
            raw = m.group("quote")
            text = raw[1:-1] if len(raw) > 1 and raw.endswith('"') else raw[1:]
            return Term(text.replace('\\"', '"'), phrase=True, field=field)
        if m.group("regex"):
            return Term(m.group("regex")[1:-1], regex=True, field=field)
        word = m.group("word")
        op, colon, rest = word.partition(":")
        if colon and op in OPERATORS:
            self.i = m.start() + len(op) + 1
            if op in ("match-case", "ignore-case"):
                node = self._operand(field)
                _set_case(node, op == "match-case")
                return node
            if op in SCOPED:
                return Scoped(op, self._operand("default"))
            return self._operand(op)
        return Term(word, field=field)

    def _operand(self, field: str) -> Node:
        if self.i >= len(self.q) or self.q[self.i].isspace():
            return Term("", field=field)
        return self.parse_atom(field)

    def parse_prop(self) -> Node:
        end = self.q.find("]", self.i)
        if end == -1:
            end = len(self.q)
        inner = self.q[self.i + 1:end]
        self.i = min(end + 1, len(self.q))
        name, colon, value = inner.partition(":")
        name = name.strip().strip('"')
        if not colon:
            return Prop(name)
        sub = _Parser(value.strip())
        return Prop(name, sub.parse() if value.strip() else Term(""))


def _set_case(node, cs: bool):
    if isinstance(node, Term):
        node.case = cs
    for attr in ("items",):
        for child in getattr(node, attr, []):
            _set_case(child, cs)
    if isinstance(node, (Not, Scoped)):
        _set_case(node.node, cs)
    if isinstance(node, Prop) and node.value is not None:
        _set_case(node.value, cs)


def parse_query(q: str) -> Node:
    return _Parser(q.strip()).parse()


# ----------------------------------------------------------------------------- evaluation
class _Doc:
    __slots__ = ("path", "name", "meta", "_content", "_index")

    def __init__(self, index: VaultIndex, path: str):
        self.path, self.name, self._index = path, basename_no_ext(path), index
        self.meta = index.meta.get(path) or {}
        self._content = None

    @property
    def content(self) -> str:
        if self._content is None:
            self._content = self._index.content(self.path) or ""
        return self._content


class _Eval:
    def __init__(self, case_sensitive: bool):
        self.cs = case_sensitive
        self.patterns: dict[int, re.Pattern] = {}

    def pat(self, t: Term) -> re.Pattern:
        key = id(t)
        if key not in self.patterns:
            self.patterns[key] = t.compile(self.cs)
        return self.patterns[key]

    def match_text(self, node: Node, text: str, doc: _Doc | None = None) -> bool:
        """Evaluate node against a plain text unit (used inside scoped operators)."""
        if isinstance(node, Term):
            return not node.text or bool(self.pat(node).search(text))
        if isinstance(node, Not):
            return not self.match_text(node.node, text, doc)
        if isinstance(node, And):
            return all(self.match_text(n, text, doc) for n in node.items)
        if isinstance(node, Or):
            return any(self.match_text(n, text, doc) for n in node.items)
        if isinstance(node, Prop) and doc is not None:
            return self.match_doc(node, doc)
        if isinstance(node, Scoped):
            return self.match_text(node.node, text, doc)
        return False

    def match_doc(self, node: Node, doc: _Doc) -> bool:
        if isinstance(node, And):
            return all(self.match_doc(n, doc) for n in node.items)
        if isinstance(node, Or):
            return any(self.match_doc(n, doc) for n in node.items)
        if isinstance(node, Not):
            return not self.match_doc(node.node, doc)
        if isinstance(node, Term):
            if not node.text:
                return True
            p = self.pat(node)
            f = node.field
            if f == "file":
                return bool(p.search(doc.path.rsplit("/", 1)[-1]))
            if f == "path":
                return bool(p.search(doc.path))
            if f == "content":
                return bool(p.search(doc.content))
            if f == "tag":
                want = node.text.lstrip("#").lower()
                for t in parser.all_tags(doc.meta):
                    t = t[1:].lower()
                    if t == want or t.startswith(want + "/"):
                        return True
                return False
            return bool(p.search(doc.name)) or bool(p.search(doc.content))
        if isinstance(node, Prop):
            fm = doc.meta.get("frontmatter") or {}
            key = next((k for k in fm if k.lower() == node.name.lower()), None)
            if key is None:
                return False
            if node.value is None:
                return True
            val = fm[key]
            vals = val if isinstance(val, list) else [val]
            if isinstance(node.value, Term) and not node.value.text:
                return all(v in (None, "", []) for v in vals) or val in (None, "", [])
            if isinstance(node.value, Term) and node.value.text.lower() == "null":
                return val is None
            return any(self.match_text(node.value, _prop_str(v)) for v in vals)
        if isinstance(node, Scoped):
            return any(self.match_text(node.node, unit, doc) for unit in _units(node.field, doc))
        return False

    def highlights(self, node: Node, doc: _Doc, out: list):
        """Collect positive content patterns for snippet highlighting."""
        if isinstance(node, (And, Or)):
            for n in node.items:
                self.highlights(n, doc, out)
        elif isinstance(node, Term) and node.text and node.field in ("default", "content"):
            out.append(self.pat(node))
        elif isinstance(node, Scoped):
            self.highlights(node.node, doc, out)


def _prop_str(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    return "" if v is None else str(v)


def _units(kind: str, doc: _Doc):
    text = doc.content
    lines = text.split("\n")
    if kind == "line":
        return lines
    if kind in ("task", "task-todo", "task-done"):
        out = []
        for item in doc.meta.get("listItems", []):
            task = item.get("task")
            if task is None:
                continue
            if kind == "task-todo" and task != " ":
                continue
            if kind == "task-done" and task == " ":
                continue
            ln = item["position"]["start"]["line"]
            if ln < len(lines):
                out.append(re.sub(r"^\s*([-*+]|\d+[.)])\s+\[.\]\s*", "", lines[ln]))
        return out
    units = []
    for sec in doc.meta.get("sections", []):
        a, b = sec["position"]["start"]["line"], sec["position"]["end"]["line"]
        units.append((sec["type"], "\n".join(lines[a:b + 1])))
    if kind == "block":
        return [u for _, u in units]
    # section = text between headings
    out, cur = [], []
    for typ, u in units:
        if typ == "heading" and cur:
            out.append("\n".join(cur))
            cur = []
        cur.append(u)
    if cur:
        out.append("\n".join(cur))
    return out


def _prefilter_terms(node: Node) -> list[str]:
    """Plain positive terms every result must contain (used with FTS)."""
    if isinstance(node, Term) and not node.regex and node.field in ("default", "content") and len(node.text) >= 3:
        return [node.text]
    if isinstance(node, And):
        out = []
        for n in node.items:
            out += _prefilter_terms(n)
        return out
    return []


def search(index: VaultIndex, query: str, *, case_sensitive: bool = False, limit_files: int = 2000,
           context: int = 1, max_matches: int = 20) -> dict:
    t0 = time.perf_counter()
    node = parse_query(query)
    ev = _Eval(case_sensitive)
    with index.lock:
        terms = _prefilter_terms(node)
        if terms:
            fts_q = " AND ".join('"' + t.replace('"', '""') + '"' for t in terms)
            try:
                rows = index.db.execute("SELECT d.path, d.content FROM fts JOIN docs d ON d.id = fts.rowid "
                                        "WHERE fts MATCH ?", (fts_q,)).fetchall()
            except Exception:  # noqa: BLE001 - fall back to a full scan
                rows = [(p, None) for p in index.files]
        else:
            rows = [(p, None) for p in index.files]
        results = []
        total = 0
        for path, content in rows:
            if path not in index.files or ext_of(path) not in ("md", "canvas", "base", "txt"):
                continue
            doc = _Doc(index, path)
            doc._content = content
            if not ev.match_doc(node, doc):
                continue
            total += 1
            if len(results) >= limit_files:
                continue
            pats: list = []
            ev.highlights(node, doc, pats)
            results.append({"path": path, "matches": _snippets(doc, pats, context, max_matches) if pats else [],
                            "mtime": int(index.files[path].mtime * 1000), "ctime": int(index.files[path].ctime * 1000)})
    return {"query": query, "total": total, "results": results, "ms": round((time.perf_counter() - t0) * 1000, 1)}


def _snippets(doc: _Doc, pats: list, context: int, max_matches: int) -> list[dict]:
    text = doc.content
    spans = []
    for p in pats:
        for m in p.finditer(text):
            if m.end() > m.start():
                spans.append((m.start(), m.end()))
            if len(spans) > max_matches * 4:
                break
    spans.sort()
    out, used_lines = [], set()
    line_starts = [0] + [m.end() for m in re.finditer("\n", text)]
    import bisect
    for s, e in spans:
        ln = bisect.bisect_right(line_starts, s) - 1
        if ln in used_lines:
            continue
        used_lines.add(ln)
        a = max(0, ln - context + 1) if context > 1 else ln
        b = min(len(line_starts) - 1, ln + context - 1) if context > 1 else ln
        start = line_starts[a]
        end = (line_starts[b + 1] - 1) if b + 1 < len(line_starts) else len(text)
        chunk = text[start:end]
        if len(chunk) > 400:  # long lines: window around the match
            ws = max(start, s - 150)
            we = min(end, e + 200)
            chunk, start = text[ws:we], ws
        segs, pos = [], 0
        for s2, e2 in spans:
            if s2 >= start and e2 <= start + len(chunk) and s2 - start >= pos:
                segs.append([chunk[pos:s2 - start], False])
                segs.append([chunk[s2 - start:e2 - start], True])
                pos = e2 - start
        segs.append([chunk[pos:], False])
        out.append({"line": ln, "segments": [sg for sg in segs if sg[0]]})
        if len(out) >= max_matches:
            break
    return out

"""Vault index: metadata cache (SQLite, keyed by mtime+size), full-text index (FTS5
trigram, substring search in any language) and the link graph.

The cache lives in ``<vault>/.sk_notes/cache.db``; it can be deleted at any time and is
rebuilt on the next start. Only files whose mtime/size changed are re-parsed.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import threading
from collections import defaultdict
from pathlib import PurePosixPath

from . import parser
from .vault import FileEntry, Vault, normalize_path

log = logging.getLogger(__name__)

SCHEMA_VERSION = 4
MARKDOWN_EXT = {"md"}
TEXT_EXT = {"md", "canvas", "base", "txt"}
MAX_INDEXED_BYTES = 8 * 1024 * 1024  # bigger notes are listed but not parsed/indexed
# paths that need no normalisation (fast path of resolve())
_SIMPLE_PATH = re.compile(r"[^\\/\u00a0\u202f]+(?:/[^\\/\u00a0\u202f.][^\\/\u00a0\u202f]*)*")

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta_info (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    mtime REAL NOT NULL,
    size INTEGER NOT NULL,
    meta TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    content TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
    name, content, content = 'docs', content_rowid = 'id', tokenize = 'trigram'
);
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
    INSERT INTO fts(rowid, name, content) VALUES (new.id, new.name, new.content);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
    INSERT INTO fts(fts, rowid, name, content) VALUES ('delete', old.id, old.name, old.content);
END;
CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
    INSERT INTO fts(fts, rowid, name, content) VALUES ('delete', old.id, old.name, old.content);
    INSERT INTO fts(rowid, name, content) VALUES (new.id, new.name, new.content);
END;
"""


def ext_of(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    return name.rsplit(".", 1)[-1].lower() if "." in name[1:] else ""


def basename_no_ext(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    return name.rsplit(".", 1)[0] if "." in name[1:] else name


class VaultIndex:
    def __init__(self, vault: Vault, db_path: str | None = None):
        self.vault = vault
        self.lock = threading.RLock()
        path = db_path or str(vault.config_dir / "cache.db")
        self.db = self._open(path)
        self.files: dict[str, FileEntry] = {}
        self.folders: set[str] = set()
        self.meta: dict[str, dict] = {}
        self.by_name: dict[str, list[str]] = defaultdict(list)  # lower basename → paths
        self.resolved: dict[str, dict[str, int]] = {}
        self.unresolved: dict[str, dict[str, int]] = {}
        self.backlinks: dict[str, set[str]] = defaultdict(set)
        self._resolve_cache: dict | None = None  # only during bulk rebuilds

    # ------------------------------------------------------------- db
    def _open(self, path: str) -> sqlite3.Connection:
        def connect():
            db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=NORMAL")
            db.executescript(SCHEMA)
            row = db.execute("SELECT value FROM meta_info WHERE key='schema'").fetchone()
            if row and int(row[0]) != SCHEMA_VERSION:
                raise sqlite3.DatabaseError("schema changed")
            db.execute("INSERT OR REPLACE INTO meta_info VALUES ('schema', ?)", (str(SCHEMA_VERSION),))
            return db

        try:
            return connect()
        except sqlite3.DatabaseError as exc:  # corrupt or old cache → rebuild
            log.warning("cache %s unusable (%s): rebuilding", path, exc)
            for suffix in ("", "-wal", "-shm"):
                try:
                    import os
                    os.unlink(path + suffix)
                except OSError:
                    pass
            return connect()

    def close(self) -> None:
        with self.lock:
            self.db.close()

    # ------------------------------------------------------------- full sync
    def sync(self, progress=None) -> dict:
        """Scan the vault and bring the cache up to date. Returns change counts."""
        with self.lock:
            entries = self.vault.scan()
            cached = {row[0]: (row[1], row[2]) for row in self.db.execute("SELECT path, mtime, size FROM files")}
            self.files = {e.path: e for e in entries if not e.is_dir}
            self.folders = {e.path for e in entries if e.is_dir}
            changed, removed = [], [p for p in cached if p not in self.files]
            for path, e in self.files.items():
                if ext_of(path) in TEXT_EXT:
                    c = cached.get(path)
                    if c is None or abs(c[0] - e.mtime) > 1e-6 or c[1] != e.size:
                        changed.append(path)
            self.db.execute("BEGIN")
            try:
                for p in removed:
                    self.db.execute("DELETE FROM files WHERE path=?", (p,))
                    self.db.execute("DELETE FROM docs WHERE path=?", (p,))
                for n, p in enumerate(changed):
                    self._index_file(p, self.files[p])
                    if progress and n % 200 == 0:
                        progress(n, len(changed))
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise
            self.meta = {}
            for path, meta in self.db.execute("SELECT path, meta FROM files"):
                if path in self.files and ext_of(path) in MARKDOWN_EXT:
                    self.meta[path] = json.loads(meta)
            self._rebuild_names()
            self._rebuild_links()
            return {"files": len(self.files), "changed": len(changed), "removed": len(removed)}

    def _read_for_index(self, path: str, entry: FileEntry) -> str:
        if entry.size > MAX_INDEXED_BYTES:
            return ""
        try:
            return self.vault.read_text(path)
        except OSError:
            return ""

    def _index_file(self, path: str, entry: FileEntry, text: str | None = None) -> dict:
        text = self._read_for_index(path, entry) if text is None else text
        meta = parser.parse(text) if ext_of(path) in MARKDOWN_EXT else {}
        self.db.execute("INSERT OR REPLACE INTO files VALUES (?,?,?,?)",
                        (path, entry.mtime, entry.size, json.dumps(meta, separators=(",", ":"))))
        self.db.execute("DELETE FROM docs WHERE path=?", (path,))
        self.db.execute("INSERT INTO docs(path, name, content) VALUES (?,?,?)",
                        (path, basename_no_ext(path), text if ext_of(path) in TEXT_EXT else ""))
        return meta

    # ------------------------------------------------------------- incremental
    def update(self, path: str, text: str | None = None) -> dict | None:
        """(Re)index one file after a write or an external change. Returns new meta."""
        path = normalize_path(path)
        with self.lock:
            entry = self.vault.stat(path)
            if entry is None:
                self.remove(path)
                return None
            if entry.is_dir:
                self.folders.add(path)
                return None
            is_new = path not in self.files
            self.files[path] = entry
            self._add_parent_folders(path)
            if ext_of(path) not in TEXT_EXT:
                if is_new:
                    self._name_add(path)
                    self._rebuild_links()
                return None
            meta = self._index_file(path, entry, text)
            if is_new:
                self._name_add(path)
            if ext_of(path) in MARKDOWN_EXT:
                self.meta[path] = meta
            if is_new:
                self._rebuild_links()  # new name may resolve old dangling links
            else:
                self._links_for(path)
            return meta

    def remove(self, path: str) -> list[str]:
        """Forget a file or a whole folder. Returns removed file paths."""
        path = normalize_path(path)
        with self.lock:
            gone = [p for p in self.files if p == path or p.startswith(path + "/")]
            for p in gone:
                self.files.pop(p, None)
                self.meta.pop(p, None)
                self.db.execute("DELETE FROM files WHERE path=?", (p,))
                self.db.execute("DELETE FROM docs WHERE path=?", (p,))
            self.folders = {f for f in self.folders if f != path and not f.startswith(path + "/")}
            if gone:
                self._rebuild_names()
                self._rebuild_links()
            return gone

    def rename(self, old: str, new: str) -> list[tuple[str, str]]:
        """Move cache entries old→new (file or folder). Returns [(old, new)] file pairs."""
        old, new = normalize_path(old), normalize_path(new)
        with self.lock:
            pairs = [(p, new + p[len(old):]) for p in list(self.files) if p == old or p.startswith(old + "/")]
            for a, b in pairs:
                e = self.files.pop(a)
                self.files[b] = FileEntry(b, False, e.size, e.mtime, e.ctime)
                if a in self.meta:
                    self.meta[b] = self.meta.pop(a)
                self.db.execute("UPDATE files SET path=? WHERE path=?", (b, a))
                self.db.execute("UPDATE docs SET path=?, name=? WHERE path=?", (b, basename_no_ext(b), a))
            if old in self.folders or any(f.startswith(old + "/") for f in self.folders):
                self.folders = {(new + f[len(old):]) if (f == old or f.startswith(old + "/")) else f for f in self.folders}
            self._add_parent_folders(new + "/x")
            self._rebuild_names()
            self._rebuild_links()
            return pairs

    def _add_parent_folders(self, path: str) -> None:
        parts = path.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            self.folders.add("/".join(parts[:i]))

    # ------------------------------------------------------------- names & links
    def _name_add(self, path: str) -> None:
        name = path.rsplit("/", 1)[-1].lower()
        self.by_name[name].append(path)
        if ext_of(path) == "md":
            self.by_name[name[:-3]].append(path)

    def _rebuild_names(self) -> None:
        self.by_name = defaultdict(list)
        for p in sorted(self.files):
            self._name_add(p)

    def resolve(self, linkpath: str, source: str = "") -> str | None:
        """Resolve a link path (without #subpath) to a vault file path: a bare name
        next to the source note → exact vault path → path relative to the source →
        by name, case-insensitive (same folder first, then shortest path)."""
        cache = self._resolve_cache
        folder = source.rpartition("/")[0] if source else ""
        key = (linkpath, folder)
        if cache is not None and key in cache:
            return cache[key]
        res = self._resolve(linkpath, source, folder)
        if cache is not None:
            cache[key] = res
        return res

    def _resolve(self, linkpath: str, source: str, folder: str) -> str | None:
        linkpath = linkpath.strip()
        if not linkpath:
            return source or None
        lp = linkpath if _SIMPLE_PATH.fullmatch(linkpath) else normalize_path(linkpath)
        if lp == "/":
            return None
        candidates = (lp + ".md", lp) if ext_of(lp) == "" else (lp, lp + ".md")
        files = self.files
        if folder and "/" not in lp:
            for c in candidates:
                if f"{folder}/{c}" in files:
                    return f"{folder}/{c}"
        for c in candidates:
            if c in files:
                return c
        if folder and "/" in lp:
            for c in candidates:
                parts = []
                for part in (folder + "/" + c).split("/"):
                    if part == "..":
                        if parts:
                            parts.pop()
                    elif part not in ("", "."):
                        parts.append(part)
                rel = "/".join(parts)
                if rel in files:
                    return rel
        name = lp.rpartition("/")[2].lower()
        matches = self.by_name.get(name, [])
        if "/" in lp:
            low_lp = lp.lower()
            matches = [m for m in matches if m.lower() in (low_lp, low_lp + ".md")
                       or m.lower().endswith("/" + low_lp) or m.lower().endswith("/" + low_lp + ".md")]
        if not matches:
            return None
        if len(matches) == 1:
            return matches[0]
        same = [m for m in matches if m.rpartition("/")[0] == folder]
        if same:
            return same[0]
        bare = ext_of(lp) == ""
        return min(matches, key=lambda m: ((ext_of(m) != "md") if bare else False, m.count("/"), m))

    def _links_for(self, path: str) -> None:
        old_targets = set(self.resolved.get(path, {}))
        for t in old_targets:
            self.backlinks[t].discard(path)
        res: dict[str, int] = {}
        unres: dict[str, int] = {}
        meta = self.meta.get(path) or {}
        for ref in meta.get("links", []) + meta.get("embeds", []) + meta.get("frontmatterLinks", []):
            target, _ = parser.parse_linktext(ref["link"])
            if not target:
                continue
            dest = self.resolve(target, path)
            if dest:
                res[dest] = res.get(dest, 0) + 1
                self.backlinks[dest].add(path)
            else:
                unres[target] = unres.get(target, 0) + 1
        self.resolved[path] = res
        self.unresolved[path] = unres

    def _rebuild_links(self) -> None:
        self.resolved, self.unresolved, self.backlinks = {}, {}, defaultdict(set)
        self._resolve_cache = {}
        try:
            for p in self.meta:
                self._links_for(p)
        finally:
            self._resolve_cache = None

    # ------------------------------------------------------------- queries
    def file_list(self) -> list[dict]:
        out = [{"path": f, "folder": True} for f in sorted(self.folders)]
        out += [e.to_json() for _, e in sorted(self.files.items())]
        return out

    def content(self, path: str) -> str | None:
        row = self.db.execute("SELECT content FROM docs WHERE path=?", (path,)).fetchone()
        return row[0] if row else None

    def all_tags(self) -> dict[str, int]:
        counts: dict[str, int] = defaultdict(int)
        for meta in self.meta.values():
            for t in parser.all_tags(meta):
                counts[t] += 1
        return dict(counts)

    def properties(self) -> dict[str, dict]:
        """Every frontmatter key with its count and inferred type."""
        out: dict[str, dict] = {}
        for meta in self.meta.values():
            for k, v in (meta.get("frontmatter") or {}).items():
                info = out.setdefault(k, {"count": 0, "type": _infer_type(k, v)})
                info["count"] += 1
        return out

    def snapshot(self) -> dict:
        """Everything the UI needs at start."""
        with self.lock:
            return {
                "files": self.file_list(),
                "metadata": self.meta,
                "resolvedLinks": self.resolved,
                "unresolvedLinks": self.unresolved,
            }


def _infer_type(key: str, value) -> str:
    import re
    if key in ("tags", "tag"):
        return "tags"
    if key in ("aliases", "alias"):
        return "aliases"
    if isinstance(value, bool):
        return "checkbox"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, list):
        return "multitext"
    if isinstance(value, str):
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return "date"
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?", value):
            return "datetime"
    return "text"

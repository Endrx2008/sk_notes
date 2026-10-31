"""Local embedding index for questions about the whole vault.

Notes are split into chunks (by heading/paragraph, ~800 characters), embedded with the
installed Ollama embedding model and stored in .sk_notes/embeddings.db. Only changed
notes are re-embedded. Retrieval = cosine similarity (numpy). When no embedding model
is installed, retrieval falls back to the full-text index (keyword search)."""

from __future__ import annotations

import re
import sqlite3
import threading
import time
from array import array

try:
    import numpy as np
except ImportError:  # pragma: no cover - numpy is a declared dependency
    np = None

CHUNK = 800
BATCH = 16


def split_chunks(text: str) -> list[str]:
    text = re.sub(r"^---\n[\s\S]*?\n---\n?", "", text)
    parts: list[str] = []
    cur = ""
    for block in re.split(r"\n(?=#{1,6}\s)|\n\s*\n", text):
        block = block.strip()
        if not block:
            continue
        if len(cur) + len(block) + 2 <= CHUNK:
            cur = f"{cur}\n\n{block}" if cur else block
        else:
            if cur:
                parts.append(cur)
            while len(block) > CHUNK:
                parts.append(block[:CHUNK])
                block = block[CHUNK - 100:]
            cur = block
    if cur:
        parts.append(cur)
    return parts


class EmbeddingIndex:
    def __init__(self, db_path: str):
        self.db = sqlite3.connect(db_path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS chunks (path TEXT, idx INTEGER, mtime REAL, model TEXT, text TEXT, vec BLOB,
                                               PRIMARY KEY (path, idx));
            CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
        """)
        self.lock = threading.Lock()
        self._matrix = None  # cached (paths, texts, matrix)
        self.cancel = threading.Event()
        self.running = False

    def status(self, model: str | None) -> dict:
        row = self.db.execute("SELECT COUNT(DISTINCT path), COUNT(*) FROM chunks WHERE model=?", (model or "",)).fetchone()
        return {"notes": row[0], "chunks": row[1], "model": model or "", "running": self.running}

    def build(self, service, ollama, model: str, progress=None) -> dict:
        """Embed new/changed notes. Returns counts. Safe to call repeatedly."""
        if self.running:
            return {"busy": True}
        self.running = True
        self.cancel.clear()
        try:
            files = {p: e for p, e in service.index.files.items() if p.endswith(".md")}
            known = {r[0]: r[1] for r in self.db.execute("SELECT path, MAX(mtime) FROM chunks WHERE model=? GROUP BY path", (model,))}
            for gone in set(known) - set(files):
                self.db.execute("DELETE FROM chunks WHERE path=?", (gone,))
            todo = [p for p, e in files.items() if known.get(p) is None or abs(known[p] - e.mtime) > 1e-6]
            done = 0
            for path in todo:
                if self.cancel.is_set():
                    break
                with service.index.lock:  # the index connection is shared with the UI thread
                    text = service.index.content(path) or ""
                chunks = split_chunks(text)[:200]
                vecs: list = []
                for i in range(0, len(chunks), BATCH):
                    vecs += ollama.embed([f"{path}\n{c}" for c in chunks[i:i + BATCH]], model=model)
                with self.lock:
                    self.db.execute("BEGIN")
                    self.db.execute("DELETE FROM chunks WHERE path=?", (path,))
                    for i, (c, v) in enumerate(zip(chunks, vecs)):
                        self.db.execute("INSERT INTO chunks VALUES (?,?,?,?,?,?)",
                                        (path, i, files[path].mtime, model, c, array("f", v).tobytes()))
                    self.db.execute("COMMIT")
                    self._matrix = None
                done += 1
                if progress and (done % 5 == 0 or done == len(todo)):
                    progress(done, len(todo))
            return {"embedded": done, "pending": len(todo) - done}
        finally:
            self.running = False

    def _load(self, model: str):
        if self._matrix is not None and self._matrix[3] == model:
            return self._matrix
        rows = self.db.execute("SELECT path, text, vec FROM chunks WHERE model=?", (model,)).fetchall()
        paths = [r[0] for r in rows]
        texts = [r[1] for r in rows]
        if np is not None and rows:
            mat = np.frombuffer(b"".join(r[2] for r in rows), dtype=np.float32).reshape(len(rows), -1)
            norms = np.linalg.norm(mat, axis=1, keepdims=True)
            mat = mat / np.where(norms == 0, 1, norms)
        else:
            mat = [array("f", r[2]) for r in rows]
        self._matrix = (paths, texts, mat, model)
        return self._matrix

    def search(self, query_vec: list[float], model: str, k: int = 6) -> list[dict]:
        paths, texts, mat, _ = self._load(model)
        if not paths:
            return []
        if np is not None:
            q = np.asarray(query_vec, dtype=np.float32)
            q = q / (np.linalg.norm(q) or 1)
            scores = mat @ q
            order = np.argsort(-scores)[: k * 3]
            ranked = [(float(scores[i]), int(i)) for i in order]
        else:  # pragma: no cover
            qn = sum(x * x for x in query_vec) ** 0.5 or 1
            ranked = sorted(((sum(a * b for a, b in zip(v, query_vec)) / qn, i) for i, v in enumerate(mat)), reverse=True)[: k * 3]
        out, seen = [], {}
        for score, i in ranked:
            if seen.get(paths[i], 0) >= 2:  # at most two chunks per note
                continue
            seen[paths[i]] = seen.get(paths[i], 0) + 1
            out.append({"path": paths[i], "text": texts[i], "score": round(score, 4)})
            if len(out) >= k:
                break
        return out

    def close(self) -> None:
        self.cancel.set()
        self.db.close()


def keyword_retrieve(service, query: str, k: int = 6) -> list[dict]:
    """Fallback retrieval with the full-text index: notes containing most query words."""
    from ..core.search import search
    words = [w for w in re.findall(r"[\wÀ-￿]{3,}", query.lower())][:8]
    if not words:
        return []
    res = search(service.index, " OR ".join(f'"{w}"' for w in words), limit_files=200, context=2, max_matches=3)
    scored = []
    for r in res["results"]:
        text = service.index.content(r["path"]) or ""
        low = text.lower()
        score = sum(low.count(w) for w in words) / (1 + len(text) / 4000)
        scored.append((score, r["path"], text))
    scored.sort(reverse=True)
    out = []
    for score, path, text in scored[:k]:
        chunks = split_chunks(text) or [text[:CHUNK]]
        best = max(chunks, key=lambda c: sum(c.lower().count(w) for w in words))
        out.append({"path": path, "text": best, "score": round(score, 3)})
    return out


def now() -> float:
    return time.time()

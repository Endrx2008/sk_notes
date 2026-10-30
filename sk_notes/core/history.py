"""Version history and file recovery.

Snapshots are zlib-compressed copies of a note stored in ``.sk_notes/history.db``.
A snapshot is taken at most every ``interval`` seconds per file while editing, and
always before destructive operations (delete, rename, AI edits, external overwrite).
Identical content is never stored twice in a row.
"""

from __future__ import annotations

import hashlib
import sqlite3
import threading
import time
import zlib


class History:
    def __init__(self, db_path: str, *, interval: float = 300, keep_days: int = 30, keep_per_file: int = 100):
        self.interval, self.keep_days, self.keep_per_file = interval, keep_days, keep_per_file
        self.lock = threading.Lock()
        try:
            self.db = self._open(db_path)
        except sqlite3.DatabaseError:
            import os
            os.replace(db_path, db_path + ".corrupt")
            self.db = self._open(db_path)

    @staticmethod
    def _open(path: str) -> sqlite3.Connection:
        db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL, ts REAL NOT NULL, hash TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT 'edit', size INTEGER NOT NULL, data BLOB NOT NULL);
            CREATE INDEX IF NOT EXISTS snap_path ON snapshots(path, ts);
        """)
        return db

    def snapshot(self, path: str, text: str, *, reason: str = "edit", force: bool = False) -> bool:
        data = text.encode("utf-8")
        digest = hashlib.sha1(data).hexdigest()
        now = time.time()
        with self.lock:
            last = self.db.execute("SELECT ts, hash FROM snapshots WHERE path=? ORDER BY ts DESC LIMIT 1",
                                   (path,)).fetchone()
            if last and last[1] == digest:
                return False
            if last and not force and now - last[0] < self.interval:
                return False
            self.db.execute("INSERT INTO snapshots(path, ts, hash, reason, size, data) VALUES (?,?,?,?,?,?)",
                            (path, now, digest, reason, len(data), zlib.compress(data, 6)))
            self._prune(path)
            return True

    def _prune(self, path: str) -> None:
        cutoff = time.time() - self.keep_days * 86400
        self.db.execute("DELETE FROM snapshots WHERE path=? AND ts<? AND id NOT IN "
                        "(SELECT id FROM snapshots WHERE path=? ORDER BY ts DESC LIMIT 5)", (path, cutoff, path))
        self.db.execute("DELETE FROM snapshots WHERE path=? AND id NOT IN "
                        "(SELECT id FROM snapshots WHERE path=? ORDER BY ts DESC LIMIT ?)",
                        (path, path, self.keep_per_file))

    def list(self, path: str) -> list[dict]:
        rows = self.db.execute("SELECT id, ts, reason, size FROM snapshots WHERE path=? ORDER BY ts DESC", (path,))
        return [{"id": r[0], "ts": int(r[1] * 1000), "reason": r[2], "size": r[3]} for r in rows]

    def files(self) -> list[dict]:
        """All paths with snapshots (including deleted files) for the recovery view."""
        rows = self.db.execute("SELECT path, MAX(ts), COUNT(*) FROM snapshots GROUP BY path ORDER BY MAX(ts) DESC")
        return [{"path": r[0], "ts": int(r[1] * 1000), "count": r[2]} for r in rows]

    def read(self, snap_id: int) -> str | None:
        row = self.db.execute("SELECT data FROM snapshots WHERE id=?", (snap_id,)).fetchone()
        return zlib.decompress(row[0]).decode("utf-8") if row else None

    def rename(self, old: str, new: str) -> None:
        with self.lock:
            self.db.execute("UPDATE snapshots SET path=? || substr(path, ?) WHERE path=? OR path LIKE ? ESCAPE '\\'",
                            (new, len(old) + 1, old, _like_prefix(old)))

    def close(self) -> None:
        self.db.close()


def _like_prefix(p: str) -> str:
    return p.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "/%"

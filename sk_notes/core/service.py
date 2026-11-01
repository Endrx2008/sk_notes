"""VaultService: the single entry point the UI bridge uses for vault operations.

It keeps the filesystem, the index, the version history and the UI in step and
emits events (``emit(name, payload)``) for every change, whether made by sk_notes
or by another program.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Callable

from . import links, trash
from .history import History
from .index import TEXT_EXT, VaultIndex, ext_of
from .vault import CONFIG_DIR, Vault, VaultError, normalize_path

log = logging.getLogger(__name__)
Emit = Callable[[str, dict], None]


class VaultService:
    def __init__(self, root: str, emit: Emit | None = None):
        self.vault = Vault(root)
        self.emit: Emit = emit or (lambda name, payload: None)
        self.index = VaultIndex(self.vault)
        self.history = History(str(self.vault.config_dir / "history.db"))
        self.lock = threading.RLock()
        # paths written by us recently: the watcher ignores their own echo
        self._own_writes: dict[str, float] = {}

    # ------------------------------------------------------------- lifecycle
    def open(self) -> dict:
        stats = self.index.sync()
        log.info("vault %s opened: %s", self.vault.root, stats)
        return stats

    def close(self) -> None:
        self.index.close()
        self.history.close()

    # ------------------------------------------------------------- config files
    def config_read(self, name: str, default=None):
        p = self.vault.config_dir / name
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    def config_write(self, name: str, data) -> None:
        p = self.vault.config_dir / name
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(p)

    def app_setting(self, key: str, default=None):
        return (self.config_read("app.json", {}) or {}).get(key, default)

    # ------------------------------------------------------------- helpers
    def _mark_own(self, *paths: str) -> None:
        now = time.time()
        for p in paths:
            self._own_writes[normalize_path(p)] = now

    def is_own_echo(self, path: str, window: float = 2.0) -> bool:
        t = self._own_writes.get(normalize_path(path))
        return t is not None and time.time() - t < window

    def _entry(self, path: str) -> dict:
        e = self.vault.stat(path)
        return e.to_json() if e else {"path": path}

    # ------------------------------------------------------------- read/write
    def read(self, path: str) -> dict:
        path = normalize_path(path)
        st = self.vault.stat(path)
        if st is None or st.is_dir:
            raise VaultError("not-found")
        out = {"text": self.vault.read_text(path), "mtime": int(st.mtime * 1000), "size": st.size}
        if ext_of(path) in TEXT_EXT:
            info = self.vault.text_info(path)
            # an editor must not save these back: the text is lossy, or the file read-only
            out["readOnly"] = "not-utf8" if not info["utf8"] else (None if info["writable"] else "read-only")
        return out

    def write(self, path: str, text: str, *, expected_mtime: int | None = None, reason: str = "edit",
              mtime: float | None = None) -> dict:
        """Write a text file. With expected_mtime, refuse (conflict) if the file was
        changed on disk by someone else since it was read: no silent overwrite."""
        path = normalize_path(path)
        with self.lock:
            st = self.vault.stat(path)
            if expected_mtime is not None and st is not None and abs(int(st.mtime * 1000) - expected_mtime) > 2:
                disk = self.vault.read_text(path)
                if disk != text:
                    self.history.snapshot(path, disk, reason="external", force=True)
                    return {"conflict": True, "text": disk, "mtime": int(st.mtime * 1000)}
            is_new = st is None
            if st is not None and ext_of(path) in TEXT_EXT and not self.vault.text_info(path)["utf8"]:
                # its text was decoded with replacement characters: writing it back would
                # destroy the original bytes (Latin-1 notes, binaries named .md)
                raise VaultError("not-utf8")
            if st is not None and ext_of(path) in TEXT_EXT:
                if reason != "edit":
                    try:
                        self.history.snapshot(path, self.vault.read_text(path), reason=reason, force=True)
                    except OSError:
                        pass
            self._mark_own(path)
            entry = self.vault.write_text_keep_eol(path, text, mtime=mtime)
            if ext_of(path) in TEXT_EXT:
                self.history.snapshot(path, text, reason="edit")
            meta = self.index.update(path, text)
            self.emit("create" if is_new else "modify", {"file": entry.to_json(), "metadata": meta,
                                                        **self._links_payload(None if is_new else [path])})
            return {"file": entry.to_json()}

    def write_binary(self, path: str, data: bytes) -> dict:
        path = normalize_path(path)
        with self.lock:
            is_new = not self.vault.exists(path)
            self._mark_own(path)
            entry = self.vault.write_bytes(path, data)
            self.index.update(path)
            self.emit("create" if is_new else "modify", {"file": entry.to_json(), "metadata": None})
            return {"file": entry.to_json()}

    def create(self, path: str, text: str = "") -> dict:
        path = normalize_path(path)
        if self.vault.exists(path):
            raise VaultError("already-exists")
        return self.write(path, text)

    def create_unique(self, folder: str, base: str, ext: str = "md", text: str = "") -> dict:
        path = self.vault.available_path(folder, base, ext)
        return self.write(path, text)

    def mkdir(self, path: str) -> dict:
        path = normalize_path(path)
        with self.lock:
            existed = self.vault.exists(path)
            self.vault.mkdir(path)
            self.index.folders.add(path)
            self.index._add_parent_folders(path + "/x")
            if not existed:
                self.emit("create", {"file": {"path": path, "folder": True}})
            return {"file": {"path": path, "folder": True}}

    # ------------------------------------------------------------- rename / move
    def rename(self, old: str, new: str, *, update_links: bool | None = None) -> dict:
        old, new = normalize_path(old), normalize_path(new)
        if old == new:
            return {"path": new, "updated": []}
        if update_links is None:
            update_links = self.app_setting("alwaysUpdateLinks", True)
        with self.lock:
            src_is_dir = self.vault.abs(old).is_dir()
            moved = {p: new + p[len(old):] for p in self.index.files if p == old or p.startswith(old + "/")}
            refs = links.collect_references(self.index, moved) if update_links else {}
            for p in moved:
                if ext_of(p) in TEXT_EXT:
                    try:
                        self.history.snapshot(p, self.vault.read_text(p), reason="rename", force=True)
                    except OSError:
                        pass
            self._mark_own(old, new, *moved, *moved.values())
            self.vault.rename(old, new)
            self.index.rename(old, new)
            self.history.rename(old, new)
            updated = []
            # a moved note keeps its own relative markdown links working
            for a, b in moved.items():
                if ext_of(b) == "md":
                    text = self._editable_text(b)
                    if text is None:
                        continue
                    fixed = links.relink_moved_note(text, a, b, self.index)
                    if fixed != text and self._rewrite(b, text, fixed, snapshot=False):
                        self.index.update(b, fixed)
            for src, items in refs.items():
                src_now = moved.get(src, src)
                text = self._editable_text(src_now)
                if text is None:
                    continue
                new_text = links.apply_rewrites(text, items, self.index, src_now)
                if new_text != text and self._rewrite(src_now, text, new_text):
                    self.index.update(src_now, new_text)
                    updated.append(src_now)
            if update_links:
                for src in [p for p in self.index.files if ext_of(p) == "canvas"]:
                    text = self._editable_text(src)
                    if text is None:
                        continue
                    new_text = links.relink_canvas(text, moved)
                    if new_text is not None and self._rewrite(src, text, new_text):
                        self.index.update(src, new_text)
                        updated.append(src)
            payload = {"oldPath": old, "file": {"path": new, "folder": src_is_dir} if src_is_dir else self._entry(new),
                       "moved": [[a, b] for a, b in moved.items()], "updated": updated,
                       "metadata": {p: self.index.meta.get(p) for p in set(updated) | set(moved.values())
                                    if p in self.index.meta}}
            payload.update(self._links_payload(None))
            self.emit("rename", payload)
            return {"path": new, "updated": updated}

    def _editable_text(self, path: str) -> str | None:
        """Text of a file that may be rewritten automatically (link updates): None for
        unreadable, read-only or non-UTF-8 files, which are left alone."""
        try:
            data = self.vault.read_bytes(path)
            if not os.access(self.vault.abs(path), os.W_OK):
                return None
            return data.decode("utf-8")
        except (OSError, UnicodeDecodeError, VaultError):
            return None

    def _rewrite(self, path: str, old_text: str, new_text: str, *, snapshot: bool = True) -> bool:
        """Automatic rewrite of one file; a failure skips that file instead of aborting."""
        try:
            if snapshot:
                self.history.snapshot(path, old_text, reason="link-update", force=True)
            self._mark_own(path)
            self.vault.write_text(path, new_text)
            return True
        except (OSError, VaultError) as exc:
            log.warning("could not update links in %s: %s", path, exc)
            return False

    def copy(self, old: str, new: str) -> dict:
        old, new = normalize_path(old), normalize_path(new)
        with self.lock:
            self._mark_own(new)
            self.vault.copy(old, new)
            if self.vault.abs(new).is_dir():
                self.index.sync()
                self.emit("refresh", self.index.snapshot())
            else:
                meta = self.index.update(new)
                self.emit("create", {"file": self._entry(new), "metadata": meta, **self._links_payload(None)})
            return {"path": new}

    # ------------------------------------------------------------- delete
    def delete(self, path: str, *, mode: str | None = None) -> dict:
        path = normalize_path(path)
        mode = mode or self.app_setting("trashOption", "system")
        with self.lock:
            targets = [p for p in self.index.files if p == path or p.startswith(path + "/")]
            for p in targets:
                if ext_of(p) in TEXT_EXT:
                    try:
                        self.history.snapshot(p, self.vault.read_text(p), reason="delete", force=True)
                    except OSError:
                        pass
            was_dir = self.vault.abs(path).is_dir()
            self._mark_own(path, *targets)
            used = trash.delete(self.vault, path, mode)
            gone = self.index.remove(path)
            self.emit("delete", {"file": {"path": path, "folder": was_dir}, "removed": gone,
                                 **self._links_payload(None)})
            return {"mode": used, "removed": gone}

    def restore_snapshot(self, path: str, snap_id: int) -> dict:
        text = self.history.read(snap_id)
        if text is None:
            raise VaultError("not-found")
        path = normalize_path(path)
        if self.vault.exists(path):
            self.history.snapshot(path, self.vault.read_text(path), reason="restore", force=True)
        return self.write(path, text, reason="restore")

    # ------------------------------------------------------------- external changes
    def external_change(self, path: str) -> None:
        """Called by the watcher for changes not made by sk_notes."""
        path = normalize_path(path)
        if self.is_own_echo(path):
            return
        with self.lock:
            st = self.vault.stat(path)
            if st is None:
                if path in self.index.files or path in self.index.folders:
                    was_dir = path in self.index.folders
                    gone = self.index.remove(path)
                    self.emit("delete", {"file": {"path": path, "folder": was_dir}, "removed": gone,
                                         **self._links_payload(None)})
                return
            if st.is_dir:
                if path not in self.index.folders:
                    self.index.sync()
                    self.emit("refresh", self.index.snapshot())
                return
            known = self.index.files.get(path)
            if known and abs(known.mtime - st.mtime) < 1e-6 and known.size == st.size:
                return
            meta = self.index.update(path)
            if ext_of(path) in TEXT_EXT:
                try:
                    self.history.snapshot(path, self.vault.read_text(path), reason="external")
                except OSError:
                    pass
            self.emit("modify" if known else "create",
                      {"file": st.to_json(), "metadata": meta, "external": True,
                       **self._links_payload([path] if known else None)})

    def rescan(self) -> None:
        with self.lock:
            stats = self.index.sync()
            if stats["changed"] or stats["removed"]:
                self.emit("refresh", self.index.snapshot())

    # ------------------------------------------------------------- misc
    def _links_payload(self, paths: list[str] | None) -> dict:
        """Link maps to send after a change: the full maps when names changed (create,
        rename, delete: other notes may resolve differently), otherwise only the
        entries of the changed notes."""
        if paths is None:
            return {"resolvedLinks": self.index.resolved, "unresolvedLinks": self.index.unresolved}
        return {"resolvedPatch": {p: self.index.resolved.get(p, {}) for p in paths},
                "unresolvedPatch": {p: self.index.unresolved.get(p, {}) for p in paths}}

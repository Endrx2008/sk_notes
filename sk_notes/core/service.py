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
from .vault import Vault, VaultError, normalize_path

log = logging.getLogger(__name__)


def _sha(text: str) -> str:
    import hashlib
    return hashlib.sha1(text.encode("utf-8")).hexdigest()
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
        self.recovered_rename: str | None = None

    # ------------------------------------------------------------- lifecycle
    def open(self) -> dict:
        self.recovered_rename = self._recover_rename()
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
            if self.vault.protected:  # SKAI_ Memory: root-owned on disk, editable only after consent + sudo password
                out["readOnly"] = None if self.vault.unlocked else "memory-locked"
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
        if "/" in (old, new):
            raise VaultError("vault-root")
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
            # journal (B-13): a crash between the move and the end of the link updates
            # must not leave thousands of broken links; see _recover_rename()
            self._journal({"phase": "move", "old": old, "new": new})
            self._mark_own(old, new, *moved, *moved.values())
            try:
                self.vault.rename(old, new)
            except BaseException:
                self._journal(None)
                raise
            self.index.rename(old, new)
            self.history.rename(old, new)
            # every rewrite is planned in memory first, then journaled, then written
            plan: list[tuple[str, str, str, bool]] = []  # path, old text, new text, counts as "updated"
            for a, b in moved.items():
                if ext_of(b) == "md":  # a moved note keeps its own relative markdown links working
                    text = self._editable_text(b)
                    if text is not None:
                        fixed = links.relink_moved_note(text, a, b, self.index)
                        if fixed != text:
                            plan.append((b, text, fixed, False))
            planned = {x[0]: x for x in plan}
            for src, items in refs.items():
                src_now = moved.get(src, src)
                prev = planned.get(src_now)
                text = prev[2] if prev else self._editable_text(src_now)
                if text is None:
                    continue
                new_text = links.apply_rewrites(text, items, self.index, src_now)
                if new_text != text:
                    entry = (src_now, prev[1] if prev else text, new_text, True)
                    if prev:
                        plan[plan.index(prev)] = entry
                    else:
                        plan.append(entry)
                    planned[src_now] = entry
            if update_links:
                for src in [p for p in self.index.files if ext_of(p) == "canvas"]:
                    text = self._editable_text(src)
                    if text is not None:
                        new_text = links.relink_canvas(text, moved)
                        if new_text is not None:
                            plan.append((src, text, new_text, True))
            self._journal({"phase": "write", "old": old, "new": new,
                           "writes": [{"path": p_, "sha": _sha(t0), "text": t1} for p_, t0, t1, _u in plan]})
            updated = []
            for path_, text, new_text, counts in plan:
                if self._rewrite(path_, text, new_text, snapshot=counts):
                    self.index.update(path_, new_text)
                    if counts:
                        updated.append(path_)
            self._journal(None)
            payload = {"oldPath": old, "file": {"path": new, "folder": src_is_dir} if src_is_dir else self._entry(new),
                       "moved": [[a, b] for a, b in moved.items()], "updated": updated,
                       "metadata": {p: self.index.meta.get(p) for p in set(updated) | set(moved.values())
                                    if p in self.index.meta}}
            payload.update(self._links_payload(None))
            self.emit("rename", payload)
            return {"path": new, "updated": updated}

    # ------------------------------------------------------------- rename journal
    def _journal_path(self) -> Path:
        return self.vault.config_dir / "rename-journal.json"

    def _journal(self, data: dict | None) -> None:
        p = self._journal_path()
        try:
            if data is None:
                p.unlink(missing_ok=True)
                return
            tmp = p.with_name(p.name + ".tmp")
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, p)
        except OSError as exc:  # read-only vault: rename without a safety net
            log.warning("rename journal not written: %s", exc)

    def _recover_rename(self) -> str | None:
        """Finish or undo a rename that a crash interrupted. 'undone' if the files were
        moved back (crash before the link updates were planned), 'completed' if the
        planned link updates were written now, None if there was nothing to do."""
        p = self._journal_path()
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict):  # damaged or planted: drop it (B2-20)
            self._journal(None)
            return None
        result = None
        try:
            old, new = data["old"], data["new"]
            if data.get("phase") == "move":
                if self.vault.exists(new) and not self.vault.exists(old):
                    self.vault.rename(new, old)
                    result = "undone"
            elif data.get("phase") == "write":
                for w in data.get("writes", []):
                    try:
                        cur = self.vault.read_bytes(w["path"]).decode("utf-8")
                    except (OSError, UnicodeDecodeError, VaultError):
                        continue
                    if _sha(cur) == w["sha"]:  # not written yet, not changed by anyone since
                        self.vault.write_text(w["path"], w["text"])
                result = "completed"
            log.warning("interrupted rename %s -> %s %s", old, new, result or "had nothing left to do")
        except (KeyError, TypeError, AttributeError, OSError, VaultError) as exc:
            log.error("could not recover an interrupted rename: %s", exc)
        self._journal(None)
        return result

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
        if "/" in (old, new) or new.startswith(old + "/"):
            raise VaultError("into-itself" if old != "/" else "vault-root")
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
        if path == "/":
            raise VaultError("vault-root")  # a plugin with an empty folder setting deleted the whole vault (B2-8)
        mode = "permanent" if self.vault.protected else (mode or self.app_setting("trashOption", "system"))
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
        # (no "own echo" shortcut: our own writes are filtered by the stat check below, and a
        # time window hid other programs' changes made right after a save, B2-11)
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
                    self.history.snapshot(path, self.vault.read_text(path), reason="external", force=True)
                except OSError:
                    pass
            self.emit("modify" if known else "create",
                      {"file": st.to_json(), "metadata": meta, "external": True,
                       **self._links_payload([path] if known else None)})

    def external_rename(self, old: str, new: str) -> None:
        """Another program renamed or moved a file or folder inside the vault: update the
        index and tell the page, so open tabs follow it (links are not rewritten)."""
        old, new = normalize_path(old), normalize_path(new)
        if self.is_own_echo(old) or self.is_own_echo(new):
            return
        with self.lock:
            known = old in self.index.files or old in self.index.folders
            if not known or not self.vault.exists(new) or new in self.index.files:
                self.external_change(old)
                self.external_change(new)
                return
            is_dir = old in self.index.folders
            moved = {p: new + p[len(old):] for p in self.index.files if p == old or p.startswith(old + "/")}
            self.index.rename(old, new)
            self.history.rename(old, new)
            payload = {"oldPath": old, "file": {"path": new, "folder": True} if is_dir else self._entry(new),
                       "moved": [[a, b] for a, b in moved.items()], "updated": [], "external": True,
                       "metadata": {p: self.index.meta.get(p) for p in moved.values() if p in self.index.meta}}
            payload.update(self._links_payload(None))
            self.emit("rename", payload)

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

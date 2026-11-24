"""Watches the vault for changes made by other programs (Linux inotify via ctypes).

Every folder gets one inotify watch (child create/modify/delete/move events carry the
file name), so content changes are seen without a watch per file. If inotify is not
available, a periodic rescan is used instead."""

from __future__ import annotations

import ctypes
import ctypes.util
import logging
import os
import struct
from pathlib import Path

from PyQt6.QtCore import QObject, QSocketNotifier, QTimer, pyqtSignal

log = logging.getLogger(__name__)

IN_MODIFY, IN_ATTRIB, IN_CLOSE_WRITE, IN_OPEN = 0x2, 0x4, 0x8, 0x20
IN_MOVED_FROM, IN_MOVED_TO, IN_CREATE, IN_DELETE = 0x40, 0x80, 0x100, 0x200
IN_DELETE_SELF, IN_MOVE_SELF, IN_Q_OVERFLOW, IN_IGNORED, IN_ISDIR = 0x400, 0x800, 0x4000, 0x8000, 0x40000000
IN_NONBLOCK, IN_CLOEXEC = 0o4000, 0o2000000
MASK = (IN_CLOSE_WRITE | IN_MODIFY | IN_ATTRIB | IN_MOVED_FROM | IN_MOVED_TO | IN_CREATE | IN_DELETE
        | IN_DELETE_SELF | IN_MOVE_SELF)
SKIP = {".git", ".trash", "node_modules", ".obsidian", ".sk_notes"}


class VaultWatcher(QObject):
    changed = pyqtSignal(str)  # vault-relative path of a file or folder
    rescan = pyqtSignal()  # too many events / overflow: do a full rescan
    moved = pyqtSignal(str, str)  # a file or folder renamed inside the vault by another program
    opened = pyqtSignal(list)  # files opened (read) by any program, when reads=True (SKAI_ Memory)

    def __init__(self, root: Path, parent=None, reads: bool = False):
        super().__init__(parent)
        self.root = Path(root)
        self.mask = MASK | (IN_OPEN if reads else 0)
        self.opened_files: set[str] = set()
        self.wd_to_dir: dict[int, str] = {}
        self.dir_to_wd: dict[str, int] = {}
        self.pending: set[str] = set()
        self.move_from: dict[int, str] = {}  # inotify cookie -> old path, until its MOVED_TO
        self.moves: list[tuple[str, str]] = []
        self.flush_timer = QTimer(self, singleShot=True, interval=250)
        self.flush_timer.timeout.connect(self._flush)
        self.fd = -1
        self.notifier = None
        self.poll_timer = None
        libc_name = ctypes.util.find_library("c")
        self.libc = ctypes.CDLL(libc_name, use_errno=True) if libc_name else None
        try:
            if self.libc is None:
                raise OSError("no libc")
            self.fd = self.libc.inotify_init1(IN_NONBLOCK | IN_CLOEXEC)
            if self.fd < 0:
                raise OSError(ctypes.get_errno(), "inotify_init1")
            self._add_tree("")
            self.notifier = QSocketNotifier(self.fd, QSocketNotifier.Type.Read, self)
            self.notifier.activated.connect(self._read)
        except OSError as exc:
            log.warning("inotify unavailable (%s): polling every 10 s", exc)
            self.poll_timer = QTimer(self, interval=10_000)
            self.poll_timer.timeout.connect(self.rescan.emit)
            self.poll_timer.start()

    def _add(self, rel: str) -> None:
        path = str(self.root / rel) if rel else str(self.root)
        wd = self.libc.inotify_add_watch(self.fd, os.fsencode(path), self.mask)
        if wd < 0:
            err = ctypes.get_errno()
            if err == 28:  # ENOSPC: max_user_watches reached
                log.warning("inotify watch limit reached; some folders are polled")
                if self.poll_timer is None:
                    self.poll_timer = QTimer(self, interval=15_000)
                    self.poll_timer.timeout.connect(self.rescan.emit)
                    self.poll_timer.start()
            return
        self.wd_to_dir[wd] = rel
        self.dir_to_wd[rel] = wd

    def _add_tree(self, rel: str) -> None:
        self._add(rel)
        base = self.root / rel if rel else self.root
        try:
            entries = list(os.scandir(base))
        except OSError:
            return
        for e in entries:
            if e.is_dir(follow_symlinks=False) and not e.name.startswith(".") and e.name not in SKIP:
                self._add_tree(f"{rel}/{e.name}" if rel else e.name)

    def _read(self) -> None:
        try:
            data = os.read(self.fd, 64 * 1024)
        except BlockingIOError:
            return
        except OSError:
            return
        i = 0
        while i + 16 <= len(data):
            wd, mask, _cookie, length = struct.unpack_from("iIII", data, i)  # noqa: RUF100
            name = data[i + 16:i + 16 + length].rstrip(b"\0").decode("utf-8", "surrogateescape")
            i += 16 + length
            if mask & IN_Q_OVERFLOW:
                self.rescan.emit()
                continue
            if mask & IN_IGNORED:
                d = self.wd_to_dir.pop(wd, None)
                if d is not None:
                    self.dir_to_wd.pop(d, None)
                continue
            folder = self.wd_to_dir.get(wd)
            if folder is None or not name or name.startswith(".") or name in SKIP:
                continue
            if ".skn-tmp-" in name:
                continue
            rel = f"{folder}/{name}" if folder else name
            if mask & IN_OPEN:  # its own event: nothing changed
                if not mask & IN_ISDIR:
                    self.opened_files.add(rel)
                    self.flush_timer.start()
                continue
            if mask & IN_ISDIR and mask & (IN_CREATE | IN_MOVED_TO):
                self._add_tree(rel)
            # a move inside the vault arrives as MOVED_FROM + MOVED_TO with one cookie: report
            # it as a rename so open tabs follow the file (B-16)
            if mask & IN_MOVED_FROM and _cookie:
                self.move_from[_cookie] = rel
                self.flush_timer.start()
                continue
            if mask & IN_MOVED_TO and _cookie in self.move_from:
                self.moves.append((self.move_from.pop(_cookie), rel))
                self.flush_timer.start()
                continue
            self.pending.add(rel)
        if self.pending:
            if len(self.pending) > 500:
                self.pending.clear()
                self.rescan.emit()
            else:
                self.flush_timer.start()

    def _flush(self) -> None:
        moves, self.moves = self.moves, []
        for a, b in moves:
            self.moved.emit(a, b)
        # moved out of the vault (no MOVED_TO seen): that is a delete
        self.pending.update(self.move_from.values())
        self.move_from.clear()
        items, self.pending = sorted(self.pending), set()
        for rel in items:
            self.changed.emit(rel)
        # opened and not changed: read (a write opens the file too)
        written = set(items) | {b for _a, b in moves} | {a for a, _b in moves}
        reads, self.opened_files = sorted(self.opened_files - written), set()
        if reads:
            self.opened.emit(reads)

    def close(self) -> None:
        if self.notifier is not None:
            self.notifier.setEnabled(False)
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1

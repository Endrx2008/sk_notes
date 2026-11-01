"""Vault = a normal folder of files. All paths given to this module are vault-relative
POSIX paths ("Folder/Note.md"); every access is checked to stay inside the vault."""

from __future__ import annotations

import os
import shutil
import stat as statmod
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path

CONFIG_DIR = ".sk_notes"
IGNORED_DIRS = {".git", ".trash", "node_modules", ".obsidian", CONFIG_DIR}
MAX_NAME_BYTES = 255


def eol_of(data: bytes) -> str:
    """Line ending used by a file: '\\r\\n', '\\r' or '\\n' (default)."""
    crlf = data.count(b"\r\n")
    lf = data.count(b"\n") - crlf
    cr = data.count(b"\r") - crlf
    if crlf and crlf >= lf:
        return "\r\n"
    if cr and not lf and not crlf:
        return "\r"
    return "\n"


class VaultError(Exception):
    """User-facing error (bad name, missing file, outside vault, ...)."""


@dataclass
class FileEntry:
    path: str
    is_dir: bool
    size: int = 0
    mtime: float = 0.0
    ctime: float = 0.0

    def to_json(self) -> dict:
        d = {"path": self.path, "folder": self.is_dir}
        if not self.is_dir:
            d.update(size=self.size, mtime=int(self.mtime * 1000), ctime=int(self.ctime * 1000))
        return d


def normalize_path(path: str) -> str:
    """Same rules as the plugin API normalizePath(): '/' separators, no leading or
    trailing slash, no duplicated slashes, NFC unicode, non-breaking spaces → spaces."""
    path = (path or "").replace("\\", "/").replace(" ", " ").replace(" ", " ")
    parts = [p for p in path.split("/") if p not in ("", ".")]
    out = "/".join(parts)
    return unicodedata.normalize("NFC", out) if out else "/"


def check_name(name: str) -> None:
    if not name or name in (".", ".."):
        raise VaultError("empty-name")
    bad = set('\\/:*?"<>|') & set(name) if os.name == "nt" else {"/"} & set(name)
    if bad or "\x00" in name:
        raise VaultError("invalid-characters")
    if len(name.encode("utf-8")) > MAX_NAME_BYTES:
        raise VaultError("name-too-long")


class Vault:
    def __init__(self, root: str | os.PathLike):
        self.root = Path(root).expanduser().resolve()
        if not self.root.is_dir():
            raise VaultError("not-a-folder")

    # ------------------------------------------------------------- paths
    @property
    def name(self) -> str:
        return self.root.name

    @property
    def config_dir(self) -> Path:
        d = self.root / CONFIG_DIR
        d.mkdir(exist_ok=True)
        return d

    def abs(self, rel: str) -> Path:
        rel = normalize_path(rel)
        if rel == "/":
            return self.root
        if any(part == ".." for part in rel.split("/")):
            raise VaultError("outside-vault")
        p = self.root / rel
        # Resolve parent only (the file itself may not exist yet); symlinks inside the
        # vault pointing outside are allowed for reading, as on other note apps.
        try:
            parent = p.parent.resolve()
        except OSError as exc:
            raise VaultError(str(exc)) from exc
        if parent != self.root and self.root not in parent.parents and not p.parent.is_symlink():
            raise VaultError("outside-vault")
        return p

    def rel(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()

    # ------------------------------------------------------------- listing
    def scan(self) -> list[FileEntry]:
        out: list[FileEntry] = []
        root_len = len(str(self.root)) + 1
        stack = [str(self.root)]
        while stack:
            d = stack.pop()
            try:
                it = os.scandir(d)
            except OSError:
                continue
            with it:
                for e in it:
                    name = e.name
                    if name.startswith(".") or name in IGNORED_DIRS:
                        continue
                    rel = e.path[root_len:].replace(os.sep, "/")
                    try:
                        st = e.stat()
                    except OSError:
                        continue  # broken symlink, permission denied
                    if statmod.S_ISDIR(st.st_mode):
                        out.append(FileEntry(rel, True))
                        stack.append(e.path)
                    elif statmod.S_ISREG(st.st_mode):
                        out.append(FileEntry(rel, False, st.st_size, st.st_mtime, _ctime(st)))
        return out

    def stat(self, rel: str) -> FileEntry | None:
        p = self.abs(rel)
        try:
            st = p.stat()
        except OSError:
            return None
        if statmod.S_ISDIR(st.st_mode):
            return FileEntry(normalize_path(rel), True)
        return FileEntry(normalize_path(rel), False, st.st_size, st.st_mtime, _ctime(st))

    def exists(self, rel: str) -> bool:
        return self.abs(rel).exists()

    def list_dir(self, rel: str) -> tuple[list[str], list[str]]:
        p = self.abs(rel)
        files, folders = [], []
        for e in sorted(os.scandir(p), key=lambda x: x.name):
            r = self.rel(Path(e.path))
            (folders if e.is_dir() else files).append(r)
        return files, folders

    # ------------------------------------------------------------- read / write
    def read_text(self, rel: str) -> str:
        data = self.abs(rel).read_bytes()
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            return data.decode("utf-8", errors="replace")

    def text_info(self, rel: str) -> dict:
        """What a text editor must know to save a file back without damaging it."""
        p = self.abs(rel)
        data = p.read_bytes()
        try:
            data.decode("utf-8")
            utf8 = True
        except UnicodeDecodeError:
            utf8 = False
        return {"utf8": utf8, "eol": eol_of(data), "writable": os.access(p, os.W_OK)}

    def write_text_keep_eol(self, rel: str, text: str, *, mtime: float | None = None) -> FileEntry:
        """Write text with the line endings the file already has on disk (CRLF/CR vaults)."""
        p = self.abs(rel)
        eol = "\n"
        if p.is_file():
            try:
                with open(p, "rb") as fh:
                    eol = eol_of(fh.read(65536))
            except OSError:
                pass
        if eol != "\n":
            text = text.replace("\r\n", "\n").replace("\n", eol)
        return self.write_text(rel, text, mtime=mtime)

    def read_bytes(self, rel: str) -> bytes:
        return self.abs(rel).read_bytes()

    def write_text(self, rel: str, text: str, *, mtime: float | None = None) -> FileEntry:
        return self.write_bytes(rel, text.encode("utf-8"), mtime=mtime)

    def write_bytes(self, rel: str, data: bytes, *, mtime: float | None = None) -> FileEntry:
        p = self.abs(rel)
        for part in normalize_path(rel).split("/"):
            check_name(part)
        if p.exists() and not p.is_dir() and not os.access(p, os.W_OK):
            raise VaultError("read-only")  # the atomic replace below would ignore the mode
        p.parent.mkdir(parents=True, exist_ok=True)
        # atomic replace: a crash never leaves a half-written note
        tmp = p.with_name(f".{p.name}.skn-tmp-{os.getpid()}")
        try:
            with open(tmp, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            if p.exists():
                try:
                    shutil.copymode(p, tmp)
                except OSError:
                    pass
            os.replace(tmp, p)
        finally:
            if tmp.exists():
                tmp.unlink(missing_ok=True)
        if mtime is not None:
            os.utime(p, (mtime, mtime))
        return self.stat(rel)

    def create(self, rel: str, text: str = "") -> FileEntry:
        if self.abs(rel).exists():
            raise VaultError("already-exists")
        return self.write_text(rel, text)

    def mkdir(self, rel: str) -> None:
        for part in normalize_path(rel).split("/"):
            check_name(part)
        self.abs(rel).mkdir(parents=True, exist_ok=True)

    def rename(self, old: str, new: str) -> None:
        src, dst = self.abs(old), self.abs(new)
        if not src.exists():
            raise VaultError("not-found")
        for part in normalize_path(new).split("/"):
            check_name(part)
        same_file = src.resolve() == dst.resolve() if dst.exists() else False
        if dst.exists() and not same_file:
            raise VaultError("already-exists")
        dst.parent.mkdir(parents=True, exist_ok=True)
        if same_file and src.name != dst.name:  # case-only rename on case-insensitive fs
            tmp = src.with_name(src.name + ".skn-rename")
            os.rename(src, tmp)
            os.rename(tmp, dst)
        else:
            os.rename(src, dst)

    def copy(self, old: str, new: str) -> None:
        src, dst = self.abs(old), self.abs(new)
        if dst.exists():
            raise VaultError("already-exists")
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)

    def delete_permanently(self, rel: str) -> None:
        p = self.abs(rel)
        if p.is_dir() and not p.is_symlink():
            shutil.rmtree(p)
        else:
            p.unlink()

    def available_path(self, folder: str, base: str, ext: str) -> str:
        """First free 'base.ext', 'base 1.ext', 'base 2.ext' ... inside folder."""
        folder = "" if normalize_path(folder) == "/" else normalize_path(folder) + "/"
        dot = f".{ext}" if ext else ""
        candidate = f"{folder}{base}{dot}"
        n = 1
        while self.abs(candidate).exists():
            candidate = f"{folder}{base} {n}{dot}"
            n += 1
        return candidate


def _ctime(st: os.stat_result) -> float:
    return getattr(st, "st_birthtime", None) or min(st.st_ctime, st.st_mtime)


def now_ms() -> int:
    return int(time.time() * 1000)

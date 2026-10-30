"""Deleting files: system trash (freedesktop.org spec), the vault's ``.trash`` folder,
or permanent deletion – chosen in Settings → Files and links."""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from urllib.parse import quote

from .vault import Vault


def _unique(dest_dir: Path, name: str) -> Path:
    candidate = dest_dir / name
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        stem, ext = name, ""
    n = 1
    while candidate.exists() or candidate.is_symlink():
        candidate = dest_dir / (f"{stem} {n}.{ext}" if ext else f"{stem} {n}")
        n += 1
    return candidate


def to_local_trash(vault: Vault, rel: str) -> str:
    src = vault.abs(rel)
    trash = vault.root / ".trash"
    trash.mkdir(exist_ok=True)
    dest = _unique(trash, src.name)
    shutil.move(str(src), str(dest))
    return dest.name


def _home_trash() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return Path(base) / "Trash"


def to_system_trash(vault: Vault, rel: str) -> bool:
    """Move to the user's trash. Returns False when not possible (other filesystem
    without a .Trash dir, permission problems); the caller then falls back."""
    src = vault.abs(rel)
    trash = _home_trash()
    try:
        (trash / "files").mkdir(parents=True, exist_ok=True)
        (trash / "info").mkdir(parents=True, exist_ok=True)
        if os.stat(trash).st_dev != os.stat(src).st_dev:
            return False
        dest = _unique(trash / "files", src.name)
        info = trash / "info" / (dest.name + ".trashinfo")
        info.write_text("[Trash Info]\nPath={}\nDeletionDate={}\n".format(
            quote(str(src.absolute())), time.strftime("%Y-%m-%dT%H:%M:%S")), encoding="utf-8")
        try:
            os.rename(src, dest)
        except OSError:
            info.unlink(missing_ok=True)
            return False
        return True
    except OSError:
        return False


def delete(vault: Vault, rel: str, mode: str) -> str:
    """mode: 'system' | 'local' | 'permanent'. Returns the mode actually used."""
    if mode == "system" and to_system_trash(vault, rel):
        return "system"
    if mode in ("system", "local"):
        to_local_trash(vault, rel)
        return "local"
    vault.delete_permanently(rel)
    return "permanent"

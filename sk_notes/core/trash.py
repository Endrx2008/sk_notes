"""Deleting files: system trash (freedesktop.org spec), the vault's ``.trash`` folder,
or permanent deletion – chosen in Settings → Files and links.

The trash of a vault (opened from the menu of the settings wheel) lists what this vault deleted
in the last three months: the files of its ``.trash`` folder (when and from where each came is
written in ``.trash/.skn-trash.json``, the same file the Android app writes) and the files of the
system trash that came from inside the vault (their ``.trashinfo`` says from where and when).
Older ones are removed for good when the vault opens and whenever the trash is listed; files
other folders sent to the system trash are never touched."""

from __future__ import annotations

import json
import os
import shutil
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, unquote

from .vault import Vault, VaultError, normalize_path

KEEP_SECONDS = 90 * 24 * 3600  # three months
LOG = ".skn-trash.json"
SYS = "system:"  # ids of entries of the system trash


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
    log = _read_log(vault)
    log[dest.name] = {"from": normalize_path(rel), "at": int(time.time() * 1000)}
    _write_log(vault, log)
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


# ----------------------------------------------------------------- the trash of a vault
def _read_log(vault: Vault) -> dict:
    try:
        v = json.loads((vault.root / ".trash" / LOG).read_text(encoding="utf-8"))
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_log(vault: Vault, log: dict) -> None:
    try:
        (vault.root / ".trash").mkdir(exist_ok=True)
        (vault.root / ".trash" / LOG).write_text(json.dumps(log, indent=1, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass  # read-only vault: dates are guessed again next time


def _remove(p: Path) -> None:
    if p.is_dir() and not p.is_symlink():
        shutil.rmtree(p)
    else:
        p.unlink(missing_ok=True)


def _system_entries(vault: Vault):
    """(name, original absolute path, deletion time in s) of system-trash files from this vault."""
    info_dir = _home_trash() / "info"
    root = str(vault.root.resolve())
    try:
        infos = list(info_dir.glob("*.trashinfo"))
    except OSError:
        return
    for info in infos:
        try:
            fields = dict(line.split("=", 1) for line in info.read_text(encoding="utf-8").splitlines() if "=" in line)
        except (OSError, ValueError):
            continue
        orig = unquote(fields.get("Path", ""))
        if not orig.startswith(root + "/"):
            continue
        try:
            at = datetime.strptime(fields.get("DeletionDate", ""), "%Y-%m-%dT%H:%M:%S").timestamp()
        except ValueError:
            at = info.stat().st_mtime
        yield info.name[: -len(".trashinfo")], orig, at


def list_trash(vault: Vault, now: float | None = None) -> list[dict]:
    """What this vault deleted, newest first: [{id, name, from, at (ms), folder, size}].
    Removes what is older than three months."""
    now = time.time() if now is None else now
    out: list[dict] = []
    root = str(vault.root.resolve())
    trash = vault.root / ".trash"
    if trash.is_dir() and not vault.protected:
        log = _read_log(vault)
        keep: dict = {}
        changed = False
        for p in sorted(trash.iterdir()):
            if p.name == LOG:
                continue
            e = log.get(p.name)
            if not isinstance(e, dict) or not isinstance(e.get("at"), (int, float)):
                e = {"from": (e or {}).get("from", p.name) if isinstance(e, dict) else p.name, "at": int(now * 1000)}
                changed = True
            if now - e["at"] / 1000 > KEEP_SECONDS:
                try:
                    _remove(p)
                    changed = True
                    continue
                except OSError:
                    pass
            keep[p.name] = e
            out.append({"id": p.name, "name": p.name, "from": e.get("from") or p.name, "at": int(e["at"]),
                        "folder": p.is_dir(), "size": p.stat().st_size if p.is_file() else 0})
        if changed or set(keep) != set(log):
            _write_log(vault, keep)
    files = _home_trash() / "files"
    for name, orig, at in list(_system_entries(vault)):
        p = files / name
        info = _home_trash() / "info" / (name + ".trashinfo")
        if not p.exists() and not p.is_symlink():
            continue
        if now - at > KEEP_SECONDS:
            try:
                _remove(p)
                info.unlink(missing_ok=True)
            except OSError:
                pass
            continue
        out.append({"id": SYS + name, "name": Path(orig).name, "from": orig[len(root) + 1:], "at": int(at * 1000),
                    "folder": p.is_dir(), "size": p.stat().st_size if p.is_file() else 0})
    out.sort(key=lambda e: (-e["at"], e["name"]))
    return out


def _locate(vault: Vault, item_id: str) -> tuple[Path, str, Path | None]:
    """(file in a trash, its place in the vault, its .trashinfo or None) – only what this vault deleted."""
    item_id = str(item_id or "")
    if item_id.startswith(SYS):
        name = item_id[len(SYS):]
        if not name or "/" in name or name in (".", ".."):
            raise VaultError("not-found")
        for n, orig, _at in _system_entries(vault):
            if n == name:
                return _home_trash() / "files" / name, orig[len(str(vault.root.resolve())) + 1:], _home_trash() / "info" / (name + ".trashinfo")
        raise VaultError("not-found")
    if not item_id or "/" in item_id or item_id in (".", "..", LOG):
        raise VaultError("not-found")
    p = vault.root / ".trash" / item_id
    if not p.exists() and not p.is_symlink():
        raise VaultError("not-found")
    return p, (_read_log(vault).get(item_id) or {}).get("from") or item_id, None


def restore(vault: Vault, item_id: str) -> str:
    """Put a deleted file back where it was (under another name when the place is taken).
    Returns its path in the vault."""
    src, rel, info = _locate(vault, item_id)
    rel = normalize_path(rel)
    if rel == "/" or any(part in ("..", ".trash") for part in rel.split("/")):
        rel = src.name
    folder, _, name = rel.rpartition("/")
    parent = vault.abs(folder) if folder else vault.root
    parent.mkdir(parents=True, exist_ok=True)
    dest = _unique(parent, name)
    shutil.move(str(src), str(dest))
    if info is not None:
        info.unlink(missing_ok=True)
    else:
        log = _read_log(vault)
        log.pop(item_id, None)
        _write_log(vault, log)
    return (folder + "/" if folder else "") + dest.name


def purge(vault: Vault, item_id: str | None = None) -> bool:
    """Remove one deleted file for good; without an id, everything this vault deleted."""
    ids = [e["id"] for e in list_trash(vault)] if item_id is None else [item_id]
    log = _read_log(vault)
    for i in ids:
        src, _rel, info = _locate(vault, i)
        _remove(src)
        if info is not None:
            info.unlink(missing_ok=True)
        else:
            log.pop(i, None)
    _write_log(vault, log)
    return True

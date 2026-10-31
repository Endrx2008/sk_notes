"""sknotes:// links: parsing, choosing the vault, and handing a link to the process
that already has that vault open (one process per vault, see SkNotesApp).

    sknotes://open?vault=Notes&file=Projects/Plan
    sknotes://open?path=/home/me/Notes/Projects/Plan.md
    sknotes://new?vault=Notes&name=Idea&content=...&append=true
    sknotes://search?vault=Notes&query=tag:%23todo

Other actions are passed to the page, where plugins can register handlers for them."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

SCHEME = "sknotes"


class UriError(ValueError):
    pass


def parse(uri: str) -> tuple[str, dict[str, str]]:
    """'sknotes://open?vault=a&file=b' → ('open', {'vault': 'a', 'file': 'b'})."""
    parts = urlsplit(uri.strip())
    if parts.scheme.lower() != SCHEME:
        raise UriError(f"not a {SCHEME}:// link")
    action = (parts.netloc or parts.path.lstrip("/")).split("/")[0].lower()
    if not action:
        raise UriError("missing action")
    params = dict(parse_qsl(parts.query, keep_blank_values=True))
    return action, params


def find_vault(params: dict[str, str], known: list[str]) -> str | None:
    """The vault a link refers to: by absolute file path, by vault path, or by folder name."""
    if params.get("path"):
        target = Path(params["path"]).expanduser()
        best = None
        for v in known:
            root = Path(v)
            if target == root or root in target.parents:
                if best is None or len(str(root)) > len(best):
                    best = str(root)
        return best
    name = params.get("vault")
    if name:
        for v in known:
            if v == name or Path(v).name == name:
                return v
    return None


def vault_relative(params: dict[str, str], vault: str) -> dict[str, str]:
    """Turn an absolute `path` into a vault-relative `file` for the page."""
    out = dict(params)
    if out.get("path"):
        try:
            out["file"] = Path(out.pop("path")).expanduser().relative_to(vault).as_posix()
        except ValueError:
            out.pop("path", None)
    return out


def server_name(vault: str) -> str:
    """Local socket name of the process that has `vault` open."""
    digest = hashlib.sha1(str(Path(vault)).encode()).hexdigest()[:16]
    return f"sk_notes-{os.getuid()}-{digest}"

"""Per-plugin permissions for the parts of a community plugin that reach outside the
page: files outside the vault, child processes, network, external URLs, clipboard.

Everything that decides what plugins may do is stored on this machine, not in the vault
(a shared, synced or downloaded vault must not arrive with its plugins already allowed,
B2-5): ``<config>/sk_notes/vault-trust/<vault hash>.json`` with
``{"plugins": bool, "trusted": [ids], "permissions": {id: {perm: "allow"|"deny"}},
"paths": [picked folders]}``. ``plugins`` replaces the vault's restricted-mode switch.
The first time a plugin needs a permission, a native dialog asks the user:
Allow once / Always allow / Deny."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path

from PyQt6.QtWidgets import QMessageBox

from ..app import config
from ..app.bridge import ApiError, Ctx
from ..core import i18n

log = logging.getLogger(__name__)

PERMISSIONS = ("fs-outside-vault", "exec", "network", "open-external", "clipboard")
_session: dict[tuple[str, str], bool] = {}  # "allow once" answers for this run


def _store_path(app) -> Path | None:
    if not app.service:
        return None
    root = str(Path(app.service.vault.root).resolve())
    return config.config_dir() / "vault-trust" / (hashlib.sha1(root.encode("utf-8")).hexdigest()[:20] + ".json")


def _store(app) -> dict:
    data = {}
    p = _store_path(app)
    if p is not None:
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
    if not isinstance(data, dict):
        data = {}
    data.setdefault("plugins", False)
    for key, empty in (("trusted", []), ("permissions", {}), ("paths", [])):
        if not isinstance(data.get(key), type(empty)):
            data[key] = empty
    return data


def _save(app, data: dict) -> None:
    p = _store_path(app)
    if p is None:
        return
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def all_permissions(app) -> dict:
    return {k: v for k, v in _store(app)["permissions"].items() if isinstance(v, dict)}


def status(app, plugin: str, perm: str) -> str | None:
    return (_store(app)["permissions"].get(plugin) or {}).get(perm)


def set_status(app, plugin: str, perm: str, value: str | None) -> None:
    data = _store(app)
    entry = data["permissions"].setdefault(plugin, {})
    if value is None:
        entry.pop(perm, None)
    else:
        entry[perm] = value
    _save(app, data)
    if perm == "network":
        refresh_network(app)


def forget_plugin(app, plugin: str) -> None:
    """A removed plugin loses its trust and answers: a new copy must be confirmed again (B2-7)."""
    data = _store(app)
    data["permissions"].pop(plugin, None)
    data["trusted"] = [x for x in data["trusted"] if x != plugin]
    _save(app, data)
    refresh_network(app)


def plugins_allowed(app) -> bool:
    """Community plugins may run in this vault (restricted mode off), decided on this machine."""
    return bool(_store(app)["plugins"])


def set_plugins_allowed(app, value: bool) -> None:
    data = _store(app)
    data["plugins"] = bool(value)
    _save(app, data)
    refresh_network(app)


def active_plugins(app) -> list[str]:
    """Plugins that may run: enabled in the vault, trusted here, and plugins allowed."""
    if not app.service or not plugins_allowed(app):
        return []
    trusted = set(_store(app)["trusted"])
    return [p for p in (app.service.config_read("community-plugins.json", []) or []) if p in trusted]


def refresh_network(app) -> None:
    """Remote fetch() from the page is allowed only while an active plugin holds 'network'."""
    perms = _store(app)["permissions"]
    app.network_plugins = {p for p in active_plugins(app) if (perms.get(p) or {}).get("network") == "allow"}




def confirm(app, title: str, text: str, detail: str = "", ok: str = "") -> bool:
    """Native yes/no dialog: page code (plugins included) cannot answer it for the user.
    SKN_TEST_CONFIRM=yes|no answers it in automated UI tests."""
    auto = os.environ.get("SKN_TEST_CONFIRM")
    if auto in ("yes", "no"):
        log.info("confirm %r answered %s by SKN_TEST_CONFIRM", title, auto)
        return auto == "yes"
    strings = i18n.strings(app.language)
    box = QMessageBox(app.windows[0] if app.windows else None)
    box.setIcon(QMessageBox.Icon.Warning)
    box.setWindowTitle(title)
    box.setText(text)
    box.setInformativeText((detail[:600] + "\n\n" if detail else "") + strings.get("perm.warning", ""))
    yes = box.addButton(ok or strings.get("perm.always", "Allow"), QMessageBox.ButtonRole.AcceptRole)
    no = box.addButton(strings.get("perm.cancel", "Cancel"), QMessageBox.ButtonRole.RejectRole)
    box.setDefaultButton(no)
    box.exec()
    return box.clickedButton() is yes


def is_trusted(app, plugin: str) -> bool:
    return plugin in _store(app)["trusted"]


def trust(app, plugin: str, value: bool = True) -> None:
    data = _store(app)
    lst = [x for x in data["trusted"] if x != plugin]
    if value:
        lst.append(plugin)
    data["trusted"] = lst
    _save(app, data)


_chosen: set[str] = set()


def remember_path(app, path: str, persist: bool = False) -> None:
    """A path the user picked in a native file dialog (page code cannot fake that)."""
    real = os.path.realpath(os.path.expanduser(path))
    _chosen.add(real)
    if persist and app.service:
        data = _store(app)
        data["paths"] = [x for x in data["paths"] if x != real][-19:] + [real]
        _save(app, data)


def chosen(app, path: str) -> bool:
    """True if `path` is, or is inside, a location the user picked."""
    real = os.path.realpath(os.path.expanduser(path))
    picked = _chosen | set(_store(app)["paths"])
    return any(real == c or real.startswith(c.rstrip(os.sep) + os.sep) for c in picked)


def require(app, ctx: Ctx, perm: str, detail: str = "") -> None:
    """Raise ApiError('permission-denied') unless the plugin may use `perm`."""
    if not ctx.plugin:
        # no plugin token: page code that is not a plugin's own shims (e.g. a plugin
        # calling the API directly). Permissions belong to identified plugins only.
        raise ApiError("permission-denied", f"unidentified caller: {perm}")
    plugin = ctx.plugin
    st = status(app, plugin, perm)
    if st == "allow" or _session.get((plugin, perm)):
        return
    if st == "deny":
        raise ApiError("permission-denied", f"{plugin}: {perm}")
    strings = i18n.strings(app.language)
    name = _plugin_name(app, plugin)
    box = QMessageBox(app.windows[0] if app.windows else None)
    box.setIcon(QMessageBox.Icon.Warning)
    box.setWindowTitle(strings.get("perm.title", "Permission request"))
    box.setText(strings.get("perm.question", "{plugin} wants to: {what}").replace("{plugin}", name)
                .replace("{what}", strings.get(f"perm.{perm}", perm)))
    box.setInformativeText((detail[:400] + "\n\n" if detail else "") + strings.get("perm.warning", ""))
    once = box.addButton(strings.get("perm.once", "Allow once"), QMessageBox.ButtonRole.AcceptRole)
    always = box.addButton(strings.get("perm.always", "Always allow"), QMessageBox.ButtonRole.YesRole)
    deny = box.addButton(strings.get("perm.deny", "Deny"), QMessageBox.ButtonRole.RejectRole)
    box.setDefaultButton(deny)
    box.exec()
    clicked = box.clickedButton()
    log.info("permission %s for %s: %s", perm, plugin, "once" if clicked is once else "always" if clicked is always else "deny")
    if clicked is always:
        set_status(app, plugin, perm, "allow")
        return
    if clicked is once:
        _session[(plugin, perm)] = True
        return
    set_status(app, plugin, perm, "deny")
    raise ApiError("permission-denied", f"{plugin}: {perm}")


def _plugin_name(app, plugin: str) -> str:
    try:
        import json
        m = json.loads((app.service.vault.config_dir / "plugins" / plugin / "manifest.json").read_text(encoding="utf-8"))
        return m.get("name") or plugin
    except (OSError, ValueError, AttributeError):
        return plugin

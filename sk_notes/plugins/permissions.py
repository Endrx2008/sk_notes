"""Per-plugin permissions for the parts of a community plugin that reach outside the
page: files outside the vault, child processes, network, external URLs, clipboard.

Stored per vault in .sk_notes/permissions.json: {plugin_id: {permission: "allow"|"deny"}}.
The first time a plugin needs a permission, a native dialog asks the user:
Allow once / Always allow / Deny."""

from __future__ import annotations

import logging
import os

from PyQt6.QtWidgets import QMessageBox

from ..app.bridge import ApiError, Ctx
from ..core import i18n

log = logging.getLogger(__name__)

PERMISSIONS = ("fs-outside-vault", "exec", "network", "open-external", "clipboard")
_session: dict[tuple[str, str], bool] = {}  # "allow once" answers for this run


def _store(app) -> dict:
    return app.service.config_read("permissions.json", {}) or {} if app.service else {}


def status(app, plugin: str, perm: str) -> str | None:
    return (_store(app).get(plugin) or {}).get(perm)


def set_status(app, plugin: str, perm: str, value: str | None) -> None:
    data = _store(app)
    entry = data.setdefault(plugin, {})
    if value is None:
        entry.pop(perm, None)
    else:
        entry[perm] = value
    app.service.config_write("permissions.json", data)
    if perm == "network":
        refresh_network(app)


def refresh_network(app) -> None:
    """Remote fetch() from the page is allowed only while an enabled plugin holds 'network'."""
    data = _store(app)
    enabled = set(app.service.config_read("community-plugins.json", []) or []) if app.service else set()
    app.network_plugins = {p for p, perms in data.items()
                           if isinstance(perms, dict) and perms.get("network") == "allow" and p in enabled}


TRUSTED_KEY = "__trusted__"  # plugin ids the user confirmed once (not a valid plugin id)


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
    return plugin in (_store(app).get(TRUSTED_KEY) or [])


def trust(app, plugin: str, value: bool = True) -> None:
    data = _store(app)
    lst = [x for x in (data.get(TRUSTED_KEY) or []) if x != plugin]
    if value:
        lst.append(plugin)
    data[TRUSTED_KEY] = lst
    app.service.config_write("permissions.json", data)


PATHS_KEY = "__paths__"  # folders outside the vault the user picked in a native dialog
_chosen: set[str] = set()


def remember_path(app, path: str, persist: bool = False) -> None:
    """A path the user picked in a native file dialog (page code cannot fake that)."""
    real = os.path.realpath(os.path.expanduser(path))
    _chosen.add(real)
    if persist and app.service:
        data = _store(app)
        lst = [x for x in (data.get(PATHS_KEY) or []) if x != real][-19:]
        data[PATHS_KEY] = lst + [real]
        app.service.config_write("permissions.json", data)


def chosen(app, path: str) -> bool:
    """True if `path` is, or is inside, a location the user picked."""
    real = os.path.realpath(os.path.expanduser(path))
    picked = _chosen | set(_store(app).get(PATHS_KEY) or [])
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

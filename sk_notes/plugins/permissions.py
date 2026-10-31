"""Per-plugin permissions for the parts of a community plugin that reach outside the
page: files outside the vault, child processes, network, external URLs, clipboard.

Stored per vault in .sk_notes/permissions.json: {plugin_id: {permission: "allow"|"deny"}}.
The first time a plugin needs a permission, a native dialog asks the user:
Allow once / Always allow / Deny."""

from __future__ import annotations

import logging

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
    app.network_plugins = {p for p, perms in data.items() if perms.get("network") == "allow" and p in enabled}


def require(app, ctx: Ctx, perm: str, detail: str = "") -> None:
    """Raise ApiError('permission-denied') unless the plugin may use `perm`."""
    plugin = ctx.plugin or "unknown-plugin"
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

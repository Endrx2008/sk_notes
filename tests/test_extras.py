"""Importers, read-only migration of another app's settings, and plugin permissions."""

from __future__ import annotations

import base64
import os
import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace

import yaml

from sk_notes.app.bridge import ApiError, Ctx
from sk_notes.extras import importers, migrate
from sk_notes.plugins import api as plugin_api
from sk_notes.plugins import permissions
from tests.test_vault import make_vault


def front(md: bytes) -> tuple[dict, str]:
    text = md.decode()
    if not text.startswith("---\n"):
        return {}, text
    head, body = text[4:].split("\n---\n", 1)
    return yaml.safe_load(head), body


class ImporterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, rel: str, data) -> Path:
        p = self.dir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data if isinstance(data, bytes) else data.encode())
        return p

    def test_safe_name(self):
        self.assertEqual(importers.safe_name('a/b:c*?"<>|#^[x]'), "a b c x")
        self.assertEqual(importers.safe_name("  ..  "), "Untitled")
        self.assertEqual(len(importers.safe_name("x" * 500)), 120)

    def test_markdown_folder_skips_hidden(self):
        self.write("src/a.md", "A")
        self.write("src/sub/b.md", "B")
        self.write("src/.git/config", "x")
        out = dict(importers.import_markdown_folder(self.dir / "src"))
        self.assertEqual(set(out), {"a.md", "sub/b.md"})

    def test_enex_with_attachment_and_tags(self):
        img = b"\x89PNG fake"
        h = hashlib.md5(img).hexdigest()  # noqa: S324 - same scheme as Evernote
        content = f'<en-note><div>Hello <b>world</b></div><en-media type="image/png" hash="{h}"/></en-note>'
        enex = f"""<?xml version="1.0"?><en-export><note><title>My/Note</title>
<content><![CDATA[{content}]]></content><created>20240102T030405Z</created><tag>work</tag>
<resource><data encoding="base64">{base64.b64encode(img).decode()}</data><mime>image/png</mime>
<resource-attributes><file-name>pic.png</file-name></resource-attributes></resource></note></en-export>"""
        out = dict(importers.import_enex(self.write("Book.enex", enex)))
        self.assertIn("Book/My Note.md", out)
        meta, body = front(out["Book/My Note.md"])
        self.assertEqual(meta["tags"], ["work"])
        self.assertTrue(str(meta["created"]).startswith("2024-01-02"))
        self.assertIn("**world**", body)
        self.assertIn("![[pic.png]]", body)
        self.assertEqual(out["Book/attachments/pic.png"], img)

    def test_notion_zip_strips_ids_and_rewrites_links(self):
        zpath = self.dir / "export.zip"
        nid = "0123456789abcdef0123456789abcdef"
        with zipfile.ZipFile(zpath, "w") as z:
            z.writestr(f"Home {nid}.md", f"See [Other](Other%20{nid}.md) and [web](https://x.org/a.md)")
            z.writestr(f"Other {nid}.md", "Other page")
        out = dict(importers.import_notion(zpath))
        self.assertEqual(set(out), {"Home.md", "Other.md"})
        self.assertIn("[[Other|Other]]", out["Home.md"].decode())
        self.assertIn("(https://x.org/a.md)", out["Home.md"].decode())

    def test_roam_todo_and_nesting(self):
        data = [{"title": "Page", "create-time": 0, "children": [
            {"string": "{{[[TODO]]}} task", "children": [{"string": "child"}]}]}]
        out = dict(importers.import_roam(self.write("roam.json", json.dumps(data))))
        _meta, body = front(out["Page.md"])
        self.assertIn("- [ ] task", body)
        self.assertIn("    - child", body)

    def test_keep_skips_trash_and_keeps_lists(self):
        self.write("Keep/a.json", json.dumps({"title": "Shop", "listContent": [{"text": "milk", "isChecked": True}],
                                              "labels": [{"name": "home"}]}))
        self.write("Keep/b.json", json.dumps({"title": "Old", "textContent": "x", "isTrashed": True}))
        self.write("Keep/c.json", "not json")
        out = dict(importers.import_keep(self.dir / "Keep"))
        self.assertEqual(set(out), {"Shop.md"})
        meta, body = front(out["Shop.md"])
        self.assertEqual(meta["tags"], ["home"])
        self.assertIn("- [x] milk", body)

    def test_csv_types(self):
        out = dict(importers.import_csv(self.write("t.csv", "name;qty;price;done\nApple;3;1.5;true\n")))
        meta, _ = front(out["Apple.md"])
        self.assertEqual(meta, {"qty": 3, "price": 1.5, "done": True})

    def test_html_title_and_scripts_removed(self):
        out = dict(importers.import_html(self.write("p.html", "<html><head><title>T &amp; U</title>"
                                                               "<script>alert(1)</script></head><body><h1>H</h1><p>x</p></body></html>")))
        md = out["T & U.md"].decode()
        self.assertIn("# H", md)
        self.assertNotIn("alert", md)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        files = {
            "note.md": "hello",
            ".obsidian/app.json": json.dumps({"useMarkdownLinks": True, "tabSize": 2, "unknownKey": 1}),
            ".obsidian/appearance.json": json.dumps({"theme": "moonstone", "baseFontSize": 18}),
            ".obsidian/hotkeys.json": json.dumps({"editor:toggle-bold": [{"modifiers": ["Mod"], "key": "B"}], "app:reload": []}),
            ".obsidian/snippets/a.css": "body{}",
            ".obsidian/community-plugins.json": json.dumps(["demo"]),
            ".obsidian/plugins/demo/manifest.json": json.dumps({"id": "demo", "name": "Demo"}),
            ".obsidian/plugins/demo/main.js": "module.exports = {}",
            ".obsidian/graph.json": json.dumps({"colorGroups": [{"query": "tag:#x", "color": {"rgb": 16711680}}]}),
        }
        self.tmp, self.svc = make_vault(files)
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.svc.close()
        self.tmp.cleanup()

    def snapshot(self) -> dict:
        return {p.relative_to(self.root).as_posix(): p.read_bytes()
                for p in (self.root / ".obsidian").rglob("*") if p.is_file()}

    def test_scan(self):
        res = migrate.scan(self.root)
        items = {i["id"]: i for i in res["items"]}
        self.assertTrue(res["found"])
        self.assertEqual(items["settings"]["data"]["useMarkdownLinks"], True)
        self.assertEqual(items["settings"]["data"]["theme"], "light")
        self.assertNotIn("unknownKey", items["settings"]["data"])
        self.assertNotIn("app:reload", items["hotkeys"]["data"])
        self.assertEqual(items["plugins"]["data"][0]["enabled"], True)
        self.assertEqual(items["graph"]["data"]["colorGroups"], [{"query": "tag:#x", "color": "#ff0000"}])

    def test_no_source_folder(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(migrate.scan(Path(d)), {"found": False})

    def test_apply_copies_and_never_touches_source(self):
        before = self.snapshot()
        done = migrate.apply(self.svc, ["settings", "hotkeys", "snippets", "plugins", "graph", "missing"])
        self.assertEqual(set(done), {"settings", "hotkeys", "snippets", "plugins", "graph"})
        self.assertEqual(self.snapshot(), before)
        cfg = self.svc.vault.config_dir
        self.assertTrue((cfg / "snippets" / "a.css").exists())
        self.assertTrue((cfg / "plugins" / "demo" / "main.js").exists())
        self.assertEqual(self.svc.config_read("community-plugins.json", []), ["demo"])
        self.assertEqual(self.svc.config_read("app.json", {})["tabSize"], 2)
        self.assertEqual(self.svc.config_read("appearance.json", {})["baseFontSize"], 18)


class FakeApi:
    def __init__(self):
        self.routes = {}

    def route(self, name, *, slow=False):
        def deco(fn):
            self.routes[name] = fn
            return fn
        return deco


class PermissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp, self.svc = make_vault({"inside.md": "x"})
        self.root = Path(self.tmp.name)
        self.app = SimpleNamespace(api=FakeApi(), service=self.svc, windows=[], language="en", network_plugins=set())
        plugin_api.register(self.app)
        self.fs = self.app.api.routes["shim.fs"]
        self.outside = tempfile.TemporaryDirectory()
        (Path(self.outside.name) / "secret.txt").write_text("s")
        permissions._session.clear()
        permissions._chosen.clear()

    def tearDown(self):
        self.svc.close()
        self.tmp.cleanup()
        self.outside.cleanup()

    def ctx(self, plugin="demo"):
        return Ctx(plugin=plugin, sync=False)

    def test_status_roundtrip_and_network_refresh(self):
        self.svc.config_write("community-plugins.json", ["demo"])
        permissions.set_status(self.app, "demo", "network", "allow")
        self.assertEqual(permissions.status(self.app, "demo", "network"), "allow")
        self.assertEqual(self.app.network_plugins, {"demo"})
        permissions.set_status(self.app, "demo", "network", None)
        self.assertIsNone(permissions.status(self.app, "demo", "network"))
        self.assertEqual(self.app.network_plugins, set())

    def test_network_only_for_enabled_plugins(self):
        permissions.set_status(self.app, "off", "network", "allow")
        self.assertEqual(self.app.network_plugins, set())

    def test_inside_vault_needs_no_permission(self):
        res = self.fs({"op": "readFile", "path": "inside.md"}, self.ctx())
        self.assertEqual(base64.b64decode(res["b64"]), b"x")

    def test_outside_vault_denied(self):
        permissions.set_status(self.app, "demo", "fs-outside-vault", "deny")
        path = str(Path(self.outside.name) / "secret.txt")
        with self.assertRaises(ApiError) as cm:
            self.fs({"op": "readFile", "path": path}, self.ctx())
        self.assertEqual(cm.exception.code, "permission-denied")
        with self.assertRaises(ApiError):
            self.fs({"op": "readFile", "path": "../" + Path(self.outside.name).name + "/secret.txt"}, self.ctx())

    def test_outside_vault_allowed(self):
        permissions.set_status(self.app, "demo", "fs-outside-vault", "allow")
        res = self.fs({"op": "readFile", "path": str(Path(self.outside.name) / "secret.txt")}, self.ctx())
        self.assertEqual(base64.b64decode(res["b64"]), b"s")

    def test_allow_once_is_per_session(self):
        permissions._session[("demo", "exec")] = True
        permissions.require(self.app, self.ctx(), "exec")  # no dialog, no error
        self.assertIsNone(permissions.status(self.app, "demo", "exec"))

    def test_plugin_cannot_touch_config_of_others(self):
        cfg = self.svc.vault.config_dir
        (cfg / "plugins" / "other").mkdir(parents=True)
        (cfg / "plugins" / "other" / "data.json").write_text("{}")
        # reading another plugin's folder is fine, writing it or the app config is not
        self.fs({"op": "readFile", "path": ".sk_notes/plugins/other/data.json"}, self.ctx())
        for op, path in (("writeFile", ".sk_notes/plugins/other/data.json"), ("writeFile", ".sk_notes/app.json"),
                         ("readFile", ".sk_notes/permissions.json")):
            with self.assertRaises(ApiError, msg=(op, path)) as cm:
                self.fs({"op": op, "path": path, "b64": ""}, self.ctx())
            self.assertEqual(cm.exception.code, "permission-denied")
        self.fs({"op": "writeFile", "path": ".sk_notes/plugins/demo/data.json", "b64": base64.b64encode(b"{}").decode()}, self.ctx())
        self.assertTrue((cfg / "plugins" / "demo" / "data.json").exists())

    def test_unidentified_caller_never_gets_a_permission(self):
        # B-1: a call without a plugin token (e.g. a plugin calling the API itself) is not
        # allowed to use plugin permissions, and no dialog is shown for it
        permissions.set_status(self.app, "unknown-plugin", "fs-outside-vault", "allow")
        with self.assertRaises(ApiError) as cm:
            self.fs({"op": "readFile", "path": str(Path(self.outside.name) / "secret.txt")}, Ctx(plugin=None, sync=False))
        self.assertEqual(cm.exception.code, "permission-denied")

    def test_symlink_inside_vault_counts_as_outside(self):
        # B-4
        os.symlink(self.outside.name, self.root / "outlink")
        os.symlink(Path(self.outside.name) / "secret.txt", self.root / "secretlink.md")
        permissions.set_status(self.app, "demo", "fs-outside-vault", "deny")
        for op, path in (("readFile", "outlink/secret.txt"), ("writeFile", "outlink/pwned.txt"), ("readFile", "secretlink.md")):
            with self.assertRaises(ApiError, msg=path):
                self.fs({"op": op, "path": path, "b64": ""}, self.ctx())
        self.assertFalse((Path(self.outside.name) / "pwned.txt").exists())

    def test_granting_a_permission_needs_the_native_confirmation(self):
        os.environ["SKN_TEST_CONFIRM"] = "no"
        try:
            self.app.api.routes["plugins.permissions"]({"id": "demo", "set": {"exec": "allow"}}, Ctx(plugin=None, sync=False))
            self.assertIsNone(permissions.status(self.app, "demo", "exec"))
            os.environ["SKN_TEST_CONFIRM"] = "yes"
            self.app.api.routes["plugins.permissions"]({"id": "demo", "set": {"exec": "allow"}}, Ctx(plugin=None, sync=False))
            self.assertEqual(permissions.status(self.app, "demo", "exec"), "allow")
        finally:
            os.environ.pop("SKN_TEST_CONFIRM", None)

    def test_enabling_a_new_plugin_needs_the_native_confirmation(self):
        os.environ["SKN_TEST_CONFIRM"] = "no"
        try:
            with self.assertRaises(ApiError):
                self.app.api.routes["plugins.setEnabled"]({"id": "dropper", "enabled": True}, Ctx(plugin=None, sync=False))
            self.assertNotIn("dropper", self.svc.config_read("community-plugins.json", []) or [])
        finally:
            os.environ.pop("SKN_TEST_CONFIRM", None)

    def test_paths_the_user_did_not_pick(self):
        # B-3: only locations picked in a native dialog
        secret = str(Path(self.outside.name) / "secret.txt")
        self.assertFalse(permissions.chosen(self.app, secret))
        permissions.remember_path(self.app, self.outside.name)
        self.assertTrue(permissions.chosen(self.app, secret))
        self.assertFalse(permissions.chosen(self.app, self.outside.name + "-other/x"))


class ProtectedConfigTests(unittest.TestCase):
    def test_protected_names(self):
        # B-5: what decides plugin rights is written by Python only
        from sk_notes.app.api_core import protected
        for name in ("permissions.json", "community-plugins.json", "plugins", "plugins/x", "plugins/x/main.js",
                     "plugins/x/manifest.json", "plugins/x/styles.css", "/plugins/x/"):
            self.assertTrue(protected(name), name)
        for name in ("plugins/x/data.json", "app.json", "workspace.json", "snippets/a.css"):
            self.assertFalse(protected(name), name)


if __name__ == "__main__":
    unittest.main()

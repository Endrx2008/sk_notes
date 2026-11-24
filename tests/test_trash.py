"""The trash of a vault: .trash with dates, the system trash entries from this vault only,
restore, delete for good, and removal after three months."""
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from sk_notes.core import trash
from sk_notes.core.service import VaultService


class TrashTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.xdg = base / "xdg"
        self.env = mock.patch.dict(os.environ, {"XDG_DATA_HOME": str(self.xdg)})
        self.env.start()
        self.root = base / "vault"
        (self.root / "Projects").mkdir(parents=True)
        for rel in ("Projects/Plan.md", "Old.md", "Keep.md", "Sys.md"):
            (self.root / rel).write_text("# " + rel, encoding="utf-8")
        self.other = base / "elsewhere.txt"
        self.other.write_text("not ours")
        self.svc = VaultService(str(self.root), emit=lambda n, d: None)
        self.svc.open()

    def tearDown(self):
        self.svc.close()
        self.env.stop()
        self.tmp.cleanup()

    def test_local_and_system(self):
        self.svc.delete("Projects/Plan.md", mode="local")
        self.svc.delete("Old.md", mode="local")
        self.assertEqual(self.svc.delete("Sys.md", mode="system")["mode"], "system")
        # something another folder sent to the system trash is not ours
        info = self.xdg / "Trash" / "info"
        (self.xdg / "Trash" / "files" / "elsewhere.txt").write_text("x")
        (info / "elsewhere.txt.trashinfo").write_text(f"[Trash Info]\nPath={self.other}\nDeletionDate=2020-01-01T00:00:00\n")
        items = trash.list_trash(self.svc.vault)
        self.assertEqual(sorted(e["name"] for e in items), ["Old.md", "Plan.md", "Sys.md"])
        plan = next(e for e in items if e["name"] == "Plan.md")
        self.assertEqual(plan["from"], "Projects/Plan.md")
        sys_item = next(e for e in items if e["name"] == "Sys.md")
        self.assertTrue(sys_item["id"].startswith("system:"))
        # back where it was; the place taken: beside it
        (self.root / "Projects/Plan.md").write_text("new")
        self.assertEqual(trash.restore(self.svc.vault, "Plan.md"), "Projects/Plan 1.md")
        self.assertEqual(trash.restore(self.svc.vault, sys_item["id"]), "Sys.md")
        self.assertFalse((info / (sys_item["id"][7:] + ".trashinfo")).exists())
        with self.assertRaises(Exception):
            trash.restore(self.svc.vault, "../Keep.md")
        with self.assertRaises(Exception):
            trash.restore(self.svc.vault, "system:elsewhere.txt")
        # three months and a day later
        later = time.time() + trash.KEEP_SECONDS + 86400
        self.assertEqual(trash.list_trash(self.svc.vault, now=later), [])
        self.assertFalse((self.root / ".trash" / "Old.md").exists())
        self.assertTrue((self.xdg / "Trash" / "files" / "elsewhere.txt").exists())  # never touched
        # for good: one, then all
        self.svc.delete("Keep.md", mode="system")
        self.svc.delete("Sys.md", mode="local")
        ids = [e["id"] for e in trash.list_trash(self.svc.vault)]
        self.assertEqual(len(ids), 2)
        trash.purge(self.svc.vault, ids[0])
        self.assertEqual(len(trash.list_trash(self.svc.vault)), 1)
        trash.purge(self.svc.vault, None)
        self.assertEqual(trash.list_trash(self.svc.vault), [])


if __name__ == "__main__":
    unittest.main()

"""SKAI_ Memory: notes read by other programs are reported (the scorpion of the graph shows
them); reads by sk_notes itself, writes, and ordinary vaults are not."""
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from PyQt6.QtCore import QCoreApplication, QEventLoop, QTimer

from sk_notes.app.watcher import VaultWatcher
from sk_notes.core.service import VaultService
from sk_notes.core.vault import MEMORY_MARKER

app = QCoreApplication.instance() or QCoreApplication(sys.argv[:1])


def spin(ms: int) -> None:
    loop = QEventLoop()
    QTimer.singleShot(ms, loop.quit)
    loop.exec()


class MemoryReadTests(unittest.TestCase):
    def make(self, protected: bool):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        if protected:
            (root / MEMORY_MARKER).write_text("")
        for n in ("SKAI", "a", "b"):
            (root / f"{n}.md").write_text(f"# {n}\n")
        events = []
        svc = VaultService(str(root), emit=lambda n, d: events.append((n, d)))
        svc.open()
        self.addCleanup(svc.close)
        w = VaultWatcher(root, reads=svc.vault.protected)
        self.addCleanup(w.close)
        w.opened.connect(svc.external_read)
        w.changed.connect(svc.external_change)
        return root, svc, events

    def reads(self, events):
        return [p for n, d in events if n == "read" for p in d["paths"]]

    def test_other_program_reads(self):
        root, svc, events = self.make(True)
        spin(2300)  # the reads of opening the vault are sk_notes' own
        events.clear()
        subprocess.run(["cat", str(root / "a.md")], capture_output=True, check=True)
        spin(600)
        self.assertEqual(self.reads(events), ["a.md"])

    def test_own_reads_and_writes_are_not_reads(self):
        root, svc, events = self.make(True)
        spin(2300)
        events.clear()
        svc.vault.read_text("b.md")  # sk_notes reading a note
        spin(600)
        self.assertEqual(self.reads(events), [])
        with open(root / "a.md", "a") as fh:  # another program writing: a change, not a read
            fh.write("more\n")
        spin(600)
        self.assertEqual(self.reads(events), [])
        self.assertTrue(any(n == "modify" for n, _ in events))

    def test_many_at_once_is_a_scan(self):
        root, svc, events = self.make(True)
        for i in range(8):
            (root / f"n{i}.md").write_text("x")
        spin(2300)
        svc.rescan()
        spin(2300)
        events.clear()
        subprocess.run("cat " + " ".join(f"'{p}'" for p in root.glob("*.md")), shell=True, capture_output=True, check=True)
        spin(600)
        scans = [d for n, d in events if n == "read"]
        self.assertTrue(scans and scans[0]["scan"])

    def test_ordinary_vault_reports_nothing(self):
        root, svc, events = self.make(False)
        spin(300)
        subprocess.run(["cat", str(root / "a.md")], capture_output=True, check=True)
        spin(600)
        self.assertEqual(self.reads(events), [])


if __name__ == "__main__":
    unittest.main()


class SkaiChangeTests(unittest.TestCase):
    """SKAI_ Memory: SKAI changes notes the user asked for, without the sudo password."""

    def test_write_append_delete(self):
        import os
        from unittest import mock
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / MEMORY_MARKER).write_text("")
        (root / "SKAI.md").write_text("# SKAI\n")
        (root / "old.md").write_text("# old\n")
        with mock.patch.dict(os.environ, {"SKAI_MEMORY_NO_SUDO": "1"}):
            events = []
            svc = VaultService(str(root), emit=lambda n, d: events.append((n, d)))
            svc.open()
            self.addCleanup(svc.close)
            self.assertFalse(svc.vault.unlocked)  # no sudo password anywhere
            svc.skai_change("append", "SKAI.md", "- [[plugins/skai/people]]\n")
            svc.skai_change("write", "plugins/skai/people.md", "# people\n")
            svc.skai_change("delete", "old.md")
            self.assertEqual((root / "SKAI.md").read_text(), "# SKAI\n- [[plugins/skai/people]]\n")
            self.assertEqual((root / "plugins/skai/people.md").read_text(), "# people\n")
            self.assertFalse((root / "old.md").exists())
            self.assertIn("plugins/skai/people.md", svc.index.files)
            self.assertTrue(any(n == "create" for n, _ in events))
            self.assertTrue(any(s["reason"] == "skai" for s in svc.history.list("old.md")))  # the text before is kept
            for bad in (("write", "x.txt"), ("rename", "SKAI.md"), ("write", "../x.md")):
                with self.assertRaises(Exception):
                    svc.skai_change(bad[0], bad[1], "x")

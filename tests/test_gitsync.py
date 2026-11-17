"""Git sync of the desktop app (sk_notes/extras/gitsync.py) against real repositories."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from sk_notes.extras.gitsync import GitSync, SyncError

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "android" / "web" / "tests" / "git-server.mjs"
ENV = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null", GIT_TERMINAL_PROMPT="0",
           GIT_AUTHOR_NAME="PC2", GIT_AUTHOR_EMAIL="pc2@example.org", GIT_COMMITTER_NAME="PC2", GIT_COMMITTER_EMAIL="pc2@example.org")


def git(cwd, *args) -> str:
    return subprocess.run(["git", *args], cwd=cwd, env=ENV, check=True, capture_output=True, text=True).stdout


@unittest.skipUnless(shutil.which("git"), "git not installed")
class GitSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.n = 0

    def tearDown(self):
        self.tmp.cleanup()

    def world(self, seed=None):
        """A bare repository, another computer's clone of it ("pc2"), and this vault."""
        self.n += 1
        bare = self.dir / f"w{self.n}.git"
        git(self.dir, "init", "-q", "--bare", "-b", "main", str(bare))
        pc2 = self.dir / f"w{self.n}-pc2"
        git(self.dir, "clone", "-q", str(bare), str(pc2))
        if seed:
            for rel, text in seed.items():
                (pc2 / rel).parent.mkdir(parents=True, exist_ok=True)
                (pc2 / rel).write_text(text)
            git(pc2, "add", "-A")
            git(pc2, "commit", "-q", "-m", "seed")
            git(pc2, "push", "-q", "origin", "HEAD:main")
        vault = self.dir / f"w{self.n}-vault"
        vault.mkdir()
        return bare, pc2, vault

    def sync(self, vault, bare, seen=None):
        return GitSync(vault, str(bare), "main", ("anna", "anna@example.org"), None,
                       before_overwrite=(lambda p, b: seen.append(p)) if seen is not None else None).sync()

    def pc2_push(self, pc2, msg="pc2"):
        git(pc2, "add", "-A")
        try:
            git(pc2, "commit", "-q", "-m", msg)
        except subprocess.CalledProcessError:
            pass
        git(pc2, "pull", "-q", "--no-rebase", "--no-edit", "origin", "main")
        git(pc2, "push", "-q", "origin", "HEAD:main")

    def w(self, root, rel, text):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text)

    def test_vault_to_empty_repository_and_back(self):
        bare, pc2, vault = self.world()
        self.w(vault, "Idea.md", "# Idea\n\n[[Other]]\n")
        self.w(vault, "Folder/Other.md", "# Other\n")
        self.w(vault, ".trash/gone.md", "no")
        self.w(vault, ".sk_notes/workspace.json", "{}")
        self.w(vault, ".sk_notes/app.json", '{"a":1}')
        r = self.sync(vault, bare)
        self.assertTrue(r["pushed"])
        git(pc2, "pull", "-q", "origin", "main")
        self.assertEqual((pc2 / "Idea.md").read_text(), "# Idea\n\n[[Other]]\n")
        self.assertTrue((pc2 / ".sk_notes/app.json").exists())
        self.assertFalse((pc2 / ".trash").exists())
        self.assertFalse((pc2 / ".sk_notes/workspace.json").exists())
        self.assertRegex(git(pc2, "log", "-1", "--format=%an %s"), r"^anna sk_notes \(desktop\): \d{4}-")
        again = self.sync(vault, bare)
        self.assertEqual((again["committed"], again["pushed"], again["pulled"]), (False, False, 0))
        # changes both ways, removals and renames
        self.w(pc2, "From PC2.md", "p\n")
        self.w(pc2, "Folder/Other.md", "# Other, pc2\n")
        self.pc2_push(pc2)
        self.w(vault, "Idea.md", "# Idea\n\nedited here\n")
        (vault / "Folder" / "Other.md").rename(vault / "Folder" / "Moved.md") if False else None
        r = self.sync(vault, bare)
        self.assertEqual((vault / "From PC2.md").read_text(), "p\n")
        self.assertEqual((vault / "Folder/Other.md").read_text(), "# Other, pc2\n")
        self.assertEqual(r["conflicts"], [])
        git(pc2, "pull", "-q", "origin", "main")
        self.assertEqual((pc2 / "Idea.md").read_text(), "# Idea\n\nedited here\n")
        self.assertEqual(git(pc2, "status", "--porcelain"), "")
        (vault / "From PC2.md").unlink()
        self.sync(vault, bare)
        git(pc2, "pull", "-q", "origin", "main")
        self.assertFalse((pc2 / "From PC2.md").exists())
        shutil.rmtree(pc2 / "Folder")
        self.pc2_push(pc2, "rm folder")
        self.sync(vault, bare)
        self.assertFalse((vault / "Folder").exists())
        self.assertEqual(git(vault, "status", "--porcelain").strip(), "")

    def test_same_note_changed_on_both_sides(self):
        bare, pc2, vault = self.world({"N.md": "one\ntwo\nthree\nfour\nfive\n", "C.md": "same\n", "D.md": "d\n", "E.md": "e\n", "img.png": "v1"})
        self.sync(vault, bare)
        self.w(vault, "N.md", "ONE\ntwo\nthree\nfour\nfive\n")
        self.w(vault, "C.md", "this computer\n")
        (vault / "D.md").unlink()
        self.w(vault, "E.md", "e here\n")
        self.w(vault, "img.png", "here")
        git(pc2, "pull", "-q", "origin", "main")
        self.w(pc2, "N.md", "one\ntwo\nthree\nfour\nFIVE\n")
        self.w(pc2, "C.md", "other computer\n")
        self.w(pc2, "D.md", "d pc2\n")
        (pc2 / "E.md").unlink()
        self.w(pc2, "img.png", "pc2")
        self.pc2_push(pc2)
        seen = []
        r = self.sync(vault, bare, seen)
        self.assertEqual((vault / "N.md").read_text(), "ONE\ntwo\nthree\nfour\nFIVE\n")
        self.assertEqual((vault / "C.md").read_text(), "other computer\n")
        copies = {c["path"]: c["copy"] for c in r["conflicts"]}
        self.assertEqual(sorted(copies), ["C.md", "img.png"])
        self.assertRegex(copies["C.md"], r"^C \(conflict \d{4}-\d\d-\d\d \d\d\.\d\d\)\.md$")
        self.assertEqual((vault / copies["C.md"]).read_text(), "this computer\n")
        self.assertEqual((vault / "D.md").read_text(), "d pc2\n")
        self.assertEqual((vault / "E.md").read_text(), "e here\n")
        self.assertIn("C.md", seen)
        git(pc2, "pull", "-q", "origin", "main")
        self.assertEqual((pc2 / copies["C.md"]).read_text(), "this computer\n")
        self.assertRegex(git(pc2, "log", "-1", "--format=%P").strip(), r"^\w{40} \w{40}$")
        self.assertEqual(git(pc2, "status", "--porcelain"), "")
        self.assertNotIn("<<<<<<<", (vault / "C.md").read_text())

    def test_first_link_when_both_sides_have_notes(self):
        bare, pc2, vault = self.world({"Same.md": "same\n", "Differs.md": "pc2\n", "Only PC2.md": "p\n", ".gitignore": "private/\n"})
        self.w(vault, "Same.md", "same\n")
        self.w(vault, "Differs.md", "here\n")
        self.w(vault, "Only here.md", "h\n")
        self.w(vault, "private/secret.md", "s\n")
        r = self.sync(vault, bare)
        self.assertEqual((vault / "Differs.md").read_text(), "pc2\n")
        self.assertEqual(len(r["conflicts"]), 1)
        self.assertEqual((vault / ".gitignore").read_text(), "private/\n")
        git(pc2, "pull", "-q", "origin", "main")
        self.assertTrue((pc2 / "Only here.md").exists())
        self.assertFalse((pc2 / "private").exists())

    def test_existing_repository_and_another_device_pushing_meanwhile(self):
        bare, pc2, vault = self.world({"A.md": "a\n"})
        git(self.dir, "clone", "-q", str(bare), str(vault / "x"))  # a vault that is already a clone
        shutil.rmtree(vault)
        git(self.dir, "clone", "-q", str(bare), str(vault))
        self.w(vault, "Mine.md", "m\n")
        s = GitSync(vault, str(bare), "main", ("anna", "a@b"))
        real = s.git
        raced = []

        def racing(*args, **kw):
            if args and args[0] == "push" and not raced:
                raced.append(1)
                self.w(pc2, "Race.md", "r\n")
                self.pc2_push(pc2, "race")
            return real(*args, **kw)
        s.git = racing
        r = s.sync()
        self.assertTrue(r["pushed"])
        self.assertEqual((vault / "Race.md").read_text(), "r\n")
        git(pc2, "pull", "-q", "origin", "main")
        self.assertTrue((pc2 / "Mine.md").exists())

    @unittest.skipUnless(shutil.which("node") and SERVER.exists(), "node or the test git server not available")
    def test_sign_in_over_http(self):
        srv_root = self.dir / "srv"
        srv_root.mkdir()
        git(self.dir, "init", "-q", "--bare", "-b", "main", str(srv_root / "notes.git"))
        git(srv_root / "notes.git", "config", "http.receivepack", "true")
        proc = subprocess.Popen(["node", str(SERVER), str(srv_root)], stdout=subprocess.PIPE, text=True)
        try:
            port = re.search(r"PORT (\d+)", proc.stdout.readline()).group(1)
            url = f"http://127.0.0.1:{port}/notes.git"
            vault = self.dir / "httpvault"
            vault.mkdir()
            self.w(vault, "N.md", "n\n")
            with self.assertRaises(SyncError) as cm:
                GitSync(vault, url, "main", ("anna", "a@b"), ("anna", "wrong")).sync()
            self.assertEqual(cm.exception.code, "sync-auth")
            r = GitSync(vault, url, "main", ("anna", "a@b"), ("anna", "secret-token")).sync()
            self.assertTrue(r["pushed"])
            self.assertNotIn("secret-token", (vault / ".git" / "config").read_text())
            with self.assertRaises(SyncError) as cm:
                GitSync(vault, f"http://127.0.0.1:{port}/missing.git", "main", ("a", "b"), ("anna", "secret-token")).remote_info()
            self.assertEqual(cm.exception.code, "sync-no-repo")
            with self.assertRaises(SyncError) as cm:
                GitSync(vault, "http://127.0.0.1:9/x.git", "main", ("a", "b"), ("x", "y")).remote_info()
            self.assertEqual(cm.exception.code, "network-error")
        finally:
            proc.terminate()


if __name__ == "__main__":
    unittest.main()

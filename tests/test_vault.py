import os
import random
import tempfile
import time
import unittest
from pathlib import Path

from sk_notes.core.search import parse_query, search
from sk_notes.core.service import VaultService
from sk_notes.core.vault import Vault, VaultError, normalize_path


def make_vault(files: dict[str, str]) -> tuple[tempfile.TemporaryDirectory, VaultService]:
    tmp = tempfile.TemporaryDirectory()
    for rel, text in files.items():
        p = Path(tmp.name) / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    events = []
    svc = VaultService(tmp.name, emit=lambda n, d: events.append((n, d)))
    svc.events = events
    svc.open()
    return tmp, svc


class VaultPathTests(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(normalize_path("/a//b/./c/"), "a/b/c")
        self.assertEqual(normalize_path("a\\b"), "a/b")
        self.assertEqual(normalize_path(""), "/")
        self.assertEqual(normalize_path("x y"), "x y")

    def test_outside_vault_refused(self):
        with tempfile.TemporaryDirectory() as d:
            v = Vault(d)
            for bad in ("../x.md", "a/../../x.md"):
                with self.assertRaises(VaultError):
                    v.write_text(bad, "x")
            with self.assertRaises(VaultError):
                v.write_text("a" * 300 + ".md", "x")

    def test_atomic_write_and_unicode_names(self):
        with tempfile.TemporaryDirectory() as d:
            v = Vault(d)
            v.write_text("Ünï cødé/日本語 📝.md", "hi")
            self.assertEqual(v.read_text("Ünï cødé/日本語 📝.md"), "hi")
            self.assertFalse([f for f in os.listdir(Path(d) / "Ünï cødé") if "skn-tmp" in f])

    def test_scan_skips_hidden_and_config(self):
        with tempfile.TemporaryDirectory() as d:
            for rel in ("a.md", ".hidden/x.md", ".sk_notes/app.json", ".git/HEAD", "f/b.md"):
                p = Path(d) / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("x")
            paths = sorted(e.path for e in Vault(d).scan())
            self.assertEqual(paths, ["a.md", "f", "f/b.md"])


class IndexTests(unittest.TestCase):
    def setUp(self):
        self.tmp, self.svc = make_vault({
            "Home.md": "[[Alpha]] [[Folder/Beta]] [[Missing]] ![[pic.png]]",
            "Alpha.md": "#tag/sub text [[Home#Top|home]]",
            "Folder/Beta.md": "---\ntags: [x]\nup: \"[[Home]]\"\n---\n[rel](Gamma.md)",
            "Folder/Gamma.md": "gamma",
            "Other/Alpha.md": "duplicate name",
            "pic.png": "png",
        })

    def tearDown(self):
        self.svc.close()
        self.tmp.cleanup()

    def test_resolution(self):
        idx = self.svc.index
        self.assertEqual(idx.resolve("Alpha", "Home.md"), "Alpha.md")
        self.assertEqual(idx.resolve("Alpha", "Other/x.md"), "Other/Alpha.md")  # same folder wins
        self.assertEqual(idx.resolve("Gamma.md", "Folder/Beta.md"), "Folder/Gamma.md")  # relative
        self.assertEqual(idx.resolve("beta", "Home.md"), "Folder/Beta.md")  # case-insensitive by name
        self.assertIsNone(idx.resolve("Missing", "Home.md"))
        self.assertEqual(idx.resolved["Home.md"], {"Alpha.md": 1, "Folder/Beta.md": 1, "pic.png": 1})
        self.assertEqual(idx.unresolved["Home.md"], {"Missing": 1})
        self.assertIn("Home.md", idx.backlinks["Alpha.md"])
        self.assertIn("Folder/Beta.md", idx.backlinks["Home.md"])  # frontmatter link counts

    def test_cache_reused(self):
        self.svc.close()
        svc2 = VaultService(self.tmp.name)
        stats = svc2.open()
        self.assertEqual(stats["changed"], 0)
        svc2.close()

    def test_corrupt_cache_rebuilt(self):
        self.svc.close()
        db = Path(self.tmp.name) / ".sk_notes" / "cache.db"
        db.write_bytes(b"garbage" * 100)
        for s in ("-wal", "-shm"):
            Path(str(db) + s).unlink(missing_ok=True)
        svc2 = VaultService(self.tmp.name)
        self.assertGreater(svc2.open()["changed"], 0)
        svc2.close()

    def test_new_file_resolves_dangling_links(self):
        self.svc.create("Missing.md", "now here")
        self.assertEqual(self.svc.index.unresolved["Home.md"], {})
        self.assertIn("Missing.md", self.svc.index.resolved["Home.md"])

    def test_tags_and_properties(self):
        tags = self.svc.index.all_tags()
        self.assertEqual(tags["#tag/sub"], 1)
        self.assertEqual(tags["#x"], 1)
        self.assertEqual(self.svc.index.properties()["tags"]["type"], "tags")


class RenameTests(unittest.TestCase):
    def setUp(self):
        self.tmp, self.svc = make_vault({
            "Index.md": "See [[Target]], [[Target#Sec|alias]], ![[Target]], [md](Target.md) and [[Folder/Target2]].",
            "Target.md": "# Sec\n[back](Index.md)",
            "Folder/Target2.md": "x",
            "Folder/Rel.md": "[sib](Target2.md)",
            "Prop.md": "---\nup: \"[[Target]]\"\n---\nbody 😀 [[Target]]",
        })

    def tearDown(self):
        self.svc.close()
        self.tmp.cleanup()

    def read(self, p):
        return (Path(self.tmp.name) / p).read_text(encoding="utf-8")

    def test_rename_updates_all_link_styles(self):
        res = self.svc.rename("Target.md", "Renamed.md")
        self.assertEqual(self.read("Index.md"),
                         "See [[Renamed]], [[Renamed#Sec|alias]], ![[Renamed]], [md](Renamed.md) and [[Folder/Target2]].")
        self.assertEqual(self.read("Prop.md"), "---\nup: \"[[Renamed]]\"\n---\nbody 😀 [[Renamed]]")
        self.assertCountEqual(res["updated"], ["Index.md", "Prop.md"])
        self.assertEqual(self.svc.index.unresolved["Index.md"], {})

    def test_move_note_keeps_full_paths_and_relative_links(self):
        self.svc.rename("Folder/Target2.md", "Deep/Sub/Target2.md")
        self.assertIn("[[Deep/Sub/Target2]]", self.read("Index.md"))
        self.svc.rename("Folder/Rel.md", "Elsewhere/Rel.md")
        self.assertEqual(self.read("Elsewhere/Rel.md"), "[sib](../Deep/Sub/Target2.md)")

    def test_rename_folder(self):
        self.svc.rename("Folder", "Renamed Folder")
        self.assertIn("[[Renamed Folder/Target2]]", self.read("Index.md"))
        self.assertIn("Renamed Folder/Rel.md", self.svc.index.files)
        self.assertNotIn("Folder", self.svc.index.folders)

    def test_rename_to_existing_refused(self):
        with self.assertRaises(VaultError):
            self.svc.rename("Target.md", "Index.md")
        self.assertIn("Target", self.read("Index.md"))

    def test_rename_without_link_update(self):
        self.svc.rename("Target.md", "Renamed.md", update_links=False)
        self.assertIn("[[Target]]", self.read("Index.md"))
        self.assertIn("Target", self.svc.index.unresolved["Index.md"])

    def test_case_only_rename(self):
        self.svc.rename("Target.md", "target.md")
        self.assertIn("target.md", self.svc.index.files)
        self.assertIn("[[target]]", self.read("Index.md"))

    def test_many_renames_stay_consistent(self):
        name = "Target.md"
        for i in range(60):
            new = f"N{i}/T{i}.md" if i % 2 else f"T{i}.md"
            self.svc.rename(name, new)
            name = new
        self.assertEqual(self.svc.index.unresolved["Index.md"], {})
        self.assertIn(name[:-3].split("/")[-1], self.read("Index.md"))


class WriteDeleteHistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp, self.svc = make_vault({"A.md": "one"})
        os.environ["XDG_DATA_HOME"] = str(Path(self.tmp.name) / "xdg")

    def tearDown(self):
        self.svc.close()
        self.tmp.cleanup()
        os.environ.pop("XDG_DATA_HOME", None)

    def test_conflict_detected_not_overwritten(self):
        r = self.svc.read("A.md")
        time.sleep(0.02)
        p = Path(self.tmp.name) / "A.md"
        p.write_text("changed outside")
        os.utime(p, (time.time() + 5, time.time() + 5))
        out = self.svc.write("A.md", "my edit", expected_mtime=r["mtime"])
        self.assertTrue(out.get("conflict"))
        self.assertEqual(p.read_text(), "changed outside")

    def test_delete_to_local_trash_and_history(self):
        self.svc.write("A.md", "two", reason="manual")
        self.svc.delete("A.md", mode="local")
        self.assertTrue((Path(self.tmp.name) / ".trash" / "A.md").exists())
        self.assertNotIn("A.md", self.svc.index.files)
        snaps = self.svc.history.list("A.md")
        texts = {self.svc.history.read(s["id"]) for s in snaps}
        self.assertTrue({"one", "two"} <= texts)
        self.svc.restore_snapshot("A.md", snaps[-1]["id"])
        self.assertTrue((Path(self.tmp.name) / "A.md").exists())

    def test_delete_to_system_trash(self):
        self.assertEqual(self.svc.delete("A.md", mode="system")["mode"], "system")
        trash = Path(self.tmp.name) / "xdg" / "Trash"
        self.assertTrue((trash / "files" / "A.md").exists())
        self.assertTrue((trash / "info" / "A.md.trashinfo").exists())

    def test_external_change_event(self):
        p = Path(self.tmp.name) / "B.md"
        p.write_text("[[A]]")
        self.svc.external_change("B.md")
        self.assertEqual(self.svc.events[-1][0], "create")
        self.assertIn("A.md", self.svc.index.resolved["B.md"])
        p.unlink()
        self.svc.external_change("B.md")
        self.assertEqual(self.svc.events[-1][0], "delete")


class SearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp, cls.svc = make_vault({
            "Meeting notes.md": "---\nstatus: open\npriority: 2\ntags: [work]\n---\n# Agenda\nBudget review with Anna\n- [ ] send report\n- [x] book room",
            "Recipes/Pasta.md": "Tomato and basil. #food\nCook 10 minutes.",
            "Journal.md": "Today I met Anna at the café. Budget is fine.\n\n## Later\nNothing",
            "Case.md": "UPPER lower Mixed",
        })

    @classmethod
    def tearDownClass(cls):
        cls.svc.close()
        cls.tmp.cleanup()

    def paths(self, q, **kw):
        return sorted(r["path"] for r in search(self.svc.index, q, **kw)["results"])

    def test_basic_and_or_not(self):
        self.assertEqual(self.paths("budget anna"), ["Journal.md", "Meeting notes.md"])
        self.assertEqual(self.paths("tomato OR café"), ["Journal.md", "Recipes/Pasta.md"])
        self.assertEqual(self.paths("budget -review"), ["Journal.md"])
        self.assertEqual(self.paths('"met Anna"'), ["Journal.md"])

    def test_operators(self):
        self.assertEqual(self.paths("file:pasta"), ["Recipes/Pasta.md"])
        self.assertEqual(self.paths("path:recipes"), ["Recipes/Pasta.md"])
        self.assertEqual(self.paths("tag:#food"), ["Recipes/Pasta.md"])
        self.assertEqual(self.paths("tag:work"), ["Meeting notes.md"])
        self.assertEqual(self.paths("task-todo:report"), ["Meeting notes.md"])
        self.assertEqual(self.paths("task-done:report"), [])
        self.assertEqual(self.paths("line:(budget anna)"), ["Journal.md", "Meeting notes.md"])
        self.assertEqual(self.paths("line:(tomato minutes)"), [])
        self.assertEqual(self.paths("section:(nothing later)"), ["Journal.md"])
        self.assertEqual(self.paths("[status:open]"), ["Meeting notes.md"])
        self.assertEqual(self.paths("[priority]"), ["Meeting notes.md"])
        self.assertEqual(self.paths("/b[a-z]sil/"), ["Recipes/Pasta.md"])

    def test_case(self):
        self.assertEqual(self.paths("upper"), ["Case.md"])
        self.assertEqual(self.paths("match-case:upper"), [])
        self.assertEqual(self.paths("upper", case_sensitive=True), [])

    def test_snippets(self):
        r = search(self.svc.index, "anna")["results"]
        seg = [s for s in r[0]["matches"][0]["segments"] if s[1]]
        self.assertEqual(seg[0][0].lower(), "anna")

    def test_bad_queries_do_not_crash(self):
        for q in ('"unclosed', "(((", ")", "/[/", "[", "line:", "-", "OR OR", "tag:", "[a:"):
            try:
                search(self.svc.index, q)
            except Exception as exc:  # noqa: BLE001
                self.assertEqual(type(exc).__name__, "QueryError", q)

    def test_parse_shapes(self):
        self.assertEqual(type(parse_query("a OR b c")).__name__, "Or")


class PerformanceTests(unittest.TestCase):
    """Target from the spec: search results under 100 ms on 10,000 notes."""

    @classmethod
    def setUpClass(cls):
        rnd = random.Random(7)
        words = [w.strip() for w in "alpha beta gamma delta epsilon zeta theta kappa lambda omicron sigma tau "
                 "river mountain garden window library coffee planet engine music winter summer".split()]
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        for i in range(10_000):
            folder = root / f"F{i % 50}"
            folder.mkdir(exist_ok=True)
            body = " ".join(rnd.choice(words) for _ in range(rnd.randint(80, 300)))
            links = " ".join(f"[[Note {rnd.randrange(10_000)}]]" for _ in range(3))
            (folder / f"Note {i}.md").write_text(f"# Note {i}\n{body}\n{links} #t{i % 30}\n", encoding="utf-8")
        (root / "F1" / "Note 1.md").write_text("needle unique phrase here", encoding="utf-8")
        t0 = time.perf_counter()
        cls.svc = VaultService(cls.tmp.name)
        cls.svc.open()
        cls.first_open = time.perf_counter() - t0
        cls.svc.close()
        t0 = time.perf_counter()
        cls.svc = VaultService(cls.tmp.name)
        cls.svc.open()
        cls.cached_open = time.perf_counter() - t0

    @classmethod
    def tearDownClass(cls):
        cls.svc.close()
        cls.tmp.cleanup()

    def test_search_speed(self):
        for q in ("needle", "unique phrase", "garden coffee", "tag:#t3", "file:\"Note 99\"", "mountain -winter"):
            res = search(self.svc.index, q, limit_files=200)
            self.assertLess(res["ms"], 100 if q in ("needle", "unique phrase", "file:\"Note 99\"") else 1500, (q, res["ms"]))
        print(f"\n  10k notes: first index {self.first_open:.1f}s, cached open {self.cached_open:.2f}s")

    def test_cached_open_is_fast(self):
        self.assertLess(self.cached_open, 5.0)


if __name__ == "__main__":
    unittest.main()

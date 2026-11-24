import json, os, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
os.environ["SKAI_MEMORY_NO_SUDO"] = "1"
from skai_memory import Memory, MemoryError_, snippet  # noqa: E402  pylint: disable=import-error,wrong-import-position


class T(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        (self.d / "SKAI.md").write_text("# SKAI\n\n")
        self.mail, self.cal = Memory("skmail", self.d), Memory("skalendar", self.d)
        self.mail.remember("inbox", "Anna asked to move the Friday meeting to Monday", links=["https://example.org/x"])
        self.mail.remember("drafts", "Draft about the budget", links=["[[plugins/skmail/inbox]]"])
        self.cal.remember("planning", "Monday 10:00 is free, booked the quarterly review", links=["/etc/os-release"])
        self.mail.link("skalendar", "meeting dates")
        self.cal.link("skmail", note="inbox")

    def tearDown(self):
        shutil.rmtree(self.d)

    def test_registration_creates_plugin_note_and_links_it(self):
        note = (self.d / "plugins/skmail.md").read_text()
        self.assertIn("app: skmail", note)
        self.assertIn("only skmail can change it", note)
        self.assertIn("[[plugins/skmail/inbox]]", note)
        skai = (self.d / "SKAI.md").read_text()
        self.assertIn("[[skmail]]", skai)
        self.assertIn("[[skalendar]]", skai)

    def test_app_cannot_write_others_notes(self):
        for bad in ("plugins/skalendar.md", "plugins/skalendar/planning.md", "SKAI.md", "plugins/skmail2/x.md"):
            with self.assertRaises(MemoryError_, msg=bad):
                self.mail.write(bad, "x")
        # the helper enforces it too, not only the library
        req = {"op": "write", "path": "plugins/skalendar/planning.md", "text": "x", "caller": "skmail", "dir": str(self.d)}
        r = subprocess.run([str(HERE / "skai-memory-write"), "--direct"], input=json.dumps(req), capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("may only change its own", r.stderr)
        for who in ("", "SKAI", "../x"):
            req["caller"] = who
            r = subprocess.run([str(HERE / "skai-memory-write"), "--direct"], input=json.dumps(req), capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)

    def test_anonymous_cannot_write(self):
        with self.assertRaises(MemoryError_):
            Memory(root=self.d).remember("x", "y")
        with self.assertRaises(MemoryError_):
            Memory("Bad Name", self.d)

    def test_human_manual_mode_may_edit_anything(self):
        req = {"op": "write", "path": "plugins/skalendar.md", "text": "# edited\n", "dir": str(self.d)}
        r = subprocess.run([str(HERE / "skai-memory-write"), "--direct"], input=json.dumps(req), capture_output=True, text=True,
                           env={**os.environ, "SKAI_TEST_AS": "manual"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((self.d / "plugins/skalendar.md").read_text(), "# edited\n")

    def test_skai_herself_may_edit_every_note(self):
        helper = [str(HERE / "skai-memory-write"), "--direct"]
        for path in ("plugins/skalendar.md", "SKAI.md", "plugins/skmail/new.md"):
            req = {"op": "write", "path": path, "text": "# by SKAI\n", "caller": "skai", "dir": str(self.d)}
            r = subprocess.run(helper, input=json.dumps(req), capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual((self.d / path).read_text(), "# by SKAI\n")
        for bad in ({"op": "register", "caller": "skai"}, {"op": "write", "path": "../x.md", "caller": "skai"},
                    {"op": "write", "path": ".hidden.md", "caller": "skai"}, {"op": "write", "path": "x.txt", "caller": "skai"}):
            r = subprocess.run(helper, input=json.dumps({"text": "x", "dir": str(self.d), **bad}), capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0, bad)

    def test_graph_edge_styles(self):
        g = self.mail.graph()
        st = {(e["from"], e["to"]): e["style"] for e in g["edges"]}
        self.assertEqual(st[("SKAI.md", "plugins/skmail.md")], "solid")                       # tree
        self.assertEqual(st[("plugins/skmail.md", "plugins/skmail/inbox.md")], "solid")       # tree
        self.assertEqual(st[("plugins/skmail/drafts.md", "plugins/skmail/inbox.md")], "dashed")  # same app, between memory files
        self.assertEqual(st[("plugins/skmail.md", "plugins/skalendar.md")], "dotted")         # between apps
        self.assertEqual(st[("plugins/skalendar.md", "plugins/skmail/inbox.md")], "dotted")

    def test_same_chat_name_in_two_apps_stays_separate(self):
        self.cal.remember("inbox", "calendar inbox")
        self.assertIn("calendar inbox", (self.d / "plugins/skalendar/inbox.md").read_text())
        self.assertNotIn("calendar inbox", (self.d / "plugins/skmail/inbox.md").read_text())
        st = {(e["from"], e["to"]) for e in self.mail.graph()["edges"]}
        self.assertIn(("plugins/skalendar.md", "plugins/skalendar/inbox.md"), st)

    def test_search_hops_across_apps(self):
        hits = self.mail.search("Anna meeting", hops=1)
        self.assertEqual(hits[0]["path"], "plugins/skmail/inbox.md")
        self.assertIn("https://example.org/x", hits[0]["external"])
        cal = [h for h in hits if h["path"].startswith("plugins/skalendar")]
        self.assertTrue(cal and cal[0]["via"])

    def test_no_hops_stays_put(self):
        self.assertEqual([h["path"] for h in self.mail.search("Anna", hops=0)], ["plugins/skmail/inbox.md"])

    def test_refuses_bad_paths(self):
        for bad in ("../x.md", "a/../../x.md", "x.txt", "/etc/passwd"):
            with self.assertRaises(MemoryError_):
                self.mail.write(bad, "x")
        with self.assertRaises(MemoryError_):
            self.mail.write("plugins/skmail/big.md", "x" * 300000)

    def test_snippet_reaches_a_fact_deep_in_a_daily_note(self):
        filler = "".join(f"The user asked what the weather is like and the answer was that it is sunny ({i}).\n" for i in range(40))
        for i in range(3):
            self.mail.remember("2026-11-19", filler)
        self.mail.remember("2026-11-19", "The user said that the dentist appointment is on Thursday at 15:30.")
        hit = next(h for h in self.mail.search("what is the day of the dentist appointment?") if h["path"] == "plugins/skmail/2026-11-19.md")
        self.assertIn("dentist appointment is on Thursday at 15:30", hit["snippet"])
        # substrings do not count: "is" inside "this", "the" inside "there"
        self.assertFalse(snippet("this there those\n" * 30 + "budget is 300", {"budget": 2.0, "is": 0.1}).startswith("this"))

    def test_manual_mode_needs_sudo(self):
        r = subprocess.run([str(HERE / "skai-memory-write"), "--direct"], input="{}", capture_output=True, text=True,
                           env={**os.environ, "SKAI_MEMORY_NO_SUDO": "0"})
        self.assertNotEqual(r.returncode, 0)

    @unittest.skipUnless(shutil.which("node"), "node missing")
    def test_js_twin_matches(self):
        script = ("import {Memory} from %r; const m=new Memory({app:'skmail',root:%r});"
                  "console.log(JSON.stringify(await m.search('Anna meeting')));"
                  "console.log(JSON.stringify(await m.graph()));"
                  "try { await m.write('plugins/skalendar.md','x'); console.log('NOT REFUSED'); } catch (e) { console.log('refused'); }") % (str(HERE / "skai_memory.js"), str(self.d))
        out = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, check=True).stdout.splitlines()
        py = self.mail.search("Anna meeting")
        self.assertEqual([(h["path"], h["score"], h["via"], h["snippet"]) for h in json.loads(out[0])],
                         [(h["path"], h["score"], h["via"], h["snippet"]) for h in py])
        key = lambda e: (e["from"], e["to"], e["style"])
        self.assertEqual(sorted(map(key, json.loads(out[1])["edges"])), sorted(map(key, self.mail.graph()["edges"])))
        self.assertEqual(out[2], "refused")

    @unittest.skipUnless(shutil.which("node"), "node missing")
    def test_js_remember(self):
        script = ("import {Memory} from %r; const m=new Memory({app:'sk_notes',root:%r});"
                  "await m.remember('ideas','garden plan',{links:['https://a.b']}); await m.link('skmail','mail dates');") % (str(HERE / "skai_memory.js"), str(self.d))
        subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, check=True)
        self.assertIn("garden plan", (self.d / "plugins/sk_notes/ideas.md").read_text())
        self.assertIn("[[plugins/skmail]]", (self.d / "plugins/sk_notes.md").read_text())
        self.assertIn("[[sk_notes]]", (self.d / "SKAI.md").read_text())


if __name__ == "__main__":
    unittest.main()

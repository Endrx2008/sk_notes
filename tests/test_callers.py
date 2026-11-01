"""Caller identities for plugins (sk_notes/app/callers.py)."""

from __future__ import annotations

import unittest

from sk_notes.app.callers import Callers


class CallerTests(unittest.TestCase):
    def test_boot_secret_works_once(self):
        c = Callers()
        boot = c.new_page("p1")
        res = c.exchange(boot, ["a", "b"])
        self.assertEqual(set(res["tokens"]), {"a", "b"})
        self.assertEqual(c.plugin_for(res["tokens"]["a"]), "a")
        self.assertIsNone(c.exchange(boot, ["a"]))  # a second exchange gets nothing
        self.assertIsNone(c.exchange("guess", ["a"]))

    def test_unknown_tokens_are_the_app(self):
        c = Callers()
        self.assertIsNone(c.plugin_for(None))
        self.assertIsNone(c.plugin_for("a"))  # a plugin id is not a token

    def test_page_key_gives_one_token_per_new_plugin(self):
        c = Callers()
        res = c.exchange(c.new_page("p1"), ["a"])
        tok = c.token(res["key"], "new")
        self.assertEqual(c.plugin_for(tok), "new")
        self.assertIsNone(c.token(res["key"], "new"))  # not twice
        self.assertIsNone(c.token(res["key"], "a"))  # not for one already issued
        self.assertIsNone(c.token("wrong", "other"))

    def test_reload_revokes_old_tokens(self):
        c = Callers()
        res = c.exchange(c.new_page("p1"), ["a"])
        c.new_page("p1")  # the page reloads
        self.assertIsNone(c.plugin_for(res["tokens"]["a"]))
        self.assertIsNone(c.token(res["key"], "x"))
        c2 = c.exchange(c.new_page("p2"), ["a"])
        c.drop_page("p2")
        self.assertIsNone(c.plugin_for(c2["tokens"]["a"]))


if __name__ == "__main__":
    unittest.main()

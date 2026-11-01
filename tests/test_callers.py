"""Caller identities (sk_notes/app/callers.py)."""

from __future__ import annotations

import unittest

from sk_notes.app.callers import Callers


class CallerTests(unittest.TestCase):
    def test_boot_secret_gives_an_app_key_once(self):
        c = Callers()
        boot = c.new_page("p1")
        key = c.auth(boot)
        self.assertTrue(c.is_app(key))
        self.assertIsNone(c.auth(boot))  # not twice
        self.assertIsNone(c.auth("guess"))

    def test_nothing_is_the_app_by_default(self):
        c = Callers()
        self.assertFalse(c.is_app(None))
        self.assertFalse(c.is_app(""))
        self.assertFalse(c.is_app("anything"))
        self.assertIsNone(c.plugin_for(None))
        self.assertIsNone(c.plugin_for("a"))  # a plugin id is not a token

    def test_plugin_tokens_need_the_app_key_and_are_issued_once(self):
        c = Callers()
        key = c.auth(c.new_page("p1"))
        tok = c.issue(key, "a")
        self.assertEqual(c.plugin_for(tok), "a")
        self.assertIsNone(c.issue(key, "a"))
        self.assertIsNone(c.issue("wrong", "b"))
        self.assertFalse(c.is_app(tok))  # a plugin token is not an app key

    def test_reload_revokes_everything_of_the_old_page(self):
        c = Callers()
        key = c.auth(c.new_page("p1"))
        tok = c.issue(key, "a")
        c.new_page("p1")  # the page reloads
        self.assertFalse(c.is_app(key))
        self.assertIsNone(c.plugin_for(tok))
        key2 = c.auth(c.new_page("p2"))
        c.drop_page("p2")
        self.assertFalse(c.is_app(key2))


if __name__ == "__main__":
    unittest.main()

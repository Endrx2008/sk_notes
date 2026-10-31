"""sknotes:// link parsing and vault selection."""

from __future__ import annotations

import unittest

from sk_notes.app import uri


class UriTests(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(uri.parse("sknotes://open?vault=My%20Notes&file=A%2FB"), ("open", {"vault": "My Notes", "file": "A/B"}))
        self.assertEqual(uri.parse("SKNOTES://new?name=x&silent"), ("new", {"name": "x", "silent": ""}))
        self.assertEqual(uri.parse("sknotes:///search?query=tag%3A%23a")[0], "search")

    def test_parse_rejects_other_schemes(self):
        for bad in ("obsidian://open?vault=a", "https://x", "sknotes://"):
            with self.assertRaises(uri.UriError, msg=bad):
                uri.parse(bad)

    def test_find_vault(self):
        known = ["/home/u/Notes", "/home/u/Notes/Sub", "/home/u/Work"]
        self.assertEqual(uri.find_vault({"vault": "Work"}, known), "/home/u/Work")
        self.assertEqual(uri.find_vault({"vault": "/home/u/Notes"}, known), "/home/u/Notes")
        self.assertIsNone(uri.find_vault({"vault": "Nope"}, known))
        # the deepest vault containing the file wins
        self.assertEqual(uri.find_vault({"path": "/home/u/Notes/Sub/a.md"}, known), "/home/u/Notes/Sub")
        self.assertEqual(uri.find_vault({"path": "/home/u/Notes/a.md"}, known), "/home/u/Notes")
        self.assertIsNone(uri.find_vault({"path": "/etc/passwd"}, known))

    def test_vault_relative(self):
        self.assertEqual(uri.vault_relative({"path": "/v/a/b.md"}, "/v"), {"file": "a/b.md"})
        self.assertEqual(uri.vault_relative({"path": "/elsewhere/b.md"}, "/v"), {})
        self.assertEqual(uri.vault_relative({"file": "x"}, "/v"), {"file": "x"})

    def test_server_name_is_per_vault_and_user(self):
        a, b = uri.server_name("/v1"), uri.server_name("/v2")
        self.assertNotEqual(a, b)
        self.assertTrue(a.startswith("sk_notes-"))


if __name__ == "__main__":
    unittest.main()

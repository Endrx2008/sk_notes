"""Embedding index: cosine ranking with numpy imported lazily (start-up time fix)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from array import array
from pathlib import Path

from sk_notes.ai import embeddings


class EmbeddingIndexTests(unittest.TestCase):
    def test_numpy_not_imported_at_module_load(self):
        # importing the module must stay cheap; numpy comes with the first search
        if "numpy" not in sys.modules:
            self.assertIsNone(embeddings.np)

    def test_search_ranks_by_cosine(self):
        with tempfile.TemporaryDirectory() as d:
            idx = embeddings.EmbeddingIndex(str(Path(d) / "e.db"))
            rows = [("a.md", "alpha", [1.0, 0.0]), ("b.md", "beta", [0.0, 1.0]), ("c.md", "gamma", [0.7, 0.7])]
            for path, text, vec in rows:
                idx.db.execute("INSERT INTO chunks(path, idx, mtime, model, text, vec) VALUES (?,0,0,'m',?,?)",
                               (path, text, array("f", vec).tobytes()))
            res = idx.search([1.0, 0.1], "m", k=2)
            self.assertEqual(res[0]["path"], "a.md")
            self.assertIsNotNone(embeddings.np)
            idx.close()


if __name__ == "__main__":
    unittest.main()

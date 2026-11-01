"""Static checks on the front-end sources that would otherwise only show up as broken UI."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "sk_notes" / "web"
# lifecycle methods of View/Component: a view that redefines one of them with another
# meaning breaks the workspace (SearchView.open(file, line) once kept the search pane empty)
LIFECYCLE = {"open", "close", "load", "unload"}
METHOD = re.compile(r"^  (?:async\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{", re.M)


class FrontendStaticTests(unittest.TestCase):
    def test_views_do_not_shadow_lifecycle_methods(self):
        files = [f for f in (WEB / "src" / "views").glob("*.js") if f.name != "base.js"] + [WEB / "src" / "skai" / "view.js"]
        bad = []
        for f in files:
            text = f.read_text(encoding="utf-8")
            for cls in re.split(r"\n(?=export class |class )", text):
                if not re.match(r"(export )?class \w+ extends \w*View\b", cls):
                    continue
                for m in METHOD.finditer(cls):
                    if m.group(1) in LIFECYCLE:
                        bad.append(f"{f.name}: {m.group(1)}({m.group(2)})")
        self.assertEqual(bad, [])

    def test_text_file_views_keep_data_a_string(self):
        # TextFileView.data is the file text (plugin API) and save() assigns it; the canvas
        # once kept its parsed object there, and the first save turned it into a string
        bad = []
        for f in (WEB / "src" / "views").glob("*.js"):
            if f.name in ("base.js", "markdown.js"):
                continue
            text = f.read_text(encoding="utf-8")
            if re.search(r"extends TextFileView\b", text) and re.search(r"this\.data\b", text):
                bad.append(f.name)
        self.assertEqual(bad, [])

    def test_codemirror_overrides_beat_its_base_theme(self):
        css = (WEB / "styles" / "20-editor.css").read_text(encoding="utf-8")
        # a single-class rule loses against CodeMirror's injected ".ͼ2 .cm-gutters" (light background)
        self.assertNotRegex(css, r"(?m)^\.cm-gutters\s*\{")
        self.assertIn(".cm-editor.cm-editor .cm-gutters", css)


if __name__ == "__main__":
    unittest.main()

"""Suite configuration paths."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class SuiteConfigTests(unittest.TestCase):
    def test_suite_files_follow_xdg_config_home(self):
        # B-24: the Ollama settings were read from $HOME/.config whatever XDG_CONFIG_HOME said
        with tempfile.TemporaryDirectory() as d:
            env = dict(os.environ, XDG_CONFIG_HOME=d)
            out = subprocess.run([sys.executable, "-c", "from sk_notes.app import config; print(config.SUITE_SETTINGS_FILE);"
                                  " print(config.SKAI_THEME_FILE)"], cwd=ROOT, env=env, capture_output=True, text=True, check=True)
            suite, theme = out.stdout.split()
            self.assertEqual(suite, str(Path(d) / "skorpion-suite" / "settings.json"))
            self.assertTrue(theme.startswith(d))


if __name__ == "__main__":
    unittest.main()

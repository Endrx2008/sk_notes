#!/usr/bin/env python3
"""Regenerate THIRD_PARTY_LICENSES.md from package-lock.json (runtime JS packages bundled
into the web front-end) plus the system Python packages sk_notes depends on."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = [
    ("Python 3", "PSF-2.0", "Interpreter (system package)."),
    ("PyQt6 / python3-pyqt6", "GPL-3.0", "Qt bindings (system package)."),
    ("Qt WebEngine / python3-pyqt6.qtwebengine", "LGPL-3.0 / GPL-3.0", "Chromium-based web engine for the workspace (system package)."),
    ("PyYAML / python3-yaml", "MIT", "Frontmatter parsing (system package)."),
    ("NumPy / python3-numpy", "BSD-3-Clause", "Vector search for the SKAI index (system package)."),
    ("websocket-client / python3-websocket", "Apache-2.0", "UI tests only (Chrome DevTools Protocol driver); not shipped."),
    ("esbuild", "MIT", "Build tool only; not shipped."),
]
NOT_BUNDLED = {"argparse": "used only by the markdown-it command line tool; not part of the bundle"}


def main():
    lock = json.loads((ROOT / "package-lock.json").read_text())
    rows = []
    for key, meta in lock["packages"].items():
        if not key or meta.get("dev"):
            continue
        pj = json.loads((ROOT / key / "package.json").read_text())
        name = key.split("node_modules/")[-1]
        repo = pj.get("repository")
        repo = repo.get("url") if isinstance(repo, dict) else repo or pj.get("homepage", "")
        rows.append((name, pj.get("version", ""), pj.get("license", "?"), str(repo or "").replace("git+", "")))
    rows.sort()
    out = ["# Third-party licenses", "",
           "sk_notes is licensed under GPL-3.0-or-later. It uses the components below; all their licenses are",
           "compatible with GPL-3.0. Full license texts are in each package (node_modules/<name>/LICENSE) and in",
           "the Debian/Arch packages of the system libraries.", "",
           "The type definitions of the public plugin API (npm package `obsidian`, MIT, © Dynalist Inc.) were",
           "used as a reference for names and signatures only; no file of that package is included in sk_notes.", "",
           "## System and build components", "", "| Component | License | Use |", "|---|---|---|"]
    out += [f"| {n} | {l} | {u} |" for n, l, u in PY]
    out += ["", "## JavaScript packages bundled in the web front-end", "", "| Package | Version | License | Source |", "|---|---|---|---|"]
    for name, ver, lic, repo in rows:
        note = f" ({NOT_BUNDLED[name]})" if name in NOT_BUNDLED else ""
        out.append(f"| {name}{note} | {ver} | {lic} | {repo} |")
    out += ["", "KaTeX fonts are distributed with KaTeX under the MIT license.", ""]
    (ROOT / "THIRD_PARTY_LICENSES.md").write_text("\n".join(out), encoding="utf-8")


if __name__ == "__main__":
    main()

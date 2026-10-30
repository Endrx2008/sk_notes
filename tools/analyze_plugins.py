#!/usr/bin/env python3
"""Summarise the community plugins downloaded in research/plugins/.

For every plugin it records: licence, which names of the plugin API it imports,
Node/Electron modules it requires, CodeMirror 6 packages it uses. The output is a
Markdown table plus a JSON file used to prioritise the compatibility layer.

Usage: tools/analyze_plugins.py <research dir> <output .md> <output .json>
"""

from __future__ import annotations

import collections
import json
import re
import sys
from pathlib import Path

NODE_BUILTINS = {
    "fs", "fs/promises", "path", "os", "child_process", "crypto", "url", "util", "stream",
    "events", "buffer", "http", "https", "net", "zlib", "electron", "@electron/remote",
    "process", "querystring", "readline", "worker_threads", "assert", "tls", "dns",
}
SRC_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".svelte", ".vue"}
IMPORT_RE = re.compile(
    r"""(?:import\s+(?:type\s+)?([\s\S]*?)\s+from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']"""
)
NAMES_RE = re.compile(r"\{([^}]*)\}")
SKIP_DIRS = {"node_modules", ".git", "dist", "build", "docs", "test", "tests", "__tests__", "example", "examples"}


def licence_of(src: Path) -> str:
    pkg = src / "package.json"
    if pkg.exists():
        try:
            lic = json.loads(pkg.read_text(encoding="utf-8", errors="replace")).get("license")
            if isinstance(lic, str) and lic.strip():
                return lic.strip()
        except ValueError:
            pass
    for name in ("LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE", "COPYING"):
        f = src / name
        if f.exists():
            head = f.read_text(encoding="utf-8", errors="replace")[:600].lower()
            for key, label in (("mit license", "MIT"), ("permission is hereby granted", "MIT"),
                               ("gnu affero", "AGPL-3.0"), ("gnu general public license", "GPL"),
                               ("apache license", "Apache-2.0"), ("mozilla public", "MPL-2.0"),
                               ("bsd", "BSD"), ("isc license", "ISC"), ("unlicense", "Unlicense")):
                if key in head:
                    return label
            return "custom (see file)"
    return "none found"


def source_files(src: Path):
    for path in src.rglob("*"):
        if path.suffix in SRC_EXT and path.is_file() and not (set(path.relative_to(src).parts) & SKIP_DIRS):
            if not path.name.endswith(".d.ts") and path.stat().st_size < 3_000_000:
                yield path


def analyse(plugin_dir: Path) -> dict:
    src = plugin_dir / "src"
    api, node, cm, other = collections.Counter(), set(), set(), set()
    files = 0
    for f in source_files(src) if src.exists() else []:
        files += 1
        text = f.read_text(encoding="utf-8", errors="replace")
        for clause, module in IMPORT_RE.findall(text):
            base = module[5:] if module.startswith("node:") else module
            if module == "obsidian":
                m = NAMES_RE.search(clause or "")
                for name in (m.group(1).split(",") if m else []):
                    name = name.strip().replace("type ", "").split(" as ")[0].strip()
                    if name:
                        api[name] += 1
            elif base in NODE_BUILTINS or base.split("/")[0] in NODE_BUILTINS:
                node.add(base)
            elif module.startswith("@codemirror/") or module.startswith("@lezer/"):
                cm.add(module)
            elif not module.startswith("."):
                other.add(module.split("/")[0] if not module.startswith("@") else "/".join(module.split("/")[:2]))
        for call in re.findall(r"\b(?:app|this\.app)\.(\w+)\.(\w+)", text):
            api[f"app.{call[0]}.{call[1]}"] += 0  # presence only (count kept at 0)
    manifest = {}
    for m in (plugin_dir / "release" / "manifest.json", src / "manifest.json"):
        if m.exists():
            try:
                manifest = json.loads(m.read_text(encoding="utf-8"))
                break
            except ValueError:
                pass
    return {
        "id": plugin_dir.name,
        "licence": licence_of(src) if src.exists() else "source missing",
        "files": files,
        "api": sorted(k for k in api if not k.startswith("app.")),
        "app_paths": sorted(k for k in api if k.startswith("app.")),
        "node": sorted(node),
        "codemirror": sorted(cm),
        "npm": sorted(other),
        "desktop_only": bool(manifest.get("isDesktopOnly")),
        "min_app_version": manifest.get("minAppVersion", ""),
        "has_release": (plugin_dir / "release" / "main.js").exists(),
    }


def main() -> int:
    research, out_md, out_json = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    top = json.loads((research / "top-plugins.json").read_text())[:50]
    rows = [analyse(research / "plugins" / p["id"]) | {"downloads": p["downloads"], "repo": p["repo"]}
            for p in top]
    out_json.write_text(json.dumps(rows, indent=1), encoding="utf-8")

    api_total = collections.Counter(n for r in rows for n in r["api"])
    node_total = collections.Counter(n for r in rows for n in r["node"])
    cm_total = collections.Counter(n for r in rows for n in r["codemirror"])
    lines = [
        "# Community plugins studied (top 50 by downloads)",
        "",
        "Generated by `tools/analyze_plugins.py` from the public sources downloaded into",
        "`research/plugins/` (not committed). No plugin code is copied into sk_notes; this",
        "table only records licence and which public API surface each plugin needs.",
        "",
        "| # | Plugin | Downloads | Licence | Desktop only | Node/Electron | CodeMirror 6 | API names used |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for i, r in enumerate(rows, 1):
        lines.append(
            f"| {i} | `{r['id']}` | {r['downloads']:,} | {r['licence']} | {'yes' if r['desktop_only'] else 'no'} "
            f"| {', '.join(r['node']) or '–'} | {', '.join(x.split('/')[-1] for x in r['codemirror']) or '–'} "
            f"| {len(r['api'])}: {', '.join(r['api'][:18])}{' …' if len(r['api']) > 18 else ''} |"
        )
    lines += ["", "## API names by number of plugins using them", ""]
    lines += [f"- `{n}`: {c}" for n, c in api_total.most_common()]
    lines += ["", "## Node / Electron modules", ""]
    lines += [f"- `{n}`: {c}" for n, c in node_total.most_common()]
    lines += ["", "## CodeMirror / Lezer packages", ""]
    lines += [f"- `{n}`: {c}" for n, c in cm_total.most_common()]
    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())

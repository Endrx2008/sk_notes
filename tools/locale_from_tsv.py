#!/usr/bin/env python3
"""Build sk_notes/locales/<code>.json from a TSV file (key<TAB>text), keeping the key
order of en.json. Missing keys are left out (they fall back to English).

Usage: tools/locale_from_tsv.py <code> "<language name>" <file.tsv>"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    code, name, tsv = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    en = json.loads((ROOT / "sk_notes/locales/en.json").read_text(encoding="utf-8"))
    tr = {}
    for line in tsv.read_text(encoding="utf-8").splitlines():
        if "\t" in line:
            k, v = line.split("\t", 1)
            tr[k.strip()] = v.replace("\\n", "\n")
    out = {"_meta": {"name": name, "needsReview": True}}
    for k in en:
        if k != "_meta" and k in tr:
            out[k] = tr[k]
    (ROOT / f"sk_notes/locales/{code}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(code, len(out) - 1, "of", len(en) - 1, "unknown:", sorted(set(tr) - set(en))[:10])


if __name__ == "__main__":
    main()

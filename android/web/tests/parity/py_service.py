"""Runs the desktop VaultService on a vault and a list of operations; prints the results."""
import json, sys
sys.path.insert(0, sys.argv[1])
from sk_notes.core.service import VaultService
from sk_notes.core.search import search
from sk_notes.core import links

svc = VaultService(sys.argv[2])
svc.open()
out = []
for op in json.load(sys.stdin):
    kind = op["op"]
    try:
        if kind == "snapshot":
            s = svc.index.snapshot()
            out.append({"files": [{"path": f["path"], "folder": f["folder"], "size": f.get("size")} for f in s["files"]],
                        "metadata": s["metadata"], "resolved": s["resolvedLinks"], "unresolved": s["unresolvedLinks"]})
        elif kind == "search":
            r = search(svc.index, op["query"], case_sensitive=op.get("cs", False), context=op.get("context", 1))
            out.append({"total": r["total"], "results": sorted(({"path": x["path"], "matches": x["matches"]} for x in r["results"]), key=lambda x: x["path"])})
        elif kind == "rename":
            r = svc.rename(op["path"], op["newPath"], update_links=op.get("updateLinks"))
            out.append({"path": r["path"], "updated": sorted(r["updated"])})
        elif kind == "write":
            svc.write(op["path"], op["text"])
            out.append(True)
        elif kind == "delete":
            r = svc.delete(op["path"], mode=op.get("mode", "permanent"))
            out.append({"mode": r["mode"], "removed": sorted(r["removed"])})
        elif kind == "resolve":
            out.append(svc.index.resolve(op["link"], op.get("source", "")))
        elif kind == "linktext":
            out.append(links.generate_markdown_link(svc.index, op["target"], op["source"]) if False else links.linkpath_for(svc.index, op["target"], op["source"]))
        elif kind == "tags":
            out.append(svc.index.all_tags())
        elif kind == "properties":
            out.append(svc.index.properties())
        elif kind == "read":
            out.append(svc.vault.read_bytes(op["path"]).decode("utf-8"))
        else:
            out.append({"error": "unknown op"})
    except Exception as exc:  # noqa: BLE001
        out.append({"error": str(exc)})
json.dump(out, sys.stdout)

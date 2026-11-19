"""Runs the desktop parser on a JSON list of texts (stdin) and prints the results."""
import json, sys
sys.path.insert(0, sys.argv[1])
from sk_notes.core import parser
texts = json.load(sys.stdin)
json.dump([{"meta": parser.parse(t), "tags": parser.all_tags(parser.parse(t)), "aliases": parser.aliases(parser.parse(t))} for t in texts], sys.stdout)

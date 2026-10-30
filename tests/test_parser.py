import unittest

from sk_notes.core.parser import aliases, all_tags, parse, parse_linktext


def links(meta):
    return [l["link"] for l in meta.get("links", [])]


def tags(meta):
    return [t["tag"] for t in meta.get("tags", [])]


class LinkTests(unittest.TestCase):
    def test_wikilink_alias_heading_block(self):
        m = parse("See [[Note|alias]], [[Other#Head]] and [[Third#^abc|x]].")
        self.assertEqual(links(m), ["Note", "Other#Head", "Third#^abc"])
        self.assertEqual(m["links"][0]["displayText"], "alias")
        self.assertEqual(m["links"][0]["original"], "[[Note|alias]]")

    def test_embeds_are_separate(self):
        m = parse("![[pic.png]] [[note]] ![alt](img/a%20b.png)")
        self.assertEqual([e["link"] for e in m["embeds"]], ["pic.png", "img/a b.png"])
        self.assertEqual(links(m), ["note"])

    def test_markdown_internal_links_decoded_external_ignored(self):
        m = parse("[a](My%20Note.md) [b](https://example.org) [c](mailto:x@y.z) [d](<Folder/Space Name.md>)")
        self.assertEqual(links(m), ["My Note.md", "Folder/Space Name.md"])

    def test_code_math_and_comments_are_ignored(self):
        text = "`[[no]]` $[[no]]$ %%[[no]]%% <!-- [[no]] -->\n```\n[[no]] #no\n```\n$$\n[[no]]\n$$\n%%\n[[no]]\n%%\n[[yes]]"
        m = parse(text)
        self.assertEqual(links(m), ["yes"])
        self.assertEqual(tags(m), [])

    def test_positions(self):
        m = parse("ab\ncd [[x]]")
        p = m["links"][0]["position"]
        self.assertEqual(p["start"], {"line": 1, "col": 3, "offset": 6})
        self.assertEqual(p["end"], {"line": 1, "col": 8, "offset": 11})

    def test_utf16_offsets_after_emoji(self):
        m = parse("😀 [[x]]")
        self.assertEqual(m["links"][0]["position"]["start"]["offset"], 3)

    def test_crlf(self):
        m = parse("# H\r\n[[x]]\r\n")
        self.assertEqual(links(m), ["x"])
        self.assertEqual(m["headings"][0]["heading"], "H")

    def test_parse_linktext(self):
        self.assertEqual(parse_linktext("a/b#c#d"), ("a/b", "#c#d"))
        self.assertEqual(parse_linktext("plain"), ("plain", ""))

    def test_unclosed_brackets_do_not_crash(self):
        m = parse("[[open and [[ nested ]] ]] [[]] [[|x]] ![[")
        self.assertEqual(links(m), ["nested"])


class TagTests(unittest.TestCase):
    def test_tag_rules(self):
        m = parse("#a #b/c #1984 #y1984 #tag-with_dash #émoji #中文 a#no (#paren) #end.")
        self.assertEqual(tags(m), ["#a", "#b/c", "#y1984", "#tag-with_dash", "#émoji", "#中文", "#paren", "#end"])

    def test_heading_is_not_tag_and_url_fragment_ignored(self):
        m = parse("# Heading\nhttps://x.org/#frag [l](https://y.org/#f) #real")
        self.assertEqual(tags(m), ["#real"])

    def test_frontmatter_tags_and_aliases(self):
        m = parse("---\ntags: [a, '#b']\naliases: one, two\n---\n#c")
        self.assertEqual(sorted(all_tags(m)), ["#a", "#b", "#c"])
        self.assertEqual(aliases(m), ["one", "two"])

    def test_tags_string_property(self):
        m = parse("---\ntags: x y, z\n---\n")
        self.assertEqual(all_tags(m), ["#x", "#y", "#z"])


class FrontmatterTests(unittest.TestCase):
    def test_dates_stay_strings(self):
        m = parse("---\ndate: 2024-05-01\ntime: 2024-05-01T10:00:00\nn: 3\nok: true\n---\nbody")
        self.assertEqual(m["frontmatter"], {"date": "2024-05-01", "time": "2024-05-01T10:00:00", "n": 3, "ok": True})
        self.assertEqual(m["frontmatterPosition"]["end"]["line"], 5)

    def test_invalid_yaml_reported_not_raised(self):
        m = parse("---\nkey: [unclosed\n---\n[[x]]")
        self.assertNotIn("frontmatter", m)
        self.assertIn("frontmatterError", m)
        self.assertEqual(links(m), ["x"])

    def test_not_frontmatter_when_not_first_line(self):
        m = parse("\n---\na: 1\n---\n")
        self.assertNotIn("frontmatter", m)

    def test_unterminated_frontmatter(self):
        m = parse("---\na: 1\nno end")
        self.assertNotIn("frontmatter", m)

    def test_frontmatter_links(self):
        m = parse("---\nup: \"[[Home]]\"\nrel:\n  - \"[[A|x]]\"\n  - plain\n---\n")
        self.assertEqual([(l["key"], l["link"]) for l in m["frontmatterLinks"]], [("up", "Home"), ("rel.0", "A")])

    def test_non_mapping_yaml(self):
        m = parse("---\n- a\n- b\n---\n")
        self.assertIn("frontmatterError", m)


class StructureTests(unittest.TestCase):
    def test_headings_atx_and_setext(self):
        m = parse("# One\ntext\n\nTwo\n===\n\n### Three ###\n####### no")
        self.assertEqual([(h["heading"], h["level"]) for h in m["headings"]], [("One", 1), ("Two", 1), ("Three", 3)])

    def test_tasks_and_parents(self):
        m = parse("- [ ] a\n  - [x] b\n- c\n\n1. [/] d")
        items = m["listItems"]
        self.assertEqual([i.get("task") for i in items], [" ", "x", None, "/"])
        self.assertEqual(items[1]["parent"], 0)
        self.assertLess(items[0]["parent"], 0)
        self.assertLess(items[3]["parent"], 0)

    def test_block_ids(self):
        m = parse("para line ^p1\n\n- item ^Item2\n\n| a |\n|---|\n| b |\n\n^tbl")
        self.assertEqual(sorted(m["blocks"]), ["item2", "p1", "tbl"])
        self.assertEqual(m["listItems"][0]["id"], "Item2")

    def test_sections(self):
        m = parse("---\na: 1\n---\n# H\npara\n\n> [!note] x\n> y\n\n```\ncode\n```\n\n| a |\n|---|\n\n---\n")
        self.assertEqual([s["type"] for s in m["sections"]], ["yaml", "heading", "paragraph", "callout", "code", "table", "thematicBreak"])

    def test_footnotes(self):
        m = parse("Text[^1]\n\n[^1]: note")
        self.assertEqual(m["footnotes"][0]["id"], "1")

    def test_empty(self):
        self.assertEqual(parse(""), {})


if __name__ == "__main__":
    unittest.main()

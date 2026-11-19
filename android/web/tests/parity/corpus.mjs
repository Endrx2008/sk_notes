// Markdown samples used to compare the Android (JS) backend with the desktop (Python) one.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const SAMPLES = [
  '',
  'plain text',
  '---\ntitle: Hello\ntags: [a, b/c]\naliases:\n  - One\n  - Two\ndate: 2024-03-05\ntime: 2024-03-05T10:20:30\nnum: 3\nflag: true\nlink: "[[Target|shown]]"\nlist:\n  - "[[A]]"\n  - "[[B#h]]"\n---\n# Title\n\nBody with [[Link]] and [[Other#Heading|alias]] and ![[image.png|100]].\n',
  '---\ntitle: broken: yaml: here\n  - x\n---\ntext #tag',
  '---\n- just\n- a list\n---\nbody',
  '---\n---\nempty frontmatter\n',
  '---\nkey: value\n...\nafter dots',
  '--- \nkey: value\n---  \nspaces after dashes',
  '---\nno end\n# h',
  '# H1\n## H2 ##\n### H3 with `code` ###   \n####### not heading\n#nospace\nSetext\n======\nAnother\nsetext\n------\n',
  '- a\n- b\n  - c\n    - d\n- [ ] todo\n- [x] done ^blk-1\n* star\n+ plus\n1. one\n2) two\n\n- new list\n   continuation line\n- [/] half\n',
  'Para one\ncontinues ^para-id\n\nPara two\n\n^orphan\n',
  '> quote\n> more\n\n> [!note] Callout title\n> content\n\n> [!warning]- Folded\n> x ^callq\n',
  '| a | b |\n|---|:-:|\n| 1 | 2 |\n| [[T|x]] | #tag |\n^table-id\n\nafter',
  '```js\nconst x = "[[notalink]] #notatag";\n```\n\n~~~\n[[also not]]\n~~~\n\n    indented [[is a link in this parser]]\n\n````md\n```\ninner\n```\n````\n[[real]]',
  'inline `[[code]] #no` and ``double ` tick [[x]]`` then [[yes]] #yes',
  'math $[[a]]$ and $$\n[[b]] #c\n$$\nand $$ [[one-line]] $$\n[[after]] costs $5 and $6 here',
  '%% hidden [[x]] #y %% visible [[z]]\n\n%%\nblock [[hidden]]\n#hiddentag\n%%\n\n<!-- [[c1]] #c2 -->\n<!--\nmulti [[c3]]\n-->\nshown #shown',
  '[text](note.md) [t2](folder/My%20Note.md#head) [ext](https://example.com/#frag) ![img](pic.png "title") [angle](<with space.md>) [empty]() [hash](#) [h2](#local) [nested [x]](a.md) [par](a(b).md)',
  'tags: #a #b/c #d_e #f-g #1 #1a #12/34 #x/ #é #日本語 a#no /#no &#no #yes, #yes2. (#paren) #em😀ji ##double #tag!bang http://a.b/#frag https://x.y/z#q',
  '---\ntags: one, two three\nalias: Solo\n---\n#body',
  '---\ntags:\n  - "#hash"\n  - 42\n  - nested/tag\naliases: [1, null, " sp "]\n---\n',
  'Footnote[^1] and [^named].\n\n[^1]: The note\n[^named]: Another [[link]]\n',
  '***\n---\n___\n- - -\n* * *\ntext\n',
  '<div>\n[[inside html]] #htmltag\n</div>\n\n<span>inline</span> [[x]]',
  'emoji 😀 [[Link 😀]] then #tag😀 and more [[second]] 👨‍👩‍👧 [md](😀.md)',
  'CRLF line\r\n[[one]]\r\n\r\n# Head\r\n- item\r\n',
  'old mac\r[[cr]]\r# h\r',
  '[[a|b|c]] [[ spaced ]] [[#only-heading]] [[note#^block]] [[note#h1#h2]] [[]] [[ ]] ![[embed#sec]] [[a]][[b]]',
  '1. a\n   - b\n     1. c\n2. d\n\ntext\n- e\n\n\t- tabbed\n\t\t- deeper\n',
  '$$\nunclosed math\n[[x]]',
  '```\nunclosed fence\n[[x]]',
  '%%\nunclosed comment\n[[x]]',
  'a\n\n\n\nb\n',
  '\n\n# starts with blank lines\n',
  '- [ ] task one #todo\n- [x] task two [[done]]\n\t- [ ] sub ^sub1\n- [?] odd\n-[ ] not a list\n- []\n',
  '# A\ntext\n## B\n```\n# not heading\n```\n## C\n> # quoted heading\n',
  '---\nanchors: &a [1, 2]\nref: *a\nmulti: |\n  line1\n  line2\nfolded: >\n  f1\n  f2\nnul: null\ntilde: ~\nempty:\nquoted: "yes"\nfloat: 1.5\nneg: -3\nyes1: yes\noff1: Off\nletter: n\nstr: 007x\n---\n',
  '---\n"__proto__": x\nconstructor: y\n---\n^__proto__\n\ntext ^constructor\n',
  'link in heading\n\n# [[HeadLink]] and #headtag\n\n[link](path/to/file.pdf) ![[file.pdf#page=3]]\n',
  'x'.repeat(5000) + ' [[far]] #end',
  Array.from({ length: 300 }, (_, i) => `- item ${i} [[L${i % 7}]] #t${i % 5}`).join('\n'),
];

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules' || name === 'research' || name === 'build' || name === 'dist') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.md') && st.size < 300000) out.push(readFileSync(p, 'utf8'));
  }
}

/** The samples plus every Markdown file found in the given folders (real documents). */
export function corpus(dirs = []) {
  const out = SAMPLES.slice();
  for (const d of dirs) { try { walk(d, out); } catch { /* folder not there */ } }
  return out;
}

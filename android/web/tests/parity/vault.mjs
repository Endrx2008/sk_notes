// A small vault with the cases that matter for links, search and renames.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FILES = {
  'Home.md': '---\ntags: [index, area/work]\naliases: [Start]\nstatus: open\nrating: 4\ndone: false\nrelated: "[[Alpha]]"\n---\n# Home\n\nSee [[Alpha]], [[Projects/Plan|the plan]] and [[Plan#Goals]].\nAlso ![[pic.png]] and [md link](Projects/Plan.md) plus [rel](Projects/Ideas%20Box.md#top).\n\n- [ ] buy coffee for the garden party #todo\n- [x] water the garden\n\nMissing: [[Nowhere]] [[Ghost#h]]\n',
  'Alpha.md': '# Alpha\n\nBack to [[Home]]. The river flows near the garden.\n\n## Details\n\nCoffee kernel notes. See [[Beta]] and [[beta|lowercase]].\n\n^alpha-block\n',
  'Beta.md': 'Beta links [[Alpha#Details]] and [[Alpha#^alpha-block]] and ![[Alpha]].\n\nTEXT in CAPS and text in lower. A regex target: abc123def.\n',
  'Projects/Plan.md': '---\ntags: project\ndue: 2024-05-01\n---\n# Plan\n\n## Goals\n\nGoal one. Link up: [[Home]] and sideways [[Ideas Box]] and relative [up](../Alpha.md) and [side](Ideas%20Box.md).\n\n- [ ] write the plan #todo\n',
  'Projects/Ideas Box.md': '# Ideas Box\n\nAn idea about coffee. [[Plan]] [[Projects/Plan]] [[Alpha|a]]\n',
  'Projects/Sub/Deep.md': 'Deep note → [[Plan]] [[../Plan]] [[Home]] [x](../../Alpha.md)\n',
  'Archive/Plan.md': '# Old plan\n\nSame name as the other Plan. [[Home]] [[Projects/Plan]]\n',
  'Archive/Alpha copy.md': 'nothing here but the word river\n',
  'Daily/2024-03-05.md': '---\ntags:\n  - daily\n---\nToday: [[Home]] #daily/log\n',
  'Notes with (parens).md': 'paren note [[Alpha]]\n',
  'Ünïcödé Nöte.md': 'unicode [[Home]] café 😀 #tag😀\n',
  'empty.md': '',
  'Board.canvas': JSON.stringify({ nodes: [{ id: '1', type: 'text', text: 'Card about the garden', x: 0, y: 0, width: 10, height: 10 }, { id: '2', type: 'file', file: 'Alpha.md', x: 0, y: 0, width: 10, height: 10 }, { id: '3', type: 'group', label: 'Group label', x: 0, y: 0, width: 10, height: 10 }], edges: [] }, null, '\t'),
  'Tasks.base': 'views:\n  - type: table\n    name: Tasks\n',
  'plain.txt': 'a plain text file mentioning coffee\n',
  'pic.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
  'Attachments/doc.pdf': Buffer.from('%PDF-1.4\n%%EOF\n'),
  'crlf.md': 'line one [[Alpha]]\r\nline two\r\n',
};

export function makeVault(prefix = 'skn-vault-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, data] of Object.entries(FILES)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }
  fs.mkdirSync(path.join(dir, 'Empty folder'));
  return dir;
}

export function readTree(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      if (name.startsWith('.')) continue;
      const p = path.join(d, name);
      const r = rel ? rel + '/' + name : name;
      if (fs.statSync(p).isDirectory()) walk(p, r); else if (/\.(md|canvas|base|txt)$/.test(name)) out[r] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

// skai_memory.js - JavaScript twin of skai_memory.py (same methods, same ranking). One file, no dependencies.
//
//   import { Memory } from './skai_memory.js';          // ES module (Node, WebExtension pages, Gecko experiments)
//   const m = new Memory({ app: 'skmail' });           // identifies the app; Node: /var/lib/skai/SKAI_ Memory
//   const hits = await m.search('meeting with Anna');   // reads every app's notes
//   await m.remember('inbox', 'Anna asked to move the meeting', { links: ['[[skalendar]]'] }); // only plugins/skmail/**
//
// Outside Node pass the file access you have: new Memory({ fs: { list, read, write } })
//   list(dir) -> array of { name, isDir }     read(path) -> text     write(path, text, mode) -> void
// For Firefox/Thunderbird experiment code there is ioUtilsFs(IOUtils, spawn) below.
// Reading is plain file reading; writing is delegated to `write`, which must end in skai-memory-write.

export const DEFAULT_DIR = '/var/lib/skai/SKAI_ Memory';
const WIKI = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const MDLINK = /(?<!!)\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
const NAME = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const WORD = /[\p{L}\p{N}_]{2,}/gu;

const tokens = (s) => (s.match(WORD) || []).map((w) => w.toLowerCase());
const stem = (p) => p.split('/').pop().replace(/\.md$/i, '');

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return [{}, text];
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return [meta, text.slice(m[0].length)];
}

/** 'solid' (the tree) | 'dashed' (same app's memory) | 'dotted' (between different apps). */
export function edgeStyle(a, b) {
  if (!a.app || !b.app) return 'solid';
  if (a.app !== b.app) return 'dotted';
  return a.kind === 'app' || b.kind === 'app' ? 'solid' : 'dashed';
}

export function slug(text) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note';
}

function parse(rel, text) {
  const [meta, body] = frontmatter(text);
  const heads = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]);
  const title = meta.title || heads[0] || stem(rel);
  const parts = rel.split('/');
  const plug = parts[0] === 'plugins';
  const app = plug && parts.length > 1 ? (parts.length === 2 ? parts[1].slice(0, -3) : parts[1]) : '';
  const kind = plug && parts.length === 2 ? 'app' : plug ? 'chat' : parts.length > 1 ? parts[0] : 'hub';
  const wiki = [...body.matchAll(WIKI)].map((m) => m[1].trim());
  const external = [...body.matchAll(MDLINK)].map((m) => m[1]).filter((u) => /^(https?:\/\/|file:\/\/|skai:\/\/|\/)/.test(u));
  return { path: rel, title, app, kind, text: body, wiki, external, headings: heads.map((h) => h.toLowerCase()),
    tokens: tokens(body), titleTokens: new Set(tokens(`${title} ${stem(rel)}`)) };
}

export class Memory {
  constructor({ app = null, root = DEFAULT_DIR, fs = null } = {}) {
    if (app !== null && !NAME.test(app)) throw new Error(`app name must match [a-z0-9][a-z0-9_-]{1,39}: ${app}`);
    this.app = app;
    this._registered = false;
    this.root = root.replace(/\/+$/, '');
    this._fs = fs;
    this._cache = new Map();
  }

  async _io() {
    if (this._fs) return this._fs;
    const nfs = await import('node:fs/promises');
    const cp = await import('node:child_process');
    this._fs = {
      list: async (d) => (await nfs.readdir(d, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() })),
      read: (p) => nfs.readFile(p, 'utf8'),
      write: (p, text, mode, rel, caller) => new Promise((resolve, reject) => {
        const direct = process.env.SKAI_MEMORY_NO_SUDO === '1';
        const args = direct ? [new URL('./skai-memory-write', import.meta.url).pathname, '--direct']
          : ['-n', '/usr/lib/skai/skai-memory-write', '--skai'];
        const p2 = cp.spawn(direct ? 'python3' : 'sudo', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let err = '';
        p2.stderr.on('data', (d) => { err += d; });
        p2.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err.trim() || 'write refused'))));
        p2.stdin.end(JSON.stringify({ op: mode, path: rel, text, dir: this.root, caller }));
      }),
    };
    return this._fs;
  }

  async notes() {
    const fs = await this._io();
    const out = new Map();
    const walk = async (dir, rel) => {
      for (const e of await fs.list(dir)) {
        if (e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDir) await walk(`${dir}/${e.name}`, r);
        else if (e.name.endsWith('.md')) {
          try { out.set(r, parse(r, await fs.read(`${dir}/${e.name}`))); } catch { /* unreadable: skip */ }
        }
      }
    };
    await walk(this.root, '');
    const byName = new Map();
    for (const rel of [...out.keys()].sort()) {
      const a = stem(rel).toLowerCase(); const b = rel.slice(0, -3).toLowerCase();
      if (!byName.has(a)) byName.set(a, rel);
      if (!byName.has(b)) byName.set(b, rel);
    }
    for (const n of out.values()) {
      n.out = [...new Set(n.wiki.map((w) => byName.get(w.toLowerCase().replace(/\.md$/, ''))).filter((t) => t && t !== n.path))].sort();
      n.back = [];
    }
    for (const n of out.values()) for (const t of n.out) out.get(t).back.push(n.path);
    return out;
  }

  async read(path) { return (await this._io()).read(`${this.root}/${this._rel(path)}`); }

  async links(path) {
    const n = (await this.notes()).get(this._rel(path));
    return { notes: n.out, backlinks: [...n.back].sort(), external: n.external };
  }

  async graph() {
    const notes = await this.notes();
    return { nodes: [...notes.values()].map((n) => ({ id: n.path, title: n.title, app: n.app, kind: n.kind })),
      edges: [...notes.values()].flatMap((n) => n.out.map((t) => ({ from: n.path, to: t, style: edgeStyle(n, notes.get(t)) }))) };
  }

  async search(query, { app = this.app, hops = 1, limit = 8, onlyApp = false } = {}) {
    const notes = await this.notes();
    const q = tokens(query);
    if (!q.length || !notes.size) return [];
    const N = notes.size;
    const df = new Map([...new Set(q)].map((t) => [t, [...notes.values()].filter((n) => n.titleTokens.has(t) || n.tokens.includes(t)).length]));
    const scores = new Map();
    for (const [rel, n] of notes) {
      if (onlyApp && app && n.app !== app && n.kind !== 'hub' && n.kind !== 'app') continue;
      let s = 0;
      for (const t of q) {
        const idf = Math.log(1 + N / (1 + df.get(t)));
        const tf = n.tokens.filter((x) => x === t).length;
        s += idf * ((n.titleTokens.has(t) ? 3 : 0) + (n.headings.some((h) => h.includes(t)) ? 2 : 0) + tf / (tf + 1.2));
      }
      if (s > 0) scores.set(rel, s * (app && n.app === app ? 1.5 : 1));
    }
    const seeds = [...scores.keys()].sort((a, b) => scores.get(b) - scores.get(a)).slice(0, limit);
    const found = new Map(seeds.map((r) => [r, [scores.get(r), null]]));
    let frontier = seeds;
    for (let h = 1; h <= Math.max(0, hops); h++) {
      const next = [];
      for (const r of frontier) {
        for (const t of [...notes.get(r).out, ...notes.get(r).back]) {
          const sc = found.get(r)[0] * 0.5 ** h;
          if (!found.has(t) || found.get(t)[0] < sc) {
            if (!found.has(t)) next.push(t);
            found.set(t, [sc, r]);
          }
        }
      }
      frontier = next;
    }
    return [...found.keys()].sort((a, b) => found.get(b)[0] - found.get(a)[0]).slice(0, limit * 2).map((r) => {
      const n = notes.get(r);
      const low = n.text.toLowerCase();
      const at = q.map((t) => low.indexOf(t)).filter((i) => i >= 0);
      const pos = at.length ? Math.min(...at) : 0;
      return { path: r, title: n.title, app: n.app, kind: n.kind, score: Math.round(found.get(r)[0] * 1000) / 1000,
        via: found.get(r)[1], snippet: n.text.slice(Math.max(0, pos - 40), pos + 160).replace(/\n/g, ' ').trim(), external: n.external };
    });
  }

  _rel(path) {
    const p = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!p.endsWith('.md') || p.split('/').some((x) => x === '' || x === '..')) throw new Error(`not a note path: ${path}`);
    return p;
  }

  _needApp() { if (!this.app) throw new Error("identify the app first: new Memory({ app: 'your-app' })"); }

  _own(path) {
    this._needApp();
    const p = this._rel(path);
    if (!(p === `plugins/${this.app}.md` || p.startsWith(`plugins/${this.app}/`))) {
      throw new Error(`${this.app} may only change its own notes (plugins/${this.app}.md, plugins/${this.app}/)`);
    }
    return p;
  }

  async register() {
    this._needApp();
    const rel = `plugins/${this.app}.md`;
    await (await this._io()).write(`${this.root}/${rel}`, '', 'register', rel, this.app);
    this._registered = true;
    return rel;
  }

  async write(path, text) { const p = this._own(path); return (await this._io()).write(`${this.root}/${p}`, text, 'write', p, this.app); }
  async append(path, text) { const p = this._own(path); return (await this._io()).write(`${this.root}/${p}`, text, 'append', p, this.app); }

  async _exists(rel) { try { await this.read(rel); return true; } catch { return false; } }

  async _ensureRegistered() {
    if (!this._registered && !(await this._exists(`plugins/${this.app}.md`))) await this.register();
    this._registered = true;
  }

  async remember(chat, text, { links = [] } = {}) {
    this._needApp();
    await this._ensureRegistered();
    const c = slug(chat);
    const path = `plugins/${this.app}/${c}.md`;
    if (!(await this._exists(path))) {
      await this.write(path, `---\napp: ${this.app}\nkind: chat\ntitle: ${chat}\n---\n# ${chat}\n\nSub-chat of [[plugins/${this.app}]].\n`);
      await this.append(`plugins/${this.app}.md`, `- [[plugins/${this.app}/${c}]]\n`);
    }
    const extra = links.map((l) => `- ${l.startsWith('[') ? l : `[${l}](${l.includes('://') ? l : `file://${l}`})`}\n`).join('');
    const d = new Date(); const pad = (x) => String(x).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    await this.append(path, `\n## ${stamp}\n\n${text.trim()}\n${extra ? `\n${extra}` : ''}`);
    return path;
  }

  /** Leave a link from this app's note to another app's note (or one of its sub-chats). */
  async link(otherApp, why = '', note = null) {
    this._needApp();
    await this._ensureRegistered();
    const target = note ? `plugins/${otherApp}/${slug(note)}` : `plugins/${otherApp}`;
    await this.append(`plugins/${this.app}.md`, `- [[${target}]]${why ? ` — ${why}` : ''}\n`);
  }
}

/** Adapter for Firefox/Thunderbird experiment code: `fs` for Memory from IOUtils and a spawn function
 *  `spawn(argv, stdinText) -> Promise<{code, stderr}>` (Subprocess.sys.mjs) used for writes. */
export function ioUtilsFs(IOUtils, spawn) {
  return {
    list: async (d) => Promise.all((await IOUtils.getChildren(d)).map(async (p) => ({ name: p.split('/').pop(), isDir: (await IOUtils.stat(p)).type === 'directory' }))),
    read: (p) => IOUtils.readUTF8(p),
    write: async (p, text, mode, rel, caller) => {
      const r = await spawn(['sudo', '-n', '/usr/lib/skai/skai-memory-write', '--skai'], JSON.stringify({ op: mode, path: rel, text, caller }));
      if (r.code !== 0) throw new Error(r.stderr || 'write refused');
    },
  };
}

export default Memory;

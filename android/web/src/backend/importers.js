// sk_notes for Android – importers from other note apps.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Everything is converted on the device; nothing is sent anywhere. Each importer returns
// items {path, text} or {path, b64} that the caller writes into a folder of the vault
// (never overwriting: names get " 1", " 2"...). Same formats and results as the desktop
// importers (sk_notes/extras/importers.py).

import YAML from 'yaml';
import { native } from './native.js';
import { ApiError, b64ToText, basename, breathe, bytesToB64, textToB64 } from './util.js';

const SAFE_RE = /[\\/:*?"<>|#^[\]]+/g;

export function safeName(name, fallback = 'Untitled') {
  let n = String(name || '').replace(SAFE_RE, ' ').trim().replace(/^\.+|\.+$/g, '');
  n = n.replace(/\s+/g, ' ').slice(0, 120).trim();
  return n || fallback;
}

export function frontmatter(data) {
  const clean = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    clean[k] = v;
  }
  if (!Object.keys(clean).length) return '';
  return '---\n' + YAML.stringify(clean, { indentSeq: false, lineWidth: 0 }).trim() + '\n---\n';
}

const stem = (name) => (name.slice(1).includes('.') ? name.slice(0, name.lastIndexOf('.')) : name);
const isoUtc = (ms) => new Date(ms).toISOString().slice(0, 19);

// --------------------------------------------------------------------------- markup tokenizer
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', euro: '€', pound: '£', deg: '°', times: '×',
  agrave: 'à', egrave: 'è', eacute: 'é', igrave: 'ì', ograve: 'ò', ugrave: 'ù', auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß', ntilde: 'ñ', ccedil: 'ç' };

let entityEl = null;
/** Character references → characters (all named ones in the app; the common ones elsewhere). */
export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    if (Object.hasOwn(ENTITIES, ref)) return ENTITIES[ref];
    if (Object.hasOwn(ENTITIES, ref.toLowerCase()) && ref.length > 2) return ENTITIES[ref.toLowerCase()];
    if (globalThis.document && m.endsWith(';')) {
      entityEl ||= document.createElement('textarea'); // a textarea never runs or loads anything
      entityEl.innerHTML = m;
      return entityEl.value;
    }
    return m;
  });
}

const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Walk markup, calling on.start(tag, attrs), on.end(tag), on.text(text). Tolerant like a
 * browser: broken markup never throws. Tag names are lower-cased unless `xml`. */
export function tokenize(src, on, { xml = false } = {}) {
  let i = 0;
  const n = src.length;
  const name = (s) => (xml ? s : s.toLowerCase());
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { on.text?.(decodeEntities(src.slice(i))); break; }
    if (lt > i) on.text?.(decodeEntities(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      on.text?.(src.slice(lt + 9, end === -1 ? n : end));
      i = end === -1 ? n : end + 3;
    } else if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      const end = src.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
    } else {
      const m = /^<(\/?)([A-Za-z][^\s/>]*)/.exec(src.slice(lt, lt + 200));
      if (!m) { on.text?.('<'); i = lt + 1; continue; }
      // the end of the tag: the first '>' outside quotes
      let j = lt + m[0].length;
      let quote = '';
      while (j < n) {
        const c = src[j];
        if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break;
        j++;
      }
      const inner = src.slice(lt + m[0].length, j);
      i = Math.min(n, j + 1);
      const tag = name(m[2]);
      if (m[1]) { on.end?.(tag); continue; }
      const attrs = {};
      ATTR_RE.lastIndex = 0;
      let a;
      while ((a = ATTR_RE.exec(inner))) {
        const v = a[2] ?? a[3] ?? a[4];
        attrs[name(a[1])] = v === undefined ? '' : decodeEntities(v);
      }
      on.start?.(tag, attrs);
      if (/\/\s*$/.test(inner)) on.end?.(tag);
      else if (!xml && (tag === 'script' || tag === 'style')) { // raw text: skipped
        const close = src.toLowerCase().indexOf('</' + tag, i);
        i = close === -1 ? n : close;
      }
    }
  }
}

/** A small tree for XML documents: {tag, attrs, children, text}. */
export function parseXml(src) {
  const root = { tag: '', attrs: {}, children: [], text: '' };
  const stack = [root];
  tokenize(src, {
    start(tag, attrs) {
      const node = { tag, attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    },
    end(tag) {
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === tag) { stack.length = k; break; }
    },
    text(text) { stack[stack.length - 1].text += text; },
  }, { xml: true });
  return root;
}

const child = (node, tag) => node.children.find((c) => c.tag === tag) || null;
const childText = (node, path) => {
  let cur = node;
  for (const part of path.split('/')) {
    cur = cur && child(cur, part);
    if (!cur) return '';
  }
  return cur.text;
};
function* descendants(node, tag) {
  for (const c of node.children) {
    if (c.tag === tag) yield c;
    yield* descendants(c, tag);
  }
}

// --------------------------------------------------------------------------- HTML → Markdown
export function htmlToMarkdown(src, resourceLink = null) {
  const out = [];
  const stack = [];
  const lists = [];
  const hrefs = [];
  let inPre = 0;
  let row = null;
  let table = null;
  let cell = null;
  const emit = (s) => { if (cell !== null) cell.push(s); else out.push(s); };
  const INLINE = { strong: '**', b: '**', em: '*', i: '*', s: '~~', del: '~~', strike: '~~', mark: '==' };
  tokenize(src, {
    start(tag, a) {
      stack.push(tag);
      if (/^h[1-6]$/.test(tag)) emit('\n\n' + '#'.repeat(Number(tag[1])) + ' ');
      else if (['p', 'div', 'section', 'article'].includes(tag)) emit('\n\n');
      else if (tag === 'br') emit('\n');
      else if (INLINE[tag]) emit(INLINE[tag]);
      else if (tag === 'code' && !inPre) emit('`');
      else if (tag === 'pre') { inPre += 1; emit('\n\n```\n'); }
      else if (tag === 'blockquote') emit('\n\n> ');
      else if (tag === 'ul' || tag === 'ol') { lists.push([tag, 0]); emit('\n'); }
      else if (tag === 'li') {
        const depth = Math.max(0, lists.length - 1);
        const kind = lists.length ? lists[lists.length - 1] : ['ul', 0];
        kind[1] += 1;
        emit('\n' + '    '.repeat(depth) + (kind[0] === 'ol' ? `${kind[1]}.` : '-') + ' ');
      } else if (tag === 'input' && a.type === 'checkbox') emit('checked' in a ? '[x] ' : '[ ] ');
      else if (tag === 'en-todo') emit(a.checked === 'true' ? '[x] ' : '[ ] ');
      else if (tag === 'a') { hrefs.push(a.href ?? null); emit('['); }
      else if (tag === 'img') emit(`![${a.alt || ''}](${a.src || ''})`);
      else if (tag === 'en-media' && resourceLink) emit(resourceLink(a.hash || '', a.type || ''));
      else if (tag === 'hr') emit('\n\n---\n\n');
      else if (tag === 'table') table = [];
      else if (tag === 'tr' && table !== null) row = [];
      else if ((tag === 'td' || tag === 'th') && row !== null) cell = [];
    },
    end(tag) {
      if (stack.length && stack[stack.length - 1] === tag) stack.pop();
      if (INLINE[tag]) emit(INLINE[tag]);
      else if (tag === 'code' && !inPre) emit('`');
      else if (tag === 'pre') { inPre = Math.max(0, inPre - 1); emit('\n```\n\n'); }
      else if (tag === 'ul' || tag === 'ol') { lists.pop(); emit('\n'); }
      else if (tag === 'a') { const href = hrefs.length ? hrefs.pop() : null; emit(href ? `](${href})` : ']'); }
      else if ((tag === 'td' || tag === 'th') && cell !== null && row !== null) {
        row.push(cell.join('').trim().replace(/\|/g, '\\|').replace(/\n/g, ' '));
        cell = null;
      } else if (tag === 'tr' && row !== null && table !== null) { table.push(row); row = null; }
      else if (tag === 'table' && table !== null) {
        let rows = table;
        table = null;
        if (rows.length) {
          const width = Math.max(...rows.map((r) => r.length));
          rows = rows.map((r) => [...r, ...Array(width - r.length).fill('')]);
          const lines = ['| ' + rows[0].join(' | ') + ' |', '|' + ' --- |'.repeat(width), ...rows.slice(1).map((r) => '| ' + r.join(' | ') + ' |')];
          emit('\n\n' + lines.join('\n') + '\n\n');
        }
      }
    },
    text(data) { emit(inPre ? data : data.replace(/\s+/g, ' ')); },
  });
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// --------------------------------------------------------------------------- reading the source
const isDir = (p) => native.sync('fs.stat', { path: p })?.type === 'dir';
const readText = (p) => native.sync('fs.readText', { path: p }).text.replace(/^\ufeff/, '');
const readB64 = (p) => native.sync('fs.readB64', { path: p });
const text = (path, t) => ({ path, text: t });
const bin = (path, b64) => ({ path, b64 });

/** Every file under `root` as paths relative to it, sorted. */
async function walk(root, { hidden = true } = {}) {
  const rows = await native.async('fs.scan', { path: root, ignore: [], skipHidden: !hidden });
  return rows.filter((r) => !r[1] && !/\.base$/i.test(r[0])).map((r) => r[0]).sort(); // no databases on the phone
}

/** A zip is unpacked into the app's cache; returns the folder (removed by the caller). */
async function unzip(path, tmp) {
  const dest = `${tmp}/unzip-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  await native.async('fs.unzip', { path, dest });
  return dest;
}

const EXT_OF_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'application/pdf': '.pdf',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-m4a': '.m4a', 'video/mp4': '.mp4', 'text/plain': '.txt', 'text/html': '.html', 'application/zip': '.zip' };

// --------------------------------------------------------------------------- formats
async function importMarkdownFolder(src) {
  if (!isDir(src)) throw new ApiError('not-a-folder', src);
  const out = [];
  for (const rel of await walk(src, { hidden: false })) {
    out.push(/\.md$/i.test(rel) ? { path: rel, text: null, from: `${src}/${rel}` } : { path: rel, b64: null, from: `${src}/${rel}` });
  }
  return out;
}

async function importHtml(src) {
  const dir = isDir(src);
  const files = dir ? (await walk(src)).filter((f) => /\.html?$/i.test(f)) : [basename(src)];
  const base = dir ? src : src.slice(0, src.lastIndexOf('/'));
  const out = [];
  for (const f of files) {
    const raw = readText(`${base}/${f}`);
    const title = /<title>([\s\S]*?)<\/title>/i.exec(raw);
    const md = htmlToMarkdown(raw.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ''));
    const name = safeName(title ? decodeEntities(title[1]) : stem(basename(f)));
    const rel = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    out.push(text(rel ? `${rel}/${name}.md` : `${name}.md`, md));
    await breathe();
  }
  return out;
}

function enexDate(v) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
}

async function importEnex(src) {
  const dir = isDir(src);
  const files = dir ? (await walk(src)).filter((f) => f.toLowerCase().endsWith('.enex')).map((f) => `${src}/${f}`) : [src];
  const out = [];
  for (const f of files) {
    const notebook = safeName(stem(basename(f)));
    const root = parseXml(readText(f));
    for (const note of descendants(root, 'note')) {
      const title = safeName(childText(note, 'title') || 'Untitled');
      const resources = new Map();
      for (const res of descendants(note, 'resource')) {
        const data = (childText(res, 'data') || '').replace(/\s+/g, '');
        if (!data) continue;
        const h = native.sync('hash', { algo: 'md5', b64: data }).hex; // Evernote references resources by md5
        const mime = childText(res, 'mime') || 'application/octet-stream';
        const fname = childText(res, 'resource-attributes/file-name') || `${h.slice(0, 8)}${EXT_OF_MIME[mime] || ''}`;
        resources.set(h, [safeName(fname, h), data, mime]);
      }
      const link = (h, mime) => {
        if (!resources.has(h)) return '';
        const [name] = resources.get(h);
        return mime.startsWith('image/') ? `![[${name}]]` : `[[${name}]]`;
      };
      const md = htmlToMarkdown(childText(note, 'content') || '', link);
      const meta = {
        tags: note.children.filter((c) => c.tag === 'tag' && c.text).map((c) => c.text),
        created: enexDate(childText(note, 'created')), updated: enexDate(childText(note, 'updated')),
        source: childText(note, 'note-attributes/source-url') || null,
      };
      out.push(text(`${notebook}/${title}.md`, frontmatter(meta) + md));
      for (const [name, data] of resources.values()) out.push(bin(`${notebook}/attachments/${name}`, data));
    }
    await breathe();
  }
  return out;
}

const NOTION_ID = /\s[0-9a-f]{32}(?=\.|\/|$)/g;

/** Notion "Markdown & CSV" export (zip or extracted folder). */
async function importNotion(src, tmp) {
  let root = src;
  if (!isDir(src)) {
    if (!/\.zip$/i.test(src)) throw new ApiError('bad-format', basename(src));
    root = await unzip(src, tmp);
    for (const inner of (await walk(root)).filter((f) => f.toLowerCase().endsWith('.zip'))) { // nested export parts
      await native.async('fs.unzip', { path: `${root}/${inner}`, dest: root });
      native.sync('fs.delete', { path: `${root}/${inner}`, recursive: false });
    }
  }
  const out = [];
  for (const path of await walk(root)) {
    const clean = path.replace(NOTION_ID, '');
    if (clean.endsWith('.md')) {
      let body = readText(`${root}/${path}`);
      body = body.replace(/(?<!!)\[([^\]]*)\]\(([^)]+\.md)\)/g, (m, label, target) => {
        let tgt = target.replace(/%20/g, ' ').replace(NOTION_ID, '').replace(/\.md$/, '');
        if (/^[a-z]+:\/\//.test(tgt)) return m;
        tgt = tgt.split('/').pop();
        return label ? `[[${tgt}|${label}]]` : `[[${tgt}]]`;
      });
      body = body.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, target) => `![${alt}](${target.replace(/%20/g, ' ').replace(NOTION_ID, '')})`);
      out.push(text(clean, body));
    } else out.push({ path: clean, b64: null, from: `${root}/${path}` });
  }
  return out;
}

async function importTextbundle(src, tmp) {
  const out = [];
  const one = async (bundle) => {
    let dir = bundle;
    if (!isDir(bundle)) dir = await unzip(bundle, tmp);
    const names = await walk(dir);
    const textName = names.find((n) => /(^|\/)text\.(md|markdown|txt)$/.test(n));
    if (!textName) return;
    const body = readText(`${dir}/${textName}`);
    const fallback = stem(basename(bundle));
    const first = (body.trim().split(/\r?\n/)[0] || fallback).replace(/^[# ]+/, '');
    out.push(text(`${safeName(first, fallback)}.md`, body.replaceAll('](assets/', '](attachments/')));
    for (const n of names) {
      const k = n.lastIndexOf('assets/');
      if (k !== -1 && (k === 0 || n[k - 1] === '/')) out.push({ path: `attachments/${n.slice(k + 7)}`, b64: null, from: `${dir}/${n}` });
    }
  };
  if (/\.(textbundle|textpack)$/i.test(src)) await one(src);
  else if (isDir(src)) {
    const rows = await native.async('fs.scan', { path: src, ignore: [], skipHidden: false });
    const bundles = rows.map((r) => r[0]).filter((p) => /\.(textbundle|textpack)$/i.test(p)).sort();
    for (const b of bundles) await one(`${src}/${b}`);
  } else throw new ApiError('bad-format', basename(src));
  return out;
}

async function importLogseq(src) {
  if (!isDir(src)) throw new ApiError('not-a-folder', src);
  const out = [];
  for (const sub of ['pages', 'journals']) {
    const d = `${src}/${sub}`;
    if (!isDir(d)) continue;
    const files = native.sync('fs.list', { path: d }).filter((e) => e.type === 'file' && e.name.endsWith('.md')).map((e) => e.name).sort();
    for (const f of files) {
      const lines = readText(`${d}/${f}`).split(/\r?\n/);
      const props = {};
      while (lines.length && /^[\w-]+:: /.test(lines[0])) {
        const line = lines.shift();
        const k = line.slice(0, line.indexOf(':: '));
        const v = line.slice(line.indexOf(':: ') + 3);
        props[k] = k === 'tags' || k === 'alias' ? v.split(',').map((x) => x.trim()) : v.trim();
      }
      if ('alias' in props) { props.aliases = props.alias; delete props.alias; }
      const body = lines.join('\n').replace(/^(\s*)- ([\w-]+):: (.*)$/gm, '$1- **$2**: $3');
      const base = stem(f);
      let name = base.replaceAll('___', '/').replaceAll('%2F', '/');
      if (sub === 'journals') {
        const m = /^(\d{4})_(\d{2})_(\d{2})/.exec(base);
        name = m ? `Journal/${m[1]}-${m[2]}-${m[3]}` : `Journal/${base}`;
      }
      out.push(text(`${name}.md`, frontmatter(props) + body + '\n'));
    }
    await breathe();
  }
  if (isDir(`${src}/assets`)) {
    for (const e of native.sync('fs.list', { path: `${src}/assets` })) if (e.type === 'file') out.push({ path: `assets/${e.name}`, b64: null, from: `${src}/assets/${e.name}` });
  }
  return out;
}

async function importRoam(src) {
  let data;
  try { data = JSON.parse(readText(src)); } catch { throw new ApiError('bad-format', basename(src)); }
  if (!Array.isArray(data)) throw new ApiError('bad-format', basename(src));
  const blocks = (children, depth = 0) => {
    const lines = [];
    for (const c of Array.isArray(children) ? children : []) {
      const s = String(c?.string ?? '').replace(/\{\{\[\[TODO\]\]\}\}/g, '[ ]').replace(/\{\{\[\[DONE\]\]\}\}/g, '[x]');
      lines.push('    '.repeat(depth) + '- ' + s, ...blocks(c?.children, depth + 1));
    }
    return lines;
  };
  return data.filter((page) => page && typeof page === 'object').map((page) => {
    const meta = {};
    if (page['create-time']) meta.created = isoUtc(page['create-time']);
    return text(`${safeName(page.title || 'Untitled')}.md`, frontmatter(meta) + blocks(page.children).join('\n') + '\n');
  });
}

async function importKeep(src) {
  const dir = isDir(src);
  const files = dir ? (await walk(src)).filter((f) => f.endsWith('.json')).map((f) => `${src}/${f}`) : [src];
  const out = [];
  for (const f of files) {
    let note;
    try { note = JSON.parse(readText(f)); } catch { continue; }
    if (!note || typeof note !== 'object' || Array.isArray(note) || (!('textContent' in note) && !('listContent' in note))) continue;
    if (note.isTrashed) continue;
    const title = safeName(note.title || stem(basename(f)));
    let body = note.textContent || '';
    if (Array.isArray(note.listContent) && note.listContent.length) body += note.listContent.map((i) => `- [${i.isChecked ? 'x' : ' '}] ${i.text || ''}`).join('\n');
    const meta = { tags: (note.labels || []).map((l) => l?.name).filter(Boolean), archived: note.isArchived ? true : null, pinned: note.isPinned ? true : null };
    if (note.userEditedTimestampUsec) meta.updated = isoUtc(note.userEditedTimestampUsec / 1000);
    for (const att of note.attachments || []) {
      const name = basename(String(att?.filePath || ''));
      const p = `${f.slice(0, f.lastIndexOf('/'))}/${name}`;
      if (name && native.sync('fs.stat', { path: p })?.type === 'file') {
        out.push({ path: `attachments/${name}`, b64: null, from: p });
        body += `\n\n![[${name}]]`;
      }
    }
    out.push(text(`${title}.md`, frontmatter(meta) + body + '\n'));
  }
  return out;
}

/** Rows of a CSV text (quotes, doubled quotes and line breaks inside quoted fields). */
export function parseCsv(src, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

function typed(raw) {
  const v = raw.trim();
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return v;
}

async function importCsv(src) {
  const raw = readText(src);
  if (!raw.trim()) return [];
  const head = raw.slice(0, 4096).split(/\r?\n/)[0];
  const delimiter = [',', ';', '\t'].map((d) => [head.split(d).length, d]).sort((a, b) => b[0] - a[0])[0][1];
  const rows = parseCsv(raw, delimiter);
  if (rows.length < 2) return [];
  const header = rows[0];
  const base = stem(basename(src));
  return rows.slice(1).map((cells, i) => {
    const title = safeName(cells[0] || `${base} ${i + 1}`);
    const props = {};
    header.forEach((k, col) => { if (col > 0 && k && cells[col] !== undefined && cells[col] !== '') props[k] = typed(cells[col]); });
    return text(`${title}.md`, frontmatter(props));
  });
}

export const IMPORTERS = { markdown: importMarkdownFolder, html: importHtml, enex: importEnex, notion: importNotion, textbundle: importTextbundle,
  logseq: importLogseq, roam: importRoam, keep: importKeep, csv: importCsv };

/** Run an importer and hand every item to `write({path, text?, b64?})`; files that are
 * copied as they are are read one at a time, so a big export never sits in memory. */
export async function runImport(format, src, tmp, write) {
  const fn = IMPORTERS[format];
  if (!fn) throw new ApiError('bad-format', String(format));
  const items = await fn(src, tmp);
  let n = 0;
  for (const item of items) {
    if (item.from) {
      if (item.text === null) item.text = b64ToText(readB64(item.from));
      else item.b64 = readB64(item.from);
    }
    await write(item);
    if (++n % 20 === 0) await breathe();
  }
  return items.length;
}

export { bytesToB64, textToB64 };

// sk_notes for Android – search query language and evaluation.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Syntax (the publicly documented operators of Markdown note apps):
//   words (AND), "exact phrase", OR, -negation, ( grouping ), /regex/,
//   file: path: content: tag: line:( ) block:( ) section:( ) task: task-todo: task-done:
//   match-case: ignore-case: [property] [property:value]
// Matching is case-insensitive by default and works on substrings.

import * as parser from './parser.js';
import { ApiError, basenameNoExt, breathe, escapeRegExp, extOf } from './util.js';

const OPERATORS = new Set(['file', 'path', 'content', 'tag', 'line', 'block', 'section', 'task', 'task-todo', 'task-done', 'match-case', 'ignore-case']);
const SCOPED = new Set(['line', 'block', 'section', 'task', 'task-todo', 'task-done']);
const SEARCHED_EXT = new Set(['md', 'canvas', 'base', 'txt']);

export class QueryError extends ApiError {
  constructor(detail) { super('bad-query', detail); }
}

// ----------------------------------------------------------------------------- AST
const Term = (text, o = {}) => ({ k: 'term', text, regex: !!o.regex, phrase: !!o.phrase, field: o.field || 'default', cs: null });
const And = (items) => ({ k: 'and', items });
const Or = (items) => ({ k: 'or', items });
const Not = (node) => ({ k: 'not', node });
const Scoped = (field, node) => ({ k: 'scoped', field, node });
const Prop = (name, value = null) => ({ k: 'prop', name, value });

const isSpace = (c) => c !== undefined && c !== '' && /\s/.test(c);
const TOKEN_RE = /(\s+)|(\()|(\))|(\[)|("(?:[^"\\]|\\.)*"?)|(\/(?:[^/\\]|\\.)+\/)|([^\s()"[]+)/y;

class Parser {
  constructor(q) {
    this.q = q;
    this.i = 0;
  }

  peek() {
    while (this.i < this.q.length && isSpace(this.q[this.i])) this.i += 1;
    return this.i < this.q.length ? this.q[this.i] : '';
  }

  parse() {
    const node = this.parseOr();
    if (this.peek() === ')') {
      this.i += 1; // tolerate a stray ')'
      return And([node, this.parse()]);
    }
    return node;
  }

  _atOr(strict) {
    if (this.q.slice(this.i, this.i + 2) !== 'OR') return false;
    const next = this.q[this.i + 2];
    if (this.i + 2 === this.q.length) return true;
    return strict ? (next === ' ' || next === '(' || next === '\t') : (isSpace(next) || next === '(');
  }

  parseOr() {
    const items = [this.parseAnd()];
    for (;;) {
      const save = this.i;
      const c = this.peek();
      if (this._atOr(false)) {
        this.i += 2;
        items.push(this.parseAnd());
      } else {
        this.i = save;
        break;
      }
      if (!c) break;
    }
    return items.length === 1 ? items[0] : Or(items);
  }

  parseAnd() {
    const items = [];
    for (;;) {
      const c = this.peek();
      if (!c || c === ')') break;
      if (this._atOr(true)) break;
      items.push(this.parseUnary());
    }
    if (!items.length) return And([]);
    return items.length === 1 ? items[0] : And(items);
  }

  parseUnary() {
    const c = this.peek();
    if (c === '-' && this.i + 1 < this.q.length && !isSpace(this.q[this.i + 1])) {
      this.i += 1;
      return Not(this.parseUnary());
    }
    return this.parseAtom();
  }

  parseAtom(field = 'default') {
    const c = this.peek();
    if (c === '(') {
      this.i += 1;
      const node = this.parseOr();
      if (this.peek() === ')') this.i += 1;
      return node;
    }
    if (c === '[') return this.parseProp();
    TOKEN_RE.lastIndex = this.i;
    const m = TOKEN_RE.exec(this.q);
    if (!m) throw new QueryError('syntax');
    const start = this.i;
    this.i = TOKEN_RE.lastIndex;
    if (m[5]) {
      const raw = m[5];
      const text = raw.length > 1 && raw.endsWith('"') ? raw.slice(1, -1) : raw.slice(1);
      return Term(text.replaceAll('\\"', '"'), { phrase: true, field });
    }
    if (m[6]) return Term(m[6].slice(1, -1), { regex: true, field });
    const word = m[7];
    if (word === undefined) throw new QueryError('syntax');
    const colon = word.indexOf(':');
    const op = colon === -1 ? word : word.slice(0, colon);
    if (colon !== -1 && OPERATORS.has(op)) {
      this.i = start + op.length + 1;
      if (op === 'match-case' || op === 'ignore-case') {
        const node = this._operand(field);
        setCase(node, op === 'match-case');
        return node;
      }
      if (SCOPED.has(op)) return Scoped(op, this._operand('default'));
      return this._operand(op);
    }
    return Term(word, { field });
  }

  _operand(field) {
    if (this.i >= this.q.length || isSpace(this.q[this.i])) return Term('', { field });
    return this.parseAtom(field);
  }

  parseProp() {
    let end = this.q.indexOf(']', this.i);
    if (end === -1) end = this.q.length;
    const inner = this.q.slice(this.i + 1, end);
    this.i = Math.min(end + 1, this.q.length);
    const colon = inner.indexOf(':');
    const name = (colon === -1 ? inner : inner.slice(0, colon)).trim().replace(/^"+|"+$/g, '');
    if (colon === -1) return Prop(name);
    const value = inner.slice(colon + 1).trim();
    return Prop(name, value ? new Parser(value).parse() : Term(''));
  }
}

function setCase(node, cs) {
  if (!node) return;
  if (node.k === 'term') node.cs = cs;
  if (node.items) for (const c of node.items) setCase(c, cs);
  if (node.k === 'not' || node.k === 'scoped') setCase(node.node, cs);
  if (node.k === 'prop' && node.value) setCase(node.value, cs);
}

export function parseQuery(q) {
  return new Parser(q.trim()).parse();
}

// ----------------------------------------------------------------------------- evaluation
class Doc {
  constructor(index, path) {
    this.index = index;
    this.path = path;
    this.name = basenameNoExt(path);
    this.meta = index.meta[path] || {};
    this._content = null;
  }

  get content() {
    if (this._content === null) this._content = this.index.content(this.path) || '';
    return this._content;
  }
}

function compile(term, caseSensitive) {
  const cs = term.cs !== null ? term.cs : caseSensitive;
  if (term.regex) {
    try { return new RegExp(term.text, cs ? 'gm' : 'gim'); } catch (e) { throw new QueryError(`regex: ${e.message}`); }
  }
  return new RegExp(escapeRegExp(term.text), cs ? 'gu' : 'giu');
}

class Eval {
  constructor(caseSensitive) {
    this.cs = caseSensitive;
    this.patterns = new Map();
  }

  pat(t) {
    let p = this.patterns.get(t);
    if (!p) this.patterns.set(t, (p = compile(t, this.cs)));
    return p;
  }

  has(t, text) {
    const p = this.pat(t);
    p.lastIndex = 0;
    return p.test(text);
  }

  /** Evaluate a node against a plain text unit (inside scoped operators). */
  matchText(node, text, doc = null) {
    switch (node.k) {
      case 'term': return !node.text || this.has(node, text);
      case 'not': return !this.matchText(node.node, text, doc);
      case 'and': return node.items.every((n) => this.matchText(n, text, doc));
      case 'or': return node.items.some((n) => this.matchText(n, text, doc));
      case 'prop': return doc !== null ? this.matchDoc(node, doc) : false;
      case 'scoped': return this.matchText(node.node, text, doc);
      default: return false;
    }
  }

  matchDoc(node, doc) {
    switch (node.k) {
      case 'and': return node.items.every((n) => this.matchDoc(n, doc));
      case 'or': return node.items.some((n) => this.matchDoc(n, doc));
      case 'not': return !this.matchDoc(node.node, doc);
      case 'term': {
        if (!node.text) return true;
        const f = node.field;
        if (f === 'file') return this.has(node, doc.path.slice(doc.path.lastIndexOf('/') + 1));
        if (f === 'path') return this.has(node, doc.path);
        if (f === 'content') return this.has(node, doc.content);
        if (f === 'tag') {
          const want = node.text.replace(/^#+/, '').toLowerCase();
          return parser.allTags(doc.meta).some((t) => {
            const tag = t.slice(1).toLowerCase();
            return tag === want || tag.startsWith(want + '/');
          });
        }
        return this.has(node, doc.name) || this.has(node, doc.content);
      }
      case 'prop': {
        const fm = doc.meta.frontmatter || {};
        const key = Object.keys(fm).find((k) => k.toLowerCase() === node.name.toLowerCase());
        if (key === undefined) return false;
        if (node.value === null) return true;
        const val = fm[key];
        const vals = Array.isArray(val) ? val : [val];
        const empty = (v) => v === null || v === '' || (Array.isArray(v) && !v.length);
        if (node.value.k === 'term' && !node.value.text) return vals.every(empty) || empty(val);
        if (node.value.k === 'term' && node.value.text.toLowerCase() === 'null') return val === null;
        return vals.some((v) => this.matchText(node.value, propStr(v)));
      }
      case 'scoped':
        if (node.field === 'line') return this._matchLines(node, doc);
        return units(node.field, doc).some((unit) => this.matchText(node.node, unit, doc));
      default: return false;
    }
  }

  /** line:(…): only lines holding a term the line must contain are examined. */
  _matchLines(node, doc) {
    const terms = prefilterTerms(node.node);
    if (!terms.length) return units('line', doc).some((unit) => this.matchText(node.node, unit, doc));
    const text = doc.content;
    const p = compile(Term(terms[0]), this.cs);
    const seen = new Set();
    for (let m = p.exec(text); m; m = p.exec(text)) {
      if (!m[0].length) p.lastIndex += 1;
      const a = m.index === 0 ? 0 : text.lastIndexOf('\n', m.index - 1) + 1;
      if (seen.has(a)) continue;
      seen.add(a);
      const b = text.indexOf('\n', m.index);
      if (this.matchText(node.node, b === -1 ? text.slice(a) : text.slice(a, b), doc)) return true;
    }
    return false;
  }

  /** Positive content patterns, for the highlighted snippets. */
  highlights(node, out) {
    if (node.k === 'and' || node.k === 'or') for (const n of node.items) this.highlights(n, out);
    else if (node.k === 'term' && node.text && (node.field === 'default' || node.field === 'content')) out.push(this.pat(node));
    else if (node.k === 'scoped') this.highlights(node.node, out);
  }
}

function propStr(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function units(kind, doc) {
  const text = doc.content;
  const lines = text.split('\n');
  if (kind === 'line') return lines;
  if (kind === 'task' || kind === 'task-todo' || kind === 'task-done') {
    const out = [];
    for (const item of doc.meta.listItems || []) {
      const task = item.task;
      if (task === undefined || task === null) continue;
      if (kind === 'task-todo' && task !== ' ') continue;
      if (kind === 'task-done' && task === ' ') continue;
      const ln = item.position.start.line;
      if (ln < lines.length) out.push(lines[ln].replace(/^\s*([-*+]|\d+[.)])\s+\[.\]\s*/u, ''));
    }
    return out;
  }
  const blocks = (doc.meta.sections || []).map((sec) => [sec.type, lines.slice(sec.position.start.line, sec.position.end.line + 1).join('\n')]);
  if (kind === 'block') return blocks.map(([, u]) => u);
  // section = text between headings
  const out = [];
  let cur = [];
  for (const [type, u] of blocks) {
    if (type === 'heading' && cur.length) {
      out.push(cur.join('\n'));
      cur = [];
    }
    cur.push(u);
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

/** Plain positive terms every result must contain. */
function prefilterTerms(node) {
  if (node.k === 'term' && !node.regex && (node.field === 'default' || node.field === 'content') && node.text.length >= 3) return [node.text];
  if (node.k === 'and') return node.items.flatMap(prefilterTerms);
  if (node.k === 'scoped') return prefilterTerms(node.node);
  return [];
}

/** True when the query can only be answered by reading note text. */
function needsContent(node) {
  if (node.k === 'term') return !!node.text && (node.field === 'default' || node.field === 'content');
  if (node.k === 'scoped') return true;
  if (node.k === 'not') return needsContent(node.node);
  if (node.items) return node.items.some(needsContent);
  return false;
}

const now = () => (globalThis.performance ? performance.now() : Date.now());

/** Files matching `query`. Snippets ("matches") are built for the first `snippetFiles`
 * results only (all by default); the others get null and the caller asks snippets() for
 * them when it shows them. */
export async function search(index, query, { caseSensitive = false, limitFiles = 2000, context = 1, maxMatches = 20, snippetFiles = null } = {}) {
  const t0 = now();
  const node = parseQuery(query);
  const ev = new Eval(caseSensitive);
  const paths = [...index.files.keys()].filter((p) => SEARCHED_EXT.has(extOf(p)));
  // note text comes into memory without blocking the page; whatever does not fit is read while matching
  if (needsContent(node)) await index.loadContents(paths);
  const results = [];
  let total = 0;
  let n = 0;
  for (const path of paths) {
    if (!index.files.has(path)) continue;
    if (++n % 400 === 0) await breathe();
    const doc = new Doc(index, path);
    if (!ev.matchDoc(node, doc)) continue;
    total += 1;
    if (results.length >= limitFiles) continue;
    let matches = null;
    if (snippetFiles === null || results.length < snippetFiles) {
      const pats = [];
      ev.highlights(node, pats);
      matches = pats.length ? snippetsOf(doc, pats, context, maxMatches) : [];
    }
    const e = index.files.get(path);
    results.push({ path, matches, mtime: e.mtime, ctime: e.ctime });
  }
  return { query, total, results, ms: Math.round((now() - t0) * 10) / 10 };
}

/** Snippets of `query` in the given files (see search(snippetFiles)). */
export function snippets(index, query, paths, { caseSensitive = false, context = 1, maxMatches = 20 } = {}) {
  const node = parseQuery(query);
  const ev = new Eval(caseSensitive);
  const out = {};
  for (const path of paths.slice(0, 500)) {
    if (!index.files.has(path)) continue;
    const doc = new Doc(index, path);
    const pats = [];
    ev.highlights(node, pats);
    out[path] = pats.length ? snippetsOf(doc, pats, context, maxMatches) : [];
  }
  return out;
}

function countNewlines(text, from, to) {
  let n = 0;
  for (let i = text.indexOf('\n', from); i !== -1 && i < to; i = text.indexOf('\n', i + 1)) n += 1;
  return n;
}

/** Lines around the matches, with the matched parts marked. */
function snippetsOf(doc, pats, context, maxMatches) {
  const text = doc.content;
  const spans = [];
  for (const p of pats) {
    p.lastIndex = 0;
    for (let m = p.exec(text); m; m = p.exec(text)) {
      if (m[0].length) spans.push([m.index, m.index + m[0].length]); else p.lastIndex += 1;
      if (spans.length > maxMatches * 4) break;
    }
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  const usedLines = new Set();
  let ln = 0;
  let countedTo = 0;
  for (const [s, e] of spans) {
    ln += countNewlines(text, countedTo, s);
    countedTo = s;
    if (usedLines.has(ln)) continue;
    usedLines.add(ln);
    let start = s === 0 ? 0 : text.lastIndexOf('\n', s - 1) + 1;
    let end = text.indexOf('\n', s);
    if (end === -1) end = text.length;
    for (let k = 0; k < Math.max(0, context - 1); k++) { // extra lines of context before and after
      if (start > 0) start = start - 2 >= 0 ? text.lastIndexOf('\n', start - 2) + 1 : 0;
      if (end < text.length) {
        const nxt = text.indexOf('\n', end + 1);
        end = nxt === -1 ? text.length : nxt;
      }
    }
    let chunk = text.slice(start, end);
    if (chunk.length > 400) { // long lines: a window around the match
      const ws = Math.max(start, s - 150);
      const we = Math.min(end, e + 200);
      chunk = text.slice(ws, we);
      start = ws;
    }
    const segs = [];
    let pos = 0;
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) { // first span starting at or after `start`
      const mid = (lo + hi) >> 1;
      if (spans[mid][0] < start) lo = mid + 1; else hi = mid;
    }
    for (let i = lo; i < spans.length; i++) {
      const [s2, e2] = spans[i];
      if (e2 > start + chunk.length) break;
      if (s2 - start >= pos) {
        segs.push([chunk.slice(pos, s2 - start), false]);
        segs.push([chunk.slice(s2 - start, e2 - start), true]);
        pos = e2 - start;
      }
    }
    segs.push([chunk.slice(pos), false]);
    out.push({ line: ln, segments: segs.filter((sg) => sg[0]) });
    if (out.length >= maxMatches) break;
  }
  return out;
}

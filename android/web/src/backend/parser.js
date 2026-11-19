// sk_notes for Android – Markdown metadata parser.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Produces the metadata the rest of sk_notes needs (and that the plugin API exposes as
// CachedMetadata): frontmatter, links, embeds, tags, headings, sections, list items
// (tasks), block ids and footnotes, each with a position
// {start: {line, col, offset}, end: {...}} counted in UTF-16 units, like the editor.
//
// Everything inside fenced code, inline code, math, HTML comments and %% comments %% is
// ignored when looking for links and tags. Same rules as the desktop parser
// (sk_notes/core/parser.py); tests/parser-parity.test.mjs compares the two.

import YAML from 'yaml';
import { unquote } from './util.js';

const MAX_ALIASES = 50;
const MAX_VALUES = 100000;

class TooBig extends Error {}

function jsonable(value, budget) {
  if (--budget.n < 0) throw new TooBig();
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => jsonable(v, budget));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value) Object.defineProperty(out, String(k), { value: jsonable(v, budget), enumerable: true, writable: true, configurable: true });
    return out;
  }
  if (value instanceof Set) return [...value].map((v) => jsonable(v, budget));
  if (typeof value === 'object') {
    if (ArrayBuffer.isView(value)) return String(value);
    const out = {};
    // defineProperty: a "__proto__" key must stay a plain key
    for (const k of Object.keys(value)) Object.defineProperty(out, k, { value: jsonable(value[k], budget), enumerable: true, writable: true, configurable: true });
    return out;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return String(value);
}

/** [yamlText, endLine, endOffset] of a leading frontmatter block; [null, -1, 0] without one.
 * endLine is the index of the closing --- line, endOffset the offset just after it. */
export function splitFrontmatter(text) {
  if (!text.startsWith('---')) return [null, -1, 0];
  const firstNl = text.indexOf('\n');
  if (firstNl === -1 || text.slice(0, firstNl).replace(/[\r ]+$/, '') !== '---') return [null, -1, 0];
  let pos = firstNl + 1;
  let line = 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const stripped = text.slice(pos, end).replace(/[\r ]+$/, '');
    if (stripped === '---' || stripped === '...') return [text.slice(firstNl + 1, pos), line, end];
    if (nl === -1) break;
    pos = nl + 1;
    line += 1;
  }
  return [null, -1, 0];
}

// YAML 1.1 like the desktop app, with dates and times kept as plain strings
const YAML_OPTIONS = {
  version: '1.1',
  maxAliasCount: MAX_ALIASES,
  prettyErrors: true,
  strict: false,
  uniqueKeys: false,
  customTags: (tags) => tags.filter((tag) => !/timestamp|binary|omap|pairs|set/.test(tag.tag || '')).map((tag) => {
    // yes/no/on/off are booleans as on the desktop, single letters (y, n) are text
    if (tag.tag !== 'tag:yaml.org,2002:bool' || !(tag.test instanceof RegExp)) return tag;
    return tag.test.test('true')
      ? { ...tag, test: /^(?:[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/ }
      : { ...tag, test: /^(?:[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/ };
  }),
};

/** [data, error]: frontmatter YAML as a plain object. YAML that is not a mapping is an error. */
export function parseFrontmatter(yamlText) {
  if (!yamlText.trim()) return [{}, null];
  let data;
  try {
    const doc = YAML.parseDocument(yamlText, YAML_OPTIONS);
    if (doc.errors.length) return [null, String(doc.errors[0].message).split('\n')[0]];
    data = doc.toJS({ maxAliasCount: MAX_ALIASES });
  } catch (e) {
    return [null, String(e.message || e).split('\n')[0]];
  }
  if (data === null || data === undefined) return [{}, null];
  if (typeof data !== 'object' || Array.isArray(data)) return [null, 'frontmatter is not a key/value mapping'];
  try {
    return [jsonable(data, { n: MAX_VALUES }), null];
  } catch (e) {
    if (e instanceof TooBig || e instanceof RangeError) return [null, 'frontmatter is too large'];
    throw e;
  }
}

/** Split 'path#subpath' → [path, '#subpath']; the subpath keeps its leading '#'. */
export function parseLinktext(linktext) {
  const idx = linktext.indexOf('#');
  return idx === -1 ? [linktext, ''] : [linktext.slice(0, idx), linktext.slice(idx)];
}

class Positions {
  constructor(text) {
    this.lineStarts = [0];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) this.lineStarts.push(i + 1);
  }

  loc(offset) {
    const ls = this.lineStarts;
    let lo = 0;
    let hi = ls.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ls[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo, col: offset - ls[lo], offset };
  }

  span(start, end) {
    return { start: this.loc(start), end: this.loc(end) };
  }
}

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)(\[(.)\][ \t]+)?/u;
const QUOTE_RE = /^ {0,3}>/;
const CALLOUT_RE = /^ {0,3}>\s*\[!([^\]]+)\]([+-]?)/;
const HR_RE = /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const BLOCK_ID_RE = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;
const FOOTNOTE_DEF_RE = /^\[\^([^\]\s]+)\]:/;
const MATH_FENCE_RE = /^\s*\$\$/;
const HTML_BLOCK_RE = /^ {0,3}<(?:[A-Za-z][A-Za-z0-9-]*|!--)/;

const WIKI_RE = /(!?)\[\[([^[\]\n]+?)\]\]/gd;
const MDLINK_RE = /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(<[^>\n]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/gd;
const TAG_RE = /(?<![\p{L}\p{N}_#/&])#([^\s!"#$%&'()*+,.:;<=>?@[\\\]^`{|}~\u3001-\u303f\uff01-\uff0f]+)/gu;
const INLINE_CODE_RE = /(`+)[\s\S]*?(?<!`)\1(?!`)/g;
const INLINE_MATH_RE = /(?<![\\$])\$(?!\s)([^$\n]+?)(?<![\s\\])\$(?!\d)/g;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// scheme start anchored and bounded: an unbounded scheme is quadratic on long words
const URL_RE = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/\S+/g;
const COMMENT_RE = /%%[\s\S]*?%%/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

function spansOf(re, text) {
  const out = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** Replace the given [start, end) ranges with spaces (line breaks are kept). */
function mask(text, spans) {
  if (!spans.length) return text;
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [s, e0] of sorted) {
    const e = Math.min(e0, text.length);
    if (e <= pos) continue;
    const from = Math.max(s, pos);
    out += text.slice(pos, from) + text.slice(from, e).replace(/[^\n]/g, ' ');
    pos = e;
  }
  return out + text.slice(pos);
}

function indentWidth(s) {
  let w = 0;
  for (const c of s) {
    if (c === ' ') w += 1;
    else if (c === '\t') w += 4 - (w % 4);
    else break;
  }
  return w;
}

function isValidTag(body) {
  const b = body.replace(/\/+$/, '');
  return !!b && !/^[\p{Nd}/]+$/u.test(b);
}

function partition(s, sep) {
  const i = s.indexOf(sep);
  return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + sep.length)];
}

/** Parse a Markdown note and return its metadata (JSON-serialisable). */
export function parse(input) {
  const text = input.includes('\r') ? input.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : input;
  const pos = new Positions(text);
  const lines = [];
  {
    let p = 0;
    for (const raw of text.split('\n')) {
      lines.push({ start: p, end: p + raw.length, text: raw });
      p += raw.length + 1;
    }
  }
  const meta = {};
  let sections = [];

  // ---- frontmatter
  let bodyStartLine = 0;
  const [yamlText, fmEndLine, fmEndOff] = splitFrontmatter(text);
  if (yamlText !== null) {
    const [data, error] = parseFrontmatter(yamlText);
    meta.frontmatterPosition = pos.span(0, fmEndOff);
    if (data !== null) {
      meta.frontmatter = data;
      const fmLinks = frontmatterLinks(data);
      if (fmLinks.length) meta.frontmatterLinks = fmLinks;
    } else meta.frontmatterError = error;
    bodyStartLine = fmEndLine + 1;
    sections = [{ type: 'yaml', position: pos.span(0, fmEndOff) }];
  }

  // ---- block pass: code/math/comment ranges, headings, lists, sections
  const maskedRanges = [];
  const headings = [];
  const listItems = [];
  const blocks = {};
  const footnotes = [];
  const n = lines.length;
  let i = bodyStartLine;
  let listStack = []; // [indent, line]
  let listRoot = null;
  const addSection = (kind, a, b) => sections.push({ type: kind, position: pos.span(lines[a].start, lines[b].end) });
  const blockIds = (a, b, afterLine = false) => {
    const k = afterLine ? b + 1 : b;
    if (k >= lines.length) return;
    const m = BLOCK_ID_RE.exec(lines[k].text);
    if (m && !(afterLine && lines[k].text.trim() !== '^' + m[1])) {
      Object.defineProperty(blocks, m[1].toLowerCase(), { value: { id: m[1], position: pos.span(lines[a].start, lines[k].end) }, enumerable: true, writable: true, configurable: true });
    }
  };

  while (i < n) {
    const ln = lines[i];
    const s = ln.text;
    const st = s.trim();
    if (!st) {
      listStack = [];
      listRoot = null;
      i += 1;
      continue;
    }

    // %% comment blocks %%
    if (st.startsWith('%%')) {
      if (!st.slice(2).includes('%%')) {
        let j = i + 1;
        while (j < n && !lines[j].text.includes('%%')) j += 1;
        j = Math.min(j, n - 1);
        maskedRanges.push([ln.start, lines[j].end]);
        addSection('comment', i, j);
        i = j + 1;
        continue;
      }
    }

    const fence = FENCE_RE.exec(s);
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      const marker = fence[2];
      let j = i + 1;
      while (j < n) {
        const close = FENCE_RE.exec(lines[j].text);
        if (close && close[2][0] === marker[0] && close[2].length >= marker.length && !close[3].trim()) break;
        j += 1;
      }
      j = Math.min(j, n - 1);
      maskedRanges.push([ln.start, lines[j].end]);
      addSection('code', i, j);
      listStack = [];
      listRoot = null;
      i = j + 1;
      continue;
    }

    if (MATH_FENCE_RE.test(s) && !listStack.length) {
      if (st.slice(2).includes('$$')) {
        maskedRanges.push([ln.start, ln.end]);
        addSection('math', i, i);
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < n && !lines[j].text.includes('$$')) j += 1;
      j = Math.min(j, n - 1);
      maskedRanges.push([ln.start, lines[j].end]);
      addSection('math', i, j);
      i = j + 1;
      continue;
    }

    if (s.trimStart().startsWith('<!--')) {
      let j = i;
      while (j < n && !lines[j].text.includes('-->')) j += 1;
      j = Math.min(j, n - 1);
      maskedRanges.push([ln.start, lines[j].end]);
      addSection('html', i, j);
      i = j + 1;
      continue;
    }

    const h = HEADING_RE.exec(s);
    if (h) {
      headings.push({ heading: (h[2] || '').trim(), level: h[1].length, position: pos.span(ln.start, ln.end) });
      addSection('heading', i, i);
      listStack = [];
      listRoot = null;
      i += 1;
      continue;
    }

    if (HR_RE.test(s) && !LIST_RE.test(s.replaceAll('- - -', ''))) {
      addSection('thematicBreak', i, i);
      i += 1;
      continue;
    }

    const fn = FOOTNOTE_DEF_RE.exec(s);
    if (fn) {
      footnotes.push({ id: fn[1], position: pos.span(ln.start, ln.end) });
      addSection('footnoteDefinition', i, i);
      i += 1;
      continue;
    }

    const lm = LIST_RE.exec(s);
    if (lm && (indentWidth(s) < 4 || listStack.length)) {
      // one paragraph-like run of a list: the item and its continuation lines
      let j = i;
      while (j + 1 < n && lines[j + 1].text.trim()) {
        const nxt = lines[j + 1].text;
        if (HEADING_RE.test(nxt) || FENCE_RE.test(nxt)) break;
        j += 1;
      }
      for (let k = i; k <= j; k++) {
        const tline = lines[k].text;
        const m = LIST_RE.exec(tline);
        if (!m) {
          if (listItems.length) listItems[listItems.length - 1].position.end = pos.loc(lines[k].end);
          continue;
        }
        const ind = indentWidth(m[1]);
        while (listStack.length && listStack[listStack.length - 1][0] >= ind) listStack.pop();
        if (!listStack.length && listRoot === null) listRoot = k;
        const root = listRoot !== null ? listRoot : k;
        // root items: negative line of the list start (-1 for line 0, -0 is not < 0)
        const parent = listStack.length ? listStack[listStack.length - 1][1] : (root ? -root : -1);
        const item = { position: pos.span(lines[k].start, lines[k].end), parent };
        if (m[4]) item.task = m[5];
        const bid = BLOCK_ID_RE.exec(tline);
        if (bid) item.id = bid[1];
        listItems.push(item);
        listStack.push([ind, k]);
      }
      addSection('list', i, j);
      blockIds(i, j);
      i = j + 1;
      continue;
    }

    if (QUOTE_RE.test(s)) {
      const callout = CALLOUT_RE.test(s);
      let j = i;
      while (j + 1 < n && QUOTE_RE.test(lines[j + 1].text)) j += 1;
      addSection(callout ? 'callout' : 'blockquote', i, j);
      blockIds(i, j);
      i = j + 1;
      continue;
    }

    // table
    if (s.includes('|') && i + 1 < n && TABLE_SEP_RE.test(lines[i + 1].text) && lines[i + 1].text.includes('-')) {
      let j = i + 1;
      while (j + 1 < n && lines[j + 1].text.includes('|') && lines[j + 1].text.trim()) j += 1;
      addSection('table', i, j);
      blockIds(j, j, true);
      i = j + 1;
      continue;
    }

    if (HTML_BLOCK_RE.test(s)) {
      let j = i;
      while (j + 1 < n && lines[j + 1].text.trim()) j += 1;
      addSection('html', i, j);
      i = j + 1;
      continue;
    }

    // paragraph (setext headings too)
    let j = i;
    while (j + 1 < n) {
      const nxt = lines[j + 1].text;
      if (!nxt.trim() || HEADING_RE.test(nxt) || FENCE_RE.test(nxt) || QUOTE_RE.test(nxt)
        || (LIST_RE.test(nxt) && indentWidth(nxt) < 4) || MATH_FENCE_RE.test(nxt)) break;
      if (SETEXT_RE.test(nxt)) {
        const level = nxt.trim()[0] === '=' ? 1 : 2;
        const title = lines.slice(i, j + 1).map((l) => l.text.trim()).join(' ');
        headings.push({ heading: title, level, position: pos.span(lines[i].start, lines[j + 1].end) });
        addSection('heading', i, j + 1);
        j += 1;
        break;
      }
      j += 1;
    }
    if (!sections.length || sections[sections.length - 1].position.start.line !== i) addSection('paragraph', i, j);
    blockIds(i, j);
    i = j + 1;
  }

  // ---- inline pass over the text with code/math/comments masked
  const bodyOffset = bodyStartLine < n ? lines[bodyStartLine].start : text.length;
  let scan = mask(text, maskedRanges);
  if (bodyOffset) scan = mask(scan, [[0, bodyOffset]]);
  scan = mask(scan, [...spansOf(INLINE_CODE_RE, scan), ...spansOf(COMMENT_RE, scan), ...spansOf(HTML_COMMENT_RE, scan)]);
  const scanNoMath = mask(scan, spansOf(INLINE_MATH_RE, scan));

  const links = [];
  const embeds = [];
  const wikiSpans = [];
  WIKI_RE.lastIndex = 0;
  for (let m = WIKI_RE.exec(scanNoMath); m; m = WIKI_RE.exec(scanNoMath)) {
    const [a, b] = m.indices[0];
    const inner = text.slice(m.indices[2][0], m.indices[2][1]);
    const [rawTarget, alias] = partition(inner, '|');
    const target = rawTarget.trim();
    if (!target) continue;
    const entry = { link: target, original: text.slice(a, b), position: pos.span(a, b), displayText: alias || target };
    (m[1] ? embeds : links).push(entry);
    wikiSpans.push([a, b]);
  }
  const mdScan = mask(scanNoMath, wikiSpans);
  MDLINK_RE.lastIndex = 0;
  for (let m = MDLINK_RE.exec(mdScan); m; m = MDLINK_RE.exec(mdScan)) {
    const [a, b] = m.indices[0];
    let dest = m[3].trim();
    if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1);
    if (!dest || URL_SCHEME_RE.test(dest) || (dest.startsWith('#') && !dest.slice(1))) continue;
    const entry = { link: unquote(dest), original: text.slice(a, b), displayText: text.slice(m.indices[2][0], m.indices[2][1]), position: pos.span(a, b) };
    (m[1] ? embeds : links).push(entry);
  }
  const byOffset = (x, y) => x.position.start.offset - y.position.start.offset;
  links.sort(byOffset);
  embeds.sort(byOffset);

  let tagScan = mask(scanNoMath, [...spansOf(MDLINK_RE, scanNoMath), ...wikiSpans]);
  // URLs like http://x.y/#frag must not produce tags
  tagScan = mask(tagScan, spansOf(URL_RE, tagScan));
  const tags = [];
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(tagScan); m; m = TAG_RE.exec(tagScan)) {
    if (!isValidTag(m[1])) continue;
    tags.push({ tag: '#' + m[1], position: pos.span(m.index, m.index + m[0].length) });
  }

  if (links.length) meta.links = links;
  if (embeds.length) meta.embeds = embeds;
  if (tags.length) meta.tags = tags;
  if (headings.length) meta.headings = headings;
  if (sections.length) meta.sections = sections;
  if (listItems.length) meta.listItems = listItems;
  if (Object.keys(blocks).length) meta.blocks = blocks;
  if (footnotes.length) meta.footnotes = footnotes;
  return meta;
}

function frontmatterLinks(data, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(data)) {
    const isList = Array.isArray(value);
    const values = isList ? value : [value];
    values.forEach((v, idx) => {
      if (typeof v !== 'string') return;
      const re = /(!?)\[\[([^[\]\n]+?)\]\]/g;
      for (let m = re.exec(v); m; m = re.exec(v)) {
        const [target, alias] = partition(m[2], '|');
        if (target.trim() && !m[1]) {
          out.push({ key: `${prefix}${key}` + (isList ? `.${idx}` : ''), link: target.trim(), original: m[0], displayText: alias || target.trim() });
        }
      }
    });
  }
  return out;
}

/** Tags of a note from both the body (#tag) and the `tags` property. */
export function allTags(meta) {
  const out = (meta.tags || []).map((x) => x.tag);
  const fm = meta.frontmatter || {};
  for (const key of ['tags', 'tag']) {
    let val = fm[key];
    if (typeof val === 'string') val = val.split(/[,\s]+/).filter(Boolean);
    if (Array.isArray(val)) {
      for (let v of val) {
        if ((typeof v === 'string' || (typeof v === 'number' && Number.isInteger(v))) && String(v).trim()) {
          v = String(v).trim();
          out.push(v.startsWith('#') ? v : '#' + v);
        }
      }
    }
  }
  return out;
}

export function aliases(meta) {
  const fm = meta.frontmatter || {};
  const out = [];
  for (const key of ['aliases', 'alias']) {
    let val = fm[key];
    if (typeof val === 'string') val = val.split(',').map((v) => v.trim());
    if (Array.isArray(val)) for (const v of val) if (v !== null && v !== undefined && String(v).trim()) out.push(String(v).trim());
  }
  return out;
}

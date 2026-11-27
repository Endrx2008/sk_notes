// Reading-view renderer: markdown-it + sk_notes rules, section-by-section output so
// post-processors (ours and plugins') receive one element per block with line info.

import { parseReminder, whenText } from '../features/reminders.js';
import MarkdownIt from 'markdown-it';
import { resourceUrl } from '../core/api.js';
import { setIcon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { isAudio, isImage, isVideo } from '../core/util.js';
import { Component } from '../model/component.js';
import { parseLinktext, resolveSubpath } from '../model/metadata.js';

const CALLOUT_ICONS = {
  note: 'pencil', abstract: 'clipboard', summary: 'clipboard', tldr: 'clipboard', info: 'info', todo: 'check-circle',
  tip: 'sparkles', hint: 'sparkles', important: 'sparkles', success: 'check', check: 'check', done: 'check',
  question: 'help', help: 'help', faq: 'help', warning: 'alert-triangle', caution: 'alert-triangle', attention: 'alert-triangle',
  failure: 'x', fail: 'x', missing: 'x', danger: 'alert-circle', error: 'alert-circle', bug: 'alert-circle',
  example: 'list', quote: 'quote', cite: 'quote',
};

let katexMod = null;
async function katex() {
  if (!katexMod) katexMod = (await import('katex')).default;
  return katexMod;
}

// ------------------------------------------------------------------- markdown-it rules
function wikilinkRule(md) {
  md.inline.ruler.before('link', 'sk_wikilink', (state, silent) => {
    const src = state.src;
    let pos = state.pos;
    const embed = src.charCodeAt(pos) === 0x21; // !
    if (embed) pos++;
    if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
    // the link ends on the same line, before any other "[[": scanning to the end of the
    // note from every "[[" made notes full of brackets take seconds to render (B-23)
    let end = -1;
    for (let i = pos + 2; i < src.length - 1; i++) {
      const c = src.charCodeAt(i);
      if (c === 0x0a) return false;
      if (c === 0x5b && src.charCodeAt(i + 1) === 0x5b) return false;
      if (c === 0x5d && src.charCodeAt(i + 1) === 0x5d) { end = i; break; }
    }
    if (end === -1) return false;
    const inner = src.slice(pos + 2, end);
    if (!inner.trim()) return false;
    if (!silent) {
      const bar = inner.indexOf('|');
      const target = (bar === -1 ? inner : inner.slice(0, bar)).trim();
      const alias = bar === -1 ? '' : inner.slice(bar + 1);
      const tok = state.push(embed ? 'sk_embed' : 'sk_wikilink', '', 0);
      tok.meta = { target, alias };
    }
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules.sk_wikilink = (tokens, i) => {
    const { target, alias } = tokens[i].meta;
    const text = alias || target.replace(/#\^?/, ' > ').replace(/^ > /, '');
    return `<a data-href="${md.utils.escapeHtml(target)}" href="${md.utils.escapeHtml(target)}" class="internal-link" target="_blank" rel="noopener">${md.utils.escapeHtml(text)}</a>`;
  };
  md.renderer.rules.sk_embed = (tokens, i) => {
    const { target, alias } = tokens[i].meta;
    return `<span class="internal-embed" src="${md.utils.escapeHtml(target)}" alt="${md.utils.escapeHtml(alias)}" data-sk-embed="1"></span>`;
  };
}

function tagRule(md) {
  const re = /^#([^\s!"#$%&'()*+,.:;<=>?@[\\\]^`{|}~　-〿！-／]+)/u;
  md.inline.ruler.push('sk_tag', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x23) return false;
    const prev = state.pos > 0 ? state.src[state.pos - 1] : ' ';
    if (/[\p{L}\p{N}_#/&]/u.test(prev)) return false;
    const m = re.exec(state.src.slice(state.pos));
    if (!m) return false;
    const body = m[1].replace(/\/+$/, '');
    if (!body || /^[\d/]+$/.test(body)) return false;
    if (!silent) {
      const tok = state.push('sk_tag', '', 0);
      tok.content = body;
    }
    state.pos += 1 + body.length;
    return true;
  });
  md.renderer.rules.sk_tag = (tokens, i) => {
    const tag = md.utils.escapeHtml(tokens[i].content);
    return `<a href="#${tag}" class="tag" target="_blank" rel="noopener">#${tag}</a>`;
  };
}

function delimRule(md, name, marker, tag, cls) {
  md.inline.ruler.before('emphasis', name, (state, silent) => {
    const src = state.src;
    if (!src.startsWith(marker, state.pos)) return false;
    const end = src.indexOf(marker, state.pos + marker.length);
    if (end === -1 || end === state.pos + marker.length) return false;
    if (/\s/.test(src[state.pos + marker.length]) || /\s/.test(src[end - 1])) return false;
    if (!silent) {
      state.push(`${name}_open`, tag, 1).attrs = cls ? [['class', cls]] : null;
      const old = state.posMax;
      state.pos += marker.length;
      state.posMax = end;
      state.md.inline.tokenize(state);
      state.posMax = old;
      state.push(`${name}_close`, tag, -1);
    }
    state.pos = end + marker.length;
    return true;
  });
}

function commentRule(md) {
  md.inline.ruler.before('emphasis', 'sk_comment', (state, silent) => {
    if (!state.src.startsWith('%%', state.pos)) return false;
    const end = state.src.indexOf('%%', state.pos + 2);
    if (end === -1) return false;
    state.pos = end + 2;
    return true;
  });
  md.block.ruler.before('fence', 'sk_comment_block', (state, start, end, silent) => {
    const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
    if (!line.startsWith('%%')) return false;
    const rest = line.slice(2);
    if (rest.includes('%%') && !rest.trimEnd().endsWith('%%') ) return false;
    let next = start;
    if (!(rest.trimEnd().endsWith('%%') && rest.trim().length >= 2)) {
      next = start + 1;
      while (next < end) {
        const l = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]);
        if (l.includes('%%')) break;
        next++;
      }
    }
    if (silent) return true;
    state.line = Math.min(next + 1, end);
    const tok = state.push('sk_comment', '', 0);
    tok.map = [start, state.line];
    return true;
  });
  md.renderer.rules.sk_comment = () => '';
}

function mathRule(md) {
  md.inline.ruler.after('escape', 'sk_math_inline', (state, silent) => {
    const src = state.src;
    if (src.charCodeAt(state.pos) !== 0x24 || src.charCodeAt(state.pos + 1) === 0x24) return false;
    if (/\s/.test(src[state.pos + 1] || ' ')) return false;
    let end = state.pos + 1;
    while ((end = src.indexOf('$', end)) !== -1) {
      if (src[end - 1] !== '\\') break;
      end++;
    }
    if (end === -1 || /\s/.test(src[end - 1]) || /\d/.test(src[end + 1] || '')) return false;
    if (!silent) {
      const tok = state.push('sk_math', '', 0);
      tok.content = src.slice(state.pos + 1, end);
      tok.meta = { display: false };
    }
    state.pos = end + 1;
    return true;
  });
  md.block.ruler.before('fence', 'sk_math_block', (state, start, end, silent) => {
    const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
    if (!first.startsWith('$$')) return false;
    let content;
    let next = start;
    const rest = first.slice(2);
    if (rest.trim().endsWith('$$') && rest.trim().length > 2) {
      content = rest.trim().slice(0, -2);
    } else {
      const lines = [rest];
      next = start + 1;
      while (next < end) {
        const l = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]);
        if (l.trim().endsWith('$$')) { lines.push(l.trim().slice(0, -2)); break; }
        lines.push(l);
        next++;
      }
      content = lines.join('\n');
    }
    if (silent) return true;
    state.line = Math.min(next + 1, end);
    const tok = state.push('sk_math', '', 0);
    tok.content = content;
    tok.meta = { display: true };
    tok.map = [start, state.line];
    tok.block = true;
    return true;
  });
  md.renderer.rules.sk_math = (tokens, i) => {
    const tok = tokens[i];
    const tag = tok.meta.display ? 'div' : 'span';
    return `<${tag} class="math ${tok.meta.display ? 'math-block' : 'math-inline'}" data-tex="${md.utils.escapeHtml(tok.content)}"></${tag}>`;
  };
}

function footnoteRule(md) {
  md.block.ruler.before('reference', 'sk_footnote_def', (state, start, end, silent) => {
    const pos = state.bMarks[start] + state.tShift[start];
    const line = state.src.slice(pos, state.eMarks[start]);
    const m = /^\[\^([^\]\s]+)\]:\s?(.*)$/.exec(line);
    if (!m) return false;
    if (silent) return true;
    let next = start + 1;
    const lines = [m[2]];
    while (next < end) {
      const l = state.src.slice(state.bMarks[next], state.eMarks[next]);
      if (!/^(\s{2,}|\t)/.test(l) || !l.trim()) break;
      lines.push(l.trim());
      next++;
    }
    state.env.footnotes ||= [];
    state.env.footnotes.push({ id: m[1], text: lines.join(' ') });
    state.line = next;
    const tok = state.push('sk_footnote_anchor', '', 0);
    tok.map = [start, next];
    return true;
  });
  md.inline.ruler.after('image', 'sk_footnote_ref', (state, silent) => {
    const m = /^\[\^([^\]\s]+)\]/.exec(state.src.slice(state.pos));
    if (!m) return false;
    if (!silent) {
      const tok = state.push('sk_footnote_ref', '', 0);
      tok.content = m[1];
    }
    state.pos += m[0].length;
    return true;
  });
  md.inline.ruler.after('image', 'sk_inline_footnote', (state, silent) => {
    if (!state.src.startsWith('^[', state.pos)) return false;
    const end = state.src.indexOf(']', state.pos + 2);
    if (end === -1) return false;
    if (!silent) {
      state.env.footnotes ||= [];
      const id = `inline-${state.env.footnotes.length + 1}`;
      state.env.footnotes.push({ id, text: state.src.slice(state.pos + 2, end) });
      const tok = state.push('sk_footnote_ref', '', 0);
      tok.content = id;
    }
    state.pos = end + 1;
    return true;
  });
  md.renderer.rules.sk_footnote_anchor = () => '';
  md.renderer.rules.sk_footnote_ref = (tokens, i, opts, env) => {
    const id = md.utils.escapeHtml(tokens[i].content);
    env.footnoteOrder ||= [];
    if (!env.footnoteOrder.includes(tokens[i].content)) env.footnoteOrder.push(tokens[i].content);
    const n = env.footnoteOrder.indexOf(tokens[i].content) + 1;
    return `<sup class="footnote-ref" data-footnote-id="${id}"><a href="#fn-${id}" class="footnote-link">${n}</a></sup>`;
  };
}

function taskRule(md) {
  md.core.ruler.after('inline', 'sk_tasks', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
      const m = /^\[(.)\][ \t]/.exec(tok.content) || /^\[(.)\]$/.exec(tok.content);
      if (!m) continue;
      const char = m[1];
      const li = tokens[i - 2];
      li.attrJoin('class', 'task-list-item');
      if (char !== ' ') li.attrJoin('class', 'is-checked');
      li.attrSet('data-task', char === ' ' ? '' : char);
      const first = tok.children[0];
      if (first && first.type === 'text') first.content = first.content.replace(/^\[.\][ \t]?/, '');
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input data-line="${li.map ? li.map[0] : ''}" class="task-list-item-checkbox" type="checkbox"${char !== ' ' ? ' checked' : ''}>`;
      tok.children.unshift(box);
      // parent list gets the class too
      for (let j = i - 3; j >= 0; j--) {
        if (tokens[j].type === 'bullet_list_open' || tokens[j].type === 'ordered_list_open') {
          if (tokens[j].level === li.level - 1) { tokens[j].attrJoin('class', 'contains-task-list'); break; }
        }
      }
    }
  });
}

function blockIdRule(md) {
  md.core.ruler.after('inline', 'sk_block_ids', (state) => {
    for (const tok of state.tokens) {
      if (tok.type !== 'inline' || !tok.children?.length) continue;
      const last = tok.children[tok.children.length - 1];
      if (last.type !== 'text') continue;
      const m = /(^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(last.content);
      if (!m) continue;
      last.content = last.content.slice(0, m.index + m[1].length).trimEnd();
      tok.meta = { ...(tok.meta || {}), blockId: m[2] };
    }
  });
}

function calloutRule(md) {
  md.core.ruler.after('sk_block_ids', 'sk_callouts', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'blockquote_open') continue;
      const p = tokens[i + 1];
      const inline = tokens[i + 2];
      if (p?.type !== 'paragraph_open' || inline?.type !== 'inline') continue;
      const m = /^\[!([^\]]+)\]([+-]?)[ \t]*([^\n]*)/.exec(inline.content);
      if (!m) continue;
      const type = m[1].trim().toLowerCase();
      tokens[i].type = 'sk_callout_open';
      tokens[i].meta = { type, fold: m[2], title: m[3] };
      // find matching close
      let depth = 0;
      for (let j = i; j < tokens.length; j++) {
        if (tokens[j].type === 'blockquote_open' || tokens[j].type === 'sk_callout_open') depth++;
        if (tokens[j].type === 'blockquote_close') { depth--; if (depth === 0) { tokens[j].type = 'sk_callout_close'; break; } }
      }
      // remove the marker line from the first paragraph
      const nl = inline.content.indexOf('\n');
      const rest = nl === -1 ? '' : inline.content.slice(nl + 1);
      const titleTok = new state.Token('sk_callout_title', '', 0);
      titleTok.meta = tokens[i].meta;
      const titleInline = new state.Token('inline', '', 0);
      titleInline.content = m[3] || '';
      titleInline.children = [];
      state.md.inline.parse(titleInline.content, state.md, state.env, titleInline.children);
      titleTok.children = titleInline.children;
      if (!rest.trim()) {
        tokens.splice(i + 1, 3, titleTok); // drop the empty paragraph
      } else {
        inline.content = rest;
        inline.children = [];
        state.md.inline.parse(rest, state.md, state.env, inline.children);
        tokens.splice(i + 1, 0, titleTok);
      }
    }
  });
  md.renderer.rules.sk_callout_open = (tokens, i) => {
    const { type, fold } = tokens[i].meta;
    const cls = `callout${fold ? ' is-collapsible' : ''}${fold === '-' ? ' is-collapsed' : ''}`;
    return `<div data-callout-metadata="" data-callout-fold="${fold}" data-callout="${md.utils.escapeHtml(type)}" class="${cls}">`;
  };
  md.renderer.rules.sk_callout_title = (tokens, i, opts, env, self) => {
    const { type, title, fold } = tokens[i].meta;
    const inner = title ? self.renderInline(tokens[i].children, opts, env) : md.utils.escapeHtml(type.charAt(0).toUpperCase() + type.slice(1));
    return `<div class="callout-title"><div class="callout-icon" data-icon="${CALLOUT_ICONS[type] || 'pencil'}"></div><div class="callout-title-inner">${inner}</div>${fold ? '<div class="callout-fold"></div>' : ''}</div><div class="callout-content">`;
  };
  md.renderer.rules.sk_callout_close = () => '</div></div>';
}

export function createMarkdownIt() {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: false });
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
  wikilinkRule(md);
  tagRule(md);
  delimRule(md, 'sk_mark', '==', 'mark');
  commentRule(md);
  mathRule(md);
  footnoteRule(md);
  taskRule(md);
  blockIdRule(md);
  calloutRule(md);
  const defaultLink = md.renderer.rules.link_open || ((tk, i, o, e, s) => s.renderToken(tk, i, o));
  md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
    const href = tokens[i].attrGet('href') || '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      tokens[i].attrJoin('class', 'external-link');
      tokens[i].attrSet('target', '_blank');
      tokens[i].attrSet('rel', 'noopener nofollow');
    } else if (!href.startsWith('#')) {
      tokens[i].attrJoin('class', 'internal-link');
      tokens[i].attrSet('data-href', decodeURIComponentSafe(href));
    }
    return defaultLink(tokens, i, opts, env, self);
  };
  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, i, opts, env, self) => {
    const src = tokens[i].attrGet('src') || '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(src)) {
      return `<span class="internal-embed" src="${md.utils.escapeHtml(decodeURIComponentSafe(src))}" alt="${md.utils.escapeHtml(tokens[i].content)}" data-sk-embed="1"></span>`;
    }
    const alt = tokens[i].content;
    const m = /^(.*?)\|(\d+)(?:x(\d+))?$/.exec(alt);
    if (m) {
      tokens[i].attrSet('width', m[2]);
      if (m[3]) tokens[i].attrSet('height', m[3]);
      tokens[i].children = [];
      tokens[i].attrSet('alt', m[1]);
    }
    return defaultImage(tokens, i, opts, env, self);
  };
  md.renderer.rules.paragraph_open = (tokens, i, opts, env, self) => {
    const inline = tokens[i + 1];
    if (inline?.meta?.blockId) tokens[i].attrSet('data-block-id', inline.meta.blockId);
    return self.renderToken(tokens, i, opts);
  };
  md.renderer.rules.fence = (tokens, i) => {
    const tok = tokens[i];
    const lang = (tok.info || '').trim().split(/\s+/)[0];
    const esc = md.utils.escapeHtml(tok.content);
    return `<pre class="language-${md.utils.escapeHtml(lang)}" data-lang="${md.utils.escapeHtml(lang)}"><code class="language-${md.utils.escapeHtml(lang)} is-loaded">${esc}</code><button class="copy-code-button">${md.utils.escapeHtml(t('common.copy'))}</button></pre>`;
  };
  return md;
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

const md = createMarkdownIt();

// ------------------------------------------------------------------- sections
function stripFrontmatter(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return { body: text, offset: 0 };
  return { body: text.slice(m[0].length), offset: m[0].split('\n').length - 1 };
}

/** Render into `el`. Returns the list of {el, lineStart, lineEnd, text}. */
export function renderSections(app, markdown, el, sourcePath, component, options = {}) {
  const { body, offset } = options.keepFrontmatter ? { body: markdown, offset: 0 } : stripFrontmatter(markdown);
  const env = { sourcePath };
  const tokens = md.parse(body, env);
  const lines = markdown.split('\n');
  const sections = [];
  let i = 0;
  while (i < tokens.length) {
    const start = i;
    let depth = 0;
    do {
      depth += tokens[i].nesting;
      i++;
    } while (i < tokens.length && depth > 0);
    const group = tokens.slice(start, i);
    const map = group.find((tk) => tk.map)?.map || [0, 0];
    const html = md.renderer.render(group, md.options, env);
    if (!html.trim() && group[0].type !== 'sk_comment') continue;
    const div = el.createDiv();
    div.appendChild(sanitizeHTMLToDom(html, { iframes: true }));
    const lineStart = map[0] + offset;
    const lineEnd = Math.max(lineStart, map[1] + offset - 1);
    sections.push({ el: div, lineStart, lineEnd, text: lines.slice(lineStart, lineEnd + 1).join('\n') });
  }
  if (env.footnotes?.length) {
    const div = el.createDiv('footnotes');
    div.createEl('hr', 'footnotes-sep');
    const ol = div.createEl('ol', 'footnotes-list');
    const order = env.footnoteOrder || [];
    const notes = env.footnotes.slice().sort((a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9));
    for (const fn of notes) {
      const li = ol.createEl('li', { cls: 'footnote-item', attr: { id: `fn-${fn.id}` } });
      li.appendChild(sanitizeHTMLToDom(md.renderInline(fn.text, env)));
    }
    sections.push({ el: div, lineStart: lines.length, lineEnd: lines.length, text: '' });
  }
  return sections;
}

// ------------------------------------------------------------------- post processing
export class MarkdownRenderChild extends Component {
  constructor(containerEl) {
    super();
    this.containerEl = containerEl;
  }
}

export class MarkdownPostProcessorContext {
  constructor(app, sourcePath, frontmatter, component, sectionMap) {
    this.docId = Math.random().toString(36).slice(2);
    this.sourcePath = sourcePath;
    this.frontmatter = frontmatter;
    this._component = component;
    this._sectionMap = sectionMap;
    this.app = app;
  }
  addChild(child) { this._component?.addChild(child); }
  getSectionInfo(el) {
    let x = el;
    while (x && !this._sectionMap.has(x)) x = x.parentElement;
    const s = x && this._sectionMap.get(x);
    if (!s) return null;
    return { text: s.fullText, lineStart: s.lineStart, lineEnd: s.lineEnd };
  }
}

export async function postProcess(app, sections, sourcePath, component, frontmatter, fullText, depth = 0) {
  const sectionMap = new Map(sections.map((s) => [s.el, { ...s, fullText }]));
  const ctx = new MarkdownPostProcessorContext(app, sourcePath, frontmatter, component, sectionMap);
  for (const s of sections) {
    s.el.setAttr('data-sk-line', s.lineStart);
    await builtinPostProcess(app, s.el, sourcePath, component, depth, ctx);
    for (const pp of app.markdownProcessors.sorted()) {
      try {
        const r = pp(s.el, ctx);
        if (r && typeof r.then === 'function') await r;
      } catch (e) { console.error('markdown post processor failed', e); }
    }
  }
}

async function builtinPostProcess(app, el, sourcePath, component, depth, ctx) {
  // reminders "(@2026-11-28 15:00)": a small label with the time (the note keeps the plain text)
  if (el.textContent.includes('(@')) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.includes('(@') && !n.parentElement?.closest('code, pre')) hits.push(n);
    for (const n of hits) {
      const re = /\(@\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?\)/g;
      const text = n.nodeValue;
      let last = 0;
      const frag = document.createDocumentFragment();
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const r = parseReminder(m[0]);
        if (!r) continue;
        frag.append(text.slice(last, m.index));
        frag.append(createSpan({ cls: 'sk-reminder' + (r.at < Date.now() ? ' is-past' : ''), text: `⏰ ${whenText(r.at)}`, attr: { title: m[0] } }));
        last = m.index + m[0].length;
      }
      if (!last) continue;
      frag.append(text.slice(last));
      n.replaceWith(frag);
    }
  }
  // code block processors (plugins) and copy buttons
  for (const pre of el.findAll('pre[data-lang]')) {
    const lang = pre.getAttr('data-lang');
    const handler = lang && app.markdownProcessors.codeBlocks.get(lang);
    if (handler) {
      const box = createDiv({ cls: `block-language-${lang}` });
      pre.replaceWith(box);
      try { await handler(pre.querySelector('code').textContent.replace(/\n$/, ''), box, ctx); } catch (e) {
        console.error('code block processor failed', lang, e);
        box.setText(String(e));
      }
      continue;
    }
    pre.querySelector('.copy-code-button')?.addEventListener('click', (e) => {
      navigator.clipboard.writeText(pre.querySelector('code').textContent);
      e.target.setText(t('common.copied'));
      setTimeout(() => e.target.setText(t('common.copy')), 1500);
    });
  }
  for (const ic of el.findAll('.callout-icon[data-icon]')) setIcon(ic, ic.getAttr('data-icon'));
  for (const f of el.findAll('.callout-fold')) {
    setIcon(f, 'chevron-down');
    const callout = f.closest('.callout');
    callout.querySelector('.callout-title').addEventListener('click', () => callout.toggleClass('is-collapsed', !callout.hasClass('is-collapsed')));
  }
  const maths = el.findAll('.math[data-tex]');
  if (maths.length) {
    const k = await katex();
    for (const m of maths) {
      try {
        k.render(m.getAttr('data-tex'), m, { displayMode: m.hasClass('math-block'), throwOnError: false, output: 'html', trust: false });
      } catch (e) { m.setText(m.getAttr('data-tex')); }
    }
  }
  for (const a of el.findAll('a.internal-link')) {
    const href = a.getAttr('data-href') || '';
    const { path } = parseLinktext(href);
    if (path && !app.metadataCache.getFirstLinkpathDest(path, sourcePath)) a.addClass('is-unresolved');
  }
  for (const span of el.findAll('span.internal-embed[data-sk-embed]')) {
    span.removeAttribute('data-sk-embed');
    await renderEmbed(app, span, sourcePath, component, depth);
  }
}

// ------------------------------------------------------------------- embeds
export async function renderEmbed(app, span, sourcePath, component, depth) {
  const src = span.getAttr('src') || '';
  const alt = span.getAttr('alt') || '';
  const { path, subpath } = parseLinktext(src);
  const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath) || (path === '' ? app.vault.getFileByPath(sourcePath) : null);
  if (!file) {
    span.addClass('is-unresolved');
    span.createDiv({ cls: 'embed-unresolved', text: t('embed.missing', { name: path }) });
    span.addEventListener('click', () => app.workspace.openLinkText(src, sourcePath));
    return;
  }
  const ext = file.extension;
  const size = /^(\d+)(?:x(\d+))?$/.exec(alt);
  if (isImage(ext)) {
    span.addClass('media-embed', 'image-embed');
    const img = span.createEl('img', { attr: { src: resourceUrl(file.path, file.stat.mtime), alt: size ? file.name : alt || file.name, loading: 'lazy' } });
    if (size) { img.setAttr('width', size[1]); if (size[2]) img.setAttr('height', size[2]); }
    return;
  }
  if (isAudio(ext)) {
    span.addClass('media-embed', 'audio-embed');
    span.createEl('audio', { attr: { controls: true, src: resourceUrl(file.path, file.stat.mtime) } });
    return;
  }
  if (isVideo(ext)) {
    span.addClass('media-embed', 'video-embed');
    span.createEl('video', { attr: { controls: true, src: resourceUrl(file.path, file.stat.mtime) } });
    return;
  }
  if (ext === 'pdf') {
    span.addClass('pdf-embed');
    const page = /page=(\d+)/.exec(subpath)?.[1];
    if (app.renderPdf) {
      const box = span.createDiv('pdf-embed-pages');
      box.style.maxHeight = (size?.[1] || 600) + 'px';
      app.renderPdf(box, file).then((show) => page && show && show(Number(page)));
      return;
    }
    span.createEl('iframe', { attr: { src: resourceUrl(file.path, file.stat.mtime) + (page ? `#page=${page}` : ''), height: size?.[1] || 600 } });
    return;
  }
  if (ext === 'md') {
    if (depth >= 4 || (file.path === sourcePath && !subpath)) {
      span.createDiv({ cls: 'embed-unresolved', text: t('embed.too-deep') });
      return;
    }
    span.addClass('markdown-embed', 'inline-embed', 'is-loaded');
    const titleEl = span.createDiv('markdown-embed-title');
    titleEl.setText(file.basename + (subpath ? ' ' + subpath.replace(/#\^?/g, ' > ').trim() : ''));
    const link = span.createDiv({ cls: 'markdown-embed-link', attr: { 'aria-label': t('embed.open') } });
    setIcon(link, 'external-link');
    link.addEventListener('click', (e) => { e.stopPropagation(); app.workspace.openLinkText(src, sourcePath, 'tab'); });
    const content = span.createDiv('markdown-embed-content markdown-rendered');
    const text = await app.vault.cachedRead(file);
    let part = text;
    if (subpath) {
      const cache = app.metadataCache.getFileCache(file);
      const sp = resolveSubpath(cache, subpath);
      if (!sp) { content.setText(t('embed.section-missing', { name: subpath })); return; }
      const lines = text.split('\n');
      const startLine = sp.start.line;
      const endLine = sp.end ? (sp.type === 'heading' ? sp.end.line - 1 : sp.end.line) : lines.length - 1;
      part = lines.slice(startLine, endLine + 1).join('\n');
      if (sp.type === 'block') part = part.replace(/\s\^[A-Za-z0-9-]+\s*$/, '');
    }
    const secs = renderSections(app, part, content, file.path, component, { keepFrontmatter: !!subpath });
    await postProcess(app, secs, file.path, component, app.metadataCache.getFileCache(file)?.frontmatter, part, depth + 1);
    return;
  }
  if (ext === 'canvas' || ext === 'base') {
    span.addClass('file-embed');
    const box = span.createDiv('file-embed-title');
    setIcon(box.createSpan('file-embed-icon'), ext === 'canvas' ? 'canvas' : 'database');
    box.createSpan({ text: file.basename });
    span.addEventListener('click', () => app.workspace.openFile(file, false));
    if (ext === 'base' && app.renderBaseEmbed) await app.renderBaseEmbed(span, file, subpath, component);
    return;
  }
  span.addClass('file-embed');
  const box = span.createDiv('file-embed-title');
  setIcon(box.createSpan('file-embed-icon'), 'file');
  box.createSpan({ text: file.name });
  span.addEventListener('click', () => app.api('system.openPath', { path: file.path }));
}

// ------------------------------------------------------------------- public API
export class MarkdownRenderer extends MarkdownRenderChild {
  static async render(app, markdown, el, sourcePath, component) {
    el.addClass('markdown-rendered');
    const secs = renderSections(app, markdown, el, sourcePath || '', component);
    const fm = sourcePath ? app.metadataCache.getCache(sourcePath)?.frontmatter : undefined;
    await postProcess(app, secs, sourcePath || '', component, fm, markdown);
    // plugins expect the blocks as direct children of `el` (Tasks moves a <p>'s children
    // up with el.insertBefore), not inside the section wrappers of the reading view (A-6)
    for (const sec of secs) {
      const div = sec.el;
      if (div.parentNode !== el || div.className) continue;
      while (div.firstChild) el.insertBefore(div.firstChild, div);
      div.remove();
    }
  }

  static async renderMarkdown(markdown, el, sourcePath, component) {
    return MarkdownRenderer.render(window.app, markdown, el, sourcePath, component);
  }
}

export function renderInlineMarkdown(text) {
  return md.renderInline(text, {});
}

export function htmlToMarkdown(html) {
  const doc = typeof html === 'string' ? new DOMParser().parseFromString(html, 'text/html').body : html;
  const walk = (node, ctx = {}) => {
    if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const inner = () => Array.from(node.childNodes).map((c) => walk(c, ctx)).join('');
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return `\n\n${'#'.repeat(+tag[1])} ${inner().trim()}\n\n`;
      case 'p': case 'div': case 'section': case 'article': return `\n\n${inner().trim()}\n\n`;
      case 'br': return '\n';
      case 'strong': case 'b': return `**${inner()}**`;
      case 'em': case 'i': return `*${inner()}*`;
      case 's': case 'del': case 'strike': return `~~${inner()}~~`;
      case 'mark': return `==${inner()}==`;
      case 'code': return ctx.pre ? node.textContent : `\`${node.textContent}\``;
      case 'pre': return `\n\n\`\`\`\n${node.textContent.replace(/\n$/, '')}\n\`\`\`\n\n`;
      case 'a': { const h = node.getAttribute('href') || ''; const txt = inner(); return h ? `[${txt}](${h})` : txt; }
      case 'img': return `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`;
      case 'blockquote': return '\n\n' + inner().trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
      case 'ul': case 'ol': {
        let n = 0;
        return '\n\n' + Array.from(node.children).filter((c) => c.tagName === 'LI').map((li) => {
          n++;
          const body = walk(li, ctx).trim().replace(/\n/g, '\n    ');
          return (tag === 'ol' ? `${n}. ` : '- ') + body;
        }).join('\n') + '\n\n';
      }
      case 'li': return inner();
      case 'hr': return '\n\n---\n\n';
      case 'table': {
        const rows = Array.from(node.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((c) => walk(c, ctx).trim().replace(/\|/g, '\\|')));
        if (!rows.length) return '';
        const head = rows[0];
        return '\n\n| ' + head.join(' | ') + ' |\n|' + head.map(() => ' --- |').join('') + '\n' + rows.slice(1).map((r) => '| ' + r.join(' | ') + ' |').join('\n') + '\n\n';
      }
      case 'script': case 'style': return '';
      default: return inner();
    }
  };
  return walk(doc).replace(/\n{3,}/g, '\n\n').trim();
}

/** Remove anything that could run code from HTML written in notes (or by plugins).
 *  Notes may come from other people: no scripts, no event handlers, no javascript:
 *  URLs, no base/meta/link/object/embed; iframes (web page embeds) are sandboxed
 *  without same-origin access. */
export function sanitizeHTMLToDom(html, opts = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html);
  const banned = 'script, object, embed, style, link, meta, base, frame, frameset, applet' + (opts.iframes ? '' : ', iframe');
  for (const bad of tpl.content.querySelectorAll(banned)) bad.remove();
  for (const el of tpl.content.querySelectorAll('*')) {
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase();
      const value = a.value.replace(/[\u0000- ]/g, '').toLowerCase();
      if (name.startsWith('on') || name === 'formaction' || name === 'srcdoc'
        || (/^(href|src|xlink:href|action|data|poster|background)$/.test(name) && /^(javascript|vbscript|data:text\/html)/.test(value))) {
        el.removeAttribute(a.name);
      }
    }
    if (el.tagName === 'IFRAME') el.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms');
    if (el.tagName === 'FORM') el.removeAttribute('action');
  }
  return tpl.content;
}

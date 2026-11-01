// Live Preview: markup is hidden outside the lines the cursor is on; links, embeds,
// tasks, math, tables, callouts and the frontmatter render as widgets.

import { syntaxTree } from '@codemirror/language';
import { EditorState, RangeSetBuilder, StateEffect, StateField, Facet } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { setIcon } from '../core/icons.js';
import { renderEmbed, renderSections, postProcess } from '../render/markdown.js';
import { Component } from '../model/component.js';

/** {app, file, editor, view} of the editor (plugins read it as editorInfoField). */
export const setEditorInfo = StateEffect.define();
export const editorInfoField = StateField.define({
  create: () => null,
  update(v, tr) { for (const e of tr.effects) if (e.is(setEditorInfo)) return e.value; return v; },
});

/** true in Live Preview, false in Source mode (plugins read it as editorLivePreviewField). */
export const editorLivePreviewField = StateField.define({
  create: () => true,
  update(v, tr) { for (const e of tr.effects) if (e.is(setLivePreview)) return e.value; return v; },
});
export const setLivePreview = StateEffect.define();

export const infoFacet = Facet.define({ combine: (v) => v[v.length - 1] || null });

const FRONTMATTER_RE = /^---\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/;

export function frontmatterRange(doc) {
  const head = doc.sliceString(0, Math.min(doc.length, 20000));
  const m = FRONTMATTER_RE.exec(head);
  return m ? { from: 0, to: m[0].endsWith('\n') ? m[0].length - 1 : m[0].length } : null;
}

function activeLines(state) {
  const lines = new Set();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  return lines;
}

function rangeTouchesSelection(state, from, to) {
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

// ------------------------------------------------------------------- widgets
class LinkWidget extends WidgetType {
  constructor(text, href, unresolved) { super(); this.text = text; this.href = href; this.unresolved = unresolved; }
  eq(o) { return o.text === this.text && o.href === this.href && o.unresolved === this.unresolved; }
  toDOM() {
    const a = createSpan({ cls: 'cm-sk-link cm-hmd-internal-link' + (this.unresolved ? ' is-unresolved' : ''), text: this.text });
    a.setAttr('data-href', this.href);
    return a;
  }
  ignoreEvent() { return false; }
}

class CheckboxWidget extends WidgetType {
  constructor(checked, pos) { super(); this.checked = checked; this.pos = pos; }
  eq(o) { return o.checked === this.checked && o.pos === this.pos; }
  toDOM(view) {
    const box = createEl('input', { type: 'checkbox', cls: 'task-list-item-checkbox' });
    box.checked = this.checked;
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const line = view.state.doc.lineAt(this.pos);
      const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\])/.exec(line.text);
      if (!m) return;
      const at = line.from + m[1].length;
      view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' } });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() { return createSpan({ cls: 'list-bullet', text: '•' }); }
}

class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() { return createEl('hr', 'cm-sk-hr'); }
}

class MathWidget extends WidgetType {
  constructor(tex, display) { super(); this.tex = tex; this.display = display; }
  eq(o) { return o.tex === this.tex && o.display === this.display; }
  toDOM() {
    const el = createEl(this.display ? 'div' : 'span', { cls: `math ${this.display ? 'math-block' : 'math-inline'} cm-sk-math` });
    import('katex').then(({ default: k }) => {
      try { k.render(this.tex, el, { displayMode: this.display, throwOnError: false }); } catch { el.setText(this.tex); }
    });
    return el;
  }
  ignoreEvent() { return false; }
}

class EmbedWidget extends WidgetType {
  constructor(info, target, alias) { super(); this.info = info; this.target = target; this.alias = alias; }
  eq(o) { return o.target === this.target && o.alias === this.alias; }
  toDOM() {
    const span = createSpan({ cls: 'internal-embed cm-sk-embed', attr: { src: this.target, alt: this.alias } });
    const c = new Component();
    c.load();
    this._c = c;
    if (this.info?.app) renderEmbed(this.info.app, span, this.info.file?.path || '', c, 1);
    return span;
  }
  destroy() { this._c?.unload(); }
  get estimatedHeight() { return 120; }
  ignoreEvent() { return false; }
}

class RenderedBlockWidget extends WidgetType {
  constructor(info, text, from, kind) { super(); this.info = info; this.text = text; this.from = from; this.kind = kind; }
  eq(o) { return o.text === this.text && o.kind === this.kind; }
  toDOM(view) {
    const box = createDiv({ cls: `cm-sk-block cm-sk-block-${this.kind} markdown-rendered` });
    const c = new Component();
    c.load();
    this._c = c;
    if (this.info?.app) {
      const secs = renderSections(this.info.app, this.text, box, this.info.file?.path || '', c, { keepFrontmatter: true });
      postProcess(this.info.app, secs, this.info.file?.path || '', c, undefined, this.text);
    }
    const edit = box.createDiv({ cls: 'cm-sk-block-edit clickable-icon' });
    setIcon(edit, 'code');
    edit.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return box;
  }
  destroy() { this._c?.unload(); }
  ignoreEvent(e) { return !(e.type === 'mousedown' && e.target.closest?.('.cm-sk-block-edit')); }
}

class PropertiesWidget extends WidgetType {
  constructor(info, yamlText) { super(); this.info = info; this.yamlText = yamlText; }
  eq(o) { return o.yamlText === this.yamlText; }
  toDOM(view) {
    const box = createDiv('cm-sk-properties metadata-container');
    if (this.info?.app?.renderPropertiesEditor) this.info.app.renderPropertiesEditor(box, view, this.yamlText, this.info);
    else box.setText(this.yamlText);
    return box;
  }
  ignoreEvent() { return true; }
}

// ------------------------------------------------------------------- inline decorations
const hide = Decoration.replace({});

function buildInline(view) {
  const { state } = view;
  const info = state.facet(infoFacet);
  const app = info?.app;
  const active = activeLines(state);
  const b = [];
  const lineOf = (pos) => state.doc.lineAt(pos).number;
  const isActive = (from, to) => {
    const a = lineOf(from);
    const z = lineOf(to);
    for (let n = a; n <= z; n++) if (active.has(n)) return true;
    return false;
  };
  const fm = frontmatterRange(state.doc);
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const name = node.name;
        if (fm && node.from < fm.to) return name === 'Document';
        switch (name) {
          case 'ATXHeading1': case 'ATXHeading2': case 'ATXHeading3': case 'ATXHeading4': case 'ATXHeading5': case 'ATXHeading6':
            return true;
          case 'HeaderMark': {
            const line = state.doc.lineAt(node.from);
            if (!active.has(line.number) && node.from === line.from + (line.text.length - line.text.trimStart().length)) {
              const end = Math.min(node.to + 1, line.to);
              b.push(hide.range(node.from, end));
            }
            return false;
          }
          case 'EmphasisMark': case 'CodeMark': case 'StrikethroughMark': case 'HighlightMark': case 'QuoteMark':
            if (name === 'CodeMark' && node.node.parent?.name === 'FencedCode') return false;
            if (!isActive(node.from, node.to)) {
              let end = node.to;
              if (name === 'QuoteMark' && state.doc.sliceString(end, end + 1) === ' ') end++;
              b.push(hide.range(node.from, end));
            }
            return false;
          case 'Link': {
            if (isActive(node.from, node.to)) return false;
            const marks = [];
            let url = null;
            for (let c = node.node.firstChild; c; c = c.nextSibling) {
              if (c.name === 'LinkMark') marks.push(c);
              if (c.name === 'URL') url = c;
            }
            if (marks.length >= 2 && url) {
              const href = state.doc.sliceString(url.from, url.to).replace(/^<|>$/g, '');
              b.push(hide.range(marks[0].from, marks[0].to));
              b.push(Decoration.mark({ class: 'cm-sk-link cm-link', attributes: { 'data-href': safeDecode(href) } }).range(marks[0].to, marks[1].from));
              b.push(hide.range(marks[1].from, node.to));
            }
            return false;
          }
          case 'Image': {
            if (isActive(node.from, node.to)) return false;
            const txt = state.doc.sliceString(node.from, node.to);
            const m = /^!\[([^\]]*)\]\(\s*<?([^)>\s]+)>?/.exec(txt);
            if (m && app) b.push(Decoration.replace({ widget: new EmbedWidget(info, safeDecode(m[2]), m[1]) }).range(node.from, node.to));
            return false;
          }
          case 'WikiLink': {
            if (isActive(node.from, node.to)) return false;
            const inner = state.doc.sliceString(node.from + 2, node.to - 2);
            const bar = inner.indexOf('|');
            const target = (bar === -1 ? inner : inner.slice(0, bar)).trim();
            const text = bar === -1 ? target.replace(/#\^?/, ' > ').replace(/^ > /, '') : inner.slice(bar + 1);
            const pathPart = target.split('#')[0];
            const unresolved = app && pathPart ? !app.metadataCache.getFirstLinkpathDest(pathPart, info.file?.path || '') : false;
            b.push(Decoration.replace({ widget: new LinkWidget(text, target, unresolved) }).range(node.from, node.to));
            return false;
          }
          case 'Embed': {
            if (isActive(node.from, node.to)) return false;
            const inner = state.doc.sliceString(node.from + 3, node.to - 2);
            const bar = inner.indexOf('|');
            b.push(Decoration.replace({ widget: new EmbedWidget(info, (bar === -1 ? inner : inner.slice(0, bar)).trim(), bar === -1 ? '' : inner.slice(bar + 1)) }).range(node.from, node.to));
            return false;
          }
          case 'Hashtag':
            b.push(Decoration.mark({ class: 'cm-hashtag', attributes: { 'data-tag': state.doc.sliceString(node.from + 1, node.to) } }).range(node.from, node.to));
            return false;
          case 'InlineMath':
            if (!isActive(node.from, node.to)) {
              b.push(Decoration.replace({ widget: new MathWidget(state.doc.sliceString(node.from + 1, node.to - 1), false) }).range(node.from, node.to));
            }
            return false;
          case 'TaskMarker': {
            const txt = state.doc.sliceString(node.from, node.to);
            b.push(Decoration.replace({ widget: new CheckboxWidget(txt[1] !== ' ', node.from) }).range(node.from, node.to));
            const line = state.doc.lineAt(node.from);
            if (txt[1] !== ' ') b.push(Decoration.mark({ class: 'cm-sk-task-done' }).range(node.to, line.to));
            return false;
          }
          case 'ListMark': {
            const line = state.doc.lineAt(node.from);
            const after = state.doc.sliceString(node.to, Math.min(node.to + 4, line.to));
            const ch = state.doc.sliceString(node.from, node.to);
            if (/^ \[.\]/.test(after)) {
              // task item: the checkbox replaces the bullet
              if (!active.has(line.number)) b.push(hide.range(node.from, Math.min(node.to + 1, line.to)));
            } else if (/^[-*+]$/.test(ch) && !active.has(line.number)) {
              b.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
            }
            return false;
          }
          case 'HorizontalRule': {
            const line = state.doc.lineAt(node.from);
            if (!active.has(line.number)) b.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
            return false;
          }
          case 'BlockId':
            b.push(Decoration.mark({ class: 'cm-sk-block-id' }).range(node.from, node.to));
            return false;
          default:
            return true;
        }
      },
    });
  }
  return Decoration.set(b, true);
}

export const livePreviewInline = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = view.state.field(editorLivePreviewField) ? buildInline(view) : Decoration.none; }
  update(u) {
    const lp = u.state.field(editorLivePreviewField);
    if (!lp) { this.decorations = Decoration.none; return; }
    if (u.docChanged || u.viewportChanged || u.selectionSet || u.startState.field(editorLivePreviewField) !== lp
      || syntaxTree(u.startState) !== syntaxTree(u.state) || u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLP)))) {
      this.decorations = buildInline(u.view);
    }
  }
}, { decorations: (v) => v.decorations });

export const refreshLP = StateEffect.define();

// ------------------------------------------------------------------- block decorations
function buildBlocks(state) {
  if (!state.field(editorLivePreviewField)) return Decoration.none;
  const info = state.facet(infoFacet);
  const out = [];
  const fm = frontmatterRange(state.doc);
  if (fm && info?.app?.renderPropertiesEditor && info.showProperties !== false) {
    out.push(Decoration.replace({ widget: new PropertiesWidget(info, state.doc.sliceString(0, fm.to)), block: true }).range(fm.from, fm.to));
  }
  const tree = syntaxTree(state);
  let child = tree.topNode.firstChild;
  while (child) {
    const { from, to, name } = child;
    if (fm && from < fm.to) { child = child.nextSibling; continue; }
    let kind = null;
    if (name === 'Table') kind = 'table';
    else if (name === 'BlockMath') kind = 'math';
    else if (name === 'Blockquote' && /^\s*>\s*\[!/.test(state.doc.sliceString(from, Math.min(to, from + 40)))) kind = 'callout';
    else if (name === 'CommentBlock') kind = 'comment';
    else if (name === 'HTMLBlock') kind = 'html';
    else if (name === 'FencedCode') {
      // a code block a plugin renders (dataview, tasks, ad-note…) shows its result, like in
      // the reading view, while the cursor is outside it (A-5)
      const lang = /^\s*(`{3,}|~{3,})\s*([^\s`{]+)/.exec(state.doc.lineAt(from).text)?.[2];
      if (lang && info?.app?.markdownProcessors?.codeBlocks?.has(lang)) kind = 'code';
    }
    if (kind && !rangeTouchesSelection(state, from, to)) {
      const start = state.doc.lineAt(from).from;
      const end = state.doc.lineAt(to).to;
      const text = state.doc.sliceString(start, end);
      if (kind === 'comment') {
        out.push(Decoration.mark({ class: 'cm-sk-comment-block' }).range(start, end));
      } else if (kind === 'math') {
        const tex = text.trim().replace(/^\$\$/, '').replace(/\$\$$/, '');
        out.push(Decoration.replace({ widget: new MathWidget(tex, true), block: true }).range(start, end));
      } else {
        out.push(Decoration.replace({ widget: new RenderedBlockWidget(info, text, start, kind), block: true }).range(start, end));
      }
    }
    child = child.nextSibling;
  }
  return Decoration.set(out, true);
}

export const livePreviewBlocks = StateField.define({
  create: (state) => buildBlocks(state),
  update(deco, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setLivePreview) || e.is(refreshLP))
      || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return buildBlocks(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// line classes for headings etc. (both modes)
export const lineClasses = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = this.build(u.view); }
  build(view) {
    const builder = new RangeSetBuilder();
    const fm = frontmatterRange(view.state.doc);
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from, to,
        enter: (node) => {
          const m = /^ATXHeading(\d)$|^SetextHeading(\d)$/.exec(node.name);
          if (m && !(fm && node.from < fm.to)) {
            const line = view.state.doc.lineAt(node.from);
            builder.add(line.from, line.from, Decoration.line({ class: `HyperMD-header HyperMD-header-${m[1] || m[2]} cm-sk-heading` }));
          }
          if (node.name === 'FencedCode') {
            const a = view.state.doc.lineAt(node.from).number;
            const z = view.state.doc.lineAt(node.to).number;
            for (let n = Math.max(a, view.state.doc.lineAt(from).number); n <= Math.min(z, view.state.doc.lineAt(to).number); n++) {
              const l = view.state.doc.line(n);
              builder.add(l.from, l.from, Decoration.line({ class: 'HyperMD-codeblock' + (n === a ? ' HyperMD-codeblock-begin' : n === z ? ' HyperMD-codeblock-end' : '') }));
            }
            return false;
          }
          if (node.name === 'Blockquote') {
            const a = view.state.doc.lineAt(node.from).number;
            const z = view.state.doc.lineAt(node.to).number;
            for (let n = Math.max(a, view.state.doc.lineAt(from).number); n <= Math.min(z, view.state.doc.lineAt(to).number); n++) {
              const l = view.state.doc.line(n);
              builder.add(l.from, l.from, Decoration.line({ class: 'HyperMD-quote' }));
            }
            return false;
          }
          return true;
        },
      });
    }
    return builder.finish();
  }
}, { decorations: (v) => v.decorations });

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

/** Click on a rendered link in the editor opens it (Ctrl/middle → new tab). */
export function linkClickHandler(openLink) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      const el = e.target.closest?.('.cm-sk-link, .cm-hashtag, .cm-sk-embed .markdown-embed-link');
      if (!el || e.button === 2) return false;
      if (el.hasClass('cm-hashtag')) {
        if (!view.state.field(editorLivePreviewField) && !(e.ctrlKey || e.metaKey)) return false;
        e.preventDefault();
        openLink({ tag: el.getAttr('data-tag') }, e);
        return true;
      }
      const href = el.getAttr('data-href');
      if (!href) return false;
      e.preventDefault();
      openLink({ href }, e);
      return true;
    },
  });
}

/** Source mode: Ctrl+click on [[link]] text opens it. */
export function sourceLinkHandler(openLink) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      if (view.state.field(editorLivePreviewField) || !(e.ctrlKey || e.metaKey)) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos === null) return false;
      let node = syntaxTree(view.state).resolveInner(pos, 1);
      while (node && node.name !== 'WikiLink' && node.name !== 'Link' && node.name !== 'Embed') node = node.parent;
      if (!node) return false;
      const txt = view.state.sliceDoc(node.from, node.to);
      let href = null;
      if (node.name === 'Link') href = /\]\(\s*<?([^)>\s]+)/.exec(txt)?.[1];
      else href = txt.replace(/^!?\[\[|\]\]$/g, '').split('|')[0];
      if (!href) return false;
      e.preventDefault();
      openLink({ href: safeDecode(href) }, e);
      return true;
    },
  });
}

export { EditorState };

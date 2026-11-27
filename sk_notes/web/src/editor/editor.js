// CodeMirror 6 editor setup for notes and the Editor API wrapper.

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, startCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, indentWithTab, redo, undo, selectAll } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, bracketMatching, foldGutter, foldKeymap, foldService, indentOnInput, syntaxHighlighting, foldEffect, unfoldAll, foldAll, foldCode, unfoldCode } from '@codemirror/language';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { createFindPanel } from './find-panel.js';
import { Compartment, EditorSelection, EditorState, Prec } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, keymap, placeholder, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { t as tr } from '../core/i18n.js';
import { skMarkdownExtensions, skTags } from './syntax.js';
import {
  editorInfoField, editorLivePreviewField, infoFacet, lineClasses, linkClickHandler, livePreviewBlocks, livePreviewInline,
  refreshLP, setEditorInfo, setLivePreview, sourceLinkHandler,
} from './livepreview.js';

// ------------------------------------------------------------------- highlight style
export const skHighlight = HighlightStyle.define([
  { tag: t.heading1, class: 'cm-header cm-header-1' },
  { tag: t.heading2, class: 'cm-header cm-header-2' },
  { tag: t.heading3, class: 'cm-header cm-header-3' },
  { tag: t.heading4, class: 'cm-header cm-header-4' },
  { tag: t.heading5, class: 'cm-header cm-header-5' },
  { tag: t.heading6, class: 'cm-header cm-header-6' },
  { tag: t.strong, class: 'cm-strong' },
  { tag: t.emphasis, class: 'cm-em' },
  { tag: t.strikethrough, class: 'cm-strikethrough' },
  { tag: t.link, class: 'cm-link' },
  { tag: t.url, class: 'cm-url' },
  { tag: t.monospace, class: 'cm-inline-code' },
  { tag: t.quote, class: 'cm-quote' },
  { tag: t.list, class: 'cm-list' },
  { tag: t.processingInstruction, class: 'cm-formatting' },
  { tag: t.meta, class: 'cm-meta' },
  { tag: t.contentSeparator, class: 'cm-hr' },
  { tag: t.keyword, class: 'cm-keyword' },
  { tag: t.string, class: 'cm-string' },
  { tag: t.number, class: 'cm-number' },
  { tag: t.comment, class: 'cm-comment' },
  { tag: t.variableName, class: 'cm-variable' },
  { tag: t.function(t.variableName), class: 'cm-def' },
  { tag: t.typeName, class: 'cm-type' },
  { tag: t.propertyName, class: 'cm-property' },
  { tag: t.operator, class: 'cm-operator' },
  { tag: t.bool, class: 'cm-atom' },
  { tag: t.tagName, class: 'cm-tag' },
  { tag: t.attributeName, class: 'cm-attribute' },
  { tag: skTags.wikilink, class: 'cm-hmd-internal-link' },
  { tag: skTags.embed, class: 'cm-hmd-internal-link cm-embed' },
  { tag: skTags.tag, class: 'cm-hashtag' },
  { tag: skTags.highlight, class: 'cm-highlight' },
  { tag: skTags.comment, class: 'cm-comment' },
  { tag: skTags.math, class: 'cm-math' },
  { tag: skTags.blockId, class: 'cm-blockid' },
]);

// ------------------------------------------------------------------- formatting commands
function toggleWrap(view, mark) {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const before = state.sliceDoc(range.from - mark.length, range.from);
    const after = state.sliceDoc(range.to, range.to + mark.length);
    if (before === mark && after === mark) {
      return { changes: [{ from: range.from - mark.length, to: range.from }, { from: range.to, to: range.to + mark.length }],
        range: EditorSelection.range(range.from - mark.length, range.to - mark.length) };
    }
    if (text.startsWith(mark) && text.endsWith(mark) && text.length >= mark.length * 2) {
      return { changes: { from: range.from, to: range.to, insert: text.slice(mark.length, -mark.length) },
        range: EditorSelection.range(range.from, range.to - mark.length * 2) };
    }
    if (range.empty) {
      const word = state.wordAt(range.head);
      if (word) {
        return { changes: [{ from: word.from, insert: mark }, { from: word.to, insert: mark }],
          range: EditorSelection.cursor(range.head + mark.length) };
      }
    }
    return { changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
      range: EditorSelection.range(range.from + mark.length, range.to + mark.length) };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
  return true;
}

function eachLine(view, fn) {
  const { state } = view;
  const lines = new Set();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) lines.add(n);
  }
  const changes = [];
  for (const n of [...lines].sort((a, b) => a - b)) {
    const line = state.doc.line(n);
    const out = fn(line.text);
    if (out !== null && out !== line.text) changes.push({ from: line.from, to: line.to, insert: out });
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'input' });
  return true;
}

export const commands = {
  bold: (v) => toggleWrap(v, '**'),
  italic: (v) => toggleWrap(v, '*'),
  strike: (v) => toggleWrap(v, '~~'),
  highlight: (v) => toggleWrap(v, '=='),
  code: (v) => toggleWrap(v, '`'),
  math: (v) => toggleWrap(v, '$'),
  comment: (v) => toggleWrap(v, '%%'),
  link: (v) => {
    const r = v.state.selection.main;
    const text = v.state.sliceDoc(r.from, r.to);
    if (/^[a-z]+:\/\//i.test(text)) {
      v.dispatch({ changes: { from: r.from, to: r.to, insert: `[](${text})` }, selection: { anchor: r.from + 1 } });
    } else {
      v.dispatch({ changes: { from: r.from, to: r.to, insert: `[${text}]()` }, selection: { anchor: r.from + text.length + 3 } });
    }
    return true;
  },
  wikilink: (v) => {
    const r = v.state.selection.main;
    const text = v.state.sliceDoc(r.from, r.to);
    v.dispatch({ changes: { from: r.from, to: r.to, insert: `[[${text}]]` }, selection: { anchor: r.from + 2 + text.length } });
    if (!text) startCompletion(v);
    return true;
  },
  toggleChecklist: (v) => eachLine(v, (l) => {
    const m = /^(\s*)([-*+]|\d+[.)])\s+\[(.)\]\s?(.*)$/.exec(l);
    if (m) return `${m[1]}${m[2]} [${m[3] === ' ' ? 'x' : ' '}] ${m[4]}`;
    const b = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (b) return `${b[1]}${b[2]} [ ] ${b[3]}`;
    return `- [ ] ${l}`;
  }),
  toggleBullet: (v) => eachLine(v, (l) => {
    const m = /^(\s*)[-*+]\s+(?:\[.\]\s+)?(.*)$/.exec(l);
    return m ? m[1] + m[2] : `- ${l.trimStart()}`;
  }),
  toggleNumbered: (v) => eachLine(v, (l) => {
    const m = /^(\s*)\d+[.)]\s+(.*)$/.exec(l);
    return m ? m[1] + m[2] : `1. ${l.trimStart()}`;
  }),
  toggleQuote: (v) => eachLine(v, (l) => (/^>\s?/.test(l) ? l.replace(/^>\s?/, '') : `> ${l}`)),
  heading: (level) => (v) => eachLine(v, (l) => {
    const stripped = l.replace(/^#{1,6}\s+/, '');
    const cur = /^(#{1,6})\s/.exec(l)?.[1].length || 0;
    return cur === level ? stripped : (level ? '#'.repeat(level) + ' ' : '') + stripped;
  }),
  deleteParagraph: (v) => {
    const { state } = v;
    const line = state.doc.lineAt(state.selection.main.head);
    const to = Math.min(state.doc.length, line.to + 1);
    v.dispatch({ changes: { from: line.from, to }, userEvent: 'delete' });
    return true;
  },
  swapUp: (v) => swapLine(v, -1),
  swapDown: (v) => swapLine(v, 1),
  insertCodeBlock: (v) => {
    const r = v.state.selection.main;
    const text = v.state.sliceDoc(r.from, r.to);
    v.dispatch({ changes: { from: r.from, to: r.to, insert: '```\n' + text + '\n```' }, selection: { anchor: r.from + 3 } });
    return true;
  },
  insertCallout: (v) => {
    const r = v.state.selection.main;
    const text = v.state.sliceDoc(r.from, r.to);
    v.dispatch({ changes: { from: r.from, to: r.to, insert: '> [!note]\n> ' + text.split('\n').join('\n> ') }, selection: { anchor: r.from + 12 } });
    return true;
  },
  insertTable: (v) => {
    const r = v.state.selection.main;
    v.dispatch({ changes: { from: r.from, insert: '\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n' }, selection: { anchor: r.from + 3 } });
    return true;
  },
  insertHr: (v) => {
    const r = v.state.selection.main;
    v.dispatch({ changes: { from: r.from, insert: '\n---\n' } });
    return true;
  },
  clearFormatting: (v) => {
    const r = v.state.selection.main;
    const text = v.state.sliceDoc(r.from, r.to).replace(/(\*\*|__|==|~~|%%|\*|_|`)/g, '');
    v.dispatch({ changes: { from: r.from, to: r.to, insert: text } });
    return true;
  },
};

function swapLine(view, dir) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const other = dir < 0 ? (line.number > 1 ? state.doc.line(line.number - 1) : null) : (line.number < state.doc.lines ? state.doc.line(line.number + 1) : null);
  if (!other) return true;
  const a = dir < 0 ? other : line;
  const b = dir < 0 ? line : other;
  const offset = state.selection.main.head - line.from;
  view.dispatch({
    changes: { from: a.from, to: b.to, insert: b.text + '\n' + a.text },
    selection: { anchor: (dir < 0 ? a.from : a.from + b.text.length + 1) + offset },
    userEvent: 'move.line',
  });
  return true;
}

// Enter in lists continues the list (tasks restart unchecked); empty item ends it.
function continueList(view) {
  const { state } = view;
  const r = state.selection.main;
  if (!r.empty) return false;
  const line = state.doc.lineAt(r.head);
  const m = /^(\s*)((?:[-*+])|(\d+)([.)]))(\s+)(\[.\]\s+)?(.*)$/.exec(line.text);
  if (!m) {
    const q = /^(\s*>\s?)(.*)$/.exec(line.text);
    if (q && r.head === line.to) {
      if (!q[2].trim()) { view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } }); return true; }
      view.dispatch({ changes: { from: r.head, insert: '\n' + q[1] }, selection: { anchor: r.head + 1 + q[1].length }, userEvent: 'input' });
      return true;
    }
    return false;
  }
  if (r.head < line.from + m[1].length + m[2].length) return false;
  const content = m[7];
  if (!content.trim() && r.head === line.to) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: '' }, userEvent: 'delete' });
    return true;
  }
  const bullet = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2];
  const task = m[6] ? '[ ] ' : '';
  const insert = '\n' + m[1] + bullet + m[5] + task;
  view.dispatch({ changes: { from: r.head, to: r.head, insert }, selection: { anchor: r.head + insert.length }, userEvent: 'input', scrollIntoView: true });
  return true;
}

// Fold headings by section (both modes) and lists by indentation.
const headingFold = foldService.of((state, from, to) => {
  const line = state.doc.lineAt(from);
  const m = /^(#{1,6})\s/.exec(line.text);
  if (m) {
    const level = m[1].length;
    let end = line.to;
    for (let n = line.number + 1; n <= state.doc.lines; n++) {
      const l = state.doc.line(n);
      const h = /^(#{1,6})\s/.exec(l.text);
      if (h && h[1].length <= level) break;
      end = l.to;
    }
    while (end > line.to && /^\s*$/.test(state.doc.lineAt(end).text)) end = state.doc.lineAt(end).from - 1;
    return end > line.to ? { from: line.to, to: end } : null;
  }
  const li = /^(\s*)([-*+]|\d+[.)])\s/.exec(line.text);
  if (li) {
    const ind = li[1].length;
    let end = line.to;
    for (let n = line.number + 1; n <= state.doc.lines; n++) {
      const l = state.doc.line(n);
      if (!l.text.trim()) break;
      if ((/^(\s*)/.exec(l.text)[1].length) <= ind) break;
      end = l.to;
    }
    return end > line.to ? { from: line.to, to: end } : null;
  }
  return null;
});

// ------------------------------------------------------------------- completion
function linkCompletionSource(getInfo) {
  return async (ctx) => {
    const info = getInfo();
    if (!info?.app) return null;
    const app = info.app;
    const before = ctx.state.doc.sliceString(Math.max(0, ctx.pos - 300), ctx.pos);
    const m = /(!?)\[\[([^\[\]|\n]*)$/.exec(before);
    if (m) {
      const query = m[2];
      const from = ctx.pos - query.length;
      const after = ctx.state.doc.sliceString(ctx.pos, ctx.pos + 2);
      const close = after === ']]' ? '' : ']]';
      const hashIdx = query.indexOf('#');
      if (hashIdx !== -1) {
        // headings / blocks of a note
        const notePart = query.slice(0, hashIdx);
        const file = notePart ? app.metadataCache.getFirstLinkpathDest(notePart, info.file?.path || '') : info.file;
        const cache = file && app.metadataCache.getFileCache(file);
        if (!cache) return null;
        const sub = query.slice(hashIdx + 1);
        const options = sub.startsWith('^')
          ? (cache.listItems || []).concat(cache.sections || []).filter((x) => x.id || x.position).slice(0, 300).map((x) => {
            const id = x.id;
            const line = info.app.vault._cache.get(file.path)?.text?.split('\n')[x.position.start.line] || '';
            return { label: '^' + (id || ''), detail: line.slice(0, 60), apply: '^' + (id || ''), type: 'block' };
          }).filter((o) => o.label !== '^')
          : (cache.headings || []).map((h) => ({ label: h.heading, detail: 'H' + h.level, type: 'heading', apply: h.heading + close }));
        return { from: from + hashIdx + 1, options, validFor: /^[^#|\]]*$/ };
      }
      const files = app.vault.getFiles();
      const options = [];
      for (const f of files) {
        const text = f.extension === 'md' ? f.basename : f.name;
        const linktext = app.metadataCache.fileToLinktext(f, info.file?.path || '');
        options.push({ label: text, detail: f.parent && f.parent.path !== '/' ? f.parent.path : '', apply: linktext + close, type: f.extension === 'md' ? 'note' : 'file', boost: f.extension === 'md' ? 1 : 0 });
        const aliases = app.metadataCache.getFileCache(f)?.frontmatter?.aliases;
        for (const a of Array.isArray(aliases) ? aliases : typeof aliases === 'string' ? [aliases] : []) {
          options.push({ label: String(a), detail: '→ ' + text, apply: `${linktext}|${a}${close}`, type: 'alias' });
        }
      }
      // "create note" only when nothing existing matches: an exact label outranks a
      // prefix match in CodeMirror's scoring whatever the boost, so Enter would link to
      // a new note instead of the existing "Note 0042 python" (A-10)
      const q = query.trim();
      if (q && !app.metadataCache.getFirstLinkpathDest(q, info.file?.path || '')
          && !options.some((o) => o.label.toLowerCase().includes(q.toLowerCase()))) {
        options.push({ label: q, detail: tr('editor.create-note'), apply: q + close, type: 'new', boost: -99 });
      }
      return { from, options, validFor: /^[^#|\[\]\n]*$/ };
    }
    const tm = /(^|[\s(])#([^\s#!"$%&'()*+,.:;<=>?@[\\\]^`{|}~]*)$/u.exec(before);
    if (tm && (tm[2].length || ctx.explicit || true)) {
      const from = ctx.pos - tm[2].length;
      const tags = Object.entries(app.metadataCache.getTags()).sort((a, b) => b[1] - a[1]);
      if (!tags.length) return null;
      return { from, options: tags.map(([tag, n]) => ({ label: tag.slice(1), detail: String(n), type: 'tag' })), validFor: /^[^\s#]*$/u };
    }
    return null;
  };
}

function slashSource(getInfo) {
  return (ctx) => {
    const info = getInfo();
    if (!info?.app || info.app.settings?.get('slashCommands') === false) return null;
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = ctx.state.doc.sliceString(line.from, ctx.pos);
    const m = /(^|\s)\/([\p{L}\p{N} -]*)$/u.exec(before);
    if (!m) return null;
    const from = ctx.pos - m[2].length - 1;
    const cmds = info.app.commands.listCommands();
    return {
      from,
      options: cmds.map((c) => ({
        label: c.name, type: 'command', detail: '',
        apply: (view, completion, f, to) => {
          view.dispatch({ changes: { from: f, to, insert: '' } });
          setTimeout(() => info.app.commands.executeCommand(c), 0);
        },
      })),
      filter: true,
      validFor: /^\/[\p{L}\p{N} -]*$/u,
    };
  };
}

// plugin EditorSuggest instances (registered through the plugin API)
function pluginSuggestSource(getInfo) {
  return async (ctx) => {
    const info = getInfo();
    const app = info?.app;
    if (!app || !app.editorSuggests?.length || !info.editor) return null;
    const cursor = info.editor.offsetToPos(ctx.pos);
    for (const s of app.editorSuggests) {
      let trig;
      try { trig = s.onTrigger(cursor, info.editor, info.file); } catch (e) { console.error(e); continue; }
      if (!trig) continue;
      s.context = { ...trig, editor: info.editor, file: info.file };
      let items;
      try { items = await s.getSuggestions(s.context); } catch (e) { console.error(e); continue; }
      if (!items || !items.length) continue;
      const from = info.editor.posToOffset(trig.start);
      return {
        from,
        filter: false,
        options: items.slice(0, s.limit || 100).map((item) => ({
          label: ' ',
          render: () => { const el = createDiv('suggestion-item'); try { s.renderSuggestion(item, el); } catch (e) { console.error(e); } return el; },
          apply: () => { try { s.selectSuggestion(item, new KeyboardEvent('keydown')); } catch (e) { console.error(e); } },
        })),
      };
    }
    return null;
  };
}

// ------------------------------------------------------------------- setup
export function createEditor({ parent, doc, info, livePreview = true, onChange, onFocus, openLink, extraKeys = [], pluginExtensions = [], settings = {} }) {
  const lpComp = new Compartment();
  const infoComp = new Compartment();
  const pluginComp = new Compartment();
  const settingsComp = new Compartment();
  const historyComp = new Compartment();
  const readOnlyComp = new Compartment();
  let currentInfo = info;
  const getInfo = () => currentInfo;
  const settingsExt = (s) => [
    s.lineWrap !== false ? EditorView.lineWrapping : [],
    s.spellcheck ? EditorView.contentAttributes.of({ spellcheck: 'true' }) : EditorView.contentAttributes.of({ spellcheck: 'false' }),
    EditorState.tabSize.of(s.tabSize || 4),
    s.foldGutter !== false ? foldGutter({ markerDOM: (open) => { const el = createSpan('cm-fold-marker' + (open ? ' is-open' : '')); el.setText(open ? '▾' : '▸'); return el; } }) : [],
    s.autoPair !== false ? closeBrackets() : [],
  ];
  const state = EditorState.create({
    doc,
    extensions: [
      historyComp.of(history()),
      readOnlyComp.of([]),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      rectangularSelection(),
      crosshairCursor(),
      indentOnInput(),
      bracketMatching(),
      highlightSelectionMatches(),
      search({ top: true, createPanel: createFindPanel }),
      markdown({ base: markdownLanguage, codeLanguages: languages, extensions: skMarkdownExtensions, addKeymap: false }),
      syntaxHighlighting(skHighlight),
      headingFold,
      editorLivePreviewField.init(() => livePreview),
      editorInfoField.init(() => info),
      infoComp.of(infoFacet.of(info)),
      livePreviewInline,
      livePreviewBlocks,
      lineClasses,
      linkClickHandler((target, evt) => openLink?.(target, evt)),
      sourceLinkHandler((target, evt) => openLink?.(target, evt)),
      autocompletion({ override: [pluginSuggestSource(getInfo), linkCompletionSource(getInfo), slashSource(getInfo)], icons: false, closeOnBlur: true, activateOnTyping: true }),
      placeholder(tr('editor.placeholder')),
      settingsComp.of(settingsExt(settings)),
      Prec.high(keymap.of([
        { key: 'Enter', run: continueList },
        { key: 'Tab', run: (v) => (isInList(v) ? indentMore(v) : false) },
        { key: 'Shift-Tab', run: (v) => (isInList(v) ? indentLess(v) : false) },
        ...extraKeys,
      ])),
      keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap.filter((k) => k.key !== 'Mod-f'), ...historyKeymap, ...foldKeymap, ...defaultKeymap, indentWithTab]),
      pluginComp.of(pluginExtensions),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChange?.(u);
        if (u.focusChanged && u.view.hasFocus) onFocus?.();
      }),
      EditorView.domEventHandlers({
        paste: (e, view) => info?.app?.handleEditorPaste?.(e, view, getInfo()),
        drop: (e, view) => info?.app?.handleEditorDrop?.(e, view, getInfo()),
      }),
    ],
  });
  const view = new EditorView({ state, parent });
  return {
    view,
    setLivePreview(v) { view.dispatch({ effects: setLivePreview.of(!!v) }); },
    setInfo(i) {
      currentInfo = i;
      view.dispatch({ effects: [infoComp.reconfigure(infoFacet.of(i)), setEditorInfo.of(i)] });
    },
    setPluginExtensions(exts) { view.dispatch({ effects: pluginComp.reconfigure(exts) }); },
    setSettings(s) { view.dispatch({ effects: settingsComp.reconfigure(settingsExt(s)) }); },
    refresh() { view.dispatch({ effects: refreshLP.of(null) }); },
    setReadOnly(ro) { view.dispatch({ effects: readOnlyComp.reconfigure(ro ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []) }); },
    /** Forget undo/redo (another file was loaded into this editor). */
    resetHistory() {
      view.dispatch({ effects: historyComp.reconfigure([]) });
      view.dispatch({ effects: historyComp.reconfigure(history()) });
    },
  };
}

function isInList(view) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  return /^\s*([-*+]|\d+[.)])\s/.test(line.text);
}

// ------------------------------------------------------------------- Editor API
export class Editor {
  constructor(cm, owner) {
    this.cm = cm;
    this.owner = owner;
  }

  get doc() { return this.cm.state.doc; }
  getDoc() { return this; }
  refresh() { this.cm.requestMeasure(); }
  getValue() { return this.cm.state.doc.toString(); }
  setValue(v) { this.cm.dispatch({ changes: { from: 0, to: this.cm.state.doc.length, insert: v } }); }
  getLine(n) { return n < 0 || n >= this.doc.lines ? '' : this.doc.line(n + 1).text; }
  setLine(n, text) { const l = this.doc.line(n + 1); this.cm.dispatch({ changes: { from: l.from, to: l.to, insert: text } }); }
  lineCount() { return this.doc.lines; }
  lastLine() { return this.doc.lines - 1; }

  posToOffset(pos) {
    const line = this.doc.line(Math.clamp(pos.line, 0, this.doc.lines - 1) + 1);
    return Math.min(line.from + Math.max(0, pos.ch), line.to);
  }

  offsetToPos(offset) {
    offset = Math.clamp(offset, 0, this.doc.length);
    const line = this.doc.lineAt(offset);
    return { line: line.number - 1, ch: offset - line.from };
  }

  getCursor(which = 'head') {
    const r = this.cm.state.selection.main;
    const off = which === 'from' ? r.from : which === 'to' ? r.to : which === 'anchor' ? r.anchor : r.head;
    return this.offsetToPos(off);
  }

  setCursor(pos, ch) {
    if (typeof pos === 'number') pos = { line: pos, ch: ch || 0 };
    const off = this.posToOffset(pos);
    this.cm.dispatch({ selection: { anchor: off }, scrollIntoView: true });
  }

  setSelection(anchor, head) {
    this.cm.dispatch({ selection: { anchor: this.posToOffset(anchor), head: this.posToOffset(head || anchor) }, scrollIntoView: true });
  }

  setSelections(ranges, main) {
    const sel = EditorSelection.create(ranges.map((r) => EditorSelection.range(this.posToOffset(r.anchor), this.posToOffset(r.head || r.anchor))), main || 0);
    this.cm.dispatch({ selection: sel });
  }

  listSelections() {
    return this.cm.state.selection.ranges.map((r) => ({ anchor: this.offsetToPos(r.anchor), head: this.offsetToPos(r.head) }));
  }

  somethingSelected() { return this.cm.state.selection.ranges.some((r) => !r.empty); }
  getSelection() { const r = this.cm.state.selection.main; return this.cm.state.sliceDoc(r.from, r.to); }
  getRange(from, to) { return this.cm.state.sliceDoc(this.posToOffset(from), this.posToOffset(to)); }

  replaceSelection(text, origin) {
    this.cm.dispatch(this.cm.state.replaceSelection(text), { userEvent: origin || 'input' });
  }

  replaceRange(text, from, to, origin) {
    const a = this.posToOffset(from);
    const b = to ? this.posToOffset(to) : a;
    this.cm.dispatch({ changes: { from: a, to: b, insert: text }, userEvent: origin || 'input' });
  }

  transaction(tx, origin) {
    const spec = { userEvent: origin || 'input' };
    if (tx.changes) spec.changes = tx.changes.map((c) => ({ from: this.posToOffset(c.from), to: c.to ? this.posToOffset(c.to) : this.posToOffset(c.from), insert: c.text }));
    if (tx.selection) spec.selection = { anchor: this.posToOffset(tx.selection.from), head: this.posToOffset(tx.selection.to || tx.selection.from) };
    if (tx.selections) spec.selection = EditorSelection.create(tx.selections.map((s) => EditorSelection.range(this.posToOffset(s.from), this.posToOffset(s.to || s.from))));
    this.cm.dispatch(spec);
  }

  wordAt(pos) {
    const w = this.cm.state.wordAt(this.posToOffset(pos));
    return w ? { from: this.offsetToPos(w.from), to: this.offsetToPos(w.to) } : null;
  }

  processLines(read, write, ignoreEmpty = false) {
    const changes = [];
    for (let n = 0; n < this.lineCount(); n++) {
      const text = this.getLine(n);
      if (ignoreEmpty && !text) continue;
      const r = read(n, text);
      const c = write(n, text, r);
      if (c) changes.push(c);
    }
    if (changes.length) this.transaction({ changes });
  }

  focus() { this.cm.focus(); }
  blur() { this.cm.contentDOM.blur(); }
  hasFocus() { return this.cm.hasFocus; }

  getScrollInfo() { const s = this.cm.scrollDOM; return { top: s.scrollTop, left: s.scrollLeft }; }
  scrollTo(x, y) { if (x !== null && x !== undefined) this.cm.scrollDOM.scrollLeft = x; if (y !== null && y !== undefined) this.cm.scrollDOM.scrollTop = y; }
  scrollIntoView(range, center) {
    const from = this.posToOffset(range.from);
    this.cm.dispatch({ effects: EditorView.scrollIntoView(from, { y: center ? 'center' : 'nearest' }) });
  }

  undo() { undo(this.cm); }
  redo() { redo(this.cm); }

  exec(command) {
    const map = {
      goUp: 'cursorLineUp', goDown: 'cursorLineDown', goLeft: 'cursorCharLeft', goRight: 'cursorCharRight',
      goStart: 'cursorDocStart', goEnd: 'cursorDocEnd', goWordLeft: 'cursorGroupLeft', goWordRight: 'cursorGroupRight',
    };
    if (command === 'selectAll') return selectAll(this.cm);
    if (command === 'indentMore') return indentMore(this.cm);
    if (command === 'indentLess') return indentLess(this.cm);
    if (command === 'newlineAndIndent') return this.replaceSelection('\n');
    if (command === 'undo') return this.undo();
    if (command === 'redo') return this.redo();
    if (command === 'swapLineUp') return commands.swapUp(this.cm);
    if (command === 'swapLineDown') return commands.swapDown(this.cm);
    if (command === 'deleteLine') return commands.deleteParagraph(this.cm);
    if (command === 'toggleFold') return foldCode(this.cm) || unfoldCode(this.cm); // the block at the cursor
    if (command === 'foldAll') return foldAll(this.cm);
    if (command === 'unfoldAll') return unfoldAll(this.cm);
    import('@codemirror/commands').then((m) => m[map[command]]?.(this.cm));
    return undefined;
  }

  openSearch() { openSearchPanel(this.cm); }
}

export { foldAll, unfoldAll, foldEffect, openSearchPanel, EditorView, EditorState, keymap };

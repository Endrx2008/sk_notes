// Home (desktop): what an empty tab shows, like the Home of the Android app, laid out for a
// wide window and for the keyboard.
//   Recent: the last notes opened, one compact row under the title
//   Create: a note (today's note is the calendar button of the same tile), a canvas, a note
//           from a template
//   View:   the graph, the file list, the database of the vault (a view, no file is made)
// Every tile is a command, so its shortcut is the one set in Settings → Hotkeys and is shown
// on the tile. On Home: arrows move between tiles, Enter opens, 1–9 open the n-th tile (not shown),
// typing a letter starts "go to file".

import { setIcon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { TemplateModal, applyTemplateVars } from '../features/core.js';
import { hotkeyToString } from '../model/keymap.js';
import { TFile } from '../model/vault.js';
import { VAULT_BASE } from './vault-base.js';

/** Choose a template, then make a new note with its text. */
export function newNoteFromTemplate(app) {
  new TemplateModal(app, async (template) => {
    try {
      const folder = app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path || '');
      const file = await app.fileManager.createNewMarkdownFile(folder);
      if (!file) return;
      await app.vault.modify(file, applyTemplateVars(app, await app.vault.read(template), file.basename));
      await app.workspace.getLeaf(false).openFile(file);
    } catch (e) { app.notice(String(e.message || e)); }
  }).open();
}

/** The tab in use (Home is shown there), or a new tab. */
function leafHere(app) {
  const ws = app.workspace;
  const leaf = ws.activeLeaf && ws.activeLeaf.getRoot() === ws.rootSplit ? ws.activeLeaf : ws.getMostRecentLeaf(ws.rootSplit);
  return leaf && !leaf.pinned ? leaf : ws.getLeaf('tab');
}

export async function openView(app, type) {
  const leaf = leafHere(app);
  if (leaf.view?.getViewType() !== type) await leaf.setViewState({ type, active: true });
  app.workspace.setActiveLeaf(leaf, { focus: true });
}

/** Go to Home: an empty tab there is, or a new one. */
export async function openHome(app) {
  const ws = app.workspace;
  let empty = null;
  ws.iterateLeaves(ws.rootSplit, (l) => { if (!empty && l.view?.getViewType() === 'empty') empty = l; });
  const leaf = empty || ws.getLeaf('tab');
  if (!empty) await leaf.setViewState({ type: 'empty' });
  ws.setActiveLeaf(leaf, { focus: true });
  leaf.view?.contentEl.querySelector('.pc-home-tile')?.focus();
}

// The logo in the colours of the theme in use: the scorpion takes the accent colour.
let logoSvg = null;
async function themedLogo(el) {
  try {
    if (logoSvg === null) {
      const text = await (await fetch('logo-home.svg')).text();
      logoSvg = text
        .replace(/<rect width="432" height="432"[^>]*\/>/, '').replace(/<rect x="6" y="6"[^>]*\/>/, '')
        .replace(/fill="#e05c00"/g, 'style="fill:var(--sk-accent)"')
        .replace(/fill="#9c3f00"/g, 'style="fill:var(--sk-accent);opacity:.7"')
        .replace(/ width="432" height="432"/, '').replace('viewBox="0 0 432 432"', 'viewBox="52 44 328 344"');
    }
    if (!/^<svg[\s>]/.test(logoSvg)) return;
    const doc = new DOMParser().parseFromString(logoSvg, 'image/svg+xml');
    const svg = doc.documentElement;
    if (svg.nodeName !== 'svg' || doc.querySelector('script, foreignObject')) return;
    el.empty();
    el.appendChild(document.importNode(svg, true));
  } catch { /* the plain picture stays */ }
}

const TILES = [
  // [row, command id, icon, label key, extra class, small button: [command id, icon, label key]]
  // the file list is not here: it is always open in the left sidebar
  ['create', 'file:new', 'file-plus', 'cmd.new-note', 'mod-cta', ['daily-notes', 'calendar-day', 'cmd.daily-note']],
  ['create', 'canvas:new-file', 'canvas', 'cmd.new-canvas'],
  ['template', 'file:new-from-template', 'template', 'pc.home.from-template', 'mod-slim'],
  ['template', 'reminders:open', 'alarm-clock', 'cmd.reminders', 'mod-slim'],
  ['view', 'graph:open-here', 'graph', 'pc.home.graph', 'mod-view'],
  ['view', 'bases:vault-view', 'database', 'pc.home.database', 'mod-view'],
];

export function renderHome(app, view) {
  const box = view.contentEl.createDiv('pc-home');
  const head = box.createDiv('pc-home-head');
  const logo = head.createDiv('pc-home-logo');
  logo.createEl('img', { attr: { src: 'logo-home.svg', alt: '' } });
  themedLogo(logo);
  const titles = head.createDiv('pc-home-titles');
  titles.createDiv({ cls: 'pc-home-name', text: 'sk_notes' });
  // the vault open now (its folder name), not a version
  const vaultName = app.vault.getName?.() || app.info?.vault?.name || '';
  if (vaultName) {
    const v = titles.createDiv({ cls: 'pc-home-vault', attr: { 'aria-label': t('pc.home.vault') } });
    setIcon(v.createSpan('pc-home-vault-icon'), 'vault');
    v.createSpan({ text: vaultName });
  }

  // recent notes: one row of chips, it takes little room
  const files = app.workspace.getLastOpenFiles().map((p) => app.vault.getAbstractFileByPath(p)).filter((f) => f instanceof TFile).slice(0, 8);
  if (files.length) {
    const recent = box.createDiv('pc-home-recent');
    recent.createSpan({ cls: 'pc-home-recent-title', text: t('pc.home.recent') });
    for (const f of files) {
      const chip = recent.createDiv({ cls: 'pc-home-recent-item', attr: { tabindex: '0', role: 'button', 'aria-label': f.path } });
      setIcon(chip.createSpan('pc-home-recent-icon'), f.extension === 'canvas' ? 'canvas' : f.extension === 'base' ? 'database' : 'file-text');
      chip.createSpan({ cls: 'pc-home-recent-name', text: f.basename });
      chip.addEventListener('click', () => app.workspace.getLeaf(false).openFile(f));
      chip.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); chip.click(); } });
    }
  }

  const left = box.createDiv('pc-home-main');
  const tiles = [];
  const section = (id, title) => {
    if (title) left.createDiv({ cls: 'pc-home-title', text: title });
    const grid = left.createDiv('pc-home-grid mod-' + id);
    for (const [sec, cmd, icon, label, cls, extra] of TILES) {
      if (sec !== id) continue;
      const tile = grid.createDiv({ cls: 'pc-home-tile' + (cls ? ' ' + cls : ''), attr: { role: 'button', tabindex: '0', 'data-command': cmd } });
      setIcon(tile.createDiv('pc-home-icon'), icon);
      const txt = tile.createDiv('pc-home-text');
      txt.createDiv({ cls: 'pc-home-label', text: t(label) });
      const hk = app.commands.hotkeysFor(cmd)[0];
      const keys = txt.createDiv('pc-home-keys');
      if (hk) keys.createEl('kbd', { text: hotkeyToString(hk) });
      tile.addEventListener('click', () => app.commands.executeCommandById(cmd));
      if (extra) {
        const [xcmd, xicon, xlabel] = extra;
        const xk = app.commands.hotkeysFor(xcmd)[0];
        const b = tile.createDiv({ cls: 'pc-home-extra clickable-icon', attr: { role: 'button', tabindex: '0', 'data-command': xcmd,
          'aria-label': t(xlabel) + (xk ? ` (${hotkeyToString(xk)})` : '') } });
        setIcon(b, xicon);
        b.addEventListener('click', (e) => { e.stopPropagation(); app.commands.executeCommandById(xcmd); });
        b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); b.click(); } });
      }
      tiles.push(tile);
    }
  };
  section('create', t('pc.home.create'));
  section('template', null); // a note from a template: smaller, under the two above
  section('view', t('pc.home.view'));

  // the main keys, in one line at the bottom
  const help = box.createDiv('pc-home-help');
  const line = (label, cmd) => {
    const hk = app.commands.hotkeysFor(cmd)[0];
    if (!hk) return;
    const r = help.createSpan('pc-home-help-row');
    r.createEl('kbd', { text: hotkeyToString(hk) });
    r.createSpan({ text: label });
  };
  line(t('pc.home.go-to-file'), 'switcher:open');
  line(t('pc.home.search'), 'global-search:open');
  line(t('pc.home.commands'), 'command-palette:open');
  line(t('pc.home.go-home'), 'home:open');
  const keysLink = help.createEl('a', { cls: 'pc-home-keys-link', text: t('pc.home.edit-keys'), href: '#' });
  keysLink.addEventListener('click', (e) => { e.preventDefault(); app.commands.executeCommandById('app:open-settings'); setTimeout(() => app.setting?.openTabById?.('hotkeys'), 50); });

  // keyboard: arrows between tiles, Enter, digits; a letter starts "go to file"
  box.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const i = tiles.indexOf(document.activeElement);
    const go = (j) => { e.preventDefault(); tiles[Math.max(0, Math.min(tiles.length - 1, j))]?.focus(); };
    // the nearest tile in the row above/below, by position on screen
    const vertical = (dir) => {
      if (i < 0) return go(0);
      const r = tiles[i].getBoundingClientRect();
      const cx = r.left + r.width / 2;
      let best = -1;
      let bestD = Infinity;
      tiles.forEach((tile, j) => {
        const q = tile.getBoundingClientRect();
        if (dir > 0 ? q.top < r.bottom - 1 : q.bottom > r.top + 1) return;
        const d = Math.abs(q.top - r.top) * 4 + Math.abs(q.left + q.width / 2 - cx);
        if (d < bestD) { bestD = d; best = j; }
      });
      if (best >= 0) go(best); else e.preventDefault();
    };
    if (e.key === 'ArrowRight') go(i < 0 ? 0 : i + 1);
    else if (e.key === 'ArrowLeft') go(i < 0 ? 0 : i - 1);
    else if (e.key === 'ArrowDown') vertical(1);
    else if (e.key === 'ArrowUp') vertical(-1);
    else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) { e.preventDefault(); tiles[i].click(); }
    else if (/^[1-9]$/.test(e.key) && tiles[Number(e.key) - 1]) { e.preventDefault(); tiles[Number(e.key) - 1].click(); }
    else if (/^\p{L}$/u.test(e.key) && !e.target.closest('input, textarea')) { e.preventDefault(); app.commands.executeCommandById('switcher:open'); }
  });
  setTimeout(() => { if (view.leaf === app.workspace.activeLeaf && !document.activeElement?.closest?.('input, textarea, .cm-editor, .modal')) tiles[0]?.focus(); }, 60);
}

/** Commands of Home (all configurable in Settings → Hotkeys) and their default keys. */
export function installHome(app) {
  app.renderHome = (view) => renderHome(app, view);
  app.homeTitle = t('pc.home.title');
  const cmd = (id, name, icon, callback) => app.commands.addCommand({ id, name, icon, callback });
  cmd('home:open', t('pc.home.go-home'), 'home', () => openHome(app));
  cmd('file:new-from-template', t('pc.home.from-template'), 'template', () => newNoteFromTemplate(app));
  cmd('graph:open-here', t('pc.home.graph'), 'graph', () => openView(app, 'graph'));
  cmd('bases:vault-view', t('pc.home.database'), 'database', () => openView(app, VAULT_BASE));
  // default keys of the operations of Home (only where the command has none of its own)
  const DEFAULTS = {
    'home:open': [{ modifiers: ['Mod', 'Shift'], key: 'H' }],
    'canvas:new-file': [{ modifiers: ['Mod'], key: 'C' }], // only when there is nothing to copy (see keyCheck below)
    'daily-notes': [{ modifiers: ['Mod', 'Shift'], key: 'D' }],
    'file:new-from-template': [{ modifiers: ['Mod', 'Alt'], key: 'N' }],
    'graph:open-here': [{ modifiers: ['Mod', 'Shift'], key: 'G' }],
    'file-explorer:open': [{ modifiers: ['Mod', 'Shift'], key: 'E' }],
    'bases:vault-view': [{ modifiers: ['Mod', 'Shift'], key: 'B' }],
    'sync:commit-and-push': [{ modifiers: ['Mod', 'Alt'], key: 'S' }],
    'templates:community': [],
  };
  const apply = () => {
    for (const [id, hk] of Object.entries(DEFAULTS)) {
      const c = app.commands.commands[id];
      if (c && !(c.hotkeys && c.hotkeys.length) && hk.length) c.hotkeys = hk;
    }
    // Ctrl+C makes a canvas only when it would copy nothing: text chosen anywhere, the cursor in
    // an editor or a field, or a canvas (which copies its cards) keep Ctrl+C as "copy"
    const canvas = app.commands.commands['canvas:new-file'];
    if (canvas && !canvas.keyCheck) {
      canvas.keyCheck = (evt) => {
        const plainCopy = (evt.ctrlKey || evt.metaKey) && !evt.shiftKey && !evt.altKey && evt.key.toLowerCase() === 'c';
        if (!plainCopy) return true;
        if (String(window.getSelection?.() || '').length) return false;
        if (document.activeElement?.closest?.('input, textarea, select, [contenteditable="true"], .cm-editor')) return false;
        const front = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
        return front?.view?.getViewType() !== 'canvas';
      };
    }
  };
  apply();
  // Home is drawn again when the app is ready and whenever it is shown, so its tiles show the
  // keys as they are now (the defaults above, or what the user set in Settings → Hotkeys)
  const redraw = (leaf) => {
    const v = leaf?.view;
    if (v?.getViewType() !== 'empty' || !v.contentEl.querySelector('.pc-home')) return;
    v.contentEl.empty();
    renderHome(app, v);
  };
  app.on('ready', () => {
    apply();
    app.workspace.iterateLeaves(app.workspace.rootSplit, redraw);
    app.workspace.on('active-leaf-change', redraw);
  });
  // the file list, opened from the keyboard, takes the keyboard too (arrows move in it, Enter opens)
  app.on('ready', () => {
    const c = app.commands.commands['file-explorer:open'];
    if (!c || c._pcFocus) return;
    const open = c.callback;
    c._pcFocus = true;
    c.callback = async (...args) => {
      await open?.(...args);
      const list = document.querySelector('.workspace-leaf-content[data-type="file-explorer"] .nav-files-container');
      if (!list) return;
      list.focus();
      (list.querySelector('.tree-item-self.is-active') || list.querySelector('.tree-item-self'))?.scrollIntoView({ block: 'nearest' });
    };
  });
}

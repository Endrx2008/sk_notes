// sk_notes for Android – the workspace on a phone or tablet.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The workspace itself is the desktop one. This module changes how it is used with
// fingers: sidebars become drawers, a navigation bar sits at the bottom, a toolbar
// appears above the keyboard, menus and dialogs become sheets, and Android's back button
// closes whatever is on top.

import { call, onBackend } from './api.js';
import { installBack } from './back.js';
import { installColorWheel } from './color-wheel.js';
import { isPhone } from './device.js';
import { installDrawers } from './drawers.js';
import { installFolderPicker } from './folder-picker.js';
import { installTemplateGallery, installThemeBrowser } from './gallery.js';
import { BASE_VIEWS, newNoteFromTemplate, openBase, renderHome } from './home.js';
import { installMultiSelect } from './multiselect.js';
import { installNavbar } from './navbar.js';
import { renderPdf } from './pdf.js';
import { installPluginBrowser } from './plugin-browser.js';
import { installSheets } from './sheets.js';
import { installSkaiSettings } from './skai-settings.js';
import { installSync } from './sync.js';
import { installToolbar } from './toolbar.js';
import { installTouch } from './touch.js';
import { installVersions } from './versions.js';
import { t } from '@desktop/core/i18n.js';
import { installCryptUi } from './crypt-ui.js';
import { installSpell } from './spell/index.js';
import { checkUpdate } from './update.js';
import { installForeign } from './foreign.js';
import { themeLooks } from './appearance.js';
import { CommandPalette } from '@desktop/ui/palette.js';
import { TFile, TFolder } from '@desktop/model/vault.js';

export function installMobile(app, info) {
  const ws = app.workspace;
  installFolderPicker(app);
  installSheets(app);
  installColorWheel(app);
  installTouch(app);
  installSkaiSettings(app);
  installPluginBrowser(app);
  installTemplateGallery(app);
  installThemeBrowser(app);
  installVersions(app);
  installSync(app);
  installMultiSelect(app);

  // The CSS of the chosen theme and of the enabled snippets (.sk_notes/themes, .sk_notes/snippets).
  // Themes that come with the app are read from its own files.
  const BUILT_IN = ['Anna.g_3'];
  let cssRun = 0;
  app.loadCss = async () => {
    const run = ++cssRun;
    const parts = [];
    const theme = app.settings.get('cssTheme') || '';
    if (theme) {
      // a theme that comes with the app is read from the app (it changes with its updates)
      let css = BUILT_IN.includes(theme) ? await fetch(`themes/${encodeURIComponent(theme)}/theme.css`).then((r) => (r.ok ? r.text() : null)).catch(() => null) : null;
      if (typeof css !== 'string') css = await call('config.read', { name: `themes/${theme}/theme.css` }).catch(() => null);
      if (typeof css === 'string') parts.push(css);
      app.themeLooks = typeof css === 'string' ? themeLooks(css) : { dark: true, light: true }; // one look or both (Appearance offers the base theme only for both)
    } else app.themeLooks = { dark: true, light: true };
    for (const name of app.settings.get('enabledCssSnippets') || []) {
      const css = await call('config.read', { name: `snippets/${name}` }).catch(() => null);
      if (typeof css === 'string') parts.push(css);
    }
    if (run !== cssRun) return;
    let el = document.getElementById('sk-theme-css');
    if (!el) { el = document.createElement('style'); el.id = 'sk-theme-css'; document.head.appendChild(el); }
    el.textContent = parts.join('\n');
    document.body.classList.toggle('has-css-theme', !!theme && parts.length > 0); // see "themes" in 90-mobile.css
    app.workspace?.trigger('css-change');
  };
  let cssBusy = false;
  const firstCss = () => { if (!cssBusy) { cssBusy = true; app.loadCss().finally(() => { cssBusy = false; }); } };
  firstCss();

  // an empty tab is Home: what to make, and how to look at the vault (graph or file list)
  app.renderHome = (view) => renderHome(app, view);
  app.homeTitle = t('mobile.home.title');
  // graph and file list are base views: they give way to the file opened from them and
  // come back with "back" (see home.js)
  app.baseViews = true;
  const markBase = () => ws.iterateLeaves(ws.rootSplit, (l) => { if (l.view && BASE_VIEWS.includes(l.view.getViewType())) l.view.navigation = true; });
  ws.on('layout-change', markBase);

  // The clipboard goes through Android: the page's own access to it is refused in a WebView
  // (reading always, writing whenever the page is not focused), which left "copy" and "paste"
  // of the menus doing nothing. Reading still needs the user's tap, like in a browser.
  if (navigator.clipboard) {
    navigator.clipboard.writeText = (text) => call('clipboard.write', { text: String(text ?? '') }).then(() => undefined);
    navigator.clipboard.readText = () => (navigator.userActivation && !navigator.userActivation.isActive
      ? Promise.reject(new DOMException('Clipboard read needs a tap', 'NotAllowedError')) : call('clipboard.read').then((s) => String(s ?? '')));
  }
  // A long press on text selects it and shows Android's own bar (cut, copy, paste, select all)
  // at the selection. The editor's menu of a PC would cover the whole note instead.
  document.addEventListener('contextmenu', (e) => {
    if (!e.isTrusted) return;
    const el = e.target?.closest ? e.target : e.target?.parentElement;
    if (!el?.closest) return;
    const inEditor = el.closest('.cm-content');
    const inText = el.closest('.markdown-reading-view, .markdown-rendered') && !el.closest('a, img, .internal-embed, button, .clickable-icon');
    if (inEditor || inText || el.closest('input, textarea')) e.stopPropagation();
  }, true);
  // side-by-side notes need the width of a tablet
  app.noSplits = () => isPhone();

  // PDFs are drawn by the native side (the WebView has no PDF viewer)
  app.renderPdf = (container, file) => renderPdf(container, file);

  // a web page inside a canvas card: the address is one the user put on the board, so the
  // native side lets that site load in a frame (nothing else of the page may use the network)
  app.embedWeb = async (url) => {
    const address = String(url || '').trim().replace(/^http:\/\//i, 'https://');
    if (!/^https:\/\//i.test(address)) throw new Error(t('error.bad-url'));
    await call('web.allow', { url: address });
    return address;
  };

  /** Android's file chooser → copies in the vault. `folder` is where they go; without it,
   * the attachment folder of the note or board at `sourcePath`. Returns the new files. */
  app.importFromDevice = async ({ folder = null, sourcePath = '', mime = ['*/*'] } = {}) => {
    const picked = await call('system.pickFiles', { multiple: true, mime });
    if (!picked.length) return [];
    const dest = folder !== null ? folder : (await app.fileManager.getAvailablePathForAttachment('x', sourcePath)).replace(/\/?x$/, '');
    const added = await call('system.importFiles', { files: picked, folder: dest === '/' ? '' : dest });
    return added.map((path) => app.vault.getFileByPath(path)).filter(Boolean);
  };

  // encrypted vaults: Settings → General (lock, password, recovery code, encrypt / decrypt), wheel menu
  installCryptUi(app, info);

  // pictures made by a view (a board, the graph): a file of the vault, in the attachment folder
  app.saveImage = async (name, dataUrl, sourcePath = '') => {
    const bytes = Uint8Array.from(atob(String(dataUrl).split(',')[1] || ''), (ch) => ch.charCodeAt(0));
    if (!bytes.length) throw new Error(t('mobile.picture-empty'));
    const file = await app.saveAttachment(name, bytes.buffer, sourcePath);
    const note = app.notice(createFragment((f) => {
      f.createDiv({ text: t('mobile.picture-saved', { path: file.path }) });
      const row = f.createDiv('notice-buttons');
      row.createEl('button', { text: t('mobile.picture-open') }).addEventListener('click', () => { note.hide(); app.workspace.getLeaf(false).openFile(file); });
      row.createEl('button', { text: t('mobile.share') }).addEventListener('click', () => { note.hide(); call('system.share', { path: file.path, title: file.basename }).catch((e) => app.notice(String(e.code || e))); });
    }), 12000);
    return file;
  };

  // a phone shows one note at a time: "split" opens a tab instead
  const split = ws.createLeafBySplit.bind(ws);
  ws.createLeafBySplit = (leaf, direction, before) => (isPhone() ? ws.getLeaf('tab') : split(leaf, direction, before));
  // there is one window: "open in new window" opens a tab
  ws.openPopoutLeaf = () => ws.getLeaf('tab');
  ws.moveLeafToPopout = async (leaf) => leaf;

  // with several tab groups (a layout made on a tablet), a phone shows the one in use
  const markGroup = () => {
    const cur = ws.activeLeaf && ws.activeLeaf.getRoot() === ws.rootSplit ? ws.activeLeaf : ws.getMostRecentLeaf(ws.rootSplit);
    const groups = new Set();
    ws.iterateLeaves(ws.rootSplit, (l) => { if (l.parent) groups.add(l.parent); });
    for (const g of groups) g.containerEl.toggleClass('is-current-group', !cur || g === cur.parent);
  };
  ws.on('active-leaf-change', markGroup);
  ws.on('layout-change', markGroup);

  app.on('ready', () => {
    markGroup();
    installDrawers(app);
    installNavbar(app);
    installToolbar(app);
    installBack(app);
    installSpell(app);
    installForeign(app);
    setTimeout(() => checkUpdate(app), 1500); // after the start, never in its way
    tidyCommands(app);
    syncBars(app);
    // a link sk_notes was started with (from another app or a home-screen shortcut)
    call('app.takeUri').catch(() => {});
    if (info.startError) app.notice(t('vaults.open-failed', { error: info.startError.detail || info.startError.code }), 10000);
  });
  ws.on('css-change', () => syncBars(app));

  // text or files shared to sk_notes from another app
  onBackend('share', (d) => receiveShare(app, d).catch((e) => app.notice(String(e.message || e))));
  onBackend('open-uri', () => ws.leftSplit.collapsed || !isPhone() || ws.leftSplit.collapse());
}

/** Commands that make no sense on a phone leave the palette; a few get a phone meaning. */
// What typing "/" in a note offers: the things to put in a note that have no button in the
// bar above the keyboard. Everything else the app does has its own button or menu entry.
const SLASH = new Set(['editor:insert-callout', 'editor:insert-codeblock', 'editor:insert-horizontal-rule', 'editor:insert-embed', 'editor:insert-table',
  'editor:toggle-inline-math', 'editor:toggle-comments', 'editor:set-heading-0', 'editor:set-heading-1', 'editor:set-heading-2', 'editor:set-heading-3',
  'editor:set-heading-4', 'editor:set-heading-5', 'editor:set-heading-6', 'editor:clear-formatting', 'editor:add-property', 'insert-current-date',
  'insert-current-time', 'insert-template']);

/** A phone has no list of every command: the app's own are reached by its buttons and menus.
 * Only what community plugins add is listed, since nothing else could run it; with no such
 * command there is no list at all, and no entry or icon for it. */
function phoneCommands(app) {
  const cmds = app.commands;
  // chosen first, asked whether they apply second: asking every command would ask this list's own
  cmds.listCommands = () => cmds.allCommands().filter((c) => (c._plugin || SLASH.has(c.id)) && cmds.isAvailable(c));
  app.pluginCommands = () => cmds.allCommands().filter((c) => c._plugin && cmds.isAvailable(c));
  class PluginCommands extends CommandPalette {
    getSuggestions(query) { return super.getSuggestions(query).filter((s) => s.cmd._plugin); }
  }
  const name = cmds.commands?.['command-palette:open']?.name || t('mobile.menu.commands');
  cmds.removeCommand?.('command-palette:open');
  cmds.addCommand({ id: 'command-palette:open', name, checkCallback: (check) => {
    if (!app.pluginCommands().length) return false;
    if (!check) new PluginCommands(app).open();
    return true;
  } });
  const ribbon = app.workspace.leftRibbon;
  for (const it of ribbon.items.filter((x) => x.id === 'palette')) ribbon.removeItem(it.el);
}

function tidyCommands(app) {
  phoneCommands(app);
  const gone = ['workspace:move-to-new-window', 'workspace:open-in-new-window', 'window:toggle-fullscreen', 'app:toggle-ribbon', 'app:show-debug-info',
    'window:zoom-in', 'window:zoom-out', 'window:reset-zoom', 'open-with-default-app:show', 'publish:open'];
  for (const id of gone) app.commands.removeCommand?.(id);
  // no "random note" on Android: neither the command nor its entry in the menu
  app.commands.removeCommand?.('random-note');
  // no new database files on a phone (existing .base files still open)
  app.commands.removeCommand?.('bases:new-file');
  const ribbon = app.workspace.leftRibbon;
  for (const it of ribbon.items.filter((x) => x.id === 'random')) ribbon.removeItem(it.el);
  // splits only where there is room for them (tablets)
  for (const [id, direction] of [['workspace:split-vertical', 'vertical'], ['workspace:split-horizontal', 'horizontal']]) {
    const name = app.commands.commands?.[id]?.name;
    if (!name) continue;
    app.commands.removeCommand?.(id);
    app.commands.addCommand({ id, name, checkCallback: (check) => {
      const leaf = app.workspace.activeLeaf;
      if (isPhone() || !leaf) return false;
      if (!check) app.workspace.duplicateLeaf(leaf, direction);
      return true;
    } });
  }
  // the graph is a base view here: shown in the tab in use, not in a tab of its own
  const graphName = app.commands.commands?.['graph:open']?.name || t('mobile.home.graph');
  app.commands.removeCommand?.('graph:open');
  app.commands.addCommand({ id: 'graph:open', name: graphName, callback: () => openBase(app, 'graph') });
  app.commands.addCommand({ id: 'mobile:file-list', name: t('mobile.home.list'), callback: () => openBase(app, 'file-explorer') });
  markBaseViews(app);
  app.commands.addCommand({ id: 'mobile:new-from-template', name: t('mobile.home.template'), callback: () => newNoteFromTemplate(app) });
  app.commands.addCommand({ id: 'mobile:share-note', name: t('mobile.share-note'), checkCallback: (check) => {
    const f = app.workspace.getActiveFile();
    if (!(f instanceof TFile)) return false;
    if (!check) call('system.share', { path: f.path, title: f.basename }).catch((e) => app.notice(String(e.code || e)));
    return true;
  } });
  app.commands.addCommand({ id: 'mobile:rescan', name: t('mobile.rescan'), callback: async () => { await call('vault.rescan'); app.notice(t('mobile.rescan-done')); } });
  const importInto = async (folder) => {
    try {
      const files = await app.importFromDevice({ folder });
      if (files.length) app.notice(t('mobile.shared-files', { n: files.length }));
    } catch (e) { app.notice(String(e.message || e)); }
  };
  // photos, PDFs and other files of the device, copied into the folder shown in the file list
  app.commands.addCommand({ id: 'mobile:import-files', name: t('mobile.import-files'), callback: () => {
    const cur = app.workspace.getActiveFile();
    importInto(cur?.parent ? cur.parent.path : '');
  } });
  app.workspace.on('file-menu', (menu, file) => {
    // no new database files on a phone
    const base = menu.items.find((it) => it.titleEl?.textContent === t('file.new-base'));
    if (base) { menu.items.remove(base); base.dom.remove(); }
    if (file instanceof TFolder) {
      menu.addItem((i) => i.setTitle(t('mobile.import-here')).setIcon('upload').setSection('action').onClick(() => importInto(file.path)));
      return;
    }
    if (!(file instanceof TFile)) return;
    menu.addItem((i) => i.setTitle(t('mobile.share')).setIcon('share').setSection('system').onClick(() => call('system.share', { path: file.path, title: file.basename }).catch((e) => app.notice(String(e.code || e)))));
  });
}

function markBaseViews(app) {
  const ws = app.workspace;
  ws.iterateLeaves(ws.rootSplit, (l) => { if (l.view && BASE_VIEWS.includes(l.view.getViewType())) l.view.navigation = true; });
}

/** Android's status and navigation bars take the colour of the app. */
/** A CSS colour as #rrggbb ('' for one that is not opaque or not a colour). */
function hexColor(value) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = '#000001';
  c.fillStyle = String(value || '').trim();
  const v = c.fillStyle;
  return /^#[0-9a-f]{6}$/i.test(v) && v !== '#000001' ? v : '';
}

function syncBars(app) {
  const css = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const pick = (...names) => { for (const n of names) { const v = hexColor(body.getPropertyValue(n) || css.getPropertyValue(n)); if (v) return v; } return ''; };
  const color = pick('--sk-bg', '--background-primary') || '#0d0d0d';
  call('mobile.bars', { color, light: document.body.classList.contains('theme-light') }).catch(() => {});
  // the loading screen of the next start takes the same colours (web/splash.js)
  try {
    localStorage.setItem('skn-splash', JSON.stringify({ bg: color, accent: pick('--sk-accent', '--interactive-accent'), track: pick('--sk-border', '--background-modifier-border') }));
  } catch { /* no storage: the default loading screen */ }
}

async function receiveShare(app, d) {
  if (!d) return;
  const stamp = window.moment().format('YYYY-MM-DD HH.mm');
  if (Array.isArray(d.files) && d.files.length) {
    const added = await call('system.importFiles', { files: d.files, folder: (await app.fileManager.getAvailablePathForAttachment('x', '')).replace(/\/?x$/, '') });
    app.notice(t('mobile.shared-files', { n: added.length }));
    const active = app.workspace.activeEditor;
    if (active?.editor && active.file) {
      const links = added.map((p) => app.vault.getFileByPath(p)).filter(Boolean).map((f) => app.fileManager.generateMarkdownLink(f, active.file.path));
      if (links.length) active.editor.replaceSelection(links.join('\n'));
    }
    return;
  }
  const text = String(d.text || '').trim();
  if (!text) return;
  const title = String(d.title || '').trim();
  const file = await app.fileManager.createNewMarkdownFile(null, (title || `${t('mobile.shared-note')} ${stamp}`).replace(/[\\/:*?"<>|#^[\]]+/g, ' ').slice(0, 80), text + '\n');
  await app.workspace.getLeaf(false).openFile(file, { active: true });
}

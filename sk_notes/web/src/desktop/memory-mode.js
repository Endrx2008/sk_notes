// SKAI_ Memory on the PC: a window on SKAI's memory, not a place to take notes.
//
// Nobody takes notes in SKAI_ Memory, so what serves note taking is left out: no Home, no new
// notes, canvases, databases, templates or daily notes, no bookmarks, tags, outline, backlinks
// or properties, no panes side by side and no separate windows, no settings (the look of the
// interface is the same in every vault). What is there: the graph in the middle (the view it
// opens on), the files on the left, and SKAI on the right – asked in plain words to read or
// change the memory, she does it herself after the user confirmed each change (no sudo password,
// see skai/memory-chat.js). The settings wheel keeps Git (upload only) and the version history.
// The Android app has no such mode.

import { t } from '../core/i18n.js';
import { Menu } from '../ui/kit.js';

// No tabs: the middle shows ONE view. It opens on the graph; a note chosen in the file list, on
// the graph or through a link takes its place, and the "Graph" button of its header (or "back")
// brings the graph again. The saved layout is never trusted for the middle (older versions saved
// Home tabs and panes, which became extra graphs): it is rebuilt with the graph alone.
//
// What is hidden by the stylesheet (50-desktop.css, body.sk-memory-mode): the left ribbon (its
// only button would be the graph), the buttons that close the sidebars, the tab bars of the
// middle and of the two sidebars (files, SKAI), and the tab list arrow ("close all").

// commands that serve taking notes, panes, windows or the settings
const GONE = [
  'file:new', 'file:new-in-new-tab', 'workspace:new-tab', 'canvas:new-file', 'bases:new-file', 'bases:vault-view',
  'daily-notes', 'daily-notes:goto-prev', 'daily-notes:goto-next', 'insert-template', 'insert-current-date',
  'insert-current-time', 'zk-prefixer', 'note-composer:merge-file', 'note-composer:split-file', 'workspaces:save',
  'workspaces:load', 'workspace:split-vertical', 'workspace:split-horizontal', 'workspace:move-to-new-window',
  'home:open', 'graph:open-here', 'file:new-from-template', 'templates:community', 'themes:browse', 'plugins:browse',
  'bookmarks:open', 'bookmarks:bookmark-current-view', 'bookmarks:bookmark-all-tabs', 'tag-pane:open', 'outline:open',
  'backlink:open', 'outgoing-links:open', 'properties:open', 'graph:open-local', 'app:open-settings',
  'editor:add-property', 'command-palette:open', 'global-search:open',
  'app:toggle-left-sidebar', 'app:toggle-right-sidebar', 'app:toggle-ribbon',
  'workspace:close', 'workspace:close-others', 'workspace:undo-close-pane', 'workspace:next-tab',
  'workspace:previous-tab', 'workspace:goto-last-tab', 'workspace:toggle-pin',
];
// ribbon buttons kept: only the graph
const RIBBON_KEEP = new Set(['graph']);

export function installMemoryMode(app) {
  if (!app.info?.vault?.protected) return;
  app.memoryMode = true;
  document.body.addClass('sk-memory-mode');
  const ws = app.workspace;

  // the two sidebars stay open: the files and SKAI are the point of this vault
  for (const dock of [ws.leftSplit, ws.rightSplit]) {
    const set = dock.setCollapsed.bind(dock);
    dock.setCollapsed = () => set(false);
  }

  // ONE view in the middle: the layout is rebuilt with the graph alone, the sidebars with the
  // files (left) and SKAI (right)
  const GRAPH_ONLY = { type: 'split', direction: 'vertical', children: [{ type: 'tabs', children: [{ type: 'leaf', state: { type: 'graph', state: {} } }] }] };
  const side = (saved, type, width) => ({ type: 'split', direction: 'horizontal', width: saved?.width || width, children: [{ type: 'tabs', children: [{ type: 'leaf', state: { type } }] }] });
  const changeLayout = ws.changeLayout.bind(ws);
  ws.changeLayout = (layout) => changeLayout({ ...(layout || {}), main: GRAPH_ONLY, left: side(layout?.left, 'file-explorer', 280), right: side(layout?.right, 'skai', 320) });
  app._ensureSidebars = () => {};

  const rootLeaves = () => { const out = []; ws.iterateLeaves(ws.rootSplit, (l) => out.push(l)); return out; };
  const only = () => rootLeaves()[0] || null;
  // every way of opening something (a new tab, beside, a window) opens it in that one view
  const getLeaf = ws.getLeaf.bind(ws);
  ws.getLeaf = () => only() || getLeaf(false);
  ws.createLeafBySplit = () => only() || getLeaf(false);
  ws.openPopoutLeaf = () => only() || getLeaf(false);
  ws.moveLeafToPopout = async (leaf) => leaf;
  ws.duplicateLeaf = async (leaf) => leaf;
  app.noSplits = () => true;
  // and should a second one appear anyway, it goes
  let tidying = false;
  ws.on('layout-change', () => {
    if (tidying) return;
    setTimeout(async () => {
      const all = rootLeaves();
      if (all.length < 2) return;
      tidying = true;
      try {
        const keep = all.find((l) => l === ws.activeLeaf) || all[0];
        for (const l of all) if (l !== keep) await l.detach();
        ws.setActiveLeaf(keep, { focus: false });
      } finally { tidying = false; }
    }, 0);
  });

  // a note shown in the middle has a "Graph" button in its header: back to the graph
  const graphButton = () => {
    const v = only()?.view;
    if (!v || v.getViewType() === 'graph' || v._memGraphBtn || typeof v.addAction !== 'function') return;
    v._memGraphBtn = v.addAction('graph', t('graph.title'), () => only()?.setViewState({ type: 'graph', active: true }));
  };
  ws.on('layout-change', graphButton);
  ws.on('active-leaf-change', graphButton);
  ws.on('file-open', graphButton);

  // no Home: the empty view shows the graph
  app.homeTitle = t('graph.title');
  app.renderHome = (view) => {
    setTimeout(() => { if (view.leaf?.view === view) view.leaf.setViewState({ type: 'graph', active: true }); }, 0);
  };

  // the file list: no "new note" / "new folder"; file menus: nothing that makes files or windows
  ws.on('file-menu', (menu) => {
    for (const it of [...menu.items]) {
      if (['new', 'open'].includes(it.section) || it.titleEl?.textContent === t('file.open-window')) {
        menu.items.remove(it);
        it.dom?.remove();
      }
    }
  });

  // the settings wheel: Git (upload only), the version history of the note on screen (SKAI is always open on the right)
  app.settingsWheel = (el) => {
    const m = new Menu();
    const run = (id) => () => app.commands.executeCommandById(id);
    if (app.commands.commands['sync:open']) m.addItem((i) => i.setTitle(t('pc.memory.git')).setIcon('cloud').setSection('keep').onClick(run('sync:open')));
    const file = ws.getActiveFile();
    if (file && app.commands.commands['file:version-history']) m.addItem((i) => i.setTitle(t('cmd.version-history')).setIcon('history').setSection('keep').onClick(run('file:version-history')));
    if (app.commands.commands['file-recovery:open']) m.addItem((i) => i.setTitle(t('cmd.file-recovery')).setIcon('history').setSection('keep').onClick(run('file-recovery:open')));
    const r = el.getBoundingClientRect();
    m.showAtPosition({ x: r.right + 6, y: r.bottom });
  };

  const tidy = () => {
    for (const id of GONE) if (app.commands.commands[id]) app.commands.removeCommand(id);
    const ribbon = ws.leftRibbon;
    for (const it of [...ribbon.items]) if (!RIBBON_KEEP.has(it.id)) ribbon.removeItem(it.el);
    // the file list without "new note" and "new folder"
    for (const label of [t('explorer.new-note'), t('explorer.new-folder')]) {
      for (const b of document.querySelectorAll(`.nav-buttons-container .nav-action-button[aria-label="${CSS.escape(label)}"]`)) b.addClass('mod-memory-hidden');
    }
  };
  tidy();

  app.on('ready', async () => {
    tidy();
    if (ws.leftSplit.collapsed) ws.leftSplit.expand();
    if (ws.rightSplit.collapsed) ws.rightSplit.expand();
    const leaf = only();
    if (leaf) ws.setActiveLeaf(leaf, { focus: false });
    graphButton();
    tidy(); // commands added late by other parts
    ws.trigger('layout-change');
  });
}

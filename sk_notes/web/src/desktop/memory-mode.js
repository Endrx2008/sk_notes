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
];
// ribbon buttons kept: only the graph
const RIBBON_KEEP = new Set(['graph']);
// side views kept: the file list (left) and SKAI (right)
const SIDE_KEEP = new Set(['file-explorer', 'skai']);

export function installMemoryMode(app) {
  if (!app.info?.vault?.protected) return;
  app.memoryMode = true;
  document.body.addClass('sk-memory-mode');
  const ws = app.workspace;

  // no panes side by side, no windows
  app.noSplits = () => true;
  ws.openPopoutLeaf = () => ws.getLeaf('tab');
  ws.moveLeafToPopout = async (leaf) => leaf;

  // no Home: an empty tab shows the graph
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

  // the settings wheel: SKAI, Git (upload only), the version history of the note on screen
  app.settingsWheel = (el) => {
    const m = new Menu();
    const run = (id) => () => app.commands.executeCommandById(id);
    m.addItem((i) => i.setTitle(t('ribbon.skai')).setIcon('sparkles').setSection('do').onClick(run('skai:open')));
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
    // the sidebars: the files on the left, SKAI on the right, nothing else
    const leaves = [];
    ws.iterateAllLeaves((l) => { if (l.getRoot() !== ws.rootSplit) leaves.push(l); });
    for (const l of leaves) {
      const type = l.view?.getViewType?.() ?? l._pending?.type;
      if (!SIDE_KEEP.has(type)) await l.detach();
    }
    const files = await ws.ensureSideLeaf('file-explorer', 'left', { reveal: true });
    if (ws.leftSplit.collapsed) ws.leftSplit.expand();
    files.parent?.selectTab?.(files);
    await ws.ensureSideLeaf('skai', 'right', { reveal: true });
    if (ws.rightSplit.collapsed) ws.rightSplit.expand();
    // the graph is the view it opens on
    let graph = ws.getLeavesOfType('graph').find((l) => l.getRoot() === ws.rootSplit);
    if (!graph) {
      const front = ws.getMostRecentLeaf(ws.rootSplit);
      const empty = front && ['empty', undefined].includes(front.view?.getViewType?.());
      graph = empty ? front : ws.getLeaf('tab');
      await graph.setViewState({ type: 'graph', active: true });
    }
    ws.setActiveLeaf(graph, { focus: false });
    tidy(); // commands added late by other parts
    ws.trigger('layout-change');
  });
}

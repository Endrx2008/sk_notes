// Core features (built-in plugins): views, commands with default hotkeys, ribbon,
// daily notes, templates, unique notes, note composer, workspaces, page
// preview, file recovery, PDF export.

import { call } from '../core/api.js';
import { diffLines, diffStats, renderDiff } from '../core/diff.js';
import { setIcon } from '../core/icons.js';
import { t, tn, errorText } from '../core/i18n.js';
import { debounce } from '../core/util.js';
import { commands as fmt } from '../editor/editor.js';
import { Component } from '../model/component.js';
import { TFile, TFolder } from '../model/vault.js';
import { renderSections, postProcess } from '../render/markdown.js';
import { ButtonComponent, FuzzySuggestModal, Modal, confirmDialog, promptDialog } from '../ui/kit.js';
import { CommandPalette, QuickSwitcher } from '../ui/palette.js';
import { FileExplorerView } from '../views/explorer.js';
import { AudioView, ImageView, PdfView, UnknownFileView, VideoView } from '../views/files.js';
import { AllPropertiesView, BacklinkView, BookmarksView, Bookmarks, OutgoingLinkView, OutlineView, TagView } from '../views/panels.js';
import { SearchView } from '../views/search.js';
import { openSettings } from '../ui/settings.js';
import { installPropertiesEditor } from '../ui/properties.js';

const M = 'Mod';

export function registerCoreFeatures(app) {
  const reg = app.viewRegistry;
  reg.registerView('file-explorer', (l) => new FileExplorerView(l));
  reg.registerView('search', (l) => new SearchView(l));
  reg.registerView('bookmarks', (l) => new BookmarksView(l));
  reg.registerView('backlink', (l) => new BacklinkView(l));
  reg.registerView('outgoing-link', (l) => new OutgoingLinkView(l));
  reg.registerView('tag', (l) => new TagView(l));
  reg.registerView('outline', (l) => new OutlineView(l));
  reg.registerView('all-properties', (l) => new AllPropertiesView(l));
  reg.registerView('image', (l) => new ImageView(l));
  reg.registerView('audio', (l) => new AudioView(l));
  reg.registerView('video', (l) => new VideoView(l));
  reg.registerView('pdf', (l) => new PdfView(l));
  reg.registerView('unknown-file', (l) => new UnknownFileView(l));
  reg.registerExtensions(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif'], 'image');
  reg.registerExtensions(['mp3', 'wav', 'm4a', 'ogg', '3gp', 'flac', 'opus'], 'audio');
  reg.registerExtensions(['mp4', 'webm', 'ogv', 'mov', 'mkv'], 'video');
  reg.registerExtensions(['pdf'], 'pdf');
  // heavy views load on demand
  const lazy = (type, loader, exts) => {
    reg.registerView(type, (leaf) => {
      const holder = new LazyView(leaf, type, loader);
      return holder;
    });
    if (exts) reg.registerExtensions(exts, type);
  };
  lazy('graph', () => import('../views/graph.js').then((m) => m.GraphView));
  lazy('localgraph', () => import('../views/graph.js').then((m) => m.LocalGraphView));
  lazy('canvas', () => import('../views/canvas.js').then((m) => m.CanvasView), ['canvas']);
  lazy('bases', () => import('../views/bases.js').then((m) => m.BasesView), ['base']);
  lazy('skai', () => import('../skai/view.js').then((m) => m.SkaiView));
  lazy('file-recovery', () => import('./recovery.js').then((m) => m.RecoveryView));

  // bases code blocks and embeds: load the bases module on first use
  const loadBases = async () => { (await import('../views/bases.js')).installBaseEmbeds(app); };
  app.markdownProcessors.codeBlocks.set('base', async (src, el, ctx) => { await loadBases(); return app.markdownProcessors.codeBlocks.get('base')(src, el, ctx); });
  app.renderBaseEmbed = async (...a) => { await loadBases(); return app.renderBaseEmbed(...a); };

  app.bookmarks = new Bookmarks(app);
  app.bookmarks.load();
  installPropertiesEditor(app);
  app.pagePreview = new PagePreview(app);

  const ws = app.workspace;
  const cmd = (id, name, opts) => app.commands.addCommand({ id, name, ...opts });
  const editorCmd = (id, nameKey, run, hotkeys) => cmd(id, t(nameKey), { hotkeys, editorCallback: (editor) => run(editor.cm) });

  // ---------------------------------------------------------------- navigation
  cmd('command-palette:open', t('cmd.command-palette'), { hotkeys: [{ modifiers: [M], key: 'P' }], callback: () => new CommandPalette(app).open() });
  cmd('switcher:open', t('cmd.quick-switcher'), { hotkeys: [{ modifiers: [M], key: 'O' }], callback: () => new QuickSwitcher(app).open() });
  cmd('switcher:recent', t('cmd.recent-files'), { callback: () => new QuickSwitcher(app, { recentOnly: true }).open() });
  cmd('file:new', t('cmd.new-note'), { hotkeys: [{ modifiers: [M], key: 'N' }], callback: () => newNote(app, false) });
  cmd('file:new-in-new-tab', t('cmd.new-note-tab'), { hotkeys: [{ modifiers: [M, 'Shift'], key: 'N' }], callback: () => newNote(app, 'tab') });
  cmd('workspace:new-tab', t('cmd.new-tab'), { hotkeys: [{ modifiers: [M], key: 'T' }], callback: () => {
    const leaf = ws.getLeaf('tab');
    leaf.setViewState({ type: 'empty', active: true });
  } });
  cmd('workspace:close', t('cmd.close-tab'), { hotkeys: [{ modifiers: [M], key: 'W' }], checkCallback: (check) => {
    const leaf = ws.activeLeaf;
    if (!leaf || leaf.getRoot() !== ws.rootSplit) return false;
    if (!check) leaf.detach();
    return true;
  } });
  cmd('workspace:close-others', t('tab.close-others'), { callback: () => {
    const leaf = ws.activeLeaf;
    leaf?.parent?.children.filter((l) => l !== leaf && !l.pinned).forEach((l) => l.detach());
  } });
  cmd('workspace:undo-close-pane', t('cmd.reopen-tab'), { hotkeys: [{ modifiers: [M, 'Shift'], key: 'T' }], callback: () => ws.reopenClosed() });
  cmd('workspace:next-tab', t('cmd.next-tab'), { hotkeys: [{ modifiers: [M], key: 'Tab' }], callback: () => cycleTab(ws, 1) });
  cmd('workspace:previous-tab', t('cmd.previous-tab'), { hotkeys: [{ modifiers: [M, 'Shift'], key: 'Tab' }], callback: () => cycleTab(ws, -1) });
  for (let i = 1; i <= 8; i++) {
    cmd(`workspace:goto-tab-${i}`, t('cmd.goto-tab', { n: i }), { hotkeys: [{ modifiers: [M], key: String(i) }], callback: () => gotoTab(ws, i - 1) });
  }
  cmd('workspace:goto-last-tab', t('cmd.goto-last-tab'), { hotkeys: [{ modifiers: [M], key: '9' }], callback: () => gotoTab(ws, -1) });
  cmd('app:go-back', t('cmd.go-back'), { hotkeys: [{ modifiers: [M, 'Alt'], key: 'ArrowLeft' }], callback: () => ws.activeLeaf?.history.back() });
  cmd('app:go-forward', t('cmd.go-forward'), { hotkeys: [{ modifiers: [M, 'Alt'], key: 'ArrowRight' }], callback: () => ws.activeLeaf?.history.forward() });
  cmd('app:open-settings', t('cmd.settings'), { hotkeys: [{ modifiers: [M], key: ',' }], callback: () => openSettings(app) });
  cmd('app:toggle-left-sidebar', t('cmd.toggle-left'), { callback: () => ws.leftSplit.toggle() });
  cmd('app:toggle-right-sidebar', t('cmd.toggle-right'), { callback: () => ws.rightSplit.toggle() });
  cmd('app:toggle-ribbon', t('cmd.toggle-ribbon'), { callback: () => app.settings.set('showRibbon', app.settings.get('showRibbon') === false) });
  cmd('app:open-vault', t('cmd.open-vault'), { callback: () => openVaultManager(app) });
  cmd('app:toggle-theme', t('cmd.toggle-theme'), { callback: () => app.settings.set('theme', document.body.hasClass('theme-dark') ? 'light' : 'dark') });
  cmd('window:zoom-in', t('cmd.zoom-in'), { hotkeys: [{ modifiers: [M], key: '=' }, { modifiers: [M, 'Shift'], key: '=' }], callback: () => app.changeZoom(0.1) });
  cmd('window:zoom-out', t('cmd.zoom-out'), { hotkeys: [{ modifiers: [M], key: '-' }], callback: () => app.changeZoom(-0.1) });
  cmd('window:reset-zoom', t('cmd.reset-zoom'), { hotkeys: [{ modifiers: [M], key: '0' }], callback: () => app.changeZoom(1 - (app.info.zoom || 1)) });
  cmd('window:toggle-fullscreen', t('cmd.fullscreen'), { hotkeys: [{ modifiers: [], key: 'F11' }], callback: () => call('window.fullscreen') });
  cmd('workspace:split-vertical', t('tab.split-right'), { callback: () => ws.activeLeaf && ws.duplicateLeaf(ws.activeLeaf, 'vertical') });
  cmd('workspace:split-horizontal', t('tab.split-down'), { callback: () => ws.activeLeaf && ws.duplicateLeaf(ws.activeLeaf, 'horizontal') });
  cmd('workspace:toggle-pin', t('cmd.toggle-pin'), { callback: () => ws.activeLeaf?.togglePinned() });
  cmd('workspace:move-to-new-window', t('tab.new-window'), { callback: () => ws.activeLeaf && ws.moveLeafToPopout(ws.activeLeaf) });

  // ---------------------------------------------------------------- views
  const openSide = (type, side) => async () => {
    const leaf = await ws.ensureSideLeaf(type, side, { reveal: true });
    ws.setActiveLeaf(leaf, { focus: true });
  };
  cmd('file-explorer:open', t('cmd.show-files'), { callback: openSide('file-explorer', 'left') });
  cmd('file-explorer:reveal-active-file', t('cmd.reveal-file'), { checkCallback: (check) => {
    const f = ws.getActiveFile();
    if (!f) return false;
    if (!check) ws.ensureSideLeaf('file-explorer', 'left', { reveal: true }).then((l) => l.view.revealInFolder(f));
    return true;
  } });
  cmd('global-search:open', t('cmd.search'), { hotkeys: [{ modifiers: [M, 'Shift'], key: 'F' }], callback: async () => {
    const leaf = await ws.ensureSideLeaf('search', 'left', { reveal: true });
    const sel = ws.activeEditor?.editor?.getSelection?.();
    if (sel && !sel.includes('\n')) leaf.view.setQuery(sel);
    else leaf.view.focus();
  } });
  cmd('bookmarks:open', t('cmd.bookmarks'), { callback: openSide('bookmarks', 'left') });
  cmd('bookmarks:bookmark-current-view', t('cmd.bookmark-file'), { checkCallback: (check) => {
    const f = ws.getActiveFile();
    if (!f) return false;
    if (!check) { app.bookmarks.addFile(f); app.notice(t('bookmarks.added')); }
    return true;
  } });
  cmd('bookmarks:bookmark-all-tabs', t('cmd.bookmark-all-tabs'), { checkCallback: (check) => {
    const files = [];
    ws.iterateRootLeaves((l) => { const f = l.view?.file; if (f && !files.includes(f)) files.push(f); });
    if (!files.length) return false;
    if (!check) { for (const f of files) app.bookmarks.addFile(f); app.notice(t('bookmarks.added')); }
    return true;
  } });
  cmd('app:show-debug-info', t('cmd.debug-info'), { callback: () => showDebugInfo(app) });
  cmd('backlink:open', t('cmd.backlinks'), { callback: openSide('backlink', 'right') });
  cmd('outgoing-links:open', t('cmd.outgoing'), { callback: openSide('outgoing-link', 'right') });
  cmd('tag-pane:open', t('cmd.tags'), { callback: openSide('tag', 'right') });
  cmd('outline:open', t('cmd.outline'), { callback: openSide('outline', 'right') });
  cmd('properties:open', t('cmd.all-properties'), { callback: openSide('all-properties', 'right') });
  cmd('graph:open', t('cmd.graph'), { hotkeys: [{ modifiers: [M], key: 'G' }], callback: () => openSingleton(app, 'graph') });
  cmd('graph:open-local', t('cmd.local-graph'), { checkCallback: (check) => {
    if (!ws.getActiveFile()) return false;
    if (!check) app.openLinkedView(ws.activeLeaf, 'localgraph');
    return true;
  } });
  cmd('canvas:new-file', t('cmd.new-canvas'), { callback: () => newFileOfType(app, 'canvas', '{\n  "nodes": [],\n  "edges": []\n}') });
  cmd('bases:new-file', t('cmd.new-base'), { callback: () => newFileOfType(app, 'base', 'views:\n  - type: table\n    name: Table\n') });
  cmd('file-recovery:open', t('cmd.file-recovery'), { callback: () => openSingleton(app, 'file-recovery') });
  cmd('file:version-history', t('cmd.version-history'), { checkCallback: (check) => {
    const f = ws.getActiveFile();
    if (!f || !['md', 'canvas', 'base', 'txt'].includes(f.extension)) return false;
    if (!check) app.openVersionHistory(f);
    return true;
  } });
  app.openVersionHistory = (file) => new VersionHistoryModal(app, file).open();

  // ---------------------------------------------------------------- file actions
  const activeFileCmd = (id, nameKey, fn, hotkeys) => cmd(id, t(nameKey), { hotkeys, checkCallback: (check) => {
    const f = ws.getActiveFile();
    if (!f) return false;
    if (!check) fn(f);
    return true;
  } });
  activeFileCmd('workspace:edit-file-title', 'file.rename', (f) => {
    const v = ws.activeLeaf?.view;
    if (v?.inlineTitleEl?.isShown()) { v.inlineTitleEl.focus(); document.getSelection().selectAllChildren(v.inlineTitleEl); } else app.fileManager.promptForFileRename(f);
  }, [{ modifiers: [], key: 'F2' }]);
  activeFileCmd('app:delete-file', 'cmd.delete-file', (f) => app.fileManager.promptForDeletion(f));
  activeFileCmd('file-explorer:move-file', 'file.move', (f) => app.commands._moveFile(f));
  activeFileCmd('workspace:copy-path', 'file.copy-path', (f) => navigator.clipboard.writeText(f.path));
  activeFileCmd('workspace:open-in-new-window', 'file.open-window', (f) => ws.openFile(f, 'window'));
  activeFileCmd('workspace:export-pdf', 'cmd.export-pdf', (f) => exportPdf(app, f));
  activeFileCmd('open-with-default-app:open', 'file.open-default-app', (f) => call('system.openPath', { path: f.path }));
  activeFileCmd('open-with-default-app:show', 'file.show-in-system', (f) => call('system.showInFolder', { path: f.path }));
  cmd('editor:save-file', t('cmd.save'), { hotkeys: [{ modifiers: [M], key: 'S' }], callback: () => ws.activeLeaf?.view?.save?.() });
  cmd('markdown:toggle-preview', t('cmd.toggle-reading'), { hotkeys: [{ modifiers: [M], key: 'E' }], checkCallback: (check) => {
    const v = ws.activeLeaf?.view;
    if (v?.getViewType() !== 'markdown') return false;
    if (!check) { v.toggleMode(); v.focus(); }
    return true;
  } });
  cmd('editor:toggle-source', t('cmd.toggle-source'), { checkCallback: (check) => {
    const v = ws.activeLeaf?.view;
    if (v?.getViewType() !== 'markdown') return false;
    if (!check) v.setSourceMode(!v.sourceMode);
    return true;
  } });
  app.commands._moveFile = (file) => new FolderSuggestModal(app, async (folder) => {
    const target = (folder.path === '/' ? '' : folder.path + '/') + file.name;
    try { await app.fileManager.renameFile(file, target); } catch (e) { app.notice(t('notice.move-failed', { error: errorText(e) })); }
  }).open();
  app.commands._newFolderIn = async (folder) => {
    const v = app.workspace.getLeavesOfType('file-explorer')[0]?.view;
    if (v) v.newFolder(folder);
  };
  app.commands._newCanvasIn = (folder) => newFileOfType(app, 'canvas', '{\n  "nodes": [],\n  "edges": []\n}', folder);
  app.commands._newBaseIn = (folder) => newFileOfType(app, 'base', 'views:\n  - type: table\n    name: Table\n', folder);

  // ---------------------------------------------------------------- editor commands
  editorCmd('editor:toggle-bold', 'cmd.toggle-bold', fmt.bold, [{ modifiers: [M], key: 'B' }]);
  editorCmd('editor:toggle-italics', 'cmd.toggle-italics', fmt.italic, [{ modifiers: [M], key: 'I' }]);
  editorCmd('editor:toggle-strikethrough', 'cmd.toggle-strike', fmt.strike);
  editorCmd('editor:toggle-highlight', 'cmd.toggle-highlight', fmt.highlight);
  editorCmd('editor:toggle-code', 'cmd.toggle-code', fmt.code);
  editorCmd('editor:toggle-inline-math', 'cmd.toggle-math', fmt.math);
  editorCmd('editor:toggle-comments', 'cmd.toggle-comment', fmt.comment, [{ modifiers: [M], key: '/' }]);
  editorCmd('editor:insert-link', 'cmd.insert-link', fmt.link, [{ modifiers: [M], key: 'K' }]);
  editorCmd('editor:insert-wikilink', 'cmd.insert-wikilink', fmt.wikilink);
  editorCmd('editor:insert-embed', 'cmd.insert-embed', (v) => { v.dispatch(v.state.replaceSelection('![[]]')); v.dispatch({ selection: { anchor: v.state.selection.main.head - 2 } }); });
  editorCmd('editor:toggle-checklist-status', 'cmd.toggle-checklist', fmt.toggleChecklist, [{ modifiers: [M], key: 'L' }]);
  editorCmd('editor:toggle-bullet-list', 'cmd.toggle-bullet', fmt.toggleBullet);
  editorCmd('editor:toggle-numbered-list', 'cmd.toggle-numbered', fmt.toggleNumbered);
  editorCmd('editor:toggle-blockquote', 'cmd.toggle-quote', fmt.toggleQuote);
  for (let h = 0; h <= 6; h++) editorCmd(`editor:set-heading-${h}`, h ? 'cmd.heading' : 'cmd.no-heading', fmt.heading(h));
  for (let h = 1; h <= 6; h++) app.commands.findCommand(`editor:set-heading-${h}`).name = t('cmd.heading', { n: h });
  editorCmd('editor:delete-paragraph', 'cmd.delete-paragraph', fmt.deleteParagraph, [{ modifiers: [M], key: 'D' }]);
  editorCmd('editor:swap-line-up', 'cmd.swap-up', fmt.swapUp, [{ modifiers: ['Alt'], key: 'ArrowUp' }]);
  editorCmd('editor:swap-line-down', 'cmd.swap-down', fmt.swapDown, [{ modifiers: ['Alt'], key: 'ArrowDown' }]);
  editorCmd('editor:insert-codeblock', 'cmd.insert-codeblock', fmt.insertCodeBlock);
  editorCmd('editor:insert-callout', 'cmd.insert-callout', fmt.insertCallout);
  editorCmd('editor:insert-table', 'cmd.insert-table', fmt.insertTable);
  editorCmd('editor:insert-horizontal-rule', 'cmd.insert-hr', fmt.insertHr);
  editorCmd('editor:clear-formatting', 'cmd.clear-formatting', fmt.clearFormatting);
  cmd('editor:open-search', t('cmd.find'), { hotkeys: [{ modifiers: [M], key: 'F' }], checkCallback: (check) => {
    const v = ws.activeLeaf?.view;
    if (!v?.showSearch) return false;
    if (!check) v.showSearch(false);
    return true;
  } });
  cmd('editor:open-search-replace', t('cmd.replace'), { hotkeys: [{ modifiers: [M], key: 'H' }], checkCallback: (check) => {
    const v = ws.activeLeaf?.view;
    if (!v?.showSearch) return false;
    if (!check) v.showSearch(true);
    return true;
  } });
  cmd('editor:indent-list', t('cmd.indent'), { hotkeys: [{ modifiers: [M], key: ']' }], editorCallback: (e) => e.exec('indentMore') });
  cmd('editor:unindent-list', t('cmd.unindent'), { hotkeys: [{ modifiers: [M], key: '[' }], editorCallback: (e) => e.exec('indentLess') });
  cmd('editor:fold-all', t('cmd.fold-all'), { editorCallback: (e) => e.exec('foldAll') });
  cmd('editor:toggle-fold', t('cmd.toggle-fold'), { editorCallback: (e) => e.exec('toggleFold') });
  cmd('editor:unfold-all', t('cmd.unfold-all'), { editorCallback: (e) => e.exec('unfoldAll') });
  const linkCmd = (id, name, hotkeys, mode, toggleTask) => cmd(id, name, { hotkeys, editorCheckCallback: (check, editor, view) => {
    const link = linkAtCursor(editor);
    const line = editor.getLine(editor.getCursor().line);
    const task = toggleTask && /^\s*([-*+]|\d+[.)])\s+\[.\]/.test(line);
    if (!link && !task) return false;
    if (!check) {
      if (link) ws.openLinkText(link, view.file?.path || '', mode);
      else fmt.toggleChecklist(editor.cm);
    }
    return true;
  } });
  linkCmd('editor:follow-link', t('cmd.follow-link'), [{ modifiers: ['Alt'], key: 'Enter' }], false, false);
  linkCmd('editor:open-link-in-new-leaf', t('cmd.open-link-new-tab'), [{ modifiers: [M], key: 'Enter' }], 'tab', true);
  linkCmd('editor:open-link-in-new-split', t('cmd.open-link-new-split'), [], 'split', false);
  cmd('editor:add-cursor-above', t('cmd.cursor-above'), { hotkeys: [{ modifiers: [M, 'Alt'], key: 'ArrowUp' }], editorCallback: (e) => addCursor(e, -1) });
  cmd('editor:add-cursor-below', t('cmd.cursor-below'), { hotkeys: [{ modifiers: [M, 'Alt'], key: 'ArrowDown' }], editorCallback: (e) => addCursor(e, 1) });
  cmd('editor:add-property', t('cmd.add-property'), { checkCallback: (check) => {
    const f = ws.getActiveFile();
    if (!f || f.extension !== 'md') return false;
    if (!check) app.addPropertyPrompt?.(f);
    return true;
  } });

  // ---------------------------------------------------------------- daily notes, templates, unique
  cmd('daily-notes', t('cmd.daily-note'), { callback: () => openDailyNote(app, 0) });
  cmd('daily-notes:goto-prev', t('cmd.daily-prev'), { callback: () => openDailyNote(app, -1, true) });
  cmd('daily-notes:goto-next', t('cmd.daily-next'), { callback: () => openDailyNote(app, 1, true) });
  cmd('insert-template', t('cmd.insert-template'), { editorCallback: (editor, view) => new TemplateModal(app, (f) => insertTemplate(app, f, editor, view)).open() });
  cmd('insert-current-date', t('cmd.insert-date'), { editorCallback: (e) => e.replaceSelection(window.moment().format(app.settings.get('templateDateFormat') || 'YYYY-MM-DD')) });
  cmd('insert-current-time', t('cmd.insert-time'), { editorCallback: (e) => e.replaceSelection(window.moment().format(app.settings.get('templateTimeFormat') || 'HH:mm')) });
  cmd('zk-prefixer', t('cmd.unique-note'), { callback: async () => {
    const name = window.moment().format(app.settings.get('uniqueNotePrefix') || 'YYYYMMDDHHmm');
    const folder = app.vault.getFolderByPath(app.settings.get('uniqueNoteFolder') || '') || app.fileManager.getNewFileParent();
    const f = await app.fileManager.createNewMarkdownFile(folder, name);
    ws.openFile(f, false);
  } });
  cmd('note-composer:merge-file', t('cmd.merge-file'), { checkCallback: (check) => {
    const f = ws.getActiveFile();
    if (!f || f.extension !== 'md') return false;
    if (!check) new QuickSwitcher(app, { onChoose: (target) => mergeFiles(app, f, target) }).open();
    return true;
  } });
  cmd('note-composer:split-file', t('cmd.extract-selection'), { editorCheckCallback: (check, editor, view) => {
    if (!editor.somethingSelected()) return false;
    if (!check) extractSelection(app, editor, view);
    return true;
  } });

  // ---------------------------------------------------------------- workspaces (saved layouts)
  cmd('workspaces:save', t('cmd.workspace-save'), { callback: async () => {
    const name = await promptDialog(app, { title: t('workspaces.save') });
    if (!name) return;
    const data = (await app.config.read('workspaces.json').catch(() => null)) || { workspaces: {} };
    data.workspaces[name] = ws.getLayout();
    data.active = name;
    await app.config.write('workspaces.json', data);
    app.notice(t('workspaces.saved', { name }));
  } });
  cmd('workspaces:load', t('cmd.workspace-load'), { callback: async () => {
    const data = (await app.config.read('workspaces.json').catch(() => null)) || { workspaces: {} };
    const names = Object.keys(data.workspaces || {});
    if (!names.length) { app.notice(t('workspaces.none')); return; }
    new (class extends FuzzySuggestModal {
      getItems() { return names; }
      getItemText(n) { return n; }
      async onChooseItem(n) { await app.flush(); await ws.changeLayout(data.workspaces[n]); }
    })(app).open();
  } });

  // ---------------------------------------------------------------- ribbon
  const ribbon = ws.leftRibbon;
  ribbon.addRibbonItemButton('switcher', 'file-text', t('ribbon.switcher'), () => app.commands.executeCommandById('switcher:open'));
  ribbon.addRibbonItemButton('graph', 'graph', t('ribbon.graph'), () => app.commands.executeCommandById('graph:open'));
  ribbon.addRibbonItemButton('canvas', 'canvas', t('ribbon.canvas'), () => app.commands.executeCommandById('canvas:new-file'));
  ribbon.addRibbonItemButton('daily', 'calendar-day', t('ribbon.daily'), () => app.commands.executeCommandById('daily-notes'));
  ribbon.addRibbonItemButton('templates', 'template', t('ribbon.templates'), () => app.commands.executeCommandById('insert-template'));
  ribbon.addRibbonItemButton('palette', 'terminal', t('ribbon.palette'), () => app.commands.executeCommandById('command-palette:open'));
  ribbon.addRibbonItemButton('bases', 'database', t('ribbon.base'), () => app.commands.executeCommandById('bases:new-file'));
  ribbon.addRibbonItemButton('skai', 'sparkles', t('ribbon.skai'), () => app.commands.executeCommandById('skai:open'));
  // bottom of the ribbon: vault switcher, help, settings
  const vaultBtn = ribbon.settingsEl.createDiv({ cls: 'clickable-icon side-dock-ribbon-action mod-vault', attr: { 'aria-label': t('ribbon.vaults'), 'data-tooltip-position': 'right' } });
  setIcon(vaultBtn, 'vault');
  vaultBtn.addEventListener('click', () => openVaultManager(app));
  const helpBtn = ribbon.settingsEl.createDiv({ cls: 'clickable-icon side-dock-ribbon-action', attr: { 'aria-label': t('ribbon.help'), 'data-tooltip-position': 'right' } });
  setIcon(helpBtn, 'help');
  helpBtn.addEventListener('click', () => openHelp(app));
  const setBtn = ribbon.settingsEl.createDiv({ cls: 'clickable-icon side-dock-ribbon-action', attr: { 'aria-label': t('ribbon.settings'), 'data-tooltip-position': 'right' } });
  setIcon(setBtn, 'settings');
  // the desktop shows a small menu first (trash, SKAI, settings: app.settingsWheel)
  setBtn.addEventListener('click', () => (app.settingsWheel ? app.settingsWheel(setBtn) : openSettings(app)));
  installFileOnlyTabs(app);
  // vault name at the bottom of the left sidebar
  app.on('ready', () => {
    const name = ws.leftSplit.containerEl.createDiv('workspace-sidedock-vault-profile mod-keep');
    const sw = name.createDiv({ cls: 'workspace-drawer-vault-switcher clickable-icon', attr: { 'aria-label': t('ribbon.vaults') } });
    setIcon(sw.createSpan('workspace-drawer-vault-switcher-icon'), 'chevrons-up-down');
    sw.createSpan({ cls: 'workspace-drawer-vault-name', text: app.vault.getName() });
    sw.addEventListener('click', () => openVaultManager(app));
    const actions = name.createDiv('workspace-drawer-vault-actions');
    const h = actions.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': t('ribbon.help') } });
    setIcon(h, 'help');
    h.addEventListener('click', () => openHelp(app));
    const s = actions.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': t('ribbon.settings') } });
    setIcon(s, 'settings');
    s.addEventListener('click', () => (app.settingsWheel ? app.settingsWheel(s) : openSettings(app)));
  });
}

// ------------------------------------------------------------------- lazy view holder
class LazyView extends Component {
  constructor(leaf, type, loader) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this._type = type;
    this._loader = loader;
    this.containerEl = createDiv('workspace-leaf-content');
    this._real = null;
    this._pendingState = null;
  }
  async open(parentEl) {
    const Cls = await this._loader();
    // replaced while its code was loading (two opens of the same leaf at start): the newer view
    // owns the leaf, this one must not draw itself in it too (it was left there for good, a
    // second graph under the first)
    if (this._closed || (this.leaf.view && this.leaf.view !== this)) return;
    const real = new Cls(this.leaf);
    this._real = real;
    this.leaf.view = real;
    await real.open(parentEl);
    if (this._pendingState) await real.setState(this._pendingState, {});
  }
  async setState(st) { if (this._real) await this._real.setState(st, {}); else this._pendingState = st; }
  getViewType() { return this._type; }
  getState() { return this._pendingState || {}; }
  getEphemeralState() { return {}; }
  setEphemeralState() {}
  getDisplayText() { return ''; }
  getIcon() { return 'file'; }
  async close() { this._closed = true; this.unload(); }
  onResize() {}
}

// ------------------------------------------------------------------- helpers
async function newNote(app, newLeaf) {
  const f = await app.fileManager.createNewMarkdownFile(app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path || ''));
  const leaf = app.workspace.getLeaf(newLeaf);
  await leaf.openFile(f, { state: { mode: 'source' } });
  setTimeout(() => {
    const el = leaf.view?.inlineTitleEl;
    if (el && el.isShown()) { el.focus(); document.getSelection().selectAllChildren(el); } else leaf.view?.focus?.();
  }, 50);
}

async function newFileOfType(app, ext, content, folder) {
  folder = folder || app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path || '');
  const f = await app.fileManager.createNewFile(folder, t('file.untitled'), ext, content);
  if (f) app.workspace.openFile(f, false);
}

function cycleTab(ws, d) {
  const tabs = ws.activeLeaf?.parent;
  if (!tabs?.children?.length) return;
  const i = (tabs.children.indexOf(ws.activeLeaf) + d + tabs.children.length) % tabs.children.length;
  ws.setActiveLeaf(tabs.children[i], { focus: true });
}

function gotoTab(ws, i) {
  const tabs = ws.activeLeaf?.parent && ws.activeLeaf.getRoot() === ws.rootSplit ? ws.activeLeaf.parent : ws._firstTabs(ws.rootSplit);
  const leaf = i === -1 ? tabs?.children.last() : tabs?.children[i];
  if (leaf) ws.setActiveLeaf(leaf, { focus: true });
}

async function openSingleton(app, type) {
  const existing = app.workspace.getLeavesOfType(type)[0];
  if (existing) { app.workspace.setActiveLeaf(existing, { focus: true }); return; }
  const leaf = app.workspace.getLeaf('tab');
  await leaf.setViewState({ type, active: true });
}

function linkAtCursor(editor) {
  const pos = editor.getCursor();
  const line = editor.getLine(pos.line);
  const re = /!?\[\[([^\]]+)\]\]|\[[^\]]*\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(line))) {
    if (pos.ch >= m.index && pos.ch <= m.index + m[0].length) return m[1] ? m[1].split('|')[0] : decodeURIComponent(m[2]);
  }
  return null;
}

function addCursor(editor, dir) {
  const sels = editor.listSelections();
  const last = sels[sels.length - 1].head;
  const line = last.line + dir;
  if (line < 0 || line > editor.lastLine()) return;
  editor.setSelections([...sels, { anchor: { line, ch: Math.min(last.ch, editor.getLine(line).length) } }], sels.length);
}

async function openDailyNote(app, offset, relative) {
  const s = app.settings;
  const format = s.get('dailyNoteFormat') || 'YYYY-MM-DD';
  let date = window.moment();
  if (relative) {
    const cur = app.workspace.getActiveFile();
    const parsed = cur ? window.moment(cur.basename, format, true) : null;
    if (parsed?.isValid()) date = parsed;
    // jump to the nearest existing daily note in that direction
    const folder = s.get('dailyNoteFolder') || '';
    const notes = app.vault.getMarkdownFiles().filter((f) => (f.parent?.path === '/' ? '' : f.parent?.path) === folder)
      .map((f) => ({ f, d: window.moment(f.basename, format, true) })).filter((x) => x.d.isValid())
      .sort((a, b) => a.d - b.d);
    const target = offset < 0 ? notes.filter((x) => x.d.isBefore(date, 'day')).last() : notes.find((x) => x.d.isAfter(date, 'day'));
    if (target) { app.workspace.openFile(target.f, false); return; }
    app.notice(t('daily.no-more'));
    return;
  }
  date = date.add(offset, 'day');
  const name = date.format(format);
  const folder = s.get('dailyNoteFolder') || '';
  const path = (folder ? folder + '/' : '') + name + '.md';
  let file = app.vault.getFileByPath(path);
  if (!file) {
    let content = '';
    const tpl = s.get('dailyNoteTemplate');
    if (tpl) {
      const tf = app.metadataCache.getFirstLinkpathDest(tpl, '');
      if (tf) content = applyTemplateVars(app, await app.vault.read(tf), name, date);
    }
    if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder).catch(() => {});
    await app.vault.create(path, content);
    file = app.vault.getFileByPath(path);
  }
  if (file) app.workspace.openFile(file, false);
}

/** Backlinks and outgoing links speak of the note on screen: with no note on screen (graph,
 * file list, Home) their tabs in the sidebars are hidden instead of saying "No file open". */
function installFileOnlyTabs(app) {
  const ws = app.workspace;
  const FILE_ONLY = new Set(['backlink', 'outgoing-link']);
  const update = () => {
    const front = ws.activeLeaf && ws.activeLeaf.getRoot() === ws.rootSplit ? ws.activeLeaf : ws.getMostRecentLeaf(ws.rootSplit);
    const hasFile = !!front?.view?.file;
    for (const type of FILE_ONLY) {
      for (const l of ws.getLeavesOfType(type)) {
        if (l.getRoot() === ws.rootSplit) continue;
        l.tabHeaderEl?.toggle(hasFile);
        const tabs = l.parent;
        if (!hasFile && tabs?.children?.[tabs.currentTab] === l) {
          const other = tabs.children.find((x) => !FILE_ONLY.has(x.view?.getViewType?.() ?? x._pending?.type));
          if (other) tabs.selectTab(other);
        }
      }
    }
  };
  const later = () => setTimeout(update, 0);
  app.on('ready', () => {
    update();
    ws.on('active-leaf-change', later);
    ws.on('layout-change', later);
    ws.on('file-open', later);
  });
}

export function applyTemplateVars(app, text, title, date = window.moment()) {
  const s = app.settings;
  return text
    .replace(/\{\{\s*title\s*\}\}/gi, title)
    .replace(/\{\{\s*date\s*(?::\s*([^}]+?))?\s*\}\}/gi, (m, f) => date.format(f || s.get('templateDateFormat') || 'YYYY-MM-DD'))
    .replace(/\{\{\s*time\s*(?::\s*([^}]+?))?\s*\}\}/gi, (m, f) => date.format(f || s.get('templateTimeFormat') || 'HH:mm'));
}

export class TemplateModal extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder(t('templates.choose'));
    this.emptyStateText = t('templates.none');
  }
  getItems() {
    const folder = this.app.settings.get('templatesFolder') || '';
    if (!folder) return [];
    return this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(folder.replace(/\/$/, '') + '/'));
  }
  getItemText(f) { return f.basename; }
  onChooseItem(f) { this.onChoose(f); }
}

async function insertTemplate(app, tf, editor, view) {
  const text = applyTemplateVars(app, await app.vault.read(tf), view.file?.basename || '');
  // template frontmatter merges into the note's frontmatter
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (m && view.file) {
    const { parseYaml } = await import('../model/filemanager.js');
    let data = {};
    try { data = parseYaml(m[1]) || {}; } catch { data = {}; }
    editor.replaceSelection(text.slice(m[0].length));
    await view.save();
    await app.fileManager.processFrontMatter(view.file, (fm) => {
      for (const [k, v] of Object.entries(data)) {
        if (Array.isArray(v) && Array.isArray(fm[k])) fm[k] = [...new Set([...fm[k], ...v])];
        else if (fm[k] === undefined) fm[k] = v;
      }
    });
  } else editor.replaceSelection(text);
}

class FolderSuggestModal extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder(t('file.move-placeholder'));
  }
  getItems() { return this.app.vault.getAllFolders(true); }
  getItemText(f) { return f.path === '/' ? '/' : f.path; }
  onChooseItem(f) { this.onChoose(f); }
}

async function mergeFiles(app, source, target) {
  if (source === target) return;
  const ok = await confirmDialog(app, { title: t('composer.merge-title'), message: t('composer.merge-message', { a: source.basename, b: target.basename }), confirm: t('composer.merge') });
  if (!ok) return;
  const text = await app.vault.read(source);
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  await app.vault.append(target, (/\n$/.test(await app.vault.read(target)) ? '\n' : '\n\n') + body);
  // links to the source now point to the target: rename onto a temp then let links update
  const tmp = source.path;
  await app.fileManager.trashFile(source);
  for (const f of app.vault.getMarkdownFiles()) {
    const un = app.metadataCache.unresolvedLinks[f.path] || {};
    const name = tmp.replace(/\.md$/, '').split('/').pop();
    if (Object.keys(un).some((k) => k === name || k === tmp.replace(/\.md$/, ''))) {
      await app.vault.process(f, (txt) => txt.replace(new RegExp(`\\[\\[(${escapeRe(name)}|${escapeRe(tmp.replace(/\.md$/, ''))})(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]`, 'g'),
        (m, p, sub, alias) => `[[${app.metadataCache.fileToLinktext(target, f.path)}${sub || ''}${alias || ''}]]`));
    }
  }
  app.workspace.openFile(target, false);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function extractSelection(app, editor, view) {
  const sel = editor.getSelection();
  const firstLine = sel.split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 60) || t('file.untitled');
  const name = await promptDialog(app, { title: t('composer.extract-title'), value: firstLine.replace(/[\\/:#^[\]|]/g, '') });
  if (!name) return;
  const f = await app.fileManager.createNewMarkdownFile(app.fileManager.getNewFileParent(view.file?.path), name, sel);
  editor.replaceSelection(`![[${app.metadataCache.fileToLinktext(f, view.file?.path || '')}]]`);
}

async function exportPdf(app, file) {
  if (file.extension !== 'md') { app.notice(t('export.only-md')); return; }
  const box = createDiv('markdown-rendered sk-print');
  box.createEl('h1', { text: file.basename });
  const text = await app.vault.read(file);
  const comp = new Component();
  comp.load();
  const secs = renderSections(app, text, box, file.path, comp);
  await postProcess(app, secs, file.path, comp, app.metadataCache.getFileCache(file)?.frontmatter, text);
  // inline images as data for the print page
  for (const img of box.findAll('img')) {
    const src = img.getAttr('src');
    if (src?.startsWith('skn://vault/')) {
      try {
        const blob = await (await fetch(src)).blob();
        img.setAttr('src', await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); }));
      } catch { /* keep */ }
    }
  }
  const css = Array.from(document.styleSheets).map((s) => { try { return Array.from(s.cssRules).map((r) => r.cssText).join('\n'); } catch { return ''; } }).join('\n');
  comp.unload();
  try {
    const out = await call('export.pdf', { html: box.outerHTML, css, name: file.basename });
    if (out) app.notice(t('export.done', { path: out }));
  } catch (e) { app.notice(t('export.failed', { error: errorText(e) })); }
}

export async function openVaultManager(app) {
  const { VaultManagerModal } = await import('../ui/vaults.js');
  new VaultManagerModal(app).open();
}

function openHelp(app) {
  app.openExternal('https://sourceforge.net/projects/skos/');
}

// ------------------------------------------------------------------- page preview
class PagePreview {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.timer = null;
    this.hide = this.hide.bind(this);
  }

  onHover(evt, targetEl, linktext, sourcePath, requireMod, isPath) {
    const needMod = requireMod && this.app.settings.get('pagePreviewRequireMod') !== false;
    if (needMod && !(evt.ctrlKey || evt.metaKey)) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.show(targetEl, linktext, sourcePath, isPath), 350);
    targetEl.addEventListener('mouseleave', () => { clearTimeout(this.timer); this._leaveTimer = setTimeout(this.hide, 300); }, { once: true });
  }

  async show(targetEl, linktext, sourcePath, isPath) {
    const { path } = (await import('../model/metadata.js')).parseLinktext(linktext);
    const file = isPath ? this.app.vault.getFileByPath(linktext) : this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
    if (!(file instanceof TFile) || file.extension !== 'md' || !targetEl.isConnected) return;
    this.hide();
    const el = document.body.createDiv('popover hover-popover');
    this.el = el;
    const content = el.createDiv('markdown-embed markdown-rendered');
    const span = content.createSpan({ cls: 'internal-embed', attr: { src: isPath ? file.path : linktext } });
    const comp = new Component();
    comp.load();
    this.comp = comp;
    const { renderEmbed } = await import('../render/markdown.js');
    await renderEmbed(this.app, span, sourcePath || file.path, comp, 1);
    const r = targetEl.getBoundingClientRect();
    const w = 460;
    let x = Math.clamp(r.left, 8, innerWidth - w - 8);
    let y = r.bottom + 6;
    if (y + 360 > innerHeight) y = Math.max(8, r.top - 366);
    Object.assign(el.style, { left: x + 'px', top: y + 'px', width: w + 'px' });
    el.addEventListener('mouseenter', () => clearTimeout(this._leaveTimer));
    el.addEventListener('mouseleave', () => { this._leaveTimer = setTimeout(this.hide, 300); });
    this.app.workspace.trigger('hover-link', { event: null, source: 'preview', hoverParent: null, targetEl, linktext, sourcePath });
  }

  hide() {
    this.el?.detach();
    this.el = null;
    this.comp?.unload();
  }
}

// ------------------------------------------------------------------- version history
class VersionHistoryModal extends Modal {
  constructor(app, file) {
    super(app);
    this.file = file;
    this.modalEl.addClass('mod-version-history');
  }

  async onOpen() {
    this.setTitle(t('history.title', { name: this.file.basename }));
    const wrap = this.contentEl.createDiv('version-history');
    const list = wrap.createDiv('version-history-list');
    const right = wrap.createDiv('version-history-detail');
    const snaps = await call('history.list', { path: this.file.path });
    if (!snaps.length) { list.createDiv({ cls: 'pane-empty', text: t('history.none') }); return; }
    const current = await this.app.vault.read(this.file);
    let mode = 'previous'; // 'previous': what this version changed (shows removed lines); 'current': distance from the file now
    let selected = null;
    const show = async (s, row) => {
      selected = [s, row];
      list.findAll('.is-active').forEach((x) => x.removeClass('is-active'));
      row.addClass('is-active');
      right.empty();
      const text = await call('history.read', { id: s.id });
      let base = current;
      if (mode === 'previous') {
        const older = snaps[snaps.indexOf(s) + 1]; // snaps are newest first
        base = older ? await call('history.read', { id: older.id }) : '';
      }
      const ops = mode === 'previous' ? diffLines(base, text) : diffLines(text, base);
      const st = diffStats(ops);
      const bar = right.createDiv('version-history-toolbar');
      const modeSel = bar.createEl('select', { cls: 'dropdown' });
      modeSel.createEl('option', { value: 'previous', text: t('history.mode-previous') });
      modeSel.createEl('option', { value: 'current', text: t('history.mode-current') });
      modeSel.value = mode;
      modeSel.addEventListener('change', () => { mode = modeSel.value; show(...selected); });
      bar.createSpan({ text: t(mode === 'previous' ? 'history.compare-previous' : 'history.compare', { added: st.added, removed: st.removed }) });
      new ButtonComponent(bar).setButtonText(t('history.restore')).setCta().onClick(async () => {
        const ok = await confirmDialog(this.app, { title: t('history.restore'), message: t('history.restore-confirm'), confirm: t('history.restore') });
        if (!ok) return;
        await call('history.restore', { path: this.file.path, id: s.id });
        this.close();
      });
      new ButtonComponent(bar).setButtonText(t('common.copy')).onClick(() => navigator.clipboard.writeText(text));
      renderDiff(right.createDiv('version-history-diff'), ops);
    };
    snaps.forEach((s, i) => {
      const row = list.createDiv('version-history-item is-clickable');
      row.createDiv({ cls: 'version-history-date', text: window.moment(s.ts).format('YYYY-MM-DD HH:mm:ss') });
      row.createDiv({ cls: 'version-history-reason', text: t(`history.reason.${s.reason}`) });
      row.addEventListener('click', () => show(s, row));
      if (i === 0) show(s, row);
    });
  }
}

export { tn, debounce, TFolder };

/** Version, environment and plugins, ready to paste into a bug report. */
function showDebugInfo(app) {
  const m = new Modal(app);
  m.titleEl.setText(t('cmd.debug-info'));
  const enabled = [...(app.plugins?.enabledPlugins || [])].map((id) => `${id} ${app.plugins.manifests?.[id]?.version || ''}`.trim());
  const text = [`sk_notes ${app.info.version}`, `language: ${app.info.language}`, `theme: ${app.info.theme}`,
    `user agent: ${navigator.userAgent}`, `restricted mode: ${app.plugins?.restricted ? 'on' : 'off'}`,
    `community plugins: ${enabled.length ? enabled.join(', ') : '-'}`,
    `files: ${app.vault.getFiles().length}, notes: ${app.vault.getMarkdownFiles().length}`].join('\n');
  m.contentEl.createEl('pre', { cls: 'sk-debug-info', text });
  new ButtonComponent(m.contentEl.createDiv('modal-button-container')).setButtonText(t('debug.copy')).setCta()
    .onClick(() => { navigator.clipboard.writeText(text).then(() => app.notice(t('debug.copied')), () => {}); });
  m.open();
}

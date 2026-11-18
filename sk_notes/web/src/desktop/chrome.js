// The frame around the notes (desktop): fewer buttons that do the same thing twice.
// - Left ribbon: SKAI lives in the right sidebar, not here. While only Home is on screen the
//   ribbon is hidden (Home shows it all); notes, canvases and the other pages show it as always.
// - Sidebar buttons: always outside the sidebar, at the edge of the notes area, so they move
//   with the sidebar as it opens and closes instead of jumping from one place to another.
// - "+" of the tabs, like the "+" of the Android app: a click shows two bubbles (note, canvas)
//   to click; or press, pull down and let go towards one of them. What is made opens in a new
//   tab of that pane. Escape, or a click elsewhere, closes the bubbles. (Home: Ctrl+T, Ctrl+Shift+H.)
// - Panes side by side, also while editing: "split right" in the header of every pane and in
//   the menu of a tab (the new pane shows Home, to choose what to open), Ctrl+Alt+D /
//   Ctrl+Alt+Shift+D, a tab or a file of the list dropped on an edge of a pane.
// - Closing the last note of a pane closes the pane (the others share its room, like tiling
//   windows) instead of leaving a Home behind; closing the very last one still shows Home.
// - Back/forward arrows of a tab show only when there is somewhere to go (styles in 50-desktop.css).

import { setIcon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { WorkspaceLeaf } from '../ui/workspace.js';

export function installChrome(app) {
  app.on('ready', () => {
    tidyRibbon(app);
    sidebarButtonsOutside(app);
    installTiling(app);
  });
  installNewBubbles(app);
}

function tidyRibbon(app) {
  const ws = app.workspace;
  const ribbon = ws.leftRibbon;
  for (const it of ribbon.items.filter((x) => x.id === 'skai')) ribbon.removeItem(it.el);
  // only Home on screen (every pane shows Home): no ribbon, Home has it all; a note or a
  // canvas on screen, also beside a Home, brings it back
  const update = () => {
    const panes = ws._allTabs().filter((x) => x.getRoot?.() === ws.rootSplit);
    const home = panes.length > 0 && panes.every((x) => {
      const v = x.children[x.currentTab]?.view;
      return v?.getViewType() === 'empty' && !!v.contentEl.querySelector('.pc-home');
    });
    if (document.body.hasClass('pc-home-front') === home) return;
    document.body.toggleClass('pc-home-front', home);
    ws.onLayoutResize?.(); // the notes area got wider or narrower
  };
  // after the change has been drawn (Home is drawn when its tab is shown)
  const later = () => requestAnimationFrame(() => setTimeout(update, 0));
  ws.on('layout-change', later);
  ws.on('active-leaf-change', later);
  ws.on('file-open', later);
  later();
}

function sidebarButtonsOutside(app) {
  const ws = app.workspace;
  ws._updateToggles = function updateToggles() {
    const first = this._firstTabs(this.rootSplit);
    const last = this._lastTabs(this.rootSplit);
    if (first) first.tabHeaderContainerEl.insertBefore(this.leftToggleEl, first.tabHeaderContainerEl.firstChild);
    if (last) last.tabHeaderContainerEl.appendChild(this.rightToggleEl);
    for (const tabs of this._allTabs()) tabs.containerEl.toggleClass('mod-top-left-space', tabs === first && this.leftSplit.collapsed);
  };
  ws._updateToggles();
}

/** A new tab in the pane of `tabsEl` (or the pane in front), shown and focused. */
async function newTabIn(app, tabsEl) {
  const ws = app.workspace;
  const tabs = ws._allTabs().find((x) => x.containerEl === tabsEl && x.getRoot?.() === ws.rootSplit)
    || ws.getMostRecentLeaf(ws.rootSplit)?.parent;
  if (!tabs) return;
  const leaf = new WorkspaceLeaf(ws);
  tabs.insertChild(-1, leaf);
  await leaf.setViewState({ type: 'empty' });
  ws.setActiveLeaf(leaf, { focus: true });
}

function installNewBubbles(app) {
  const START = 10; // px down before a press becomes a pull
  const CHOOSE = 28; // px down before letting go of a pull makes something
  let g = null; // { button, tabsEl, x, y, mode: 'press' | 'pull' | 'menu', layer, note, canvas }

  const bubble = (layer, kind, icon, label, x, y) => {
    const b = layer.createDiv({ cls: 'pc-new-bubble', attr: { role: 'button', 'data-kind': kind } });
    setIcon(b.createDiv('pc-new-bubble-icon'), icon);
    b.createDiv({ cls: 'pc-new-bubble-label', text: label });
    b.style.left = `${x}px`;
    b.style.top = `${y}px`;
    return b;
  };
  const show = (clickable) => {
    const r = g.button.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const top = r.bottom + 56;
    const side = cx + 190 > window.innerWidth ? -1 : 1; // no room on the right: canvas on the left
    g.layer = document.body.createDiv('pc-new-gesture' + (clickable ? ' is-clickable' : ''));
    g.note = { x: cx, y: top, el: bubble(g.layer, 'note', 'file-plus', t('cmd.new-note'), cx, top) };
    g.canvas = { x: cx + side * 104, y: top, el: bubble(g.layer, 'canvas', 'canvas', t('cmd.new-canvas'), cx + side * 104, top) };
  };
  const mark = (c) => {
    g.note.el.toggleClass('is-chosen', c === 'note');
    g.canvas.el.toggleClass('is-chosen', c === 'canvas');
  };
  const pulled = (x, y) => {
    if (y - g.y < CHOOSE) return null;
    const d = (b) => Math.hypot(x - b.x, y - b.y);
    return d(g.canvas) < d(g.note) ? 'canvas' : 'note';
  };
  const close = () => {
    g?.layer?.remove();
    document.body.removeClass('pc-new-pulling');
    g = null;
  };
  const make = async (kind, tabsEl) => {
    close();
    await newTabIn(app, tabsEl);
    app.commands.executeCommandById(kind === 'canvas' ? 'canvas:new-file' : 'file:new');
  };
  const plusAt = (target) => {
    const b = target.closest?.('.workspace-tab-header-new-tab .clickable-icon');
    return b && !b.closest('.mod-sidedock') ? b : null;
  };

  // the click of the "+" (by the user) shows the bubbles instead of opening an empty tab
  document.addEventListener('click', (e) => {
    if (e.isTrusted && plusAt(e.target)) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (g?.mode === 'menu') {
      const b = e.target.closest?.('.pc-new-bubble');
      e.stopPropagation();
      e.preventDefault();
      if (b) make(b.dataset.kind, g.tabsEl);
      else close(); // a click elsewhere (or on the "+" again) closes them
      return;
    }
    const button = plusAt(e.target);
    if (!button) return;
    g = { button, tabsEl: button.closest('.workspace-tabs'), x: e.clientX, y: e.clientY, mode: 'press' };
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!g || g.mode === 'menu') return;
    if (g.mode === 'press') {
      if (e.clientY - g.y < START) return;
      g.mode = 'pull';
      document.body.addClass('pc-new-pulling');
      show(false);
    }
    mark(pulled(e.clientX, e.clientY));
  }, true);

  document.addEventListener('mouseup', (e) => {
    if (!g || g.mode === 'menu') return;
    if (g.mode === 'press') { // a plain click: the bubbles stay, to be clicked
      g.mode = 'menu';
      show(true);
      return;
    }
    const kind = pulled(e.clientX, e.clientY);
    if (kind) make(kind, g.tabsEl); else close();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!g || g.mode === 'press') return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (g.mode !== 'menu') return;
    const cur = g.canvas.el.hasClass('is-chosen') ? 'canvas' : g.note.el.hasClass('is-chosen') ? 'note' : null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Tab') { e.preventDefault(); mark(cur === 'note' ? 'canvas' : 'note'); }
    else if (e.key === 'Enter' && cur) { e.preventDefault(); make(cur, g.tabsEl); }
    else if (e.key.toLowerCase() === 'n') { e.preventDefault(); make('note', g.tabsEl); }
    else if (e.key.toLowerCase() === 'c') { e.preventDefault(); make('canvas', g.tabsEl); }
  }, true);
}

function installTiling(app) {
  const ws = app.workspace;
  const isHome = (l) => (l._pending ? l._pending.type : (l.view?.getViewType() ?? 'empty')) === 'empty';
  const rootPanes = () => ws._allTabs().filter((x) => x.getRoot?.() === ws.rootSplit);

  // a new pane next to `leaf`, showing Home (the user chooses what goes there)
  const split = async (leaf, direction) => {
    const base = leaf && leaf.getRoot?.() === ws.rootSplit ? leaf : ws.getMostRecentLeaf(ws.rootSplit);
    if (!base) return null;
    const fresh = ws.createLeafBySplit(base, direction);
    await fresh.setViewState({ type: 'empty', active: true });
    ws.setActiveLeaf(fresh, { focus: true });
    return fresh;
  };
  const dup = ws.duplicateLeaf.bind(ws);
  ws.duplicateLeaf = (leaf, direction) => (direction === 'vertical' || direction === 'horizontal' ? split(leaf, direction) : dup(leaf, direction));
  const setCmd = (id, direction, hotkeys) => {
    const c = app.commands.commands[id];
    if (!c) return;
    c.callback = () => split(ws.getMostRecentLeaf(ws.rootSplit), direction);
    if (!(c.hotkeys && c.hotkeys.length)) c.hotkeys = hotkeys;
  };
  setCmd('workspace:split-vertical', 'vertical', [{ modifiers: ['Mod', 'Alt'], key: 'D' }]);
  setCmd('workspace:split-horizontal', 'horizontal', [{ modifiers: ['Mod', 'Alt', 'Shift'], key: 'D' }]);

  // "split right" in the header of every pane of the notes area
  const addButtons = () => ws.iterateLeaves(ws.rootSplit, (l) => {
    const v = l.view;
    if (!v || v._pcSplitBtn || typeof v.addAction !== 'function' || !v.actionsEl) return;
    v._pcSplitBtn = v.addAction('split-right', t('pc.split-right'), () => split(l, 'vertical'));
    v._pcSplitBtn.addClass('pc-split-button');
  });
  ws.on('layout-change', addButtons);
  addButtons();

  // closing the last note of a pane closes the pane, the others take its room
  const proto = WorkspaceLeaf.prototype;
  const detach = proto.detach;
  proto.detach = async function detachAndTile(...args) {
    const pane = this.parent;
    const inRoot = this.getRoot?.() === ws.rootSplit;
    const content = !isHome(this);
    await detach.apply(this, args);
    if (!inRoot || !content || !pane?.parent || !pane.children.length || rootPanes().length < 2) return;
    if (!pane.children.every(isHome)) return;
    for (const l of pane.children.slice()) await detach.call(l);
  };

  // a file of the list dropped on an edge of a pane opens there, beside (the middle of an
  // editor still takes it as a link)
  const paneAt = (target) => rootPanes().find((x) => x.tabsContainerEl.contains(target));
  document.addEventListener('dragover', (e) => {
    if (ws._draggedLeaf || !e.dataTransfer?.types?.includes('text/x-sk-path')) return;
    const pane = paneAt(e.target);
    if (!pane) return;
    ws._showDropOverlay(pane, e);
    if (!ws._dropZone || ws._dropZone === 'center') { ws._hideDropOverlay(); ws._pcFileDrop = null; return; }
    ws._pcFileDrop = pane;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  document.addEventListener('drop', async (e) => {
    const pane = ws._pcFileDrop;
    const zone = ws._dropZone;
    ws._pcFileDrop = null;
    if (!pane || ws._draggedLeaf || !zone || zone === 'center') return;
    e.preventDefault();
    e.stopPropagation();
    ws._hideDropOverlay();
    const file = app.vault.getAbstractFileByPath(e.dataTransfer.getData('text/x-sk-path'));
    if (!file || !file.extension) return;
    const base = pane.children[pane.currentTab];
    const leaf = ws.createLeafBySplit(base, zone === 'left' || zone === 'right' ? 'vertical' : 'horizontal', zone === 'left' || zone === 'top');
    await leaf.openFile(file);
    ws.setActiveLeaf(leaf, { focus: true });
  }, true);
  document.addEventListener('dragend', () => { ws._pcFileDrop = null; ws._hideDropOverlay(); }, true);
}

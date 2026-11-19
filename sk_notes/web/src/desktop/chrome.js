// The frame around the notes (desktop): fewer buttons that do the same thing twice.
// - Left ribbon: SKAI lives in the right sidebar, not here. While only Home is on screen the
//   ribbon is hidden (Home shows it all); notes, canvases and the other pages show it as always.
// - Sidebar buttons: always outside the sidebar, at the edge of the notes area, so they move
//   with the sidebar as it opens and closes instead of jumping from one place to another.
// - "+" of the tabs, like the "+" of the Android app: a click shows two bubbles (note, canvas)
//   to click; or press, pull down and let go towards one of them. What is made opens in a new
//   tab of that pane. Escape, or a click elsewhere, closes the bubbles. (Home: Ctrl+T, Ctrl+Shift+H.)
// - Panes side by side, also while editing: the "new pane on the right" button in the header of
//   every pane (and Ctrl+Alt+D) adds a pane at the right edge, all panes the same width; it opens
//   the last note used that is not on screen, or Home. "Split right/down" of the tab menu.
// - Panes are moved like windows inside the window, never pulled out of it: drag a tab (its
//   name and x) and let go on the half of a pane where it should go (left, right, top,
//   bottom), in its middle to become one of its tabs, on a tab bar to sit among those tabs.
//   Dragging the empty part of a tab bar moves the whole pane, all its tabs. Escape cancels.
// - A file of the list dropped on an edge of a pane opens there, beside.
// - Closing the last note of a pane closes the pane (the others share its room, like tiling
//   windows); panes left with only Home close too while a note is still open. When nothing is
//   open, one Home is shown, without a close button (closing it would just show it again).
// - Back/forward arrows of a tab show only when there is somewhere to go (styles in 50-desktop.css).

import { setIcon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { WorkspaceLeaf, WorkspaceSplit, WorkspaceTabs } from '../ui/workspace.js';

export function installChrome(app) {
  app.on('ready', () => {
    tidyRibbon(app);
    sidebarButtonsOutside(app);
    installTiling(app);
    installPaneMoves(app);
  });
  installNewBubbles(app);
}

const isHomeLeaf = (l) => (l._pending ? l._pending.type : (l.view?.getViewType() ?? 'empty')) === 'empty';

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
    const leaves = [];
    ws.iterateLeaves(ws.rootSplit, (l) => leaves.push(l));
    document.body.toggleClass('pc-lone-home', leaves.length === 1 && isHomeLeaf(leaves[0]));
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

/** A tab to make something in, in the pane of `tabsEl` (or the pane in front): its Home, or a new tab. */
async function newTabIn(app, tabsEl) {
  const ws = app.workspace;
  const tabs = ws._allTabs().find((x) => x.containerEl === tabsEl && x.getRoot?.() === ws.rootSplit)
    || ws.getMostRecentLeaf(ws.rootSplit)?.parent;
  if (!tabs) return;
  // the Home shown in that pane is used (no Home left behind a new tab)
  const cur = tabs.children[tabs.currentTab];
  if (cur && !cur.pinned && cur.view?.getViewType() === 'empty') { ws.setActiveLeaf(cur, { focus: true }); return; }
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

  // a new pane next to `leaf`, with the last note used that is not on screen already (Home
  // when there is none): two different notes side by side at once, and closing one leaves
  // the other, never a Home in its place
  const split = async (leaf, direction) => {
    const base = leaf && leaf.getRoot?.() === ws.rootSplit ? leaf : ws.getMostRecentLeaf(ws.rootSplit);
    if (!base) return null;
    const shown = new Set();
    for (const p of rootPanes()) { const f = p.children[p.currentTab]?.view?.file; if (f) shown.add(f.path); }
    const next = ws.getLastOpenFiles().map((p) => app.vault.getAbstractFileByPath(p)).find((f) => f?.extension && !shown.has(f.path));
    const fresh = ws.createLeafBySplit(base, direction);
    if (next) await fresh.openFile(next, { active: true });
    else await fresh.setViewState({ type: 'empty', active: true });
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
  app.commands.commands['workspace:split-vertical'].callback = () => addRight();
  setCmd('workspace:split-horizontal', 'horizontal', [{ modifiers: ['Mod', 'Alt', 'Shift'], key: 'D' }]);

  // a new pane at the right edge of the notes area; all panes side by side get the same width
  const addRight = async () => {
    const root = ws.rootSplit;
    const shown = new Set();
    for (const p of rootPanes()) { const f = p.children[p.currentTab]?.view?.file; if (f) shown.add(f.path); }
    const next = ws.getLastOpenFiles().map((p) => app.vault.getAbstractFileByPath(p)).find((f) => f?.extension && !shown.has(f.path));
    const tabs = new WorkspaceTabs(ws);
    const leaf = new WorkspaceLeaf(ws);
    tabs.insertChild(0, leaf);
    if (root.direction !== 'vertical') {
      if (root.children.length > 1) {
        // panes stacked one above the other: they become one column, the new pane goes beside it
        const column = new WorkspaceSplit(ws, 'horizontal');
        for (const c of root.children) { c.parent = column; column.children.push(c); c.containerEl?.detach(); }
        column.parent = root;
        root.children = [column];
        column._render();
      }
      root.direction = 'vertical';
      root._setDirClass();
    }
    for (const c of root.children) c.setDimension(100);
    tabs.setDimension(100);
    root.insertChild(-1, tabs);
    if (next) await leaf.openFile(next, { active: true });
    else await leaf.setViewState({ type: 'empty', active: true });
    ws.setActiveLeaf(leaf, { focus: true });
    ws._updateToggles();
    ws.trigger('layout-change');
    ws.requestSaveLayout();
  };

  // the "new pane on the right" button in the header of every pane of the notes area
  const addButtons = () => ws.iterateLeaves(ws.rootSplit, (l) => {
    const v = l.view;
    if (!v || v._pcSplitBtn || typeof v.addAction !== 'function' || !v.actionsEl) return;
    v._pcSplitBtn = v.addAction('split-right', t('pc.split-right'), () => addRight());
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
    if (!inRoot || !content) return;
    const panes = rootPanes();
    const homeOnly = panes.filter((p) => p.children.length && p.children.every(isHome));
    if (homeOnly.length === panes.length) {
      // nothing else is open: one Home is enough (the pane the closed note was in, if it is left)
      const keep = homeOnly.includes(pane) ? pane : homeOnly[0];
      for (const p of homeOnly) if (p !== keep) for (const l of p.children.slice()) await detach.call(l);
      return;
    }
    for (const p of homeOnly) for (const l of p.children.slice()) await detach.call(l);
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

/** Panes moved like windows inside the window, by dragging a tab or the empty part of a tab bar. */
export function installPaneMoves(app) {
  const ws = app.workspace;
  const MOVE = 6;
  let d = null; // { leaf | pane, x, y, active, ghost, target }
  const rootPanes = () => ws._allTabs().filter((x) => x.getRoot?.() === ws.rootSplit);
  const leafOf = (el) => { let found = null; ws.iterateLeaves(ws.rootSplit, (l) => { if (!found && l.tabHeaderEl === el) found = l; }); return found; };

  // the browser's own drag of a tab is not used in the notes area (it can pull a tab out)
  const noNativeDrag = () => ws.iterateLeaves(ws.rootSplit, (l) => l.tabHeaderEl?.setAttribute('draggable', 'false'));
  ws.on('layout-change', noNativeDrag);
  noNativeDrag();

  const clearMarks = () => {
    ws._hideDropOverlay();
    for (const el of document.querySelectorAll('.pc-tab-insert')) el.remove();
  };
  const end = () => {
    clearMarks();
    d?.ghost?.remove();
    document.body.removeClass('pc-pane-moving');
    d = null;
  };

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest?.('.workspace-tab-header-inner-close-button, .workspace-tab-header-new-tab, .workspace-tab-header-tab-list, .sidebar-toggle-button')) return;
    const header = e.target.closest?.('.mod-root .workspace-tab-header');
    const bar = !header && e.target.closest?.('.mod-root .workspace-tab-header-container');
    if (!header && !bar) return;
    if (header) {
      const leaf = leafOf(header);
      if (leaf) d = { leaf, x: e.clientX, y: e.clientY };
    } else {
      const pane = rootPanes().find((p) => p.tabHeaderContainerEl === bar);
      if (pane && pane.children.length) d = { pane, x: e.clientX, y: e.clientY };
    }
  }, true);

  const targetAt = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return null;
    const bar = el.closest('.mod-root .workspace-tab-header-container');
    if (bar && d.leaf) {
      const pane = rootPanes().find((p) => p.tabHeaderContainerEl === bar);
      if (!pane) return null;
      let index = pane.children.length;
      for (let i = 0; i < pane.children.length; i++) {
        const r = pane.children[i].tabHeaderEl.getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) { index = i; break; }
      }
      return { pane, zone: 'tabs', index };
    }
    const body = el.closest('.mod-root .workspace-tab-container');
    const pane = body && rootPanes().find((p) => p.tabsContainerEl === body);
    if (!pane) return null;
    ws._showDropOverlay(pane, e);
    return { pane, zone: ws._dropZone };
  };

  document.addEventListener('mousemove', (e) => {
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < MOVE) return;
      d.active = true;
      document.body.addClass('pc-pane-moving');
      const leaf = d.leaf || d.pane.children[d.pane.currentTab];
      d.ghost = document.body.createDiv('pc-pane-ghost');
      setIcon(d.ghost.createSpan('pc-pane-ghost-icon'), leaf.getIcon());
      d.ghost.createSpan({ text: d.leaf ? leaf.getDisplayText() : `${leaf.getDisplayText()}${d.pane.children.length > 1 ? ` +${d.pane.children.length - 1}` : ''}` });
    }
    e.preventDefault();
    d.ghost.style.left = `${e.clientX + 12}px`;
    d.ghost.style.top = `${e.clientY + 12}px`;
    clearMarks();
    d.target = targetAt(e);
    if (d.target?.zone === 'tabs') {
      const { pane, index } = d.target;
      const ref = pane.children[index]?.tabHeaderEl;
      const r = (ref || pane.tabsInnerEl).getBoundingClientRect();
      const mark = document.body.createDiv('pc-tab-insert');
      Object.assign(mark.style, { left: `${(ref ? r.left : r.right) - 1}px`, top: `${r.top + 4}px`, height: `${r.height - 8}px` });
    }
  }, true);

  document.addEventListener('mouseup', () => {
    if (!d) return;
    const was = d;
    const target = was.active ? was.target : null;
    if (was.active) {
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 300);
    }
    end();
    if (!target) return;
    const { pane, zone } = target;
    const leaves = was.leaf ? [was.leaf] : was.pane.children.slice();
    const from = leaves[0].parent;
    if (zone === 'tabs' || zone === 'center') {
      if (from === pane && zone === 'center') return; // its own middle: stays where it is
      let index = zone === 'tabs' ? target.index : pane.children.length;
      for (const l of leaves) {
        if (l.parent === pane && pane.children.indexOf(l) < index) index -= 1;
        ws._moveLeaf(l, pane, index);
        index += 1;
      }
    } else {
      if (from === pane && pane.children.length === leaves.length) return; // beside itself: nothing changes
      ws._splitWith(leaves[0], pane, zone);
      const fresh = leaves[0].parent;
      for (const l of leaves.slice(1)) ws._moveLeaf(l, fresh, fresh.children.length);
      ws.setActiveLeaf(leaves[0], { focus: true });
    }
    ws._updateToggles();
    ws.trigger('layout-change');
    ws.requestSaveLayout();
    ws.onLayoutResize?.();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (d?.active && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); }
  }, true);
}

// sk_notes for Android – the sidebars as drawers.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// On a phone or a tablet (both have the phone's layout, see device.js) the left and right
// sidebars slide over the note (one at a time) and close when a note is chosen, when the dimmed
// area is tapped, with a swipe, or with the back button.

import { isPhone } from './device.js';
import { WorkspaceLeaf } from '@desktop/ui/workspace.js';

const SWIPE_MIN = 56; // px travelled sideways to count as a swipe
const SWIPE_SLOPE = 0.6; // …and at most this much vertical movement per horizontal pixel
const EDGE = 28; // a swipe starting this close to a side opens that side's drawer from anywhere

// taps on these, inside a drawer, lead back to the note
const CLOSING = {
  'file-explorer': '.nav-file-title',
  search: '.search-result-file-match, .search-result-file-title',
  bookmarks: '.tree-item-self:not(.mod-collapsible)',
  outline: '.tree-item-self',
  backlink: '.search-result-file-match, .search-result-file-title',
  'outgoing-link': '.tree-item-self',
};

export function drawerOpen(app) {
  if (!isPhone()) return null;
  const ws = app.workspace;
  return !ws.leftSplit.collapsed ? ws.leftSplit : !ws.rightSplit.collapsed ? ws.rightSplit : null;
}

/** The file list fills the screen (the list view): the left sidebar would show the same list. */
function listOnScreen(ws) {
  const leaf = ws.activeLeaf && ws.activeLeaf.getRoot() === ws.rootSplit ? ws.activeLeaf : ws.getMostRecentLeaf(ws.rootSplit);
  return leaf?.view?.getViewType() === 'file-explorer';
}

export function installDrawers(app) {
  const ws = app.workspace;
  const docks = [ws.leftSplit, ws.rightSplit];
  const backdrop = ws.containerEl.createDiv('workspace-drawer-backdrop');
  backdrop.addEventListener('click', () => docks.forEach((d) => d.collapsed || d.collapse()));

  for (const dock of docks) {
    dock.containerEl.addClass('workspace-drawer', dock.side === 'left' ? 'mod-left' : 'mod-right');
    const set = dock.setCollapsed.bind(dock);
    dock.setCollapsed = (v) => {
      if (!v && isPhone()) {
        const other = dock === ws.leftSplit ? ws.rightSplit : ws.leftSplit;
        if (!other.collapsed) other.setCollapsed(true);
        document.activeElement?.blur?.(); // the keyboard goes away with the note
      }
      set(v);
    };
    dock.containerEl.addEventListener('click', (e) => {
      if (!isPhone() || dock.collapsed) return;
      const type = e.target.closest?.('.workspace-leaf-content')?.getAttribute('data-type');
      const sel = CLOSING[type];
      if (sel && e.target.closest(sel)) setTimeout(() => dock.collapsed || dock.collapse(), 0);
    });
  }

  // the note that takes the place of the drawer
  ws.on('active-leaf-change', (leaf) => {
    if (isPhone() && leaf && leaf.getRoot() === ws.rootSplit) docks.forEach((d) => d.collapsed || d.collapse());
    placeToggles();
  });

  // drawer buttons live in the header of the note on a phone (there is no tab bar)
  const desktopToggles = ws._updateToggles.bind(ws);
  const placeToggles = () => {
    // in the list view the left sidebar is not offered: its button goes, and on a tablet the
    // sidebar steps aside until the list is left
    const inList = listOnScreen(ws);
    if (!isPhone()) {
      desktopToggles();
      if (inList && !ws.leftSplit.collapsed) { ws._leftAsideForList = true; ws.leftSplit.setCollapsed(true); }
      else if (!inList && ws._leftAsideForList) { ws._leftAsideForList = false; if (ws.leftSplit.collapsed) ws.leftSplit.setCollapsed(false); }
      ws.leftToggleEl?.toggle(!inList);
      return;
    }
    ws.leftToggleEl?.toggle(!inList);
    const leaf = ws.activeLeaf && ws.activeLeaf.getRoot() === ws.rootSplit ? ws.activeLeaf : ws.getMostRecentLeaf(ws.rootSplit);
    const header = leaf?.view?.headerEl;
    if (!header) return;
    if (header.firstChild !== ws.leftToggleEl) header.insertBefore(ws.leftToggleEl, header.firstChild);
    if (header.lastChild !== ws.rightToggleEl) header.appendChild(ws.rightToggleEl);
  };
  ws._updateToggles = placeToggles;
  ws.on('layout-change', placeToggles);
  const open = WorkspaceLeaf.prototype.open;
  WorkspaceLeaf.prototype.open = async function openAndPlace(view) {
    const r = await open.call(this, view);
    placeToggles();
    return r;
  };

  const settle = () => {
    if (isPhone()) docks.forEach((d) => d.collapsed || d.setCollapsed(true));
    else if (ws.leftSplit.collapsed && !ws._tabletOpened) { ws._tabletOpened = true; ws.leftSplit.setCollapsed(false); }
    placeToggles();
    ws.onLayoutResize();
  };
  settle();
  window.addEventListener('skn-device-change', settle);

  // ---- swipes
  let start = null;
  const scrollsSideways = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 4) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
      if (n.matches?.('[data-type="canvas"], [data-type="graph"], [data-type="localgraph"], .canvas, canvas, input[type=range], .modal-container, .menu, .mobile-toolbar')) return true;
    }
    return false;
  };
  document.addEventListener('touchstart', (e) => {
    start = null;
    if (!isPhone() || e.touches.length !== 1) return;
    const t0 = e.touches[0];
    const edge = t0.clientX <= EDGE ? 'left' : t0.clientX >= innerWidth - EDGE ? 'right' : null;
    if (!edge && scrollsSideways(e.target)) return;
    if (document.querySelector('.modal-container, .menu')) return;
    start = { x: t0.clientX, y: t0.clientY, edge, time: Date.now(), selecting: !!String(document.getSelection() || '') };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => { if (e.touches.length !== 1) start = null; }, { passive: true });
  document.addEventListener('touchend', (e) => {
    const s = start;
    start = null;
    if (!s || !isPhone()) return;
    const t1 = e.changedTouches[0];
    const dx = t1.clientX - s.x;
    const dy = t1.clientY - s.y;
    if (Math.abs(dx) < SWIPE_MIN || Math.abs(dy) > Math.abs(dx) * SWIPE_SLOPE || Date.now() - s.time > 700) return;
    if (s.selecting || String(document.getSelection() || '')) return; // dragging a text selection is not a swipe
    const right = dx > 0;
    const opened = drawerOpen(app);
    if (opened) {
      if ((opened.side === 'left') !== right) opened.collapse();
      return;
    }
    if (right && listOnScreen(ws)) return; // the list view: the left sidebar would show the same list
    (right ? ws.leftSplit : ws.rightSplit).expand();
  }, { passive: true });
}

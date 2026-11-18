// The frame around the notes (desktop): fewer buttons that do the same thing twice.
// - Left ribbon: SKAI lives in the right sidebar, not here. While Home is the tab in front the
//   ribbon is hidden (Home shows it all); notes, canvases and the other pages show it as always.
// - Sidebar buttons: always outside the sidebar, at the edge of the notes area, so they move
//   with the sidebar as it opens and closes instead of jumping from one place to another.
// - "+" of the tabs: a click opens a new tab (Home), as always. Press and pull down: two
//   bubbles appear, like the "+" of the Android app; let go towards the canvas bubble for a new
//   canvas, anywhere else below for a new note. Both open in a new tab. Escape cancels.
// - Back/forward arrows of a tab show only when there is somewhere to go (styles in 50-desktop.css).

import { setIcon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { WorkspaceLeaf } from '../ui/workspace.js';

export function installChrome(app) {
  app.on('ready', () => {
    tidyRibbon(app);
    sidebarButtonsOutside(app);
  });
  installNewGesture(app);
}

function tidyRibbon(app) {
  const ws = app.workspace;
  const ribbon = ws.leftRibbon;
  for (const it of ribbon.items.filter((x) => x.id === 'skai')) ribbon.removeItem(it.el);
  // Home in front (the tab last used in the notes area): no ribbon, Home has it all
  const update = () => {
    const front = ws.getMostRecentLeaf(ws.rootSplit);
    const home = front?.view?.getViewType() === 'empty' && !!front.view.contentEl.querySelector('.pc-home');
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

function installNewGesture(app) {
  const START = 10; // px down before the bubbles show
  const CHOOSE = 28; // px down before letting go makes something
  let g = null;

  const bubble = (layer, icon, label, x, y) => {
    const b = layer.createDiv({ cls: 'pc-new-bubble' });
    setIcon(b.createDiv('pc-new-bubble-icon'), icon);
    b.createDiv({ cls: 'pc-new-bubble-label', text: label });
    b.style.left = `${x}px`;
    b.style.top = `${y}px`;
    return b;
  };

  const show = () => {
    const r = g.button.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const top = r.bottom + 56;
    const side = cx + 190 > window.innerWidth ? -1 : 1; // no room on the right: canvas on the left
    g.layer = document.body.createDiv('pc-new-gesture');
    g.note = { x: cx, y: top, el: bubble(g.layer, 'file-plus', t('cmd.new-note'), cx, top) };
    g.canvas = { x: cx + side * 104, y: top, el: bubble(g.layer, 'canvas', t('cmd.new-canvas'), cx + side * 104, top) };
    g.trail = g.layer.createDiv('pc-new-trail');
  };

  const choice = (x, y) => {
    if (y - g.y < CHOOSE) return null;
    const d = (b) => Math.hypot(x - b.x, y - b.y);
    return d(g.canvas) < d(g.note) ? 'canvas' : 'note';
  };

  const end = () => {
    g?.layer?.remove();
    document.body.removeClass('pc-new-pulling');
    g = null;
  };

  document.addEventListener('mousedown', (e) => {
    const button = e.button === 0 && e.target.closest?.('.workspace-tab-header-new-tab .clickable-icon');
    if (!button || button.closest('.mod-sidedock')) return;
    const tabsEl = button.closest('.workspace-tabs');
    g = { button, tabsEl, x: e.clientX, y: e.clientY, active: false };
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!g || g.cancelled) return;
    if (!g.active) {
      if (e.clientY - g.y < START) return;
      g.active = true;
      document.body.addClass('pc-new-pulling');
      show();
    }
    const c = choice(e.clientX, e.clientY);
    g.note.el.toggleClass('is-chosen', c === 'note');
    g.canvas.el.toggleClass('is-chosen', c === 'canvas');
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    g.trail.style.left = `${g.x}px`;
    g.trail.style.top = `${g.y}px`;
    g.trail.style.width = `${Math.hypot(dx, dy)}px`;
    g.trail.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
  }, true);

  document.addEventListener('mouseup', async (e) => {
    if (!g) return;
    const was = g;
    if (!was.active && !was.cancelled) { g = null; return; } // a plain click: the "+" does its own job
    const c = was.cancelled ? null : choice(e.clientX, e.clientY);
    // the click that follows this mouseup must not also open an empty tab
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 300);
    end();
    if (!c) return;
    const ws = app.workspace;
    let tabs = null;
    ws.iterateLeaves(ws.rootSplit, (l) => { if (!tabs && l.parent?.containerEl === was.tabsEl) tabs = l.parent; });
    tabs = tabs || ws.getMostRecentLeaf(ws.rootSplit)?.parent;
    if (tabs) {
      const leaf = new WorkspaceLeaf(ws);
      tabs.insertChild(-1, leaf);
      await leaf.setViewState({ type: 'empty' });
      ws.setActiveLeaf(leaf, { focus: true });
    }
    app.commands.executeCommandById(c === 'canvas' ? 'canvas:new-file' : 'file:new');
  }, true);

  document.addEventListener('keydown', (e) => {
    if (g?.active && e.key === 'Escape') {
      e.preventDefault();
      g.layer?.remove();
      document.body.removeClass('pc-new-pulling');
      g.active = false;
      g.cancelled = true; // letting go now does nothing, not even a new tab
    }
  }, true);
}

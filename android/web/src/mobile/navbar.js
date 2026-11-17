// sk_notes for Android – the navigation bar at the bottom of a phone, and the tab list.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later

import { isPhone } from './device.js';
import { BASE_VIEWS, leaveBase, openBase } from './home.js';
import { setIcon } from '@desktop/core/icons.js';
import { t } from '@desktop/core/i18n.js';
import { Menu, Modal } from '@desktop/ui/kit.js';
import { WorkspaceLeaf } from '@desktop/ui/workspace.js';

/** What a tab that shows a base view right now holds underneath (the file "back" returns to). */
function behind(leaf) {
  const h = leaf.history?.backHistory || [];
  for (let i = h.length - 1; i >= 0; i--) {
    const st = h[i]?.state;
    if (!st || BASE_VIEWS.includes(st.type)) continue;
    return st.type === 'empty' ? null : st;
  }
  return null;
}

const isBase = (leaf) => BASE_VIEWS.includes(leaf.view?.getViewType());

/** The tabs. The graph and the file list are ways of looking at the vault, not tabs: a tab
 * that shows one of them counts as the file it holds underneath, or not at all. */
const isHome = (leaf) => (leaf.view?.getViewType() || 'empty') === 'empty';

/** Home is where a tab starts from, not a tab: it is neither listed nor counted. */
function rootLeaves(ws) {
  const out = [];
  ws.iterateLeaves(ws.rootSplit, (l) => { if (isBase(l) ? behind(l) : !isHome(l)) out.push(l); });
  return out;
}

function tabTitle(leaf) {
  if (!isBase(leaf)) return leaf.getDisplayText() || t('tab.new');
  const file = String(behind(leaf)?.state?.file || '');
  return file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/i, '') || t('tab.new');
}

class TabSwitcher extends Modal {
  onOpen() {
    this.modalEl.addClass('mod-tab-switcher');
    this.setTitle(t('mobile.tabs'));
    this.listEl = this.contentEl.createDiv('mobile-tab-list');
    const row = this.contentEl.createDiv('modal-button-container');
    const add = row.createEl('button', { cls: 'mod-cta', text: t('tab.new') });
    add.addEventListener('click', () => {
      this.close();
      leaveBase(this.app, null).then(() => {
        // a new tab is Home until a file is opened in it: the Home already there is used again
        const ws = this.app.workspace;
        let home = null;
        ws.iterateLeaves(ws.rootSplit, (l) => { if (!home && isHome(l)) home = l; });
        if (home) ws.setActiveLeaf(home, { focus: false }); else this.app.commands.executeCommandById('workspace:new-tab');
      });
    });
    const all = row.createEl('button', { text: t('tab.close-all') });
    all.addEventListener('click', async () => {
      for (const l of rootLeaves(this.app.workspace)) if (!l.pinned) await l.detach();
      this.close();
    });
    this.render();
  }

  render() {
    const ws = this.app.workspace;
    this.listEl.empty();
    for (const leaf of rootLeaves(ws)) {
      const item = this.listEl.createDiv('mobile-tab-item' + (leaf === ws.activeLeaf || (ws.activeLeaf?.getRoot() !== ws.rootSplit && leaf === ws.getMostRecentLeaf(ws.rootSplit)) ? ' is-active' : ''));
      setIcon(item.createDiv('mobile-tab-icon'), isBase(leaf) ? 'file' : leaf.getIcon());
      const text = item.createDiv('mobile-tab-text');
      text.createDiv({ cls: 'mobile-tab-title', text: tabTitle(leaf) });
      const file = leaf.view?.file;
      if (file?.parent && file.parent.path !== '/') text.createDiv({ cls: 'mobile-tab-path', text: file.parent.path });
      if (leaf.pinned) setIcon(item.createDiv('mobile-tab-pin'), 'pin');
      else {
        const x = item.createDiv({ cls: 'clickable-icon mobile-tab-close', attr: { 'aria-label': t('tab.close') } });
        setIcon(x, 'x');
        x.addEventListener('click', async (e) => {
          e.stopPropagation();
          await leaf.detach();
          if (rootLeaves(ws).length) this.render(); else this.close();
        });
      }
      item.addEventListener('click', async () => {
        this.close();
        await leaveBase(this.app, null); // a tab is its file: the graph or list shown over it is put away
        if (leaf.parent) ws.setActiveLeaf(leaf, { focus: false });
      });
    }
  }
}

const CORE_RIBBON = new Set(['switcher', 'graph', 'canvas', 'daily', 'templates', 'palette', 'bases', 'random', 'skai', 'vault', 'help', 'settings']);

/** "+": press it and three bubbles rise above it – database, note, canvas. Slide the finger
 * onto one and lift it: that file is made and opened. A plain tap leaves the bubbles up to be
 * tapped; a touch anywhere else puts them away. */
function installCreate(app, plus) {
  const KINDS = [
    ['database', 'bases:new-file', 'cmd.new-base', 'mod-left'],
    ['file-plus', 'file:new', 'cmd.new-note', 'mod-center'],
    ['canvas', 'canvas:new-file', 'cmd.new-canvas', 'mod-right'],
  ];
  let pop = null;
  let downAt = null;
  let outside = null;
  const close = () => {
    pop?.remove();
    pop = null;
    plus.removeClass('is-open');
    if (outside) { document.removeEventListener('pointerdown', outside, true); outside = null; }
  };
  const make = (id) => { close(); app.commands.executeCommandById(id); };
  const open = () => {
    if (pop) return;
    pop = document.body.createDiv('mobile-create');
    for (const [icon, id, label, cls] of KINDS) {
      const b = pop.createDiv({ cls: 'mobile-create-item ' + cls, attr: { 'data-command': id, 'aria-label': t(label), role: 'button' } });
      setIcon(b.createDiv('mobile-create-icon'), icon);
      b.createDiv({ cls: 'mobile-create-label', text: t(label) });
      b.addEventListener('click', () => make(id));
    }
    const r = plus.getBoundingClientRect();
    pop.style.left = `${r.left + r.width / 2}px`;
    pop.style.bottom = `${window.innerHeight - r.top + 10}px`;
    plus.addClass('is-open');
    outside = (e) => { if (!e.target.closest?.('.mobile-create, .mobile-navbar-action.mod-new')) close(); };
    setTimeout(() => { if (outside) document.addEventListener('pointerdown', outside, true); }, 0);
  };
  const under = (e) => document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.mobile-create-item') || null;
  const mark = (el) => { pop?.querySelectorAll('.mobile-create-item').forEach((x) => x.toggleClass('is-target', x === el)); };
  plus.addEventListener('pointerdown', (e) => {
    if (pop) { close(); downAt = null; return; } // a second tap on "+" puts the bubbles away
    downAt = { x: e.clientX, y: e.clientY, id: e.pointerId };
    try { plus.setPointerCapture(e.pointerId); } catch { /* the bubbles still work with taps */ }
    open();
    e.preventDefault();
  });
  plus.addEventListener('pointermove', (e) => { if (downAt && e.pointerId === downAt.id) mark(under(e)); });
  plus.addEventListener('pointerup', (e) => {
    if (!downAt || e.pointerId !== downAt.id) return;
    const at = downAt;
    downAt = null;
    const hit = under(e);
    const moved = Math.hypot(e.clientX - at.x, e.clientY - at.y) > 14;
    if (hit) make(hit.getAttribute('data-command')); // slid onto a bubble: made at once
    else if (moved) close(); // slid away without reaching one: nothing is wanted, the bubbles go
    else mark(null); // a plain tap on "+": the bubbles wait for a tap
  });
  plus.addEventListener('pointercancel', () => { downAt = null; close(); });
  window.addEventListener('skn-device-change', close);
}

export function installNavbar(app) {
  const ws = app.workspace;
  const bar = app.containerEl.createDiv('mobile-navbar');
  const button = (icon, label, onClick, cls = '') => {
    const el = bar.createDiv({ cls: 'mobile-navbar-action clickable-icon ' + cls, attr: { 'aria-label': label, 'data-no-tooltip': '' } });
    setIcon(el, icon);
    el.addEventListener('click', (e) => onClick(e, el));
    return el;
  };
  const run = (id) => () => app.commands.executeCommandById(id);
  const back = button('arrow-left', t('view.back'), run('app:go-back'), 'mod-back');
  const forward = button('arrow-right', t('view.forward'), run('app:go-forward'), 'mod-forward');
  // the two base views sit on the two sides of "+": the file list and the graph
  button('list', t('mobile.home.list'), () => openBase(app, 'file-explorer'), 'mod-list');
  installCreate(app, button('plus', t('mobile.home.create'), () => {}, 'mod-new'));
  button('graph', t('ribbon.graph'), () => openBase(app, 'graph'), 'mod-graph');
  const tabs = button('layers', t('mobile.tabs'), () => new TabSwitcher(app).open(), 'mod-tabs');
  const count = tabs.createSpan('mobile-navbar-tab-count');
  // the wheel: what is not "make a new file" (that is "+"), and at the bottom the real settings
  button('settings', t('mobile.more'), (e, el) => {
    const menu = new Menu();
    const item = (section, icon, title, fn) => menu.addItem((i) => i.setTitle(title).setIcon(icon).setSection(section).onClick(fn));
    item('do', 'sparkles', t('ribbon.skai'), run('skai:open'));
    item('do', 'calendar-day', t('cmd.daily-note'), run('daily-notes'));
    item('do', 'template', t('mobile.menu.template'), () => {
      if (!app.workspace.activeEditor?.editor) { app.notice(t('mobile.menu.template-needs-note')); return; }
      app.commands.executeCommandById('insert-template');
    });
    item('do', 'file-plus', t('mobile.home.template'), run('mobile:new-from-template'));
    if (app.commands.commands['file:version-history']?.checkCallback?.(true)) item('do', 'history', t('mobile.versions.menu'), run('file:version-history'));
    if (app.pluginCommands?.().length) item('plugins', 'command', t('mobile.menu.commands'), run('command-palette:open')); // only what plugins add
    // what community plugins added to the ribbon of a PC
    for (const it of ws.leftRibbon.items) {
      if (CORE_RIBBON.has(it.id) || ws.leftRibbon.hidden.has(it.id)) continue;
      menu.addItem((i) => i.setTitle(it.title).setIcon(it.icon).setSection('plugins').onClick((ev) => it.callback(ev || e)));
    }
    item('vault', 'upload', t('mobile.import-files'), run('mobile:import-files'));
    item('vault', 'vault', t('cmd.open-vault'), run('app:open-vault'));
    if (app.lockVault) item('vault', 'lock', t('mobile.crypt.lock'), () => app.lockVault());
    item('settings', 'settings', t('cmd.settings'), run('app:open-settings'));
    const r = el.getBoundingClientRect();
    menu.showAtPosition({ x: r.right, y: r.top - 4, left: true });
  }, 'mod-more');

  const update = () => {
    const leaf = ws.activeLeaf && ws.activeLeaf.getRoot() === ws.rootSplit ? ws.activeLeaf : ws.getMostRecentLeaf(ws.rootSplit);
    back.toggleClass('is-disabled', !leaf?.history.canBack());
    forward.toggleClass('is-disabled', !leaf?.history.canForward());
    const n = rootLeaves(ws).length;
    count.setText(n ? String(n) : ''); // Home alone is not a tab: nothing to count
  };
  ws.on('active-leaf-change', update);
  ws.on('layout-change', update);
  ws.on('file-open', update);
  // history changes when a view state is set on a leaf
  const setViewState = WorkspaceLeaf.prototype.setViewState;
  WorkspaceLeaf.prototype.setViewState = async function setAndUpdate(...args) {
    const r = await setViewState.apply(this, args);
    update();
    return r;
  };
  const detach = WorkspaceLeaf.prototype.detach;
  WorkspaceLeaf.prototype.detach = async function detachAndUpdate(...args) {
    const r = await detach.apply(this, args);
    update();
    return r;
  };
  update();
  void isPhone;
}

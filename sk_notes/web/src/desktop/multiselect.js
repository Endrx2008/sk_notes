// Several files chosen in the file list (desktop), the way a file manager does it:
// Ctrl+click adds or removes a row, Shift+click takes the rows in between, a plain click
// opens the file as always and ends the choice. The menu of a chosen row (right click)
// acts on all of them: rename them one dialog after the other, move them to a folder,
// delete them (asked once). Delete on the keyboard deletes them, Escape ends the choice.

import { setIcon } from '../core/icons.js';
import { errorText, t } from '../core/i18n.js';
import { TFile, TFolder } from '../model/vault.js';
import { FuzzySuggestModal, Menu, confirmDialog, promptDialog } from '../ui/kit.js';
import { FileExplorerView } from '../views/explorer.js';

const ROW = '.workspace-leaf-content[data-type="file-explorer"] .tree-item-self[data-path]';

class FolderChooser extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder(t('pc.select.move'));
  }

  getItems() { return [this.app.vault.getRoot(), ...this.app.vault.getAllFolders().filter((f) => f.path !== '/')]; }
  getItemText(f) { return f.path === '/' ? '/' : f.path; }
  onChooseItem(f) { this.onChoose(f); }
}

export function installMultiSelect(app) {
  const chosen = new Set();
  let anchor = null;
  let bar = null;

  const files = () => [...chosen].map((p) => app.vault.getAbstractFileByPath(p)).filter(Boolean);
  // what is inside a chosen folder goes with the folder
  const tops = () => { const all = files(); return all.filter((f) => !all.some((g) => g !== f && g instanceof TFolder && f.path.startsWith(g.path + '/'))); };

  const mark = () => {
    for (const el of document.querySelectorAll(ROW)) el.toggleClass('is-chosen', chosen.has(el.getAttribute('data-path')));
    document.body.classList.toggle('is-choosing-files', chosen.size > 1);
    if (chosen.size < 2) { bar?.remove(); bar = null; return; }
    const list = document.querySelector('.workspace-leaf-content[data-type="file-explorer"]');
    if (!list) return;
    if (!bar || !bar.isConnected) {
      bar = list.createDiv('pc-select-bar');
      const btn = (icon, label, fn, cls = '') => {
        const b = bar.createDiv({ cls: 'clickable-icon ' + cls, attr: { 'aria-label': label } });
        setIcon(b, icon);
        b.addEventListener('click', fn);
      };
      bar.createSpan('pc-select-count');
      btn('pencil', t('pc.select.rename'), renameAll);
      btn('folder-input', t('pc.select.move'), moveAll);
      btn('trash', t('common.delete'), deleteAll, 'mod-warning');
      btn('x', t('common.cancel'), stop);
    }
    bar.find('.pc-select-count').setText(t('pc.select.count', { n: chosen.size }));
  };
  const stop = () => { chosen.clear(); anchor = null; mark(); };

  async function renameAll() {
    const list = files();
    stop();
    let done = 0;
    for (let i = 0; i < list.length; i++) {
      const file = app.vault.getAbstractFileByPath(list[i].path);
      if (!file) continue;
      const old = file instanceof TFile ? file.basename : file.name;
      const name = await promptDialog(app, { title: t('pc.select.rename-title', { i: i + 1, n: list.length }), value: old, confirm: t('common.rename') });
      if (name === null) break; // "Cancel" stops the series
      const next = name.trim();
      if (!next || next === old) continue;
      const parent = file.parent && file.parent.path !== '/' ? file.parent.path + '/' : '';
      try {
        await app.fileManager.renameFile(file, file instanceof TFile ? `${parent}${next}.${file.extension}` : `${parent}${next}`);
        done += 1;
      } catch (e) { app.notice(t('notice.rename-failed', { error: errorText(e) })); }
    }
    app.notice(t('pc.select.renamed', { n: done }));
  }

  function moveAll() {
    const list = tops();
    new FolderChooser(app, async (folder) => {
      stop();
      let done = 0;
      for (const f of list) {
        if (f instanceof TFolder && (folder.path + '/').startsWith(f.path + '/')) continue; // not into itself
        const target = (folder.path === '/' ? '' : folder.path + '/') + f.name;
        if (target === f.path) continue;
        try { await app.fileManager.renameFile(f, target); done += 1; } catch (e) { app.notice(`${f.name}: ${errorText(e)}`); }
      }
      app.notice(t('pc.select.moved', { n: done }));
    }).open();
  }

  async function deleteAll() {
    const list = tops();
    if (!list.length) return;
    const names = list.slice(0, 8).map((f) => f.name).join('\n') + (list.length > 8 ? '\n…' : '');
    if (!(await confirmDialog(app, { title: t('pc.select.delete-title', { n: list.length }), message: names, confirm: t('common.delete'), warning: true }))) return;
    stop();
    let done = 0;
    for (const f of list) {
      try { await app.fileManager.trashFile(f); done += 1; } catch (e) { app.notice(`${f.name}: ${errorText(e)}`); }
    }
    app.notice(t('pc.select.deleted', { n: done }));
  }

  const visibleRows = () => [...document.querySelectorAll(ROW)].filter((el) => el.offsetParent !== null);

  document.addEventListener('click', (e) => {
    const row = e.target.closest?.(ROW);
    if (!row || e.button !== 0) return;
    const path = row.getAttribute('data-path');
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      // the file shown now counts as chosen when the choice starts
      if (!chosen.size) { const cur = app.workspace.getActiveFile(); if (cur && cur.path !== path) chosen.add(cur.path); }
      if (chosen.has(path)) chosen.delete(path); else chosen.add(path);
      anchor = path;
      mark();
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const rows = visibleRows().map((el) => el.getAttribute('data-path'));
      const from = rows.indexOf(anchor || app.workspace.getActiveFile()?.path || path);
      const to = rows.indexOf(path);
      if (from === -1) { chosen.add(path); anchor = path; } else {
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) chosen.add(rows[i]);
      }
      mark();
      return;
    }
    if (chosen.size) stop(); // a plain click: as always, and the choice ends
  }, true);

  document.addEventListener('contextmenu', (e) => {
    const row = e.target.closest?.(ROW);
    if (!row || chosen.size < 2 || !chosen.has(row.getAttribute('data-path'))) return;
    e.preventDefault();
    e.stopPropagation();
    const m = new Menu();
    m.addItem((i) => i.setTitle(t('pc.select.rename')).setIcon('pencil').onClick(renameAll));
    m.addItem((i) => i.setTitle(t('pc.select.move')).setIcon('folder-input').onClick(moveAll));
    m.addItem((i) => i.setTitle(`${t('common.delete')} (${tops().length})`).setIcon('trash').setWarning(true).setSection('danger').onClick(deleteAll));
    m.showAtMouseEvent(e);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (chosen.size < 2 || e.target.closest?.('input, textarea, .cm-editor, [contenteditable="true"]')) return;
    if (!document.activeElement?.closest?.('.workspace-leaf-content[data-type="file-explorer"]')) return;
    if (e.key === 'Escape') { e.preventDefault(); stop(); }
    if (e.key === 'Delete') { e.preventDefault(); deleteAll(); }
    if (e.key === 'F2') { e.preventDefault(); renameAll(); }
  }, true);

  // the list is drawn again at every change of the vault: the marks are put back
  const render = FileExplorerView.prototype._render;
  FileExplorerView.prototype._render = function renderAndMark(...args) {
    const r = render.apply(this, args);
    for (const p of [...chosen]) if (!app.vault.getAbstractFileByPath(p)) chosen.delete(p);
    mark();
    return r;
  };
}

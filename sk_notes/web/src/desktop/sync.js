// Sync with GitHub, GitLab or another Git server (desktop): the dialog, a page of the
// settings, an item of the status bar, and the timing. The work is done by Python
// (sk_notes/extras/sync_api.py, gitsync.py).
//
// Timing: when the vault opens, a little after the last change, at the chosen interval,
// when the window gets the focus back after a while, and (by Python) when sk_notes closes.

import { call, onBackend } from '../core/api.js';
import { setIcon } from '../core/icons.js';
import { errorText, getLanguage, t } from '../core/i18n.js';
import { Modal, Setting, confirmDialog } from '../ui/kit.js';

const AFTER_CHANGE = 30000;
const AFTER_FOCUS = 120000;
const TOKEN_PAGES = {
  github: () => 'https://github.com/settings/tokens/new?description=sk_notes&scopes=repo',
  gitlab: (host) => `https://${host || 'gitlab.com'}/-/user_settings/personal_access_tokens?name=sk_notes&scopes=api,read_repository,write_repository`,
};

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  const f = new Intl.RelativeTimeFormat(getLanguage(), { numeric: 'auto' });
  if (s < 60) return f.format(0, 'minute');
  if (s < 3600) return f.format(-Math.floor(s / 60), 'minute');
  if (s < 86400) return f.format(-Math.floor(s / 3600), 'hour');
  return f.format(-Math.floor(s / 86400), 'day');
}

const failure = (e) => (['sync-failed', 'sync-http', 'sync-rejected'].includes(e?.code) ? `${errorText(e)} ${e.detail || ''}`.trim() : errorText(e));

export function installSync(app) {
  let st = { linked: false };
  let busy = false;
  let lastTry = 0;
  let changeTimer = null;
  let intervalTimer = null;
  let toldError = '';
  const manual = app.commands.commands['sync:open']?.callback; // the panel of before: Git by hand, Syncthing

  // status bar: the state at a glance; a click opens the dialog (the bar exists once the app has started)
  let item = null;
  const drawItem = () => {
    if (!item && app.statusBar) {
      item = app.statusBar.addStatusBarItem();
      item.addClass('mod-clickable', 'pc-sync-status');
      item.addEventListener('click', () => openSync());
    }
    if (!item) return;
    item.empty();
    item.toggle(!!st.linked);
    if (!st.linked) return;
    const bad = st.lastError && st.lastError.code !== 'network-error';
    setIcon(item.createSpan('pc-sync-icon' + (busy ? ' is-busy' : '') + (bad ? ' is-error' : '')), bad ? 'alert-triangle' : 'cloud');
    item.createSpan({ text: ' ' + stateText() });
    item.setAttr('aria-label', st.repo);
  };

  const stateText = () => {
    if (busy) return t('pc.sync.working');
    if (st.lastError) return st.lastError.code === 'network-error' ? t('pc.sync.offline') : t('pc.sync.failed', { error: failure(st.lastError) });
    if (!st.lastSync) return t('pc.sync.never');
    return t('pc.sync.status-linked', { when: ago(st.lastSync) });
  };

  const schedule = () => {
    clearInterval(intervalTimer);
    intervalTimer = null;
    if (st.linked && st.auto && st.interval > 0) intervalTimer = setInterval(() => syncNow(), st.interval * 60000);
  };

  const refresh = async () => {
    try { st = await call('sync.status'); } catch { st = { linked: false }; }
    schedule();
    drawItem();
    return st;
  };

  const report = (r) => {
    if (r.conflicts?.length) app.notice(t('pc.sync.conflicts', { n: r.conflicts.length, list: r.conflicts.slice(0, 5).map((c) => c.copy).join('\n') }), 15000);
    if (r.tooBig?.length) app.notice(t('pc.sync.too-big', { n: r.tooBig.length, list: r.tooBig.slice(0, 5).join('\n') }), 12000);
  };

  async function syncNow({ quiet = true } = {}) {
    if (!st.linked || busy) return null;
    busy = true;
    lastTry = Date.now();
    clearTimeout(changeTimer);
    changeTimer = null;
    drawItem();
    const note = quiet ? null : app.notice(t('pc.sync.working'), 0);
    try {
      try { await app.flush?.(); } catch { /* what is on disk is synced */ }
      const r = await call('sync.run');
      toldError = '';
      report(r);
      note?.setMessage(r.pulled || r.pushed ? t('pc.sync.done-changes', { down: r.pulled, up: r.pushed ? t('pc.sync.sent') : t('pc.sync.nothing-sent') }) : t('pc.sync.done-same'));
      return r;
    } catch (e) {
      const text = t('pc.sync.failed', { error: failure(e) });
      if (note) note.setMessage(text);
      else if (e.code !== 'network-error' && toldError !== e.code) { toldError = e.code; app.notice(text, 10000); }
      return null;
    } finally {
      busy = false;
      if (note) setTimeout(() => note.hide(), 4000);
      await refresh();
    }
  }

  const changed = () => {
    if (!st.linked || !st.auto || busy) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { changeTimer = null; syncNow(); }, AFTER_CHANGE);
  };

  // ------------------------------------------------------------- the dialog / the settings page
  async function render(el, again) {
    await refresh();
    el.empty();
    el.addClass('pc-sync');
    if (st.encrypted) { el.createEl('p', { cls: 'setting-item-description', text: t('pc.sync.encrypted') }); return; }
    if (st.linked) renderLinked(el, again); else renderSetup(el, again);
    if (manual) {
      new Setting(el).setName(t('pc.sync.manual')).setDesc(t('pc.sync.manual-desc'))
        .addButton((b) => b.setButtonText(t('pc.sync.manual')).onClick(() => manual()));
    }
  }

  function renderLinked(el, again) {
    el.createEl('p', { cls: 'setting-item-description', text: t('pc.sync.linked-intro') });
    new Setting(el).setName(st.repo).setDesc(`${st.user ? st.user + ' · ' : ''}${st.branch} · ${stateText()}`)
      .addButton((b) => b.setButtonText(t('pc.sync.now')).setCta().onClick(async () => { b.setDisabled(true); await syncNow({ quiet: false }); again(); }));
    new Setting(el).setName(t('pc.sync.auto')).setDesc(t('pc.sync.auto-desc')).addToggle((tg) => tg.setValue(st.auto).onChange(async (v) => { await call('sync.options', { auto: v }); again(); }));
    if (st.auto) {
      const every = { 0: t('pc.sync.every-never') };
      for (const m of [5, 10, 15, 30, 60]) every[m] = t('pc.sync.every-min', { n: m });
      new Setting(el).setName(t('pc.sync.every')).setDesc(t('pc.sync.every-desc')).addDropdown((d) => d.addOptions(every).setValue(String(st.interval)).onChange(async (v) => { await call('sync.options', { interval: Number(v) }); refresh(); }));
    }
    new Setting(el).setName(t('pc.sync.pc')).setHeading();
    el.createEl('p', { cls: 'setting-item-description', text: t('pc.sync.pc-text') });
    new Setting(el).setName(t('pc.sync.unlink')).setDesc(t('pc.sync.unlink-desc')).addButton((b) => b.setButtonText(t('pc.sync.unlink')).setWarning().onClick(async () => {
      if (!(await confirmDialog(app, { title: t('pc.sync.unlink'), message: t('pc.sync.unlink-desc'), confirm: t('pc.sync.unlink'), warning: true }))) return;
      try { await call('sync.unlink'); } catch (e) { app.notice(failure(e)); }
      again();
    }));
  }

  function renderSetup(el, again) {
    const form = { provider: 'github', host: '', user: '', token: '', url: '', repo: '', name: 'notes' };
    el.createEl('p', { cls: 'setting-item-description', text: t('pc.sync.intro') });
    const top = el.createDiv();
    const rest = el.createDiv();
    const plain = (x, type) => { x.inputEl.setAttr('autocomplete', 'off'); x.inputEl.setAttr('spellcheck', 'false'); if (type) x.inputEl.type = type; return x; };
    const connect = async (url) => {
      const note = app.notice(t('pc.sync.first'), 0);
      try {
        try { await app.flush?.(); } catch { /* what is on disk is synced */ }
        const r = await call('sync.link', { ...form, url });
        note.setMessage(t('pc.sync.linked'));
        report(r);
      } catch (e) {
        note.setMessage(t('pc.sync.failed', { error: failure(e) }));
      } finally {
        setTimeout(() => note.hide(), 6000);
        again();
      }
    };
    const drawRepos = (found) => {
      rest.empty();
      const NEW = '__new__';
      if (!found.canList) {
        new Setting(rest).setName(t('pc.sync.repo')).setDesc(t('pc.sync.repo-type-desc')).addText((x) => plain(x).setPlaceholder(`${form.user || 'name'}/notes`).setValue(form.url).onChange((v) => { form.url = v.trim(); }));
      } else {
        const opts = { [NEW]: t('pc.sync.repo-new') };
        for (const r of found.repos) opts[r.url] = r.name + (r.private ? '' : ` (${t('pc.sync.public')})`);
        form.repo = NEW;
        const nameRow = createDiv();
        new Setting(rest).setName(t('pc.sync.repo')).setDesc(t('pc.sync.repo-desc')).addDropdown((d) => d.addOptions(opts).setValue(NEW).onChange((v) => { form.repo = v; nameRow.toggle(v === NEW); }));
        rest.appendChild(nameRow);
        new Setting(nameRow).setName(t('pc.sync.repo-name')).setDesc(t('pc.sync.repo-name-desc')).addText((x) => plain(x).setValue(form.name).onChange((v) => { form.name = v.trim(); }));
      }
      new Setting(rest).addButton((b) => b.setButtonText(t('pc.sync.connect')).setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          let url = form.url;
          if (found.canList) url = form.repo === NEW ? (await call('sync.createRepo', form)).url : form.repo;
          if (!url) { app.notice(t('pc.sync.need-all')); return; }
          await connect(url);
        } catch (e) { app.notice(t('pc.sync.failed', { error: failure(e) }), 9000); } finally { b.setDisabled(false); }
      }));
    };
    const drawTop = () => {
      top.empty();
      rest.empty();
      new Setting(top).setName(t('pc.sync.site')).setDesc(t('pc.sync.site-desc')).addDropdown((d) => d
        .addOptions({ github: 'GitHub', gitlab: 'GitLab', other: t('pc.sync.site-other') }).setValue(form.provider).onChange((v) => { form.provider = v; drawTop(); }));
      if (form.provider === 'gitlab') new Setting(top).setName(t('pc.sync.host')).setDesc(t('pc.sync.host-desc')).addText((x) => plain(x).setPlaceholder('gitlab.com').setValue(form.host).onChange((v) => { form.host = v.trim(); }));
      if (form.provider === 'other') new Setting(top).setName(t('pc.sync.address')).setDesc(t('pc.sync.address-desc')).addText((x) => plain(x).setPlaceholder('https://git.example.org/me/notes.git').setValue(form.url).onChange((v) => { form.url = v.trim(); }));
      new Setting(top).setName(t('pc.sync.user')).addText((x) => plain(x).setValue(form.user).onChange((v) => { form.user = v.trim(); }));
      const secretRow = new Setting(top).setName(t('pc.sync.secret')).setDesc(t(`pc.sync.secret-${form.provider}`))
        .addText((x) => plain(x, 'password').setValue(form.token).onChange((v) => { form.token = v.trim(); }));
      if (TOKEN_PAGES[form.provider]) secretRow.addButton((b) => b.setButtonText(t('pc.sync.make-token')).onClick(() => app.openExternal(TOKEN_PAGES[form.provider](form.host))));
      new Setting(top).addButton((b) => b.setButtonText(form.provider === 'other' ? t('pc.sync.connect') : t('pc.sync.continue')).setCta().onClick(async () => {
        if (!form.token || (form.provider === 'other' && !form.url)) { app.notice(t('pc.sync.need-all')); return; }
        b.setDisabled(true);
        try {
          if (form.provider === 'other') { await connect(form.url); return; }
          const found = await call('sync.check', form);
          if (found.user && !form.user) form.user = found.user;
          drawRepos(found);
        } catch (e) { app.notice(t('pc.sync.failed', { error: failure(e) }), 9000); } finally { b.setDisabled(false); }
      }));
    };
    drawTop();
  }

  class SyncModal extends Modal {
    onOpen() {
      this.modalEl.addClass('mod-pc-sync');
      this.setTitle(t('pc.sync.title'));
      const draw = () => render(this.contentEl, draw).catch((e) => this.contentEl.setText(String(e.message || e)));
      draw();
    }
  }
  const openSync = () => new SyncModal(app).open();
  app.renderSyncSettings = (el) => { const draw = () => render(el, draw).catch((e) => el.setText(String(e.message || e))); draw(); return true; };

  app.commands.removeCommand('sync:open');
  app.commands.removeCommand('sync:commit-and-push');
  app.commands.addCommand({ id: 'sync:open', name: t('pc.sync.title'), icon: 'cloud', callback: openSync });
  app.commands.addCommand({ id: 'sync:commit-and-push', name: t('pc.sync.now'), checkCallback: (check) => {
    if (!st.linked) return false;
    if (!check) syncNow({ quiet: false });
    return true;
  } });
  if (manual) app.commands.addCommand({ id: 'sync:manual', name: t('pc.sync.manual'), callback: manual });

  app.on('ready', async () => {
    for (const ev of ['modify', 'create', 'delete', 'rename']) app.vault.on(ev, changed);
    await refresh();
    if (st.linked && st.auto) setTimeout(() => syncNow(), 2000);
    else if (!st.linked && !st.offered && !st.encrypted) offer();
  });
  onBackend('sync', () => { if (!busy) refresh(); });
  window.addEventListener('focus', () => { if (st.linked && st.auto && Date.now() - lastTry > AFTER_FOCUS) syncNow(); });
  setInterval(drawItem, 60000); // "2 minutes ago" moves on

  /** Proposed once per vault, in a notice that can be dismissed. */
  function offer() {
    const frag = createFragment((f) => {
      f.createDiv({ cls: 'pc-sync-offer-title', text: t('pc.sync.offer-title') });
      f.createDiv({ text: t('pc.sync.offer-text') });
      const row = f.createDiv('notice-buttons');
      row.createEl('button', { cls: 'mod-cta', text: t('pc.sync.offer-yes') }).addEventListener('click', () => { n.hide(); openSync(); });
      row.createEl('button', { text: t('pc.sync.offer-no') }).addEventListener('click', () => { n.hide(); call('sync.options', { offered: true }).catch(() => {}); });
    });
    const n = app.notice(frag, 0);
  }
}

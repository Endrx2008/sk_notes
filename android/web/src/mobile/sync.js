// sk_notes for Android – sync with GitHub, GitLab or another Git server: the screens and the timing.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The work is done by the backend (backend/routes-sync.js). Here:
//   - the set-up: a site, a name, a password or access token, a repository;
//   - when to sync without being asked: at the start, a little after the last change, at
//     an interval, when the app comes back to the front and when it is left;
//   - what the user is told: nothing when all went well, a notice when two devices changed
//     the same note or when something must be fixed (the sign-in, for example);
//   - the card of Home that proposes the sync once, then shows its state.

import { native } from '../backend/native.js';
import { call, onBackend } from './api.js';
import { setIcon } from '@desktop/core/icons.js';
import { errorText, getLanguage, t } from '@desktop/core/i18n.js';
import { Modal, Setting, confirmDialog } from '@desktop/ui/kit.js';

const AFTER_CHANGE = 45000; // sync this long after the last change
const AFTER_RESUME = 60000; // coming back to the app: sync if the last one is older than this
const TOKEN_PAGES = {
  github: () => 'https://github.com/settings/tokens/new?description=sk_notes&scopes=repo',
  gitlab: (host) => `https://${host || 'gitlab.com'}/-/user_settings/personal_access_tokens?name=sk_notes&scopes=api,read_repository,write_repository`,
};

/** "5 minutes ago", in the language of the app. */
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  const f = new Intl.RelativeTimeFormat(getLanguage(), { numeric: 'auto' });
  if (s < 60) return f.format(0, 'minute');
  if (s < 3600) return f.format(-Math.floor(s / 60), 'minute');
  if (s < 86400) return f.format(-Math.floor(s / 3600), 'hour');
  return f.format(-Math.floor(s / 86400), 'day');
}

const failure = (e) => (e?.code === 'sync-failed' || e?.code === 'sync-http' || e?.code === 'sync-rejected' ? `${errorText(e)} ${e.detail || ''}`.trim() : errorText(e));

export function installSync(app) {
  let st = { linked: false };
  let busy = false;
  let lastTry = 0;
  let changeTimer = null;
  let intervalTimer = null;
  let toldError = '';
  const told = new Set();
  const cards = new Set(); // Home cards on screen

  const drawCards = () => { for (const el of [...cards]) { if (!el.isConnected) cards.delete(el); else drawCard(el); } };

  const schedule = () => {
    clearInterval(intervalTimer);
    intervalTimer = null;
    if (st.linked && st.auto && st.interval > 0) intervalTimer = setInterval(() => { if (document.visibilityState !== 'hidden') syncNow(); }, st.interval * 60000);
  };

  const refresh = async () => {
    try { st = await call('sync.status'); } catch { st = { linked: false }; }
    schedule();
    drawCards();
    return st;
  };

  const report = (r) => {
    if (r.conflicts?.length) app.notice(t('mobile.sync.conflicts', { n: r.conflicts.length, list: r.conflicts.slice(0, 5).map((c) => c.copy).join('\n') }), 15000);
    for (const [key, list] of [['mobile.sync.too-big', r.tooBig], ['mobile.sync.unwritable', r.unwritable]]) {
      const fresh = (list || []).filter((p) => !told.has(key + p));
      for (const p of fresh) told.add(key + p);
      if (fresh.length) app.notice(t(key, { n: fresh.length, list: fresh.slice(0, 5).join('\n') }), 12000);
    }
  };

  /** One round. quiet: started by the app itself (no "done" notice, no notice when offline). */
  async function syncNow({ quiet = true } = {}) {
    if (!st.linked || busy) return null;
    busy = true;
    lastTry = Date.now();
    clearTimeout(changeTimer);
    changeTimer = null;
    drawCards();
    const note = quiet ? null : app.notice(t('mobile.sync.working'), 0);
    try {
      try { await app.flush(); } catch { /* what is on disk is synced */ }
      const r = await call('sync.run');
      toldError = '';
      report(r);
      note?.setMessage(r.pulled || r.pushed ? t('mobile.sync.done-changes', { down: r.pulled, up: r.pushed ? t('mobile.sync.sent') : t('mobile.sync.nothing-sent') }) : t('mobile.sync.done-same'));
      return r;
    } catch (e) {
      const text = t('mobile.sync.failed', { error: failure(e) });
      if (note) note.setMessage(text);
      // by itself the app complains once per problem, and never about being offline
      else if (e.code !== 'network-error' && toldError !== e.code) { toldError = e.code; app.notice(text, 10000); }
      return null;
    } finally {
      busy = false;
      if (note) setTimeout(() => note.hide(), 4000);
      await refresh();
    }
  }

  const changed = () => {
    if (!st.linked || !st.auto || busy) return; // what a sync itself brings is not a change to send
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { changeTimer = null; syncNow(); }, AFTER_CHANGE);
  };

  // ------------------------------------------------------------- the card of Home
  function drawCard(el) {
    el.empty();
    el.className = 'mobile-sync-card';
    if (!st.linked) {
      if (st.offered) { el.hide(); return; }
      el.show();
      el.addClass('mod-offer');
      setIcon(el.createDiv('mobile-sync-card-icon'), 'cloud');
      const body = el.createDiv('mobile-sync-card-body');
      body.createDiv({ cls: 'mobile-sync-card-title', text: t('mobile.sync.offer-title') });
      body.createDiv({ cls: 'mobile-sync-card-text', text: t('mobile.sync.offer-text') });
      const row = body.createDiv('mobile-sync-card-buttons');
      row.createEl('button', { cls: 'mod-cta', text: t('mobile.sync.offer-yes') }).addEventListener('click', () => openSync());
      row.createEl('button', { text: t('mobile.sync.offer-no') }).addEventListener('click', async () => { await call('sync.options', { offered: true }).catch(() => {}); refresh(); });
      return;
    }
    el.show();
    const bad = st.lastError && st.lastError.code !== 'network-error';
    if (bad) el.addClass('mod-error');
    const icon = el.createDiv('mobile-sync-card-icon' + (busy ? ' is-busy' : ''));
    setIcon(icon, bad ? 'alert-triangle' : 'cloud');
    const body = el.createDiv('mobile-sync-card-body');
    body.createDiv({ cls: 'mobile-sync-card-title', text: st.repo });
    body.createDiv({ cls: 'mobile-sync-card-text', text: stateText() });
    body.addEventListener('click', () => openSync());
    const now = el.createDiv({ cls: 'clickable-icon mobile-sync-card-now', attr: { 'aria-label': t('mobile.sync.now'), 'data-no-tooltip': '' } });
    setIcon(now, 'refresh');
    now.addEventListener('click', () => syncNow({ quiet: false }));
  }

  function stateText() {
    if (busy) return t('mobile.sync.working');
    if (st.lastError) return st.lastError.code === 'network-error' ? t('mobile.sync.offline') : t('mobile.sync.failed', { error: failure(st.lastError) });
    if (!st.lastSync) return t('mobile.sync.never');
    return t('mobile.sync.last', { when: ago(st.lastSync) });
  }

  app.renderSyncCard = (parent) => {
    const el = parent.createDiv('mobile-sync-card');
    cards.add(el);
    drawCard(el);
    return el;
  };

  // ------------------------------------------------------------- the screen (a dialog, and a page of the settings)
  async function render(el, again) {
    await refresh();
    el.empty();
    el.addClass('mobile-sync');
    if (st.encrypted) { el.createEl('p', { cls: 'setting-item-description', text: t('mobile.sync.encrypted') }); return; }
    if (st.linked) renderLinked(el, again); else renderSetup(el, again);
  }

  function renderLinked(el, again) {
    el.createEl('p', { cls: 'setting-item-description', text: t('mobile.sync.linked-intro') });
    new Setting(el).setName(st.repo).setDesc(`${st.user ? st.user + ' · ' : ''}${st.branch} · ${stateText()}`)
      .addButton((b) => b.setButtonText(t('mobile.sync.now')).setCta().onClick(async () => { b.setDisabled(true); await syncNow({ quiet: false }); again(); }));
    new Setting(el).setName(t('mobile.sync.auto')).setDesc(t('mobile.sync.auto-desc')).addToggle((tg) => tg.setValue(st.auto).onChange(async (v) => { await call('sync.options', { auto: v }); again(); }));
    if (st.auto) {
      const every = { 0: t('mobile.sync.every-never') };
      for (const m of [5, 10, 15, 30, 60]) every[m] = t('mobile.sync.every-min', { n: m });
      new Setting(el).setName(t('mobile.sync.every')).setDesc(t('mobile.sync.every-desc')).addDropdown((d) => d.addOptions(every).setValue(String(st.interval)).onChange(async (v) => { await call('sync.options', { interval: Number(v) }); refresh(); }));
    }
    new Setting(el).setName(t('mobile.sync.pc')).setHeading();
    el.createEl('p', { cls: 'setting-item-description', text: t('mobile.sync.pc-text') });
    new Setting(el).setName(t('mobile.sync.unlink')).setDesc(t('mobile.sync.unlink-desc')).addButton((b) => b.setButtonText(t('mobile.sync.unlink')).setWarning().onClick(async () => {
      if (!(await confirmDialog(app, { title: t('mobile.sync.unlink'), message: t('mobile.sync.unlink-desc'), confirm: t('mobile.sync.unlink'), warning: true }))) return;
      try { await call('sync.unlink'); } catch (e) { app.notice(failure(e)); }
      again();
    }));
  }

  function renderSetup(el, again) {
    const form = { provider: 'github', host: '', user: '', token: '', url: '', repo: '', name: 'notes' };
    el.createEl('p', { cls: 'setting-item-description', text: t('mobile.sync.intro') });
    const top = el.createDiv();
    const rest = el.createDiv();
    const plain = (x, type) => {
      x.inputEl.setAttr('autocapitalize', 'off');
      x.inputEl.setAttr('autocomplete', 'off');
      x.inputEl.setAttr('autocorrect', 'off');
      x.inputEl.setAttr('spellcheck', 'false');
      if (type === 'url') x.inputEl.setAttr('inputmode', 'url');
      else if (type) x.inputEl.type = type;
      return x;
    };
    const drawTop = () => {
      top.empty();
      rest.empty();
      new Setting(top).setName(t('mobile.sync.site')).setDesc(t('mobile.sync.site-desc')).addDropdown((d) => d
        .addOptions({ github: 'GitHub', gitlab: 'GitLab', other: t('mobile.sync.site-other') }).setValue(form.provider).onChange((v) => { form.provider = v; drawTop(); }));
      if (form.provider === 'gitlab') new Setting(top).setName(t('mobile.sync.host')).setDesc(t('mobile.sync.host-desc')).addText((x) => plain(x).setPlaceholder('gitlab.com').setValue(form.host).onChange((v) => { form.host = v.trim(); }));
      if (form.provider === 'other') new Setting(top).setName(t('mobile.sync.address')).setDesc(t('mobile.sync.address-desc')).addText((x) => plain(x, 'url').setPlaceholder('https://git.example.org/me/notes.git').setValue(form.url).onChange((v) => { form.url = v.trim(); }));
      new Setting(top).setName(t('mobile.sync.user')).addText((x) => plain(x).setValue(form.user).onChange((v) => { form.user = v.trim(); }));
      const secret = new Setting(top).setName(t('mobile.sync.secret')).setDesc(t(`mobile.sync.secret-${form.provider}`))
        .addText((x) => plain(x, 'password').setValue(form.token).onChange((v) => { form.token = v.trim(); }));
      if (TOKEN_PAGES[form.provider]) secret.addButton((b) => b.setButtonText(t('mobile.sync.make-token')).onClick(() => app.openExternal(TOKEN_PAGES[form.provider](form.host))));
      new Setting(top).addButton((b) => b.setButtonText(form.provider === 'other' ? t('mobile.sync.connect') : t('mobile.sync.continue')).setCta().onClick(async () => {
        if (!form.token || (form.provider === 'other' && !form.url)) { app.notice(t('mobile.sync.need-all')); return; }
        b.setDisabled(true);
        try {
          if (form.provider === 'other') { await connect(form.url); return; }
          const found = await call('sync.check', form);
          if (found.user && !form.user) form.user = found.user;
          drawRepos(found);
        } catch (e) { app.notice(t('mobile.sync.failed', { error: failure(e) }), 9000); } finally { b.setDisabled(false); }
      }));
    };
    const connect = async (url) => {
      const note = app.notice(t('mobile.sync.first'), 0);
      try {
        try { await app.flush(); } catch { /* what is on disk is synced */ }
        const r = await call('sync.link', { ...form, url });
        note.setMessage(t('mobile.sync.linked'));
        report(r);
      } catch (e) {
        note.setMessage(t('mobile.sync.failed', { error: failure(e) }));
      } finally {
        setTimeout(() => note.hide(), 6000);
        again();
      }
    };
    const drawRepos = (found) => {
      rest.empty();
      const NEW = '__new__';
      if (!found.canList) {
        // signed in with something the site's lists do not accept (an account password): the repository is typed
        new Setting(rest).setName(t('mobile.sync.repo')).setDesc(t('mobile.sync.repo-type-desc')).addText((x) => plain(x).setPlaceholder(`${form.user || 'name'}/notes`).setValue(form.url).onChange((v) => { form.url = v.trim(); }));
      } else {
        const opts = { [NEW]: t('mobile.sync.repo-new') };
        for (const r of found.repos) opts[r.url] = r.name + (r.private ? '' : ` (${t('mobile.sync.public')})`);
        form.repo = NEW;
        const nameRow = createDiv();
        new Setting(rest).setName(t('mobile.sync.repo')).setDesc(t('mobile.sync.repo-desc')).addDropdown((d) => d.addOptions(opts).setValue(NEW).onChange((v) => { form.repo = v; nameRow.toggle(v === NEW); }));
        rest.appendChild(nameRow);
        new Setting(nameRow).setName(t('mobile.sync.repo-name')).setDesc(t('mobile.sync.repo-name-desc')).addText((x) => plain(x).setValue(form.name).onChange((v) => { form.name = v.trim(); }));
      }
      new Setting(rest).addButton((b) => b.setButtonText(t('mobile.sync.connect')).setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          let url = form.url;
          if (found.canList) url = form.repo === NEW ? (await call('sync.createRepo', form)).url : form.repo;
          if (!url) { app.notice(t('mobile.sync.need-all')); return; }
          await connect(url);
        } catch (e) { app.notice(t('mobile.sync.failed', { error: failure(e) }), 9000); } finally { b.setDisabled(false); }
      }));
    };
    drawTop();
  }

  class SyncModal extends Modal {
    onOpen() {
      this.setTitle(t('mobile.sync.title'));
      const draw = () => render(this.contentEl, draw).catch((e) => this.contentEl.setText(String(e.message || e)));
      draw();
    }
  }
  const openSync = () => new SyncModal(app).open();
  app.renderSyncSettings = (el) => { const draw = () => render(el, draw).catch((e) => el.setText(String(e.message || e))); draw(); return true; };

  // ------------------------------------------------------------- commands and timing
  app.on('ready', async () => {
    for (const id of ['sync:open', 'sync:commit-and-push']) app.commands.removeCommand?.(id);
    app.commands.addCommand({ id: 'sync:open', name: t('mobile.sync.title'), callback: openSync });
    app.commands.addCommand({ id: 'sync:commit-and-push', name: t('mobile.sync.now'), checkCallback: (check) => {
      if (!st.linked) return false;
      if (!check) syncNow({ quiet: false });
      return true;
    } });
    for (const ev of ['modify', 'create', 'delete', 'rename']) app.vault.on(ev, changed);
    await refresh();
    if (st.linked && st.auto) setTimeout(() => syncNow(), 1500);
  });
  onBackend('sync', () => { if (!busy) refresh(); });
  native.on('app.resume', () => { if (st.linked && st.auto && Date.now() - lastTry > AFTER_RESUME) syncNow(); });
  // leaving the app with changes not sent yet: send them now, as far as Android lets the app work
  native.on('app.pause', () => { if (st.linked && st.auto && changeTimer) syncNow(); });
}

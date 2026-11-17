// sk_notes for Android – SKAI settings.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A phone does not run the AI model. SKAI works when the phone is on the same network as
// a PC running Skorpion OS (or any Ollama with an open endpoint): its address is set
// here, and away from that network SKAI is simply offline while everything else works.

import { call } from './api.js';
import { t } from '@desktop/core/i18n.js';
import { buildIndex } from '@desktop/skai/skai.js';
import { Setting } from '@desktop/ui/kit.js';

async function render(app, el) {
  const s = app.settings;
  el.empty();
  el.createEl('p', { cls: 'setting-item-description', text: t('mobile.skai.intro') });
  new Setting(el).setName(t('skai.enable')).setDesc(t('skai.enable-desc')).addToggle((tg) => tg.setValue(s.get('skaiEnabled') !== false).onChange((v) => s.set('skaiEnabled', v)));

  const cfg = await call('ai.config');
  let host = cfg.host;
  new Setting(el).setName(t('mobile.skai.pc')).setHeading();
  const save = async () => {
    try { await call('ai.setConfig', { host }); } catch { app.notice(t('mobile.skai.bad-host')); return; }
    await render(app, el);
  };
  new Setting(el).setName(t('mobile.skai.host')).setDesc(t('mobile.skai.host-desc', { port: cfg.defaultPort }))
    .addText((x) => {
      x.setPlaceholder('192.168.1.20').setValue(host).onChange((v) => { host = v; });
      x.inputEl.setAttr('inputmode', 'url');
      x.inputEl.setAttr('autocapitalize', 'off');
      x.inputEl.setAttr('autocomplete', 'off');
      x.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    })
    .addButton((b) => b.setButtonText(t('mobile.skai.save')).setCta().onClick(save));

  const found = el.createDiv('skai-discover');
  new Setting(el).setName(t('mobile.skai.find')).setDesc(t('mobile.skai.find-desc')).addButton((b) => b.setButtonText(t('mobile.skai.find-button')).onClick(async () => {
    b.setDisabled(true);
    found.empty();
    found.createDiv({ cls: 'setting-item-description', text: t('mobile.skai.finding') });
    let list = [];
    try { list = await call('ai.discover'); } catch (e) { app.notice(t('mobile.skai.find-failed', { error: e.detail || e.code })); }
    found.empty();
    if (!list.length) found.createDiv({ cls: 'setting-item-description', text: t('mobile.skai.none-found') });
    for (const pc of list) {
      new Setting(found).setName(pc.name ? `${pc.name} (${pc.host})` : pc.host).setDesc(pc.version ? `Ollama ${pc.version}` : 'Ollama')
        .addButton((x) => x.setButtonText(t('mobile.skai.use')).setCta().onClick(async () => { host = pc.host; await save(); }));
    }
    b.setDisabled(false);
  }));
  el.appendChild(found);

  const st = await app.skai.refreshStatus();
  const info = new Setting(el).setName(t('skai.connection'));
  if (!cfg.host) info.setDesc(t('mobile.skai.not-set'));
  else if (st.online) info.setDesc(t('skai.connected', { host: st.host, model: st.chatModel || '—', embed: st.embedModel || t('skai.none') }));
  else info.setDesc(t('mobile.skai.offline', { host: st.host || cfg.url || cfg.host }));
  info.addButton((b) => b.setButtonText(t('skai.check')).onClick(() => render(app, el)));

  if (st.online) {
    const models = { '': t('mobile.skai.model-auto') };
    for (const m of st.chatModels || st.models || []) models[m] = m;
    if (cfg.model && !models[cfg.model]) models[cfg.model] = cfg.model;
    new Setting(el).setName(t('mobile.skai.model')).setDesc(t('mobile.skai.model-desc')).addDropdown((d) => d.addOptions(models).setValue(cfg.model || '').onChange(async (v) => {
      await call('ai.setConfig', { model: v });
      await render(app, el);
    }));
    const idx = st.index;
    new Setting(el).setName(t('skai.index')).setDesc(idx ? t('skai.index-status', { notes: idx.notes, chunks: idx.chunks, model: idx.model || t('skai.none') }) : t('skai.index-desc'))
      .addButton((b) => b.setButtonText(t('skai.index-build')).onClick(() => buildIndex(app)))
      .addExtraButton((b) => b.setIcon('stop').setTooltip(t('skai.index-stop')).onClick(() => call('ai.index.stop')));
  }
  new Setting(el).setName(t('mobile.skai.help')).setHeading();
  el.createEl('p', { cls: 'setting-item-description', text: t('mobile.skai.help-text') });
  el.createEl('pre', { cls: 'skai-help-code', text: 'sudo systemctl edit ollama\n\n[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0"\n\nsudo systemctl restart ollama' });
  el.createEl('p', { cls: 'setting-item-description', text: t('mobile.skai.privacy') });
  el.createEl('p', { cls: 'setting-item-description', text: t('skai.model-note') });
}

export function installSkaiSettings(app) {
  if (!app.skai) return;
  app.skai.renderSettings = (el) => { render(app, el).catch((e) => { console.error(e); el.setText(String(e.message || e)); }); return true; };
}

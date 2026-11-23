// sk_notes for Android – the settings of spell checking: the choice in the Editor page, and the
// page of the sk_notes checker (languages to download, what it does, personal words).
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later

import { call } from '../api.js';
import { getLanguage, t } from '@desktop/core/i18n.js';
import { Setting } from '@desktop/ui/kit.js';
import { reloadSpell, removeWord } from './checker.js';

const mb = (bytes) => (bytes / 1048576 < 0.95 ? `${Math.max(0.1, Math.round(bytes / 104857.6) / 10)} MB` : `${Math.round(bytes / 104857.6) / 10} MB`);

function languageName(code) {
  try {
    const name = new Intl.DisplayNames([getLanguage() || 'en'], { type: 'language' }).of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase() + name.slice(1);
  } catch { /* a code Intl does not know */ }
  return code;
}

function errorText(e) {
  if (e?.code === 'spell-bad-engine') return t('mobile.spell.bad-engine');
  return t('mobile.spell.download-failed', { error: e?.detail || e?.code || String(e?.message || e) });
}

/** Turn the checker of the phone keyboard (the editor's "spellcheck") on or off with the mode. */
async function setMode(app, mode) {
  await call('spell.setConfig', { config: { mode } });
  if (!!app.settings.get('spellcheck') !== (mode === 'system')) app.settings.set('spellcheck', mode === 'system');
  await reloadSpell();
}

/** In the Editor page, in place of the on/off switch: off, the keyboard's checker, or sk_notes'. */
export function renderSpellChoice(app, el, modal) {
  const s = new Setting(el).setName(t('mobile.spell.choice')).setDesc(t('mobile.spell.choice-desc'));
  call('spell.state').then((st) => {
    const mode = st.config.mode === 'off' && app.settings.get('spellcheck') ? 'system' : st.config.mode;
    s.addDropdown((d) => d
      .addOption('off', t('mobile.spell.mode-off'))
      .addOption('system', t('mobile.spell.mode-system'))
      .addOption('sknotes', t('mobile.spell.mode-sknotes'))
      .setValue(mode)
      .onChange(async (v) => {
        await setMode(app, v);
        if (v === 'sknotes') modal.openTabById('spell'); // languages to download, options
      }));
    s.addExtraButton((b) => b.setIcon('settings').setTooltip(t('mobile.spell.configure')).onClick(() => modal.openTabById('spell')));
  }).catch((e) => s.setDesc(String(e.message || e)));
}

/** The page of the sk_notes checker. */
export function renderSpellSettings(app, el) {
  let busy = null; // the language being downloaded
  const draw = async () => {
    const st = await call('spell.state');
    const cfg = st.config;
    el.empty();
    el.createEl('p', { cls: 'setting-item-description', text: t('mobile.spell.intro') });
    new Setting(el).setName(t('mobile.spell.enable')).setDesc(t('mobile.spell.enable-desc'))
      .addToggle((tg) => tg.setValue(cfg.mode === 'sknotes').onChange(async (v) => { await setMode(app, v ? 'sknotes' : 'off'); draw(); }));

    // ---- languages
    new Setting(el).setName(t('mobile.spell.languages')).setHeading();
    const have = st.dictionaries.filter((d) => d.installed).sort((a, b) => languageName(a.code).localeCompare(languageName(b.code)));
    if (!have.length) el.createDiv({ cls: 'setting-item-description mobile-spell-empty', text: t('mobile.spell.no-languages') });
    for (const d of have) {
      new Setting(el).setName(languageName(d.code)).setDesc(`${d.code} · ${mb(d.size)} · ${t('mobile.spell.licence', { license: d.license })}`)
        .addToggle((tg) => tg.setTooltip(t('mobile.spell.in-use')).setValue(cfg.langs.includes(d.code)).onChange(async (v) => {
          const langs = v ? [...cfg.langs, d.code] : cfg.langs.filter((x) => x !== d.code);
          await call('spell.setConfig', { config: { langs } });
          await reloadSpell();
          draw();
        }))
        .addExtraButton((b) => b.setIcon('trash').setTooltip(t('mobile.spell.remove')).onClick(async () => {
          await call('spell.remove', { code: d.code });
          await reloadSpell();
          draw();
        }));
    }
    const rest = st.dictionaries.filter((d) => !d.installed).map((d) => ({ ...d, name: languageName(d.code) })).sort((a, b) => a.name.localeCompare(b.name));
    if (rest.length) {
      const mine = (getLanguage() || 'en').toLowerCase();
      let pick = (rest.find((d) => d.code.toLowerCase() === mine) || rest.find((d) => d.code.toLowerCase() === mine.split('-')[0]) || rest[0]).code;
      const add = new Setting(el).setName(t('mobile.spell.add'))
        .setDesc(st.engine.installed ? '' : t('mobile.spell.add-desc', { size: mb(st.engine.size) }));
      add.addDropdown((dd) => {
        for (const d of rest) dd.addOption(d.code, `${d.name} (${mb(d.size)})`);
        dd.setValue(pick).onChange((v) => { pick = v; });
        dd.selectEl.addClass('mobile-spell-pick');
      });
      add.addButton((b) => {
        b.setButtonText(busy ? t('mobile.spell.downloading') : t('mobile.spell.download')).setCta().setDisabled(!!busy).onClick(async () => {
          busy = pick;
          b.setButtonText(t('mobile.spell.downloading')).setDisabled(true);
          try {
            await call('spell.install', { code: pick });
            // the first language: the sk_notes checker is what the user wants
            if ((await call('spell.state')).config.mode !== 'sknotes') await setMode(app, 'sknotes'); else await reloadSpell();
          } catch (e) { app.notice(errorText(e)); }
          busy = null;
          draw();
        });
      });
    }

    // ---- what it does
    new Setting(el).setName(t('mobile.spell.behaviour')).setHeading();
    const opt = (key, name, desc) => new Setting(el).setName(name).setDesc(desc || '').addToggle((tg) => tg.setValue(!!cfg[key]).onChange(async (v) => {
      await call('spell.setConfig', { config: { [key]: v } });
      await reloadSpell();
    }));
    opt('underline', t('mobile.spell.underline'), t('mobile.spell.underline-desc'));
    opt('suggest', t('mobile.spell.suggest'), t('mobile.spell.suggest-desc'));
    opt('autocorrect', t('mobile.spell.autocorrect'), t('mobile.spell.autocorrect-desc'));
    opt('ignoreCaps', t('mobile.spell.ignore-caps'));

    // ---- personal words
    new Setting(el).setName(t('mobile.spell.personal')).setHeading();
    if (!st.words.length) el.createDiv({ cls: 'setting-item-description mobile-spell-empty', text: t('mobile.spell.personal-empty') });
    for (const w of st.words) new Setting(el).setName(w).addExtraButton((b) => b.setIcon('x').setTooltip(t('mobile.spell.remove')).onClick(async () => { await removeWord(w); draw(); }));

    // ---- the engine
    new Setting(el).setName(t('mobile.spell.engine')).setHeading();
    new Setting(el).setName('Hunspell').setDesc(t('mobile.spell.engine-desc', { version: st.engine.version, size: mb(st.engine.size) }) + ' ' +
      (st.engine.installed ? t('mobile.spell.engine-ready') : t('mobile.spell.engine-missing')));
  };
  draw().catch((e) => el.setText(String(e.message || e)));
  return true;
}

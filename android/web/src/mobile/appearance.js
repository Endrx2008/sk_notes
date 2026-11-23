// sk_notes for Android – the Appearance page of the settings, as a phone needs it.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Same options as on the PC, with two differences: the base theme (dark/light) is offered only
// when the community theme in use has both looks (a theme with one look ignores it), and fonts
// are chosen from a list of those the phone has, instead of typing their names.

import { call } from './api.js';
import { t } from '@desktop/core/i18n.js';
import { Setting } from '@desktop/ui/kit.js';

/** The looks a theme's CSS defines: {dark, light} (a theme without either has one look). */
export function themeLooks(css) {
  const s = String(css || '');
  return { dark: /\.theme-dark\b/.test(s), light: /\.theme-light\b/.test(s) };
}

// Fonts a phone may have (Android's own, Google's, common in themes) and the generic families.
const TEXT_FONTS = ['Roboto', 'Noto Sans', 'Noto Serif', 'Source Sans Pro', 'Open Sans', 'Lato', 'Inter', 'Carrois Gothic', 'Coming Soon', 'Dancing Script', 'Cutive Mono'];
const MONO_FONTS = ['Roboto Mono', 'Droid Sans Mono', 'Noto Sans Mono', 'Source Code Pro', 'JetBrains Mono', 'Fira Code', 'Cutive Mono'];
const GENERIC_TEXT = ['sans-serif', 'serif', 'sans-serif-condensed', 'sans-serif-light', 'sans-serif-medium', 'serif-monospace', 'casual', 'cursive'];
const GENERIC_MONO = ['monospace', 'serif-monospace'];

let measure = null;
/** True when the phone draws `font` (its letters differ from both fallback families). */
function hasFont(font) {
  if (!measure) measure = document.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmmlli1WQ@#';
  const width = (f) => { measure.font = `32px ${f}`; return measure.measureText(sample).width; };
  for (const base of ['monospace', 'serif', 'sans-serif']) {
    if (width(`"${font}", ${base}`) !== width(base)) return true;
  }
  return false;
}

function fontOptions(names, generic, current) {
  const opts = { '': t('mobile.fonts.default') };
  for (const f of names) if (hasFont(f)) opts[`"${f}"`] = f;
  for (const g of generic) opts[g] = g;
  if (current && !(current in opts)) opts[current] = current; // a name typed on the PC stays
  return opts;
}

export async function renderAppearance(modal, el) {
  const a = modal.app;
  const s = a.settings;
  const theme = s.get('cssTheme') || '';
  const looks = a.themeLooks || { dark: true, light: true };
  if (!theme || (looks.dark && looks.light)) {
    modal.dropdown(el, 'theme', t('settings.base-theme'), t('settings.base-theme-desc'), { skai: t('settings.theme-skai'), dark: t('settings.theme-dark'), light: t('settings.theme-light') });
  } else {
    // one look only: the base theme would change nothing
    const which = looks.dark ? t('mobile.theme.only-dark', { theme }) : looks.light ? t('mobile.theme.only-light', { theme }) : t('mobile.theme.only-one', { theme });
    new Setting(el).setName(t('settings.base-theme')).setDesc(which);
  }
  new Setting(el).setName(t('settings.font-size')).setDesc(t('settings.font-size-desc')).addSlider((sl) => sl.setLimits(10, 30, 1).setValue(s.get('baseFontSize') || 16).setDynamicTooltip().onChange((v) => s.set('baseFontSize', v)));
  modal.dropdown(el, 'textFont', t('settings.text-font'), t('mobile.fonts.text-desc'), fontOptions(TEXT_FONTS, GENERIC_TEXT, s.get('textFont') || ''));
  modal.dropdown(el, 'monospaceFont', t('settings.mono-font'), t('mobile.fonts.mono-desc'), fontOptions(MONO_FONTS, GENERIC_MONO, s.get('monospaceFont') || ''));
  for (const sel of el.querySelectorAll('select')) sel.querySelectorAll('option').forEach((o) => { if (o.value && o.value !== 'skai' && o.value !== 'dark' && o.value !== 'light') o.style.fontFamily = o.value; });
  new Setting(el).setName(t('settings.zoom')).setDesc(t('settings.zoom-desc')).addSlider((sl) => sl.setLimits(50, 200, 10).setValue(Math.round((a.info.zoom || 1) * 100)).setDynamicTooltip().onChange((v) => a.changeZoom(v / 100 - (a.info.zoom || 1))));

  modal.heading(el, t('settings.themes'));
  const themes = await call('config.list', { kind: 'themes' }).catch(() => []);
  const opts = { '': t('settings.theme-none') };
  for (const th of themes) opts[th] = th;
  new Setting(el).setName(t('settings.community-theme')).setDesc(t('settings.community-theme-desc')).addDropdown((d) => d.addOptions(opts).setValue(theme).onChange(async (v) => {
    s.set('cssTheme', v);
    await a.loadCss?.(); // its looks decide whether the base theme is offered
    modal.openTabById('appearance');
  }));
  if (a.browseThemes) {
    new Setting(el).setName(t('mobile.themes.title')).setDesc(t('mobile.themes.desc'))
      .addButton((b) => b.setButtonText(t('mobile.plugins.browse-button')).setCta().onClick(() => a.browseThemes(async () => { await a.loadCss?.(); modal.openTabById('appearance'); })));
  }
  modal.heading(el, t('settings.snippets'));
  const snippets = await call('config.list', { kind: 'snippets' }).catch(() => []);
  new Setting(el).setName(t('settings.snippets-folder')).setDesc(t('settings.snippets-desc'))
    .addExtraButton((b) => b.setIcon('refresh').setTooltip(t('settings.reload')).onClick(() => { a.loadCss?.(); modal.openTabById('appearance'); }));
  for (const sn of snippets) {
    new Setting(el).setName(sn.replace(/\.css$/, '')).addToggle((tg) => tg.setValue((s.get('enabledCssSnippets') || []).includes(sn)).onChange((v) => {
      const list = new Set(s.get('enabledCssSnippets') || []);
      if (v) list.add(sn); else list.delete(sn);
      s.set('enabledCssSnippets', [...list]);
    }));
  }
}

/** The Files page without "static site" (not on Android). */
export function withoutPublish(el) {
  const name = t('settings.publish');
  for (const item of el.querySelectorAll('.setting-item')) {
    if (item.querySelector('.setting-item-name')?.textContent.trim() === name) item.remove();
  }
  // the heading "Sync and publishing" keeps only the sync
  for (const h of el.querySelectorAll('.setting-item-heading .setting-item-name')) {
    if (h.textContent.trim() === t('settings.sync-publish')) h.setText(t('settings.git'));
  }
}

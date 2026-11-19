// sk_notes for Android – entry point of the page.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
import moment from 'moment';
import { installDomHelpers } from '@desktop/core/dom.js';
import { setStrings, t, errorText } from '@desktop/core/i18n.js';
import { applyTheme } from '@desktop/core/theme.js';
import { installTooltips } from '@desktop/ui/kit.js';
import { call, onBackend } from './api.js';
import { installDevice } from './device.js';

performance.mark('skn:script');
window.moment = moment;
installDomHelpers(window);

async function boot() {
  const info = await call('app.info');
  performance.mark('skn:info');
  setStrings(info.language, info.strings);
  moment.locale(info.language.toLowerCase());
  document.body.addClass('sk-notes', 'is-mobile', 'is-android');
  installDevice(info);
  applyTheme(info.theme, 'skai');
  installTooltips();
  const root = document.getElementById('sk-root');
  if (!info.vault || location.hash === '#vaults') {
    document.body.addClass('is-vault-manager');
    onBackend('skai-theme', (d) => applyTheme(d.theme, 'skai'));
    const { renderStartScreen } = await import('./vaults.js');
    root.empty();
    renderStartScreen(root.createDiv('vault-manager-page'), info);
    document.title = t('vaults.title') + ' – sk_notes';
    call('app.ready').catch(() => {});
    return;
  }
  const [{ App }, plugins, skai, extras, mobile] = await Promise.all([
    import('@desktop/app/app.js'),
    import('@desktop/plugins/manager.js'),
    import('@desktop/skai/skai.js'),
    import('@desktop/features/extras.js'),
    import('./mobile.js'),
  ]);
  performance.mark('skn:modules');
  const app = new App(info);
  app.isMobile = true;
  plugins.installPluginManager(app);
  skai.installSkai(app);
  extras.installExtras(app);
  mobile.installMobile(app, info);
  root.empty();
  await app.start(root);
  document.body.addClass('is-ready');
  window.__sknReady = true;
  const marks = Object.fromEntries(performance.getEntriesByType('mark').filter((m) => m.name.startsWith('skn:'))
    .map((m) => [m.name.slice(4), Math.round(m.startTime)]));
  call('app.ready', { pageMs: performance.now(), marks }).catch(() => {});
}

boot().catch((e) => {
  console.error(e);
  const root = document.getElementById('sk-root') || document.body;
  root.textContent = 'sk_notes failed to start: ' + ((e && errorText(e)) || e);
  root.style.cssText = 'padding:24px;user-select:text;white-space:pre-wrap';
});

// sk_notes web entry point.
import moment from 'moment';
import { installDomHelpers } from './core/dom.js';
import { call, onBackend } from './core/api.js';
import { setStrings, t } from './core/i18n.js';
import { applyTheme } from './core/theme.js';
import { installTooltips } from './ui/kit.js';

performance.mark('skn:script');
window.moment = moment;
installDomHelpers(window);

async function boot() {
  const info = await call('app.info');
  performance.mark('skn:info');
  setStrings(info.language, info.strings);
  moment.locale(info.language.toLowerCase());
  document.body.addClass('sk-notes', 'mod-linux', 'is-frameless');
  applyTheme(info.theme, 'skai');
  installTooltips();
  const root = document.getElementById('sk-root');
  if (!info.vault || location.hash === '#vaults') {
    document.body.addClass('is-vault-manager');
    onBackend('skai-theme', (d) => applyTheme(d.theme, 'skai'));
    const { renderVaultManager } = await import('./ui/vaults.js');
    renderVaultManager(root.createDiv('vault-manager-page'));
    document.title = t('vaults.title') + ' – sk_notes';
    return;
  }
  const [{ App }, plugins, skai, extras] = await Promise.all([
    import('./app/app.js'),
    import('./plugins/manager.js'),
    import('./skai/skai.js'),
    import('./features/extras.js'),
  ]);
  performance.mark('skn:modules');
  const app = new App(info);
  plugins.installPluginManager(app);
  skai.installSkai(app);
  extras.installExtras(app);
  await app.start(root);
  document.body.addClass('is-ready');
  window.__sknReady = true;
  // start-up phases, logged by Python with the total time (see qa/startup_time.py)
  const marks = Object.fromEntries(performance.getEntriesByType('mark').filter((m) => m.name.startsWith('skn:'))
    .map((m) => [m.name.slice(4), Math.round(m.startTime)]));
  call('app.ready', { pageMs: performance.now(), marks }).catch(() => {});
}

boot().catch((e) => {
  console.error(e);
  document.body.textContent = 'sk_notes failed to start: ' + (e && (e.code || e.message) || e);
});

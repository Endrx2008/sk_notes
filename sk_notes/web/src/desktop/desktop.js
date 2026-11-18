// What only the desktop page has (the Android app has a page of its own, android/web/src/mobile):
// Git sync with GitHub/GitLab, encrypted vaults in the settings, several files chosen in the
// file list, community themes/plugins/templates, themes applied (built-in Anna.g_3 included),
// pictures saved with "Save as", the graph settings closing on a click outside them, Home and
// a tidier frame (chrome.js).

import { call } from '../core/api.js';
import { errorText, t } from '../core/i18n.js';
import { installCryptUi } from '../ui/crypt-ui.js';
import { installChrome } from './chrome.js';
import { installGallery } from './gallery.js';
import { installHome } from './home.js';
import { installMultiSelect } from './multiselect.js';
import { installSync } from './sync.js';
import { VAULT_BASE, VaultBaseView } from './vault-base.js';

const BUILT_IN = ['Anna.g_3']; // themes that come with sk_notes (web/themes)

export function installDesktop(app, info) {
  installHome(app);
  installVaultBase(app);
  installChrome(app);
  installThemes(app);
  installImages(app);
  installCryptUi(app, info);
  installMultiSelect(app);
  installGallery(app);
  installSync(app);
  installGraphControls();
}

/** The database of the vault is a way of looking at notes, not a file to make: the ribbon
 * and the menu of a folder open it instead of making a .base file (existing .base files open as always). */
function installVaultBase(app) {
  app.viewRegistry.registerView(VAULT_BASE, (leaf) => new VaultBaseView(leaf));
  app.on('ready', () => {
    const ribbon = app.workspace.leftRibbon;
    for (const it of ribbon.items.filter((x) => x.id === 'bases')) ribbon.removeItem(it.el);
    ribbon.addRibbonItemButton('vault-base', 'database', t('pc.home.database'), () => app.commands.executeCommandById('bases:vault-view'));
  });
  app.workspace.on('file-menu', (menu) => {
    const base = menu.items.find((it) => it.titleEl?.textContent === t('file.new-base'));
    if (base) { menu.items.remove(base); base.dom.remove(); }
  });
}

/** The CSS of the chosen community theme and of the enabled snippets (.sk_notes/themes, .sk_notes/snippets).
 * body.has-css-theme lets the interface take the theme's colours (50-desktop.css). */
function installThemes(app) {
  let run = 0;
  app.loadCss = async () => {
    const mine = ++run;
    const parts = [];
    const theme = app.settings.get('cssTheme') || '';
    if (theme) {
      let css = BUILT_IN.includes(theme) ? await fetch(`themes/${encodeURIComponent(theme)}/theme.css`).then((r) => (r.ok ? r.text() : null)).catch(() => null) : null;
      if (typeof css !== 'string') css = await call('config.read', { name: `themes/${theme}/theme.css` }).catch(() => null);
      if (typeof css === 'string') parts.push(css);
    }
    for (const name of app.settings.get('enabledCssSnippets') || []) {
      const css = await call('config.read', { name: `snippets/${name}` }).catch(() => null);
      if (typeof css === 'string') parts.push(css);
    }
    if (mine !== run) return;
    let el = document.getElementById('sk-theme-css');
    if (!el) { el = document.createElement('style'); el.id = 'sk-theme-css'; document.head.appendChild(el); }
    el.textContent = parts.join('\n');
    document.body.classList.toggle('has-css-theme', !!theme && parts.length > 0);
    app.workspace?.trigger('css-change');
  };
  app.loadCss();
}

/** Pictures made by a view (a canvas board, the graph): "Save as", then a way to the folder. */
function installImages(app) {
  app.saveImage = async (name, dataUrl) => {
    let path;
    try { path = await call('image.save', { name, data: dataUrl }); } catch (e) { app.notice(errorText(e)); return null; }
    if (!path) return null;
    const n = app.notice(createFragment((f) => {
      f.createDiv({ text: t('pc.picture-saved', { path }) });
      const row = f.createDiv('notice-buttons');
      row.createEl('button', { text: t('pc.picture-show') }).addEventListener('click', () => { n.hide(); call('image.showFolder', { path }).catch(() => {}); });
    }), 9000);
    return path;
  };
}

/** The settings panel of the graph closes on a click anywhere outside it. */
function installGraphControls() {
  document.addEventListener('pointerdown', (e) => {
    const inside = e.target.closest?.('.graph-controls');
    for (const el of document.querySelectorAll('.graph-controls:not(.is-close)')) if (el !== inside) el.addClass('is-close');
  }, true);
}

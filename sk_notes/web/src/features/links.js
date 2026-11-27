// sknotes:// links handed over by Python (event "open-uri").
// Built-in actions: open, new, search. Any other action goes to a handler registered
// by a plugin (registerObsidianProtocolHandler), with the same parameters.

import { onBackend } from '../core/api.js';
import { t, errorText } from '../core/i18n.js';
import { TFile } from '../model/vault.js';

const truthy = (v) => v !== undefined && v !== 'false' && v !== '0';

function findFile(app, name) {
  if (!name) return null;
  const clean = name.replace(/^\/+/, '');
  return app.vault.getFileByPath(clean) || app.vault.getFileByPath(clean + '.md')
    || app.metadataCache.getFirstLinkpathDest(clean.replace(/\.md$/, ''), '');
}

async function openAction(app, p) {
  const file = findFile(app, p.file);
  if (!file) {
    if (p.file) app.notice(t('embed.missing', { name: p.file }));
    return;
  }
  const leaf = app.workspace.getLeaf(truthy(p.newpane) ? 'tab' : false);
  await leaf.openFile(file, { active: true, eState: p.line ? { line: Math.max(0, Number(p.line) - 1) } : {} });
}

async function newAction(app, p) {
  const name = (p.file || p.name || '').replace(/^\/+/, '');
  const content = p.content || '';
  let file = name ? findFile(app, name) : null;
  if (file instanceof TFile && (truthy(p.append) || truthy(p.prepend) || truthy(p.overwrite))) {
    if (truthy(p.overwrite)) await app.vault.modify(file, content, { reason: 'link-overwrite' }); // old text kept in the history (B2-13)
    else await app.vault.process(file, (text) => (truthy(p.prepend) ? content + '\n' + text : text + (text.endsWith('\n') || !text ? '' : '\n') + content));
  } else if (name && name.includes('/')) {
    const path = name.endsWith('.md') ? name : name + '.md';
    file = await app.vault.create(app.vault.getAvailablePath?.(path.replace(/\.md$/, ''), 'md') || path, content);
  } else {
    file = await app.fileManager.createNewMarkdownFile(null, name || t('file.untitled'), content);
  }
  if (!truthy(p.silent) && file) await app.workspace.getLeaf(false).openFile(file, { active: true });
}

async function searchAction(app, p) {
  const leaf = await app.workspace.ensureSideLeaf('search', 'left', { reveal: true });
  leaf.view.setQuery(p.query || '');
}

// sknotes://graph?vault=… (a widget of the graph), sknotes://reminders?vault=… (the widget of the things to do)
const graphAction = (app) => app.workspace.onLayoutReady(() => app.commands.executeCommandById('graph:open'));
const remindersAction = (app) => app.workspace.onLayoutReady(() => app.commands.executeCommandById('reminders:open'));

const BUILTIN = { open: openAction, new: newAction, search: searchAction, graph: graphAction, reminders: remindersAction };

export function installLinkHandler(app) {
  onBackend('open-uri', async ({ action, params }) => {
    try {
      if (BUILTIN[action]) { await BUILTIN[action](app, params); return; }
      const handler = app.protocolHandlers?.[action] || app.workspace.protocolHandlers?.get?.(action);
      if (handler) await handler({ action, ...params });
      else console.warn('no handler for sknotes:// action', action);
    } catch (e) {
      console.error('sknotes:// link failed', action, e);
      app.notice(errorText(e));
    }
  });
}

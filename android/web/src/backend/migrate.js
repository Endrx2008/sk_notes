// sk_notes for Android – coming from another Markdown app.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Reads (never writes) the vault's ".obsidian" settings folder and offers to import
// settings, hotkeys, CSS and plugins into ".sk_notes". The original files and folders
// are left untouched. Same rules as the desktop app (sk_notes/extras/migrate.py).

import { native } from './native.js';
import { CONFIG_DIR } from './util.js';

const SOURCE_DIR = '.obsidian'; // folder name used by vaults made with that app

// settings that map 1:1 (names in its app.json → sk_notes app.json)
const APP_KEYS = {
  alwaysUpdateLinks: 'alwaysUpdateLinks', newFileLocation: 'newFileLocation', newFileFolderPath: 'newFileFolderPath',
  attachmentFolderPath: 'attachmentFolderPath', useMarkdownLinks: 'useMarkdownLinks', readableLineLength: 'readableLineLength',
  showInlineTitle: 'showInlineTitle', spellcheck: 'spellcheck', livePreview: 'livePreview', defaultViewMode: 'defaultViewMode',
  tabSize: 'tabSize', promptDelete: 'promptDelete', trashOption: 'trashOption', foldHeading: 'foldGutter',
  autoPairBrackets: 'autoPair', propertiesInDocument: 'propertiesInDocument',
};
const APPEARANCE_KEYS = { baseFontSize: 'baseFontSize', textFontFamily: 'textFont', monospaceFontFamily: 'monospaceFont',
  cssTheme: 'cssTheme', enabledCssSnippets: 'enabledCssSnippets', showRibbon: 'showRibbon' };
// hotkey command ids that differ (null = no such command here)
const COMMAND_IDS = { 'app:open-help': null, 'app:reload': null, 'workspace:toggle-pin': 'workspace:toggle-pin' };

const exists = (path) => native.sync('fs.exists', { path });
const isDir = (path) => native.sync('fs.stat', { path })?.type === 'dir';
const list = (path) => { try { return native.sync('fs.list', { path }).slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); } catch { return []; } };
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null);

function readJson(path) {
  try { return exists(path) ? JSON.parse(native.sync('fs.readText', { path }).text) : null; } catch { return null; }
}

function graphOptions(g) {
  const o = { search: g.search ?? '', showTags: g.showTags ?? false, showAttachments: g.showAttachments ?? false,
    hideUnresolved: g.hideUnresolved ?? true, showOrphans: g.showOrphans ?? true, showArrow: g.showArrow ?? false,
    textFadeMultiplier: g.textFadeMultiplier ?? 0, nodeSizeMultiplier: g.nodeSizeMultiplier ?? 1,
    lineSizeMultiplier: g.lineSizeMultiplier ?? 1, centerStrength: g.centerStrength ?? 0.5,
    repelStrength: g.repelStrength ?? 10, linkStrength: g.linkStrength ?? 1, linkDistance: g.linkDistance ?? 250 };
  o.colorGroups = [];
  for (const grp of Array.isArray(g.colorGroups) ? g.colorGroups : []) {
    const rgb = grp?.color?.rgb;
    if (Number.isInteger(rgb)) o.colorGroups.push({ query: grp.query ?? '', color: '#' + (rgb & 0xffffff).toString(16).padStart(6, '0') });
  }
  return o;
}

export function scan(vaultRoot) {
  const src = `${vaultRoot}/${SOURCE_DIR}`;
  if (!isDir(src)) return { found: false };
  const out = { found: true, items: [] };
  const app = obj(readJson(src + '/app.json')) || {};
  const appearance = obj(readJson(src + '/appearance.json')) || {};
  const settings = {};
  for (const [k, v] of Object.entries(app)) if (Object.hasOwn(APP_KEYS, k)) settings[APP_KEYS[k]] = v;
  if (app.trashOption === 'none') settings.trashOption = 'none';
  for (const [k, v] of Object.entries(appearance)) if (Object.hasOwn(APPEARANCE_KEYS, k)) settings[APPEARANCE_KEYS[k]] = v;
  if (appearance.theme === 'obsidian' || appearance.theme === 'moonstone') settings.theme = appearance.theme === 'obsidian' ? 'dark' : 'light';
  for (const [name, keymap] of [
    ['daily-notes.json', { folder: 'dailyNoteFolder', format: 'dailyNoteFormat', template: 'dailyNoteTemplate' }],
    ['templates.json', { folder: 'templatesFolder', dateFormat: 'templateDateFormat', timeFormat: 'templateTimeFormat' }],
    ['zk-prefixer.json', { format: 'uniqueNotePrefix', folder: 'uniqueNoteFolder' }]]) {
    const data = obj(readJson(`${src}/${name}`)) || {};
    for (const [k, v] of Object.entries(keymap)) if (data[k]) settings[v] = data[k];
  }
  if (Object.keys(settings).length) out.items.push({ id: 'settings', count: Object.keys(settings).length, data: settings });
  const hotkeys = obj(readJson(src + '/hotkeys.json')) || {};
  if (Object.keys(hotkeys).length) {
    const mapped = {};
    for (const [cmd, keys] of Object.entries(hotkeys)) {
      const target = Object.hasOwn(COMMAND_IDS, cmd) ? COMMAND_IDS[cmd] : cmd;
      if (target && Array.isArray(keys)) mapped[target] = keys.filter((k) => obj(k)).map((k) => ({ modifiers: k.modifiers ?? [], key: k.key ?? '' }));
    }
    out.items.push({ id: 'hotkeys', count: Object.keys(mapped).length, data: mapped });
  }
  const snippets = isDir(src + '/snippets') ? list(src + '/snippets').filter((e) => e.type === 'file' && e.name.endsWith('.css')).map((e) => e.name) : [];
  if (snippets.length) out.items.push({ id: 'snippets', count: snippets.length, data: snippets });
  const themes = isDir(src + '/themes') ? list(src + '/themes').filter((e) => exists(`${src}/themes/${e.name}/theme.css`)).map((e) => e.name) : [];
  if (themes.length) out.items.push({ id: 'themes', count: themes.length, data: themes });
  const plugins = [];
  const enabled = readJson(src + '/community-plugins.json');
  const on = Array.isArray(enabled) ? enabled : [];
  if (isDir(src + '/plugins')) {
    for (const d of list(src + '/plugins')) {
      const m = obj(readJson(`${src}/plugins/${d.name}/manifest.json`));
      if (m && exists(`${src}/plugins/${d.name}/main.js`)) {
        plugins.push({ dir: d.name, id: m.id ?? null, name: m.name ?? null, enabled: on.includes(d.name) || on.includes(m.id), desktopOnly: !!m.isDesktopOnly });
      }
    }
  }
  if (plugins.length) out.items.push({ id: 'plugins', count: plugins.length, data: plugins });
  const bookmarks = obj(readJson(src + '/bookmarks.json'));
  if (bookmarks && Array.isArray(bookmarks.items) && bookmarks.items.length) out.items.push({ id: 'bookmarks', count: bookmarks.items.length, data: bookmarks });
  const graph = obj(readJson(src + '/graph.json'));
  if (graph && Object.keys(graph).length) out.items.push({ id: 'graph', count: 1, data: graphOptions(graph) });
  return out;
}

function copyTree(from, to) {
  native.sync('fs.mkdirs', { path: to });
  for (const e of list(from)) {
    if (e.type === 'dir') copyTree(`${from}/${e.name}`, `${to}/${e.name}`);
    else native.sync('fs.writeB64', { path: `${to}/${e.name}`, b64: native.sync('fs.readB64', { path: `${from}/${e.name}` }) });
  }
}

/** Copy the chosen items into .sk_notes. Reads from the source folder only. */
export function apply(service, itemIds) {
  const root = service.vault.root;
  const src = `${root}/${SOURCE_DIR}`;
  const found = new Map((scan(root).items || []).map((i) => [i.id, i]));
  const dest = `${root}/${CONFIG_DIR}`;
  const done = {};
  for (const id of itemIds) {
    const item = found.get(id);
    if (!item) continue;
    if (id === 'settings') {
      const lookKeys = new Set([...Object.values(APPEARANCE_KEYS), 'theme']);
      const appCfg = obj(service.configRead('app.json', {})) || {};
      const look = obj(service.configRead('appearance.json', {})) || {};
      for (const [k, v] of Object.entries(item.data)) (lookKeys.has(k) ? look : appCfg)[k] = v;
      service.configWrite('app.json', appCfg);
      service.configWrite('appearance.json', look);
    } else if (id === 'hotkeys') {
      service.configWrite('hotkeys.json', { ...(obj(service.configRead('hotkeys.json', {})) || {}), ...item.data });
    } else if (id === 'snippets') {
      native.sync('fs.mkdirs', { path: dest + '/snippets' });
      for (const name of item.data) native.sync('fs.writeB64', { path: `${dest}/snippets/${name}`, b64: native.sync('fs.readB64', { path: `${src}/snippets/${name}` }) });
    } else if (id === 'themes') {
      for (const name of item.data) copyTree(`${src}/themes/${name}`, `${dest}/themes/${name}`);
    } else if (id === 'plugins') {
      const en = service.configRead('community-plugins.json', []);
      const enabled = Array.isArray(en) ? en.slice() : [];
      for (const p of item.data) {
        copyTree(`${src}/plugins/${p.dir}`, `${dest}/plugins/${p.dir}`);
        if (p.enabled && !enabled.includes(p.dir)) enabled.push(p.dir);
      }
      service.configWrite('community-plugins.json', enabled);
    } else if (id === 'bookmarks') service.configWrite('bookmarks.json', item.data);
    else if (id === 'graph') service.configWrite('graph.json', item.data);
    done[id] = item.count;
  }
  return done;
}

const ADOPTED = 'adopted.json'; // in .sk_notes: the settings of the other app were taken once

/** The first time a vault made with that app opens here: its settings, themes, snippets,
 * bookmarks, graph and hotkeys are used straight away (copied into .sk_notes; its own folder
 * is only read). Community plugins are code: they stay a choice of the user (the migration
 * dialog). Returns what was taken, or null. */
export function adopt(service) {
  const root = service.vault.root;
  if (!isDir(`${root}/${SOURCE_DIR}`) || exists(`${root}/${CONFIG_DIR}/${ADOPTED}`)) return null;
  const res = scan(root);
  const ids = (res.items || []).map((i) => i.id).filter((id) => id !== 'plugins');
  const done = apply(service, ids);
  const app = obj(readJson(`${root}/${SOURCE_DIR}/app.json`)) || {};
  const cfg = obj(service.configRead('app.json', {})) || {};
  // that app shows the file name as the title of a note: no "# Name" heading in new notes
  if (app.showInlineTitle !== false && cfg.newNoteHeading === undefined) cfg.newNoteHeading = false;
  cfg.migrationOffered = true; // nothing left to propose but the plugins (see the page)
  service.configWrite('app.json', cfg);
  const plugins = (res.items || []).find((i) => i.id === 'plugins')?.data || [];
  const info = { at: Date.now(), from: 'Obsidian', taken: done, plugins: plugins.map((p) => p.name || p.id || p.dir) };
  service.configWrite(ADOPTED, info);
  return info;
}

/** The app a vault was made with, when it is not sk_notes: 'Obsidian', 'Logseq' or null. */
export function foreignApp(root) {
  if (isDir(`${root}/${SOURCE_DIR}`)) return 'Obsidian';
  if (exists(`${root}/logseq/config.edn`)) return 'Logseq';
  return null;
}

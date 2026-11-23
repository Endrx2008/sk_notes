// sk_notes for Android – import, migration, sync status, static site publishing, PDF export.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later

import { runImport } from './importers.js';
import * as migrate from './migrate.js';
import { native } from './native.js';
import * as permissions from './permissions.js';
import { route } from './router.js';
import { askFolder } from './routes-core.js';
import { roots, state, svc, t } from './state.js';
import { ApiError, normpath, textToB64 } from './util.js';

const PICK_MIME = {
  enex: ['application/xml', 'text/xml', 'application/octet-stream', '*/*'], notion: ['application/zip', 'application/x-zip-compressed', '*/*'],
  html: ['text/html', '*/*'], roam: ['application/json', '*/*'], csv: ['text/csv', 'text/comma-separated-values', 'text/tab-separated-values', '*/*'],
  textbundle: ['application/zip', 'application/octet-stream', '*/*'],
};

export function registerExtras() {
  const r = route;
  const appOnly = (ctx) => { if (ctx.plugin) throw new ApiError('permission-denied'); };

  // ------------------------------------------------------------- import
  r('import.pick', async (p) => {
    if (p.folder) {
      const f = await askFolder({ title: p.title || '' });
      if (f) permissions.rememberPath(f);
      return f || null;
    }
    const kind = Object.keys(PICK_MIME).find((k) => String(p.filter || '').toLowerCase().includes(k === 'notion' ? '*.zip' : k === 'roam' ? '*.json' : `*.${k}`));
    const files = await native.async('ui.pickFiles', { multiple: false, mime: PICK_MIME[kind] || ['*/*'] });
    const f = files && files[0] ? files[0].path : null;
    if (f) permissions.rememberPath(f);
    return f;
  });

  r('import.run', async (p, ctx) => {
    appOnly(ctx);
    const src = String(p.source || '').replace(/\/+$/, '');
    if (!native.sync('fs.exists', { path: src })) throw new ApiError('not-found', src);
    if (!permissions.chosen(src)) throw new ApiError('permission-denied', src); // only what the user picked
    const s = svc();
    const root = s.vault.root;
    if (src === root || src.startsWith(root + '/')) throw new ApiError('source-inside-vault');
    const target = String(p.folder || '').replace(/^\/+|\/+$/g, '');
    const tmp = roots().cache + '/import';
    let count = 0;
    let notes = 0;
    const errors = [];
    try {
      await runImport(p.format, src, tmp, (item) => {
        const rel = item.path.replace(/^\/+|\/+$/g, '');
        const slash = rel.lastIndexOf('/');
        const name = rel.slice(slash + 1);
        const dot = name.lastIndexOf('.');
        const hasExt = dot > 0;
        const folder = [target, slash === -1 ? '' : rel.slice(0, slash)].filter(Boolean).join('/');
        try {
          const path = s.vault.availablePath(folder, (hasExt ? name.slice(0, dot) : name) || 'Untitled', hasExt ? name.slice(dot + 1) : '');
          if (path.endsWith('.md') && typeof item.text === 'string') {
            s.write(path, item.text, { reason: 'import' });
            notes += 1;
          } else s.writeBinary(path, item.b64 ?? textToB64(item.text ?? ''));
          count += 1;
        } catch (e) { errors.push(`${rel}: ${e.code || e.message || e}`); } // keep importing the rest
      });
    } catch (e) {
      console.error('import failed', e);
      throw new ApiError(e.code === 'bad-format' || e.code === 'not-a-folder' ? e.code : 'import-failed', e.detail || String(e.message || e));
    } finally {
      try { native.sync('fs.delete', { path: tmp, recursive: true }); } catch { /* nothing unpacked */ }
    }
    return { files: count, notes, errors: errors.slice(0, 20) };
  });

  // ------------------------------------------------------------- migration
  r('migration.scan', () => {
    const res = migrate.scan(svc().vault.root);
    for (const item of res.items || []) {
      if (['settings', 'hotkeys', 'bookmarks', 'graph'].includes(item.id)) item.preview = item.id !== 'bookmarks' ? item.data : null;
    }
    return res;
  });

  // ------------------------------------------------------------- vaults made with another app
  const ackFile = () => roots().private + '/foreign-ack.json';
  const acks = () => { try { const v = JSON.parse(native.sync('fs.readText', { path: ackFile() }).text); return Array.isArray(v) ? v : []; } catch { return []; } };

  /** {app, ack, adopted}: the app the open vault was made with (null for sk_notes), whether the
   * user asked not to be warned again for it, and what was taken from it at this start. */
  r('vault.foreign', () => {
    const root = svc().vault.root;
    const app = migrate.foreignApp(root);
    const adopted = state.adopted || null;
    state.adopted = null; // told once
    return { app, ack: !app || acks().includes(root), adopted };
  });

  r('vault.foreignAck', (p, ctx) => {
    appOnly(ctx);
    const root = svc().vault.root;
    const list = acks().filter((x) => x !== root);
    list.push(root);
    native.sync('fs.writeText', { path: ackFile(), text: JSON.stringify(list) });
    return true;
  });

  r('migration.apply', (p, ctx) => {
    appOnly(ctx);
    return migrate.apply(svc(), Array.isArray(p.items) ? p.items : []);
  });

  // ------------------------------------------------------------- git / Syncthing
  // No git program exists on Android: the vault is synced by a sync app working on the
  // same folder (Syncthing-Fork, FolderSync...) or by a community plugin.
  r('git.status', () => ({ available: false, android: true }));
  for (const name of ['git.init', 'git.commit', 'git.pull', 'git.push', 'git.setRemote']) r(name, () => { throw new ApiError('git-missing', t('mobile.no-git')); });
  r('syncthing.status', () => ({ installed: !!native.sync('sys.hasApp', { packages: ['com.github.catfriend1.syncthingandroid', 'com.github.catfriend1.syncthingfork', 'com.nutomic.syncthingandroid'] }), configured: false, android: true }));

  // ------------------------------------------------------------- static site
  r('publish.pickFolder', async (p) => {
    const f = await askFolder({ title: p.title || '', create: true });
    if (f) permissions.rememberPath(f, true);
    return f || null;
  });

  r('publish.write', (p, ctx) => {
    appOnly(ctx);
    const out = normpath(String(p.folder || ''));
    const root = svc().vault.root;
    if (out === root || out.startsWith(root + '/')) throw new ApiError('output-inside-vault');
    if (!out.startsWith('/') || !permissions.chosen(out)) throw new ApiError('permission-denied', out); // a folder the user picked, never one the page names
    native.sync('fs.mkdirs', { path: out });
    const files = Array.isArray(p.files) ? p.files : [];
    for (const f of files) {
      const rel = String(f.path || '');
      if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) throw new ApiError('bad-path', rel);
      const target = `${out}/${rel}`;
      if ('text' in f) native.sync('fs.writeText', { path: target, text: String(f.text) });
      else if ('vault' in f) native.sync('fs.writeB64', { path: target, b64: svc().vault.readB64(f.vault) });
      else native.sync('fs.writeB64', { path: target, b64: f.b64 || '' });
    }
    return { folder: out, files: files.length };
  });

  r('publish.open', (p) => {
    const folder = normpath(String(p.folder || ''));
    if (!permissions.chosen(folder)) throw new ApiError('permission-denied', folder);
    return native.sync('sys.openPath', { path: folder + '/index.html' });
  });

  // ------------------------------------------------------------- PDF
  // Android's own print dialog makes the PDF ("Save as PDF") or sends it to a printer.
  r('export.pdf', async (p) => {
    const name = String(p.name || 'note').replace(/[\\/:*?"<>|]+/g, '-');
    const html = "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><style>" + (p.css || '')
      + '\nhtml,body{height:auto!important;overflow:visible!important}body{background:#fff;color:#111;margin:0;padding:0 8px;font-family:sans-serif;user-select:text}'
      + ".copy-code-button{display:none}</style></head><body class='theme-light'>" + (p.html || '') + '</body></html>';
    await native.async('ui.printHtml', { name, html });
    return null; // the system dialog reports the result itself: there is no path to show
  });
}

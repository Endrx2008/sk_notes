// sk_notes for Android – is there a newer sk_notes? (the latest release on GitHub)
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// At every start the page asks once; the answer comes from the public GitHub API (no account).
// Without network the last answer is used. The APK of the release is opened by the browser,
// which downloads it and hands it to Android's installer.

import { native } from './native.js';
import { route } from './router.js';
import { roots, VERSION } from './state.js';
import { ApiError, b64ToText } from './util.js';

const LATEST_URL = 'https://api.github.com/repos/Endrx2008/sk_notes/releases/latest';
const PAGE_URL = 'https://github.com/Endrx2008/sk_notes/releases/latest';
const DOWNLOAD_RE = /^https:\/\/github\.com\/Endrx2008\/sk_notes\/releases\/download\/[^/?#]+\/[^/?#]+\.apk$/;

const file = () => roots().private + '/update.json';
function read() {
  try { return JSON.parse(native.sync('fs.readText', { path: file() }).text) || {}; } catch { return {}; }
}
function write(v) {
  try { native.sync('fs.writeText', { path: file(), text: JSON.stringify(v) }); } catch { /* not kept this time */ }
}

/** '0.5.10' > '0.5.9'; anything after a '-' is ignored. */
export function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function fetchLatest() {
  const r = await native.async('net.request', {
    url: LATEST_URL, method: 'GET', timeout: 15, maxBytes: 512 * 1024,
    headers: { 'User-Agent': 'sk_notes', Accept: 'application/vnd.github+json' },
  });
  if (r.status !== 200) throw new ApiError('download-failed', 'HTTP ' + r.status);
  const rel = JSON.parse(b64ToText(r.b64 || ''));
  if (!rel || rel.draft || rel.prerelease || typeof rel.tag_name !== 'string') throw new ApiError('download-failed', 'release');
  const apk = (rel.assets || []).find((a) => /\.apk$/i.test(a?.name || '') && DOWNLOAD_RE.test(a?.browser_download_url || ''));
  return {
    tag: rel.tag_name.slice(0, 40),
    name: String(rel.name || rel.tag_name).slice(0, 80),
    url: apk ? apk.browser_download_url : PAGE_URL, // no APK in it: the release page
  };
}

export function registerUpdate() {
  route('update.check', async (p, ctx) => {
    if (ctx.plugin) throw new ApiError('permission-denied');
    const saved = read();
    let latest = saved.latest || null;
    try {
      latest = await fetchLatest();
      write({ ...saved, latest, checked: Date.now() });
    } catch { /* offline: the last answer */ }
    const available = !!latest && newer(latest.tag, VERSION);
    return { current: VERSION, latest, available, notified: available && saved.notified === latest.tag };
  });

  /** The notice for this release was shown: it does not come back at the next start. */
  route('update.notified', (p, ctx) => {
    if (ctx.plugin) throw new ApiError('permission-denied');
    write({ ...read(), notified: String(p.tag || '').slice(0, 40) });
    return true;
  });
}

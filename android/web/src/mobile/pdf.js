// sk_notes for Android – PDF pages.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Android's WebView has no PDF viewer, so an <iframe> with a PDF stays empty. The native
// side draws the pages instead (Android's own PDF renderer) and serves them as pictures:
//   /pdf/<path in the vault>            → {pages, sizes: [[width, height], …]}
//   /pdf/<path in the vault>?page=3&w=… → that page, as an image `w` pixels wide

import { t } from '@desktop/core/i18n.js';

/** Draw a PDF of the vault inside `container`. Resolves to show(page), which scrolls to a
 * page (null if the PDF could not be read). */
export async function renderPdf(container, file) {
  const wrap = container.createDiv('mobile-pdf');
  const base = location.origin + '/pdf/' + file.path.split('/').map(encodeURIComponent).join('/');
  const stamp = file.stat?.mtime || 0;
  let info;
  try {
    const r = await fetch(`${base}?v=${stamp}`);
    if (!r.ok) throw new Error(String(r.status));
    info = await r.json();
  } catch {
    wrap.createDiv({ cls: 'mobile-pdf-error', text: t('mobile.pdf-failed') });
    return null;
  }
  // sharp on the screen without asking for pictures bigger than a phone can hold
  const width = Math.min(1800, Math.round(Math.min(Math.max(window.innerWidth, 360), 900) * Math.min(window.devicePixelRatio || 1, 2.5)));
  const pages = [];
  (info.sizes || []).forEach(([w, h], i) => {
    const img = wrap.createEl('img', { cls: 'mobile-pdf-page', attr: { loading: 'lazy', decoding: 'async', draggable: 'false', width: Math.round(w), height: Math.round(h), alt: `${file.name} – ${i + 1}`,
      src: `${base}?page=${i + 1}&w=${width}&v=${stamp}` } });
    pages.push(img);
  });
  if (!pages.length) wrap.createDiv({ cls: 'mobile-pdf-error', text: t('mobile.pdf-failed') });
  return (page) => { pages[Math.max(1, Math.min(page, pages.length)) - 1]?.scrollIntoView({ block: 'start' }); };
}

// sk_notes for Android – the logo drawn in the colours of the theme in use.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// logo.svg is the picture of the app's icon (orange on a dark tile). Inside the app it is
// drawn without the tile and with the accent colour of the theme, so it changes with it.

// The logo in the colours of the theme in use: the scorpion takes the accent colour.
let logoSvg = null;
export async function themedLogo(el) {
  try {
    if (logoSvg === null) {
      const text = await (await fetch('logo.svg')).text();
      logoSvg = text
        .replace(/<rect width="432" height="432"[^>]*\/>/, '').replace(/<rect x="6" y="6"[^>]*\/>/, '') // no tile: the page is the background
        .replace(/fill="#e05c00"/g, 'style="fill:var(--sk-accent)"')
        .replace(/fill="#9c3f00"/g, 'style="fill:var(--sk-accent);opacity:.7"')
        .replace(/ width="432" height="432"/, '').replace('viewBox="0 0 432 432"', 'viewBox="52 44 328 344"'); // the drawing without the margin of the tile
    }
    if (!/^<svg[\s>]/.test(logoSvg)) return;
    const doc = new DOMParser().parseFromString(logoSvg, 'image/svg+xml');
    const svg = doc.documentElement;
    if (svg.nodeName !== 'svg' || doc.querySelector('script, foreignObject')) return;
    el.empty();
    el.appendChild(document.importNode(svg, true));
  } catch { /* the plain picture stays */ }
}

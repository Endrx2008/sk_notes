// sk_notes for Android – what kind of device this is, as classes on <body>.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// is-phone / is-tablet follow the width of the window (a foldable or a split screen
// changes it while the app runs); the styles and the layout code look at these classes.

const TABLET_MIN = 700; // CSS pixels: narrower windows get the phone layout

export function isPhone() {
  return document.body.classList.contains('is-phone');
}

export function installDevice() {
  const body = document.body;
  const update = () => {
    const phone = Math.min(window.innerWidth, screen.width || window.innerWidth) < TABLET_MIN;
    if (body.classList.contains('is-phone') === phone && body.classList.contains('is-tablet') === !phone) return;
    body.classList.toggle('is-phone', phone);
    body.classList.toggle('is-tablet', !phone);
    window.dispatchEvent(new CustomEvent('skn-device-change', { detail: { phone } }));
  };
  update();
  window.addEventListener('resize', update);
  // the keyboard: the window gets shorter while the screen stays the same
  const vv = window.visualViewport;
  let base = window.innerHeight;
  let lastWidth = window.innerWidth;
  const keyboard = () => {
    const h = vv ? vv.height : window.innerHeight;
    if (window.innerWidth !== lastWidth) { lastWidth = window.innerWidth; base = Math.max(h, window.innerHeight); } // rotated
    if (h > base) base = h;
    const open = base - h > 120;
    if (body.classList.contains('is-keyboard-open') !== open) {
      body.classList.toggle('is-keyboard-open', open);
      window.dispatchEvent(new CustomEvent('skn-keyboard', { detail: { open } }));
    }
  };
  (vv || window).addEventListener('resize', keyboard);
}

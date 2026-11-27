// sk_notes for Android – what kind of device this is, as classes on <body>.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Phones and tablets have the same layout, the phone's (drawers, bottom bar, one note at a time,
// dialogs as sheets): is-phone is always set. is-tablet is set besides it on a wide window
// (a tablet, a foldable open, a split screen changing while the app runs): only sizes follow it
// (more tiles on Home, wider dialogs), never a different layout.

const TABLET_MIN = 700; // CSS pixels: wider windows are a tablet's

export function isPhone() {
  return document.body.classList.contains('is-phone');
}

export function installDevice() {
  const body = document.body;
  const update = () => {
    const wide = Math.min(window.innerWidth, screen.width || window.innerWidth) >= TABLET_MIN;
    if (body.classList.contains('is-phone') && body.classList.contains('is-tablet') === wide) return;
    body.classList.add('is-phone');
    body.classList.toggle('is-tablet', wide);
    window.dispatchEvent(new CustomEvent('skn-device-change', { detail: { phone: true, wide } }));
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

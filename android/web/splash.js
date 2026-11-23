// sk_notes for Android – the loading screen in the colours of the last theme used.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Runs before anything else (a plain script right after the loading screen): the page saves
// the colours of the theme in use (mobile.js, syncBars) and this puts them on the screen
// shown while the app starts. Without saved colours the default look stays.
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('skn-splash') || 'null');
    var el = document.querySelector('.sk-splash');
    if (!s || !el) return;
    var keys = { bg: '--splash-bg', track: '--splash-track', accent: '--splash-accent' };
    for (var k in keys) if (/^#[0-9a-f]{6}$/i.test(s[k] || '')) el.style.setProperty(keys[k], s[k]);
  } catch (e) { /* the default look */ }
})();

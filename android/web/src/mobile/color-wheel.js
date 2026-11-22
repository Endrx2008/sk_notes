// sk_notes for Android – choosing a colour.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Android's WebView has no colour chooser: a tap on <input type="color"> does nothing. Every
// colour field of the workspace (custom colour of a graph node, colour of a graph group,
// settings of plugins...) opens this sheet instead: a wheel with every hue (saturation from
// the centre to the edge), a brightness slider and the hex code. The field gets the chosen
// value and its usual "input" and "change" events, so the desktop code works unchanged.

import { t } from '@desktop/core/i18n.js';
import { ButtonComponent, Modal } from '@desktop/ui/kit.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function hexToHsv(hex) {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, '$&$&');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let hue = 0;
  if (d) hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (hue * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h, s, v }) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * clamp(Math.min(k, 4 - k), 0, 1)) * 255);
  };
  return '#' + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Opens the sheet; resolves to the chosen "#rrggbb", or null when it is closed without choosing. */
export function chooseColor(app, value) {
  return new Promise((resolve) => {
    const hsv = hexToHsv(value) || { h: 20, s: 1, v: 0.88 };
    let result = null;
    const m = new Modal(app);
    m.modalEl.addClass('mobile-color-wheel');
    m.setTitle(t('mobile.color.title'));
    const box = m.contentEl.createDiv('color-wheel-box');
    const wheel = box.createEl('canvas', { cls: 'color-wheel' });
    const dot = box.createDiv('color-wheel-dot');
    const shade = m.contentEl.createDiv('color-wheel-row');
    shade.createSpan({ cls: 'color-wheel-label', text: t('mobile.color.brightness') });
    const slider = shade.createEl('input', { cls: 'color-wheel-brightness', attr: { type: 'range', min: '0', max: '100', step: '1' } });
    const code = m.contentEl.createDiv('color-wheel-row');
    const swatch = code.createDiv('color-wheel-swatch');
    const hex = code.createEl('input', { cls: 'color-wheel-hex', attr: { type: 'text', maxlength: '7', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' } });
    const row = m.contentEl.createDiv('modal-button-container');
    const done = () => { result = hsvToHex(hsv); m.close(); };
    new ButtonComponent(row).setButtonText(t('common.ok')).setCta().onClick(done);
    new ButtonComponent(row).setButtonText(t('common.cancel')).onClick(() => m.close());

    let size = 0;
    const draw = () => {
      const px = window.devicePixelRatio || 1;
      size = Math.round(Math.min(280, (window.innerWidth || 320) - 64));
      box.style.width = box.style.height = size + 'px';
      wheel.width = wheel.height = Math.round(size * px);
      const c = wheel.getContext('2d');
      const r = wheel.width / 2;
      c.clearRect(0, 0, wheel.width, wheel.width);
      const hues = c.createConicGradient(-Math.PI / 2, r, r); // red at the top, then clockwise
      for (let i = 0; i <= 12; i++) hues.addColorStop(i / 12, `hsl(${i * 30}, 100%, 50%)`);
      c.fillStyle = hues;
      c.beginPath(); c.arc(r, r, r, 0, Math.PI * 2); c.fill();
      const white = c.createRadialGradient(r, r, 0, r, r, r);
      white.addColorStop(0, '#fff'); white.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = white;
      c.beginPath(); c.arc(r, r, r, 0, Math.PI * 2); c.fill();
    };
    const show = (from = '') => {
      const color = hsvToHex(hsv);
      wheel.style.filter = `brightness(${Math.round(hsv.v * 100)}%)`;
      const a = (hsv.h - 90) * Math.PI / 180;
      dot.style.left = size / 2 + Math.cos(a) * hsv.s * size / 2 + 'px';
      dot.style.top = size / 2 + Math.sin(a) * hsv.s * size / 2 + 'px';
      dot.style.background = color;
      swatch.style.background = color;
      slider.style.setProperty('--wheel-full', hsvToHex({ ...hsv, v: 1 }));
      if (from !== 'slider') slider.value = String(Math.round(hsv.v * 100));
      if (from !== 'hex') hex.value = color;
    };
    const pick = (e) => {
      const rect = wheel.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      hsv.h = (Math.atan2(y, x) * 180 / Math.PI + 90 + 360) % 360;
      hsv.s = clamp(Math.hypot(x, y) / (rect.width / 2), 0, 1);
      if (hsv.v < 0.05) hsv.v = 1; // a hue chosen on a black wheel would stay black
      show();
    };
    box.addEventListener('pointerdown', (e) => { box.setPointerCapture?.(e.pointerId); pick(e); e.preventDefault(); });
    box.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') pick(e); });
    slider.addEventListener('input', () => { hsv.v = Number(slider.value) / 100; show('slider'); });
    hex.addEventListener('input', () => {
      const v = hexToHsv(hex.value);
      if (!v) return;
      Object.assign(hsv, v.s ? v : { ...v, h: hsv.h }); // a grey keeps the hue it had
      show('hex');
    });
    hex.addEventListener('blur', () => show());
    m.scope.register([], 'Enter', () => { done(); return false; });
    m.onClose = () => resolve(result);
    m.open();
    draw();
    show();
    document.activeElement?.blur?.(); // no keyboard over the wheel until the code is tapped
  });
}

/** Colour fields open the sheet instead of Android's missing chooser. */
export function installColorWheel(app) {
  document.addEventListener('click', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'color' || input.disabled) return;
    e.preventDefault();
    chooseColor(app, input.value).then((v) => {
      if (v === null) {
        // the field the graph adds for its custom colour lives only until a choice
        if (input.parentElement === document.body && input.style.opacity === '0') input.remove();
        return;
      }
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }, true);
}

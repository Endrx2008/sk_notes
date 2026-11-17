// sk_notes for Android – fingers for the views drawn for a mouse.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The graph and the canvas are moved with mouse drags and zoomed with the wheel. A finger
// makes neither, so on those views touches are turned into the mouse and wheel events
// their code already understands:
//   graph   one finger = drag (move the view or a node), two fingers = zoom
//   canvas  one finger on the background = move the board, on a card = drag the card,
//           two fingers = zoom and move, double tap = what a double click does,
//           long press = context menu
// Text fields, buttons and links inside these views keep their normal touch behaviour.

const VIEWS = '.workspace-leaf-content[data-type="graph"] .view-content, .workspace-leaf-content[data-type="localgraph"] .view-content, .workspace-leaf-content[data-type="canvas"] .view-content';
const NATIVE = 'input, textarea, select, button, a[href], [contenteditable=""], [contenteditable="true"], .cm-editor, .clickable-icon, .canvas-controls, .canvas-card-menu, .graph-controls, .graph-control-section, .markdown-embed-link';
const LONG_PRESS = 550;
const TAP_SLOP = 10;
const DOUBLE_TAP = 320;

function mouse(type, target, touch, extra = {}) {
  target.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, view: window, clientX: touch.clientX, clientY: touch.clientY, screenX: touch.screenX, screenY: touch.screenY,
    button: 0, buttons: type === 'mouseup' || type === 'click' || type === 'dblclick' ? 0 : 1, detail: type === 'dblclick' ? 2 : 1, ...extra,
  }));
}

// Wheel events made here are for the view under the fingers only. They stop at <body>: at the
// document a Ctrl+wheel changes the text size of the whole app (the zoom shortcut of a PC).
const made = new WeakSet();

function wheel(target, x, y, dx, dy, zoom) {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, deltaX: dx, deltaY: dy, deltaMode: 0, ctrlKey: zoom });
  made.add(e);
  target.dispatchEvent(e);
}

/** Close the settings panel of a graph, if one is open. True when one was. */
export function closeGraphControls(except = null) {
  let closed = false;
  for (const el of document.querySelectorAll('.graph-controls:not(.is-close)')) {
    if (el === except) continue;
    el.addClass('is-close');
    closed = true;
  }
  return closed;
}

export function installTouch() {
  document.body.addEventListener('wheel', (e) => { if (made.has(e)) e.stopPropagation(); });
  // The settings of the graph cover part of it: a touch anywhere outside the panel closes it
  // (on a phone the panel is long, and its own button may be scrolled out of sight).
  document.addEventListener('pointerdown', (e) => { closeGraphControls(e.target.closest?.('.graph-controls') || null); }, true);
  let g = null; // the gesture in progress
  let lastTap = { time: 0, x: 0, y: 0 };

  const cancelPress = () => { if (g?.timer) { clearTimeout(g.timer); g.timer = null; } };
  const center = (a, b) => [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
  const distance = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  document.addEventListener('touchstart', (e) => {
    const area = e.target.closest?.(VIEWS);
    if (!area || e.target.closest(NATIVE)) { g = null; return; }
    if (e.touches.length === 2 && g) {
      // second finger: whatever the first one started is over, zooming begins
      cancelPress();
      if (g.mode === 'mouse' && g.down) mouse('mouseup', g.target, e.touches[0]);
      g.mode = 'pinch';
      g.dist = distance(e.touches[0], e.touches[1]);
      [g.cx, g.cy] = center(e.touches[0], e.touches[1]);
      e.preventDefault();
      return;
    }
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const isCanvas = !!area.closest('[data-type="canvas"]');
    const onItem = isCanvas && !!e.target.closest('.canvas-node, .canvas-edge-hit, .canvas-node-resizer, .canvas-node-connection-point');
    g = { area, target: e.target, x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastY: touch.clientY, moved: false, down: false, timer: null,
      mode: isCanvas && !onItem ? 'pan' : 'mouse', isCanvas };
    if (g.mode === 'mouse') { mouse('mousemove', g.target, touch, { buttons: 0 }); mouse('mousedown', g.target, touch); g.down = true; }
    g.timer = setTimeout(() => {
      if (!g || g.moved) return;
      g.timer = null;
      if (g.down) { mouse('mouseup', g.target, touch); g.down = false; }
      g.mode = 'done';
      g.target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: g.x, clientY: g.y, button: 2 }));
    }, LONG_PRESS);
    e.preventDefault(); // no page scroll, no browser-made mouse events: they are made here
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (!g) return;
    e.preventDefault();
    if (g.mode === 'pinch' && e.touches.length >= 2) {
      const d = distance(e.touches[0], e.touches[1]);
      const [cx, cy] = center(e.touches[0], e.touches[1]);
      if (g.dist > 0 && d > 0) {
        // the views zoom by exp(-deltaY * k): k is 0.0015 for the graph, 0.002 for the canvas
        const dy = -Math.log(d / g.dist) / (g.isCanvas ? 0.002 : 0.0015);
        if (Math.abs(dy) > 0.5) wheel(g.area.querySelector('canvas') && !g.isCanvas ? g.area.querySelector('canvas') : g.target, cx, cy, 0, dy, true);
      }
      if (g.isCanvas) wheel(g.target, cx, cy, g.cx - cx, g.cy - cy, false);
      g.dist = d;
      g.cx = cx;
      g.cy = cy;
      return;
    }
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (!g.moved && Math.hypot(touch.clientX - g.x, touch.clientY - g.y) > TAP_SLOP) { g.moved = true; cancelPress(); }
    if (g.mode === 'mouse' && g.down) {
      mouse('mousemove', g.target, touch);
    } else if (g.mode === 'pan' && g.moved) {
      wheel(g.target, touch.clientX, touch.clientY, g.lastX - touch.clientX, g.lastY - touch.clientY, false);
    }
    g.lastX = touch.clientX;
    g.lastY = touch.clientY;
  }, { passive: false });

  const end = (e) => {
    if (!g) return;
    cancelPress();
    const touch = e.changedTouches[0];
    if (e.touches.length > 0) { // one finger of a pinch lifted: the gesture ends when the other does
      g.mode = 'done';
      return;
    }
    const cur = g;
    g = null;
    e.preventDefault();
    if (cur.mode === 'mouse' && cur.down) mouse('mouseup', cur.target, touch);
    if (cur.mode === 'done' || cur.mode === 'pinch' || cur.moved) return;
    // a tap
    if (cur.mode === 'pan') { mouse('mousedown', cur.target, touch); mouse('mouseup', cur.target, touch); }
    mouse('click', cur.target, touch);
    const now = Date.now();
    if (now - lastTap.time < DOUBLE_TAP && Math.hypot(touch.clientX - lastTap.x, touch.clientY - lastTap.y) < 30) {
      mouse('dblclick', cur.target, touch);
      lastTap = { time: 0, x: 0, y: 0 };
    } else lastTap = { time: now, x: touch.clientX, y: touch.clientY };
  };
  document.addEventListener('touchend', end, { passive: false });
  document.addEventListener('touchcancel', () => {
    if (!g) return;
    cancelPress();
    if (g.mode === 'mouse' && g.down) mouse('mouseup', g.target, { clientX: g.lastX, clientY: g.lastY, screenX: 0, screenY: 0 });
    g = null;
  });
}

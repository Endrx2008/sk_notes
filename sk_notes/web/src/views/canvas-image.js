// A picture of a whole canvas board (for sharing it with who has no sk_notes).
//
// The board is HTML and SVG, which a browser does not turn into a picture by itself: the
// cards, their text, their images and the arrows are drawn again here on a 2D canvas, with
// the colours they have on screen. Text is drawn plain (the words of the card, without the
// styles of Markdown); a web page inside a card is drawn as its address.

const PAD = 48;
const FONT = '"Inter", "Noto Sans", "DejaVu Sans", sans-serif';

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

/** Draw `text` inside the box, wrapping words and stopping at the bottom of it. */
function drawText(ctx, text, x, y, w, h, size, color) {
  ctx.fillStyle = color;
  ctx.font = `${size}px ${FONT}`;
  ctx.textBaseline = 'top';
  const lh = Math.round(size * 1.45);
  let cy = y;
  for (const para of String(text).replace(/\r/g, '').split('\n')) {
    let line = '';
    const words = para.split(/(\s+)/);
    const flush = () => { if (cy + lh <= y + h + 1) ctx.fillText(line.trimEnd(), x, cy); cy += lh; line = ''; };
    for (const word of words) {
      if (ctx.measureText(line + word).width > w && line.trim()) flush();
      if (ctx.measureText(word).width > w) { // a word longer than the card (an address): cut where it fits
        let rest = word;
        while (rest && cy + lh <= y + h + 1) {
          let n = rest.length;
          while (n > 1 && ctx.measureText(line + rest.slice(0, n)).width > w) n -= 1;
          line += rest.slice(0, n);
          rest = rest.slice(n);
          if (rest) flush();
        }
        continue;
      }
      line += word;
    }
    flush();
    if (cy > y + h) return;
  }
}

/** The image of a card, kept whole inside the card (like on screen). */
function drawPicture(ctx, img, x, y, w, h) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) return false;
  const k = Math.min(w / iw, h / ih);
  ctx.drawImage(img, x + (w - iw * k) / 2, y + (h - ih * k) / 2, iw * k, ih * k);
  return true;
}

/** → a data: address of the picture (JPEG by default). Throws when the board is empty. */
export function canvasPicture(view, { type = 'image/jpeg', quality = 0.92, maxSide = 4096 } = {}) {
  const nodes = view.canvasData.nodes;
  if (!nodes.length) throw new Error('empty');
  const minX = Math.min(...nodes.map((n) => n.x)) - PAD;
  const minY = Math.min(...nodes.map((n) => n.y)) - PAD - 30; // room for the labels above the cards
  const maxX = Math.max(...nodes.map((n) => n.x + n.width)) + PAD;
  const maxY = Math.max(...nodes.map((n) => n.y + n.height)) + PAD;
  const w = maxX - minX;
  const h = maxY - minY;
  const scale = Math.min(2, maxSide / w, maxSide / h);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));
  const ctx = out.getContext('2d');
  const page = getComputedStyle(view.contentEl);
  const css = (name, fallback) => getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  ctx.fillStyle = page.backgroundColor && page.backgroundColor !== 'rgba(0, 0, 0, 0)' ? page.backgroundColor : css('--background-primary', '#ffffff');
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.scale(scale, scale);
  ctx.translate(-minX, -minY);
  const text = css('--text-normal', '#222222');
  const muted = css('--text-muted', '#777777');

  const drawNode = (n) => {
    const el = view.nodeEls.get(n.id);
    const box = el?.querySelector('.canvas-node-container');
    const st = box ? getComputedStyle(box) : null;
    const radius = st ? parseFloat(st.borderTopLeftRadius) || 8 : 8;
    const border = st ? parseFloat(st.borderTopWidth) || 1 : 1;
    roundRect(ctx, n.x, n.y, n.width, n.height, radius);
    if (st && st.backgroundColor !== 'rgba(0, 0, 0, 0)') { ctx.fillStyle = st.backgroundColor; ctx.fill(); }
    ctx.save();
    roundRect(ctx, n.x, n.y, n.width, n.height, radius);
    ctx.clip();
    const inner = [n.x + 14, n.y + 12, n.width - 28, n.height - 24];
    const img = el?.querySelector('.canvas-node-content img');
    if (n.type === 'group') { /* a frame only */ } else if (img && img.complete && drawPicture(ctx, img, n.x, n.y, n.width, n.height)) { /* drawn */ } else if (n.type === 'link') drawText(ctx, n.url || '', ...inner, 14, muted);
    else {
      const content = el?.querySelector('.canvas-node-content');
      drawText(ctx, (content?.innerText || n.text || n.file || '').trim(), ...inner, 15, st?.color || text);
    }
    ctx.restore();
    roundRect(ctx, n.x, n.y, n.width, n.height, radius);
    ctx.lineWidth = Math.max(1, border);
    ctx.strokeStyle = st?.borderTopColor || muted;
    if (n.type === 'group') ctx.setLineDash([]);
    ctx.stroke();
    const label = n.type === 'group' ? n.label : n.type === 'file' ? String(n.file || '').split('/').pop() : '';
    if (label) {
      ctx.fillStyle = muted;
      ctx.textBaseline = 'alphabetic';
      ctx.font = n.type === 'group' ? `700 18px ${FONT}` : `12px ${FONT}`;
      ctx.fillText(label, n.x + 4, n.y - 8);
    }
  };
  for (const n of nodes.filter((x) => x.type === 'group')) drawNode(n);

  // arrows, under the cards like on screen
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of view.canvasData.edges) {
    const a = byId.get(e.fromNode);
    const b = byId.get(e.toNode);
    if (!a || !b) continue;
    const fs = e.fromSide || view._autoSide(a, b);
    const ts = e.toSide || view._autoSide(b, a);
    const p1 = view._anchor(a, fs);
    const p2 = view._anchor(b, ts);
    const d = Math.max(40, Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 2.5);
    const [ax, ay] = view._dir(fs);
    const [bx, by] = view._dir(ts);
    const c1 = [p1[0] + ax * d, p1[1] + ay * d];
    const c2 = [p2[0] + bx * d, p2[1] + by * d];
    const pathEl = view.edgesSvg.querySelector(`.canvas-edge[data-id="${CSS.escape(e.id)}"]`);
    const color = (pathEl && getComputedStyle(pathEl).stroke) || muted;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]);
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]);
    ctx.stroke();
    const head = (tip, from) => {
      const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
      ctx.beginPath();
      ctx.moveTo(tip[0], tip[1]);
      ctx.lineTo(tip[0] - 13 * Math.cos(ang - 0.42), tip[1] - 13 * Math.sin(ang - 0.42));
      ctx.lineTo(tip[0] - 13 * Math.cos(ang + 0.42), tip[1] - 13 * Math.sin(ang + 0.42));
      ctx.closePath();
      ctx.fill();
    };
    if ((e.toEnd || 'arrow') === 'arrow') head(p2, c2);
    if (e.fromEnd === 'arrow') head(p1, c1);
    if (e.label) {
      const mid = view._mid(p1, fs, p2, ts);
      ctx.font = `13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 5;
      ctx.strokeStyle = ctx.canvas ? (page.backgroundColor !== 'rgba(0, 0, 0, 0)' ? page.backgroundColor : css('--background-primary', '#ffffff')) : '#ffffff';
      ctx.strokeText(e.label, mid[0], mid[1]);
      ctx.fillStyle = muted;
      ctx.fillText(e.label, mid[0], mid[1]);
      ctx.textAlign = 'start';
    }
  }
  for (const n of nodes.filter((x) => x.type !== 'group')) drawNode(n);
  return out.toDataURL(type, quality);
}

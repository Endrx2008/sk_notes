// Small helpers shared by the UI and the plugin API.

export function debounce(fn, wait = 0, resetTimer = false) {
  let timer = null;
  let lastArgs = null;
  let ctx = null;
  const run = () => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    fn.apply(ctx, args);
  };
  const d = function debounced(...args) {
    lastArgs = args;
    ctx = this;
    if (timer && !resetTimer) return d;
    clearTimeout(timer);
    timer = setTimeout(run, wait);
    return d;
  };
  d.cancel = () => { clearTimeout(timer); timer = null; lastArgs = null; return d; };
  d.run = () => { if (timer) { clearTimeout(timer); run(); } };
  return d;
}

export function throttle(fn, wait) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= wait) { last = now; fn(...args); return; }
    clearTimeout(timer);
    timer = setTimeout(() => { last = Date.now(); fn(...args); }, wait - (now - last));
  };
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function uid(n = 16) {
  const a = new Uint8Array(n / 2);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function arrayBufferToHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToArrayBuffer(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out.buffer;
}

export function formatBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function isImage(ext) { return ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif'].includes(ext); }
export function isAudio(ext) { return ['mp3', 'wav', 'm4a', 'ogg', '3gp', 'flac', 'webm', 'opus'].includes(ext); }
export function isVideo(ext) { return ['mp4', 'webm', 'ogv', 'mov', 'mkv'].includes(ext); }

export function wordCount(text) {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*|[぀-ヿ㐀-鿿]/gu);
  return words ? words.length : 0;
}

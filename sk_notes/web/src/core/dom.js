// DOM and language helpers installed globally. Community plugins expect them (their
// signatures are part of the public plugin API typings); sk_notes' own UI uses them too.
/* eslint-disable no-extend-native */

function define(proto, name, value) {
  if (!Object.prototype.hasOwnProperty.call(proto, name)) {
    Object.defineProperty(proto, name, { value, configurable: true, writable: true });
  }
}

function applyInfo(el, o) {
  if (o === undefined || o === null) return;
  if (typeof o === 'string') {
    el.className = o;
    return;
  }
  if (o.cls) {
    const list = Array.isArray(o.cls) ? o.cls : String(o.cls).split(' ');
    for (const c of list) if (c) el.classList.add(c);
  }
  if (o.text !== undefined && o.text !== null) {
    if (o.text instanceof Node) el.appendChild(o.text);
    else el.textContent = String(o.text);
  }
  if (o.attr) {
    for (const [k, v] of Object.entries(o.attr)) {
      if (v === null || v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (o.title !== undefined) el.setAttribute('title', o.title);
  if (o.value !== undefined && 'value' in el) el.value = o.value;
  if (o.type !== undefined) el.setAttribute('type', o.type);
  if (o.placeholder !== undefined) el.setAttribute('placeholder', o.placeholder);
  if (o.href !== undefined) el.setAttribute('href', o.href);
  if (o.parent) {
    if (o.prepend) o.parent.insertBefore(el, o.parent.firstChild);
    else o.parent.appendChild(el);
  }
}

function makeEl(doc, tag, o, cb) {
  const el = doc.createElement(tag);
  applyInfo(el, o);
  if (cb) cb(el);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function installDomHelpers(win = window) {
  const { Node: N, Element: E, HTMLElement: H, SVGElement: S, DocumentFragment: F, Document: D } = win;
  const doc = win.document;

  // ---- Object / Array / String / Math / Number
  define(Object, 'isEmpty', (o) => { for (const _ in o) return false; return true; });
  define(Object, 'each', (o, cb, ctx) => { for (const k in o) if (cb.call(ctx, o[k], k) === false) return false; return true; });
  define(Array, 'combine', (arrays) => [].concat(...arrays));
  define(Array.prototype, 'first', function first() { return this[0]; });
  define(Array.prototype, 'last', function last() { return this[this.length - 1]; });
  define(Array.prototype, 'contains', function contains(t) { return this.indexOf(t) !== -1; });
  define(Array.prototype, 'remove', function remove(t) {
    for (let i = this.length - 1; i >= 0; i--) if (this[i] === t) this.splice(i, 1);
  });
  define(Array.prototype, 'shuffle', function shuffle() {
    for (let i = this.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this[i], this[j]] = [this[j], this[i]];
    }
    return this;
  });
  define(Array.prototype, 'unique', function unique() { return Array.from(new Set(this)); });
  define(Math, 'clamp', (v, a, b) => Math.min(Math.max(v, a), b));
  define(Math, 'square', (v) => v * v);
  define(String, 'isString', (o) => typeof o === 'string' || o instanceof String);
  define(String.prototype, 'contains', function contains(t) { return this.indexOf(t) !== -1; });
  define(String.prototype, 'format', function format(...args) {
    return this.replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? args[i] : m));
  });
  define(Number, 'isNumber', (o) => typeof o === 'number');

  // ---- Node
  define(N.prototype, 'detach', function detach() { if (this.parentNode) this.parentNode.removeChild(this); });
  define(N.prototype, 'empty', function empty() { while (this.lastChild) this.removeChild(this.lastChild); });
  define(N.prototype, 'indexOf', function indexOf(other) { return Array.prototype.indexOf.call(this.childNodes, other); });
  define(N.prototype, 'setChildrenInPlace', function setChildrenInPlace(children) {
    const keep = new Set(children);
    for (const c of Array.from(this.childNodes)) if (!keep.has(c)) this.removeChild(c);
    let ref = this.firstChild;
    for (const c of children) {
      if (c === ref) ref = ref.nextSibling;
      else this.insertBefore(c, ref);
    }
  });
  define(N.prototype, 'appendText', function appendText(v) { this.appendChild((this.ownerDocument || doc).createTextNode(v)); });
  define(N.prototype, 'instanceOf', function instanceOf(type) { return this instanceof type; });
  Object.defineProperty(N.prototype, 'doc', { configurable: true, get() { return this.ownerDocument || this; } });
  Object.defineProperty(N.prototype, 'win', { configurable: true, get() { return (this.ownerDocument || this).defaultView || win; } });
  Object.defineProperty(N.prototype, 'constructorWin', { configurable: true, get() { return win; } });
  define(N.prototype, 'createEl', function createEl(tag, o, cb) {
    const el = makeEl(this.ownerDocument || doc, tag, o, null);
    if (o && typeof o === 'object' && o.prepend) this.insertBefore(el, this.firstChild);
    else this.appendChild(el);
    if (cb) cb(el);
    return el;
  });
  define(N.prototype, 'createDiv', function createDiv(o, cb) { return this.createEl('div', o, cb); });
  define(N.prototype, 'createSpan', function createSpan(o, cb) { return this.createEl('span', o, cb); });
  define(N.prototype, 'createSvg', function createSvg(tag, o, cb) {
    const el = (this.ownerDocument || doc).createElementNS(SVG_NS, tag);
    applySvgInfo(el, o);
    if (o && typeof o === 'object' && o.prepend) this.insertBefore(el, this.firstChild);
    else this.appendChild(el);
    if (cb) cb(el);
    return el;
  });

  // ---- Element
  define(E.prototype, 'getText', function getText() { return this.textContent || ''; });
  define(E.prototype, 'setText', function setText(v) {
    if (v instanceof N) { this.empty(); this.appendChild(v); } else this.textContent = v === undefined || v === null ? '' : String(v);
  });
  define(E.prototype, 'addClass', function addClass(...c) { this.classList.add(...c.flatMap((x) => String(x).split(' ')).filter(Boolean)); });
  define(E.prototype, 'addClasses', function addClasses(c) { this.addClass(...c); });
  define(E.prototype, 'removeClass', function removeClass(...c) { this.classList.remove(...c.flatMap((x) => String(x).split(' ')).filter(Boolean)); });
  define(E.prototype, 'removeClasses', function removeClasses(c) { this.removeClass(...c); });
  define(E.prototype, 'toggleClass', function toggleClass(classes, value) {
    for (const c of Array.isArray(classes) ? classes : [classes]) this.classList.toggle(c, !!value);
  });
  define(E.prototype, 'hasClass', function hasClass(c) { return this.classList.contains(c); });
  define(E.prototype, 'setAttr', function setAttr(k, v) {
    if (v === null || v === undefined || v === false) this.removeAttribute(k);
    else this.setAttribute(k, v === true ? '' : String(v));
  });
  define(E.prototype, 'setAttrs', function setAttrs(o) { for (const [k, v] of Object.entries(o)) this.setAttr(k, v); });
  define(E.prototype, 'getAttr', function getAttr(k) { return this.getAttribute(k); });
  define(E.prototype, 'matchParent', function matchParent(sel, last) {
    let el = this;
    while (el && el !== last) {
      if (el.matches && el.matches(sel)) return el;
      el = el.parentElement;
    }
    return null;
  });
  define(E.prototype, 'getCssPropertyValue', function getCssPropertyValue(p, pseudo) {
    return (this.ownerDocument.defaultView || win).getComputedStyle(this, pseudo).getPropertyValue(p);
  });
  define(E.prototype, 'isActiveElement', function isActiveElement() { return this.ownerDocument.activeElement === this; });
  define(E.prototype, 'find', function find(sel) { return this.querySelector(sel); });
  define(E.prototype, 'findAll', function findAll(sel) { return Array.from(this.querySelectorAll(sel)); });
  define(E.prototype, 'findAllSelf', function findAllSelf(sel) {
    const out = Array.from(this.querySelectorAll(sel));
    if (this.matches(sel)) out.unshift(this);
    return out;
  });
  define(F.prototype, 'find', function find(sel) { return this.querySelector(sel); });
  define(F.prototype, 'findAll', function findAll(sel) { return Array.from(this.querySelectorAll(sel)); });

  // ---- HTMLElement / SVGElement
  for (const P of [H.prototype, S.prototype]) {
    define(P, 'setCssStyles', function setCssStyles(styles) { Object.assign(this.style, styles); });
    define(P, 'setCssProps', function setCssProps(props) {
      for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
    });
  }
  define(H.prototype, 'show', function show() { this.style.display = ''; });
  define(H.prototype, 'hide', function hide() { this.style.display = 'none'; });
  define(H.prototype, 'toggle', function toggle(show) { if (show) this.show(); else this.hide(); });
  define(H.prototype, 'toggleVisibility', function toggleVisibility(v) { this.style.visibility = v ? '' : 'hidden'; });
  define(H.prototype, 'isShown', function isShown() { return !!this.offsetParent || this.style.display !== 'none' && this.isConnected; });
  define(H.prototype, 'onClickEvent', function onClickEvent(listener, options) {
    this.addEventListener('click', listener, options);
    this.addEventListener('auxclick', listener, options);
  });
  define(H.prototype, 'trigger', function trigger(type) { this.dispatchEvent(new Event(type, { bubbles: true })); });
  // Fires when the element goes from "not in the document" to "in the document" – not on
  // every DOM change (a listener that adds nodes must not trigger itself again).
  define(H.prototype, 'onNodeInserted', function onNodeInserted(listener, once) {
    let connected = this.isConnected;
    const check = () => {
      const now = this.isConnected;
      if (now && !connected) {
        connected = true;
        if (once) obs.disconnect();
        listener();
      } else if (!now) connected = false;
    };
    const obs = new MutationObserver(check);
    obs.observe(this.ownerDocument, { childList: true, subtree: true });
    if (connected) queueMicrotask(() => { if (this.isConnected) { if (once) obs.disconnect(); listener(); } });
    return () => obs.disconnect();
  });
  define(H.prototype, 'onWindowMigrated', function onWindowMigrated() { return () => {}; });

  // delegated events: el.on('click', '.selector', listener)
  for (const P of [H.prototype, D.prototype]) {
    define(P, 'on', function on(type, selector, listener, options) {
      if (!this._EVENTS) this._EVENTS = {};
      const list = (this._EVENTS[type] ||= []);
      const callback = (ev) => {
        const target = ev.target instanceof E ? ev.target.closest(selector) : null;
        if (target && (this === target || this.contains?.(target) || this instanceof D)) listener.call(this, ev, target);
      };
      list.push({ selector, listener, options, callback });
      this.addEventListener(type, callback, options);
    });
    define(P, 'off', function off(type, selector, listener, options) {
      const list = this._EVENTS?.[type] || [];
      for (let i = list.length - 1; i >= 0; i--) {
        const it = list[i];
        if (it.selector === selector && it.listener === listener) {
          this.removeEventListener(type, it.callback, options);
          list.splice(i, 1);
        }
      }
    });
  }

  // ---- globals
  win.createEl = (tag, o, cb) => makeEl(doc, tag, o, cb);
  win.createDiv = (o, cb) => makeEl(doc, 'div', o, cb);
  win.createSpan = (o, cb) => makeEl(doc, 'span', o, cb);
  win.createSvg = (tag, o, cb) => {
    const el = doc.createElementNS(SVG_NS, tag);
    applySvgInfo(el, o);
    if (cb) cb(el);
    return el;
  };
  win.createFragment = (cb) => {
    const f = doc.createDocumentFragment();
    if (cb) cb(f);
    return f;
  };
  win.isBoolean = (o) => typeof o === 'boolean';
  win.fish = (sel) => doc.querySelector(sel);
  win.fishAll = (sel) => Array.from(doc.querySelectorAll(sel));
  win.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  win.nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  win.ready = (fn) => (doc.readyState === 'loading' ? doc.addEventListener('DOMContentLoaded', fn) : fn());
  win.activeWindow = win;
  win.activeDocument = doc;
  win.ajax = (o) => {
    const req = o.req || new XMLHttpRequest();
    req.open(o.method || 'GET', o.url, true);
    for (const [k, v] of Object.entries(o.headers || {})) req.setRequestHeader(k, v);
    req.withCredentials = !!o.withCredentials;
    req.onload = () => (req.status >= 200 && req.status < 400 ? o.success?.(req.response, req) : o.error?.(req.statusText, req));
    req.onerror = (e) => o.error?.(e, req);
    req.send(typeof o.data === 'object' && !(o.data instanceof ArrayBuffer) ? JSON.stringify(o.data) : o.data);
  };
  win.ajaxPromise = (o) => new Promise((resolve, reject) => win.ajax({ ...o, success: resolve, error: reject }));
  Object.defineProperty(win.UIEvent.prototype, 'targetNode', { configurable: true, get() { return this.target instanceof N ? this.target : null; } });
  Object.defineProperty(win.UIEvent.prototype, 'win', { configurable: true, get() { return this.view || win; } });
  Object.defineProperty(win.UIEvent.prototype, 'doc', { configurable: true, get() { return (this.view || win).document; } });
}

function applySvgInfo(el, o) {
  if (!o) return;
  if (typeof o === 'string') { el.setAttribute('class', o); return; }
  if (o.cls) for (const c of Array.isArray(o.cls) ? o.cls : String(o.cls).split(' ')) if (c) el.classList.add(c);
  if (o.attr) for (const [k, v] of Object.entries(o.attr)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  if (o.parent) {
    if (o.prepend) o.parent.insertBefore(el, o.parent.firstChild);
    else o.parent.appendChild(el);
  }
}

// Keyboard: Scope (stack of key handlers), Keymap helpers, hotkey (de)serialisation.

export const isMac = /Mac/.test(navigator.platform);

export function modifiersOf(evt) {
  const m = [];
  if (evt.ctrlKey) m.push(isMac ? 'Ctrl' : 'Mod');
  if (evt.metaKey) m.push(isMac ? 'Mod' : 'Meta');
  if (evt.altKey) m.push('Alt');
  if (evt.shiftKey) m.push('Shift');
  return m;
}

/** Key name of an event, independent of the keyboard layout for letters/digits. */
export function keyOf(evt) {
  const code = evt.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  const map = { Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-', Equal: '=', Space: ' ' };
  if (map[code]) return map[code];
  return evt.key && evt.key.length === 1 ? evt.key.toUpperCase() : evt.key;
}

export function hotkeyMatches(hk, evt) {
  const mods = new Set(modifiersOf(evt));
  const want = new Set(hk.modifiers || []);
  if (mods.size !== want.size) return false;
  for (const m of want) if (!mods.has(m)) return false;
  const k = keyOf(evt);
  return String(hk.key).toUpperCase() === String(k).toUpperCase();
}

export function hotkeyToString(hk) {
  if (!hk) return '';
  const names = { Mod: isMac ? '⌘' : 'Ctrl', Ctrl: 'Ctrl', Meta: isMac ? '⌘' : 'Super', Alt: isMac ? '⌥' : 'Alt', Shift: isMac ? '⇧' : 'Shift' };
  const keyNames = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', ' ': 'Space', Escape: 'Esc', Enter: 'Enter' };
  const parts = (hk.modifiers || []).map((m) => names[m] || m);
  parts.push(keyNames[hk.key] || (hk.key.length === 1 ? hk.key.toUpperCase() : hk.key));
  return parts.join(isMac ? '' : '+');
}

export class Keymap {
  static isModifier(evt, modifier) {
    if (!evt) return false;
    if (modifier === 'Mod') return isMac ? evt.metaKey : evt.ctrlKey;
    if (modifier === 'Ctrl') return evt.ctrlKey;
    if (modifier === 'Meta') return evt.metaKey;
    if (modifier === 'Shift') return evt.shiftKey;
    if (modifier === 'Alt') return evt.altKey;
    return false;
  }

  /** How a click should open a link: false (same tab), 'tab', 'split', 'window'. */
  static isModEvent(evt) {
    if (!evt) return false;
    const mod = isMac ? evt.metaKey : evt.ctrlKey;
    if (evt.button === 1) return 'tab';
    if (mod && evt.altKey && evt.shiftKey) return 'window';
    if (mod && evt.altKey) return 'split';
    if (mod) return 'tab';
    return false;
  }
}

export class Scope {
  constructor(parent) {
    this.parent = parent;
    this.keys = [];
  }

  register(modifiers, key, func) {
    const handler = { scope: this, modifiers: modifiers || [], key: key, func };
    this.keys.push(handler);
    return handler;
  }

  unregister(handler) {
    this.keys.remove(handler);
  }

  /** Returns false when the event was handled (and should be stopped). */
  handleKey(evt, info) {
    for (const h of this.keys) {
      const keyOk = h.key === null || h.key === undefined || String(h.key).toUpperCase() === String(info.key).toUpperCase()
        || String(h.key) === evt.key;
      const modsOk = h.modifiers === null || sameMods(h.modifiers, info.modifiers);
      if (keyOk && modsOk) {
        const res = h.func(evt, { modifiers: info.modifiers.join(','), key: info.key, vkey: info.key });
        if (res === false) return false;
      }
    }
    return this.parent ? this.parent.handleKey(evt, info) : undefined;
  }
}

function sameMods(want, have) {
  const a = (Array.isArray(want) ? want : String(want).split(',')).filter(Boolean);
  if (a.length !== have.length) return false;
  return a.every((m) => have.includes(m));
}

/** Stack of scopes; the top one gets keys first (modals, suggest popups...). */
export class KeymapManager {
  constructor(rootScope) {
    this.rootScope = rootScope;
    this.stack = [];
  }

  pushScope(scope) {
    this.stack.push(scope);
  }

  popScope(scope) {
    this.stack.remove(scope);
  }

  get current() {
    return this.stack[this.stack.length - 1] || this.rootScope;
  }

  getRootScope() {
    return this.rootScope;
  }

  updateModifiers() {}

  handle(evt) {
    const info = { modifiers: modifiersOf(evt), key: keyOf(evt) };
    return this.current.handleKey(evt, info);
  }
}

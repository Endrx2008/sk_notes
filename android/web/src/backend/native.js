// sk_notes for Android – the bridge to the native (Java) side of the app.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Java side (Bridge.java) exposes `SkNative` to the page:
//   boot()                              one-time key for this page load
//   call(key, method, json)             synchronous call, returns JSON
//   callAsync(key, id, method, json)    runs on a worker thread, then calls __sknNative.r(id)
//   take(key, id)                       JSON of a finished async call or of an event
// Every method needs the key. This module takes it before any plugin runs and keeps it
// in a private variable, so community plugins (which share the page) cannot use the
// native side directly: they go through the backend, which checks their permissions.

import { ApiError } from './util.js';

const parseJson = JSON.parse;
const toJson = JSON.stringify;

let impl = null; // { sync(method, params), async(method, params) }
const listeners = new Map();

function unwrap(reply) {
  if (!reply || reply.ok !== true) throw new ApiError(reply?.error || 'native-error', reply?.detail || '');
  return reply.result;
}

function connect() {
  const N = globalThis.SkNative;
  if (!N || typeof N.boot !== 'function') return null;
  const key = N.boot();
  if (!key) return null;
  const pending = new Map();
  let nextId = 1;
  const hooks = {
    // an async call finished
    r(id) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      let reply;
      try { reply = parseJson(N.take(key, id)); } catch (e) { p.reject(new ApiError('native-error', String(e))); return; }
      try { p.resolve(unwrap(reply)); } catch (e) { p.reject(e); }
    },
    // an event from the native side
    e(name, id) {
      let payload = null;
      try { payload = parseJson(N.take(key, id)); } catch { return; }
      emitNative(name, payload);
    },
  };
  Object.defineProperty(globalThis, '__sknNative', { value: Object.freeze(hooks), writable: false, configurable: false });
  return {
    sync(method, params) {
      return unwrap(parseJson(N.call(key, method, toJson(params ?? {}))));
    },
    async(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try { N.callAsync(key, id, method, toJson(params ?? {})); } catch (e) { pending.delete(id); reject(new ApiError('native-error', String(e))); }
      });
    },
  };
}

function emitNative(name, payload) {
  for (const fn of listeners.get(name) || []) {
    try { fn(payload); } catch (e) { console.error('native event', name, e); }
  }
}

function get() {
  if (!impl) impl = connect();
  if (!impl) throw new ApiError('native-missing', 'the native side of sk_notes is not available');
  return impl;
}

export const native = {
  /** Synchronous native call (blocks the page: only small, fast operations). */
  sync: (method, params) => get().sync(method, params),
  /** Asynchronous native call (worker thread on the Java side). */
  async: (method, params) => get().async(method, params),
  /** Listen to native events (file changes, network streams, app life cycle). */
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name).delete(fn);
  },
  available() {
    try { get(); return true; } catch { return false; }
  },
};

/** Tests and the browser preview install their own native side. */
export function setNative(custom) {
  impl = custom;
  if (custom) custom.emit = emitNative;
}

// take the key now: this module is evaluated before any plugin code
try { get(); } catch { /* no native side yet (tests) */ }

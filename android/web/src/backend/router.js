// sk_notes for Android – API routes of the in-app backend and caller identities.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The page calls the backend like the desktop page calls Python: a method name and JSON
// parameters. A call made through a plugin's own shims carries that plugin's token, so
// the backend knows which plugin asks and applies its permissions.

import { ApiError } from './util.js';

const routes = new Map();
const tokens = new Map(); // token → plugin id
const issued = new Map(); // plugin id → token

export function route(name, fn) {
  routes.set(name, fn);
}

function randomToken() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Token for a plugin: one per plugin and page load. null when it already has one. */
export function issueToken(pluginId) {
  if (issued.has(pluginId)) return null;
  const tok = randomToken();
  issued.set(pluginId, tok);
  tokens.set(tok, pluginId);
  return tok;
}

/** Run a route. Returns its result, or a Promise of it for routes that wait for
 * something (network, a long scan). */
export function handle(method, params, token = null) {
  const fn = routes.get(method);
  if (!fn) throw new ApiError('unknown-method', method);
  let plugin = null;
  if (token !== null && token !== undefined) {
    plugin = tokens.get(token) || null;
    if (!plugin) throw new ApiError('permission-denied', 'unknown caller');
  }
  return fn(params || {}, { plugin });
}

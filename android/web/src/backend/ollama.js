// sk_notes for Android – Ollama client for SKAI over the local network.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A phone does not run Ollama. SKAI works when the settings name a PC on the same network
// that runs Skorpion OS (or any Ollama with an open endpoint); without one SKAI is simply
// off. Requests are made by the native side (plain HTTP on the LAN, no browser CORS), and
// the model is chosen like in every Skorpion app: the configured one, else the installed
// chat model with the most parameters.

import { native } from './native.js';
import { state } from './state.js';
import { ApiError, textToB64, b64ToText } from './util.js';

const LIST_TIMEOUT = 5;
const MAX_LINE = 4 * 1024 * 1024; // one streamed JSON line
const INACTIVITY_TIMEOUT = 600;
export const DEFAULT_PORT = 11434;

export class OllamaError extends Error {
  /** kind: not_configured | unreachable | no_model | model_missing | timeout | interrupted | server | invalid | empty | cancelled */
  constructor(kind, detail = '') {
    super(detail ? `${kind}: ${detail}` : kind);
    this.kind = kind;
    this.detail = detail;
  }
}

/** "192.168.1.20", "pc.local:11434", "http://host:port/" → "http://host:port" ('' if empty or not a host). */
export function normalizeHost(raw) {
  let s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch { return ''; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password) return '';
  const port = u.port || (u.protocol === 'https:' ? '' : String(DEFAULT_PORT));
  return `${u.protocol}//${u.hostname}${port ? ':' + port : ''}`;
}

export function config() {
  return { host: normalizeHost(state.settings.ollamaHost), model: String(state.settings.ollamaModel || '') };
}

const OLLAMA_PATHS = new Set(['', '/api/version', '/api/tags', '/api/ps', '/api/show', '/api/chat', '/api/generate', '/api/embed',
  '/api/embeddings', '/v1/models', '/v1/chat/completions', '/v1/completions', '/v1/embeddings']);

/** True if `url` asks the configured Ollama server for an answer: the one service plugins
 * may reach without the network permission. Pulling or creating models is not included. */
export function isOllamaUrl(url) {
  const host = config().host;
  if (!host) return false;
  try {
    const u = new URL(url);
    const o = new URL(host);
    const port = (x) => x.port || (x.protocol === 'https:' ? '443' : '80');
    return /^https?:$/.test(u.protocol) && u.hostname === o.hostname && port(u) === port(o) && OLLAMA_PATHS.has(u.pathname.replace(/\/+$/, ''));
  } catch { return false; }
}

export function parameterCount(size) {
  const m = /^\s*([\d.]+)\s*([kKmMbBtT])?/.exec(size || '');
  if (!m) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(m[2] || '').toLowerCase()] || 1;
  return parseFloat(m[1]) * mult;
}

function networkError(e) {
  if (e instanceof OllamaError) return e;
  const detail = String(e?.detail || e?.message || e);
  if (e?.code === 'cancelled') return new OllamaError('cancelled');
  return new OllamaError(/timed? ?out/i.test(detail) ? 'timeout' : 'unreachable', detail);
}

function httpError(status, body) {
  let msg = body;
  try { msg = JSON.parse(body).error || body; } catch { /* plain text */ }
  return new OllamaError(status === 404 ? 'model_missing' : 'server', String(msg).slice(0, 500));
}

export class Ollama {
  constructor() {
    this._caps = new Map();
    this._models = null;
    this._modelsTs = 0;
    this._host = '';
  }

  _base() {
    const { host } = config();
    if (!host) throw new OllamaError('not_configured');
    if (host !== this._host) { // another PC: nothing known about it
      this._host = host;
      this._caps.clear();
      this._models = null;
    }
    return host;
  }

  async _request(path, payload = null, timeout = LIST_TIMEOUT) {
    const url = this._base() + path;
    let r;
    try {
      r = await native.async('net.request', {
        url, method: payload === null ? 'GET' : 'POST', timeout, maxBytes: 64 * 1024 * 1024, local: true,
        headers: payload === null ? {} : { 'Content-Type': 'application/json' },
        body: payload === null ? '' : textToB64(JSON.stringify(payload)),
      });
    } catch (e) { throw networkError(e); }
    const text = b64ToText(r.b64 || '');
    if (r.status >= 400) throw httpError(r.status, text);
    try { return JSON.parse(text); } catch { throw new OllamaError('invalid', path); }
  }

  async models(refresh = false) {
    this._base();
    if (this._models && !refresh && Date.now() - this._modelsTs < 30000) return this._models;
    const data = await this._request('/api/tags');
    const out = [];
    for (const m of Array.isArray(data?.models) ? data.models : []) {
      if (!m?.name) continue;
      out.push({ name: m.name, parameter_size: m.details?.parameter_size || '', family: m.details?.family || '', capabilities: await this.capabilities(m.name) });
    }
    this._models = out;
    this._modelsTs = Date.now();
    return out;
  }

  async capabilities(name) {
    if (this._caps.has(name)) return this._caps.get(name);
    let caps = [];
    try { caps = (await this._request('/api/show', { model: name })).capabilities || []; } catch { caps = []; }
    if (!Array.isArray(caps) || !caps.length) caps = /bert|embed|minilm|nomic/i.test(name) ? ['embedding'] : ['completion']; // older Ollama: guess from the name
    this._caps.set(name, caps);
    return caps;
  }

  /** The model named in the settings, else the biggest installed chat model. */
  async chatModel() {
    const configured = config().model;
    if (configured) return configured;
    const chat = (await this.models()).filter((m) => m.capabilities.includes('completion') || !m.capabilities.includes('embedding'));
    if (!chat.length) throw new OllamaError('no_model');
    return chat.reduce((a, b) => (parameterCount(b.parameter_size) > parameterCount(a.parameter_size) ? b : a)).name;
  }

  async embedModel() {
    const emb = (await this.models()).filter((m) => m.capabilities.includes('embedding'));
    if (!emb.length) return null;
    return emb.reduce((a, b) => (parameterCount(b.parameter_size) > parameterCount(a.parameter_size) ? b : a)).name;
  }

  async status() {
    const host = config().host;
    if (!host) return { online: false, error: 'not_configured', host: '', configured: false };
    let models;
    try { models = await this.models(true); } catch (e) { return { online: false, error: networkError(e).kind, host, configured: true }; }
    let chat = '';
    try { chat = await this.chatModel(); } catch { chat = ''; }
    return { online: true, host, configured: true, chatModel: chat, embedModel: (await this.embedModel()) || '', models: models.map((m) => m.name), chatModels: models.filter((m) => m.capabilities.includes('completion') || !m.capabilities.includes('embedding')).map((m) => m.name) };
  }

  /** Stream a chat: onPiece(text) for every piece. Resolves when the answer is complete.
   * `job` = {id, cancelled}: set cancelled and call native net.cancel to stop it. */
  async chatStream(messages, { model = null, job, json = false, options = null, onPiece }) {
    const url = this._base() + '/api/chat';
    const payload = { model: model || await this.chatModel(), messages, stream: true };
    if (json) payload.format = 'json';
    if (options) payload.options = options;
    if (job.cancelled) throw new OllamaError('cancelled');
    let gotAny = false;
    let done = false;
    let failure = null;
    const off = native.on('net.line', (d) => {
      if (!d || d.id !== job.id || failure || done || job.cancelled) return;
      const line = String(d.line || '').trim();
      if (!line) return;
      if (line.length > MAX_LINE) { failure = new OllamaError('invalid', 'reply line too long'); return; }
      let obj;
      try { obj = JSON.parse(line); } catch { failure = new OllamaError('invalid', line.slice(0, 200)); return; }
      if (obj.error) { failure = new OllamaError('server', String(obj.error)); return; }
      const piece = obj.message?.content || '';
      if (piece) { gotAny = true; try { onPiece(piece); } catch (e) { console.error(e); } }
      if (obj.done) done = true;
    });
    let res;
    try {
      res = await native.async('net.stream', { id: job.id, url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: textToB64(JSON.stringify(payload)), timeout: INACTIVITY_TIMEOUT, maxLine: MAX_LINE, local: true });
    } catch (e) {
      off();
      if (job.cancelled) throw new OllamaError('cancelled');
      const err = networkError(e);
      throw gotAny && err.kind === 'unreachable' ? new OllamaError('interrupted', err.detail) : err;
    }
    // lines are delivered as events before the call returns, in order
    await new Promise((resolve) => setTimeout(resolve, 0));
    off();
    if (job.cancelled) throw new OllamaError('cancelled');
    if (res.status >= 400) throw httpError(res.status, res.body || '');
    if (failure) throw failure;
    if (!done && !gotAny) throw new OllamaError('interrupted');
    if (!gotAny) throw new OllamaError('empty');
  }

  async embed(texts, model = null) {
    const m = model || await this.embedModel();
    if (!m) throw new OllamaError('no_model', 'embedding');
    const data = await this._request('/api/embed', { model: m, input: texts }, 120);
    const vecs = data?.embeddings;
    if (!Array.isArray(vecs) || vecs.length !== texts.length) throw new OllamaError('invalid', 'embed size');
    return vecs;
  }
}

export { ApiError };

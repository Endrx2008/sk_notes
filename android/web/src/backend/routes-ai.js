// sk_notes for Android – SKAI API: connection settings (a PC on the local network),
// status, streamed chat (cancellable), embedding index, retrieval.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later

import { EmbeddingIndex, keywordRetrieve } from './embeddings.js';
import { native } from './native.js';
import { DEFAULT_PORT, Ollama, OllamaError, config, normalizeHost } from './ollama.js';
import { route } from './router.js';
import { emit, saveSettings, state, svc, vaultDataDir } from './state.js';
import { ApiError } from './util.js';

export function registerAi() {
  const r = route;
  const ollama = new Ollama();
  const jobs = new Map(); // chat id → {id, cancelled}
  let index = null;

  const embeddings = () => {
    if (!index) index = new EmbeddingIndex(vaultDataDir(svc().vault.root) + '/embeddings');
    return index;
  };

  const appOnly = (ctx) => { if (ctx.plugin) throw new ApiError('permission-denied'); };

  // ------------------------------------------------------------- connection settings
  r('ai.config', (p, ctx) => {
    appOnly(ctx);
    return { host: state.settings.ollamaHost, model: state.settings.ollamaModel, url: config().host, defaultPort: DEFAULT_PORT };
  });

  r('ai.setConfig', (p, ctx) => {
    appOnly(ctx);
    if (p.host !== undefined) {
      const raw = String(p.host || '').trim();
      if (raw && !normalizeHost(raw)) throw new ApiError('bad-host', raw);
      state.settings.ollamaHost = raw;
    }
    if (p.model !== undefined) state.settings.ollamaModel = String(p.model || '').trim();
    saveSettings();
    return { host: state.settings.ollamaHost, model: state.settings.ollamaModel, url: config().host };
  });

  /** Look for PCs answering as Ollama on the networks this phone is connected to. */
  r('ai.discover', async (p, ctx) => {
    appOnly(ctx);
    let found;
    try { found = await native.async('net.scan', { port: DEFAULT_PORT, path: '/api/version', timeout: 500 }); } catch (e) { throw new ApiError('scan-failed', e.detail || e.code || String(e)); }
    return (Array.isArray(found) ? found : []).map((h) => ({ host: String(h.host), name: String(h.name || ''), version: String(h.version || '') }));
  });

  // ------------------------------------------------------------- status & chat
  r('ai.status', async () => {
    const st = await ollama.status();
    st.memory = false; // SKAI_ Memory lives on Skorpion OS
    if (state.service) {
      try { st.index = embeddings().status(st.embedModel); } catch { st.index = null; }
    }
    return st;
  });

  r('ai.chat', (p) => {
    const id = String(p.id || '');
    if (!id) throw new ApiError('bad-request');
    const job = { id, cancelled: false };
    jobs.set(id, job);
    const messages = Array.isArray(p.messages) ? p.messages : [];
    const options = p.temperature !== null && p.temperature !== undefined ? { temperature: Number(p.temperature) } : null;
    (async () => {
      try {
        await ollama.chatStream(messages, { job, json: !!p.json, options, onPiece: (text) => { if (!job.cancelled) emit('ai-chunk', { id, text }); } });
        if (!job.cancelled) emit('ai-done', { id });
      } catch (e) {
        if (job.cancelled) return; // already reported by ai.cancel
        if (e instanceof OllamaError) emit('ai-error', { id, kind: e.kind === 'not_configured' ? 'unreachable' : e.kind, detail: e.detail.slice(0, 500) });
        else { console.error('chat failed', e); emit('ai-error', { id, kind: 'bug', detail: String(e?.message || e).slice(0, 500) }); }
      } finally {
        jobs.delete(id);
      }
    })();
    return { started: true };
  });

  r('ai.cancel', (p) => {
    const id = String(p.id);
    const job = jobs.get(id);
    if (job && !job.cancelled) {
      job.cancelled = true;
      try { native.sync('net.cancel', { id }); } catch { /* nothing to stop yet */ }
      emit('ai-error', { id, kind: 'cancelled', detail: '' }); // the UI is free at once
    }
    return !!job;
  });

  // ------------------------------------------------------------- embedding index
  r('ai.index.build', async () => {
    let model;
    try { model = await ollama.embedModel(); } catch { model = null; }
    if (!model) return { model: null };
    const s = svc();
    (async () => {
      try {
        const res = await embeddings().build(s, ollama, model, (done, total) => emit('ai-index', { done, total }));
        emit('ai-index', { finished: true, ...res });
      } catch (e) {
        if (e instanceof OllamaError) emit('ai-index', { error: e.kind, detail: e.detail.slice(0, 300) });
        else { console.error('embedding index failed', e); emit('ai-index', { error: 'bug', detail: String(e?.message || e).slice(0, 300) }); }
      }
    })();
    return { model, started: true };
  });

  r('ai.index.stop', () => {
    if (index) index.cancelled = true;
    return true;
  });

  r('ai.retrieve', async (p) => {
    const query = String(p.query || '').slice(0, 2000);
    const k = Number(p.k) || 6;
    const s = svc();
    let model = null;
    try { model = await ollama.embedModel(); } catch { model = null; }
    // why keywords are used, so the UI says the right thing
    const reason = !model ? 'no-model' : (!embeddings().status(model).chunks ? 'no-index' : 'no-match');
    if (model && reason !== 'no-index') {
      try {
        const vec = (await ollama.embed([query], model))[0];
        const hits = await embeddings().search(vec, model, k);
        if (hits.length) return { method: 'embeddings', hits, memory: [] };
      } catch (e) { if (!(e instanceof OllamaError)) throw e; }
    }
    return { method: 'keywords', reason, hits: await keywordRetrieve(s, query, k), memory: [] };
  });

  r('ai.remember', () => ({ saved: false }));
  r('ai.memory', () => ({ available: false }));
}

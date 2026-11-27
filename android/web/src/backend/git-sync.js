// sk_notes for Android – keeping a vault in step with a Git repository (GitHub, GitLab, any Git server).
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// One round of sync() does what a person does by hand with Git, in this order:
//   1. ask the server where its branch is;
//   2. commit what changed in the vault;
//   3. if the server has commits this device lacks: fetch them and merge;
//   4. push.
// The result is a normal repository with a normal history: the PC can work on the same
// notes with Git itself, with the Git plugin of Obsidian, with Foam in VS Code.
//
// Nothing is ever lost in a merge, and no note is left with conflict markers inside:
//   - a note changed on both sides in different places is merged line by line;
//   - a note changed on both sides in the same place keeps the server's text, and the
//     text of this device is saved beside it as "Name (conflict <date>).md";
//   - a note deleted on one side and changed on the other is kept.
// The Git folder is NOT inside the vault: it lives in the app's private storage, where
// neither other apps nor community plugins reach it.

import diff3Merge from 'diff3';

export const DEFAULT_IGNORE = [
  '# Files that belong to one device only (written by sk_notes)',
  '.trash/',
  '.sk_notes/workspace.json',
  '.sk_notes/workspaces.json',
  '.sk_notes/workspace-mobile.json',
  '.sk_notes/workspaces-mobile.json',
  '.sk_notes/rename-journal.json',
  '.sk_notes/graph-positions.json',
  '.sk_notes/reminders-shown.json',
  '.sk_notes/cache.db*',
  '.sk_notes/history.db*',
  '.sk_notes/embeddings.db*',
  '.obsidian/workspace.json',
  '.obsidian/workspace-mobile.json',
  '.obsidian/cache',
  '',
].join('\n');

// never committed from this device and never overwritten on it, whatever .gitignore says
const DEVICE_FILES = new Set(['.sk_notes/workspace-mobile.json', '.sk_notes/graph-positions.json', '.sk_notes/workspaces-mobile.json', '.sk_notes/rename-journal.json', '.sk_notes/reminders-shown.json']);
export const isDeviceFile = (p) => DEVICE_FILES.has(p) || p === '.trash' || p.startsWith('.trash/') || /(^|\/)\.skn-tmp-[^/]*$/.test(p);

const MAX_FILE = 50 * 1024 * 1024; // larger files stay on the device (hosting sites refuse big files)
const TEXT_MERGE = /\.(md|markdown|txt)$/i;
const LINES = /^.*(\r?\n|$)/gm;
const isConfigPath = (p) => p.startsWith('.');
const same = (a, b) => (!a && !b) || (!!a && !!b && a.oid === b.oid);
const strict = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/** Error with a code the UI has a text for. */
export class SyncError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

/** Errors of the Git library and of the network → codes of the UI. */
export function classify(e) {
  if (e instanceof SyncError) return e;
  const code = e?.code || '';
  const status = e?.data?.statusCode;
  if (code === 'HttpError') {
    if (status === 401 || status === 403) return new SyncError('sync-auth', String(status));
    if (status === 404) return new SyncError('sync-no-repo');
    return new SyncError('sync-http', String(status));
  }
  if (code === 'SmartHttpError') return new SyncError('sync-not-git');
  if (code === 'network-error' || code === 'too-large') return new SyncError(code, e.detail || '');
  if (code === 'PushRejectedError' || code === 'GitPushError') return new SyncError('sync-rejected', String(e?.data?.reason || e?.data?.prettyDetails || e.message || ''));
  if (code === 'ENOSPC') return new SyncError('disk-full');
  return new SyncError('sync-failed', String(e?.detail || e?.message || e));
}

/** 'Folder/Note.md' → 'Folder/Note (conflict 2026-11-15 14.05).md', a name not in use. */
export function conflictName(path, stamp, taken) {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const candidate = `${dir}${base} (conflict ${stamp}${n > 1 ? ' ' + n : ''})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Line-by-line merge of three texts; null when both sides changed the same lines. */
export function mergeText(ours, base, theirs) {
  const split = (s) => s.match(LINES) || [];
  let out = '';
  for (const part of diff3Merge(split(ours), split(base), split(theirs))) {
    if (!part.ok) return null;
    out += part.ok.join('');
  }
  return out;
}

export class GitSync {
  /** git: the isomorphic-git module; fs, http: see git-adapters.js; dir: the vault;
   * gitdir: where the repository data is kept; author: {name, email};
   * beforeOverwrite(path, bytes): called before a file of the vault is replaced or removed. */
  constructor({ git, fs, http, dir, gitdir, url, branch = 'main', author, beforeOverwrite = null, now = () => new Date() }) {
    Object.assign(this, { git, fs, http, dir, gitdir, url, branch, author, beforeOverwrite, now });
    this.cache = {};
    this.unwritable = null; // paths of the repository this device cannot store (names Android refuses)
  }

  get base() { return { fs: this.fs, dir: this.dir, gitdir: this.gitdir, cache: this.cache }; }

  // ------------------------------------------------------------- small helpers
  async _read(path) {
    try { return await this.fs.promises.readFile(path); } catch { return null; }
  }

  async _exists(path) {
    try { await this.fs.promises.stat(path); return true; } catch { return false; }
  }

  async _loadUnwritable() {
    if (this.unwritable) return;
    this.unwritable = new Set();
    const raw = await this._read(this.gitdir + '/sk_notes-unwritable.json');
    if (!raw) return;
    try { for (const p of JSON.parse(strict.decode(raw))) if (typeof p === 'string') this.unwritable.add(p); } catch { /* start again */ }
  }

  async _saveUnwritable() {
    await this.fs.promises.writeFile(this.gitdir + '/sk_notes-unwritable.json', JSON.stringify([...this.unwritable]));
  }

  /** Files this device neither commits nor writes. */
  skips(path) { return isDeviceFile(path) || !!this.unwritable?.has(path); }

  stamp() {
    const d = this.now();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
  }

  async head() {
    try { return await this.git.resolveRef({ fs: this.fs, gitdir: this.gitdir, ref: 'HEAD' }); } catch { return null; }
  }

  async _has(oid) {
    try { await this.git.readCommit({ ...this.base, oid }); return true; } catch { return false; }
  }

  // ------------------------------------------------------------- server
  /** What the server has: {branches: {name: oid}, defaultBranch}. Also proves the address
   * and the sign-in are right. */
  async remoteInfo() {
    const refs = await this.git.listServerRefs({ http: this.http, url: this.url, protocolVersion: 1, symrefs: true });
    const branches = {};
    let defaultBranch = null;
    for (const r of refs) {
      if (r.ref === 'HEAD' && typeof r.target === 'string' && r.target.startsWith('refs/heads/')) defaultBranch = r.target.slice(11);
      if (r.ref.startsWith('refs/heads/')) branches[r.ref.slice(11)] = r.oid;
    }
    if (!defaultBranch || !(defaultBranch in branches)) defaultBranch = 'main' in branches ? 'main' : 'master' in branches ? 'master' : Object.keys(branches)[0] || null;
    return { branches, defaultBranch };
  }

  // ------------------------------------------------------------- set up
  /** A new, empty repository for this vault (any older one of this vault is dropped; the
   * notes are not touched). */
  async init() {
    const p = this.fs.promises;
    const wipe = async (path) => {
      let names;
      try { names = await p.readdir(path); } catch { return; }
      for (const n of names) {
        const child = `${path}/${n}`;
        if ((await p.stat(child)).isDirectory()) await wipe(child); else await p.unlink(child);
      }
      await p.rmdir(path);
    };
    await wipe(this.gitdir);
    this.cache = {};
    this.unwritable = new Set();
    await this.git.init({ fs: this.fs, dir: this.dir, gitdir: this.gitdir, defaultBranch: this.branch });
    // the address is given again at every call (see sync()); this entry only names the branch to follow
    await this.git.addRemote({ fs: this.fs, dir: this.dir, gitdir: this.gitdir, remote: 'origin', url: this.url, force: true });
    if (!(await this._exists(this.dir + '/.gitignore'))) await p.writeFile(this.dir + '/.gitignore', DEFAULT_IGNORE);
  }

  async isInitialised() { return this._exists(this.gitdir + '/HEAD'); }

  // ------------------------------------------------------------- 1. commit
  /** Commit everything that changed in the vault. Returns {committed, tooBig}. */
  async commitLocal() {
    const { git } = this;
    await this._loadUnwritable();
    const rows = await git.statusMatrix({ ...this.base, filter: (f) => !this.skips(f) });
    const add = [];
    const remove = [];
    const tooBig = [];
    let dirty = false;
    for (const [path, head, work, stage] of rows) {
      if (work === 0) {
        if (stage !== 0) remove.push(path);
        if (head === 1) dirty = true;
        continue;
      }
      if (stage === 2 || (work === 1 && stage === 1)) { if (work === 2) dirty = true; continue; }
      if (work === 2) {
        let size = 0;
        try { size = (await this.fs.promises.stat(`${this.dir}/${path}`)).size; } catch { continue; }
        if (size > MAX_FILE) { tooBig.push(path); continue; }
        dirty = true;
      }
      add.push(path);
    }
    if (add.length) await git.add({ ...this.base, filepath: add, force: true, parallel: false });
    for (const path of remove) await git.remove({ ...this.base, filepath: path });
    if (!dirty) return { committed: false, tooBig };
    const d = this.now();
    const p = (n) => String(n).padStart(2, '0');
    const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    await git.commit({ ...this.base, message: `sk_notes (Android): ${when}\n`, author: this.author });
    return { committed: true, tooBig };
  }

  // ------------------------------------------------------------- 3. merge
  /** The files of a commit: Map(path → {oid, mode, type}). */
  async _flat(oid) {
    const out = new Map();
    if (!oid) return out;
    const { git } = this;
    await git.walk({
      ...this.base,
      trees: [git.TREE({ ref: oid })],
      map: async (path, [entry]) => {
        if (path === '.' || !entry) return true;
        const type = await entry.type();
        if (type !== 'tree') out.set(path, { oid: await entry.oid(), mode: await entry.mode(), type });
        return true;
      },
    });
    return out;
  }

  /** Decide, file by file, what the merged vault holds. */
  async _mergeFlat(ours, base, theirs) {
    const { git } = this;
    const result = new Map();
    const conflicts = [];
    const stamp = this.stamp();
    const text = async (e) => strict.decode((await git.readBlob({ ...this.base, oid: e.oid })).blob);
    const taken = (p) => ours.has(p) || theirs.has(p) || result.has(p);
    for (const path of new Set([...ours.keys(), ...theirs.keys(), ...base.keys()])) {
      const o = ours.get(path);
      const b = base.get(path);
      const t = theirs.get(path);
      let keep;
      if (same(o, t)) keep = o;
      else if (same(o, b)) keep = t;
      else if (same(t, b)) keep = o;
      else if (!o) keep = t; // deleted here, changed there: the change is kept
      else if (!t) keep = o; // deleted there, changed here: the change is kept
      else if (o.type !== 'blob' || t.type !== 'blob' || isConfigPath(path)) keep = t; // settings: no copies, the server's win
      else {
        let merged = null;
        if (b && b.type === 'blob' && TEXT_MERGE.test(path)) {
          try { merged = mergeText(await text(o), await text(b), await text(t)); } catch { merged = null; } // not UTF-8
        }
        if (merged !== null) keep = { oid: await git.writeBlob({ ...this.base, blob: encoder.encode(merged) }), mode: o.mode, type: 'blob' };
        else {
          keep = t;
          const copy = conflictName(path, stamp, taken);
          result.set(copy, o);
          conflicts.push({ path, copy });
        }
      }
      if (keep) result.set(path, keep);
    }
    return { result, conflicts };
  }

  /** Write the tree objects for a set of files; returns the id of the top one. */
  async _writeTrees(flat) {
    const { git } = this;
    const root = { dirs: new Map(), files: [] };
    for (const [path, e] of flat) {
      const parts = path.split('/');
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push({ mode: e.mode.toString(8).padStart(6, '0'), path: parts[parts.length - 1], oid: e.oid, type: e.type });
    }
    const write = async (node) => {
      const tree = node.files.slice();
      for (const [name, child] of node.dirs) tree.push({ mode: '040000', path: name, oid: await write(child), type: 'tree' });
      return git.writeTree({ fs: this.fs, dir: this.dir, gitdir: this.gitdir, tree });
    };
    return write(root);
  }

  /** Bring the files of the vault from `ours` to `result`. A file the user changed while
   * the sync was running is never overwritten: its text is put aside first. */
  async _applyToVault(ours, result) {
    const { git } = this;
    const p = this.fs.promises;
    const out = { written: [], removed: [], indexOnly: [], late: [] };
    const stamp = this.stamp();
    let unwritableChanged = false;
    for (const path of new Set([...ours.keys(), ...result.keys()])) {
      const o = ours.get(path);
      const r = result.get(path);
      if (same(o, r)) continue;
      if (this.skips(path) || (r && r.type !== 'blob')) { out.indexOnly.push(path); continue; }
      const abs = `${this.dir}/${path}`;
      const cur = await this._read(abs);
      const curOid = cur ? (await git.hashBlob({ object: cur })).oid : null;
      if (r) {
        if (curOid === r.oid) { out.written.push(path); continue; }
        try {
          if (cur && curOid !== (o && o.oid) && !isConfigPath(path)) {
            const copy = conflictName(path, stamp, (c) => ours.has(c) || result.has(c));
            await p.writeFile(`${this.dir}/${copy}`, cur);
            out.late.push({ path, copy });
          } else if (cur && this.beforeOverwrite) this.beforeOverwrite(path, cur);
          await p.writeFile(abs, (await git.readBlob({ ...this.base, oid: r.oid })).blob);
          out.written.push(path);
        } catch (e) {
          if (e?.code === 'ENOSPC') throw e;
          this.unwritable.add(path);
          unwritableChanged = true;
          out.indexOnly.push(path);
        }
      } else {
        if (cur && curOid === o.oid) {
          if (this.beforeOverwrite) this.beforeOverwrite(path, cur);
          await p.unlink(abs).catch(() => {});
          // folders left empty by the removal go with it
          for (let d = path.lastIndexOf('/'); d > 0; d = path.lastIndexOf('/', d - 1)) {
            try { await p.rmdir(`${this.dir}/${path.slice(0, d)}`); } catch { break; }
          }
        }
        if (this.unwritable.delete(path)) unwritableChanged = true;
        out.removed.push(path);
      }
    }
    if (unwritableChanged) await this._saveUnwritable();
    return out;
  }

  async _updateIndex(applied, result) {
    const { git } = this;
    if (applied.written.length) await git.add({ ...this.base, filepath: applied.written, force: true, parallel: false });
    for (const path of applied.removed) await git.remove({ ...this.base, filepath: path });
    for (const path of applied.indexOnly) {
      const r = result.get(path);
      if (!r) await git.remove({ ...this.base, filepath: path });
      else if (r.type === 'blob') await git.updateIndex({ ...this.base, filepath: path, oid: r.oid, mode: r.mode, add: true });
    }
  }

  /** Merge the server's commit `remote` into the vault. Returns what happened. */
  async merge(local, remote) {
    const { git } = this;
    await this._loadUnwritable();
    let base = null;
    if (local) {
      const bases = await git.findMergeBase({ ...this.base, oids: [local, remote] });
      base = bases[0] || null;
    }
    const [ours, theirs, baseFlat] = [await this._flat(local), await this._flat(remote), await this._flat(base)];
    const { result, conflicts } = await this._mergeFlat(ours, baseFlat, theirs);
    const tree = await this._writeTrees(result);
    const theirTree = (await git.readCommit({ ...this.base, oid: remote })).commit.tree;
    let head = remote; // nothing of ours to add: the branch simply moves forward
    if (!(tree === theirTree && (!local || base === local))) {
      head = await git.commit({ ...this.base, message: `Merge the changes of other devices (sk_notes Android)\n`, tree, parent: local ? [local, remote] : [remote], author: this.author, noUpdateBranch: true });
    }
    // files first, then the branch, then the index: stopped half-way, the next round sees
    // the merged files as changes of this device and finishes the job
    const applied = await this._applyToVault(ours, result);
    await git.writeRef({ fs: this.fs, gitdir: this.gitdir, ref: `refs/heads/${this.branch}`, value: head, force: true });
    await this._updateIndex(applied, result);
    return { head, changed: [...applied.written, ...applied.removed], conflicts: [...conflicts, ...applied.late], needsPush: head !== remote };
  }

  // ------------------------------------------------------------- the whole round
  async sync() {
    const { git } = this;
    const out = { committed: false, pulled: 0, pushed: false, changed: [], conflicts: [], tooBig: [], unwritable: [] };
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.cache = {};
      const remote = (await this.remoteInfo()).branches[this.branch] || null;
      const fetched = async () => {
        if (!(await this._has(remote))) await git.fetch({ ...this.base, http: this.http, url: this.url, remote: 'origin', ref: this.branch, singleBranch: true, tags: false });
      };
      const merged = (m) => { out.changed.push(...m.changed); out.conflicts.push(...m.conflicts); return m.needsPush; };
      // the first round of a vault: the repository's files (and its .gitignore) come first,
      // then what this device has is committed on top
      if (remote && !(await this.head())) { await fetched(); merged(await this.merge(null, remote)); }
      const c = await this.commitLocal();
      out.committed ||= c.committed;
      out.tooBig = c.tooBig;
      const local = await this.head();
      let push = false;
      if (!remote) push = !!local; // an empty repository on the server: ours is the first commit
      else if (remote !== local) {
        await fetched();
        const ahead = local ? await git.isDescendent({ ...this.base, oid: local, ancestor: remote, depth: -1 }) : false;
        if (ahead) push = true;
        else push = merged(await this.merge(local, remote));
      }
      if (!push) { lastError = null; break; }
      try {
        const res = await git.push({ ...this.base, http: this.http, url: this.url, remote: 'origin', ref: this.branch, remoteRef: `refs/heads/${this.branch}` });
        if (res && res.ok === false) throw new SyncError('sync-rejected', String(res.error || ''));
        out.pushed = true;
        lastError = null;
        break;
      } catch (e) {
        // another device pushed in the meantime: take its commits and try again
        if (e?.code === 'PushRejectedError' || e?.code === 'GitPushError') { lastError = e; continue; }
        throw e;
      }
    }
    if (lastError) throw lastError;
    out.changed = [...new Set(out.changed)];
    out.pulled = out.changed.length;
    out.unwritable = [...(this.unwritable || [])];
    this.cache = {};
    return out;
  }
}

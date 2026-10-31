// Command registry with default and custom hotkeys (stored in .sk_notes/hotkeys.json).

import { hotkeyMatches } from './keymap.js';

export class Commands {
  constructor(app) {
    this.app = app;
    this.commands = Object.create(null);
    this.editorCommands = Object.create(null);
    this.customHotkeys = Object.create(null); // id -> [{modifiers, key}]
    this.recent = [];
  }

  addCommand(cmd) {
    if (!cmd || !cmd.id) throw new Error('command needs an id');
    this.commands[cmd.id] = cmd;
    if (cmd.editorCallback || cmd.editorCheckCallback) this.editorCommands[cmd.id] = cmd;
    return cmd;
  }

  removeCommand(id) {
    delete this.commands[id];
    delete this.editorCommands[id];
  }

  findCommand(id) {
    return this.commands[id] || null;
  }

  listCommands() {
    return Object.values(this.commands).filter((c) => this.isAvailable(c));
  }

  allCommands() {
    return Object.values(this.commands);
  }

  hotkeysFor(id) {
    if (this.customHotkeys[id]) return this.customHotkeys[id];
    return this.commands[id]?.hotkeys || [];
  }

  isAvailable(cmd) {
    try {
      if (cmd.checkCallback) return !!cmd.checkCallback(true);
      if (cmd.editorCheckCallback || cmd.editorCallback) {
        const ctx = this.app.workspace.activeEditor;
        if (!ctx?.editor) return false;
        if (cmd.editorCheckCallback) return !!cmd.editorCheckCallback(true, ctx.editor, ctx);
      }
      return true;
    } catch (e) {
      console.error('command check failed', cmd.id, e);
      return false;
    }
  }

  executeCommand(cmd) {
    try {
      if (cmd.checkCallback) {
        if (!cmd.checkCallback(true)) return false;
        cmd.checkCallback(false);
      } else if (cmd.editorCheckCallback || cmd.editorCallback) {
        const ctx = this.app.workspace.activeEditor;
        if (!ctx?.editor) return false;
        if (cmd.editorCheckCallback) {
          if (!cmd.editorCheckCallback(true, ctx.editor, ctx)) return false;
          cmd.editorCheckCallback(false, ctx.editor, ctx);
        } else {
          cmd.editorCallback(ctx.editor, ctx);
        }
      } else if (cmd.callback) {
        cmd.callback();
      } else {
        return false;
      }
    } catch (e) {
      console.error('command failed', cmd.id, e);
      this.app.notice?.(String(e?.message || e));
      return false;
    }
    this.recent = [cmd.id, ...this.recent.filter((x) => x !== cmd.id)].slice(0, 20);
    this.app.workspace?.trigger('command-run', cmd);
    return true;
  }

  executeCommandById(id) {
    const cmd = this.commands[id];
    return cmd ? this.executeCommand(cmd) : false;
  }

  /** Keydown at the app level: run the first available command whose hotkey matches. */
  handleKey(evt) {
    for (const id in this.commands) {
      const hks = this.hotkeysFor(id);
      if (!hks.length) continue;
      if (hks.some((hk) => hotkeyMatches(hk, evt))) {
        const cmd = this.commands[id];
        if (this.isAvailable(cmd)) {
          this.executeCommand(cmd);
          return true;
        }
      }
    }
    return false;
  }

  setHotkeys(id, list) {
    if (list === null) delete this.customHotkeys[id];
    else this.customHotkeys[id] = list;
    this.app.config.write('hotkeys.json', this.customHotkeys);
  }

  conflicts(hk, exceptId) {
    const out = [];
    for (const id in this.commands) {
      if (id === exceptId) continue;
      if (this.hotkeysFor(id).some((h) => h.key.toUpperCase() === hk.key.toUpperCase()
        && (h.modifiers || []).slice().sort().join() === (hk.modifiers || []).slice().sort().join())) out.push(id);
    }
    return out;
  }
}

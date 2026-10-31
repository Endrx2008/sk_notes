// FileManager: renames with link updates, frontmatter edits, new-file locations.

import YAML from 'yaml';
import { call } from '../core/api.js';
import { t } from '../core/i18n.js';
import { TFile, TFolder, normalizePath } from './vault.js';
import { confirmDialog } from '../ui/kit.js';

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/;

export function parseYaml(text) {
  return YAML.parse(text, { schema: 'core', strict: false, uniqueKeys: false }) ?? null;
}

export function stringifyYaml(obj) {
  return YAML.stringify(obj, { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' });
}

export function getFrontMatterInfo(text) {
  const m = FM_RE.exec(text);
  if (!m) return { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 };
  return { exists: true, frontmatter: m[1], from: 4, to: 4 + m[1].length, contentStart: m[0].length };
}

export class FileManager {
  constructor(app) {
    this.app = app;
    this.vault = app.vault;
  }

  getNewFileParent(sourcePath = '', newFilePath) {
    const s = this.app.settings;
    const where = s.get('newFileLocation') || 'root';
    if (where === 'folder') {
      const f = this.vault.getAbstractFileByPath(s.get('newFileFolderPath') || '/');
      if (f instanceof TFolder) return f;
    }
    if (where === 'current') {
      const src = this.vault.getAbstractFileByPath(sourcePath) || this.app.workspace.getActiveFile();
      if (src?.parent) return src.parent;
    }
    return this.vault.getRoot();
  }

  async createNewMarkdownFile(folder, name, content = '') {
    folder = folder || this.getNewFileParent();
    const base = (name || t('file.untitled')).replace(/[\\/:]/g, '-');
    const path = await call('vault.availablePath', { folder: folder.path === '/' ? '' : folder.path, base, ext: 'md' });
    await this.vault.create(path, content);
    return this.vault.getFileByPath(path);
  }

  async createNewFile(folder, name, ext, content = '') {
    folder = folder || this.getNewFileParent();
    const path = await call('vault.availablePath', { folder: folder.path === '/' ? '' : folder.path, base: name, ext });
    await this.vault.create(path, content);
    return this.vault.getFileByPath(path);
  }

  async createNewMarkdownFileFromLinktext(linktext, sourcePath) {
    const clean = linktext.replace(/\.md$/, '');
    if (clean.includes('/')) {
      const path = normalizePath(clean + '.md');
      const folder = path.slice(0, path.lastIndexOf('/'));
      if (!this.vault.getAbstractFileByPath(folder)) await this.vault.createFolder(folder).catch(() => {});
      await this.vault.create(path, '');
      return this.vault.getFileByPath(path);
    }
    return this.createNewMarkdownFile(this.getNewFileParent(sourcePath), clean);
  }

  async renameFile(file, newPath) {
    newPath = normalizePath(newPath);
    if (newPath === file.path) return;
    await call('vault.rename', { path: file.path, newPath, updateLinks: this.app.settings.get('alwaysUpdateLinks') !== false });
  }

  generateMarkdownLink(file, sourcePath, subpath = '', alias = '') {
    const useMd = this.app.settings.get('useMarkdownLinks');
    const isEmbed = file.extension !== 'md';
    const linktext = this.app.metadataCache.fileToLinktext(file, sourcePath, true);
    if (!useMd) {
      const inner = linktext + (subpath || '') + (alias ? '|' + alias : '');
      return (isEmbed && /^(png|jpe?g|gif|bmp|svg|webp|avif|mp3|wav|ogg|m4a|mp4|webm|pdf)$/.test(file.extension) ? '!' : '') + `[[${inner}]]`;
    }
    const url = encodeURI(file.path).replace(/\(/g, '%28').replace(/\)/g, '%29') + (subpath ? encodeURI(subpath) : '');
    return `${isEmbed ? '!' : ''}[${alias || file.basename}](${url})`;
  }

  async processFrontMatter(file, fn, options) {
    await this.vault.process(file, (text) => {
      const info = getFrontMatterInfo(text);
      let data = {};
      if (info.exists) {
        try { data = parseYaml(info.frontmatter) || {}; } catch (e) { throw new Error(t('notice.yaml-invalid')); }
      }
      fn(data);
      const keys = Object.keys(data);
      const yaml = keys.length ? stringifyYaml(data).trimEnd() : '';
      const body = info.exists ? text.slice(info.contentStart) : text;
      if (!yaml) return body;
      return `---\n${yaml}\n---\n${body}`;
    }, options);
  }

  async getAvailablePathForAttachment(filename, sourcePath) {
    const setting = this.app.settings.get('attachmentFolderPath') || '/';
    const dot = filename.lastIndexOf('.');
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot + 1) : '';
    let folder = '';
    const src = sourcePath ? this.vault.getAbstractFileByPath(sourcePath) : null;
    const srcFolder = src?.parent && src.parent.path !== '/' ? src.parent.path : '';
    if (setting === './') folder = srcFolder;
    else if (setting.startsWith('./')) folder = normalizePath((srcFolder ? srcFolder + '/' : '') + setting.slice(2));
    else if (setting !== '/') folder = normalizePath(setting);
    if (folder === '/') folder = '';
    if (folder && !this.vault.getAbstractFileByPath(folder)) await this.vault.createFolder(folder).catch(() => {});
    return call('vault.availablePath', { folder, base, ext });
  }

  async trashFile(file) {
    const mode = this.app.settings.get('trashOption') || 'system';
    await call('vault.delete', { path: file.path, mode: mode === 'none' ? 'permanent' : mode });
  }

  async promptForDeletion(file) {
    if (this.app.settings.get('promptDelete') === false) { await this.trashFile(file); return true; }
    const isFolder = file instanceof TFolder;
    const ok = await confirmDialog(this.app, {
      title: isFolder ? t('delete.folder-title') : t('delete.file-title'),
      message: isFolder ? t('delete.folder-message', { name: file.name, n: countFiles(file) }) : t('delete.file-message', { name: file.name }),
      confirm: t('common.delete'), warning: true,
    });
    if (ok) await this.trashFile(file);
    return ok;
  }

  async promptForFileRename(file) {
    const { promptDialog } = await import('../ui/kit.js');
    const name = await promptDialog(this.app, { title: t('file.rename'), value: file instanceof TFile ? file.basename : file.name, confirm: t('common.rename') });
    if (!name || name === (file instanceof TFile ? file.basename : file.name)) return;
    const parent = file.parent && file.parent.path !== '/' ? file.parent.path + '/' : '';
    const target = file instanceof TFile ? `${parent}${name}.${file.extension}` : `${parent}${name}`;
    try { await this.renameFile(file, target); } catch (e) { this.app.notice(t('notice.rename-failed', { error: e.code || e.message })); }
  }
}

function countFiles(folder) {
  let n = 0;
  const walk = (f) => { if (f instanceof TFile) n++; else for (const c of f.children) walk(c); };
  walk(folder);
  return n;
}

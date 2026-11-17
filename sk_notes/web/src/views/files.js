// Views for non-Markdown files.

import { resourceUrl } from '../core/api.js';
import { t } from '../core/i18n.js';
import { FileView } from './base.js';

class MediaView extends FileView {
  constructor(leaf, type, icon) {
    super(leaf);
    this._type = type;
    this.icon = icon;
    this.contentEl.addClass(`${type}-view-content`);
  }
  getViewType() { return this._type; }
  getIcon() { return this.icon; }
  getDisplayText() { return this.file ? this.file.name : t('view.no-file'); }
  async onLoadFile(file) { this.contentEl.empty(); this.renderFile(file); }
  async onUnloadFile() { this.contentEl.empty(); }
  async onRename(file) { await super.onRename(file); }
}

export class ImageView extends MediaView {
  constructor(leaf) { super(leaf, 'image', 'image'); }
  canAcceptExtension(ext) { return ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif'].includes(ext); }
  renderFile(file) {
    const box = this.contentEl.createDiv('image-container');
    const img = box.createEl('img', { attr: { src: resourceUrl(file.path, file.stat.mtime), alt: file.name } });
    img.addEventListener('click', () => box.toggleClass('is-zoomed', !box.hasClass('is-zoomed')));
  }
}

export class AudioView extends MediaView {
  constructor(leaf) { super(leaf, 'audio', 'music'); }
  canAcceptExtension(ext) { return ['mp3', 'wav', 'm4a', 'ogg', '3gp', 'flac', 'opus'].includes(ext); }
  renderFile(file) { this.contentEl.createDiv('audio-container').createEl('audio', { attr: { controls: true, src: resourceUrl(file.path, file.stat.mtime) } }); }
}

export class VideoView extends MediaView {
  constructor(leaf) { super(leaf, 'video', 'film'); }
  canAcceptExtension(ext) { return ['mp4', 'webm', 'ogv', 'mov', 'mkv'].includes(ext); }
  renderFile(file) { this.contentEl.createDiv('video-container').createEl('video', { attr: { controls: true, src: resourceUrl(file.path, file.stat.mtime) } }); }
}

export class PdfView extends MediaView {
  constructor(leaf) { super(leaf, 'pdf', 'pdf'); }
  canAcceptExtension(ext) { return ext === 'pdf'; }
  renderFile(file) {
    if (this.app.renderPdf) { this.pdfDone = this.app.renderPdf(this.contentEl, file); return; }
    this.contentEl.createEl('iframe', { cls: 'pdf-container', attr: { src: resourceUrl(file.path, file.stat.mtime) } });
  }
  setEphemeralState(st) {
    const page = /page=(\d+)/.exec(st?.subpath || '')?.[1];
    if (page && this.pdfDone) { this.pdfDone.then((show) => show && show(Number(page))); return; }
    if (page && this.file) this.contentEl.find('iframe')?.setAttr('src', resourceUrl(this.file.path, this.file.stat.mtime) + `#page=${page}`);
  }
}

export class UnknownFileView extends MediaView {
  constructor(leaf) { super(leaf, 'unknown-file', 'file'); }
  renderFile(file) {
    const box = this.contentEl.createDiv('empty-state');
    box.createDiv({ cls: 'empty-state-title', text: t('view.unsupported', { name: file.name }) });
    const b = box.createEl('button', { cls: 'mod-cta', text: t('file.open-default-app') });
    b.addEventListener('click', () => this.app.api('system.openPath', { path: file.path }));
  }
}

// The "obsidian" module community plugins import: sk_notes' own implementation of
// the public plugin API (names and signatures follow the public MIT-licensed type
// definitions; nothing here is copied from the reference application).

import { StateField } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import moment from 'moment';
import { call } from '../core/api.js';
import { Events, EventRef } from '../core/events.js';
import { addIcon, getIcon, getIconIds, removeIcon, setIcon } from '../core/icons.js';
import { getLanguage } from '../core/i18n.js';
import { arrayBufferToBase64, arrayBufferToHex, base64ToArrayBuffer, debounce, hexToArrayBuffer } from '../core/util.js';
import { Editor } from '../editor/editor.js';
import { editorInfoField, editorLivePreviewField } from '../editor/livepreview.js';
import { Commands } from '../model/commands.js';
import { Component } from '../model/component.js';
import { FileManager, getFrontMatterInfo, parseYaml, stringifyYaml } from '../model/filemanager.js';
import { Keymap, Scope } from '../model/keymap.js';
import {
  MetadataCache, getAllTags, getLinkpath, parseFrontMatterAliases, parseFrontMatterEntry, parseFrontMatterStringArray,
  parseFrontMatterTags, parseLinktext, resolveSubpath, stripHeading,
} from '../model/metadata.js';
import { DataAdapter, TAbstractFile, TFile, TFolder, Vault, normalizePath } from '../model/vault.js';
import { MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownRenderer, htmlToMarkdown, sanitizeHTMLToDom } from '../render/markdown.js';
import {
  AbstractInputSuggest, BaseComponent, ButtonComponent, ColorComponent, DropdownComponent, ExtraButtonComponent, FuzzySuggestModal,
  Menu, MenuItem, Modal, MomentFormatComponent, Notice, PopoverSuggest, ProgressBarComponent, SearchComponent, Setting, SettingGroup,
  SliderComponent, SuggestModal, TextAreaComponent, TextComponent, ToggleComponent, ValueComponent, fuzzySearch, prepareFuzzySearch,
  prepareSimpleSearch, renderMatches, renderResults, setTooltip, sortSearchResults,
} from '../ui/kit.js';
import { PluginSettingTab, SettingTab } from '../ui/settings.js';
import {
  Workspace, WorkspaceItem, WorkspaceLeaf, WorkspaceParent, WorkspaceRibbon, WorkspaceRoot, WorkspaceSidedock, WorkspaceSplit, WorkspaceTabs,
} from '../ui/workspace.js';
import { EditableFileView, EmptyView, FileView, ItemView, TextFileView, View } from '../views/base.js';
import { MarkdownView } from '../views/markdown.js';
import { App } from '../app/app.js';
import { Plugin } from './plugin.js';
import { toB64, fromB64 } from './node.js';

export const apiVersion = '1.8.0';

export const Platform = {
  isDesktop: true, isMobile: false, isDesktopApp: true, isMobileApp: false, isIosApp: false, isAndroidApp: false,
  isPhone: false, isTablet: false, isMacOS: false, isWin: false, isLinux: true, isSafari: false, resourcePathPrefix: 'skn://vault/',
};

export function requireApiVersion() { return true; }

/** HTTP request through Python (network permission for remote hosts), attributed
 *  to the plugin that makes it. */
export function makeRequestUrl(pluginId) {
  return (req) => doRequest(pluginId, req);
}

export const requestUrl = makeRequestUrl(null);

function doRequest(pluginId, req) {
  if (typeof req === 'string') req = { url: req };
  const run = (async () => {
    let body = req.body;
    if (body !== undefined && body !== null) body = toB64(body instanceof ArrayBuffer || ArrayBuffer.isView(body) ? body : String(body));
    const r = await call('shim.request', { url: req.url, method: req.method || 'GET', headers: req.headers || {}, contentType: req.contentType, body }, pluginId);
    const bytes = fromB64(r.b64);
    const text = new TextDecoder().decode(bytes);
    let json;
    const res = {
      status: r.status, headers: r.headers, arrayBuffer: bytes.buffer, text,
      get json() { if (json === undefined) json = JSON.parse(text); return json; },
    };
    if (req.throw !== false && r.status >= 400) {
      const err = new Error(`Request failed, status ${r.status}`);
      err.status = r.status;
      err.headers = r.headers;
      throw err;
    }
    return res;
  })();
  const p = run;
  p.arrayBuffer = run.then((r) => r.arrayBuffer);
  p.json = run.then((r) => r.json);
  p.text = run.then((r) => r.text);
  p.arrayBuffer.catch?.(() => {});
  p.json.catch?.(() => {});
  p.text.catch?.(() => {});
  return p;
}

export function makeRequest(pluginId) {
  return async (req) => (await doRequest(pluginId, typeof req === 'string' ? { url: req } : req)).text;
}

export const request = makeRequest(null);

/** Floating editor suggestion lists (plugins subclass this). */
export class EditorSuggest extends PopoverSuggest {
  constructor(app) {
    super(app);
    this.limit = 100;
    this.context = null;
    this.instructionsEl = null;
  }
  setInstructions(list) { this._instructions = list; }
  onTrigger() { return null; }
  getSuggestions() { return []; }
  close() { super.close?.(); }
}

export class HoverPopover extends Component {
  constructor(parent, targetEl, waitTime) {
    super();
    this.parent = parent;
    this.targetEl = targetEl;
    this.hoverEl = document.body.createDiv('popover hover-popover');
    this.state = 0;
    void waitTime;
    const r = targetEl?.getBoundingClientRect?.();
    if (r) Object.assign(this.hoverEl.style, { left: r.left + 'px', top: r.bottom + 6 + 'px' });
    this.load();
  }
  hide() { this.hoverEl.detach(); this.unload(); }
}

export class MarkdownPreviewRenderer {
  static registerPostProcessor(fn, sortOrder) { window.app?.markdownProcessors.add(fn, sortOrder); }
  static unregisterPostProcessor(fn) { window.app?.markdownProcessors.remove(fn); }
  static createCodeBlockPostProcessor(lang, handler) {
    return (el, ctx) => {
      for (const pre of el.findAll(`pre[data-lang="${lang}"]`)) {
        const box = createDiv();
        pre.replaceWith(box);
        handler(pre.textContent, box, ctx);
      }
    };
  }
}

export class MarkdownPreviewView extends MarkdownRenderer {}
export class MarkdownEditView {}
export class MarkdownSourceView {}
export class FileSystemAdapter extends DataAdapter {}
Object.setPrototypeOf(FileSystemAdapter, DataAdapter);

/** Gives the EditorView from an editor state (some plugins need it). */
export const editorEditorField = StateField.define({ create: () => null, update: (v) => v });
export const editorViewField = editorInfoField;

export function stripHeadingForLink(h) { return stripHeading(h).replace(/[#|^:%[\]]/g, ' ').replace(/\s+/g, ' ').trim(); }

let katexP = null;
export async function loadMathJax() { katexP ||= import('katex'); await katexP; }
export function renderMath(source, display) {
  const el = createEl(display ? 'div' : 'span', { cls: 'math' });
  (katexP ||= import('katex')).then(({ default: k }) => { try { k.render(source, el, { displayMode: display, throwOnError: false }); } catch { el.setText(source); } });
  return el;
}
export async function finishRenderMath() {}
export async function loadMermaid() { throw new Error('Mermaid diagrams are not bundled in sk_notes yet'); }
export async function loadPdfJs() { throw new Error('PDF.js is not available'); }
export async function loadPrism() { return { highlightElement() {}, languages: {} }; }

export function getBlobArrayBuffer(blob) { return blob.arrayBuffer(); }
export function iterateCacheRefs(cache, cb) {
  for (const r of [...(cache?.links || []), ...(cache?.embeds || []), ...(cache?.frontmatterLinks || [])]) if (cb(r)) return true;
  return false;
}
export function iterateRefs(refs, cb) { for (const r of refs || []) if (cb(r)) return true; return false; }

export const ViewState = {};

// ------------------------------------------------------------------- newer public classes
export class ConfirmationButton extends ButtonComponent {
  setInitialFocus() { setTimeout(() => this.buttonEl.focus(), 0); return this; }
  setSecondary() { this.buttonEl.removeClass('mod-cta'); return this; }
  setCancel() { this.buttonEl.addClass('mod-cancel'); return this; }
}

export class ConfirmationModal extends Modal {
  constructor(app) {
    super(app);
    this.buttonContainerEl = this.modalEl.createDiv('modal-button-container');
  }
  addClass(cls) { this.modalEl.addClass(cls); return this; }
  addCheckbox(label, cb) {
    const row = this.contentEl.createEl('label', { cls: 'mod-checkbox' });
    const box = row.createEl('input', { type: 'checkbox' });
    row.appendText(' ' + label);
    box.addEventListener('change', () => cb(box.checked));
    return this;
  }
  addButton(cb) {
    const b = new ConfirmationButton(this.buttonContainerEl);
    b.buttonEl.addEventListener('click', () => this.close());
    cb(b);
    return this;
  }
  addCancelButton(text) {
    return this.addButton((b) => b.setButtonText(text || 'Cancel').setCancel().onClick(() => {}));
  }
}

export class SettingPage {
  constructor() {
    this.rootEl = createDiv('setting-page');
    this.titlebarEl = this.rootEl.createDiv('setting-page-titlebar');
    this.containerEl = this.rootEl.createDiv('setting-page-content');
    this.title = '';
  }
  display() {}
  hide() {}
}

export class AbstractTextComponent extends TextComponent {}
export class DisplayValueComponent extends BaseComponent {}
export class SecretComponent extends BaseComponent {
  constructor(app, containerEl) {
    super();
    this.inputEl = containerEl.createEl('input', { type: 'password' });
    this.inputEl.addEventListener('change', () => this._cb?.(this.inputEl.value || null));
  }
  setValue(v) { this.inputEl.value = v ?? ''; return this; }
  onChange(cb) { this._cb = cb; return this; }
}
export class MenuSeparator {}
export class Tasks {
  constructor() { this.list = []; }
  add(cb) { this.list.push(Promise.resolve().then(cb)); }
  addPromise(p) { this.list.push(p); }
  isEmpty() { return !this.list.length; }
  promise() { return Promise.all(this.list); }
}
export function displayTooltip(el, content) { setTooltip(el, typeof content === 'string' ? content : content?.textContent || ''); }
export const livePreviewState = editorLivePreviewField;
export function parsePropertyId(id) {
  const m = /^(note|file|formula)\.(.*)$/.exec(id);
  return m ? { type: m[1], name: m[2] } : { type: 'note', name: id };
}
export class BasesView extends Component {}
export class QueryController extends Component {}
export class WorkspaceContainer extends WorkspaceSplit {}
export class WorkspaceWindow extends WorkspaceContainer {}
export class WorkspaceFloating extends WorkspaceParent {}
export class WorkspaceMobileDrawer extends WorkspaceParent {}
export class TExternalFile {}
export class SecretStorage {}
export class Value {}
export class NullValue extends Value {}
export class NotNullValue extends Value {}
export class PrimitiveValue extends NotNullValue {}
export class StringValue extends PrimitiveValue {}
export class NumberValue extends PrimitiveValue {}
export class BooleanValue extends PrimitiveValue {}
export class DateValue extends NotNullValue {}
export class ListValue extends NotNullValue {}
export class ObjectValue extends NotNullValue {}
export class LinkValue extends NotNullValue {}
export class FileValue extends NotNullValue {}
export class TagValue extends StringValue {}
export class UrlValue extends StringValue {}
export class HTMLValue extends NotNullValue {}
export class IconValue extends NotNullValue {}
export class ImageValue extends NotNullValue {}
export class RegExpValue extends NotNullValue {}
export class DurationValue extends NotNullValue {}
export class RelativeDateValue extends DateValue {}
export const PopoverState = { Showing: 0, Shown: 1, Hiding: 2, Hidden: 3 };

export {
  App, Commands, Component, Events, EventRef, Vault, TAbstractFile, TFile, TFolder, DataAdapter, MetadataCache, FileManager,
  Workspace, WorkspaceItem, WorkspaceLeaf, WorkspaceParent, WorkspaceRibbon, WorkspaceRoot, WorkspaceSidedock, WorkspaceSplit,
  WorkspaceTabs, View, ItemView, FileView, EditableFileView, TextFileView, EmptyView, MarkdownView, Editor, Plugin,
  PluginSettingTab, SettingTab, Setting, SettingGroup, Notice, Modal, Menu, MenuItem, Scope, Keymap, SuggestModal, FuzzySuggestModal,
  PopoverSuggest, AbstractInputSuggest, BaseComponent, ValueComponent, ButtonComponent, ExtraButtonComponent, ToggleComponent,
  TextComponent, TextAreaComponent, SearchComponent, MomentFormatComponent, DropdownComponent, SliderComponent, ColorComponent,
  ProgressBarComponent, MarkdownRenderer, MarkdownRenderChild, MarkdownPostProcessorContext, moment, setIcon, addIcon, getIcon,
  getIconIds, removeIcon, setTooltip, normalizePath, debounce, parseYaml, stringifyYaml, getAllTags, getLinkpath, parseLinktext,
  parseFrontMatterAliases, parseFrontMatterEntry, parseFrontMatterStringArray, parseFrontMatterTags, resolveSubpath, stripHeading,
  prepareFuzzySearch, prepareSimpleSearch, fuzzySearch, renderMatches, renderResults, sortSearchResults, htmlToMarkdown,
  sanitizeHTMLToDom, arrayBufferToBase64, base64ToArrayBuffer, arrayBufferToHex, hexToArrayBuffer, editorInfoField,
  editorLivePreviewField, getLanguage, getFrontMatterInfo, EditorView,
};

// Component: lifecycle owner for event registrations, intervals and children.

export class Component {
  constructor() {
    this._loaded = false;
    this._events = [];
    this._children = [];
  }

  load() {
    if (this._loaded) return;
    this._loaded = true;
    try { this.onload(); } catch (e) { console.error('Component.onload failed', e); }
    for (const c of this._children.slice()) c.load();
  }

  onload() {}

  unload() {
    if (!this._loaded) return;
    this._loaded = false;
    while (this._children.length) this._children.pop().unload();
    while (this._events.length) {
      try { this._events.pop()(); } catch (e) { console.error(e); }
    }
    try { this.onunload(); } catch (e) { console.error('Component.onunload failed', e); }
  }

  onunload() {}

  addChild(component) {
    this._children.push(component);
    if (this._loaded) component.load();
    return component;
  }

  removeChild(component) {
    const i = this._children.indexOf(component);
    if (i !== -1) {
      this._children.splice(i, 1);
      component.unload();
    }
    return component;
  }

  register(cb) {
    this._events.push(cb);
  }

  registerEvent(ref) {
    this.register(() => ref.e.offref(ref));
  }

  registerDomEvent(el, type, callback, options) {
    el.addEventListener(type, callback, options);
    this.register(() => el.removeEventListener(type, callback, options));
  }

  registerScopeEvent(handler) {
    this.register(() => handler.scope?.unregister(handler));
  }

  registerInterval(id) {
    this.register(() => window.clearInterval(id));
    return id;
  }
}

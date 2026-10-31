// Event emitter with EventRef objects (same contract plugins rely on: on/off/offref/trigger).

export class EventRef {
  constructor(events, name, callback, ctx) {
    this.e = events;
    this.name = name;
    this.fn = callback;
    this.ctx = ctx;
  }
}

export class Events {
  constructor() {
    this._ev = Object.create(null);
  }

  on(name, callback, ctx) {
    const ref = new EventRef(this, name, callback, ctx);
    (this._ev[name] ||= []).push(ref);
    return ref;
  }

  off(name, callback) {
    const list = this._ev[name];
    if (!list) return;
    this._ev[name] = list.filter((r) => r.fn !== callback);
  }

  offref(ref) {
    if (!ref || !ref.e) return;
    const list = ref.e._ev[ref.name];
    if (list) ref.e._ev[ref.name] = list.filter((r) => r !== ref);
  }

  trigger(name, ...args) {
    const list = this._ev[name];
    if (!list) return;
    for (const ref of list.slice()) this.tryTrigger(ref, args);
  }

  tryTrigger(ref, args) {
    try {
      ref.fn.apply(ref.ctx, args);
    } catch (e) {
      console.error(`event "${ref.name}" handler failed`, e);
    }
  }
}

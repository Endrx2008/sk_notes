// Test bench only: `SkNative` as Bridge.java exposes it, answered by server.mjs.
(() => {
  const KEY = 'bench-key';
  let booted = false;
  const store = new Map();
  let eventId = 1e9;
  const send = (method, json) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/native?m=' + encodeURIComponent(method), false);
    x.send(json || '{}');
    return x.responseText;
  };
  window.SkNative = {
    boot() { if (booted) return ''; booted = true; return KEY; },
    call(key, method, json) {
      if (key !== KEY) return '{"ok":false,"error":"permission-denied"}';
      if (method === 'app.reload') { setTimeout(() => location.reload(), 30); return '{"ok":true,"result":true}'; }
      return send(method, json);
    },
    callAsync(key, id, method, json) {
      if (key !== KEY) return;
      fetch('/native?m=' + encodeURIComponent(method) + '&async=' + id, { method: 'POST', body: json || '{}' });
    },
    take(key, id) { const v = store.get(id); store.delete(id); return key === KEY ? v : ''; },
  };
  const es = new EventSource('/native-events');
  es.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.type === 'result') { store.set(d.id, d.body); window.__sknNative?.r(d.id); return; }
    const id = eventId++;
    store.set(id, JSON.stringify(d.payload ?? null));
    window.__sknNative?.e(d.name, id);
  };
})();

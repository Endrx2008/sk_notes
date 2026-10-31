// Expression language of .base files (filters, formulas, summaries).
// Own implementation: tokenizer → Pratt parser → tree-walking evaluator. No eval().

const PRECEDENCE = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

export class ExprError extends Error {}

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      const m = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(src.slice(i));
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { s += { n: '\n', t: '\t' }[src[j + 1]] ?? src[j + 1]; j += 2; } else s += src[j++];
      }
      if (j >= src.length) throw new ExprError('unterminated string');
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (c === '/' && (!out.length || ['op', 'punc'].includes(out[out.length - 1].t) && out[out.length - 1].v !== ')' && out[out.length - 1].v !== ']')) {
      const m = /^\/((?:\\.|[^/\\\n])+)\/([gimsuy]*)/.exec(src.slice(i));
      if (m) { out.push({ t: 'regex', v: m[1], flags: m[2] }); i += m[0].length; continue; }
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%<>!'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if ('()[],.'.includes(c)) { out.push({ t: 'punc', v: c }); i++; continue; }
    const m = /^[\p{L}_$][\p{L}\p{N}_$-]*/u.exec(src.slice(i));
    if (m) {
      let id = m[0];
      // a trailing '-' belongs to the minus operator, not to the identifier
      while (id.endsWith('-')) id = id.slice(0, -1);
      out.push({ t: 'id', v: id });
      i += id.length;
      continue;
    }
    throw new ExprError(`unexpected "${c}"`);
  }
  return out;
}

export function parse(src) {
  const toks = tokenize(String(src));
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (v) => { const tk = next(); if (!tk || tk.v !== v) throw new ExprError(`expected "${v}"`); };
  const primary = () => {
    const tk = next();
    if (!tk) throw new ExprError('unexpected end');
    let node;
    if (tk.t === 'num') node = { k: 'lit', v: tk.v };
    else if (tk.t === 'str') node = { k: 'lit', v: tk.v };
    else if (tk.t === 'regex') node = { k: 'regex', v: tk.v, flags: tk.flags };
    else if (tk.t === 'op' && (tk.v === '!' || tk.v === '-')) node = { k: 'unary', op: tk.v, a: unaryOperand() };
    else if (tk.v === '(') { node = expr(0); expect(')'); }
    else if (tk.v === '[') {
      const items = [];
      if (peek()?.v !== ']') { do { items.push(expr(0)); } while (peek()?.v === ',' && next()); }
      expect(']');
      node = { k: 'list', items };
    } else if (tk.t === 'id') {
      if (tk.v === 'true' || tk.v === 'false') node = { k: 'lit', v: tk.v === 'true' };
      else if (tk.v === 'null') node = { k: 'lit', v: null };
      else node = { k: 'id', v: tk.v };
    } else throw new ExprError(`unexpected "${tk.v}"`);
    return postfix(node);
  };
  const unaryOperand = () => primary();
  const postfix = (node) => {
    for (;;) {
      const tk = peek();
      if (tk?.v === '.') {
        next();
        const name = next();
        if (!name || name.t !== 'id') throw new ExprError('expected a name after "."');
        node = { k: 'member', obj: node, name: name.v };
      } else if (tk?.v === '(') {
        next();
        const args = [];
        if (peek()?.v !== ')') { do { args.push(expr(0)); } while (peek()?.v === ',' && next()); }
        expect(')');
        node = { k: 'call', fn: node, args };
      } else if (tk?.v === '[') {
        next();
        const idx = expr(0);
        expect(']');
        node = { k: 'index', obj: node, idx };
      } else return node;
    }
  };
  const expr = (minPrec) => {
    let left = primary();
    for (;;) {
      const tk = peek();
      if (!tk || tk.t !== 'op' || PRECEDENCE[tk.v] === undefined || PRECEDENCE[tk.v] < minPrec) return left;
      next();
      const right = expr(PRECEDENCE[tk.v] + 1);
      left = { k: 'bin', op: tk.v, a: left, b: right };
    }
  };
  const node = expr(0);
  if (p < toks.length) throw new ExprError(`unexpected "${toks[p].v}"`);
  return node;
}

// ------------------------------------------------------------------- values
export class Link {
  constructor(path, display) { this.path = path; this.display = display; }
  toString() { return this.display || this.path.replace(/\.md$/, '').split('/').pop(); }
}

export class BDate {
  constructor(d, hasTime = true) { this.d = d; this.hasTime = hasTime; }
  toString() { return this.hasTime ? window.moment(this.d).format('YYYY-MM-DD HH:mm') : window.moment(this.d).format('YYYY-MM-DD'); }
  valueOf() { return this.d.getTime(); }
}

export function toDate(v) {
  if (v instanceof BDate) return v;
  if (v instanceof Date) return new BDate(v);
  if (typeof v === 'number') return new BDate(new Date(v));
  if (typeof v === 'string' && v) {
    const m = window.moment(v, [window.moment.ISO_8601, 'YYYY-MM-DD', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DDTHH:mm:ss'], true);
    if (m.isValid()) return new BDate(m.toDate(), /[T ]\d/.test(v));
  }
  return null;
}

export function isEmpty(v) {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !(v instanceof BDate) && !(v instanceof Link) && !Array.isArray(v) && Object.keys(v).length === 0);
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return !!v && !(typeof v === 'number' && Number.isNaN(v));
}

function cmp(a, b) {
  if (a instanceof BDate || b instanceof BDate) { a = toDate(a)?.valueOf() ?? a; b = toDate(b)?.valueOf() ?? b; }
  if (a instanceof Link) a = a.toString();
  if (b instanceof Link) b = b.toString();
  if (typeof a === 'number' && typeof b === 'string' && b !== '' && !Number.isNaN(Number(b))) b = Number(b);
  if (typeof b === 'number' && typeof a === 'string' && a !== '' && !Number.isNaN(Number(a))) a = Number(a);
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

function eq(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  if (a instanceof Link && b instanceof Link) return a.path === b.path;
  if (a instanceof Link) return a.path === b || a.toString() === b;
  if (b instanceof Link) return eq(b, a);
  const nullA = a === null || a === undefined;
  const nullB = b === null || b === undefined;
  if (nullA || nullB) return nullA && nullB;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  return cmp(a, b) === 0;
}

const DURATION_RE = /^\s*(-?\d+(?:\.\d+)?)\s*(y|year|years|M|month|months|w|week|weeks|d|day|days|h|hour|hours|m|minute|minutes|s|second|seconds)\s*$/;

function addDuration(d, str, sign) {
  const m = DURATION_RE.exec(String(str));
  if (!m) return d;
  const unit = { y: 'years', year: 'years', years: 'years', M: 'months', month: 'months', months: 'months', w: 'weeks', week: 'weeks', weeks: 'weeks',
    d: 'days', day: 'days', days: 'days', h: 'hours', hour: 'hours', hours: 'hours', m: 'minutes', minute: 'minutes', minutes: 'minutes',
    s: 'seconds', second: 'seconds', seconds: 'seconds' }[m[2]];
  return new BDate(window.moment(d.d).add(sign * Number(m[1]), unit).toDate(), d.hasTime || ['hours', 'minutes', 'seconds'].includes(unit));
}

function arith(op, a, b) {
  if (a instanceof BDate && typeof b === 'string' && (op === '+' || op === '-')) return addDuration(a, b, op === '+' ? 1 : -1);
  if (a instanceof BDate && b instanceof BDate && op === '-') return a.valueOf() - b.valueOf();
  if (op === '+' && (typeof a === 'string' || typeof b === 'string')) return `${str(a)}${str(b)}`;
  const x = Number(a instanceof BDate ? a.valueOf() : a);
  const y = Number(b instanceof BDate ? b.valueOf() : b);
  switch (op) {
    case '+': return x + y;
    case '-': return x - y;
    case '*': return x * y;
    case '/': return y === 0 ? null : x / y;
    case '%': return y === 0 ? null : x % y;
    default: return null;
  }
}

export function str(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(str).join(', ');
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  if (typeof v === 'object' && !(v instanceof BDate) && !(v instanceof Link)) return JSON.stringify(v);
  return String(v);
}

// ------------------------------------------------------------------- evaluation
export class Context {
  /** row: {file (TFile), cache, props}; env: {app, formulas: {name: ast}, thisFile} */
  constructor(env, row) { this.env = env; this.row = row; this.formulaCache = new Map(); this.depth = 0; }
}

export function evaluate(node, ctx) {
  switch (node.k) {
    case 'lit': return node.v;
    case 'regex': return new RegExp(node.v, node.flags);
    case 'list': return node.items.map((n) => evaluate(n, ctx));
    case 'unary': {
      const v = evaluate(node.a, ctx);
      return node.op === '!' ? !truthy(v) : -Number(v);
    }
    case 'bin': {
      if (node.op === '&&') return truthy(evaluate(node.a, ctx)) && truthy(evaluate(node.b, ctx));
      if (node.op === '||') { const a = evaluate(node.a, ctx); return truthy(a) ? a : evaluate(node.b, ctx); }
      const a = evaluate(node.a, ctx);
      const b = evaluate(node.b, ctx);
      switch (node.op) {
        case '==': return eq(a, b);
        case '!=': return !eq(a, b);
        case '<': return cmp(a, b) < 0;
        case '<=': return cmp(a, b) <= 0;
        case '>': return cmp(a, b) > 0;
        case '>=': return cmp(a, b) >= 0;
        default: return arith(node.op, a, b);
      }
    }
    case 'id': return resolveId(node.v, ctx);
    case 'member': {
      if (node.obj.k === 'id') {
        const ns = node.obj.v;
        if (ns === 'note') return noteProp(ctx, node.name);
        if (ns === 'file') return fileProp(ctx, ctx.row, node.name);
        if (ns === 'formula') return formula(ctx, node.name);
        if (ns === 'this') return thisProp(ctx, node.name);
      }
      const obj = evaluate(node.obj, ctx);
      return field(obj, node.name, ctx);
    }
    case 'index': {
      const obj = evaluate(node.obj, ctx);
      const idx = evaluate(node.idx, ctx);
      if (node.obj.k === 'id' && node.obj.v === 'note') return noteProp(ctx, String(idx));
      if (Array.isArray(obj)) return obj[idx < 0 ? obj.length + idx : idx] ?? null;
      if (obj && typeof obj === 'object') return obj[idx] ?? null;
      if (typeof obj === 'string') return obj[idx] ?? null;
      return null;
    }
    case 'call': {
      if (node.fn.k === 'id') return callGlobal(node.fn.v, node.args, ctx);
      if (node.fn.k === 'member') {
        const ns = node.fn.obj.k === 'id' ? node.fn.obj.v : null;
        const target = ns === 'file' ? { __file: ctx.row.file } : ns === 'this' ? { __file: ctx.env.thisFile } : evaluate(node.fn.obj, ctx);
        return callMethod(target, node.fn.name, node.args, ctx);
      }
      throw new ExprError('not callable');
    }
    default: throw new ExprError('bad node');
  }
}

function resolveId(name, ctx) {
  if (name === 'file') return { __file: ctx.row.file };
  if (name === 'note') return ctx.row.props;
  if (name === 'values' && ctx.values) return ctx.values;
  if (ctx.locals && name in ctx.locals) return ctx.locals[name];
  return noteProp(ctx, name);
}

function noteProp(ctx, name) {
  const props = ctx.row.props || {};
  let v = props[name];
  if (v === undefined) {
    const key = Object.keys(props).find((k) => k.toLowerCase() === name.toLowerCase());
    v = key ? props[key] : null;
  }
  return normalizeValue(v);
}

export function normalizeValue(v) {
  if (typeof v === 'string') {
    const m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(v);
    if (m) return new Link(m[1], m[2]);
    if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(v)) return toDate(v) || v;
  }
  if (Array.isArray(v)) return v.map(normalizeValue);
  return v ?? null;
}

function thisProp(ctx, name) {
  const f = ctx.env.thisFile;
  if (!f) return null;
  const row = { file: f, cache: ctx.env.app.metadataCache.getFileCache(f), props: ctx.env.app.metadataCache.getFileCache(f)?.frontmatter || {} };
  if (name === 'file') return { __file: f };
  return fileProp(ctx, row, name) ?? normalizeValue(row.props[name]);
}

function formula(ctx, name) {
  if (ctx.formulaCache.has(name)) return ctx.formulaCache.get(name);
  const ast = ctx.env.formulas?.[name];
  if (!ast) return null;
  if (ctx.depth > 20) throw new ExprError('formula recursion');
  ctx.depth++;
  let v;
  try { v = ast instanceof Error ? null : evaluate(ast, ctx); } finally { ctx.depth--; }
  ctx.formulaCache.set(name, v);
  return v;
}

function fileProp(ctx, row, name) {
  const f = row.file;
  if (!f) return null;
  const app = ctx.env.app;
  const cache = row.cache || {};
  switch (name) {
    case 'name': return f.name;
    case 'basename': return f.basename;
    case 'path': return f.path;
    case 'folder': return f.parent && f.parent.path !== '/' ? f.parent.path : '';
    case 'ext': return f.extension;
    case 'size': return f.stat.size;
    case 'ctime': return new BDate(new Date(f.stat.ctime));
    case 'mtime': return new BDate(new Date(f.stat.mtime));
    case 'tags': return [...new Set(app.allTagsOf(cache))];
    case 'links': return (cache.links || []).map((l) => new Link(app.metadataCache.getFirstLinkpathDest(l.link.split('#')[0], f.path)?.path || l.link, l.displayText));
    case 'embeds': return (cache.embeds || []).map((l) => new Link(l.link));
    case 'backlinks': {
      const out = [];
      for (const src in app.metadataCache.resolvedLinks) if (app.metadataCache.resolvedLinks[src][f.path]) out.push(new Link(src));
      return out;
    }
    case 'properties': return { ...(row.props || {}) };
    case 'file': return { __file: f };
    default: return null;
  }
}

function field(obj, name, ctx) {
  if (obj && obj.__file) return fileProp(ctx, { file: obj.__file, cache: ctx.env.app.metadataCache.getFileCache(obj.__file), props: ctx.env.app.metadataCache.getFileCache(obj.__file)?.frontmatter || {} }, name);
  if (obj instanceof BDate) {
    const m = window.moment(obj.d);
    return { year: m.year(), month: m.month() + 1, day: m.date(), hour: m.hour(), minute: m.minute(), second: m.second(), millisecond: m.millisecond() }[name] ?? null;
  }
  if (typeof obj === 'string' && name === 'length') return obj.length;
  if (Array.isArray(obj) && name === 'length') return obj.length;
  if (obj instanceof Link) return name === 'path' ? obj.path : null;
  if (obj && typeof obj === 'object') return normalizeValue(obj[name]);
  return null;
}

function args(nodes, ctx) { return nodes.map((n) => evaluate(n, ctx)); }

function callGlobal(name, argNodes, ctx) {
  if (name === 'if') {
    const [c, a, b] = argNodes;
    return truthy(evaluate(c, ctx)) ? (a ? evaluate(a, ctx) : null) : (b ? evaluate(b, ctx) : null);
  }
  const a = args(argNodes, ctx);
  switch (name) {
    case 'date': return toDate(a[0]);
    case 'now': return new BDate(new Date());
    case 'today': { const d = new Date(); d.setHours(0, 0, 0, 0); return new BDate(d, false); }
    case 'duration': return String(a[0]);
    case 'number': {
      const v = a[0];
      if (v instanceof BDate) return v.valueOf();
      if (typeof v === 'boolean') return v ? 1 : 0;
      const n = Number(v);
      return Number.isNaN(n) ? null : n;
    }
    case 'list': return Array.isArray(a[0]) ? a[0] : a[0] === null || a[0] === undefined ? [] : [a[0]];
    case 'max': return a.flat().filter((x) => x !== null).reduce((m, x) => (m === null || cmp(x, m) > 0 ? x : m), null);
    case 'min': return a.flat().filter((x) => x !== null).reduce((m, x) => (m === null || cmp(x, m) < 0 ? x : m), null);
    case 'link': return new Link(a[0] instanceof Link ? a[0].path : String(a[0] ?? ''), a[1] ? String(a[1]) : undefined);
    case 'file': {
      const f = ctx.env.app.metadataCache.getFirstLinkpathDest(a[0] instanceof Link ? a[0].path : String(a[0] ?? ''), ctx.row.file?.path || '');
      return f ? { __file: f } : null;
    }
    case 'escapeHTML': return String(a[0] ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    case 'html': case 'image': case 'icon': return { __render: name, v: a[0] };
    case 'random': return Math.random();
    default: throw new ExprError(`unknown function ${name}()`);
  }
}

function callMethod(target, name, argNodes, ctx) {
  // lambda-style list methods: filter(value > 1), map(value * 2), reduce(acc + value, 0)
  if (Array.isArray(target) && ['filter', 'map', 'reduce'].includes(name)) {
    const body = argNodes[0];
    const run = (locals) => { const saved = ctx.locals; ctx.locals = { ...(saved || {}), ...locals }; try { return evaluate(body, ctx); } finally { ctx.locals = saved; } };
    if (name === 'filter') return target.filter((value, index) => truthy(run({ value, index })));
    if (name === 'map') return target.map((value, index) => run({ value, index }));
    let acc = argNodes[1] ? evaluate(argNodes[1], ctx) : null;
    target.forEach((value, index) => { acc = run({ value, index, acc }); });
    return acc;
  }
  const a = args(argNodes, ctx);
  if (target && target.__file) {
    const f = target.__file;
    const app = ctx.env.app;
    const cache = app.metadataCache.getFileCache(f) || {};
    switch (name) {
      case 'hasTag': {
        const tags = app.allTagsOf(cache).map((x) => x.slice(1).toLowerCase());
        return a.some((want) => { const w = String(want).replace(/^#/, '').toLowerCase(); return tags.some((tg) => tg === w || tg.startsWith(w + '/')); });
      }
      case 'inFolder': {
        const folder = String(a[0] ?? '').replace(/^\/|\/$/g, '');
        return !folder || f.path.startsWith(folder + '/');
      }
      case 'hasLink': {
        const target2 = a[0] instanceof Link ? a[0].path : a[0]?.__file ? a[0].__file.path : String(a[0] ?? '');
        const dest = app.metadataCache.getFirstLinkpathDest(target2.replace(/\.md$/, ''), f.path);
        return !!dest && !!app.metadataCache.resolvedLinks[f.path]?.[dest.path];
      }
      case 'hasProperty': return Object.prototype.hasOwnProperty.call(cache.frontmatter || {}, String(a[0]));
      case 'asLink': return new Link(f.path, a[0] ? String(a[0]) : undefined);
      default: throw new ExprError(`unknown file method ${name}()`);
    }
  }
  if (target instanceof Link) {
    if (name === 'asFile') { const f = ctx.env.app.metadataCache.getFirstLinkpathDest(target.path, ctx.row.file?.path || ''); return f ? { __file: f } : null; }
    if (name === 'linksTo') { const f = ctx.env.app.metadataCache.getFirstLinkpathDest(target.path, ctx.row.file?.path || ''); return !!f && !!ctx.env.app.metadataCache.resolvedLinks[f.path]?.[String(a[0] instanceof Link ? a[0].path : a[0])]; }
    target = target.toString();
  }
  if (target instanceof BDate) {
    switch (name) {
      case 'format': return window.moment(target.d).format(String(a[0] ?? 'YYYY-MM-DD'));
      case 'date': { const d = new Date(target.d); d.setHours(0, 0, 0, 0); return new BDate(d, false); }
      case 'time': return window.moment(target.d).format('HH:mm:ss');
      case 'relative': return window.moment(target.d).fromNow();
      case 'isEmpty': return false;
      case 'toString': return target.toString();
      default: throw new ExprError(`unknown date method ${name}()`);
    }
  }
  if (typeof target === 'string') {
    switch (name) {
      case 'contains': return target.includes(String(a[0]));
      case 'containsAll': return a.every((x) => target.includes(String(x)));
      case 'containsAny': return a.some((x) => target.includes(String(x)));
      case 'startsWith': return target.startsWith(String(a[0]));
      case 'endsWith': return target.endsWith(String(a[0]));
      case 'isEmpty': return target === '';
      case 'lower': return target.toLowerCase();
      case 'upper': return target.toUpperCase();
      case 'title': return target.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
      case 'trim': return target.trim();
      case 'replace': return a[0] instanceof RegExp ? target.replace(a[0], String(a[1] ?? '')) : target.split(String(a[0])).join(String(a[1] ?? ''));
      case 'repeat': return target.repeat(Math.max(0, Math.min(1000, Number(a[0]) || 0)));
      case 'reverse': return [...target].reverse().join('');
      case 'slice': return target.slice(a[0], a[1]);
      case 'split': return target.split(a[0] instanceof RegExp ? a[0] : String(a[0] ?? ''), a[1]);
      case 'toString': return target;
      case 'isTruthy': return truthy(target);
      case 'isType': return String(a[0]) === 'string';
      default: throw new ExprError(`unknown text method ${name}()`);
    }
  }
  if (typeof target === 'number') {
    switch (name) {
      case 'abs': return Math.abs(target);
      case 'ceil': return Math.ceil(target);
      case 'floor': return Math.floor(target);
      case 'round': { const d = Number(a[0]) || 0; const f = 10 ** d; return Math.round(target * f) / f; }
      case 'toFixed': return target.toFixed(Math.max(0, Math.min(20, Number(a[0]) || 0)));
      case 'isEmpty': return false;
      case 'toString': return str(target);
      case 'isTruthy': return truthy(target);
      case 'isType': return String(a[0]) === 'number';
      default: throw new ExprError(`unknown number method ${name}()`);
    }
  }
  if (Array.isArray(target)) {
    const strs = target.map((x) => (x instanceof Link ? x.path.replace(/\.md$/, '') : str(x)));
    const has = (x) => strs.includes(x instanceof Link ? x.path.replace(/\.md$/, '') : str(x)) || target.some((y) => eq(y, x));
    switch (name) {
      case 'contains': return has(a[0]);
      case 'containsAll': return a.every(has);
      case 'containsAny': return a.some(has);
      case 'isEmpty': return target.length === 0;
      case 'join': return target.map(str).join(a[0] === undefined ? ', ' : String(a[0]));
      case 'flat': return target.flat(Infinity);
      case 'reverse': return target.slice().reverse();
      case 'slice': return target.slice(a[0], a[1]);
      case 'sort': return target.slice().sort(cmp);
      case 'unique': { const seen = new Set(); return target.filter((x) => { const k = str(x); if (seen.has(k)) return false; seen.add(k); return true; }); }
      case 'mean': { const n = target.map(Number).filter((x) => !Number.isNaN(x)); return n.length ? n.reduce((s, x) => s + x, 0) / n.length : null; }
      case 'sum': return target.map(Number).filter((x) => !Number.isNaN(x)).reduce((s, x) => s + x, 0);
      case 'toString': return str(target);
      case 'isType': return String(a[0]) === 'list';
      default: throw new ExprError(`unknown list method ${name}()`);
    }
  }
  if (target instanceof RegExp) {
    if (name === 'matches') return target.test(str(a[0]));
    throw new ExprError(`unknown regex method ${name}()`);
  }
  if (target === null || target === undefined) {
    if (name === 'isEmpty') return true;
    if (name === 'isTruthy') return false;
    if (name === 'toString') return '';
    return null;
  }
  if (typeof target === 'boolean') {
    if (name === 'toString') return String(target);
    if (name === 'isTruthy') return target;
    if (name === 'isEmpty') return false;
    if (name === 'isType') return String(a[0]) === 'boolean';
  }
  if (typeof target === 'object') {
    if (name === 'isEmpty') return Object.keys(target).length === 0;
    if (name === 'keys') return Object.keys(target);
    if (name === 'values') return Object.values(target);
  }
  throw new ExprError(`unknown method ${name}()`);
}

// ------------------------------------------------------------------- filters & summaries
export function compileFilter(f) {
  if (f === null || f === undefined) return null;
  if (typeof f === 'string') return { k: 'expr', ast: parse(f) };
  if (typeof f === 'boolean') return { k: 'expr', ast: { k: 'lit', v: f } };
  if (f.and) return { k: 'and', items: f.and.map(compileFilter) };
  if (f.or) return { k: 'or', items: f.or.map(compileFilter) };
  if (f.not) return { k: 'not', items: (Array.isArray(f.not) ? f.not : [f.not]).map(compileFilter) };
  throw new ExprError('invalid filter');
}

export function testFilter(cf, ctx) {
  if (!cf) return true;
  if (cf.k === 'expr') return truthy(evaluate(cf.ast, ctx));
  if (cf.k === 'and') return cf.items.every((x) => testFilter(x, ctx));
  if (cf.k === 'or') return cf.items.some((x) => testFilter(x, ctx));
  if (cf.k === 'not') return !cf.items.some((x) => testFilter(x, ctx));
  return true;
}

export const SUMMARIES = {
  Average: (v) => { const n = v.map(Number).filter((x) => !Number.isNaN(x) && x !== null); return n.length ? n.reduce((s, x) => s + x, 0) / n.length : null; },
  Min: (v) => v.filter((x) => x !== null).reduce((m, x) => (m === null || cmp(x, m) < 0 ? x : m), null),
  Max: (v) => v.filter((x) => x !== null).reduce((m, x) => (m === null || cmp(x, m) > 0 ? x : m), null),
  Sum: (v) => v.map(Number).filter((x) => !Number.isNaN(x)).reduce((s, x) => s + x, 0),
  Range: (v) => { const a = SUMMARIES.Min(v); const b = SUMMARIES.Max(v); return a === null ? null : (b instanceof BDate ? window.moment(b.d).from(a.d, true) : b - a); },
  Median: (v) => { const n = v.map(Number).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b); if (!n.length) return null; const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; },
  Stddev: (v) => { const n = v.map(Number).filter((x) => !Number.isNaN(x)); if (!n.length) return null; const mean = n.reduce((s, x) => s + x, 0) / n.length; return Math.sqrt(n.reduce((s, x) => s + (x - mean) ** 2, 0) / n.length); },
  Earliest: (v) => SUMMARIES.Min(v.map(toDate).filter(Boolean)),
  Latest: (v) => SUMMARIES.Max(v.map(toDate).filter(Boolean)),
  Checked: (v) => v.filter((x) => x === true).length,
  Unchecked: (v) => v.filter((x) => x === false).length,
  Empty: (v) => v.filter(isEmpty).length,
  Filled: (v) => v.filter((x) => !isEmpty(x)).length,
  Unique: (v) => new Set(v.map(str)).size,
};

export { cmp, truthy };

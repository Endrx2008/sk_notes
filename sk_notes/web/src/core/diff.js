// Line diff (Myers' O(ND) algorithm) and a renderer used by version history and SKAI.

export function diffLines(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  // trim common prefix/suffix (fast path for small edits in big notes)
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA--; endB--; }
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'same', text: A[i] });
  ops.push(...myers(A.slice(start, endA), B.slice(start, endB)));
  for (let i = endA; i < A.length; i++) ops.push({ type: 'same', text: A[i] });
  return ops;
}

function myers(A, B) {
  const n = A.length;
  const m = B.length;
  if (!n) return B.map((text) => ({ type: 'add', text }));
  if (!m) return A.map((text) => ({ type: 'del', text }));
  const max = n + m;
  if (max > 20000) return [...A.map((text) => ({ type: 'del', text })), ...B.map((text) => ({ type: 'add', text }))];
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) x = v[k + 1 + max];
      else x = v[k - 1 + max] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[k + max] = x;
      if (x >= n && y >= m) return backtrack(trace, A, B, max);
    }
  }
  return [];
}

function backtrack(trace, A, B, max) {
  const ops = [];
  let x = A.length;
  let y = B.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[prevK + max];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ type: 'same', text: A[x - 1] }); x--; y--; }
    if (d > 0) {
      if (x === prevX) ops.push({ type: 'add', text: B[y - 1] });
      else ops.push({ type: 'del', text: A[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** Render ops into el; unchanged runs longer than 2*context are folded. */
export function renderDiff(el, ops, context = 3) {
  el.addClass('sk-diff');
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'same') {
      let j = i;
      while (j < ops.length && ops[j].type === 'same') j++;
      const run = ops.slice(i, j);
      const first = i === 0;
      const last = j === ops.length;
      const keepHead = first ? 0 : context;
      const keepTail = last ? 0 : context;
      if (run.length > keepHead + keepTail + 1) {
        for (const o of run.slice(0, keepHead)) line(el, o);
        el.createDiv({ cls: 'sk-diff-fold', text: `⋯ ${run.length - keepHead - keepTail}` });
        for (const o of run.slice(run.length - keepTail)) line(el, o);
      } else for (const o of run) line(el, o);
      i = j;
    } else {
      line(el, ops[i]);
      i++;
    }
  }
}

function line(el, o) {
  const row = el.createDiv(`sk-diff-line is-${o.type}`);
  row.createSpan({ cls: 'sk-diff-sign', text: o.type === 'add' ? '+' : o.type === 'del' ? '−' : ' ' });
  row.createSpan({ cls: 'sk-diff-text', text: o.text || ' ' });
}

export function diffStats(ops) {
  return { added: ops.filter((o) => o.type === 'add').length, removed: ops.filter((o) => o.type === 'del').length };
}

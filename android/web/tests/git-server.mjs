// A Git server for tests: `git http-backend` behind node:http, with a name and a password.
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';

/** Serve the bare repositories of `root` on a free port of this machine. */
function serve(root, { user = 'anna', password = 'secret-token' } = {}) {
  const requests = [];
  const expected = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  const server = http.createServer((req, res) => {
    const [pathInfo, query = ''] = req.url.split('?');
    if (pathInfo === '/__requests') { res.end(JSON.stringify(requests)); return; }
    requests.push({ method: req.method, url: req.url, agent: req.headers['user-agent'] || '', auth: req.headers.authorization || '' });
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
      res.end('sign in');
      return;
    }
    const env = {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method, PATH_INFO: decodeURIComponent(pathInfo),
      QUERY_STRING: query, CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: user, REMOTE_ADDR: '127.0.0.1',
      GIT_HTTP_MAX_REQUEST_BUFFER: '100M',
    };
    if (req.headers['content-length']) env.CONTENT_LENGTH = req.headers['content-length'];
    if (req.headers['git-protocol']) env.GIT_PROTOCOL = req.headers['git-protocol'];
    if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = req.headers['content-encoding'];
    const cgi = spawn('git', ['http-backend'], { env });
    req.pipe(cgi.stdin);
    const chunks = [];
    cgi.stdout.on('data', (c) => chunks.push(c));
    cgi.on('close', () => {
      const out = Buffer.concat(chunks);
      const split = out.indexOf('\r\n\r\n');
      const head = out.subarray(0, split).toString('latin1');
      const headers = {};
      let status = 200;
      for (const line of head.split('\r\n')) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = parseInt(v, 10); else headers[k] = v;
      }
      res.writeHead(status, headers);
      res.end(out.subarray(split + 4));
    });
  });
  server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
}

// run as a program: the server (its own process, so that tests may call Git and wait for it)
if (process.argv[1] && process.argv[1].endsWith('git-server.mjs')) serve(process.argv[2]);

/** Start the server. Returns {url, requests() → what was asked so far, close()}. */
export async function startGitServer(root) {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, root], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
    child.on('exit', () => reject(new Error('git server did not start')));
  });
  const url = `http://127.0.0.1:${port}`;
  return { url, requests: async () => (await fetch(url + '/__requests')).json(), close: async () => { child.kill(); } };
}

/** Network calls of the native stand-in: node's fetch, replies saved to a file like on Android. */
export async function nodeHttp(p) {
  const fs = await import('node:fs');
  let res;
  try {
    res = await fetch(p.url, { method: p.method || 'GET', headers: p.headers || {}, body: p.body ? Buffer.from(p.body, 'base64') : undefined, redirect: 'follow' });
  } catch (e) {
    throw Object.assign(new Error('network-error'), { code: 'network-error', detail: String(e.cause?.code || e.message) });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const headers = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  if (p.toFile) { fs.writeFileSync(p.toFile, buf); return { status: res.status, headers, file: p.toFile, size: buf.length }; }
  return { status: res.status, headers, b64: buf.toString('base64') };
}

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'PC', GIT_AUTHOR_EMAIL: 'pc@example.org', GIT_COMMITTER_NAME: 'PC', GIT_COMMITTER_EMAIL: 'pc@example.org' } });
}

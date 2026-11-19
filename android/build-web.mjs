// Bundles the web part of sk_notes for Android into build/assets/app.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The workspace is the one of the desktop app (../sk_notes/web/src), unchanged. Three
// things differ, and they are swapped here at build time:
//   - core/api.js (calls to Python) → web/src/mobile/api.js (calls to the in-app backend);
//   - the address vault files are served from;
//   - what the plugin API reports as the platform (a phone or tablet running Android).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const desktopWeb = join(root, 'sk_notes', 'web');
const desktopSrc = join(desktopWeb, 'src') + sep;
const mobileWeb = join(here, 'web');
const out = join(here, 'build', 'assets', 'app');
const dist = join(out, 'dist');
const dev = process.argv.includes('--dev');

rmSync(out, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const PLATFORM_RE = /export const Platform = \{[\s\S]*?\n\};/;
const PLATFORM = `export const Platform = {
  isDesktop: false, isMobile: true, isDesktopApp: false, isMobileApp: true, isIosApp: false, isAndroidApp: true,
  get isPhone() { return document.body.classList.contains('is-phone'); }, get isTablet() { return document.body.classList.contains('is-tablet'); },
  isMacOS: false, isWin: false, isLinux: false, isSafari: false, resourcePathPrefix: (location.origin + '/vault/'),
};`;
const patched = { vaultUrl: 0, platform: 0, api: 0, vaults: 0 };

const mobile = {
  name: 'sk_notes-mobile',
  setup(b) {
    b.onResolve({ filter: /(^|\/)core\/api\.js$/ }, (args) => {
      if (!args.importer.startsWith(desktopSrc) && !resolve(args.resolveDir, args.path).startsWith(desktopSrc)) return null;
      patched.api += 1;
      return { path: join(mobileWeb, 'src', 'mobile', 'api.js') };
    });
    // the vault manager of a phone (folder browser, storage places) instead of the desktop one
    b.onResolve({ filter: /(^|\/)ui\/vaults\.js$/ }, (args) => {
      if (!resolve(args.resolveDir, args.path).startsWith(desktopSrc)) return null;
      patched.vaults += 1;
      return { path: join(mobileWeb, 'src', 'mobile', 'vaults.js') };
    });
    b.onLoad({ filter: /\.js$/ }, (args) => {
      if (!args.path.startsWith(desktopSrc)) return null;
      let code = readFileSync(args.path, 'utf8');
      if (args.path.endsWith(join('compat', 'obsidian.js'))) {
        if (!PLATFORM_RE.test(code)) throw new Error('Platform not found in compat/obsidian.js');
        code = code.replace(PLATFORM_RE, PLATFORM);
        patched.platform += 1;
      }
      const parts = code.split("'skn://vault/'");
      if (parts.length > 1) {
        patched.vaultUrl += parts.length - 1;
        code = parts.join("(location.origin + '/vault/')");
      }
      if (code.includes('skn://')) throw new Error(`${args.path}: an skn:// address the Android build does not know`);
      return { contents: code, loader: 'js' };
    });
  },
};

const result = await build({
  entryPoints: [join(mobileWeb, 'src', 'mobile', 'main.js')],
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'chrome111',
  outdir: dist,
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  chunkNames: 'chunks/[name]-[hash]',
  logLevel: 'warning',
  metafile: true,
  plugins: [mobile],
  alias: { '@desktop': join(desktopWeb, 'src') },
  inject: [join(mobileWeb, 'src', 'shims', 'buffer.js')], // a full Buffer for the Git library (see the file)
  define: { __SKN_VERSION__: JSON.stringify(JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version) },
});

if (!patched.api || !patched.platform || !patched.vaults || patched.vaultUrl < 3) {
  console.error('the desktop sources changed: a build-time replacement did not apply', patched);
  process.exit(1);
}
const inputs = Object.keys(result.metafile.inputs);
if (inputs.some((p) => p.endsWith('sk_notes/web/src/core/api.js'))) {
  console.error('the desktop core/api.js was bundled');
  process.exit(1);
}
// Plugins and the app must share one CodeMirror/Lezer (see tools/build_web.mjs)
const dupes = inputs.filter((p) => /node_modules\/.+\/node_modules\/@(codemirror|lezer)\//.test(p));
if (dupes.length) {
  console.error('duplicate CodeMirror/Lezer packages bundled:\n  ' + [...new Set(dupes.map((p) => p.split('/dist/')[0]))].join('\n  '));
  process.exit(1);
}

// CSS: the desktop styles, then the mobile ones, in name order
const css = [];
for (const dir of [join(desktopWeb, 'styles'), join(mobileWeb, 'styles')]) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.css')).sort()) css.push(`/* ${f} */\n` + readFileSync(join(dir, f), 'utf8'));
}
writeFileSync(join(dist, 'app.css'), css.join('\n'));

// KaTeX stylesheet + fonts (woff2 only: every Android WebView reads it), logo
const katexDist = join(root, 'node_modules', 'katex', 'dist');
mkdirSync(join(dist, 'katex', 'fonts'), { recursive: true });
cpSync(join(katexDist, 'katex.min.css'), join(dist, 'katex', 'katex.min.css'));
for (const f of readdirSync(join(katexDist, 'fonts')).filter((x) => x.endsWith('.woff2'))) cpSync(join(katexDist, 'fonts', f), join(dist, 'katex', 'fonts', f));
// the logo of the Android app: the scorpion over an open book (icon/make_icon.py), not the desktop "S"
cpSync(join(mobileWeb, 'logo.svg'), join(dist, 'logo.svg'));
cpSync(join(mobileWeb, 'logo.svg'), join(out, 'logo.svg'));
cpSync(join(mobileWeb, 'index.html'), join(out, 'index.html'));

// Community templates: the copy the app carries (the list on GitHub is used when it answers)
cpSync(join(root, 'community', 'templates'), join(out, 'community', 'templates'), { recursive: true, filter: (src) => !src.endsWith('README.md') });

// Themes that come with the app
cpSync(join(mobileWeb, 'themes'), join(out, 'themes'), { recursive: true });

// Strings: the desktop ones plus the mobile ones, per language. Every language must have
// every mobile key (English is the base).
const locDesktop = join(root, 'sk_notes', 'locales');
const locMobile = join(mobileWeb, 'locales');
mkdirSync(join(out, 'locales'), { recursive: true });
const english = JSON.parse(readFileSync(join(locMobile, 'en.json'), 'utf8'));
let missing = 0;
for (const f of readdirSync(locDesktop).filter((x) => x.endsWith('.json'))) {
  const base = JSON.parse(readFileSync(join(locDesktop, f), 'utf8'));
  const extra = JSON.parse(readFileSync(join(locMobile, f), 'utf8'));
  for (const k of Object.keys(english)) if (extra[k] === undefined) { if (!dev) console.error(`${f}: missing string ${k}`); missing += 1; }
  for (const k of Object.keys(extra)) if (english[k] === undefined) { console.error(`${f}: unknown string ${k}`); missing += 1; }
  writeFileSync(join(out, 'locales', f), JSON.stringify({ ...base, ...extra }));
}
if (missing && !dev) process.exit(1);
console.log('built', out);

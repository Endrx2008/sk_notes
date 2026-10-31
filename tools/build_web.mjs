// Bundles sk_notes/web/src into sk_notes/web/dist (esbuild, ES modules + splitting).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'sk_notes', 'web');
const dist = join(web, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const dev = process.argv.includes('--dev');
const result = await build({
  entryPoints: [join(web, 'src', 'main.js')],
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'chrome120',
  outdir: dist,
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  chunkNames: 'chunks/[name]-[hash]',
  logLevel: 'warning',
  metafile: true,
});

// Plugins and the app must share one CodeMirror/Lezer: a nested copy (an npm version
// mismatch) breaks extensions with "multiple instances of @codemirror/state".
const dupes = Object.keys(result.metafile.inputs).filter((p) => /node_modules\/.+\/node_modules\/@(codemirror|lezer)\//.test(p));
if (dupes.length) {
  console.error('duplicate CodeMirror/Lezer packages bundled (align versions in package.json):\n  ' + [...new Set(dupes.map((p) => p.split('/dist/')[0]))].join('\n  '));
  process.exit(1);
}

// CSS: concatenate style files in name order
const styles = readdirSync(join(web, 'styles')).filter((f) => f.endsWith('.css')).sort();
writeFileSync(join(dist, 'app.css'), styles.map((f) => `/* ${f} */\n` + readFileSync(join(web, 'styles', f), 'utf8')).join('\n'));

// KaTeX stylesheet + fonts, logo
const katexDist = join(root, 'node_modules', 'katex', 'dist');
mkdirSync(join(dist, 'katex'), { recursive: true });
cpSync(join(katexDist, 'katex.min.css'), join(dist, 'katex', 'katex.min.css'));
cpSync(join(katexDist, 'fonts'), join(dist, 'katex', 'fonts'), { recursive: true });
cpSync(join(web, 'logo.svg'), join(dist, 'logo.svg'));
console.log('built', dist);

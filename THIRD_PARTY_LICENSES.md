# Third-party licenses

sk_notes is licensed under GPL-3.0-or-later. It uses the components below; all their licenses are
compatible with GPL-3.0. Full license texts are in each package (node_modules/<name>/LICENSE) and in
the Debian/Arch packages of the system libraries.

The type definitions of the public plugin API (npm package `obsidian`, MIT, © Dynalist Inc.) were
used as a reference for names and signatures only; no file of that package is included in sk_notes.

## System and build components

| Component | License | Use |
|---|---|---|
| Python 3 | PSF-2.0 | Interpreter (system package). |
| PyQt6 / python3-pyqt6 | GPL-3.0 | Qt bindings (system package). |
| Qt WebEngine / python3-pyqt6.qtwebengine | LGPL-3.0 / GPL-3.0 | Chromium-based web engine for the workspace (system package). |
| PyYAML / python3-yaml | MIT | Frontmatter parsing (system package). |
| NumPy / python3-numpy | BSD-3-Clause | Vector search for the SKAI index (system package). |
| websocket-client / python3-websocket | Apache-2.0 | UI tests only (Chrome DevTools Protocol driver); not shipped. |
| esbuild | MIT | Build tool only; not shipped. |

## JavaScript packages bundled in the web front-end

| Package | Version | License | Source |
|---|---|---|---|
| @codemirror/autocomplete | 6.18.6 | MIT | https://github.com/codemirror/autocomplete.git |
| @codemirror/commands | 6.8.1 | MIT | https://github.com/codemirror/commands.git |
| @codemirror/lang-angular | 0.1.4 | MIT | https://github.com/codemirror/lang-angular.git |
| @codemirror/lang-cpp | 6.0.3 | MIT | https://github.com/codemirror/lang-cpp.git |
| @codemirror/lang-css | 6.3.1 | MIT | https://github.com/codemirror/lang-css.git |
| @codemirror/lang-go | 6.0.1 | MIT | https://github.com/codemirror/lang-go.git |
| @codemirror/lang-html | 6.4.12 | MIT | https://code.haverbeke.berlin/codemirror/lang-html.git |
| @codemirror/lang-java | 6.0.2 | MIT | https://github.com/codemirror/lang-java.git |
| @codemirror/lang-javascript | 6.2.5 | MIT | https://github.com/codemirror/lang-javascript.git |
| @codemirror/lang-json | 6.0.2 | MIT | https://github.com/codemirror/lang-json.git |
| @codemirror/lang-less | 6.0.2 | MIT | https://github.com/codemirror/lang-less.git |
| @codemirror/lang-liquid | 6.3.3 | MIT | https://code.haverbeke.berlin/codemirror/lang-liquid.git |
| @codemirror/lang-markdown | 6.3.2 | MIT | https://github.com/codemirror/lang-markdown.git |
| @codemirror/lang-php | 6.0.2 | MIT | https://github.com/codemirror/lang-php.git |
| @codemirror/lang-python | 6.2.1 | MIT | https://github.com/codemirror/lang-python.git |
| @codemirror/lang-rust | 6.0.2 | MIT | https://github.com/codemirror/lang-rust.git |
| @codemirror/lang-sass | 6.0.2 | MIT | https://github.com/codemirror/lang-sass.git |
| @codemirror/lang-sql | 6.10.0 | MIT | https://github.com/codemirror/lang-sql.git |
| @codemirror/lang-vue | 0.1.3 | MIT | https://github.com/codemirror/lang-vue.git |
| @codemirror/lang-wast | 6.0.2 | MIT | https://github.com/codemirror/lang-wast.git |
| @codemirror/lang-xml | 6.1.0 | MIT | https://github.com/codemirror/lang-xml.git |
| @codemirror/lang-yaml | 6.1.3 | MIT | https://github.com/codemirror/lang-yaml.git |
| @codemirror/language | 6.11.0 | MIT | https://github.com/codemirror/language.git |
| @codemirror/language-data | 6.5.1 | MIT | https://github.com/codemirror/language-data.git |
| @codemirror/legacy-modes | 6.5.5 | MIT | https://code.haverbeke.berlin/codemirror/legacy-modes.git |
| @codemirror/lint | 6.9.7 | MIT | https://code.haverbeke.berlin/codemirror/lint.git |
| @codemirror/search | 6.5.10 | MIT | https://github.com/codemirror/search.git |
| @codemirror/state | 6.5.2 | MIT | https://github.com/codemirror/state.git |
| @codemirror/state | 6.7.6 | MIT | https://code.haverbeke.berlin/codemirror/state.git |
| @codemirror/streamparser | 6.0.0 | MIT | https://code.haverbeke.berlin/codemirror/streamparser.git |
| @codemirror/view | 6.36.8 | MIT | https://github.com/codemirror/view.git |
| @codemirror/view | 6.43.15 | MIT | https://code.haverbeke.berlin/codemirror/view.git |
| @lezer/common | 1.2.3 | MIT | https://github.com/lezer-parser/common.git |
| @lezer/cpp | 1.1.6 | MIT | https://code.haverbeke.berlin/lezer/cpp.git |
| @lezer/css | 1.3.9 | MIT | https://code.haverbeke.berlin/lezer/css.git |
| @lezer/go | 1.0.1 | MIT | https://github.com/lezer-parser/go.git |
| @lezer/highlight | 1.2.1 | MIT | https://github.com/lezer-parser/highlight.git |
| @lezer/html | 1.3.13 | MIT | https://github.com/lezer-parser/html.git |
| @lezer/java | 1.1.5 | MIT | https://code.haverbeke.berlin/lezer/java.git |
| @lezer/javascript | 1.5.6 | MIT | https://code.haverbeke.berlin/lezer/javascript.git |
| @lezer/json | 1.0.3 | MIT | https://github.com/lezer-parser/json.git |
| @lezer/lr | 1.4.12 | MIT | https://code.haverbeke.berlin/lezer/lr.git |
| @lezer/markdown | 1.4.3 | MIT | https://github.com/lezer-parser/markdown.git |
| @lezer/php | 1.0.6 | MIT | https://code.haverbeke.berlin/lezer/php.git |
| @lezer/python | 1.1.19 | MIT | https://code.haverbeke.berlin/lezer/python.git |
| @lezer/rust | 1.0.3 | MIT | https://code.haverbeke.berlin/lezer/rust.git |
| @lezer/sass | 1.1.0 | MIT | https://github.com/lezer-parser/sass.git |
| @lezer/xml | 1.0.6 | MIT | https://github.com/lezer-parser/xml.git |
| @lezer/yaml | 1.0.4 | MIT | https://github.com/lezer-parser/yaml.git |
| @marijn/find-cluster-break | 1.0.4 | MIT | https://code.haverbeke.berlin/marijn/find-cluster-break.git |
| argparse (used only by the markdown-it command line tool; not part of the bundle) | 2.0.1 | Python-2.0 | nodeca/argparse |
| commander | 8.3.0 | MIT | https://github.com/tj/commander.js.git |
| crelt | 1.0.7 | MIT | https://code.haverbeke.berlin/marijn/crelt.git |
| entities | 4.5.0 | BSD-2-Clause | git://github.com/fb55/entities.git |
| katex | 0.16.22 | MIT | https://github.com/KaTeX/KaTeX.git |
| linkify-it | 5.0.2 | MIT | markdown-it/linkify-it |
| markdown-it | 14.1.0 | MIT | markdown-it/markdown-it |
| mdurl | 2.1.0 | MIT | https://github.com/markdown-it/mdurl.git |
| moment | 2.30.1 | MIT | https://github.com/moment/moment.git |
| punycode.js | 2.3.1 | MIT | https://github.com/mathiasbynens/punycode.js.git |
| style-mod | 4.1.4 | MIT | https://code.haverbeke.berlin/marijn/style-mod.git |
| uc.micro | 2.1.0 | MIT | markdown-it/uc.micro |
| w3c-keyname | 2.2.8 | MIT | https://github.com/marijnh/w3c-keyname.git |
| yaml | 2.8.0 | ISC | github:eemeli/yaml |

KaTeX fonts are distributed with KaTeX under the MIT license.

## Android app: spell checker (downloaded on request)

| Component | Version | License | Use |
|---|---|---|---|
| hunspell-wasm (Hunspell for WebAssembly) | 0.3.0 | LGPL-2.0 / GPL-2.0 / MPL-1.1 | Its glue code is bundled (`dist/spell-worker.js`); the engine `hunspell.wasm` is downloaded only when the user installs a language, and checked against a fixed SHA-256. https://github.com/rotemdan/hunspell-wasm |
| Hunspell dictionaries (wooorm/dictionaries, commit 8cfea40) | — | per language (shown in the app) | Downloaded only for the languages the user chooses; not shipped. https://github.com/wooorm/dictionaries |

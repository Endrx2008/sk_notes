# Contributing to sk_notes

Thank you for helping! sk_notes is GPL-3.0-or-later; by contributing you agree that your
work is released under the same license.

## Ground rules

- Write all code yourself. Do not copy code, CSS, icons, images or texts from other note
  applications or from plugins (even open-source ones whose licenses differ). Public API
  type definitions may be used as a reference for names and signatures only.
- Code, comments, commit messages and technical documentation are in English.
- User-visible text never goes directly into the code: add a key to
  `sk_notes/locales/en.json` and use `t('key')` (JavaScript) or `i18n.strings()` (Python).
- New dependencies must have a GPL-3.0-compatible license and be listed in
  `THIRD_PARTY_LICENSES.md` (`python3 tools/third_party.py` regenerates the JavaScript part).
- Every bug fix comes with a regression test.

## Layout

```
main.py                 entry point
sk_notes/app/           Qt shell: window, skn:// scheme bridge, API routes, watcher
sk_notes/core/          vault, parser, index (SQLite/FTS5), search, links, history, trash, i18n
sk_notes/ai/            SKAI: Ollama client, embeddings, shared-memory interface
sk_notes/plugins/       plugin install/enable, permissions, Node shims (Python side)
sk_notes/extras/        importers, migration, sync, publish, PDF
sk_notes/locales/       translation files
sk_notes/web/src/       front-end (plain ES modules, bundled with esbuild)
sk_notes/web/styles/    CSS (concatenated in name order)
tests/                  Python unit tests       web/tests/   JavaScript unit tests
qa/                     UI tests (CDP driver), plugin compatibility probe, reports
```

## Build and test

```sh
npm ci && npm run build                 # web bundle → sk_notes/web/dist
python3 -m unittest discover tests      # Python tests
npm test                                # JavaScript tests
python3 tools/i18n_keys.py --check sk_notes/locales/en.json   # missing strings
python3 main.py --vault /path/to/test-vault
```

UI tests need `xvfb` and `python3-websocket`: see `qa/cdp.py`.

## Translations

Each language is one file: `sk_notes/locales/<code>.json` (codes: `en`, `it`, `es`, `fr`,
`de`, `pt`, `ru`, `zh-CN`, `ja`). English (`en.json`) is the base; a key missing in another
file falls back to English.

**Fix a translation:** edit the value in the language file. If the file has
`"_meta": {"needsReview": true}` the translation was generated automatically; when you have
reviewed the whole file, set `needsReview` to `false`.

**Add a language:**
1. Copy `en.json` to `<code>.json` (an IETF tag, e.g. `nl`, `pt-BR`).
2. Set `"_meta": {"name": "<language name in that language>", "needsReview": true}`.
3. Translate the values. Keep `{placeholders}` unchanged; plural keys end in `.one` /
   `.other` (add `.few`, `.many` … if your language needs them — see `Intl.PluralRules`).
4. Run `python3 -m unittest tests.test_i18n`: it checks that every key exists and that the
   placeholders match.

No code change is needed: the language appears in Settings → General → Language.

## Plugins

See [docs/api.md](docs/api.md) for the native API and permissions, and
[docs/compatibility.md](docs/compatibility.md) for the community-plugin compatibility layer.

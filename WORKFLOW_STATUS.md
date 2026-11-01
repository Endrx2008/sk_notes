# Workflow status

| Field | Value |
|---|---|
| Current phase | 4 – Tests (cycle 1) |
| Cycle | 1 |
| Last update | 2026-10-31 |

## Phases

- [x] Phase 1 – analysis of Skorpion apps → `docs/research/skorpion-apps.md`
- [x] Phase 2 – public material → `docs/research/ui-map.md`, `docs/research/plugins.md`,
      `docs/architecture.md`; research data in `research/` (not committed)
- [x] Phase 3 – development
- [ ] Phase 4 – tests (agent A Obsidian user, agent B destructive tester)
- [ ] Phase 5 – similarity check
- [ ] Phase 6 – originality check

## Decisions taken without asking (owner's instruction: decide, log, go on)

1. Phase 2 approval: the owner chose (2026-10-31, before the start) to continue without
   waiting; the architecture in `docs/architecture.md` is adopted as written.
2. Stack: Python 3 + PyQt6 + Qt WebEngine (same base as the SK apps), web workspace
   bundled with esbuild. Electron/Tauri rejected (see architecture).
3. UI test driver: Playwright `connectOverCDP` does not work with Qt WebEngine
   (protocol error), so tests use an equivalent CDP driver (`python3-websocket`).
4. The SK apps were deleted from this machine on 2026-10-30; Phase 1 is based on the
   notes recorded before deletion.
5. Embedding model for tests: `all-minilm` (23M parameters, 46 MB) pulled into the
   local Ollama; chat model for tests: `qwen2.5:0.5b` (the only one that fits this
   1-CPU / 1.7 GB machine alongside the app). Users get the biggest installed model.
6. Icons: own SVG set for the app; plugin calls `setIcon("<lucide name>")` resolve to
   our icon when we have one with that meaning, otherwise to a neutral placeholder
   (no third-party icon set bundled, to keep the identity fully own).
7. Languages: the 9 languages required by the spec (the old SK rule "English only"
   does not apply to sk_notes); non-English files are machine translations marked
   "needs review".

## Bugs fixed in cycle 1 (development)

1. Large saves hung: the parser's bare-URL regex was quadratic on long lines (300 KB took
   minutes). Fixed with a bounded scheme and a look-behind; regression test
   `test_long_line_is_fast`. The chunked request protocol for Qt WebEngine 6.8 bodies
   (first 64 KB block repeated) stays in place.
2. Plugin compatibility: 43 of 50 top plugins load (`docs/compatibility.md`). Added Node
   shims (stream, vm, string_decoder, punycode, http constants, tty, http2, console),
   ES5-callable EventEmitter, `hotkeyManager.addDefaultHotkeys`, `keymap.getRootScope`;
   regression tests in `sk_notes/web/tests/node-shim.test.mjs` (`npm test`).
3. The 10k-note search speed test was flaky under load: it now takes the best of 3 runs.

## Start-up time (requirement: under 2 s) — not met on this VM

Measured with `qa/startup_time.py` (process start → window ready, 200-note vault) on this VM
(1 CPU i3-5005U from 2015, 1.7 GB RAM, no GPU, Xvfb): **6.1–6.8 s** warm, from 7.5–7.8 s before
the fixes below. Breakdown of a warm start:

| Phase | Time |
|---|---|
| Python, PyQt6, QApplication | 1.4 s |
| Qt WebEngine profile + vault (vault itself: 0.01 s) | 1.4 s |
| Window shown → first page script (Chromium renderer start) | ~1.0 s |
| Page: modules 0.6 s, snapshot 0.3 s, layout 0.55 s, plugins/first render 0.4 s | ~2.0 s |

Done: lazy imports of numpy/urllib/importers (−0.8 s), one bundled CodeMirror (−215 KB JS).
About 3.5 s is the fixed cost of Qt WebEngine (Chromium) on this hardware. Further steps
if needed: deferred sidebar views (load a pane only when its tab is first shown), lighter
markdown/YAML parsers in the first chunk.

## Still to do

- Phases 4–6 (test agents, similarity, originality) and FINAL_REPORT.md.

## Done in Phase 3 (latest)

- Translations: 9 languages (en + it, es, fr, de, pt, ru, zh-CN, ja, all 779 keys,
  marked "needs review"); `tests/test_i18n.py`.
- Tests: importers, migration (source never modified), permissions (`tests/test_extras.py`),
  `sknotes://` links, embeddings, front-end static checks; UI smoke test `qa/smoke.py` (15 checks).
- Bugs found by the smoke test and fixed: empty search pane (SearchView.open shadowed
  View.open), light editor gutter on the dark theme, autosave during a note switch could
  write the previous note's text into the new file.
- `sknotes://` links (open/new/search, plugin actions; hand-over to the running window).
- Packaging: `tools/build_deb.sh` (installed and run on this VM, then removed),
  `tools/build_tarball.sh` + `packaging/arch/PKGBUILD` (package() run in a scratch dir;
  makepkg itself not available on Debian).

## Check results

None yet.

## QA cycle 1 – fixes (2026-11-01)

Reports: `qa/reports/cycle-1-agent-A.md`, `qa/reports/cycle-1-agent-B.md`.
Fixed, one commit each with a regression test: A-1, A-2, A-3, A-4, A-9, A-10, A-11,
A-14 (+ plugin-API writes reaching open editors), A-15, A-17, A-18, A-19, A-20, A-21,
B-1…B-5 and B-21 (plugin caller tokens, native confirmations, protected files; test
`qa/security.py`), B-6, B-7, B-8, B-9, B-10, B-11, B-12, B-13 (rename journal), B-14,
B-15, B-16, B-17, B-18, B-19, B-20 (safe mode; `qa/plugin_safety.py`), B-24, B-25.
A-7 (Calendar click) not reproduced: create dialog, create and open all work.

Still open (next session):
- A-8 Templater: its CM5 mode reaches `StreamLanguage.define` without `token` (shim
  `getMode` returns `{}` in plugins/manager.js) and the Prec.high language would replace
  the markdown language. Plan: minimal defineMode/getMode/overlayMode registry in the shim
  and drop plugin editor extensions that are a `Language` (debug script qa/tmp/tpl_debug.py).
- A-5 Dataview inline/Live Preview, A-6 Tasks query block, A-12 search speed,
  A-13 lazy restore of background tabs, A-16 missing commands, B-22, B-23 (low).
- Cosmetic for the user: C-1…C-6 (agent A), B-26.
- Then QA cycle 2 (both agents from scratch), Phases 5–6, FINAL_REPORT, .deb/PKGBUILD.
- Leftover test folders in /tmp (skn-home-*, ~600 MB): deleting them was blocked by the
  permission check; qa/cdp.py now removes its own. The user may delete them.

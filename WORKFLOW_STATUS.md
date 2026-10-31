# Workflow status

| Field | Value |
|---|---|
| Current phase | 3 – Development |
| Cycle | 1 |
| Last update | 2026-10-31 |

## Phases

- [x] Phase 1 – analysis of Skorpion apps → `docs/research/skorpion-apps.md`
- [x] Phase 2 – public material → `docs/research/ui-map.md`, `docs/research/plugins.md`,
      `docs/architecture.md`; research data in `research/` (not committed)
- [ ] Phase 3 – development
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

## Still to do in Phase 3

- UI smoke tests in `qa/`.
- Packaging: tools/build_deb.sh, packaging/arch/PKGBUILD, .desktop file.
- Startup time measurement (target 2 s).
- Then Phases 4–6 (test agents, similarity, originality) and FINAL_REPORT.md.

## Done in Phase 3 (latest)

- Translations: 9 languages (en + it, es, fr, de, pt, ru, zh-CN, ja, all 779 keys,
  marked "needs review"); `tests/test_i18n.py`.
- Tests: importers, migration (source never modified), permissions (`tests/test_extras.py`).

## Check results

None yet.

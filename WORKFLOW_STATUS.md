# Workflow status

| Field | Value |
|---|---|
| Current phase | 3 – Development |
| Cycle | 1 |
| Last update | 2026-10-31 (work paused: usage limit) |

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

## Open bugs (cycle 1, development still in progress)

1. API request bodies: Qt WebEngine 6.8 repeats the first 64 KB block of a request body.
   Fixed for bodies up to ~61 KB (exact length in the URL, parts of 60 KB). A 300 KB
   write still times out (multi-part upload path): to investigate next (sk_notes/app/bridge.py,
   sk_notes/web/src/core/api.js).
2. Plugin compatibility (qa/plugin_compat.py, last full run before several fixes): about 32/50
   load cleanly now; editing-toolbar crashed because of bug 1 (re-test after the fix);
   kanban, hover-editor, advanced-canvas, mind-map (ES5 classes), excalidraw, copilot,
   textgenerator, annotator, pdf-plus, realclaudian need internal APIs or Node servers.

## Still to do in Phase 3

- Fix bug 1, re-run qa/plugin_compat.py and write docs/compatibility.md.
- Translations: it, es, fr, de, pt, ru, zh-CN, ja (only en.json exists) + tests/test_i18n.py.
- Tests: importers, migration, permissions, JS unit tests (npm test), UI smoke tests.
- Packaging: tools/build_deb.sh, packaging/arch/PKGBUILD, .desktop file.
- Startup time measurement (target 2 s; ~3 s measured on this 1-CPU VM).
- Then Phases 4–6 (test agents, similarity, originality) and FINAL_REPORT.md.

## Check results

None yet.

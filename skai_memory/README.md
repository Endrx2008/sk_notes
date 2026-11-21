# skai_memory — SKAI's shared Markdown memory

One vault, `/var/lib/skai/SKAI_ Memory`, read by SKAI and by every app/plugin that makes her up.

```
SKAI_ Memory/
  SKAI.md                      hub → every app
  apps/<app>.md                one hub per app → its sub-chats
  apps/<app>/chats/<chat>.md   the app's sub-chats (they link to other apps, files, URLs)
  system.md user.md web.md     links to system files, user files, web pages
```

## Use it (same calls everywhere)

Python (scripts, LibreOffice `.oxt`; standard library only): `from skai_memory import Memory`
JavaScript (`.xpi`, Node): `import { Memory } from './skai_memory.js'`

```python
m = Memory("sk_mail")
m.search("meeting with Anna")                   # best notes + notes they link to; pulled only when needed
m.remember("inbox", "Anna moved it", links=["[[plugins/sk_office]]", "https://…", "/etc/os-release"])
m.graph(); m.links("plugins/sk_mail.md"); m.read("SKAI.md")
```
CLI: `skai-memory search <words> [--app NAME] | graph | read <note.md> | remember <app> <chat> <text>`.
In `.xpi` experiment code pass `ioUtilsFs(IOUtils, spawn)` as `fs`.

## Protection
Files are root-owned 0644: everybody reads, nobody else writes. Changes go through `skai-memory-write`:
* `--skai` (SKAI and her apps): sudoers lets group `skai` run exactly this command without a password.
* `--manual` (sk_notes editor): sudo asks the password; the app first asks the user's consent.
It refuses paths outside the vault, `..`, symlinks, non-`.md` files and notes over 256 KB, and logs to `.audit.log`.

Install: the sk-notes package does it; from a checkout `sudo sh install.sh`, then `sudo usermod -aG skai <user>`.
In sk_notes just open `/var/lib/skai/SKAI_ Memory` as a vault: it is shown read-only with an "Unlock editing" bar.

Tests: `python3 -m unittest discover -s tests`.

## For apps with a chat
`skai_memory_bridge.py` is the ready-made glue: `open_memory(app)`, `recall_text(mem, question)` (a block for the
prompt) and `remember_turn(mem, app, question, answer)`, or `around_turn(app, request, ask)` for apps with an
`ask(request)` function. Python apps copy it next to `skai_memory.py`; add-ons use `skai_memory.js`.

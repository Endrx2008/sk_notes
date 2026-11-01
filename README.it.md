# sk_notes

Appunti e base di conoscenza per **Skorpion OS**: una cartella di file Markdown sul tuo
computer, note collegate, grafo, canvas, viste a database, plugin della community e **SKAI**,
l'IA locale di Skorpion OS — tutto offline. *English: [README.md](README.md).*

- **I tuoi file, sul tuo computer.** Un vault è una normale cartella di file `.md`. Niente
  account, niente telemetria. L'unica connessione è verso il servizio locale SKAI (Ollama).
- **Familiare.** Se hai usato un'altra app di note in Markdown, pannelli, menu e scorciatoie
  sono dove te li aspetti; un vault esistente si apre così com'è e una procedura guidata propone
  di importarne le impostazioni (in sola lettura: i file originali non vengono mai modificati).
- **Leggero.** Python 3 + Qt; la ricerca risponde in meno di 100 ms su 10.000 note.

Licenza: **GPL-3.0-or-later**. sk_notes non è affiliato con Obsidian o Dynalist Inc.

## Funzioni

| Area | Cosa offre |
|---|---|
| Vault | apri/crea/cambia vault, esplora file con ordinamenti, trascinamento, rinomina (i link si aggiornano da soli), cestino di sistema o `.trash`, recupero file e cronologia delle versioni |
| Editor | Anteprima dal vivo e modalità sorgente, vista di lettura, evidenziazione della sintassi, attività, tabelle, blocchi di codice, formule (KaTeX), callout, note a piè di pagina, evidenziazioni, commenti, cursori multipli, piegatura, trova e sostituisci, comandi slash |
| Link | `[[wikilink]]` con autocompletamento, alias, link a titoli e blocchi, incorporamento di note, sezioni, immagini, audio, video e PDF, backlink e menzioni non collegate, link in uscita, anteprima al passaggio |
| Ricerca | indice a testo completo con `file:`, `path:`, `tag:`, `line:()`, `section:()`, `task-todo:`, `[proprietà:valore]`, `OR`, `-`, regex… |
| Navigazione | apertura rapida, palette dei comandi, tag annidati, struttura, segnalibri, schede, pannelli divisi, schede impilate, layout salvati, finestre separate |
| Grafo | grafo globale e locale, filtri, gruppi colorati, forze |
| Canvas | file `.canvas` (formato aperto JSON Canvas): schede, note, media, gruppi, collegamenti |
| Proprietà | editor delle proprietà con tipi e **Basi** (`.base`): viste tabella, schede, elenco e bacheca con filtri e formule |
| Organizzazione | template, note giornaliere, note uniche, compositore (unisci/estrai), conteggio parole, nota casuale |
| Esporta e importa | esportazione PDF; importazione da cartelle Markdown, Evernote, Notion, Bear/TextBundle, Logseq, Roam, Google Keep, HTML, CSV |
| Sincronizzazione e pubblicazione (facoltative) | sincronizzazione Git (commit/pull/push, commit automatico), stato di Syncthing, sito statico generato in locale |
| Plugin | API nativa di sk_notes con permessi espliciti e livello di compatibilità con i plugin della community ([tabella di compatibilità](docs/compatibility.md)) |
| SKAI | domande sulla nota aperta o su tutto il vault (indice di embedding locale), riassunti, suggerimenti di tag e link, correzione e riscrittura — in streaming, annullabili e mai applicati senza la tua conferma (prima il confronto delle differenze) |
| Lingue | English, Italiano, Español, Français, Deutsch, Português, Русский, 简体中文, 日本語 |

## Installazione

### Skorpion OS / Debian

```sh
sudo apt install ./sk-notes_0.1.0_all.deb      # pacchetto creato da tools/build_deb.sh
sk-notes
```

### Dai sorgenti

```sh
sh install-deps-apt.sh          # Python 3, PyQt6, Qt WebEngine, PyYAML, NumPy
npm ci && npm run build         # crea sk_notes/web/dist (Node.js serve solo per la compilazione)
python3 main.py                 # oppure: python3 main.py --vault ~/Note
```

### Arch / Skorpion OS Mantis

```sh
sh tools/build_tarball.sh       # dist/sk_notes-0.1.0.tar.gz + dist/PKGBUILD (con checksum)
cd dist && makepkg -si
```

### Creare i pacchetti

`sh tools/build_deb.sh` crea `dist/sk-notes_<versione>_all.deb`; `sh tools/build_tarball.sh`
crea il tarball sorgente e il PKGBUILD per Arch. Entrambi includono il front-end web già
compilato: chi installa non ha bisogno di Node.js.

## Link (`sknotes://`)

I pacchetti registrano sk_notes per i link `sknotes://`, per esempio da un launcher o da uno script:

| Link | Cosa fa |
|---|---|
| `sknotes://open?vault=Note&file=Progetti/Piano` | apre una nota (funziona anche `path=/percorso/file.md`; `newpane=true` apre una scheda) |
| `sknotes://new?vault=Note&name=Idea&content=…` | crea una nota; con `file=…&append=true` (o `prepend`, `overwrite`) aggiunge a una esistente; `silent=true` non la apre |
| `sknotes://search?vault=Note&query=tag:%23todo` | apre il pannello di ricerca |

Se il vault è già aperto, il link va alla finestra in esecuzione. Le altre azioni vengono
passate ai plugin della community che le gestiscono.

## SKAI (IA locale)

sk_notes si collega a Ollama esattamente come le altre app SK: host e modello vengono da
`~/.config/skorpion-suite/settings.json` (`ollama_host`, `ollama_model`; modello vuoto significa
*il modello di chat installato con più parametri*). In sk_notes non c'è un'impostazione separata
per host o modello, solo un interruttore (Impostazioni → SKAI). Le domande su tutto il vault
usano il modello di embedding installato, se c'è (per esempio `all-minilm`, `nomic-embed-text`),
altrimenti la ricerca per parole chiave. Senza Ollama sk_notes funziona normalmente e mostra
"SKAI offline" nella barra di stato.

## Tastiera

Le scorciatoie predefinite seguono le convenzioni delle app di note in Markdown (Ctrl+P palette
dei comandi, Ctrl+O apertura rapida, Ctrl+N nuova nota, Ctrl+E vista di lettura, Ctrl+Shift+F
ricerca, Ctrl+G grafo, Ctrl+, impostazioni…). Ogni comando si può riassegnare in Impostazioni →
Scorciatoie. Nessuna scorciatoia predefinita usa il tasto Super o Alt+F1/Alt+F9, quindi non
entrano mai in conflitto con i3 o Hyprland su Skorpion OS.

## File

| Percorso | Contenuto |
|---|---|
| `<vault>/.sk_notes/` | impostazioni (`app.json`, `appearance.json`, `hotkeys.json`, `workspace.json`…), plugin, temi, snippet, cache (`cache.db`, `history.db`, `embeddings.db` — si possono cancellare) |
| `~/.config/sk_notes/settings.json` | vault conosciuti, dimensioni della finestra, lingua |
| `~/.cache/sk_notes/sk_notes.log` | log |

## Sviluppo

- `python3 -m unittest discover tests` — test del nucleo (parser, indice, ricerca, rinomina, cronologia, importatori, traduzioni, permessi)
- `npm test` — test JavaScript (shim Node.js per i plugin)
- `python3 qa/smoke.py` — smoke test dell'interfaccia sotto Xvfb (da tastiera, Chrome DevTools Protocol)
- `python3 qa/plugin_compat.py <cartella> [id]` — compatibilità con i plugin della community ([risultati](docs/compatibility.md))
- `python3 qa/plugin_flows.py` — i flussi principali di Templater, Calendar, Tasks e Dataview
- `python3 qa/security.py` — un plugin ostile prova ad aggirare il sistema dei permessi
- `python3 qa/plugin_safety.py` — plugin che non finiscono di caricarsi o bloccano l'app (modalità sicura)
- `python3 qa/startup_time.py` — tempo di avvio; `SK_NOTES_DEBUG=1` aggiunge righe di debug al log
- Architettura: [docs/architecture.md](docs/architecture.md); API nativa dei plugin: [docs/api.md](docs/api.md); contribuire e tradurre: [CONTRIBUTING.md](CONTRIBUTING.md)

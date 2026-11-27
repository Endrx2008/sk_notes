# sk_notes

Appunti e base di conoscenza per **Skorpion OS**: una cartella di file Markdown sul tuo
computer, note collegate, grafo, canvas, viste a database, plugin della community e **SKAI**,
l'IA locale di Skorpion OS — tutto offline. *English: [README.md](README.md).*

- **I tuoi file, sul tuo computer.** Un vault è una normale cartella di file `.md`. Niente
  account, niente telemetria. La rete serve solo per il servizio locale SKAI (Ollama) e per ciò che
  chiedi tu: la sincronizzazione Git e gli elenchi della community di plugin, temi e template.
  sk_notes per Android chiede inoltre a GitHub, all'avvio, se esiste una release più recente (una
  richiesta anonima all'API pubblica), e scarica i dizionari del correttore solo per le lingue che scegli.
- **Familiare.** Se hai usato un'altra app di note in Markdown, pannelli, menu e scorciatoie
  sono dove te li aspetti; un vault esistente si apre così com'è e una procedura guidata propone
  di importarne le impostazioni (in sola lettura: i file originali non vengono mai modificati).
- **Leggero.** Python 3 + Qt; la ricerca risponde in meno di 100 ms su 10.000 note.

Licenza: **GPL-3.0-or-later**. sk_notes non è affiliato con Obsidian o Dynalist Inc.

## Funzioni

| Area | Cosa offre |
|---|---|
| Vault | apri/crea/cambia vault, esplora file con ordinamenti, trascinamento, più file insieme (Ctrl/Maiusc+clic: rinominali uno dopo l'altro, spostali, eliminali), rinomina (i link si aggiornano da soli), cestino di sistema o `.trash`, un cestino del vault (menu della rotella delle impostazioni: quello che è stato eliminato negli ultimi tre mesi, da ripristinare o eliminare per sempre; i file più vecchi se ne vanno da soli), recupero file e cronologia delle versioni |
| Editor | Anteprima dal vivo e modalità sorgente, vista di lettura, evidenziazione della sintassi, attività, tabelle, blocchi di codice, formule (KaTeX), callout, note a piè di pagina, evidenziazioni, commenti, cursori multipli, piegatura, trova e sostituisci nella nota (numero di risultati, opzioni *Parola intera* e *Maiuscole/minuscole*), comandi slash, colore del testo (salvato come `<span style="color:…">` nel Markdown, letto da ogni app) |
| Link | `[[wikilink]]` con autocompletamento, alias, link a titoli e blocchi, incorporamento di note, sezioni, immagini, audio, video e PDF, backlink e menzioni non collegate, link in uscita, anteprima al passaggio |
| Promemoria | una riga con data e ora — `- [ ] studiare capitolo 3 (@2026-11-28 15:00)`, la forma del plugin *Reminder* di Obsidian — ti chiama a quell'ora (una notifica del desktop finché sk_notes è aperto; su Android una notifica del telefono anche ad app chiusa); il pulsante dell'orologio ne mette uno, *Da fare* nella Home li elenca tutti (in ritardo, oggi, più avanti), spuntare l'attività lo chiude |
| Ricerca | indice a testo completo con `file:`, `path:`, `tag:`, `line:()`, `section:()`, `task-todo:`, `[proprietà:valore]`, `OR`, `-`, regex…; l'elenco dei file nell'area principale (la vista elenco di Android) ha una sua casella di ricerca, con *Parola intera* |
| Home | una scheda vuota è la Home, come in sk_notes per Android: il logo con il nome del vault aperto, le note recenti in una riga, crea (nota — con un pulsante calendario per la nota di oggi —, canvas e una barra più piccola per una nota da template), visualizza (grafo, database del vault — una vista, nessun file viene creato; l'elenco dei file è sempre nella barra laterale sinistra); ogni riquadro è un comando con una scorciatoia (Impostazioni → Scorciatoie) mostrata sul riquadro — nota Ctrl+N, canvas Ctrl+C quando non c'è nulla da copiare; frecce e Invio funzionano sulla Home. La barra laterale a sinistra si nasconde finché sullo schermo c'è solo la Home. Il "+" delle schede mostra due bolle (nota, canvas) da cliccare, oppure premi e trascina verso una delle due |
| Riquadri | il pulsante "nuovo riquadro a destra" nell'intestazione di ogni riquadro (o Ctrl+Alt+D) aggiunge un riquadro sul bordo destro, tutti della stessa larghezza, con l'ultima nota usata non visibile (o la Home). I riquadri si spostano come finestre dentro la finestra, senza mai uscirne: trascina una scheda per il nome e lasciala sulla metà del riquadro dove deve andare (sinistra, destra, sopra, sotto), al centro per unirla alle sue schede, su una barra delle schede per metterla tra quelle; trascina la parte vuota di una barra delle schede per spostare tutto il riquadro; Esc annulla. Un file dell'elenco lasciato sul bordo di un riquadro si apre accanto. Chiudendo l'ultima nota di un riquadro si chiude il riquadro e gli altri si dividono il suo spazio |
| Navigazione | apertura rapida, palette dei comandi, tag annidati, struttura, segnalibri, schede, pannelli divisi, layout salvati, finestre separate |
| Grafo | grafo globale e locale, filtri, gruppi colorati, forze; i punti restano dove erano quando il grafo si riapre; il clic destro (sul telefono una pressione lunga) sceglie i punti e mostra una matita: colore e dimensione per tutti (entrambi ricordati; un tema non cambia mai un colore scelto dall'utente), o le loro note nel cestino; una pressione lunga (clic destro) su un punto vuoto crea lì una nuova nota o un canvas; i canvas sono quadrati con una freccia verso ogni nota messa sopra (opzione *Canvas*, attiva di base); a scelta: le note spostate da sole in cartelle ad albero sotto le loro note madre (Impostazioni → File e link) |
| Canvas | file `.canvas` (formato aperto JSON Canvas): schede, note, media, gruppi, collegamenti (colore, etichetta, direzione, rimuovi tutte le frecce di una scheda), rinomina dal titolo, immagine di tutta la lavagna (JPG), disegni a mano (una scheda che è un file SVG del vault, da ridisegnare con un doppio tocco); i sei colori delle schede sono valori fissi, uguali in ogni tema |
| Proprietà | editor delle proprietà con tipi e **Basi** (`.base`): viste tabella, schede, elenco e bacheca con filtri e formule |
| Organizzazione | template, note giornaliere, note uniche, compositore (unisci/estrai), conteggio parole |
| Esporta e importa | esportazione PDF; importazione da cartelle Markdown, Evernote, Notion, Bear/TextBundle, Logseq, Roam, Google Keep, HTML, CSV |
| Sincronizzazione e pubblicazione (facoltative) | sincronizzazione con **GitHub, GitLab o qualsiasi server Git** con un nome e un token: commit, pull e push da soli, unioni senza marcatori di conflitto (l'altra versione resta accanto alla nota); lo stesso vault si apre in sk_notes per Android, in Obsidian con il suo plugin Git, in Foam o in Tolaria. Git a mano e stato di Syncthing; sito statico generato in locale |
| Cifratura (facoltativa) | un intero vault come un unico file cifrato (`.skvault`, AES-256-GCM, password + codice di recupero), nuovo o da un vault esistente e ritorno; si blocca da solo dopo il tempo scelto; lo stesso file si apre in sk_notes per Android |
| Plugin e temi | API nativa di sk_notes con permessi espliciti e livello di compatibilità con i plugin della community ([tabella di compatibilità](docs/compatibility.md)); gli elenchi pubblici di plugin, temi e template di note della community, sfogliati e installati con un clic; il tema Anna.g_3 incluso |
| SKAI | domande sulla nota aperta o su tutto il vault (indice di embedding locale), riassunti, suggerimenti di tag e link, correzione e riscrittura — in streaming, annullabili e mai applicati senza la tua conferma (prima il confronto delle differenze). Sul PC lo scorpione di SKAI vive in una casetta sul grafo: va verso le note che SKAI legge (con un fascio di luce), modifica, crea o collega, e dorme quando non c'è niente da fare — in SKAI_ Memory mostra cosa fa ogni app di SKAI con la memoria |
| Lingue | English, Italiano, Español, Français, Deutsch, Português, Русский, 简体中文, 日本語 |

## SKAI_ Memory

Il pacchetto installa anche la memoria Markdown condivisa di SKAI (`/var/lib/skai/SKAI_ Memory`, vedi `skai_memory/README.md`): ogni app e plugin SKAI si identifica tramite la libreria `skai_memory`, tiene le proprie note in `plugins/<app>/` e può leggere tutte le altre. Per permettere alle app di un utente di scrivere: `sudo usermod -aG skai <utente>`.

Sul PC sk_notes apre SKAI_ Memory come una finestra sulla memoria, non come un quaderno: il grafo al centro, i file a sinistra e SKAI a destra, che legge e cambia la memoria quando glielo chiedi a parole (ogni modifica viene mostrata prima; nessuna password di sudo). Niente Home, niente strumenti per prendere appunti, niente riquadri o finestre, niente impostazioni: l'aspetto dell'interfaccia è lo stesso in tutti i vault del computer. Git carica soltanto la memoria; la cronologia delle versioni resta.

## Android

`android/` contiene sk_notes per Android 8.0 o successivi: lo stesso spazio di lavoro del PC in un APK,
con la sincronizzazione Git e i vault cifrati compatibili con quelli del desktop, un correttore
ortografico con le lingue scaricate solo quando le scegli e un avviso quando su GitHub c'è una release
più recente. Telefoni e tablet hanno la stessa disposizione (quella del telefono). I promemoria suonano
come notifiche del telefono; widget per la schermata Home: cose da fare, una nota (la lista della
spesa…), il grafo. Compilazione, firma,
test e differenze del telefono: [android/README.md](android/README.md) (in inglese).

```sh
npm ci && sh android/build.sh   # → android/dist/sk_notes-1.3.0.apk
```

## Installazione

### Skorpion OS / Debian

```sh
sudo apt install ./sk-notes_1.3.0_all.deb      # pacchetto creato da tools/build_deb.sh
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
sh tools/build_tarball.sh       # dist/sk_notes-1.3.0.tar.gz + dist/PKGBUILD (con checksum)
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
| `sknotes://graph?vault=Note` | apre il grafo (il widget del grafo su Android) |
| `sknotes://reminders?vault=Note` | apre l'elenco delle cose da fare (promemoria) |

Se il vault è già aperto, il link va alla finestra in esecuzione. Le altre azioni vengono
passate ai plugin della community che le gestiscono.

## SKAI (IA locale)

sk_notes si collega a Ollama esattamente come le altre app SK: host e modello vengono da
`~/.config/skorpion-suite/settings.json` (`ollama_host`, `ollama_model`; modello vuoto significa
*il modello di chat installato con più parametri*). In sk_notes non c'è un'impostazione separata
per host o modello, solo un interruttore (Impostazioni → SKAI). Le domande su tutto il vault
usano il modello di embedding installato, se c'è (per esempio `all-minilm`, `nomic-embed-text`),
altrimenti la ricerca per parole chiave. Senza Ollama, o senza un modello, sk_notes funziona
normalmente: la barra di stato dice "IA non disponibile" e il pannello SKAI mostra lo stesso messaggio
di tutti gli strumenti SKAI ("Le funzioni IA sono disattivate…").

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
- `cd android && npm test` — backend Android confrontato con quello Python, vault cifrati, sincronizzazione Git con un vero server Git
- `python3 qa/smoke.py` — smoke test dell'interfaccia sotto Xvfb (da tastiera, Chrome DevTools Protocol)
- `python3 qa/plugin_compat.py <cartella> [id]` — compatibilità con i plugin della community ([risultati](docs/compatibility.md))
- `python3 qa/plugin_flows.py` — i flussi principali di Templater, Calendar, Tasks e Dataview
- `python3 qa/security.py` — un plugin ostile prova ad aggirare il sistema dei permessi
- `python3 qa/plugin_safety.py` — plugin che non finiscono di caricarsi o bloccano l'app (modalità sicura)
- `python3 qa/startup_time.py` — tempo di avvio; `SK_NOTES_DEBUG=1` aggiunge righe di debug al log
- Architettura: [docs/architecture.md](docs/architecture.md); API nativa dei plugin: [docs/api.md](docs/api.md); contribuire e tradurre: [CONTRIBUTING.md](CONTRIBUTING.md)

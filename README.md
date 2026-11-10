# wterm lokal – Terminal-Simulation im Browser mit nano

Dieses Projekt enthält den benötigten Quellcode von
[vercel-labs/wterm](https://github.com/vercel-labs/wterm) (Commit `20a1a24`, Apache-2.0,
siehe `LICENSE`) als eigenständiges Vite-Projekt. Alles läuft **lokal im Browser**:

- kein SSH, kein PTY-Server, kein Backend
- die Shell ist [just-bash](https://www.npmjs.com/package/just-bash) mit In-Memory-Dateisystem
- Netzwerkzugriff ist aus (just-bash ohne `network`-Konfiguration → `curl` & Co. sind deaktiviert)

## Struktur

| Pfad | Inhalt |
|---|---|
| `packages/core/` | `@wterm/core` – VT-Parser (Zig → WASM, vorkompiliert in `wasm/wterm.wasm`) + TS-Bridge |
| `packages/dom/` | `@wterm/dom` – DOM-Renderer, Eingabe, CSS |
| `packages/just-bash/` | `@wterm/just-bash` – Shell-Adapter (Zeileneditor, History, Tab-Completion) |
| `packages/just-bash/src/nano.ts` | **neu:** nano-Emulation |
| `packages/just-bash/src/git/` | **neu:** git-Emulation (isomorphic-git + Dateisystem-Adapter) |
| `packages/just-bash/src/line-reader.ts` | **neu:** Zeileneditor für interaktive Programme (REPL, `input()`) |
| `packages/python/` | **neu:** `@wterm/python` – `python`/`python3`/`pip` auf Basis von Pyodide |
| `index.html`, `src/main.ts` | Seite `/`: Terminal mit Shell, nano und git |
| `python.html`, `src/python-main.ts` | Seite `/python.html`: zusätzlich mit Python |
| `packages/psql/` | **neu:** `@wterm/psql` – psql-Simulation auf Basis von PGlite |
| `psql.html`, `src/psql-main.ts` | Seite `/psql.html`: psql direkt (ohne Shell) |
| `scripts/inline-wasm.mjs` | bettet die WASM-Datei als Base64 ein (läuft automatisch vor `dev`/`build`) |
| `scripts/copy-pyodide.mjs` | kopiert die Pyodide-Laufzeit nach `public/pyodide/` (automatisch vor `dev`/`build`) |

Die Pakete werden per Vite-Alias direkt aus `packages/*/src` gebaut – kein pnpm, Turbo oder Zig nötig.
Nicht übernommen wurden: React/Vue/Svelte-Bindings, Ghostty-Core, Markdown, Docs-Site, Beispiele
mit Server (SSH/lokale PTY) und die Tests.

## Starten

```bash
npm install
npm run dev        # http://127.0.0.1:5173, …/python.html und …/psql.html
npm run build      # statischer Build nach dist/ (alle Seiten)
```

## nano

Aufruf in der Shell: `nano [OPTIONEN] [+ZEILE[,SPALTE]] [DATEI]`

Optionen: `-l` Zeilennummern, `-v` Lesemodus, `-T N` Tabbreite, `-h`, `-V`.

| Taste | Funktion |
|---|---|
| ^O / F3 | Speichern unter (Dateiname abfragen) |
| ^S | Speichern ohne Nachfrage |
| ^X / F2 | Beenden (fragt bei Änderungen nach) |
| ^R | Datei einfügen |
| ^W, ^F, F6 / ^B | Suchen vorwärts / rückwärts |
| M-W / M-Q | Weitersuchen vorwärts / rückwärts |
| ^\ / M-R | Suchen & Ersetzen (Y/N/A) |
| ^K / M-6 / ^U | Zeile ausschneiden / kopieren / einfügen |
| M-U / M-E | Rückgängig / Wiederholen |
| ^C | Cursorposition anzeigen |
| ^_ / M-G | Gehe zu Zeile[,Spalte] |
| ^A ^E ^Y ^V, Pfeile, Pos1/Ende, Bild↑/↓ | Navigation |
| Strg+Pos1 / Strg+Ende, Strg+←/→ | Dateianfang/-ende, wortweise |
| M-N | Zeilennummern ein/aus |
| ^G / F1 | Hilfe |

Hinweis: Einige Strg-Kombinationen (Strg+W, Strg+N, Strg+T) fängt der Browser ab – dafür gibt es
die Alternativen (z. B. ^F oder F6 zum Suchen). „M-“ ist die Alt-Taste.

Nicht nachgebaut: Markieren (^6), Syntaxhervorhebung, mehrere Puffer, Rechtschreibprüfung,
Soft-Wrap. Wenn `nano` in einer Pipe oder mit `;`/`&&` verwendet wird, meldet es einen Fehler –
nur der eigenständige Aufruf startet den Editor.

Dateien liegen im Arbeitsspeicher: Ein Neuladen der Seite setzt das Dateisystem zurück.

## git

`git` basiert auf [isomorphic-git](https://isomorphic-git.org/) und schreibt ein echtes
`.git`-Verzeichnis ins virtuelle Dateisystem. Die Identität ist in `~/.gitconfig` vorbelegt
(`user` / `user@wterm.local`) und lässt sich mit `git config --global user.name …` ändern.

Unterstützt (nur lokal):

| Bereich | Befehle |
|---|---|
| Anlegen & Einstellungen | `init [-b name]`, `config [--global] [--list] [--unset]` |
| Änderungen erfassen | `add` (`.`, `-A`, `-u`), `rm` (`--cached`, `-r`), `mv`, `restore` (`--staged`, `--source`) |
| Ansehen | `status` (`-s`), `diff` (`--staged`, `--stat`, `--name-only`, `A..B`), `log` (`--oneline`, `-n`, `--stat`), `show`, `ls-files`, `rev-parse` |
| Historie | `commit` (`-m`, `-a`, `--amend`, `--allow-empty`), `branch` (`-d/-D`, `-m`, `-v`), `checkout` (`-b`, `-- datei`), `switch` (`-c`), `merge` (Fast-Forward, Merge-Commit, Konflikte, `--abort`, `--no-ff`), `tag` (`-a -m`, `-d`), `reset` (`--soft/--mixed/--hard`, Dateien) |

- `git commit` ohne `-m` öffnet **nano** mit der Commit-Vorlage (`.git/COMMIT_EDITMSG`);
  speichern und mit ^X schließen erstellt den Commit, eine leere Nachricht bricht ab.
- Bei Merge-Konflikten stehen Konfliktmarker in den Dateien; nach dem Auflösen `git add`
  und `git commit` (erzeugt einen Merge-Commit mit zwei Eltern).
- **Remote-Befehle** (`clone`, `fetch`, `pull`, `push`, `remote`, `ls-remote`, `submodule`, …)
  melden: *„Remote-Befehle sind in dieser Simulation nicht verfügbar (kein Netzwerkzugriff).“*
- Nicht unterstützt (mit Meldung): `stash`, `rebase`, `cherry-pick`, `revert`, `bisect`, `blame`,
  `clean` u. a.
- git funktioniert auch in Pipes und Skripten (`git log --oneline | wc -l`); nur der
  nano-Commit-Editor braucht den direkten Aufruf.

## Python (`/python.html`)

Die Seite `python.html` bietet dasselbe Terminal wie `/`, zusätzlich mit `python`/`python3`.
Grundlage ist [Pyodide](https://pyodide.org/) (CPython 3.14 als WebAssembly). Die Laufzeit
(~13 MB) wird **lokal** aus `pyodide/` ausgeliefert, es gibt keine Zugriffe auf ein CDN. Die Seite `/`
lädt Pyodide nicht und verhält sich unverändert.

| Aufruf | Verhalten |
|---|---|
| `python` | interaktive REPL (`>>>`, mehrzeilige Blöcke, Verlauf mit ↑/↓, Strg+C, Strg+D/`exit()`) |
| `python skript.py arg …` | Skript ausführen, Ausgabe live, `input()` liest vom Terminal |
| `python -c "code"`, `python -m modul` | wie bei CPython |
| `echo 5 \| python skript.py`, `python x.py > out.txt` | Pipes und Umleitungen (stdin aus der Pipe) |
| `pip …` | Hinweis: keine Paketinstallation möglich (kein Netzwerk) |

- Dateien werden zwischen Shell und Python abgeglichen (`/home`, `/tmp`): Python sieht mit nano
  bearbeitete Dateien, und von Python geschriebene Dateien erscheinen danach in der Shell
  (`.git` und `__pycache__` ausgenommen).
- Verfügbar ist die Standardbibliothek (inkl. `sqlite3`, `json`, `re`, `random`, …), aber keine
  Fremdpakete wie numpy.
- `input()` nutzt JavaScript Promise Integration (JSPI, z. B. aktuelles Chrome/Edge). Fehlt sie im
  Browser, erscheint stattdessen ein Eingabedialog.
- Python läuft im Haupt-Thread: Endlosschleifen lassen sich nicht mit Strg+C abbrechen, dann hilft
  nur das Neuladen der Seite.

## psql (`/psql.html`)

Die Seite startet direkt **psql** – ohne Bash. Die Datenbank ist PostgreSQL über
[PGlite](https://pglite.dev/) (WebAssembly, im Arbeitsspeicher, ~15 MB, lokal ausgeliefert).

### SQL-Skripte in der Seite

Alle `<script type="text/sql">` werden in Dokumentreihenfolge ausgeführt, bevor psql startet:

```html
<script type="text/sql" data-name="schema.sql">
  CREATE TABLE kunden (id serial PRIMARY KEY, name text NOT NULL);
</script>
<script type="text/sql" src="daten.sql"></script>
```

- Inline-SQL oder `src="…"` (relativ zur Seite, wird per `fetch` geladen – Dateien dafür in
  `public/` ablegen, damit sie im Build landen).
- `data-name` bestimmt den Namen in Fehlermeldungen (`psql:schema.sql:3: ERROR: …`) und für `\i`.
- Ergebnisse werden nicht angezeigt, Fehler und NOTICEs schon. Die Ausführung läuft bei Fehlern
  weiter (wie `psql -f`).
- Die Skripte stehen danach als Dateien bereit, z. B. `\i schema.sql`.

### Was psql kann

- Prompt wie im Original: `postgres=#`, Fortsetzung `postgres-#`, offene Strings/Klammern
  (`'#`, `(#`), Transaktionen `postgres=*#` und fehlgeschlagene Transaktion `postgres=!#`.
- Statements enden mit `;` (Strings, `"Bezeichner"`, `$$…$$`, Kommentare werden beachtet);
  mehrzeilige Eingabe, Verlauf mit ↑/↓, Strg+C verwirft den Puffer.
- Ausgabe wie psql: ausgerichtete Tabellen (Zahlen rechtsbündig, mehrzeilige Werte mit `+`),
  `(n rows)`, Command-Tags (`INSERT 0 1`, `UPDATE 2`, …), `NOTICE`, Fehler mit `LINE n:` und `^`,
  `DETAIL`/`HINT`/`CONTEXT`.
- Meta-Befehle: `\q`, `\?`, `\h`, `\d`, `\d NAME`, `\dt`, `\dv`, `\di`, `\ds`, `\dn`, `\df`, `\du`,
  `\dx`, `\l`, `\x [on|off|auto]`, `\a`, `\t`, `\pset`, `\timing`, `\i`, `\w`, `\g`, `\gx`, `\p`, `\r`,
  `\s`, `\echo`, `\set ON_ERROR_STOP`, `\c`, `\conninfo`, `\encoding`; außerdem `help`, `quit`, `exit`.
- `\q` beendet die Sitzung; Enter startet eine neue (die Datenbank bleibt bis zum Neuladen erhalten).

Nicht unterstützt: andere Datenbanken als `postgres` (`\c`), `\e`, `\!` (keine Shell), `\copy`,
Variablen-Ersetzung (`:name`), Tab-Vervollständigung. Lange Abfragen lassen sich nicht abbrechen.

## Umgebungsvariablen

Die Shell merkt sich Variablen über Befehlszeilen hinweg, wie eine echte Bash:

- `export X=1` gilt für alle folgenden Zeilen, `unset X` entfernt die Variable wieder.
- Normale Shell-Variablen (`Y=2`) bleiben ebenfalls erhalten, werden aber nicht an Programme
  weitergegeben.
- `$?`, `PATH`-Änderungen und `OLDPWD` (für `cd -`) bleiben erhalten.

Python (`/python.html`) bekommt in `os.environ` genau die exportierten Variablen, auch mit
vorangestellter Zuweisung (`NAME=Ada python skript.py`) und in der REPL. Änderungen an
`os.environ` innerhalb von Python wirken, wie bei echtem Python, nicht auf die Shell zurück.

Technisch hängt die Shell an jede Befehlszeile unsichtbar einen internen Befehl
(`__wterm_env_snapshot`), der Variablen und Export-Status sichert. Der Exit-Code der Zeile bleibt
dabei unverändert.

## Veröffentlichen auf GitHub Pages

Der Build ist rein statisch (`dist/`, ca. 31 MB inkl. Pyodide und PGlite) und nutzt relative Pfade
(`base: "./"` in `vite.config.ts`). Er funktioniert daher unter jedem Unterpfad, z. B.
`https://medien-informatik.github.io/terminal/`, `…/terminal/python.html` und `…/terminal/psql.html`.

Der Workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) baut bei jedem Push auf
`main` (oder manuell über „Run workflow“) mit Node 24 und veröffentlicht `dist/`.
`dist/`, `public/pyodide/` und `wasm-inline.ts` werden im Build erzeugt und nicht eingecheckt.

Einmalig im Repository einstellen: **Settings → Pages → Build and deployment → Source:
„GitHub Actions“**.

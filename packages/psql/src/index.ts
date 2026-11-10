/**
 * psql-Simulation auf Basis von PGlite (PostgreSQL als WebAssembly).
 *
 * `startPsql()` verbindet ein wterm-Terminal direkt mit einer psql-Sitzung –
 * ohne Shell. SQL-Skripte (z. B. aus <script type="text/sql">) werden vorher
 * in der Datenbank ausgeführt.
 */
import { LineReader, type LineResult, type ReadLineOptions } from "../../just-bash/src/line-reader.js";
import { Database } from "./database.js";
import { PsqlSession, StopError, type PsqlFiles, type PsqlIO, type PsqlSettings } from "./session.js";

export { Database } from "./database.js";
export { PsqlSession } from "./session.js";
export type { PsqlSettings } from "./session.js";

export interface SqlScript {
  /** Name für Fehlermeldungen (psql:<name>:<zeile>: ERROR: …) und für \i. */
  name: string;
  sql: string;
}

/** Ausschnitt der WTerm-API, der gebraucht wird. */
export interface PsqlTerminal {
  write(data: string): void;
  readonly cols: number;
  onData: ((data: string) => void) | null;
}

export interface StartPsqlOptions {
  /** Skripte, die vor dem Start der Sitzung ausgeführt werden. */
  scripts?: SqlScript[];
  /** Ausgabeeinstellungen (z. B. { expanded: "auto" }). */
  settings?: Partial<PsqlSettings>;
  /** Gemeinsame Datenbank (Standard: neue In-Memory-Instanz). */
  database?: Database;
}

/** Dateien im Arbeitsspeicher für \i und \w. */
export class MemoryFiles implements PsqlFiles {
  readonly files = new Map<string, string>();

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error("ENOENT");
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}

const CWD = "/";

/**
 * Führt Skripte aus. Ergebnisse werden nicht ausgegeben, Fehler und
 * NOTICEs schon. Rückgabe: Anzahl der Fehler.
 */
export async function runScripts(db: Database, scripts: SqlScript[], io: PsqlIO, fs: PsqlFiles): Promise<number> {
  let errors = 0;
  for (const script of scripts) {
    const session = new PsqlSession(db, io, { fs, cwd: CWD }, { silent: true, quiet: true });
    await session.runText(script.sql, script.name);
    errors += session.errors;
  }
  return errors;
}

/** Startet psql direkt im Terminal (läuft, solange die Seite offen ist). */
export async function startPsql(term: PsqlTerminal, options: StartPsqlOptions = {}): Promise<void> {
  const write = (t: string) => term.write(t.replace(/\r?\n/g, "\r\n"));
  const db = options.database ?? new Database();
  const files = new MemoryFiles();

  // Eingaben an den aktiven Zeileneditor weiterleiten
  let reader: LineReader | null = null;
  let pending = "";
  term.onData = (data) => {
    if (!reader) {
      pending += data;
      return;
    }
    const rest = reader.handleInput(data);
    if (reader.finished) {
      reader = null;
      pending += rest;
    }
  };
  const readLine = (opts?: ReadLineOptions): Promise<LineResult> => {
    const r = new LineReader((t) => term.write(t), opts);
    reader = r;
    if (pending) {
      const input = pending;
      pending = "";
      const rest = r.handleInput(input);
      if (r.finished) {
        reader = null;
        pending = rest;
      }
    }
    return r.result;
  };

  // Datenbank starten und Skripte ausführen
  write("\x1b[2mPostgreSQL (PGlite) wird gestartet …\x1b[0m");
  await db.get();
  const scripts = options.scripts ?? [];
  for (const s of scripts) await files.writeFile(`/${s.name}`, s.sql);
  let scriptOutput = "";
  const errors = await runScripts(db, scripts, { out: (t) => (scriptOutput += t), err: (t) => (scriptOutput += t) }, files);
  write("\r\x1b[K");
  if (scripts.length) {
    write(
      `\x1b[2m${scripts.length} SQL-Skript${scripts.length === 1 ? "" : "e"} ausgeführt` +
        ` (${scripts.map((s) => s.name).join(", ")})` +
        (errors ? `, \x1b[0m\x1b[31m${errors} Fehler` : "") +
        ".\x1b[0m\n",
    );
    if (scriptOutput) write(scriptOutput);
    write("\n");
  }

  const version = ((await db.rows("SHOW server_version")).rows[0]?.[0] ?? "").split(" ")[0];
  const history: string[] = [];

  for (;;) {
    const session = new PsqlSession(
      db,
      { out: write, err: write },
      { fs: files, cwd: CWD, columns: () => term.cols, history },
      options.settings,
    );
    await session.init();
    write(`psql (${version})\nType "help" for help.\n\n`);

    for (;;) {
      term.write(session.prompt());
      const r = await readLine({ history });
      if (r.type === "eof") {
        term.write("\\q\r\n");
        break;
      }
      if (r.type === "interrupt") {
        session.scanner.reset();
        continue;
      }
      const line = r.text;
      if (line.trim()) history.push(line);
      // "help", "quit", "exit" am Anfang einer leeren Abfrage (wie psql)
      if (session.scanner.isEmpty) {
        const word = line.trim().replace(/;$/, "").toLowerCase();
        if (word === "quit" || word === "exit") break;
        if (word === "help") {
          write(
            "You are using psql, the command-line interface to PostgreSQL.\n" +
              "Type:  \\copyright for distribution terms\n" +
              "       \\h for help with SQL commands\n" +
              "       \\? for help with psql commands\n" +
              "       \\g or terminate with semicolon to execute query\n" +
              "       \\q to quit\n",
          );
          continue;
        }
      }
      try {
        if ((await session.handleLine(line)) === "quit") break;
      } catch (err) {
        if (!(err instanceof StopError)) write(`psql: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    // Keine Shell: nach \q eine neue Sitzung anbieten (Datenbank bleibt erhalten)
    write("\n\x1b[2mpsql wurde beendet. Enter startet eine neue Sitzung.\x1b[0m\n");
    await readLine();
  }
}

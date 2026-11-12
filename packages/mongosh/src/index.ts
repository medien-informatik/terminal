/**
 * mongosh-Simulation: MongoDB-Shell im Browser ohne Server.
 *
 * Abfragen, Updates und Aggregationen laufen lokal mit mingo
 * (MongoDB-Abfragesprache für Objekte im Arbeitsspeicher).
 * `startMongosh()` verbindet ein wterm-Terminal direkt mit der REPL.
 */
import { LineReader, type LineResult, type ReadLineOptions } from "../../just-bash/src/line-reader.js";
import { ObjectId } from "./bson.js";
import { Server } from "./engine.js";
import { BANNER, MongoshSession, type ShellScript } from "./shell.js";

export { ObjectId } from "./bson.js";
export { Server } from "./engine.js";
export { inspect } from "./inspect.js";
export { MongoshSession, type ShellScript } from "./shell.js";

/** Ausschnitt der WTerm-API, der gebraucht wird. */
export interface MongoshTerminal {
  write(data: string): void;
  onData: ((data: string) => void) | null;
}

export interface StartMongoshOptions {
  /** JavaScript-Skripte (mongosh-Syntax), die vor dem Start ausgeführt werden. */
  scripts?: ShellScript[];
  /** Gemeinsamer Datenbestand (Standard: neu, im Arbeitsspeicher). */
  server?: Server;
  /** Datenbank beim Start (Standard: die zuletzt von einem Skript gewählte, sonst "test"). */
  db?: string;
}

/** Startet mongosh direkt im Terminal (läuft, solange die Seite offen ist). */
export async function startMongosh(term: MongoshTerminal, options: StartMongoshOptions = {}): Promise<void> {
  const write = (t: string) => term.write(t.replace(/\r?\n/g, "\r\n"));
  const server = options.server ?? new Server();

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

  const shellOptions = { write, clear: () => term.write("\x1b[2J\x1b[3J\x1b[H"), colors: true };

  // Startskripte ausführen (Ergebnisse unsichtbar, Fehler sichtbar)
  const scripts = options.scripts ?? [];
  let startDb = options.db ?? "test";
  if (scripts.length) {
    let output = "";
    const loader = new MongoshSession(server, { write: (t) => (output += t), colors: true });
    let errors = 0;
    for (const s of scripts) if (!(await loader.runScript(s.name, s.code))) errors++;
    if (!options.db) startDb = loader.db.getName();
    write(
      `\x1b[2m${scripts.length} Skript${scripts.length === 1 ? "" : "e"} ausgeführt` +
        ` (${scripts.map((s) => s.name).join(", ")})` +
        (errors ? `, \x1b[0m\x1b[31m${errors} Fehler` : "") +
        ".\x1b[0m\n",
    );
    if (output) write(output);
    write("\n");
  }

  const history: string[] = [];
  for (;;) {
    const session = new MongoshSession(server, shellOptions, startDb);
    for (const s of scripts) session.addScript(s.name, s.code);
    write(BANNER(new ObjectId().toHexString()) + "\n");

    let ctrlC = false;
    for (;;) {
      term.write(session.prompt());
      const r = await readLine({ history, tab: "  " });
      if (r.type === "eof") break;
      if (r.type === "interrupt") {
        if (!session.isEmpty) {
          session.resetBuffer();
          ctrlC = false;
          continue;
        }
        if (ctrlC) break;
        ctrlC = true;
        write("(To exit, press Ctrl+C again or Ctrl+D or type .exit)\n");
        continue;
      }
      ctrlC = false;
      const line = r.text;
      if (line.trim()) history.push(line);
      if ((await session.handleLine(line)) === "quit") break;
    }

    startDb = session.db.getName();
    // Keine Shell: nach exit eine neue Sitzung anbieten (Daten bleiben erhalten)
    write("\n\x1b[2mmongosh wurde beendet. Enter startet eine neue Sitzung.\x1b[0m\n");
    await readLine();
  }
}

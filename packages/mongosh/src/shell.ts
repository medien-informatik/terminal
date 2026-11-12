/**
 * Die mongosh-REPL: wertet JavaScript aus, kennt die Shell-Befehle
 * (use, show, it, help, exit, cls) und gibt Ergebnisse wie mongosh aus.
 *
 * Eingaben werden als globales JavaScript ausgeführt (indirektes eval), damit
 * Variablen zwischen Eingaben erhalten bleiben. Top-Level-let/const/class
 * werden dafür zu var umgeschrieben – wie in der mongosh-REPL bleiben sie so
 * in späteren Eingaben sichtbar.
 */
import * as bson from "./bson.js";
import {
  AbstractCursor,
  Database,
  formatBytes,
  MONGODB_VERSION,
  MongoServerError,
  MongoshInvalidInputError,
  Server,
  ShellText,
  validateDbName,
} from "./engine.js";
import { inspect } from "./inspect.js";

export const MONGOSH_VERSION = "2.5.0";
const BATCH_SIZE = 20;

export interface ShellScript {
  name: string;
  code: string;
}

const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;

const globalEval = eval;

/** Quelltext so umschreiben, dass Deklarationen global erhalten bleiben. */
export function prepareSource(code: string): string {
  return code
    .replace(/^(\s*)(?:let|const)(\s+)(?=[\p{L}_$[{])/gmu, "$1var$2")
    .replace(/^(\s*)class\s+([\p{L}_$][\p{L}\p{N}_$]*)/gmu, "$1var $2 = class $2");
}

/**
 * true, wenn die Eingabe noch nicht vollständig ist: offene Klammern,
 * Template-Strings oder Blockkommentare, oder eine Zeile endet mit "\".
 * Syntaxfehler zeigt danach die Auswertung an.
 */
export function isIncomplete(code: string): boolean {
  const stack: string[] = [];
  let lastSignificant = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    // Template-String: Ende suchen, ${ öffnet einen Ausdruck
    if (stack[stack.length - 1] === "`") {
      if (ch === "\\") i += 2;
      else if (ch === "`") {
        stack.pop();
        lastSignificant = "`";
        i++;
      } else if (ch === "$" && code[i + 1] === "{") {
        stack.push("${");
        i += 2;
      } else i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end < 0) return true;
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i++;
      while (i < n && code[i] !== ch && code[i] !== "\n") i += code[i] === "\\" ? 2 : 1;
      if (i >= n && code.endsWith("\\")) return true;
      i++;
      lastSignificant = ch;
      continue;
    }
    if (ch === "/" && (lastSignificant === "" || /[(,=:[!&|?{};+\-*%<>~^]$/.test(lastSignificant) || /\b(return|typeof|case|do|else|in|of|void|yield|await)$/.test(lastSignificant))) {
      // Regulärer Ausdruck
      i++;
      let inClass = false;
      while (i < n && code[i] !== "\n") {
        if (code[i] === "\\") i++;
        else if (code[i] === "[") inClass = true;
        else if (code[i] === "]") inClass = false;
        else if (code[i] === "/" && !inClass) break;
        i++;
      }
      i++;
      lastSignificant = "/";
      continue;
    }
    if (ch === "`") {
      stack.push("`");
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch === ")" || ch === "]" || ch === "}") {
      const open = stack.pop();
      if (open === undefined) return false; // Syntaxfehler – auswerten lassen
    }
    if (!/\s/.test(ch)) {
      const word = /^[\p{L}\p{N}_$]+/u.exec(code.slice(i));
      if (word) {
        lastSignificant = word[0];
        i += word[0].length;
        continue;
      }
      lastSignificant = ch;
    }
    i++;
  }
  return stack.length > 0;
}

/** Shell-Befehle mit Leerzeichen-Syntax (nur am Anfang einer neuen Eingabe). */
const SHELL_COMMAND = /^\s*(use|show|it|help|exit|quit|cls|\.exit)(?:\s+([^;]*?))?\s*;?\s*$/;

export interface ShellOptions {
  /** Ausgabe; Zeilentrenner "\n". */
  write(text: string): void;
  /** Bildschirm löschen. */
  clear?(): void;
  /** Ausgabe mit Farben. */
  colors?: boolean;
}

let active: MongoshSession | null = null;

export class MongoshSession {
  private readonly dbs = new Map<string, Database>();
  private current: Database;
  private lastCursor: AbstractCursor | null = null;
  private lines: string[] = [];
  private scripts = new Map<string, string>();
  quitRequested = false;

  constructor(
    readonly server: Server,
    private readonly options: ShellOptions,
    dbName = "test",
  ) {
    this.current = this.getDb(dbName);
    installGlobals();
    active = this;
  }

  /* ---------- Zustand ---------- */

  getDb(name: string): Database {
    validateDbName(name);
    let db = this.dbs.get(name);
    if (!db) this.dbs.set(name, (db = Database.create(this.server, name, (n) => this.getDb(n))));
    return db;
  }

  get db(): Database {
    return this.current;
  }

  set db(value: Database) {
    if (!(value instanceof Database)) throw new MongoshInvalidInputError("db must be a Database object");
    this.current = this.getDb(value.getName());
  }

  addScript(name: string, code: string): void {
    this.scripts.set(name, code);
  }

  get isEmpty(): boolean {
    return this.lines.length === 0;
  }

  prompt(): string {
    return this.lines.length ? "... " : `${this.current.getName()}> `;
  }

  resetBuffer(): void {
    this.lines = [];
  }

  /* ---------- Ausgabe ---------- */

  private out(text: string): void {
    this.options.write(text.endsWith("\n") ? text : text + "\n");
  }

  private show(value: unknown): void {
    this.out(inspect(value, { colors: this.options.colors ?? true }));
  }

  private printError(err: unknown, prefix = ""): void {
    let text: string;
    if (err instanceof MongoServerError && err.codeName) text = `MongoServerError[${err.codeName}]: ${err.message}`;
    else if (err instanceof Error) text = `${err.name}: ${err.message}`;
    else text = `Uncaught:\n${inspect(err, { topLevelStringsRaw: false })}`;
    this.out(RED(prefix + text));
  }

  /** Argumente wie print()/console.log ausgeben. */
  printArgs(args: unknown[], color?: (s: string) => string): void {
    const text = args.map((a) => inspect(a, { colors: this.options.colors ?? true })).join(" ");
    this.out(color ? color(text) : text);
  }

  private printCursorBatch(cursor: AbstractCursor): void {
    this.lastCursor = cursor;
    const { docs, more } = cursor.nextBatch(BATCH_SIZE);
    if (docs.length) this.show(docs);
    if (more) this.out('Type "it" for more');
  }

  private printResult(value: unknown): void {
    if (value === undefined) return;
    if (value instanceof AbstractCursor) {
      this.printCursorBatch(value);
      return;
    }
    this.show(value);
  }

  /* ---------- Shell-Befehle ---------- */

  use(name: unknown): ShellText {
    if (typeof name !== "string" || !name) throw new MongoshInvalidInputError("use requires a database name");
    validateDbName(name);
    if (name === this.current.getName()) return new ShellText(`already on db ${name}`);
    this.current = this.getDb(name);
    return new ShellText(`switched to db ${name}`);
  }

  showCommand(what: unknown): ShellText | unknown[] {
    const arg = String(what ?? "").trim();
    switch (arg) {
      case "dbs":
      case "databases": {
        const list = this.server.listDatabases();
        const w = Math.max(...list.map((d) => d.name.length));
        const sizes = list.map((d) => formatBytes(d.sizeOnDisk));
        const sw = Math.max(...sizes.map((s) => s.length));
        return new ShellText(list.map((d, i) => `${d.name.padEnd(w)}  ${sizes[i].padStart(sw)}`).join("\n"));
      }
      case "collections":
      case "tables":
        return new ShellText(this.current.getCollectionNames().join("\n"));
      case "users":
      case "roles":
        return [];
      case "profile":
        return new ShellText("db.system.profile is empty.\nUse db.setProfilingLevel(2) will enable profiling.");
      default:
        throw new MongoshInvalidInputError(`[COMMON-10001] '${arg}' is not a valid argument for "show".`);
    }
  }

  private it(): void {
    if (!this.lastCursor || this.lastCursor.isExhausted()) {
      this.out("no cursor");
      return;
    }
    this.printCursorBatch(this.lastCursor);
  }

  /** load("name"): Skript aus der Seite (erneut) ausführen. */
  load(name: unknown): boolean {
    const key = String(name).replace(/^\.?\//, "");
    const code = this.scripts.get(key);
    if (code === undefined) throw new Error(`ENOENT: no such file or directory, open '${key}'`);
    this.evaluateSync(code, true);
    return true;
  }

  /* ---------- Auswertung ---------- */

  /**
   * Führt JavaScript aus und gibt das Ergebnis zurück. "use x" am Zeilenanfang
   * (wie in mongosh-Skripten) wird zu use("x") umgeschrieben.
   */
  private evaluateSync(code: string, isScript: boolean): unknown {
    let src = isScript ? code.replace(/^(\s*)use\s+([^\s;()'"]+)\s*;?\s*$/gm, '$1use("$2");') : code;
    src = prepareSource(src);
    // { a: 1 } als Objekt, nicht als Block (wie die Node.js-REPL)
    if (!isScript && /^\s*\{/.test(src) && !/;\s*$/.test(src)) {
      try {
        new Function(`return (${src}\n)`);
        src = `(${src}\n)`;
      } catch {
        /* doch ein Block */
      }
    }
    const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    console.log = console.info = console.debug = (...a: unknown[]) => this.printArgs(a);
    console.warn = (...a: unknown[]) => this.printArgs(a, YELLOW);
    console.error = (...a: unknown[]) => this.printArgs(a, RED);
    try {
      try {
        return globalEval(src);
      } catch (err) {
        // Top-Level-await: Die Shell-API ist synchron, await ist daher wirkungslos.
        if (err instanceof SyntaxError && /await/.test(err.message)) return globalEval(src.replace(/\bawait\s+/g, ""));
        throw err;
      }
    } finally {
      Object.assign(console, saved);
    }
  }

  /** Startskripte: Ergebnisse werden nicht angezeigt, Fehler schon. */
  async runScript(name: string, code: string): Promise<boolean> {
    this.addScript(name, code);
    try {
      let r = this.evaluateSync(code, true);
      if (r instanceof Promise) r = await r;
      return true;
    } catch (err) {
      this.printError(err, `${name}: `);
      return false;
    }
  }

  /** Verarbeitet eine Eingabezeile der REPL. */
  async handleLine(line: string): Promise<"quit" | void> {
    if (this.lines.length === 0) {
      const m = SHELL_COMMAND.exec(line);
      if (m && (m[1] !== "it" || !m[2]) && (m[1] === "use" || m[1] === "show" || !m[2])) {
        try {
          switch (m[1]) {
            case "use":
              this.printResult(this.use(m[2]));
              return;
            case "show":
              this.printResult(this.showCommand(m[2]));
              return;
            case "it":
              this.it();
              return;
            case "help":
              this.out(GENERAL_HELP);
              return;
            case "cls":
              this.options.clear?.();
              return;
            default:
              return "quit";
          }
        } catch (err) {
          this.printError(err);
          return;
        }
      }
      if (!line.trim()) return;
    }

    this.lines.push(line);
    const code = this.lines.join("\n");
    if (isIncomplete(code)) return;
    this.lines = [];

    try {
      let result = this.evaluateSync(code, false);
      if (result instanceof Promise) result = await result;
      if (this.quitRequested) {
        this.quitRequested = false;
        return "quit";
      }
      this.printResult(result);
    } catch (err) {
      if (this.quitRequested) {
        this.quitRequested = false;
        return "quit";
      }
      this.printError(err);
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Globale Shell-Funktionen                                                  */
/* ------------------------------------------------------------------------ */

function session(): MongoshSession {
  if (!active) throw new Error("mongosh ist nicht gestartet");
  return active;
}

/** ObjectId() auch ohne new aufrufbar, instanceof funktioniert trotzdem. */
function makeCallable<T extends new (...args: never[]) => unknown>(cls: T): T {
  const fn = function (this: unknown, ...args: never[]) {
    return new cls(...args);
  } as unknown as T;
  Object.setPrototypeOf(fn, cls);
  (fn as { prototype: unknown }).prototype = cls.prototype;
  Object.defineProperty(fn, "name", { value: cls.name });
  return fn;
}

let installed = false;

function installGlobals(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as Record<string, unknown>;

  Object.defineProperty(globalThis, "db", {
    configurable: true,
    get: () => session().db,
    set: (v: Database) => (session().db = v),
  });

  const fns: Record<string, unknown> = {
    use: (name: string) => session().use(name),
    help: () => new ShellText(GENERAL_HELP),
    show: (what: string) => session().showCommand(what),
    print: (...args: unknown[]) => session().printArgs(args),
    printjson: (...args: unknown[]) => session().printArgs(args),
    load: (name: string) => session().load(name),
    exit: () => {
      session().quitRequested = true;
      throw new ExitSignal();
    },
    version: () => MONGOSH_VERSION,
    sleep: (ms: number) => {
      const end = Date.now() + Math.min(Number(ms) || 0, 5000);
      while (Date.now() < end) {
        /* warten */
      }
    },
    ObjectId: makeCallable(bson.ObjectId),
    ISODate: bson.ISODate,
    NumberInt: bson.NumberInt,
    NumberLong: bson.NumberLong,
    NumberDecimal: bson.NumberDecimal,
    Int32: bson.Int32,
    Long: bson.Long,
    Double: bson.Double,
    Decimal128: bson.Decimal128,
    tojson: (v: unknown) => inspect(v, { topLevelStringsRaw: false }),
  };
  fns.quit = fns.exit;
  fns.printjsononeline = fns.printjson;
  for (const [k, v] of Object.entries(fns)) {
    Object.defineProperty(g, k, { configurable: true, writable: true, value: v });
  }
}

class ExitSignal extends Error {
  override name = "ExitSignal";
}

export const BANNER = (logId: string) =>
  `Current Mongosh Log ID:\t${logId}\n` +
  `Connecting to:\t\tmongodb://127.0.0.1:27017/?directConnection=true&serverSelectionTimeoutMS=2000&appName=mongosh+${MONGOSH_VERSION}\n` +
  `Using MongoDB:\t\t${MONGODB_VERSION}\n` +
  `Using Mongosh:\t\t${MONGOSH_VERSION}\n\n` +
  `For mongosh info see: https://www.mongodb.com/docs/mongodb-shell/\n\n` +
  `\x1b[2mSimulation im Browser: Abfragen und Aggregationen laufen lokal mit mingo,\n` +
  `es gibt keinen echten MongoDB-Server. Daten liegen im Arbeitsspeicher.\x1b[0m\n`;

const GENERAL_HELP = `
  Shell Help:

    use                                        Set current database
    show                                       'show databases'/'show dbs': Print a list of all available databases.
                                               'show collections'/'show tables': Print a list of all collections for current database.
    exit                                       Quit the MongoDB shell with exit/exit()/.exit
    quit                                       Quit the MongoDB shell with quit/quit()
    it                                         result of the last line evaluated; use to further iterate
    cls                                        Clears the screen like console.clear()
    load                                       Loads and runs a script from the page (see <script type="text/mongosh">)
    print                                      Prints the contents of an object to the output
    printjson                                  Alias for print()
    sleep                                      Sleep for the specified number of milliseconds (max. 5000)
    version                                    Shell version

  Database Class:   db.help()
  Collection Class: db.<collection>.help()

  BSON: ObjectId(), ISODate(), NumberInt(), NumberLong(), NumberDecimal()

  Simulation: mingo (MongoDB query language for in-memory objects) – no real server.
`;

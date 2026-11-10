/**
 * Eine psql-Sitzung: verarbeitet Eingabezeilen (interaktiv, aus Dateien oder
 * von -c), führt SQL über PGlite aus und gibt Ergebnisse wie psql aus.
 */
import stringWidth from "string-width";
import type { Database, PgMessage, ResultSet } from "./database.js";
import { formatTable, isNumericType, type Column } from "./format.js";
import { parseMeta, SqlScanner } from "./scanner.js";

export interface PsqlSettings {
  format: "aligned" | "unaligned" | "csv";
  expanded: boolean | "auto";
  tuplesOnly: boolean;
  nullDisplay: string;
  fieldSep: string;
  timing: boolean;
  quiet: boolean;
  onErrorStop: boolean;
  echoQueries: boolean;
  /** Ergebnisse nicht ausgeben (für Startskripte), Fehler schon. */
  silent: boolean;
}

export const DEFAULT_SETTINGS: PsqlSettings = {
  format: "aligned",
  expanded: false,
  tuplesOnly: false,
  nullDisplay: "",
  fieldSep: "|",
  timing: false,
  quiet: false,
  onErrorStop: false,
  echoQueries: false,
  silent: false,
};

export interface PsqlIO {
  /** Ausgabe mit "\n" als Zeilentrenner. */
  out(text: string): void;
  err(text: string): void;
}

/** Minimales Dateisystem für \i und \w. */
export interface PsqlFiles {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface PsqlHost {
  fs: PsqlFiles;
  cwd: string;
  /** Führt einen Shell-Befehl aus (für \!). */
  exec?(command: string): Promise<{ stdout: string; stderr: string }>;
  /** Terminalbreite (für \x auto). */
  columns?(): number;
  history?: string[];
}

/** Abbruch nach Fehler bei ON_ERROR_STOP. */
export class StopError extends Error {}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Wandelt ein psql-Muster (z. B. "us*" oder public.t?) in einen regulären Ausdruck. */
function patternRegex(p: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '"') {
      if (quoted && p[i + 1] === '"') {
        out += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && ch === "*") out += ".*";
    else if (!quoted && ch === "?") out += ".";
    else {
      const c = quoted ? ch : ch.toLowerCase();
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return `^(${out})$`;
}

/** Teilt "schema.name" (Punkt außerhalb von "…"). */
function splitPattern(p: string): { schema?: string; name: string } {
  let quoted = false;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '"') quoted = !quoted;
    else if (p[i] === "." && !quoted) return { schema: p.slice(0, i), name: p.slice(i + 1) };
  }
  return { name: p };
}

const SQL_HELP: Record<string, string> = {
  SELECT:
    "Command:     SELECT\nDescription: retrieve rows from a table or view\nSyntax:\n[ WITH with_query [, ...] ]\nSELECT [ ALL | DISTINCT [ ON ( expression [, ...] ) ] ]\n    [ * | expression [ [ AS ] output_name ] [, ...] ]\n    [ FROM from_item [, ...] ]\n    [ WHERE condition ]\n    [ GROUP BY grouping_element [, ...] ]\n    [ HAVING condition ]\n    [ ORDER BY expression [ ASC | DESC ] [, ...] ]\n    [ LIMIT { count | ALL } ]\n    [ OFFSET start ]",
  INSERT:
    "Command:     INSERT\nDescription: create new rows in a table\nSyntax:\nINSERT INTO table_name [ AS alias ] [ ( column_name [, ...] ) ]\n    { DEFAULT VALUES | VALUES ( { expression | DEFAULT } [, ...] ) [, ...] | query }\n    [ ON CONFLICT [ conflict_target ] conflict_action ]\n    [ RETURNING * | output_expression [ [ AS ] output_name ] [, ...] ]",
  UPDATE:
    "Command:     UPDATE\nDescription: update rows of a table\nSyntax:\nUPDATE table_name [ * ] [ [ AS ] alias ]\n    SET { column_name = { expression | DEFAULT } } [, ...]\n    [ FROM from_item [, ...] ]\n    [ WHERE condition ]\n    [ RETURNING * | output_expression [ [ AS ] output_name ] [, ...] ]",
  DELETE:
    "Command:     DELETE\nDescription: delete rows of a table\nSyntax:\nDELETE FROM table_name [ * ] [ [ AS ] alias ]\n    [ USING from_item [, ...] ]\n    [ WHERE condition ]\n    [ RETURNING * | output_expression [ [ AS ] output_name ] [, ...] ]",
  "CREATE TABLE":
    "Command:     CREATE TABLE\nDescription: define a new table\nSyntax:\nCREATE [ TEMPORARY ] TABLE [ IF NOT EXISTS ] table_name ( [\n  { column_name data_type [ DEFAULT expr ] [ NOT NULL | NULL | UNIQUE | PRIMARY KEY\n      | REFERENCES reftable [ ( refcolumn ) ] | CHECK ( expression ) ] [ ... ]\n    | table_constraint }\n    [, ... ]\n] )",
  "DROP TABLE":
    "Command:     DROP TABLE\nDescription: remove a table\nSyntax:\nDROP TABLE [ IF EXISTS ] name [, ...] [ CASCADE | RESTRICT ]",
  "ALTER TABLE":
    "Command:     ALTER TABLE\nDescription: change the definition of a table\nSyntax:\nALTER TABLE [ IF EXISTS ] name\n    ADD [ COLUMN ] column_name data_type [ column_constraint [ ... ] ]\n  | DROP [ COLUMN ] [ IF EXISTS ] column_name [ RESTRICT | CASCADE ]\n  | ALTER [ COLUMN ] column_name [ SET DATA ] TYPE data_type\n  | RENAME [ COLUMN ] column_name TO new_column_name\n  | RENAME TO new_name\n  | ADD table_constraint",
  "CREATE INDEX":
    "Command:     CREATE INDEX\nDescription: define a new index\nSyntax:\nCREATE [ UNIQUE ] INDEX [ IF NOT EXISTS ] [ name ] ON table_name [ USING method ]\n    ( { column_name | ( expression ) } [ ASC | DESC ] [, ...] )\n    [ WHERE predicate ]",
  "CREATE VIEW":
    "Command:     CREATE VIEW\nDescription: define a new view\nSyntax:\nCREATE [ OR REPLACE ] VIEW name [ ( column_name [, ...] ) ]\n    AS query",
  BEGIN: "Command:     BEGIN\nDescription: start a transaction block\nSyntax:\nBEGIN [ WORK | TRANSACTION ] [ transaction_mode [, ...] ]",
  COMMIT: "Command:     COMMIT\nDescription: commit the current transaction\nSyntax:\nCOMMIT [ WORK | TRANSACTION ] [ AND [ NO ] CHAIN ]",
  ROLLBACK: "Command:     ROLLBACK\nDescription: abort the current transaction\nSyntax:\nROLLBACK [ WORK | TRANSACTION ] [ AND [ NO ] CHAIN ]",
};

const META_HELP = `General
  \\copyright             show PostgreSQL usage and distribution terms
  \\g                     execute query (and send result to server)
  \\h [NAME]              help on syntax of SQL commands
  \\q                     quit psql

Query Buffer
  \\p                     show the contents of the query buffer
  \\r                     reset (clear) the query buffer
  \\s                     display history
  \\w FILE                write query buffer to file

Input/Output
  \\echo [STRING]         write string to standard output
  \\i FILE                execute commands from file (Skripte der Seite, mit \\w gespeicherte Dateien)
  \\ir FILE               as \\i, but relative to location of current script
  \\qecho [STRING]        write string to standard output

Informational
  (options: S = show system objects, + = additional detail)
  \\d[S+]                 list tables, views, and sequences
  \\d[S+]  NAME           describe table, view, sequence, or index
  \\df[S]  [PATTERN]      list functions
  \\di[S]  [PATTERN]      list indexes
  \\dn     [PATTERN]      list schemas
  \\ds[S]  [PATTERN]      list sequences
  \\dt[S]  [PATTERN]      list tables
  \\du     [PATTERN]      list roles
  \\dv[S]  [PATTERN]      list views
  \\dx     [PATTERN]      list extensions
  \\l      [PATTERN]      list databases

Formatting
  \\a                     toggle between unaligned and aligned output mode
  \\pset [NAME [VALUE]]   set table output option (format, null, fieldsep, tuples_only, expanded)
  \\t [on|off]            show only rows
  \\x [on|off|auto]       toggle expanded output

Connection
  \\c[onnect] [DBNAME]    connect to database (in der Simulation nur "postgres")
  \\conninfo              display information about current connection
  \\encoding              show client encoding

Operating System
  \\timing [on|off]       toggle timing of commands

Variables
  \\set [NAME [VALUE]]    set internal variable, or list all if no parameters
  \\unset NAME            unset (delete) internal variable
`;

export class PsqlSession {
  readonly scanner = new SqlScanner();
  settings: PsqlSettings;
  private lastQuery = "";
  private vars = new Map<string, string>();
  errors = 0;
  database = "postgres";
  user = "postgres";

  constructor(
    private readonly db: Database,
    private readonly io: PsqlIO,
    private readonly host: PsqlHost,
    settings: Partial<PsqlSettings> = {},
  ) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.vars.set("ON_ERROR_STOP", this.settings.onErrorStop ? "on" : "off");
  }

  async init(): Promise<void> {
    const res = await this.db.rows("SELECT current_database(), current_user");
    if (res.rows[0]) {
      this.database = res.rows[0][0] ?? this.database;
      this.user = res.rows[0][1] ?? this.user;
    }
  }

  /** Prompt wie psql: "postgres=# ", "postgres-# ", "postgres=*# " … */
  prompt(): string {
    const tx = this.db.txStatus === "T" ? "*" : this.db.txStatus === "E" ? "!" : "";
    return `${this.database}${this.scanner.promptChar}${tx}# `;
  }

  // ───────────────────────────── Eingabe ─────────────────────────────

  /**
   * Verarbeitet eine Zeile. `source` gibt bei Dateien Name und Zeilenpräfix an.
   * Rückgabe "quit" bei \q.
   */
  async handleLine(line: string, source?: { file: string; scanner: SqlScanner }): Promise<"quit" | void> {
    const scanner = source?.scanner ?? this.scanner;
    for (const item of scanner.feedLine(line)) {
      if (item.type === "sql") {
        await this.execute(item.text, source ? `psql:${source.file}:${item.line}: ` : "");
      } else {
        const r = await this.meta(item.text, scanner, source);
        if (r === "quit") return "quit";
      }
    }
  }

  /** Verarbeitet einen ganzen Text (Datei, -c, Startskript). */
  async runText(text: string, file?: string): Promise<"quit" | void> {
    const scanner = new SqlScanner();
    const source = file ? { file, scanner } : undefined;
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      const r = source ? await this.handleLine(line, source) : await this.handleLineWith(scanner, line);
      if (r === "quit") return "quit";
    }
    // psql sendet am Dateiende auch eine Abfrage ohne abschließendes ";"
    if (scanner.buffer.trim()) {
      const sql = scanner.buffer;
      scanner.reset();
      await this.execute(sql, file ? `psql:${file}:${scanner.lineNo}: ` : "");
    }
  }

  private async handleLineWith(scanner: SqlScanner, line: string): Promise<"quit" | void> {
    for (const item of scanner.feedLine(line)) {
      if (item.type === "sql") await this.execute(item.text, "");
      else if ((await this.meta(item.text, scanner)) === "quit") return "quit";
    }
  }

  // ───────────────────────────── SQL ─────────────────────────────

  private out(text: string): void {
    this.io.out(text);
  }

  async execute(sql: string, errorPrefix = ""): Promise<boolean> {
    this.lastQuery = sql;
    if (this.settings.echoQueries) this.out(sql.replace(/\n$/, "") + "\n");
    const started = performance.now();
    const res = await this.db.query(sql);
    const elapsed = performance.now() - started;
    let ok = true;
    for (const item of res.items) {
      if (item.kind === "result") this.printResult(item.result);
      else if (item.kind === "notice") this.printMessage(item.notice, "", "");
      else {
        ok = false;
        this.errors++;
        this.printMessage(item.error, sql, errorPrefix);
      }
    }
    if (this.settings.timing) this.out(`Time: ${elapsed.toFixed(3)} ms\n`);
    if (!ok && this.settings.onErrorStop) throw new StopError();
    return ok;
  }

  private printResult(rs: ResultSet): void {
    if (this.settings.silent) return;
    if (rs.fields.length) {
      const columns: Column[] = rs.fields.map((f) => ({ name: f.name, numeric: isNumericType(f.typeId) }));
      this.printTable(columns, rs.rows);
      const tag = rs.tag ?? "";
      if (/^(INSERT|UPDATE|DELETE|MERGE)\b/.test(tag) && !this.settings.quiet) this.out(tag + "\n");
    } else if (rs.tag && !this.settings.quiet) {
      this.out(rs.tag + "\n");
    }
  }

  private printTable(columns: Column[], rows: (string | null)[][], extra: { title?: string; footers?: string[]; showRowCount?: boolean } = {}): void {
    const s = this.settings;
    if (s.format === "csv") {
      const q = (v: string | null) =>
        v === null ? "" : /[",\n\r]/.test(v) || v === "" ? `"${v.replace(/"/g, '""')}"` : v;
      let text = s.tuplesOnly ? "" : columns.map((c) => q(c.name)).join(",") + "\n";
      for (const r of rows) text += r.map(q).join(",") + "\n";
      this.out(text);
      return;
    }
    const base = {
      format: s.format,
      tuplesOnly: s.tuplesOnly,
      nullDisplay: s.nullDisplay,
      fieldSep: s.fieldSep,
      ...extra,
    };
    let expanded = s.expanded === true;
    let text = formatTable(columns, rows, { ...base, expanded });
    if (s.expanded === "auto" && s.format === "aligned" && this.host.columns) {
      const widest = Math.max(...text.split("\n").map((l) => stringWidth(l)));
      if (widest > this.host.columns()) {
        expanded = true;
        text = formatTable(columns, rows, { ...base, expanded });
      }
    }
    this.out(text);
    if (s.format === "aligned") this.out("\n");
  }

  private printMessage(m: PgMessage, sql: string, prefix: string): void {
    let text = `${prefix}${m.severity}:  ${m.message}\n`;
    if (m.position && sql) {
      const chars = Array.from(sql);
      const before = chars.slice(0, m.position - 1).join("");
      const lineIdx = before.split("\n").length - 1;
      const lineText = sql.split("\n")[lineIdx] ?? "";
      const col = before.slice(before.lastIndexOf("\n") + 1);
      const label = `LINE ${lineIdx + 1}: `;
      text += `${label}${lineText}\n${" ".repeat(stringWidth(label) + stringWidth(col))}^\n`;
    }
    if (m.detail) text += `DETAIL:  ${m.detail}\n`;
    if (m.hint) text += `HINT:  ${m.hint}\n`;
    if (m.where) text += `CONTEXT:  ${m.where}\n`;
    if (m.severity === "ERROR" || m.severity === "FATAL") this.io.err(text);
    else this.out(text);
  }

  // ───────────────────────────── Meta-Befehle ─────────────────────────────

  private async meta(text: string, scanner: SqlScanner, source?: { file: string; scanner: SqlScanner }): Promise<"quit" | void> {
    const { cmd, args } = parseMeta(text);
    const flag = (v: string | undefined, current: boolean) =>
      v === undefined ? !current : /^(on|true|1|yes)$/i.test(v);
    const say = (msg: string) => {
      if (!this.settings.quiet) this.out(msg + "\n");
    };
    const base = cmd.replace(/[S+]+$/, "");
    const plus = cmd.includes("+");
    const system = cmd.includes("S");

    switch (base) {
      case "q":
      case "quit":
        return "quit";
      case "?":
        this.out(META_HELP);
        return;
      case "h":
      case "help": {
        const topic = args.join(" ").toUpperCase().replace(/;$/, "");
        if (!topic) {
          this.out("Available help:\n  " + Object.keys(SQL_HELP).sort().join("\n  ") + "\n\n");
        } else if (SQL_HELP[topic]) {
          this.out(SQL_HELP[topic] + "\n\n");
        } else {
          this.out(`No help available for "${args.join(" ")}".\nTry \\h with no arguments to see available help.\n`);
        }
        return;
      }
      case "copyright":
        this.out(
          "PostgreSQL Database Management System\n(also known as Postgres, formerly known as Postgres95)\n\n" +
            "Portions Copyright (c) 1996-2025, PostgreSQL Global Development Group\n\n" +
            "In dieser Simulation läuft PostgreSQL über PGlite (https://pglite.dev) im Browser.\n",
        );
        return;
      case "g":
      case "gx": {
        const sql = scanner.buffer.trim() ? scanner.buffer : this.lastQuery;
        scanner.reset();
        if (!sql.trim()) return;
        const prevExpanded = this.settings.expanded;
        if (base === "gx") this.settings.expanded = true;
        try {
          await this.execute(sql, source ? `psql:${source.file}:${scanner.lineNo}: ` : "");
        } finally {
          this.settings.expanded = prevExpanded;
        }
        return;
      }
      case "r":
        scanner.reset();
        say("Query buffer reset (cleared).");
        return;
      case "p":
        if (scanner.buffer.trim()) this.out(scanner.buffer.replace(/\n?$/, "\n"));
        else if (this.lastQuery) this.out(this.lastQuery.replace(/\n?$/, "\n"));
        else this.out("Query buffer is empty.\n");
        return;
      case "s":
        for (const h of this.host.history ?? []) this.out(h + "\n");
        return;
      case "w": {
        if (!args[0]) return this.metaError("\\w: missing required argument");
        const content = scanner.buffer.trim() ? scanner.buffer : this.lastQuery;
        await this.host.fs.writeFile(this.resolve(args[0]), content);
        return;
      }
      case "echo":
      case "qecho":
        this.out(args.join(" ") + "\n");
        return;
      case "i":
      case "ir":
      case "include": {
        if (!args[0]) return this.metaError(`\\${cmd}: missing required argument`);
        const path = this.resolve(args[0]);
        let content: string;
        try {
          content = await this.host.fs.readFile(path);
        } catch {
          this.io.err(`${args[0]}: No such file or directory\n`);
          this.errors++;
          return;
        }
        return this.runText(content, args[0]);
      }
      case "e":
      case "edit":
        return this.metaError("\\e wird in der Simulation nicht unterstützt");
      case "!": {
        const command = text.replace(/^\\!\s*/, "");
        if (!this.host.exec) return this.metaError("\\!: in dieser Simulation gibt es keine Shell");
        if (!command.trim()) return this.metaError("\\!: eine interaktive Shell ist nicht verfügbar – nutze \\! befehl");
        const r = await this.host.exec(command);
        if (r.stdout) this.out(r.stdout);
        if (r.stderr) this.io.err(r.stderr);
        return;
      }
      case "timing":
        this.settings.timing = flag(args[0], this.settings.timing);
        say(`Timing is ${this.settings.timing ? "on" : "off"}.`);
        return;
      case "x": {
        const v = args[0];
        this.settings.expanded = v === "auto" ? "auto" : flag(v, this.settings.expanded === true);
        say(
          this.settings.expanded === "auto"
            ? "Expanded display is used automatically."
            : `Expanded display is ${this.settings.expanded ? "on" : "off"}.`,
        );
        return;
      }
      case "a":
        this.settings.format = this.settings.format === "aligned" ? "unaligned" : "aligned";
        say(`Output format is ${this.settings.format}.`);
        return;
      case "t":
        this.settings.tuplesOnly = flag(args[0], this.settings.tuplesOnly);
        say(`Tuples only is ${this.settings.tuplesOnly ? "on" : "off"}.`);
        return;
      case "f":
        if (args[0] !== undefined) this.settings.fieldSep = args[0];
        say(`Field separator is "${this.settings.fieldSep}".`);
        return;
      case "pset":
        return this.pset(args[0], args[1]);
      case "set":
        if (!args.length) {
          for (const [k, v] of this.vars) this.out(`${k} = '${v}'\n`);
        } else {
          const value = args.slice(1).join("");
          this.vars.set(args[0], value);
          if (args[0] === "ON_ERROR_STOP") this.settings.onErrorStop = /^(on|true|1)$/i.test(value);
        }
        return;
      case "unset":
        if (args[0]) {
          this.vars.delete(args[0]);
          if (args[0] === "ON_ERROR_STOP") this.settings.onErrorStop = false;
        }
        return;
      case "encoding":
        this.out("UTF8\n");
        return;
      case "c":
      case "connect": {
        const target = args[0] && args[0] !== "-" ? args[0] : this.database;
        if (target !== this.database) {
          this.io.err(
            `connection to server failed: FATAL:  database "${target}" is not available in this simulation\nPrevious connection kept\n`,
          );
          this.errors++;
          return;
        }
        this.out(`You are now connected to database "${this.database}" as user "${this.user}".\n`);
        return;
      }
      case "conninfo":
        this.out(`You are connected to database "${this.database}" as user "${this.user}" via PGlite (im Browser, ohne Netzwerk).\n`);
        return;
      case "l":
      case "list":
        return this.listDatabases();
      case "d":
        if (args[0]) return this.describe(args[0], plus, system);
        return this.listRelations(["r", "p", "v", "m", "S", "f"], undefined, system, "relations");
      case "dt":
        return this.listRelations(["r", "p"], args[0], system, "tables");
      case "dv":
        return this.listRelations(["v"], args[0], system, "views");
      case "dm":
        return this.listRelations(["m"], args[0], system, "materialized views");
      case "ds":
        return this.listRelations(["S"], args[0], system, "sequences");
      case "di":
        return this.listRelations(["i", "I"], args[0], system, "indexes");
      case "dn":
        return this.listSimple(
          "List of schemas",
          `SELECT n.nspname AS "Name", pg_catalog.pg_get_userbyid(n.nspowner) AS "Owner"
           FROM pg_catalog.pg_namespace n
           WHERE ${system ? "true" : "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'"}
           ${args[0] ? `AND n.nspname ~ ${lit(patternRegex(args[0]))}` : ""}
           ORDER BY 1`,
          "schemas",
          args[0],
        );
      case "du":
      case "dg":
        return this.listSimple(
          "List of roles",
          `SELECT r.rolname AS "Role name",
             pg_catalog.array_to_string(ARRAY[
               CASE WHEN r.rolsuper THEN 'Superuser' END,
               CASE WHEN r.rolcreaterole THEN 'Create role' END,
               CASE WHEN r.rolcreatedb THEN 'Create DB' END,
               CASE WHEN r.rolreplication THEN 'Replication' END,
               CASE WHEN r.rolbypassrls THEN 'Bypass RLS' END,
               CASE WHEN NOT r.rolcanlogin THEN 'Cannot login' END], ', ') AS "Attributes"
           FROM pg_catalog.pg_roles r
           WHERE r.rolname !~ '^pg_' ${args[0] ? `AND r.rolname ~ ${lit(patternRegex(args[0]))}` : ""}
           ORDER BY 1`,
          "roles",
          args[0],
          false,
        );
      case "df":
        return this.listSimple(
          "List of functions",
          `SELECT n.nspname AS "Schema", p.proname AS "Name",
             pg_catalog.pg_get_function_result(p.oid) AS "Result data type",
             pg_catalog.pg_get_function_arguments(p.oid) AS "Argument data types",
             CASE p.prokind WHEN 'a' THEN 'agg' WHEN 'w' THEN 'window' WHEN 'p' THEN 'proc' ELSE 'func' END AS "Type"
           FROM pg_catalog.pg_proc p LEFT JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE pg_catalog.pg_function_is_visible(p.oid)
             ${system ? "" : "AND n.nspname <> 'pg_catalog' AND n.nspname <> 'information_schema'"}
             ${args[0] ? `AND p.proname ~ ${lit(patternRegex(args[0]))}` : ""}
           ORDER BY 1, 2, 4`,
          "functions",
          args[0],
        );
      case "dx":
        return this.listSimple(
          "List of installed extensions",
          `SELECT e.extname AS "Name", e.extversion AS "Version", n.nspname AS "Schema",
             c.description AS "Description"
           FROM pg_catalog.pg_extension e
           LEFT JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
           LEFT JOIN pg_catalog.pg_description c ON c.objoid = e.oid AND c.classoid = 'pg_catalog.pg_extension'::pg_catalog.regclass
           ${args[0] ? `WHERE e.extname ~ ${lit(patternRegex(args[0]))}` : ""}
           ORDER BY 1`,
          "extensions",
          args[0],
        );
      default:
        this.io.err(`invalid command \\${cmd}\nTry \\? for help.\n`);
        this.errors++;
    }
  }

  private metaError(msg: string): void {
    this.io.err(msg + "\n");
    this.errors++;
  }

  private resolve(path: string): string {
    const raw = path.startsWith("/") ? path : path.startsWith("~/") ? `/home/user/${path.slice(2)}` : `${this.host.cwd}/${path}`;
    const parts: string[] = [];
    for (const p of raw.split("/")) {
      if (!p || p === ".") continue;
      if (p === "..") parts.pop();
      else parts.push(p);
    }
    return "/" + parts.join("/");
  }

  private pset(name?: string, value?: string): void {
    const s = this.settings;
    const say = (m: string) => this.out(m + "\n");
    switch (name) {
      case undefined:
        say(`expanded                 ${s.expanded === "auto" ? "auto" : s.expanded ? "on" : "off"}`);
        say(`fieldsep                 '${s.fieldSep}'`);
        say(`format                   ${s.format}`);
        say(`null                     '${s.nullDisplay}'`);
        say(`tuples_only              ${s.tuplesOnly ? "on" : "off"}`);
        return;
      case "format":
        if (value && ["aligned", "unaligned", "csv"].includes(value)) s.format = value as PsqlSettings["format"];
        else if (value) return this.metaError("\\pset: allowed formats are aligned, csv, unaligned");
        say(`Output format is ${s.format}.`);
        return;
      case "null":
        if (value !== undefined) s.nullDisplay = value;
        say(`Null display is "${s.nullDisplay}".`);
        return;
      case "fieldsep":
        if (value !== undefined) s.fieldSep = value;
        say(`Field separator is "${s.fieldSep}".`);
        return;
      case "tuples_only":
        s.tuplesOnly = value === undefined ? !s.tuplesOnly : /^(on|true|1)$/i.test(value);
        say(`Tuples only is ${s.tuplesOnly ? "on" : "off"}.`);
        return;
      case "expanded":
      case "x":
        s.expanded = value === "auto" ? "auto" : value === undefined ? !(s.expanded === true) : /^(on|true|1)$/i.test(value);
        say(s.expanded === "auto" ? "Expanded display is used automatically." : `Expanded display is ${s.expanded ? "on" : "off"}.`);
        return;
      case "border":
      case "pager":
      case "linestyle":
        return;
      default:
        this.metaError(`\\pset: unknown option: ${name}`);
    }
  }

  // ───────────────────────────── Katalog ─────────────────────────────

  private async listSimple(title: string, sql: string, what: string, pattern?: string, rowCount = true): Promise<void> {
    const rs = await this.db.rows(sql);
    if (!rs.rows.length) {
      this.io.err(pattern ? `Did not find any ${what.replace(/s$/, "")} named "${pattern}".\n` : `Did not find any ${what}.\n`);
      return;
    }
    const columns = rs.fields.map((f) => ({ name: f.name, numeric: isNumericType(f.typeId) }));
    this.printTable(columns, rs.rows, { title, showRowCount: rowCount });
  }

  private async listDatabases(): Promise<void> {
    await this.listSimple(
      "List of databases",
      `SELECT d.datname AS "Name", pg_catalog.pg_get_userbyid(d.datdba) AS "Owner",
         pg_catalog.pg_encoding_to_char(d.encoding) AS "Encoding",
         d.datcollate AS "Collate", d.datctype AS "Ctype",
         pg_catalog.array_to_string(d.datacl, E'\\n') AS "Access privileges"
       FROM pg_catalog.pg_database d ORDER BY 1`,
      "databases",
    );
  }

  private relationFilter(pattern?: string, system = false): string {
    let where = system
      ? "true"
      : "n.nspname <> 'pg_catalog' AND n.nspname !~ '^pg_toast' AND n.nspname <> 'information_schema'";
    if (pattern) {
      const { schema, name } = splitPattern(pattern);
      where += ` AND c.relname OPERATOR(pg_catalog.~) ${lit(patternRegex(name))} COLLATE pg_catalog.default`;
      if (schema) where += ` AND n.nspname OPERATOR(pg_catalog.~) ${lit(patternRegex(schema))} COLLATE pg_catalog.default`;
      else where += " AND pg_catalog.pg_table_is_visible(c.oid)";
    } else {
      where += " AND pg_catalog.pg_table_is_visible(c.oid)";
    }
    return where;
  }

  private async listRelations(kinds: string[], pattern: string | undefined, system: boolean, what: string): Promise<void> {
    const isIndex = kinds.includes("i");
    const sql = `SELECT n.nspname AS "Schema", c.relname AS "Name",
        CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
          WHEN 'i' THEN 'index' WHEN 'S' THEN 'sequence' WHEN 't' THEN 'TOAST table'
          WHEN 'f' THEN 'foreign table' WHEN 'p' THEN 'partitioned table' WHEN 'I' THEN 'partitioned index' END AS "Type",
        pg_catalog.pg_get_userbyid(c.relowner) AS "Owner"
        ${isIndex ? `, c2.relname AS "Table"` : ""}
      FROM pg_catalog.pg_class c
      LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      ${isIndex ? "LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid LEFT JOIN pg_catalog.pg_class c2 ON i.indrelid = c2.oid" : ""}
      WHERE c.relkind IN (${kinds.map(lit).join(", ")}) AND ${this.relationFilter(pattern, system)}
      ORDER BY 1, 2`;
    const rs = await this.db.rows(sql);
    if (!rs.rows.length) {
      this.io.err(
        pattern ? `Did not find any relation named "${pattern}".\n` : `Did not find any ${what}.\n`,
      );
      return;
    }
    const columns = rs.fields.map((f) => ({ name: f.name }));
    this.printTable(columns, rs.rows, { title: "List of relations" });
  }

  private async describe(pattern: string, plus: boolean, system: boolean): Promise<void> {
    const rels = await this.db.rows(
      `SELECT c.oid, n.nspname, c.relname, c.relkind FROM pg_catalog.pg_class c
       LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE ${this.relationFilter(pattern, true)} ORDER BY 2, 3`,
    );
    if (!rels.rows.length) {
      this.io.err(`Did not find any relation named "${pattern}".\n`);
      return;
    }
    void system;
    for (const [oid, schema, name, kind] of rels.rows) {
      await this.describeRelation(oid!, schema!, name!, kind!, plus);
    }
  }

  private async describeRelation(oid: string, schema: string, name: string, kind: string, plus: boolean): Promise<void> {
    const full = `"${schema}.${name}"`;
    const kindTitle: Record<string, string> = {
      r: "Table",
      p: "Partitioned table",
      v: "View",
      m: "Materialized view",
      S: "Sequence",
      i: "Index",
      I: "Partitioned index",
      f: "Foreign table",
    };
    const title = `${kindTitle[kind] ?? "Relation"} ${full}`;

    if (kind === "S") {
      const rs = await this.db.rows(
        `SELECT pg_catalog.format_type(s.seqtypid, NULL) AS "Type", s.seqstart AS "Start", s.seqmin AS "Minimum",
           s.seqmax AS "Maximum", s.seqincrement AS "Increment",
           CASE WHEN s.seqcycle THEN 'yes' ELSE 'no' END AS "Cycles?", s.seqcache AS "Cache"
         FROM pg_catalog.pg_sequence s WHERE s.seqrelid = ${lit(oid)}`,
      );
      const owned = await this.db.rows(
        `SELECT pg_catalog.quote_ident(nspname) || '.' || pg_catalog.quote_ident(relname) || '.' || pg_catalog.quote_ident(attname)
         FROM pg_catalog.pg_class c
         INNER JOIN pg_catalog.pg_depend d ON c.oid = d.refobjid
         INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         INNER JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.refobjsubid
         WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
           AND d.objid = ${lit(oid)} AND d.deptype IN ('a', 'i')`,
      );
      const footers = owned.rows[0]?.[0] ? [`Owned by: ${owned.rows[0][0]}`] : [];
      const columns = rs.fields.map((f) => ({ name: f.name, numeric: isNumericType(f.typeId) }));
      this.printTable(columns, rs.rows, { title, footers, showRowCount: false });
      return;
    }

    const cols = await this.db.rows(
      `SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
         (SELECT c.collname FROM pg_catalog.pg_collation c, pg_catalog.pg_type t
          WHERE c.oid = a.attcollation AND t.oid = a.atttypid AND a.attcollation <> t.typcollation),
         CASE WHEN a.attnotnull THEN 'not null' ELSE '' END,
         CASE WHEN a.attidentity = 'a' THEN 'generated always as identity'
              WHEN a.attidentity = 'd' THEN 'generated by default as identity'
              WHEN a.attgenerated = 's' THEN 'generated always as (' || pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) || ') stored'
              ELSE pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) END
       FROM pg_catalog.pg_attribute a
       LEFT JOIN pg_catalog.pg_attrdef d ON (a.attrelid = d.adrelid AND a.attnum = d.adnum AND a.atthasdef)
       WHERE a.attrelid = ${lit(oid)} AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
    );

    if (kind === "i" || kind === "I") {
      const info = await this.db.rows(
        `SELECT i.indisprimary, i.indisunique, am.amname, n.nspname, t.relname, pg_catalog.pg_get_indexdef(i.indexrelid, 0, true)
         FROM pg_catalog.pg_index i
         JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
         JOIN pg_catalog.pg_am am ON am.oid = c.relam
         WHERE i.indexrelid = ${lit(oid)}`,
      );
      const [pk, uniq, am, tschema, tname] = info.rows[0] ?? [];
      const footer = `${pk === "t" ? "primary key, " : uniq === "t" ? "unique, " : ""}${am}, for table "${tschema}.${tname}"`;
      this.printTable(
        [{ name: "Column" }, { name: "Type" }, { name: "Key?" }, { name: "Definition" }],
        cols.rows.map((r) => [r[0], r[1], "yes", r[0]]),
        { title, footers: [footer], showRowCount: false },
      );
      return;
    }

    const footers: string[] = [];
    if (kind === "r" || kind === "p" || kind === "m") {
      const idx = await this.db.rows(
        `SELECT c2.relname, i.indisprimary, i.indisunique, pg_catalog.pg_get_indexdef(i.indexrelid, 0, true), con.contype
         FROM pg_catalog.pg_class c, pg_catalog.pg_class c2, pg_catalog.pg_index i
         LEFT JOIN pg_catalog.pg_constraint con ON (con.conrelid = i.indrelid AND con.conindid = i.indexrelid AND con.contype IN ('p','u','x'))
         WHERE c.oid = ${lit(oid)} AND c.oid = i.indrelid AND i.indexrelid = c2.oid
         ORDER BY i.indisprimary DESC, c2.relname`,
      );
      if (idx.rows.length) {
        footers.push("Indexes:");
        for (const [iname, pk, uniq, def, contype] of idx.rows) {
          const using = def?.replace(/^.*? USING /, "") ?? "";
          const label = pk === "t" ? " PRIMARY KEY," : uniq === "t" ? (contype === "u" ? " UNIQUE CONSTRAINT," : " UNIQUE,") : "";
          footers.push(`    "${iname}"${label} ${using}`);
        }
      }
      const cons = await this.db.rows(
        `SELECT conname, contype, pg_catalog.pg_get_constraintdef(oid, true)
         FROM pg_catalog.pg_constraint WHERE conrelid = ${lit(oid)} AND contype IN ('c', 'f') ORDER BY contype, conname`,
      );
      const checks = cons.rows.filter((r) => r[1] === "c");
      const fks = cons.rows.filter((r) => r[1] === "f");
      if (checks.length) {
        footers.push("Check constraints:");
        for (const [cname, , def] of checks) footers.push(`    "${cname}" ${def}`);
      }
      if (fks.length) {
        footers.push("Foreign-key constraints:");
        for (const [cname, , def] of fks) footers.push(`    "${cname}" ${def}`);
      }
      const refs = await this.db.rows(
        `SELECT conrelid::pg_catalog.regclass, conname, pg_catalog.pg_get_constraintdef(oid, true)
         FROM pg_catalog.pg_constraint WHERE confrelid = ${lit(oid)} AND contype = 'f' ORDER BY 1, 2`,
      );
      if (refs.rows.length) {
        footers.push("Referenced by:");
        for (const [t, cname, def] of refs.rows) footers.push(`    TABLE "${t}" CONSTRAINT "${cname}" ${def}`);
      }
    }
    if ((kind === "v" || kind === "m") && plus) {
      const def = await this.db.rows(`SELECT pg_catalog.pg_get_viewdef(${lit(oid)}::pg_catalog.oid, true)`);
      footers.push("View definition:");
      for (const l of (def.rows[0]?.[0] ?? "").split("\n")) footers.push(l);
    }
    this.printTable(
      [{ name: "Column" }, { name: "Type" }, { name: "Collation" }, { name: "Nullable" }, { name: "Default" }],
      cols.rows,
      { title, footers, showRowCount: false },
    );
  }
}

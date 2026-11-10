import type { Bash, CustomCommand, NetworkConfig } from "just-bash";
import stringWidth from "string-width";
import { LineReader, type LineResult, type ReadLineOptions } from "./line-reader.js";
import {
  NanoEditor,
  NANO_USAGE,
  NANO_VERSION,
  parseNanoArgs,
  splitArgs,
} from "./nano.js";
import {
  EDITMSG_MARKER,
  EDITMSG_PREPARE,
  EDITMSG_USE,
  needsCommitEditor,
  runGit,
} from "./git/index.js";

export type { NetworkConfig } from "just-bash";
export { NanoEditor } from "./nano.js";
export type { NanoHost, NanoOptions } from "./nano.js";
import type { NanoOptions } from "./nano.js";
export { runGit } from "./git/index.js";
export { LineReader } from "./line-reader.js";
export type { LineResult, ReadLineOptions } from "./line-reader.js";

/** Kontext für interaktive Programme, die das Terminal übernehmen (z. B. eine REPL). */
export interface InteractiveCommandContext {
  /** Argumente ohne den Befehlsnamen. */
  args: string[];
  /** Aufgerufener Befehlsname (z. B. "python3"). */
  name: string;
  cwd: string;
  /** Exportierte Umgebungsvariablen (inkl. Zuweisungen wie `X=1 python`). */
  env: Record<string, string>;
  bash: Bash;
  write(data: string): void;
  size(): { cols: number; rows: number };
  /** Liest eine Zeile mit Zeileneditor vom Terminal. */
  readLine(options?: ReadLineOptions): Promise<LineResult>;
  /**
   * Leitet Terminaleingaben, die außerhalb von readLine() ankommen (z. B.
   * Strg+C während einer Berechnung), an das Programm weiter.
   */
  onInput(handler: ((data: string) => void) | null): void;
}

export interface InteractiveCommand {
  /** Befehlsname(n), z. B. ["python", "python3"]. */
  names: string[];
  /**
   * Ob der eigenständige Aufruf interaktiv laufen soll. Bei false wird der
   * Befehl normal über just-bash (z. B. als customCommand) ausgeführt.
   */
  accepts?(args: string[]): boolean;
  /** Führt das Programm aus; Rückgabewert ist der Exit-Code. */
  run(ctx: InteractiveCommandContext): Promise<number | void>;
}

export interface ShellOptions {
  files?: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
  greeting?: string | string[];
  prompt?: (cwd: string) => string;
  network?: NetworkConfig;
  /** Liefert die aktuelle Terminalgröße (für Vollbild-Programme wie nano). */
  getSize?: () => { cols: number; rows: number };
  /** Zusätzliche just-bash-Befehle (laufen auch in Pipes und Skripten). */
  customCommands?: CustomCommand[];
  /** Programme, die bei eigenständigem Aufruf das Terminal übernehmen. */
  interactiveCommands?: InteractiveCommand[];
}

/** Interner Befehl, der den Variablenzustand nach jeder Befehlszeile sichert. */
const ENV_SNAPSHOT_COMMAND = "__wterm_env_snapshot";

/** Variablen, die die Shell selbst verwaltet und nicht übernommen werden. */
const VOLATILE_VARS = new Set([
  "_",
  "PWD",
  "IFS",
  "OPTIND",
  "OPTARG",
  "SHELLOPTS",
  "BASHOPTS",
  "PPID",
  "UID",
  "EUID",
  "RANDOM",
  "SRANDOM",
  "LINENO",
  "SECONDS",
  "FUNCNAME",
  "PIPESTATUS",
  "GROUPS",
  "HISTCMD",
  "EPOCHSECONDS",
  "EPOCHREALTIME",
  "REPLY",
]);

function isPersistentVar(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !VOLATILE_VARS.has(name) && !name.startsWith("BASH");
}

function defaultPrompt(cwd: string): string {
  const display = cwd.replace(/^\/home\/user/, "~") || "/";
  return `\x1b[1;32muser@wterm\x1b[0m:\x1b[1;34m${display}\x1b[0m$ `;
}

const WORD_LEFT_SEQUENCES = new Set(["\x1b[1;3D", "\x1b[1;5D", "\x1bb"]);
const WORD_RIGHT_SEQUENCES = new Set(["\x1b[1;3C", "\x1b[1;5C", "\x1bf"]);
const WORD_ERASE_SEQUENCES = new Set(["\x1b\x7f", "\x1b\b", "\x17"]);
const HOME_SEQUENCES = new Set(["\x1b[H", "\x1bOH"]);
const END_SEQUENCES = new Set(["\x1b[F", "\x1bOF"]);
const SEARCH_EDIT_SEQUENCES = new Set([
  "\x1b[D",
  "\x1b[C",
  "\x01",
  "\x05",
  ...HOME_SEQUENCES,
  ...END_SEQUENCES,
  ...WORD_LEFT_SEQUENCES,
  ...WORD_RIGHT_SEQUENCES,
]);
const PRINTABLE_TEXT = /^[^\p{Cc}]+$/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface HistorySearch {
  query: string;
  index: number;
  direction: -1 | 1;
  draft: { line: string; cursor: number };
}

function previousGraphemeStart(line: string, cursor: number): number {
  return graphemes.segment(line).containing(cursor - 1)?.index ?? 0;
}

function nextGraphemeEnd(line: string, cursor: number): number {
  const next = graphemes.segment(line).containing(cursor);
  return next ? next.index + next.segment.length : line.length;
}

export class BashShell {
  private _bash: Bash | null = null;
  private _write: ((data: string) => void) | null = null;
  private _cwd: string;
  private _line = "";
  // UTF-16 offset in _line; terminal cursor motion uses cell widths.
  private _cursor = 0;
  private _buffer = "";
  private _history: string[] = [];
  private _historyPos = -1;
  private _historyDraft: { line: string; cursor: number } | null = null;
  private _historySearch: HistorySearch | null = null;
  private _killBuffer = "";
  private _lastActionWasKill = false;
  private _inputRevision = 0;
  private _busy = false;
  private _execAbort: AbortController | null = null;

  private _files: Record<string, string>;
  private _env: Record<string, string>;
  private _greeting: string[];
  private _prompt: (cwd: string) => string;
  private _network?: NetworkConfig;
  private _getSize: () => { cols: number; rows: number };
  private _nano: NanoEditor | null = null;
  /** Shell-Variablen und exportierte Namen zwischen Befehlszeilen. */
  private _vars: Record<string, string> = {};
  private _exported = new Set<string>();
  private _envCaptured = false;
  private _lastStatus = 0;
  private _customCommands: CustomCommand[];
  private _interactive: InteractiveCommand[];
  /** Aktiver Zeileneditor eines interaktiven Programms. */
  private _reader: LineReader | null = null;
  /** Eingabe-Handler eines interaktiven Programms außerhalb von readLine(). */
  private _programInput: ((data: string) => void) | null = null;
  private _programActive = false;
  /** Eingaben, die nach einer abgeschlossenen Zeile übrig blieben (Einfügen). */
  private _pendingInput = "";

  constructor(options: ShellOptions = {}) {
    this._files = options.files ?? {};
    // HOME/USER werden u. a. von git (~/.gitconfig) benötigt.
    this._env = {
      HOME: "/home/user",
      USER: "user",
      ...(options.env ?? { SHELL: "/bin/bash", TERM: "xterm-256color" }),
    };
    this._cwd = options.cwd ?? "/home/user";
    this._prompt = options.prompt ?? defaultPrompt;
    this._network = options.network;
    this._getSize = options.getSize ?? (() => ({ cols: 80, rows: 24 }));
    this._customCommands = options.customCommands ?? [];
    this._interactive = options.interactiveCommands ?? [];

    if (options.greeting === undefined) {
      this._greeting = [];
    } else if (typeof options.greeting === "string") {
      this._greeting = [options.greeting];
    } else {
      this._greeting = options.greeting;
    }
  }

  get cwd(): string {
    return this._cwd;
  }

  get bash(): Bash | null {
    return this._bash;
  }

  private _updateCwd(env?: Record<string, string>): void {
    const cwd = env?.PWD;
    if (cwd?.startsWith("/")) {
      this._cwd = cwd;
    }
  }

  /** Shell-Variablen der Sitzung (bleiben zwischen Befehlszeilen erhalten). */
  get variables(): Readonly<Record<string, string>> {
    return { ...this._vars };
  }

  /** Exportierte Variablen (die Umgebung für Programme). */
  get environment(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of this._exported) {
      if (name in this._vars) env[name] = this._vars[name];
    }
    env.PWD = this._cwd;
    return env;
  }

  /** Übernimmt den Variablenzustand am Ende einer Befehlszeile. */
  private _captureEnv(all: Map<string, string>, exported: Record<string, string> | undefined): void {
    const vars: Record<string, string> = {};
    for (const [name, value] of all) {
      if (isPersistentVar(name)) vars[name] = value;
    }
    this._vars = vars;
    this._exported = new Set(Object.keys(exported ?? {}).filter((n) => isPersistentVar(n)));
  }

  /** Optionen für bash.exec mit dem gemerkten Variablenzustand. */
  private _execOptions(): { cwd: string; env: Record<string, string>; replaceEnv?: boolean } {
    if (!this._envCaptured) return { cwd: this._cwd, env: { PWD: this._cwd } };
    return { cwd: this._cwd, env: { ...this._vars, PWD: this._cwd }, replaceEnv: true };
  }

  /**
   * Stellt den Export-Status wieder her und hängt bei Bedarf den internen
   * Befehl an, der den Variablenzustand nach der Zeile sichert.
   */
  private _wrapCommand(cmd: string, capture: boolean): string {
    const names = [...this._exported].filter((n) => n in this._vars);
    let prefix = names.length ? `export ${names.join(" ")}; ` : "";
    // $? der vorherigen Zeile wiederherstellen
    if (this._lastStatus !== 0) prefix += `(exit ${this._lastStatus}); `;
    return capture ? `${prefix}${cmd}\n${ENV_SNAPSHOT_COMMAND} $?` : `${prefix}${cmd}`;
  }

  async attach(write: (data: string) => void): Promise<void> {
    this._write = write;

    const { Bash, defineCommand } = await import("just-bash");
    this._bash = new Bash({
      files: this._files,
      env: this._env,
      network: this._network,
      customCommands: [
        // Innerhalb von Pipelines/Skripten kann nano nicht interaktiv laufen.
        defineCommand("nano", async (args) => {
          const parsed = parseNanoArgs(args);
          if (parsed.help) return { stdout: NANO_USAGE, stderr: "", exitCode: 0 };
          if (parsed.version) return { stdout: NANO_VERSION, stderr: "", exitCode: 0 };
          return {
            stdout: "",
            stderr:
              "nano: kann nur interaktiv als eigenständiger Befehl gestartet werden\n",
            exitCode: 1,
          };
        }),
        // git (isomorphic-git) auf dem virtuellen Dateisystem – nur lokal.
        defineCommand("git", async (args, ctx) =>
          runGit(args, { fs: ctx.fs, cwd: ctx.cwd, env: ctx.env }),
        ),
        ...this._customCommands,
        // intern: sichert Variablen + Export-Status am Ende jeder Befehlszeile
        defineCommand(ENV_SNAPSHOT_COMMAND, async (args, ctx) => {
          this._captureEnv(ctx.env, ctx.exportedEnv);
          this._envCaptured = true;
          return { stdout: "", stderr: "", exitCode: parseInt(args[0] ?? "0", 10) || 0 };
        }),
      ],
    });
    // Anfangszustand der Variablen erfassen
    await this._bash.exec(ENV_SNAPSHOT_COMMAND, { cwd: this._cwd });

    if (this._greeting.length > 0) {
      write(this._greeting.join("\r\n") + "\r\n");
    }
    write(this._prompt(this._cwd));
  }

  /** Aktiver nano-Editor (oder null). */
  get nano(): NanoEditor | null {
    return this._nano;
  }

  /** Muss bei Größenänderungen des Terminals aufgerufen werden. */
  resize(): void {
    this._nano?.resize();
  }

  private _resolvePath(path: string): string {
    let p = path;
    if (p === "~") p = "/home/user";
    else if (p.startsWith("~/")) p = "/home/user/" + p.slice(2);
    if (!p.startsWith("/")) p = `${this._cwd}/${p}`;
    const parts: string[] = [];
    for (const part of p.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return "/" + parts.join("/");
  }

  /**
   * Startet nano, wenn die Kommandozeile ein eigenständiger nano-Aufruf ist.
   * Liefert true, wenn der Befehl übernommen wurde.
   */
  private async _tryStartNano(cmd: string): Promise<boolean> {
    const trimmed = cmd.trim();
    if (!/^nano(\s|$)/.test(trimmed)) return false;
    // Mit Shell-Operatoren (Pipes, Umleitungen, Verkettung, Substitution)
    // übernimmt just-bash; dort meldet nano einen Fehler.
    if (/[|&;<>`$()]/.test(trimmed.replace(/'[^']*'|"[^"$`]*"/g, ""))) return false;
    const args = splitArgs(trimmed);
    if (!args) return false;
    const parsed = parseNanoArgs(args.slice(1));
    if (parsed.help || parsed.version || parsed.error) return false;

    await this._openNano(parsed.options);
    return true;
  }

  /**
   * Öffnet nano. `afterExit` läuft nach dem Schließen, bevor der Prompt
   * wieder erscheint (z. B. um einen Commit abzuschließen).
   */
  private async _openNano(
    options: NanoOptions,
    afterExit?: () => Promise<void>,
  ): Promise<void> {
    const bash = this._bash!;
    const write = this._write!;
    const editor = new NanoEditor(
      {
        write,
        size: this._getSize,
        resolvePath: (p) => this._resolvePath(p),
        readFile: async (p) => {
          if (!(await bash.fs.exists(p))) return null;
          return bash.readFile(p);
        },
        writeFile: (p, content) => bash.writeFile(p, content),
        isDirectory: async (p) => {
          try {
            return (await bash.fs.stat(p)).isDirectory;
          } catch {
            return false;
          }
        },
      },
      options,
    );
    this._nano = editor;
    this._busy = true;
    editor.onExit = () => {
      this._nano = null;
      void (async () => {
        try {
          await afterExit?.();
        } finally {
          this._busy = false;
          write(this._prompt(this._cwd));
        }
      })();
    };
    try {
      await editor.open();
    } catch (err) {
      this._nano = null;
      this._busy = false;
      const msg = err instanceof Error ? err.message : String(err);
      write(`\x1b[31mnano: ${msg}\x1b[0m\r\n`);
      write(this._prompt(this._cwd));
    }
  }

  private _writeResult(result: { stdout?: string; stderr?: string }): void {
    const write = this._write!;
    if (result.stdout) {
      write(result.stdout.replace(/\n/g, "\r\n"));
      if (!result.stdout.endsWith("\n")) write("\r\n");
    }
    if (result.stderr) {
      write(`\x1b[31m${result.stderr.replace(/\n/g, "\r\n")}\x1b[0m`);
      if (!result.stderr.endsWith("\n")) write("\r\n");
    }
  }

  /**
   * `git commit` ohne Nachricht: Commit-Nachricht in nano bearbeiten,
   * danach den Commit abschließen (wie mit core.editor=nano).
   */
  /** Startet ein registriertes interaktives Programm bei eigenständigem Aufruf. */
  private async _tryInteractive(cmd: string): Promise<boolean> {
    if (!this._interactive.length) return false;
    const trimmed = cmd.trim();
    if (/[|&;<>`$()]/.test(trimmed.replace(/'[^']*'|"[^"$`]*"/g, ""))) return false;
    const argv = splitArgs(trimmed);
    if (!argv || !argv.length) return false;
    // Vorangestellte Zuweisungen (X=1 Y=2 programm) gelten nur für das Programm
    const env = this.environment;
    while (argv.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
      const assignment = argv.shift()!;
      const eq = assignment.indexOf("=");
      env[assignment.slice(0, eq)] = assignment.slice(eq + 1);
    }
    const [name, ...args] = argv;
    const program = this._interactive.find((p) => p.names.includes(name));
    if (!program || (program.accepts && !program.accepts(args))) return false;

    const write = this._write!;
    this._programActive = true;
    this._busy = true;
    const ctx: InteractiveCommandContext = {
      args,
      name,
      cwd: this._cwd,
      env,
      bash: this._bash!,
      write,
      size: this._getSize,
      readLine: (options) => {
        const reader = new LineReader(write, options);
        this._reader = reader;
        // Zuvor eingefügten Rest (z. B. mehrzeiliges Einfügen) weiterverarbeiten
        const pending = this._pendingInput;
        this._pendingInput = "";
        if (pending) {
          const rest = reader.handleInput(pending);
          if (reader.finished) {
            this._reader = null;
            this._pendingInput = rest;
          }
        }
        return reader.result;
      },
      onInput: (handler) => {
        this._programInput = handler;
      },
    };
    try {
      const code = await program.run(ctx);
      this._lastStatus = typeof code === "number" ? code : 0;
    } catch (err) {
      this._lastStatus = 1;
      const msg = err instanceof Error ? err.message : String(err);
      write(`\x1b[31m${name}: ${msg}\x1b[0m\r\n`);
    } finally {
      this._programActive = false;
      this._reader = null;
      this._programInput = null;
      this._pendingInput = "";
      this._busy = false;
    }
    write(this._prompt(this._cwd));
    return true;
  }

  private async _tryGitCommitEditor(cmd: string): Promise<boolean> {
    const trimmed = cmd.trim();
    if (!/^git(\s|$)/.test(trimmed)) return false;
    if (/[|&;<>`$()]/.test(trimmed.replace(/'[^']*'|"[^"$`]*"/g, ""))) return false;
    const args = splitArgs(trimmed);
    if (!args || !needsCommitEditor(args.slice(1))) return false;

    const bash = this._bash!;
    const run = (extra: string) =>
      bash.exec(this._wrapCommand(`${trimmed} ${extra}`, false), this._execOptions());

    this._busy = true;
    try {
      const prep = await run(EDITMSG_PREPARE);
      const marker = prep.stdout.split("\n").find((l) => l.startsWith(EDITMSG_MARKER));
      if (prep.exitCode !== 0 || !marker) {
        this._writeResult(prep);
        this._busy = false;
        this._write!(this._prompt(this._cwd));
        return true;
      }
      const path = marker.slice(EDITMSG_MARKER.length);
      await this._openNano({ file: path }, async () => {
        this._writeResult(await run(EDITMSG_USE));
      });
    } catch (err) {
      this._busy = false;
      const msg = err instanceof Error ? err.message : String(err);
      this._write!(`\x1b[31m${msg}\x1b[0m\r\n${this._prompt(this._cwd)}`);
    }
    return true;
  }

  async handleInput(data: string): Promise<void> {
    if (!this._write) return;
    if (this._nano) {
      await this._nano.handleInput(data);
      return;
    }
    if (this._programActive) {
      if (this._reader) {
        const rest = this._reader.handleInput(data);
        if (this._reader.finished) {
          this._reader = null;
          this._pendingInput += rest;
        }
      } else if (this._programInput) {
        this._programInput(data);
      } else {
        this._pendingInput += data;
      }
      return;
    }
    if (this._busy) {
      if (
        data === "\x03" &&
        this._execAbort &&
        !this._execAbort.signal.aborted
      ) {
        this._write("^C\r\n");
        this._execAbort.abort();
      }
      return;
    }
    this._inputRevision++;
    const write = this._write;
    if (!WORD_ERASE_SEQUENCES.has(data) && data !== "\x15" && data !== "\x0b") {
      this._lastActionWasKill = false;
    }

    if (this._historySearch && (await this._handleHistorySearchInput(data)))
      return;
    if (data === "\x12") {
      this._startHistorySearch();
      return;
    }

    if (data === "\t") {
      await this._tabComplete();
      return;
    }

    if (data === "\r") {
      const cur = this._line;
      this._line = "";
      this._cursor = 0;
      write("\r\n");

      if (cur.endsWith("\\")) {
        this._buffer += cur + "\n";
        write("> ");
        return;
      }

      const cmd = this._buffer + cur;
      this._buffer = "";
      this._historyPos = -1;
      this._historyDraft = null;

      if (cmd.trim() && this._bash) {
        this._history.push(cmd);
        if (await this._tryStartNano(cmd)) return;
        if (await this._tryGitCommitEditor(cmd)) return;
        if (await this._tryInteractive(cmd)) return;
        const abort = new AbortController();
        this._execAbort = abort;
        this._busy = true;

        try {
          const result = await this._bash.exec(this._wrapCommand(cmd, true), {
            ...this._execOptions(),
            signal: abort.signal,
          });
          if (!abort.signal.aborted) {
            if (result.stdout) {
              write(result.stdout.replace(/\n/g, "\r\n"));
              if (!result.stdout.endsWith("\n")) write("\r\n");
            }
            if (result.stderr) {
              write(`\x1b[31m${result.stderr.replace(/\n/g, "\r\n")}\x1b[0m`);
              if (!result.stderr.endsWith("\n")) write("\r\n");
            }
          }
          this._updateCwd(result.env);
          this._lastStatus = result.exitCode;
        } catch (err) {
          if (!abort.signal.aborted) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            write(`\x1b[31m${msg}\x1b[0m\r\n`);
          }
        } finally {
          this._execAbort = null;
          this._busy = false;
        }
      }

      write(this._prompt(this._cwd));
    } else if (data === "\x7f" || data === "\b") {
      if (this._cursor > 0) {
        this._eraseBeforeCursor(
          previousGraphemeStart(this._line, this._cursor),
        );
      }
    } else if (WORD_ERASE_SEQUENCES.has(data)) {
      this._recordKill(
        this._eraseBeforeCursor(this._wordBoundary(-1)),
        "backward",
      );
    } else if (data === "\x1b[3~") {
      if (this._cursor < this._line.length) {
        const tail = this._line.slice(
          nextGraphemeEnd(this._line, this._cursor),
        );
        this._line = this._line.slice(0, this._cursor) + tail;
        write(tail + "\x1b[K");
        this._moveCells(stringWidth(tail), "D");
      }
    } else if (data === "\x1b[A") {
      if (!this._history.length) return;
      if (this._historyPos < 0) {
        this._historyDraft = { line: this._line, cursor: this._cursor };
        this._historyPos = this._history.length;
      }
      if (this._historyPos > 0) {
        this._historyPos--;
        this._showLine(this._history[this._historyPos]);
      }
    } else if (data === "\x1b[B") {
      if (this._historyPos < 0) return;
      this._historyPos++;
      if (this._historyPos >= this._history.length) {
        this._historyPos = -1;
        const draft = this._historyDraft;
        this._historyDraft = null;
        this._showLine(draft?.line ?? "", draft?.cursor ?? 0);
      } else {
        this._showLine(this._history[this._historyPos]);
      }
    } else if (data === "\x1b[D") {
      if (this._cursor > 0) {
        const start = previousGraphemeStart(this._line, this._cursor);
        const width = stringWidth(this._line.slice(start, this._cursor));
        this._cursor = start;
        this._moveCells(width, "D", true);
      }
    } else if (data === "\x1b[C") {
      if (this._cursor < this._line.length) {
        const end = nextGraphemeEnd(this._line, this._cursor);
        const width = stringWidth(this._line.slice(this._cursor, end));
        this._cursor = end;
        this._moveCells(width, "C", true);
      }
    } else if (WORD_LEFT_SEQUENCES.has(data)) {
      this._moveWord(-1);
    } else if (WORD_RIGHT_SEQUENCES.has(data)) {
      this._moveWord(1);
    } else if (data === "\x15") {
      this._recordKill(this._eraseBeforeCursor(0), "backward");
    } else if (data === "\x0b") {
      const removed = this._line.slice(this._cursor);
      this._recordKill(removed, "forward");
      if (removed) {
        this._line = this._line.slice(0, this._cursor);
        write("\x1b[K");
      }
    } else if (data === "\x19") {
      if (this._killBuffer) this._insertText(this._killBuffer);
    } else if (data === "\x01" || HOME_SEQUENCES.has(data)) {
      if (this._cursor > 0) {
        this._moveCells(stringWidth(this._line.slice(0, this._cursor)), "D");
        this._cursor = 0;
      }
    } else if (data === "\x05" || END_SEQUENCES.has(data)) {
      if (this._cursor < this._line.length) {
        this._moveCells(stringWidth(this._line.slice(this._cursor)), "C");
        this._cursor = this._line.length;
      }
    } else if (data === "\x03") {
      this._line = "";
      this._cursor = 0;
      this._buffer = "";
      this._historyPos = -1;
      this._historyDraft = null;
      write("^C\r\n");
      write(this._prompt(this._cwd));
    } else if (data === "\x0c") {
      write("\x1b[2J\x1b[H");
      write(this._prompt(this._cwd));
      write(this._line);
      if (this._cursor < this._line.length) {
        this._moveCells(stringWidth(this._line.slice(this._cursor)), "D");
      }
    } else if (data.startsWith("\x1b[") || data.startsWith("\x1bO")) {
      // Ignore unsupported functional keys instead of inserting their escape suffix.
      return;
    } else if (PRINTABLE_TEXT.test(data)) {
      this._insertText(data);
    } else if (data.length > 1) {
      for (const ch of data) {
        await this.handleInput(ch);
      }
    }
  }

  private _moveCells(
    width: number,
    direction: "C" | "D",
    shortSingleStep = false,
  ): void {
    if (width > 0) {
      const count = shortSingleStep && width === 1 ? "" : width;
      this._write?.(`\x1b[${count}${direction}`);
    }
  }

  private _insertText(text: string): void {
    const write = this._write;
    if (!write) return;
    const tail = this._line.slice(this._cursor);
    this._line = this._line.slice(0, this._cursor) + text + tail;
    this._cursor += text.length;
    if (tail.length === 0) {
      write(text);
    } else {
      write(text + tail + "\x1b[K");
      this._moveCells(stringWidth(tail), "D");
    }
  }

  private _eraseBeforeCursor(start: number): string {
    if (start === this._cursor) return "";
    const write = this._write;
    if (!write) return "";
    const removed = this._line.slice(start, this._cursor);
    const removedWidth = stringWidth(removed);
    const tail = this._line.slice(this._cursor);
    this._line = this._line.slice(0, start) + tail;
    this._cursor = start;
    const moveLeft =
      removedWidth === 1
        ? "\b"
        : removedWidth > 0
          ? `\x1b[${removedWidth}D`
          : "";
    write(moveLeft + tail + "\x1b[K");
    this._moveCells(stringWidth(tail), "D");
    return removed;
  }

  private _recordKill(text: string, direction: "backward" | "forward"): void {
    if (!text) {
      this._lastActionWasKill = false;
      return;
    }
    if (this._lastActionWasKill) {
      this._killBuffer =
        direction === "backward"
          ? text + this._killBuffer
          : this._killBuffer + text;
    } else {
      this._killBuffer = text;
    }
    this._lastActionWasKill = true;
  }

  private _showLine(line: string, cursor = line.length): void {
    this._line = line;
    this._cursor = cursor;
    this._write?.(`\r${this._prompt(this._cwd)}\x1b[K${line}`);
    this._moveCells(stringWidth(line.slice(cursor)), "D");
  }

  private _findHistoryMatch(
    query: string,
    from: number,
    direction: -1 | 1,
  ): number {
    for (
      let index = from;
      index >= 0 && index < this._history.length;
      index += direction
    ) {
      if (this._history[index].includes(query)) return index;
    }
    return -1;
  }

  private _historySearchBoundary(direction: -1 | 1): number {
    return direction === -1 ? this._history.length - 1 : 0;
  }

  private _moveHistorySearch(direction: -1 | 1): void {
    const search = this._historySearch;
    if (!search) return;
    const changedDirection = search.direction !== direction;
    search.direction = direction;
    const from =
      search.index < 0
        ? this._historySearchBoundary(direction)
        : search.index + direction;
    const match = this._findHistoryMatch(search.query, from, direction);
    if (match >= 0) search.index = match;
    if (match >= 0 || changedDirection) this._renderHistorySearch();
  }

  private _startHistorySearch(): void {
    if (!this._history.length || this._buffer) return;
    this._historySearch = {
      query: "",
      index: this._history.length - 1,
      direction: -1,
      draft: { line: this._line, cursor: this._cursor },
    };
    this._renderHistorySearch();
  }

  private _renderHistorySearch(): void {
    const search = this._historySearch;
    if (!search) return;
    const direction =
      search.direction === -1 ? "reverse-i-search" : "forward-i-search";
    const status = search.index < 0 ? `failed ${direction}` : direction;
    const command =
      search.index < 0 ? "" : this._history[search.index].replace(/\n/g, "\\n");
    this._write?.("\r\x1b[K(" + status + ")`" + search.query + "': " + command);
  }

  private _acceptHistorySearch(): boolean {
    const search = this._historySearch;
    if (!search || search.index < 0) return false;
    this._historySearch = null;
    this._historyPos = -1;
    this._historyDraft = null;
    this._showLine(this._history[search.index]);
    return true;
  }

  private _cancelHistorySearch(): void {
    const search = this._historySearch;
    if (!search) return;
    this._historySearch = null;
    this._showLine(search.draft.line, search.draft.cursor);
  }

  private async _handleHistorySearchInput(data: string): Promise<boolean> {
    const search = this._historySearch;
    if (!search) return false;

    if (data === "\x03") {
      this._historySearch = null;
      return false;
    }
    if (data === "\x12" || data === "\x13") {
      this._moveHistorySearch(data === "\x12" ? -1 : 1);
      return true;
    }
    if (data === "\x07") {
      this._cancelHistorySearch();
      return true;
    }
    if (data === "\x1b") {
      if (!this._acceptHistorySearch()) this._cancelHistorySearch();
      return true;
    }
    if (SEARCH_EDIT_SEQUENCES.has(data)) {
      if (!this._acceptHistorySearch()) this._cancelHistorySearch();
      await this.handleInput(data);
      return true;
    }
    if (data === "\r") {
      if (this._acceptHistorySearch()) await this.handleInput("\r");
      return true;
    }
    if (data === "\x7f" || data === "\b") {
      if (search.query) {
        search.query = search.query.slice(
          0,
          previousGraphemeStart(search.query, search.query.length),
        );
        const from =
          search.index < 0
            ? this._historySearchBoundary(search.direction)
            : search.index;
        search.index = this._findHistoryMatch(
          search.query,
          from,
          search.direction,
        );
        this._renderHistorySearch();
      }
      return true;
    }
    if (data === "\x15") {
      search.query = "";
      search.index = this._historySearchBoundary(search.direction);
      this._renderHistorySearch();
      return true;
    }
    if (data === "\x0c") {
      this._write?.("\x1b[2J\x1b[H");
      this._renderHistorySearch();
      return true;
    }
    if (PRINTABLE_TEXT.test(data)) {
      search.query += data;
      const from =
        search.index < 0
          ? this._historySearchBoundary(search.direction)
          : search.index;
      search.index = this._findHistoryMatch(
        search.query,
        from,
        search.direction,
      );
      this._renderHistorySearch();
      return true;
    }
    if (!data.startsWith("\x1b") && data.length > 1) {
      for (const ch of data) await this.handleInput(ch);
    }
    return true;
  }

  private _moveWord(direction: -1 | 1): void {
    const start = this._cursor;
    this._cursor = this._wordBoundary(direction);
    const width = stringWidth(
      this._line.slice(
        Math.min(start, this._cursor),
        Math.max(start, this._cursor),
      ),
    );
    this._moveCells(width, direction === -1 ? "D" : "C");
  }

  private _wordBoundary(direction: -1 | 1): number {
    const segments = [...graphemes.segment(this._line)];
    let index = segments.findIndex((segment) => segment.index >= this._cursor);
    if (index < 0) index = segments.length;
    const isWhitespace = (segment: string) => /^\s+$/u.test(segment);

    if (direction === -1) {
      while (index > 0 && isWhitespace(segments[index - 1].segment)) index--;
      while (index > 0 && !isWhitespace(segments[index - 1].segment)) index--;
    } else {
      while (index < segments.length && isWhitespace(segments[index].segment))
        index++;
      while (index < segments.length && !isWhitespace(segments[index].segment))
        index++;
    }

    return segments[index]?.index ?? this._line.length;
  }

  private _insertCompletion(completion: string): void {
    if (!completion) return;
    const suffix = /^\S*/u.exec(this._line.slice(this._cursor))?.[0] ?? "";
    let overlap = 0;
    for (const { index, segment } of graphemes.segment(suffix)) {
      const length = index + segment.length;
      if (
        length <= completion.length &&
        completion.endsWith(suffix.slice(0, length))
      ) {
        overlap = length;
      }
    }

    const insertion = completion.slice(0, completion.length - overlap);
    if (insertion) this._insertText(insertion);
    if (overlap > 0) {
      this._cursor += overlap;
      this._moveCells(stringWidth(suffix.slice(0, overlap)), "C");
    }
  }

  private async _tabComplete(): Promise<void> {
    const bash = this._bash;
    const write = this._write;
    if (!bash || !write) return;

    const line = this._line;
    const cursor = this._cursor;
    const revision = this._inputRevision;
    const parts = line.slice(0, cursor).split(/\s+/);
    const word = parts[parts.length - 1] ?? "";
    const isFirst = parts.length <= 1;

    let dir: string;
    let prefix: string;
    if (word.includes("/")) {
      const lastSlash = word.lastIndexOf("/");
      const rawDir = word.slice(0, lastSlash + 1);
      prefix = word.slice(lastSlash + 1);
      if (rawDir.startsWith("/")) {
        dir = rawDir;
      } else if (rawDir.startsWith("~/")) {
        dir = `/home/user/${rawDir.slice(2)}`;
      } else {
        dir = `${this._cwd}/${rawDir}`;
      }
    } else {
      dir = this._cwd;
      prefix = word;
    }

    let candidates: string[] = [];
    try {
      const result = await bash.exec(`ls -1a ${JSON.stringify(dir)}`, this._execOptions());
      if (result.exitCode === 0 && result.stdout) {
        candidates = result.stdout
          .split("\n")
          .filter((f) => f && f !== "." && f !== ".." && f.startsWith(prefix));
      }
    } catch {
      return;
    }
    if (this._inputRevision !== revision) return;

    if (isFirst && !word.includes("/")) {
      try {
        const cmdResult = await bash.exec(
          `compgen -c ${JSON.stringify(prefix)} 2>/dev/null || true`,
          this._execOptions(),
        );
        if (cmdResult.exitCode === 0 && cmdResult.stdout) {
          const cmds = cmdResult.stdout.split("\n").filter(Boolean);
          for (const c of cmds) {
            if (!candidates.includes(c)) candidates.push(c);
          }
        }
      } catch {
        /* compgen may not be available */
      }
    }

    if (this._inputRevision !== revision) return;
    if (candidates.length === 0) return;

    if (candidates.length === 1) {
      const completion = candidates[0].slice(prefix.length);
      this._insertCompletion(completion);
      try {
        const testPath = `${dir.replace(/\/$/, "")}/${candidates[0]}`;
        const stat = await bash.exec(
          `test -d ${JSON.stringify(testPath)} && echo DIR`,
          this._execOptions(),
        );
        if (this._inputRevision !== revision) return;
        if (
          stat.stdout?.trim() === "DIR" &&
          this._line[this._cursor - 1] !== "/" &&
          this._line[this._cursor] !== "/"
        ) {
          this._insertText("/");
        }
      } catch {
        /* ignore */
      }
    } else {
      let common = candidates[0];
      for (let i = 1; i < candidates.length; i++) {
        while (!candidates[i].startsWith(common)) {
          common = common.slice(0, -1);
        }
      }
      const partialCompletion = common.slice(prefix.length);
      if (partialCompletion) {
        this._insertCompletion(partialCompletion);
      } else {
        write("\r\n");
        write(candidates.join("  ").replace(/\n/g, "\r\n"));
        write("\r\n");
        write(this._prompt(this._cwd));
        write(this._line);
        this._moveCells(stringWidth(this._line.slice(this._cursor)), "D");
      }
    }
  }
}

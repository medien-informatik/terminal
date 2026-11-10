/**
 * Python für wterm/just-bash auf Basis von Pyodide (CPython als WebAssembly).
 *
 * Stellt bereit:
 * - `python`/`python3` als just-bash-Befehl (Skripte, `-c`, `-m`, Pipes)
 * - eine interaktive REPL und Skripte mit `input()` beim direkten Aufruf
 * - `pip` mit Hinweis, dass keine Pakete installiert werden können
 *
 * Pyodide wird lokal ausgeliefert (siehe `indexURL`), es gibt keine
 * Netzwerkzugriffe auf CDNs.
 */
import type { PyodideAPI } from "pyodide";
import type { CustomCommand, IFileSystem } from "just-bash";
import type {
  InteractiveCommand,
  InteractiveCommandContext,
} from "@wterm/just-bash";
import { syncFromPython, syncToPython, type EmscriptenFS, type Snapshot } from "./fs-sync.js";

export interface PythonOptions {
  /** URL des Verzeichnisses mit den Pyodide-Dateien (pyodide.asm.wasm, …). */
  indexURL: string;
  /** Verzeichnisse, die mit Python abgeglichen werden. */
  roots?: string[];
  /** Befehlsnamen (Standard: python, python3). */
  names?: string[];
}

type Sink = (bytes: Uint8Array) => void;
type Reader = () => Promise<string | null>;

const SETUP_CODE = String.raw`
import sys, io, os, builtins, traceback, runpy
import js
from pyodide.ffi import can_run_sync, run_sync, jsnull

sys.dont_write_bytecode = True
os.environ["HOME"] = "/home/user"
os.environ["USER"] = "user"


class _WtermStdin(io.TextIOBase):
    """sys.stdin: liest aus einer Pipe oder interaktiv vom Terminal."""

    def __init__(self):
        self.reset()

    def reset(self, data=None, reader=None):
        # JavaScripts null kommt als jsnull an, nicht als None
        self._buf = ""
        self._eof = False
        self._data = None if data is None or data is jsnull else str(data)
        self._reader = None if reader is None or reader is jsnull else reader

    @property
    def encoding(self):
        return "utf-8"

    @property
    def name(self):
        return "<stdin>"

    def readable(self):
        return True

    def isatty(self):
        return self._data is None and self._reader is not None

    def _fill(self):
        if self._buf or self._eof:
            return
        if self._data is not None:
            self._buf, self._data = self._data, ""
            if not self._buf:
                self._eof = True
            return
        if self._reader is None:
            self._eof = True
            return
        sys.stdout.flush()
        sys.stderr.flush()
        if can_run_sync():
            result = run_sync(self._reader())
        else:
            # Ohne JavaScript Promise Integration (z. B. ältere Browser)
            result = js.prompt("Eingabe für Python:")
            if result is not None:
                sys.stdout.write(result + "\n")
        if result is None or result is jsnull:
            self._eof = True
        elif result == "\x03":
            raise KeyboardInterrupt
        else:
            self._buf = result + "\n"

    def readline(self, size=-1):
        self._fill()
        if not self._buf:
            return ""
        i = self._buf.find("\n")
        n = len(self._buf) if i < 0 else i + 1
        if size is not None and size >= 0:
            n = min(n, size)
        line, self._buf = self._buf[:n], self._buf[n:]
        return line

    def read(self, size=-1):
        parts = []
        total = 0
        while size is None or size < 0 or total < size:
            self._fill()
            if not self._buf:
                break
            take = len(self._buf) if size is None or size < 0 else size - total
            parts.append(self._buf[:take])
            self._buf = self._buf[take:]
            total += take
        return "".join(parts)

    def readlines(self, hint=-1):
        return list(iter(self.readline, ""))

    def __iter__(self):
        return iter(self.readline, "")


_wterm_stdin = _WtermStdin()
sys.stdin = _wterm_stdin


def _wterm_set_env(env):
    """os.environ an die exportierten Variablen der Shell angleichen."""
    env = dict(env)
    for key in list(os.environ):
        if key not in env:
            del os.environ[key]
    for key, value in env.items():
        if os.environ.get(key) != value:
            os.environ[key] = value


def _wterm_strip(te):
    te.stack = traceback.StackSummary.from_list(
        [f for f in te.stack if f.filename != "<exec>" and "runpy" not in f.filename]
    )
    for nested in (te.__cause__, te.__context__):
        if nested is not None:
            _wterm_strip(nested)


def _wterm_format_exc(e):
    te = traceback.TracebackException.from_exception(e)
    _wterm_strip(te)
    return "".join(te.format())


def _wterm_run(mode, target, argv, cwd):
    before = set(sys.modules)
    old_path = list(sys.path)
    try:
        os.chdir(cwd)
    except OSError:
        pass
    sys.argv = list(argv)
    try:
        if mode == "c":
            sys.path.insert(0, "")
            code = compile(target, "<string>" if argv[0] == "-c" else "<stdin>", "exec")
            exec(code, {"__name__": "__main__", "__builtins__": builtins})
        elif mode == "m":
            sys.path.insert(0, cwd)
            runpy.run_module(target, run_name="__main__", alter_sys=True)
        else:
            sys.path.insert(0, os.path.dirname(os.path.abspath(target)))
            runpy.run_path(target, run_name="__main__")
        return 0
    except SystemExit as e:
        code = e.code
        if code is None:
            return 0
        if isinstance(code, int):
            return code
        sys.stderr.write(str(code) + "\n")
        return 1
    except BaseException as e:
        sys.stderr.write(_wterm_format_exc(e))
        return 1
    finally:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
        sys.path[:] = old_path
        # Eigene Module nach dem Lauf vergessen, damit Änderungen wirken
        for name in set(sys.modules) - before:
            f = getattr(sys.modules.get(name), "__file__", None) or ""
            if f.startswith(("/home/", "/tmp/")):
                del sys.modules[name]


import builtins as _b
from pyodide.ffi import to_js as _to_js


async def _wterm_await_fut(fut):
    res = await fut
    if res is not None:
        _b._ = res
    return _to_js([res], depth=1)
`;

/** Wandelt Python-Ausgabe in Terminal-Ausgabe (\n → \r\n, UTF-8 stückweise). */
function terminalSink(write: (s: string) => void, color?: string): Sink {
  const decoder = new TextDecoder();
  return (bytes) => {
    let text = decoder.decode(bytes, { stream: true }).replace(/\r?\n/g, "\r\n");
    if (!text) return;
    if (color) text = `${color}${text}\x1b[0m`;
    write(text);
  };
}

function collectSink(): { sink: Sink; text: () => string } {
  const chunks: Uint8Array[] = [];
  return {
    sink: (b) => chunks.push(b.slice()),
    text: () => {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const all = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        all.set(c, off);
        off += c.length;
      }
      return new TextDecoder().decode(all);
    },
  };
}

interface ParsedArgs {
  mode: "repl" | "c" | "m" | "file" | "stdin";
  target?: string;
  argv: string[];
  version?: boolean;
  help?: boolean;
  error?: string;
  quiet?: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  let quiet = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-V" || a === "--version") return { mode: "repl", argv: [], version: true };
    if (a === "-h" || a === "--help" || a === "-?") return { mode: "repl", argv: [], help: true };
    if (a === "-c") {
      if (args[i + 1] === undefined) return { mode: "repl", argv: [], error: "Argument expected for the -c option" };
      return { mode: "c", target: args[i + 1], argv: ["-c", ...args.slice(i + 2)], quiet };
    }
    if (a === "-m") {
      if (args[i + 1] === undefined) return { mode: "repl", argv: [], error: "Argument expected for the -m option" };
      return { mode: "m", target: args[i + 1], argv: [args[i + 1], ...args.slice(i + 2)], quiet };
    }
    if (a === "-") return { mode: "stdin", argv: ["-", ...args.slice(i + 1)], quiet };
    if (a === "-q") {
      quiet = true;
      continue;
    }
    if (/^-[uBEsSIiO]+$/.test(a)) continue; // ohne Wirkung in der Simulation
    if (a.startsWith("-")) return { mode: "repl", argv: [], error: `Unknown option: ${a}` };
    return { mode: "file", target: a, argv: args.slice(i), quiet };
  }
  return { mode: "repl", argv: [""], quiet };
}

const USAGE = `usage: python [option] ... [-c cmd | -m mod | file | -] [arg] ...
Options (Auswahl, wterm-Simulation mit Pyodide):
-c cmd : program passed in as string (terminates option list)
-m mod : run library module as a script (terminates option list)
-q     : don't print version and copyright messages on interactive startup
-V     : print the Python version number and exit (also --version)
-h     : print this help message and exit (also --help)
file   : program read from script file
-      : program read from stdin (default; interactive mode if a tty)
arg ...: arguments passed to program in sys.argv[1:]
`;

export class PythonRuntime {
  private loading: Promise<PyodideAPI> | null = null;
  private stdoutSink: Sink = () => {};
  private stderrSink: Sink = () => {};
  private readonly roots: string[];
  private busy = false;

  constructor(private readonly options: PythonOptions) {
    this.roots = options.roots ?? ["/home", "/tmp"];
  }

  get isLoaded(): boolean {
    return this.loading !== null;
  }

  load(): Promise<PyodideAPI> {
    this.loading ??= (async () => {
      const { loadPyodide } = await import("pyodide");
      const indexURL = this.options.indexURL;
      const py = await loadPyodide({
        indexURL,
        packageBaseUrl: indexURL,
        env: { HOME: "/home/user", USER: "user" },
      });
      py.setStdout({ write: (b: Uint8Array) => (this.stdoutSink(b), b.length), isatty: true });
      py.setStderr({ write: (b: Uint8Array) => (this.stderrSink(b), b.length), isatty: true });
      py.runPython(SETUP_CODE);
      return py;
    })().catch((err) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  async version(): Promise<string> {
    const py = await this.load();
    return py.runPython("import sys; sys.version.split()[0]") as string;
  }

  private rootsFor(cwd: string): string[] {
    const roots = [...this.roots];
    if (!roots.some((r) => cwd === r || cwd.startsWith(r + "/"))) roots.push(cwd);
    return roots;
  }

  /** Setzt os.environ auf die übergebenen (exportierten) Variablen. */
  private applyEnv(py: PyodideAPI, env: Record<string, string> | undefined): void {
    if (!env) return;
    const fn = py.globals.get("_wterm_set_env");
    const dict = py.toPy(env);
    try {
      fn(dict);
    } finally {
      dict.destroy();
      fn.destroy();
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Python läuft bereits");
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  /** Führt ein Programm aus (Skript, -c, -m oder Code von stdin). */
  async run(opts: {
    fs: IFileSystem;
    cwd: string;
    mode: "c" | "m" | "file";
    target: string;
    argv: string[];
    stdout: Sink;
    stderr: Sink;
    stdinData?: string;
    stdinReader?: Reader;
    /** Umgebungsvariablen für os.environ. */
    env?: Record<string, string>;
  }): Promise<number> {
    const py = await this.load();
    return this.withLock(async () => {
      const FS = py.FS as unknown as EmscriptenFS;
      const roots = this.rootsFor(opts.cwd);
      const snapshot = await syncToPython(opts.fs, FS, roots);
      this.applyEnv(py, opts.env);
      const stdin = py.globals.get("_wterm_stdin");
      stdin.reset(opts.stdinData ?? null, opts.stdinReader ?? null);
      this.stdoutSink = opts.stdout;
      this.stderrSink = opts.stderr;
      const fn = py.globals.get("_wterm_run");
      try {
        const args = [opts.mode, opts.target, opts.argv, opts.cwd] as const;
        const pyArgs = [args[0], args[1], py.toPy(args[2]), args[3]];
        let code: number;
        try {
          code = await fn.callPromising(...pyArgs);
        } catch (err) {
          // Ohne JSPI-Unterstützung: normaler (synchroner) Aufruf. Python-Fehler
          // fängt _wterm_run selbst ab, andere Fehler betreffen nur den Aufruf.
          if ((err as Error)?.constructor?.name === "PythonError") throw err;
          code = fn(...pyArgs);
        }
        return code;
      } finally {
        fn.destroy();
        stdin.reset(null, null);
        stdin.destroy();
        this.stdoutSink = () => {};
        this.stderrSink = () => {};
        await syncFromPython(opts.fs, FS, roots, snapshot);
      }
    });
  }

  /** Interaktive REPL im Terminal. */
  async repl(ctx: InteractiveCommandContext, quiet = false): Promise<number> {
    const py = await this.load();
    return this.withLock(async () => {
      const FS = py.FS as unknown as EmscriptenFS;
      const fs = ctx.bash.fs;
      const roots = this.rootsFor(ctx.cwd);
      const snapshot: Snapshot = await syncToPython(fs, FS, roots);
      this.applyEnv(py, ctx.env);
      py.runPython(`import os\ntry:\n    os.chdir(${JSON.stringify(ctx.cwd)})\nexcept OSError:\n    pass`);

      const reader: Reader = async () => {
        const r = await ctx.readLine();
        return r.type === "line" ? r.text : r.type === "eof" ? null : "\x03";
      };
      const stdin = py.globals.get("_wterm_stdin");
      stdin.reset(null, reader);
      this.stdoutSink = terminalSink(ctx.write);
      this.stderrSink = terminalSink(ctx.write, "\x1b[31m");

      const consoleMod = py.pyimport("pyodide.console");
      const ns = py.globals.get("dict")();
      ns.set("__name__", "__main__");
      ns.set("__builtins__", py.pyimport("builtins"));
      const con = consoleMod.Console.callKwargs({ globals: ns, filename: "<stdin>" });
      const reprShorten = consoleMod.repr_shorten;
      const awaitFut = py.globals.get("_wterm_await_fut");

      if (!quiet) {
        const banner = (consoleMod.BANNER as string).replace(/\n/g, "\r\n");
        ctx.write(banner + "\r\n");
      }

      const history: string[] = [];
      let prompt = ">>> ";
      let exitCode = 0;
      try {
        for (;;) {
          ctx.write(prompt);
          const r = await ctx.readLine({ history });
          if (r.type === "eof") break;
          if (r.type === "interrupt") {
            con.buffer.clear();
            ctx.write("\x1b[31mKeyboardInterrupt\x1b[0m\r\n");
            prompt = ">>> ";
            continue;
          }
          if (r.text.trim()) history.push(r.text);
          const fut = con.push(r.text);
          const check = fut.syntax_check as string;
          if (check === "incomplete") {
            prompt = "... ";
            fut.destroy();
            continue;
          }
          prompt = ">>> ";
          if (check === "syntax-error") {
            ctx.write(`\x1b[31m${String(fut.formatted_error).trimEnd().replace(/\n/g, "\r\n")}\x1b[0m\r\n`);
            fut.destroy();
            continue;
          }
          let exit = false;
          try {
            const wrapped = awaitFut.callPromising ? awaitFut.callPromising(fut) : awaitFut(fut);
            const [value] = await wrapped;
            if (value !== undefined) {
              const text = reprShorten.callKwargs(value, { separator: "\n<long output truncated>\n" });
              ctx.write(String(text).replace(/\n/g, "\r\n") + "\r\n");
            }
            if (value && typeof value.destroy === "function") value.destroy();
          } catch (e) {
            const err = e as Error & { type?: string };
            if (err.type === "SystemExit") {
              exit = true;
              const m = /SystemExit:\s*(\S+)?\s*$/.exec(err.message.trim());
              exitCode = m?.[1] && /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : 0;
            } else if (err.constructor?.name === "PythonError" || err.type) {
              // interne Rahmen der Simulation (<exec>) ausblenden
              const msg = String(fut.formatted_error || err.message)
                .split("\n")
                .filter((l) => !/^\s+File "<exec>"/.test(l))
                .join("\n")
                .trimEnd();
              ctx.write(`\x1b[31m${msg.replace(/\n/g, "\r\n")}\x1b[0m\r\n`);
            } else {
              throw e;
            }
          } finally {
            fut.destroy();
          }
          await syncFromPython(fs, FS, roots, snapshot);
          if (exit) break;
        }
      } finally {
        stdin.reset(null, null);
        stdin.destroy();
        con.destroy();
        ns.destroy();
        awaitFut.destroy();
        reprShorten.destroy();
        consoleMod.destroy();
        this.stdoutSink = () => {};
        this.stderrSink = () => {};
        await syncFromPython(fs, FS, roots, snapshot);
      }
      return exitCode;
    });
  }
}

function canOpen(name: string, path: string): string {
  return `${name}: can't open file '${path}': [Errno 2] No such file or directory\n`;
}

function resolvePath(cwd: string, p: string): string {
  const raw = p.startsWith("/") ? p : p.startsWith("~/") ? `/home/user/${p.slice(2)}` : `${cwd}/${p}`;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

/** Erzeugt die Befehle für BashShell (customCommands + interactiveCommands). */
export function createPython(options: PythonOptions): {
  runtime: PythonRuntime;
  customCommands: CustomCommand[];
  interactiveCommands: InteractiveCommand[];
} {
  const runtime = new PythonRuntime(options);
  const names = options.names ?? ["python", "python3"];

  // Nicht-interaktiv: Skripte, -c, -m, Pipes (Ausgabe wird gesammelt)
  const customCommands: CustomCommand[] = names.map((name) => ({
    name,
    trusted: true,
    async execute(args, ctx) {
      const parsed = parseArgs(args);
      if (parsed.error) return { stdout: "", stderr: `${parsed.error}\n${USAGE}`, exitCode: 2 };
      if (parsed.help) return { stdout: USAGE, stderr: "", exitCode: 0 };
      if (parsed.version) return { stdout: `Python ${await runtime.version()}\n`, stderr: "", exitCode: 0 };
      const stdinBytes = Uint8Array.from(String(ctx.stdin ?? ""), (c) => c.charCodeAt(0) & 0xff);
      const stdinText = new TextDecoder().decode(stdinBytes);
      const out = collectSink();
      const err = collectSink();
      let mode: "c" | "m" | "file" = "c";
      let target = parsed.target ?? "";
      let stdinData = stdinText;
      if (parsed.mode === "repl" || parsed.mode === "stdin") {
        // Programm von stdin lesen (z. B. echo "print(1)" | python)
        target = stdinText;
        stdinData = "";
        if (parsed.mode === "repl") parsed.argv = [""];
      } else if (parsed.mode === "file") {
        mode = "file";
        target = resolvePath(ctx.cwd, parsed.target!);
        if (!(await ctx.fs.exists(target)) || (await ctx.fs.stat(target)).isDirectory) {
          return { stdout: "", stderr: canOpen(name, target), exitCode: 2 };
        }
      } else {
        mode = parsed.mode;
      }
      const exitCode = await runtime.run({
        fs: ctx.fs,
        cwd: ctx.cwd,
        mode,
        target,
        argv: parsed.argv,
        stdout: out.sink,
        stderr: err.sink,
        stdinData,
        // nur exportierte Variablen (inkl. X=1 python …)
        env: ctx.exportedEnv ?? Object.fromEntries(ctx.env),
      });
      return { stdout: out.text(), stderr: err.text(), exitCode };
    },
  }));

  // pip: keine Paketinstallation ohne Netzwerk
  customCommands.push(
    ...["pip", "pip3"].map<CustomCommand>((name) => ({
      name,
      trusted: true,
      async execute(args) {
        if (args[0] === "--version" || args[0] === "-V") {
          return { stdout: `pip (wterm-Simulation, Python ${await runtime.version()})\n`, stderr: "", exitCode: 0 };
        }
        if (args[0] === "list" || args[0] === "freeze") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return {
          stdout: "",
          stderr:
            `${name}: Pakete können in dieser Simulation nicht installiert werden (kein Netzwerkzugriff).\n` +
            "Verfügbar ist die Python-Standardbibliothek.\n",
          exitCode: 1,
        };
      },
    })),
  );

  // Interaktiv: direkter Aufruf in der Shell → Live-Ausgabe, input(), REPL
  const interactiveCommands: InteractiveCommand[] = [
    {
      names,
      accepts(args) {
        const p = parseArgs(args);
        return !p.help && !p.version && !p.error && p.mode !== "stdin";
      },
      async run(ctx) {
        const parsed = parseArgs(ctx.args);
        if (!runtime.isLoaded) {
          ctx.write("\x1b[2mPython wird geladen …\x1b[0m");
        }
        try {
          await runtime.load();
        } finally {
          ctx.write("\r\x1b[K");
        }
        if (parsed.mode === "repl") return runtime.repl(ctx, parsed.quiet);

        let target = parsed.target!;
        if (parsed.mode === "file") {
          target = resolvePath(ctx.cwd, target);
          const fs = ctx.bash.fs;
          if (!(await fs.exists(target)) || (await fs.stat(target)).isDirectory) {
            ctx.write(`\x1b[31m${canOpen(ctx.name, target).replace(/\n/g, "\r\n")}\x1b[0m`);
            return 2;
          }
        }
        const reader: Reader = async () => {
          const r = await ctx.readLine();
          return r.type === "line" ? r.text : r.type === "eof" ? null : "\x03";
        };
        // Strg+C außerhalb von input() kann laufenden Code nicht abbrechen
        ctx.onInput((data) => {
          if (data === "\x03") ctx.write("^C");
        });
        return runtime.run({
          fs: ctx.bash.fs,
          cwd: ctx.cwd,
          mode: parsed.mode as "c" | "m" | "file",
          target,
          argv: parsed.argv,
          stdout: terminalSink(ctx.write),
          stderr: terminalSink(ctx.write, "\x1b[31m"),
          stdinReader: reader,
          env: ctx.env,
        });
      },
    },
  ];

  return { runtime, customCommands, interactiveCommands };
}


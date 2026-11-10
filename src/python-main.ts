import { WTerm } from "@wterm/dom";
import { BashShell } from "@wterm/just-bash";
import { createPython } from "@wterm/python";
import "@wterm/dom/css";

const container = document.getElementById("terminal")!;

const term = new WTerm(container, {
  debug: new URLSearchParams(location.search).has("debug"),
});

await term.init();

// Pyodide wird lokal aus ./pyodide/ geladen (siehe scripts/copy-pyodide.mjs).
const python = createPython({
  indexURL: new URL("./pyodide/", location.href).href,
});

const shell = new BashShell({
  files: {
    "/home/user/README.md":
      "# wterm lokal – Python\n\nDieses Terminal läuft komplett im Browser.\nPython läuft über Pyodide (CPython als WebAssembly).\n",
    "/home/user/hallo.py":
      'name = input("Wie heißt du? ")\nprint(f"Hallo, {name}!")\n',
    "/home/user/primzahlen.py":
      'import sys\n\nn = int(sys.argv[1]) if len(sys.argv) > 1 else 50\nprimes = [p for p in range(2, n + 1) if all(p % d for d in range(2, int(p ** 0.5) + 1))]\nprint(*primes)\n',
    "/home/user/notizen.txt": "Einkaufsliste\n- Milch\n- Brot\n- Kaffee\n",
    "/home/user/.gitconfig":
      "[user]\n\tname = user\n\temail = user@wterm.local\n[init]\n\tdefaultBranch = main\n",
  },
  greeting: [
    "\x1b[1mwterm\x1b[0m – lokale Terminal-Simulation mit \x1b[1;33mPython\x1b[0m (Pyodide)",
    "Probiere: 'python' (REPL), 'python hallo.py', 'python primzahlen.py 100' oder 'nano hallo.py'.",
    "",
  ],
  getSize: () => ({ cols: term.cols, rows: term.rows }),
  customCommands: python.customCommands,
  interactiveCommands: python.interactiveCommands,
});

await shell.attach(term.write.bind(term));
term.onData = (data: string) => void shell.handleInput(data);
term.onResize = () => shell.resize();
term.focus?.();

// Pyodide im Hintergrund vorladen, damit der erste Aufruf schneller ist.
void python.runtime.load().catch(() => {});

if (import.meta.env.DEV) {
  Object.assign(window, { wterm: { term, shell, python } });
}

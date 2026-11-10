import { WTerm } from "@wterm/dom";
import { BashShell } from "@wterm/just-bash";
import "@wterm/dom/css";

const container = document.getElementById("terminal")!;

const term = new WTerm(container, {
  debug: new URLSearchParams(location.search).has("debug"),
});

await term.init();

// Alles läuft lokal im Browser: just-bash stellt eine virtuelle Shell mit
// In-Memory-Dateisystem bereit. Kein Netzwerkzugriff (curl ist deaktiviert),
// kein Server, kein PTY.
const shell = new BashShell({
  files: {
    "/home/user/README.md":
      "# wterm lokal\n\nDieses Terminal läuft komplett im Browser.\nProbiere: nano README.md\n",
    "/home/user/hello.sh": '#!/bin/bash\necho "Hello from wterm!"\n',
    "/home/user/notizen.txt": "Einkaufsliste\n- Milch\n- Brot\n- Kaffee\n",
    // Vorkonfigurierte git-Identität (änderbar mit `git config --global ...`)
    "/home/user/.gitconfig":
      "[user]\n\tname = user\n\temail = user@wterm.local\n[init]\n\tdefaultBranch = main\n",
  },
  greeting: [
    "\x1b[1mwterm\x1b[0m – lokale Terminal-Simulation (just-bash, keine Netzwerk-Tools)",
    "Tippe 'help' für Befehle, 'nano notizen.txt' zum Bearbeiten oder 'git help'.",
    "",
  ],
  getSize: () => ({ cols: term.cols, rows: term.rows }),
});

await shell.attach(term.write.bind(term));
term.onData = (data: string) => void shell.handleInput(data);
term.onResize = () => shell.resize();
term.focus?.();

// Für Debugging in der Browser-Konsole (nur im Dev-Server).
if (import.meta.env.DEV) {
  Object.assign(window, { wterm: { term, shell } });
}

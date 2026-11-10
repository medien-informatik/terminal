/**
 * nano-Emulation für wterm.
 *
 * Ein bildschirmorientierter Texteditor im Stil von GNU nano, der komplett im
 * Browser läuft. Er zeichnet sich über ANSI-Escape-Sequenzen in den Alternate
 * Screen des Terminals und liest/schreibt Dateien über das virtuelle
 * Dateisystem von just-bash (siehe {@link NanoHost}).
 */
import stringWidth from "string-width";

export interface NanoHost {
  /** Schreibt Rohdaten (inkl. Escape-Sequenzen) ins Terminal. */
  write(data: string): void;
  /** Aktuelle Terminalgröße. */
  size(): { cols: number; rows: number };
  /** Macht aus einer Benutzereingabe einen absoluten Pfad. */
  resolvePath(path: string): string;
  /** Liefert den Dateiinhalt oder `null`, wenn die Datei nicht existiert. */
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  isDirectory(path: string): Promise<boolean>;
}

export interface NanoOptions {
  /** Dateiname, wie er auf der Kommandozeile angegeben wurde. */
  file?: string;
  line?: number;
  column?: number;
  lineNumbers?: boolean;
  viewOnly?: boolean;
  tabSize?: number;
}

interface Snapshot {
  lines: string[];
  cy: number;
  cx: number;
  modified: boolean;
}

interface Prompt {
  label: string;
  value: string;
  cursor: number;
  shortcuts: [string, string][][];
  onSubmit: (value: string) => void | Promise<void>;
  onCancel?: () => void;
}

interface Question {
  label: string;
  /** Erlaubte Antworten, z. B. { y: ..., n: ..., a: ... } */
  answers: Record<string, () => void | Promise<void>>;
  shortcuts: [string, string][][];
  onCancel: () => void;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const PRINTABLE = /^[^\p{Cc}]+$/u;
const VERSION_LABEL = "nano (wterm)";

const VERTICAL_KEYS = new Set(["\x1b[A", "\x1bOA", "\x10", "\x1b[B", "\x1bOB", "\x0e"]);

const INVERSE = "\x1b[7m";
const RESET = "\x1b[0m";

const MAIN_SHORTCUTS: [string, string][][] = [
  [
    ["^G", "Help"],
    ["^O", "Write Out"],
    ["^W", "Where Is"],
    ["^K", "Cut"],
    ["^C", "Location"],
    ["M-U", "Undo"],
  ],
  [
    ["^X", "Exit"],
    ["^R", "Read File"],
    ["^\\", "Replace"],
    ["^U", "Paste"],
    ["^_", "Go To Line"],
    ["M-E", "Redo"],
  ],
];

const CANCEL_SHORTCUTS: [string, string][][] = [
  [["^G", "Help"]],
  [["^C", "Cancel"]],
];

const YES_NO_SHORTCUTS: [string, string][][] = [
  [[" Y", "Yes"]],
  [
    [" N", "No"],
    ["^C", "Cancel"],
  ],
];

const YES_NO_ALL_SHORTCUTS: [string, string][][] = [
  [
    [" Y", "Yes"],
    [" A", "All"],
  ],
  [
    [" N", "No"],
    ["^C", "Cancel"],
  ],
];

const HELP_TEXT = `Main nano help text

 The nano editor is designed to emulate the functionality and ease-of-use of
 the UW Pico text editor.  There are four main sections of the editor.  The
 top line shows the program version, the current filename being edited, and
 whether or not the file has been modified.  Next is the main editor window
 showing the file being edited.  The status line is the third line from the
 bottom and shows important messages.  The bottom two lines show the most
 commonly used shortcuts in the editor.

 Shortcuts are written as follows: Control-key sequences are notated with a
 '^' and can be entered with the Ctrl key.  Escape-key sequences are notated
 with 'M-' and can be entered with the Alt key.

 Hinweis (wterm): Manche Strg-Kombinationen (z. B. Strg+W, Strg+N, Strg+T)
 werden vom Browser abgefangen.  Nutze dann die Alternativen in Klammern.

 ^G   (F1)          Display this help text
 ^X   (F2)          Close the current buffer / Exit from nano
 ^O   (F3)          Write the current buffer to disk
 ^S                 Save file without prompting
 ^R   (Ins)         Insert another file into the current one

 ^W   (^F, F6)      Search forward for a string
 ^B                 Search backward for a string
 M-W  (F16)         Repeat the last search (forward)
 M-Q                Repeat the last search (backward)
 ^\\   (M-R)         Replace a string

 ^K   (F9)          Cut current line into cutbuffer
 M-6                Copy current line into cutbuffer
 ^U   (F10)         Paste the contents of cutbuffer at cursor

 ^C   (F11)         Display the position of the cursor
 ^_   (M-G)         Go to line and column number
 M-U                Undo the last operation
 M-E                Redo the last undone operation

 ^A   (Home)        Go to beginning of current line
 ^E   (End)         Go to end of current line
 ^P   (Up)          Go to previous line
 ^N   (Down)        Go to next line
 ^Y   (PgUp)        Go one screenful up
 ^V   (PgDn)        Go one screenful down
 M-\\  (^Home)       Go to the first line of the file
 M-/  (^End)        Go to the last line of the file
 ^Left / ^Right     Go to previous / next word

 ^D   (Del)         Delete the character under the cursor
 ^H   (Bsp)         Delete the character to the left of the cursor
 ^L                 Refresh (redraw) the current screen
 M-N  (M-#)         Line numbering enable/disable

 Press ^X, ^G, q or Esc to leave this help.`;

function previousGraphemeStart(text: string, index: number): number {
  if (index <= 0) return 0;
  return graphemes.segment(text).containing(index - 1)?.index ?? 0;
}

function nextGraphemeEnd(text: string, index: number): number {
  const seg = graphemes.segment(text).containing(index);
  return seg ? seg.index + seg.segment.length : text.length;
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export class NanoEditor {
  /** Wird aufgerufen, sobald der Editor geschlossen wurde. */
  onExit: (() => void) | null = null;

  private host: NanoHost;
  private tabSize: number;
  private viewOnly: boolean;
  private lineNumbers: boolean;

  private filename: string; // wie angezeigt / eingegeben
  private lines: string[] = [""];
  private cy = 0;
  private cx = 0;
  private preferredCol = 0;
  private top = 0;
  private modified = false;

  private cutBuffer: string[] = [];
  private lastWasCut = false;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastEditKind: string | null = null;

  private lastSearch = "";
  private lastReplace = "";
  private highlight: { y: number; start: number; end: number } | null = null;

  private message = "";
  private messageAge = 0;
  private prompt: Prompt | null = null;
  private question: Question | null = null;
  private helpTop = -1; // >= 0, wenn die Hilfe angezeigt wird
  private closed = false;

  private pendingLine: number | undefined;
  private pendingColumn: number | undefined;

  constructor(host: NanoHost, options: NanoOptions = {}) {
    this.host = host;
    this.tabSize = options.tabSize ?? 8;
    this.viewOnly = options.viewOnly ?? false;
    this.lineNumbers = options.lineNumbers ?? false;
    this.filename = options.file ?? "";
    this.pendingLine = options.line;
    this.pendingColumn = options.column;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  // ───────────────────────────── Lebenszyklus ─────────────────────────────

  async open(): Promise<void> {
    if (this.filename) {
      const path = this.host.resolvePath(this.filename);
      if (await this.host.isDirectory(path)) {
        this.setMessage(`"${this.filename}" is a directory`);
      } else {
        const content = await this.host.readFile(path);
        if (content === null) {
          this.setMessage("New File");
        } else {
          this.lines = this.splitLines(content);
          this.setMessage(`Read ${plural(this.lines.length, "line")}`);
        }
      }
    }
    if (this.viewOnly) this.message += this.message ? " (View mode)" : "View mode";

    if (this.pendingLine !== undefined) {
      this.goTo(this.pendingLine, this.pendingColumn ?? 1);
    }

    this.host.write("\x1b[?1049h\x1b[?7l\x1b[H\x1b[2J");
    this.render();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    // Zeilenumbruch wieder an, Alternate Screen verlassen, Cursor sichtbar.
    this.host.write(`${RESET}\x1b[?7h\x1b[?1049l\x1b[?25h`);
    this.onExit?.();
  }

  resize(): void {
    if (!this.closed) this.render();
  }

  // ───────────────────────────── Eingabe ─────────────────────────────

  async handleInput(data: string): Promise<void> {
    if (this.closed) return;
    for (const key of this.tokenize(data)) {
      if (this.closed) return;
      await this.handleKey(key);
    }
    if (!this.closed) this.render();
  }

  /** Zerlegt Eingabedaten in einzelne Tasten bzw. zusammenhängenden Text. */
  private tokenize(data: string): string[] {
    const keys: string[] = [];
    let i = 0;
    let text = "";
    const flush = () => {
      if (text) keys.push(text);
      text = "";
    };
    while (i < data.length) {
      const ch = data[i];
      if (ch === "\x1b") {
        flush();
        const next = data[i + 1];
        if (next === "[") {
          let j = i + 2;
          while (j < data.length && !/[@-~]/.test(data[j])) j++;
          keys.push(data.slice(i, j + 1));
          i = j + 1;
        } else if (next === "O" && i + 2 < data.length) {
          keys.push(data.slice(i, i + 3));
          i += 3;
        } else if (next !== undefined) {
          keys.push(data.slice(i, i + 2));
          i += 2;
        } else {
          keys.push("\x1b");
          i++;
        }
      } else if (ch === "\r" && data[i + 1] === "\n") {
        flush();
        keys.push("\r");
        i += 2;
      } else if (ch === "\n") {
        flush();
        keys.push("\r");
        i++;
      } else if (/\p{Cc}/u.test(ch) && ch !== "\t") {
        flush();
        keys.push(ch);
        i++;
      } else {
        text += ch;
        i++;
      }
    }
    flush();
    return keys;
  }

  private async handleKey(key: string): Promise<void> {
    if (this.helpTop >= 0) return this.handleHelpKey(key);
    if (this.question) return this.handleQuestionKey(key);
    if (this.prompt) return this.handlePromptKey(key);

    if (this.messageAge > 0 && --this.messageAge === 0) this.message = "";
    const wasCut = key === "\x0b" || key === "\x1b[20~";
    if (!wasCut) this.lastWasCut = false;
    // vertikale Bewegungen behalten die bevorzugte Spalte
    this.syncPreferredColAfter = !VERTICAL_KEYS.has(key);
    this.highlight = null;

    switch (key) {
      // Bewegung
      case "\x1b[A":
      case "\x1bOA":
      case "\x10": // ^P
        this.moveVertical(-1);
        break;
      case "\x1b[B":
      case "\x1bOB":
      case "\x0e": // ^N
        this.moveVertical(1);
        break;
      case "\x1b[D":
      case "\x1bOD":
        this.moveLeft();
        break;
      case "\x1b[C":
      case "\x1bOC":
        this.moveRight();
        break;
      case "\x1b[1;5D":
      case "\x1b[1;3D":
      case "\x1bb":
        this.moveWord(-1);
        break;
      case "\x1b[1;5C":
      case "\x1b[1;3C":
      case "\x1bf":
        this.moveWord(1);
        break;
      case "\x01": // ^A
      case "\x1b[H":
      case "\x1bOH":
      case "\x1b[1~":
      case "\x1b[7~":
        this.cx = 0;
        break;
      case "\x05": // ^E
      case "\x1b[F":
      case "\x1bOF":
      case "\x1b[4~":
      case "\x1b[8~":
        this.cx = this.lines[this.cy].length;
        break;
      case "\x19": // ^Y
      case "\x1b[5~":
        this.movePage(-1);
        break;
      case "\x16": // ^V
      case "\x1b[6~":
        this.movePage(1);
        break;
      case "\x1b\\":
      case "\x1b[1;5H":
        this.cy = 0;
        this.cx = 0;
        break;
      case "\x1b/":
      case "\x1b[1;5F":
        this.cy = this.lines.length - 1;
        this.cx = this.lines[this.cy].length;
        break;

      // Bearbeiten
      case "\r":
        this.edit("newline", () => this.insertText("\n"));
        break;
      case "\t":
        this.edit("type", () => this.insertText("\t"));
        break;
      case "\x7f":
      case "\x08": // ^H
        this.edit("delete", () => this.backspace());
        break;
      case "\x04": // ^D
      case "\x1b[3~":
        this.edit("delete", () => this.deleteForward());
        break;
      case "\x0b": // ^K
      case "\x1b[20~": // F9
        this.cutLine();
        break;
      case "\x1b6": // M-6
      case "\x1b^":
        this.copyLine();
        break;
      case "\x15": // ^U
      case "\x1b[21~": // F10
        this.paste();
        break;
      case "\x1bu":
      case "\x1bU":
        this.undo();
        break;
      case "\x1be":
      case "\x1bE":
        this.redo();
        break;

      // Datei
      case "\x0f": // ^O
      case "\x1bOR": // F3
        this.writeOutPrompt(false);
        break;
      case "\x13": // ^S
        if (this.filename) await this.save(this.filename, false);
        else this.writeOutPrompt(false);
        break;
      case "\x18": // ^X
      case "\x1bOQ": // F2
        this.exit();
        break;
      case "\x12": // ^R
      case "\x1b[2~": // Insert
        this.readFilePrompt();
        break;

      // Suchen & Ersetzen
      case "\x17": // ^W
      case "\x06": // ^F
      case "\x1b[17~": // F6
        this.searchPrompt(1);
        break;
      case "\x02": // ^B
        this.searchPrompt(-1);
        break;
      case "\x1bw":
      case "\x1bW":
        this.findNext(1);
        break;
      case "\x1bq":
      case "\x1bQ":
        this.findNext(-1);
        break;
      case "\x1c": // ^\
      case "\x1br":
      case "\x1bR":
        this.replacePrompt();
        break;

      // Sonstiges
      case "\x07": // ^G
      case "\x1bOP": // F1
        this.helpTop = 0;
        break;
      case "\x03": // ^C
      case "\x1b[23~": // F11
        this.showLocation();
        break;
      case "\x1f": // ^_
      case "\x1bg":
      case "\x1bG":
        this.goToPrompt();
        break;
      case "\x1bn":
      case "\x1bN":
      case "\x1b#":
        this.lineNumbers = !this.lineNumbers;
        this.setMessage(`Line numbering ${this.lineNumbers ? "enabled" : "disabled"}`);
        break;
      case "\x0c": // ^L
        this.host.write("\x1b[2J");
        break;
      default:
        if (PRINTABLE.test(key)) {
          this.edit("type", () => this.insertText(key));
        } else if (key.startsWith("\x1b")) {
          // unbekannte Funktionstaste: ignorieren
        } else {
          this.setMessage("Unknown sequence");
        }
    }

    if (this.syncPreferredColAfter) {
      this.preferredCol = this.displayCol(this.lines[this.cy], this.cx);
    }
    this.syncPreferredColAfter = false;
  }

  private syncPreferredColAfter = false;

  // ───────────────────────────── Bewegung ─────────────────────────────

  private moveVertical(delta: number): void {
    const target = Math.max(0, Math.min(this.lines.length - 1, this.cy + delta));
    if (target === this.cy) return;
    this.cy = target;
    this.cx = this.indexForCol(this.lines[this.cy], this.preferredCol);
  }

  private movePage(direction: number): void {
    const height = this.editHeight();
    const step = Math.max(1, height - 2);
    const newCy = Math.max(0, Math.min(this.lines.length - 1, this.cy + direction * step));
    this.top = Math.max(0, Math.min(Math.max(0, this.lines.length - 1), this.top + direction * step));
    this.cy = newCy;
    this.cx = this.indexForCol(this.lines[this.cy], this.preferredCol);
    this.syncPreferredColAfter = false;
  }

  private moveLeft(): void {
    if (this.cx > 0) {
      this.cx = previousGraphemeStart(this.lines[this.cy], this.cx);
    } else if (this.cy > 0) {
      this.cy--;
      this.cx = this.lines[this.cy].length;
    }
  }

  private moveRight(): void {
    const line = this.lines[this.cy];
    if (this.cx < line.length) {
      this.cx = nextGraphemeEnd(line, this.cx);
    } else if (this.cy < this.lines.length - 1) {
      this.cy++;
      this.cx = 0;
    }
  }

  private moveWord(direction: -1 | 1): void {
    const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);
    if (direction === 1) {
      let line = this.lines[this.cy];
      // aktuelles Wort überspringen
      while (this.cx < line.length && isWord(line[this.cx])) this.cx++;
      // Nicht-Wort-Zeichen (auch über Zeilenenden) überspringen
      for (;;) {
        while (this.cx < line.length && !isWord(line[this.cx])) this.cx++;
        if (this.cx < line.length || this.cy >= this.lines.length - 1) break;
        this.cy++;
        this.cx = 0;
        line = this.lines[this.cy];
      }
    } else {
      let line = this.lines[this.cy];
      for (;;) {
        while (this.cx > 0 && !isWord(line[this.cx - 1])) this.cx--;
        if (this.cx > 0 || this.cy === 0) break;
        this.cy--;
        line = this.lines[this.cy];
        this.cx = line.length;
      }
      while (this.cx > 0 && isWord(line[this.cx - 1])) this.cx--;
    }
  }

  private goTo(line: number, column: number): void {
    const total = this.lines.length;
    let y = line < 0 ? total + line : line - 1;
    y = Math.max(0, Math.min(total - 1, y));
    this.cy = y;
    const text = this.lines[y];
    this.cx = Math.max(0, Math.min(text.length, column < 0 ? text.length + column + 1 : column - 1));
    this.preferredCol = this.displayCol(text, this.cx);
    this.top = Math.max(0, y - Math.floor(this.editHeight() / 2));
  }

  // ───────────────────────────── Bearbeitung ─────────────────────────────

  private snapshot(): Snapshot {
    return { lines: this.lines.slice(), cy: this.cy, cx: this.cx, modified: this.modified };
  }

  private restore(s: Snapshot): void {
    this.lines = s.lines.slice();
    this.cy = s.cy;
    this.cx = s.cx;
    this.modified = s.modified;
  }

  /** Führt eine Änderung aus und legt bei Bedarf einen Undo-Punkt an. */
  private edit(kind: string, change: () => void): boolean {
    if (this.viewOnly) {
      this.setMessage("Key is invalid in view mode");
      return false;
    }
    if (kind !== this.lastEditKind || kind === "newline" || kind === "paste" || kind === "cut") {
      this.undoStack.push(this.snapshot());
      if (this.undoStack.length > 500) this.undoStack.shift();
    }
    this.lastEditKind = kind === "newline" ? null : kind;
    this.redoStack = [];
    const before = this.lines.join("\n");
    change();
    if (this.lines.join("\n") !== before) this.modified = true;
    return true;
  }

  private insertText(text: string): void {
    const line = this.lines[this.cy];
    const head = line.slice(0, this.cx);
    const tail = line.slice(this.cx);
    const parts = text.split("\n");
    if (parts.length === 1) {
      this.lines[this.cy] = head + text + tail;
      this.cx += text.length;
      return;
    }
    const newLines = [head + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + tail];
    this.lines.splice(this.cy, 1, ...newLines);
    this.cy += parts.length - 1;
    this.cx = parts[parts.length - 1].length;
  }

  private backspace(): void {
    if (this.cx > 0) {
      const line = this.lines[this.cy];
      const start = previousGraphemeStart(line, this.cx);
      this.lines[this.cy] = line.slice(0, start) + line.slice(this.cx);
      this.cx = start;
    } else if (this.cy > 0) {
      const prev = this.lines[this.cy - 1];
      this.lines[this.cy - 1] = prev + this.lines[this.cy];
      this.lines.splice(this.cy, 1);
      this.cy--;
      this.cx = prev.length;
    }
  }

  private deleteForward(): void {
    const line = this.lines[this.cy];
    if (this.cx < line.length) {
      const end = nextGraphemeEnd(line, this.cx);
      this.lines[this.cy] = line.slice(0, this.cx) + line.slice(end);
    } else if (this.cy < this.lines.length - 1) {
      this.lines[this.cy] = line + this.lines[this.cy + 1];
      this.lines.splice(this.cy + 1, 1);
    }
  }

  private cutLine(): void {
    const append = this.lastWasCut;
    const ok = this.edit("cut", () => {
      const [removed] = this.lines.splice(this.cy, 1);
      if (this.lines.length === 0) this.lines = [""];
      // Die letzte Zeile ohne Inhalt wird nur geleert (wie nanos "magic line").
      this.cutBuffer = append ? [...this.cutBuffer, removed] : [removed];
      if (this.cy >= this.lines.length) this.cy = this.lines.length - 1;
      this.cx = 0;
    });
    if (ok) this.lastWasCut = true;
  }

  private copyLine(): void {
    this.cutBuffer = this.lastWasCut ? [...this.cutBuffer, this.lines[this.cy]] : [this.lines[this.cy]];
    this.lastWasCut = true;
    if (this.cy < this.lines.length - 1) {
      this.cy++;
      this.cx = 0;
    }
    this.setMessage(`Copied ${plural(this.cutBuffer.length, "line")}`);
  }

  private paste(): void {
    if (this.cutBuffer.length === 0) {
      this.setMessage("Cutbuffer is empty");
      return;
    }
    this.edit("paste", () => this.insertText(this.cutBuffer.join("\n") + "\n"));
  }

  private undo(): void {
    const s = this.undoStack.pop();
    if (!s) {
      this.setMessage("Nothing to undo");
      return;
    }
    this.redoStack.push(this.snapshot());
    this.restore(s);
    this.lastEditKind = null;
    this.setMessage("Undid action");
  }

  private redo(): void {
    const s = this.redoStack.pop();
    if (!s) {
      this.setMessage("Nothing to redo");
      return;
    }
    this.undoStack.push(this.snapshot());
    this.restore(s);
    this.lastEditKind = null;
    this.setMessage("Redid action");
  }

  // ───────────────────────────── Dateien ─────────────────────────────

  private splitLines(content: string): string[] {
    const normalized = content.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  private bufferContent(): string {
    if (this.lines.length === 1 && this.lines[0] === "") return "";
    return this.lines.join("\n") + "\n";
  }

  private async save(name: string, thenExit: boolean): Promise<boolean> {
    const path = this.host.resolvePath(name);
    try {
      if (await this.host.isDirectory(path)) {
        this.setMessage(`Error writing ${name}: Is a directory`);
        return false;
      }
      const parent = path.slice(0, path.lastIndexOf("/")) || "/";
      if (!(await this.host.isDirectory(parent))) {
        this.setMessage(`Error writing ${name}: No such file or directory`);
        return false;
      }
      await this.host.writeFile(path, this.bufferContent());
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.setMessage(`Error writing ${name}: ${reason.replace(/^\w+:\s*/, "")}`);
      return false;
    }
    this.filename = name;
    this.modified = false;
    const count = this.bufferContent() === "" ? 0 : this.lines.length;
    this.setMessage(`Wrote ${plural(count, "line")}`);
    if (thenExit) this.close();
    return true;
  }

  private writeOutPrompt(thenExit: boolean): void {
    this.openPrompt("File Name to Write", this.filename, async (value) => {
      const name = value.trim();
      if (!name) {
        this.setMessage("Cancelled");
        return;
      }
      await this.save(name, thenExit);
    });
  }

  private exit(): void {
    if (!this.modified || this.viewOnly) {
      this.close();
      return;
    }
    this.question = {
      label: "Save modified buffer?",
      shortcuts: YES_NO_SHORTCUTS,
      answers: {
        y: () => this.writeOutPrompt(true),
        n: () => this.close(),
      },
      onCancel: () => this.setMessage("Cancelled"),
    };
  }

  private readFilePrompt(): void {
    if (this.viewOnly) {
      this.setMessage("Key is invalid in view mode");
      return;
    }
    this.openPrompt("File to insert [from ./]", "", async (value) => {
      const name = value.trim();
      if (!name) {
        this.setMessage("Cancelled");
        return;
      }
      const path = this.host.resolvePath(name);
      if (await this.host.isDirectory(path)) {
        this.setMessage(`"${name}" is a directory`);
        return;
      }
      const content = await this.host.readFile(path);
      if (content === null) {
        this.setMessage(`File "${name}" not found`);
        return;
      }
      const inserted = this.splitLines(content);
      this.edit("paste", () => this.insertText(inserted.join("\n")));
      this.setMessage(`Read ${plural(inserted.length, "line")}`);
    });
  }

  // ───────────────────────────── Suchen ─────────────────────────────

  private searchPrompt(direction: 1 | -1): void {
    const label =
      (direction === 1 ? "Search" : "Search Backwards") +
      (this.lastSearch ? ` [${this.lastSearch}]` : "");
    this.openPrompt(label, "", (value) => {
      const term = value || this.lastSearch;
      if (!term) {
        this.setMessage("Cancelled");
        return;
      }
      this.lastSearch = term;
      this.findNext(direction);
    });
  }

  /** Sucht ab der Cursorposition; liefert die Fundstelle oder null. */
  private find(
    term: string,
    fromY: number,
    fromX: number,
    direction: 1 | -1,
    wrap = true,
  ): { y: number; x: number; wrapped: boolean } | null {
    const total = this.lines.length;
    for (let step = 0; step <= total; step++) {
      const rawY = fromY + step * direction;
      const wrapped = rawY < 0 || rawY >= total;
      if (wrapped && !wrap) return null;
      const y = ((rawY % total) + total) % total;
      const line = this.lines[y];
      let x: number;
      if (direction === 1) {
        x = line.indexOf(term, step === 0 ? fromX : 0);
      } else {
        const limit = step === 0 ? fromX - 1 : line.length;
        x = limit < 0 ? -1 : line.lastIndexOf(term, limit);
      }
      if (x >= 0) {
        if (step === total && !(direction === 1 ? x < fromX : x > fromX)) continue;
        return { y, x, wrapped };
      }
    }
    return null;
  }

  private findNext(direction: 1 | -1): void {
    if (!this.lastSearch) {
      this.setMessage("No current search pattern");
      return;
    }
    const startX = direction === 1 ? this.cx + 1 : this.cx;
    const hit = this.find(this.lastSearch, this.cy, startX, direction);
    if (!hit) {
      this.setMessage(`"${this.lastSearch}" not found`);
      return;
    }
    if (hit.y === this.cy && hit.x === this.cx) {
      this.setMessage("This is the only occurrence");
    } else if (hit.wrapped) {
      this.setMessage("Search Wrapped");
    }
    this.cy = hit.y;
    this.cx = hit.x;
    this.preferredCol = this.displayCol(this.lines[this.cy], this.cx);
  }

  private replacePrompt(): void {
    if (this.viewOnly) {
      this.setMessage("Key is invalid in view mode");
      return;
    }
    const label = "Search (to replace)" + (this.lastSearch ? ` [${this.lastSearch}]` : "");
    this.openPrompt(label, "", (value) => {
      const term = value || this.lastSearch;
      if (!term) {
        this.setMessage("Cancelled");
        return;
      }
      this.lastSearch = term;
      this.openPrompt(
        "Replace with" + (this.lastReplace ? ` [${this.lastReplace}]` : ""),
        "",
        (replacement) => {
          const repl = replacement || this.lastReplace;
          this.lastReplace = repl;
          this.undoStack.push(this.snapshot());
          this.redoStack = [];
          this.lastEditKind = null;
          this.replaceSession(term, repl);
        },
      );
    });
  }

  /**
   * Interaktives Ersetzen wie in nano: ab dem Cursor bis zum Dateiende,
   * danach vom Dateianfang bis zur Startposition.
   */
  private replaceSession(term: string, repl: string): void {
    const origin = { y: this.cy, x: this.cx };
    let pos = { y: this.cy, x: this.cx };
    let wrapped = false;
    let found = false;
    let count = 0;

    const nextHit = () => {
      if (!wrapped) {
        const hit = this.find(term, pos.y, pos.x, 1, false);
        if (hit) return hit;
        wrapped = true;
        pos = { y: 0, x: 0 };
      }
      const hit = this.find(term, pos.y, pos.x, 1, false);
      if (!hit) return null;
      if (hit.y > origin.y || (hit.y === origin.y && hit.x + term.length > origin.x)) return null;
      return hit;
    };

    const doReplace = (hit: { y: number; x: number }) => {
      const line = this.lines[hit.y];
      this.lines[hit.y] = line.slice(0, hit.x) + repl + line.slice(hit.x + term.length);
      if (wrapped && hit.y === origin.y) origin.x += repl.length - term.length;
      this.cy = hit.y;
      this.cx = hit.x + repl.length;
      pos = { y: this.cy, x: this.cx };
      count++;
    };

    const finish = () => {
      this.highlight = null;
      if (!found) {
        this.undoStack.pop();
        this.setMessage(`"${term}" not found`);
        return;
      }
      if (count > 0) this.modified = true;
      else this.undoStack.pop();
      this.setMessage(`Replaced ${plural(count, "occurrence")}`);
    };

    const step = (all: boolean): void => {
      for (;;) {
        const hit = nextHit();
        if (!hit) return finish();
        found = true;
        if (all) {
          doReplace(hit);
          continue;
        }
        this.cy = hit.y;
        this.cx = hit.x;
        this.highlight = { y: hit.y, start: hit.x, end: hit.x + term.length };
        this.question = {
          label: "Replace this instance?",
          shortcuts: YES_NO_ALL_SHORTCUTS,
          answers: {
            y: () => {
              doReplace(hit);
              step(false);
            },
            n: () => {
              pos = { y: hit.y, x: hit.x + 1 };
              step(false);
            },
            a: () => {
              doReplace(hit);
              step(true);
            },
          },
          onCancel: finish,
        };
        return;
      }
    };

    step(false);
  }

  // ───────────────────────────── Sonstiges ─────────────────────────────

  private showLocation(): void {
    const line = this.lines[this.cy];
    const totalLines = this.lines.length;
    const col = this.displayCol(line, this.cx) + 1;
    const cols = this.displayCol(line, line.length) + 1;
    let charPos = 0;
    for (let i = 0; i < this.cy; i++) charPos += this.lines[i].length + 1;
    charPos += this.cx;
    const totalChars = this.bufferContent().length;
    const pct = (a: number, b: number) => Math.floor((100 * a) / Math.max(1, b));
    this.setMessage(
      `line ${this.cy + 1}/${totalLines} (${pct(this.cy + 1, totalLines)}%), ` +
        `col ${col}/${cols} (${pct(col, cols)}%), ` +
        `char ${charPos}/${totalChars} (${pct(charPos, totalChars)}%)`,
    );
  }

  private goToPrompt(): void {
    this.openPrompt("Enter line number, column number", "", (value) => {
      const m = /^\s*(-?\d+)?\s*(?:[,\s]\s*(-?\d+))?\s*$/.exec(value);
      if (!m || (!m[1] && !m[2])) {
        this.setMessage("Invalid line or column number");
        return;
      }
      this.goTo(m[1] ? parseInt(m[1], 10) : this.cy + 1, m[2] ? parseInt(m[2], 10) : 1);
    });
  }

  private setMessage(text: string): void {
    this.message = text;
    this.messageAge = 2;
  }

  // ───────────────────────────── Prompt / Fragen / Hilfe ─────────────────────────────

  private openPrompt(
    label: string,
    initial: string,
    onSubmit: (value: string) => void | Promise<void>,
  ): void {
    this.prompt = {
      label,
      value: initial,
      cursor: initial.length,
      shortcuts: CANCEL_SHORTCUTS,
      onSubmit,
    };
  }

  private async handlePromptKey(key: string): Promise<void> {
    const p = this.prompt!;
    switch (key) {
      case "\r": {
        this.prompt = null;
        await p.onSubmit(p.value);
        return;
      }
      case "\x03":
      case "\x1b":
        this.prompt = null;
        p.onCancel?.();
        this.setMessage("Cancelled");
        return;
      case "\x07":
      case "\x1bOP":
        this.prompt = null;
        this.helpTop = 0;
        return;
      case "\x7f":
      case "\x08":
        if (p.cursor > 0) {
          const start = previousGraphemeStart(p.value, p.cursor);
          p.value = p.value.slice(0, start) + p.value.slice(p.cursor);
          p.cursor = start;
        }
        return;
      case "\x04":
      case "\x1b[3~":
        if (p.cursor < p.value.length) {
          p.value = p.value.slice(0, p.cursor) + p.value.slice(nextGraphemeEnd(p.value, p.cursor));
        }
        return;
      case "\x1b[D":
      case "\x1bOD":
        p.cursor = previousGraphemeStart(p.value, p.cursor);
        return;
      case "\x1b[C":
      case "\x1bOC":
        if (p.cursor < p.value.length) p.cursor = nextGraphemeEnd(p.value, p.cursor);
        return;
      case "\x01":
      case "\x1b[H":
      case "\x1bOH":
      case "\x1b[1~":
        p.cursor = 0;
        return;
      case "\x05":
      case "\x1b[F":
      case "\x1bOF":
      case "\x1b[4~":
        p.cursor = p.value.length;
        return;
      case "\x15": // ^U: Eingabe leeren
        p.value = "";
        p.cursor = 0;
        return;
      default:
        if (PRINTABLE.test(key) || key === "\t") {
          p.value = p.value.slice(0, p.cursor) + key + p.value.slice(p.cursor);
          p.cursor += key.length;
        }
    }
  }

  private async handleQuestionKey(key: string): Promise<void> {
    const q = this.question!;
    if (key === "\x03" || key === "\x1b") {
      this.question = null;
      q.onCancel();
      return;
    }
    const answer = q.answers[key.toLowerCase()];
    if (answer) {
      this.question = null;
      await answer();
    }
  }

  private handleHelpKey(key: string): void {
    const helpLines = HELP_TEXT.split("\n");
    const height = this.editHeight();
    const maxTop = Math.max(0, helpLines.length - height);
    switch (key) {
      case "\x18":
      case "\x07":
      case "q":
      case "Q":
      case "\x1b":
      case "\x03":
        this.helpTop = -1;
        return;
      case "\x1b[A":
      case "\x10":
        this.helpTop = Math.max(0, this.helpTop - 1);
        return;
      case "\x1b[B":
      case "\x0e":
        this.helpTop = Math.min(maxTop, this.helpTop + 1);
        return;
      case "\x1b[5~":
      case "\x19":
        this.helpTop = Math.max(0, this.helpTop - height);
        return;
      case "\x1b[6~":
      case "\x16":
      case " ":
        this.helpTop = Math.min(maxTop, this.helpTop + height);
        return;
    }
  }

  // ───────────────────────────── Darstellung ─────────────────────────────

  private editHeight(): number {
    return Math.max(1, this.host.size().rows - 4);
  }

  private gutterWidth(): number {
    return this.lineNumbers ? String(this.lines.length).length + 1 : 0;
  }

  /** Breite eines Graphems an Spalte `col` (Tabs, Steuerzeichen). */
  private cellsFor(seg: string, col: number): { text: string; width: number } {
    if (seg === "\t") {
      const width = this.tabSize - (col % this.tabSize);
      return { text: " ".repeat(width), width };
    }
    const code = seg.codePointAt(0)!;
    if (seg.length === 1 && (code < 0x20 || code === 0x7f)) {
      return { text: "^" + (code === 0x7f ? "?" : String.fromCharCode(code + 64)), width: 2 };
    }
    return { text: seg, width: stringWidth(seg) };
  }

  private displayCol(line: string, index: number): number {
    let col = 0;
    for (const { segment, index: i } of graphemes.segment(line)) {
      if (i >= index) break;
      col += this.cellsFor(segment, col).width;
    }
    return col;
  }

  private indexForCol(line: string, target: number): number {
    let col = 0;
    for (const { segment, index } of graphemes.segment(line)) {
      const w = this.cellsFor(segment, col).width;
      if (col + w > target) return index;
      col += w;
    }
    return line.length;
  }

  /** Startspalte für horizontales Scrollen der Cursorzeile (wie nano: seitenweise). */
  private pageStart(col: number, width: number): number {
    if (width < 3 || col < width - 1) return 0;
    const chunk = Math.max(1, width - 8);
    let start = 0;
    while (col - start >= width - 1) start += chunk;
    return start;
  }

  /**
   * Rendert eine Textzeile ab Spalte `start` in `width` Zellen.
   * Liefert die fertige Ausgabe (mit SGR-Sequenzen für Hervorhebungen).
   */
  private renderLine(
    line: string,
    start: number,
    width: number,
    hl: { start: number; end: number } | null,
  ): string {
    type Cell = { ch: string; hl: boolean };
    const cells: Cell[] = [];
    let col = 0;
    let overflow = false;
    const end = start + width;
    for (const { segment, index } of graphemes.segment(line)) {
      const { text, width: w } = this.cellsFor(segment, col);
      const highlighted = !!hl && index >= hl.start && index < hl.end;
      if (col + w <= start) {
        col += w;
        continue;
      }
      if (col + w > end) {
        overflow = true;
        break;
      }
      if (col < start) {
        // teilweise sichtbares breites Zeichen/Tab
        for (let c = start; c < col + w; c++) cells.push({ ch: " ", hl: highlighted });
      } else if (segment === "\t" || text.length === w) {
        // Tabs und einfache Zeichen: ein Zeichen pro Zelle
        if (w === 0) {
          if (cells.length) cells[cells.length - 1].ch += text;
        } else if (segment === "\t" || /^\^.$/.test(text)) {
          for (const c of text) cells.push({ ch: c, hl: highlighted });
        } else {
          cells.push({ ch: text, hl: highlighted });
          for (let k = 1; k < w; k++) cells.push({ ch: "", hl: highlighted });
        }
      } else {
        if (w === 0) {
          if (cells.length) cells[cells.length - 1].ch += text;
        } else {
          cells.push({ ch: text, hl: highlighted });
          for (let k = 1; k < w; k++) cells.push({ ch: "", hl: highlighted });
        }
      }
      col += w;
    }
    if (start > 0 && cells.length > 0) {
      cells[0] = { ch: "<", hl: false };
      if (cells[1]?.ch === "") cells[1] = { ch: " ", hl: false };
    }
    if (overflow) {
      while (cells.length < width) cells.push({ ch: " ", hl: false });
      const last = width - 1;
      if (cells[last].ch === "") {
        // breites Zeichen in den letzten beiden Zellen
        let k = last - 1;
        while (k > 0 && cells[k].ch === "") k--;
        cells[k] = { ch: " ", hl: false };
        for (let j = k + 1; j < last; j++) cells[j] = { ch: " ", hl: false };
      }
      cells[last] = { ch: ">", hl: false };
    }
    let out = "";
    let inHl = false;
    for (const cell of cells) {
      if (cell.hl !== inHl) {
        out += cell.hl ? INVERSE : RESET;
        inHl = cell.hl;
      }
      out += cell.ch;
    }
    if (inHl) out += RESET;
    return out;
  }

  private fit(text: string, width: number): string {
    let out = "";
    let w = 0;
    for (const { segment } of graphemes.segment(text)) {
      const sw = stringWidth(segment);
      if (w + sw > width) break;
      out += segment;
      w += sw;
    }
    return out + " ".repeat(Math.max(0, width - w));
  }

  private titleBar(cols: number): string {
    const left = `  ${VERSION_LABEL}`;
    const name = this.filename ? basename(this.filename) : "New Buffer";
    const right = this.modified ? "Modified  " : this.viewOnly ? "View  " : "";
    let line = this.fit(left, cols);
    const chars = Array.from(line);
    const nameStart = Math.max(left.length + 2, Math.floor((cols - stringWidth(name)) / 2));
    const place = (text: string, at: number) => {
      const arr = Array.from(text);
      for (let i = 0; i < arr.length && at + i < chars.length; i++) chars[at + i] = arr[i];
    };
    if (nameStart < cols) place(name, nameStart);
    if (right) place(right, Math.max(0, cols - right.length));
    line = chars.join("");
    return INVERSE + this.fit(line, cols) + RESET;
  }

  private shortcutRows(rows: [string, string][][], cols: number): string[] {
    const perRow = 6;
    const itemWidth = Math.max(1, Math.floor(cols / perRow));
    return [0, 1].map((r) => {
      const items = rows[r] ?? [];
      let out = "";
      let used = 0;
      for (const [key, label] of items) {
        if (used + itemWidth > cols) break;
        const keyText = key.length < 2 ? key.padEnd(2) : key;
        // mindestens ein Leerzeichen Abstand zum nächsten Eintrag
        const labelText =
          this.fit(" " + label, Math.max(0, itemWidth - keyText.length - 1)) + " ";
        out += INVERSE + keyText + RESET + labelText;
        used += itemWidth;
      }
      return out;
    });
  }

  render(): void {
    if (this.closed) return;
    const { cols, rows } = this.host.size();
    const height = this.editHeight();
    const gutter = this.gutterWidth();
    const textWidth = Math.max(1, cols - gutter);

    // Viewport an Cursor anpassen
    if (this.cy < this.top) this.top = this.cy;
    if (this.cy >= this.top + height) this.top = this.cy - height + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.lines.length - 1)));

    let out = "\x1b[?25l" + RESET;
    // Titelzeile
    out += "\x1b[1;1H" + this.titleBar(cols);

    let cursorRow = 2;
    let cursorCol = 1;

    if (this.helpTop >= 0) {
      const helpLines = HELP_TEXT.split("\n");
      for (let i = 0; i < height; i++) {
        const text = helpLines[this.helpTop + i] ?? "";
        out += `\x1b[${i + 2};1H` + this.fit(text, cols).trimEnd() + "\x1b[K";
      }
    } else {
      const cursorLineCol = this.displayCol(this.lines[this.cy], this.cx);
      for (let i = 0; i < height; i++) {
        const y = this.top + i;
        out += `\x1b[${i + 2};1H`;
        if (y < this.lines.length) {
          if (gutter) {
            out += "\x1b[2m" + String(y + 1).padStart(gutter - 1) + " " + RESET;
          }
          const start = y === this.cy ? this.pageStart(cursorLineCol, textWidth) : 0;
          const hl = this.highlight && this.highlight.y === y ? this.highlight : null;
          out += this.renderLine(this.lines[y], start, textWidth, hl);
          if (y === this.cy) {
            cursorRow = i + 2;
            cursorCol = gutter + cursorLineCol - start + 1;
          }
        }
        out += "\x1b[K";
      }
    }

    // Statuszeile
    out += `\x1b[${rows - 2};1H`;
    let shortcuts = MAIN_SHORTCUTS;
    if (this.prompt) {
      const p = this.prompt;
      const prefix = `${p.label}: `;
      const promptWidth = cols - stringWidth(prefix);
      const caret = stringWidth(p.value.slice(0, p.cursor));
      const start = caret >= promptWidth - 1 ? caret - promptWidth + 2 : 0;
      let visible = "";
      let w = 0;
      for (const { segment } of graphemes.segment(p.value)) {
        const sw = stringWidth(segment);
        if (w >= start && w + sw - start <= promptWidth) visible += segment;
        w += sw;
      }
      out += INVERSE + this.fit(prefix + visible, cols) + RESET;
      cursorRow = rows - 2;
      cursorCol = Math.min(cols, stringWidth(prefix) + caret - start + 1);
      shortcuts = p.shortcuts;
    } else if (this.question) {
      const label = this.question.label + " ";
      out += INVERSE + this.fit(label, cols) + RESET;
      cursorRow = rows - 2;
      cursorCol = Math.min(cols, stringWidth(label) + 1);
      shortcuts = this.question.shortcuts;
    } else if (this.helpTop >= 0) {
      out += "\x1b[K";
      shortcuts = [
        [
          ["^X", "Close"],
          ["^Y", "Prev Page"],
        ],
        [
          [" q", "Close"],
          ["^V", "Next Page"],
        ],
      ];
    } else if (this.message) {
      const text = `[ ${this.message} ]`;
      const pad = Math.max(0, Math.floor((cols - stringWidth(text)) / 2));
      out += " ".repeat(pad) + INVERSE + this.fit(text, Math.min(cols, stringWidth(text))) + RESET + "\x1b[K";
    } else {
      out += "\x1b[K";
    }

    // Tastenkürzel
    const help = this.shortcutRows(shortcuts, cols);
    out += `\x1b[${rows - 1};1H${help[0]}\x1b[K`;
    out += `\x1b[${rows};1H${help[1]}\x1b[K`;

    out += `\x1b[${cursorRow};${Math.max(1, cursorCol)}H`;
    if (this.helpTop < 0) out += "\x1b[?25h";
    this.host.write(out);
  }
}

/** Zerlegt eine Kommandozeile in Wörter (einfache Shell-Quoting-Regeln). */
export function splitArgs(input: string): string[] | null {
  const args: string[] = [];
  let current = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < input.length) current += input[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      current += input[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) args.push(current);
      current = "";
      has = false;
    } else {
      current += ch;
      has = true;
    }
  }
  if (quote) return null;
  if (has) args.push(current);
  return args;
}

export interface ParsedNanoArgs {
  options: NanoOptions;
  error?: string;
  help?: boolean;
  version?: boolean;
}

/** Wertet die von der nano-Emulation unterstützten Kommandozeilenoptionen aus. */
export function parseNanoArgs(args: string[]): ParsedNanoArgs {
  const options: NanoOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const pos = /^\+(-?\d+)?(?:,(-?\d+))?$/.exec(arg);
    if (pos && (pos[1] || pos[2])) {
      if (pos[1]) options.line = parseInt(pos[1], 10);
      if (pos[2]) options.column = parseInt(pos[2], 10);
    } else if (arg === "-l" || arg === "--linenumbers") {
      options.lineNumbers = true;
    } else if (arg === "-v" || arg === "--view") {
      options.viewOnly = true;
    } else if (arg === "-h" || arg === "--help") {
      return { options, help: true };
    } else if (arg === "-V" || arg === "--version") {
      return { options, version: true };
    } else if (/^-T\d+$/.test(arg) || /^--tabsize=\d+$/.test(arg)) {
      options.tabSize = Math.max(1, parseInt(arg.replace(/\D/g, ""), 10));
    } else if (arg === "-T" || arg === "--tabsize") {
      const v = parseInt(args[++i] ?? "", 10);
      if (!(v > 0)) return { options, error: "nano: requested tab size is invalid" };
      options.tabSize = v;
    } else if (arg === "--") {
      if (args[i + 1] !== undefined) options.file = args[i + 1];
      break;
    } else if (arg.startsWith("-") && arg !== "-") {
      return { options, error: `nano: invalid option -- '${arg.replace(/^-+/, "")}'` };
    } else if (options.file === undefined) {
      options.file = arg;
    }
  }
  return { options };
}

export const NANO_USAGE = `Usage: nano [OPTIONS] [[+LINE[,COLUMN]] FILE]

 +LINE[,COLUMN]          Start at line LINE, column COLUMN
 -l, --linenumbers       Show line numbers in front of the text
 -T, --tabsize=<number>  Make a tab this number of columns wide
 -v, --view              View mode (read-only)
 -h, --help              Show this help text and exit
 -V, --version           Print version information and exit
`;

export const NANO_VERSION = ` ${VERSION_LABEL} — eine nano-Emulation für wterm/just-bash
`;

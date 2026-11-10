/**
 * Einfacher Zeileneditor für interaktive Programme (z. B. Python-REPL, input()).
 *
 * Arbeitet nur mit relativen Cursorbewegungen ab der aktuellen Position, damit
 * er auch nach bereits ausgegebenem Text (z. B. einem input()-Prompt) funktioniert.
 */
import stringWidth from "string-width";

export type LineResult =
  | { type: "line"; text: string }
  | { type: "interrupt" }
  | { type: "eof" };

export interface ReadLineOptions {
  /** Verlauf für Pfeil hoch/runter (wird nicht verändert). */
  history?: string[];
  /** Tab fügt diese Zeichen ein (Standard: 4 Leerzeichen). */
  tab?: string;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const PRINTABLE = /^[^\p{Cc}]+$/u;

function prevStart(text: string, i: number): number {
  return i <= 0 ? 0 : (graphemes.segment(text).containing(i - 1)?.index ?? 0);
}

function nextEnd(text: string, i: number): number {
  const seg = graphemes.segment(text).containing(i);
  return seg ? seg.index + seg.segment.length : text.length;
}

export class LineReader {
  private line = "";
  private cursor = 0;
  private historyPos = -1;
  private draft = "";
  private done = false;
  private resolve!: (r: LineResult) => void;
  readonly result: Promise<LineResult>;

  constructor(
    private readonly write: (data: string) => void,
    private readonly options: ReadLineOptions = {},
  ) {
    this.result = new Promise((r) => (this.resolve = r));
  }

  get finished(): boolean {
    return this.done;
  }

  private finish(r: LineResult): void {
    this.done = true;
    this.resolve(r);
  }

  private move(width: number, dir: "C" | "D"): void {
    if (width > 0) this.write(`\x1b[${width}${dir}`);
  }

  private replaceLine(text: string): void {
    this.move(stringWidth(this.line.slice(0, this.cursor)), "D");
    this.write(text + "\x1b[K");
    this.line = text;
    this.cursor = text.length;
  }

  private insert(text: string): void {
    const tail = this.line.slice(this.cursor);
    this.line = this.line.slice(0, this.cursor) + text + tail;
    this.cursor += text.length;
    this.write(text + tail + (tail ? "\x1b[K" : ""));
    this.move(stringWidth(tail), "D");
  }

  private eraseTo(start: number): void {
    if (start >= this.cursor) return;
    const removedWidth = stringWidth(this.line.slice(start, this.cursor));
    const tail = this.line.slice(this.cursor);
    this.line = this.line.slice(0, start) + tail;
    this.cursor = start;
    this.move(removedWidth, "D");
    this.write(tail + "\x1b[K");
    this.move(stringWidth(tail), "D");
  }

  /**
   * Verarbeitet Eingabedaten. Gibt den nicht verbrauchten Rest zurück, falls
   * die Zeile mitten in den Daten abgeschlossen wurde (z. B. beim Einfügen).
   */
  handleInput(data: string): string {
    let i = 0;
    while (i < data.length && !this.done) {
      // Escape-Sequenzen als Ganzes behandeln
      if (data[i] === "\x1b") {
        const m = /^\x1b(\[[0-9;]*[@-~]|O.|.)?/s.exec(data.slice(i))!;
        this.key(m[0]);
        i += m[0].length;
        continue;
      }
      // zusammenhängenden druckbaren Text auf einmal einfügen
      const m = /^[^\p{Cc}]+/u.exec(data.slice(i));
      if (m) {
        this.insert(m[0]);
        i += m[0].length;
        continue;
      }
      const ch = data[i];
      i++;
      if (ch === "\r" && data[i] === "\n") i++;
      this.key(ch);
    }
    return data.slice(i);
  }

  private key(k: string): void {
    const history = this.options.history ?? [];
    switch (k) {
      case "\r":
      case "\n":
        this.write("\r\n");
        this.finish({ type: "line", text: this.line });
        return;
      case "\x03": // Ctrl+C
        this.write("^C\r\n");
        this.finish({ type: "interrupt" });
        return;
      case "\x04": // Ctrl+D
        if (!this.line) {
          this.write("\r\n");
          this.finish({ type: "eof" });
        } else if (this.cursor < this.line.length) {
          const end = nextEnd(this.line, this.cursor);
          const tail = this.line.slice(end);
          this.line = this.line.slice(0, this.cursor) + tail;
          this.write(tail + "\x1b[K");
          this.move(stringWidth(tail), "D");
        }
        return;
      case "\x7f":
      case "\b":
        this.eraseTo(prevStart(this.line, this.cursor));
        return;
      case "\x1b[3~": {
        if (this.cursor >= this.line.length) return;
        const save = this.cursor;
        this.cursor = nextEnd(this.line, this.cursor);
        this.move(stringWidth(this.line.slice(save, this.cursor)), "C");
        this.eraseTo(save);
        return;
      }
      case "\x15": // Ctrl+U
        this.eraseTo(0);
        return;
      case "\x0b": // Ctrl+K
        this.line = this.line.slice(0, this.cursor);
        this.write("\x1b[K");
        return;
      case "\x1b[D":
      case "\x1bOD":
        if (this.cursor > 0) {
          const start = prevStart(this.line, this.cursor);
          this.move(stringWidth(this.line.slice(start, this.cursor)), "D");
          this.cursor = start;
        }
        return;
      case "\x1b[C":
      case "\x1bOC":
        if (this.cursor < this.line.length) {
          const end = nextEnd(this.line, this.cursor);
          this.move(stringWidth(this.line.slice(this.cursor, end)), "C");
          this.cursor = end;
        }
        return;
      case "\x01":
      case "\x1b[H":
      case "\x1bOH":
        this.move(stringWidth(this.line.slice(0, this.cursor)), "D");
        this.cursor = 0;
        return;
      case "\x05":
      case "\x1b[F":
      case "\x1bOF":
        this.move(stringWidth(this.line.slice(this.cursor)), "C");
        this.cursor = this.line.length;
        return;
      case "\x1b[A":
      case "\x1bOA":
        if (!history.length) return;
        if (this.historyPos < 0) {
          this.draft = this.line;
          this.historyPos = history.length;
        }
        if (this.historyPos > 0) this.replaceLine(history[--this.historyPos]);
        return;
      case "\x1b[B":
      case "\x1bOB":
        if (this.historyPos < 0) return;
        this.historyPos++;
        if (this.historyPos >= history.length) {
          this.historyPos = -1;
          this.replaceLine(this.draft);
        } else {
          this.replaceLine(history[this.historyPos]);
        }
        return;
      case "\t":
        this.insert(this.options.tab ?? "    ");
        return;
      default:
        if (PRINTABLE.test(k)) this.insert(k);
    }
  }
}

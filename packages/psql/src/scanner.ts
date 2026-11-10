/**
 * Zeilenweiser SQL-Scanner wie in psql: erkennt, wann ein Statement mit `;`
 * abgeschlossen ist (unter Beachtung von Strings, Bezeichnern in "…",
 * Dollar-Quoting, Kommentaren und Klammern) und trennt Meta-Befehle (`\…`) ab.
 */

export type ScanItem =
  | { type: "sql"; text: string; line: number }
  | { type: "meta"; text: string; line: number };

type State = "normal" | "squote" | "equote" | "dquote" | "dollar" | "bcomment";

const IDENT = /[A-Za-z0-9_$\u0080-￿]/;

export class SqlScanner {
  /** Noch nicht abgeschlossener Abfragepuffer. */
  buffer = "";
  private state: State = "normal";
  private dollarTag = "";
  private commentDepth = 0;
  private parenDepth = 0;
  /** Zeilennummer (1-basiert) der zuletzt verarbeiteten Zeile. */
  lineNo = 0;

  /** Zeichen für den psql-Prompt: = - ' " $ * ( */
  get promptChar(): string {
    switch (this.state) {
      case "squote":
      case "equote":
        return "'";
      case "dquote":
        return '"';
      case "dollar":
        return "$";
      case "bcomment":
        return "*";
    }
    if (this.parenDepth > 0) return "(";
    return this.buffer.trim() ? "-" : "=";
  }

  get isEmpty(): boolean {
    return !this.buffer.trim() && this.state === "normal";
  }

  reset(): void {
    this.buffer = "";
    this.state = "normal";
    this.dollarTag = "";
    this.commentDepth = 0;
    this.parenDepth = 0;
  }

  /** Verarbeitet eine Eingabezeile (ohne Zeilenumbruch). */
  feedLine(line: string): ScanItem[] {
    this.lineNo++;
    const items: ScanItem[] = [];
    let start = 0; // Beginn des noch nicht übernommenen Teils der Zeile
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1];
      switch (this.state) {
        case "normal": {
          if (ch === "-" && next === "-") {
            i = line.length; // Zeilenkommentar
            continue;
          }
          if (ch === "/" && next === "*") {
            this.state = "bcomment";
            this.commentDepth = 1;
            i += 2;
            continue;
          }
          if (ch === "'") {
            const prev = line[i - 1];
            const prev2 = line[i - 2];
            this.state =
              (prev === "E" || prev === "e") && !(prev2 && IDENT.test(prev2)) ? "equote" : "squote";
            i++;
            continue;
          }
          if (ch === '"') {
            this.state = "dquote";
            i++;
            continue;
          }
          if (ch === "$") {
            const prev = line[i - 1];
            const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(line.slice(i));
            if (m && !(prev && IDENT.test(prev))) {
              this.state = "dollar";
              this.dollarTag = m[0];
              i += m[0].length;
              continue;
            }
          }
          if (ch === "(") this.parenDepth++;
          else if (ch === ")") this.parenDepth = Math.max(0, this.parenDepth - 1);
          else if (ch === ";" && this.parenDepth === 0) {
            const text = this.buffer + line.slice(start, i + 1);
            this.buffer = "";
            items.push({ type: "sql", text, line: this.lineNo });
            start = i + 1;
          } else if (ch === "\\") {
            // Meta-Befehl: Rest der Zeile
            this.append(line.slice(start, i));
            items.push({ type: "meta", text: line.slice(i), line: this.lineNo });
            return items;
          }
          i++;
          continue;
        }
        case "squote":
          if (ch === "'") {
            if (next === "'") i += 2;
            else {
              this.state = "normal";
              i++;
            }
          } else i++;
          continue;
        case "equote":
          if (ch === "\\") i += 2;
          else if (ch === "'") {
            if (next === "'") i += 2;
            else {
              this.state = "normal";
              i++;
            }
          } else i++;
          continue;
        case "dquote":
          if (ch === '"') {
            if (next === '"') i += 2;
            else {
              this.state = "normal";
              i++;
            }
          } else i++;
          continue;
        case "dollar":
          if (line.startsWith(this.dollarTag, i)) {
            i += this.dollarTag.length;
            this.state = "normal";
          } else i++;
          continue;
        case "bcomment":
          if (ch === "/" && next === "*") {
            this.commentDepth++;
            i += 2;
          } else if (ch === "*" && next === "/") {
            this.commentDepth--;
            i += 2;
            if (this.commentDepth === 0) this.state = "normal";
          } else i++;
          continue;
      }
    }
    this.append(line.slice(start) + "\n");
    return items;
  }

  private append(text: string): void {
    // Führende Leerzeilen nicht puffern (Prompt bleibt "=")
    if (!this.buffer && !text.trim() && this.state === "normal") return;
    this.buffer += text;
  }
}

/** Zerlegt einen Meta-Befehl in Befehl und Argumente (psql-ähnliches Quoting). */
export function parseMeta(text: string): { cmd: string; args: string[] } {
  const m = /^\\([^\s\\]*)(.*)$/s.exec(text);
  if (!m) return { cmd: "", args: [] };
  const cmd = m[1];
  const args: string[] = [];
  const rest = m[2];
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i])) i++;
    if (i >= rest.length) break;
    if (rest.startsWith("\\\\", i)) break;
    let arg = "";
    if (rest[i] === "'") {
      i++;
      while (i < rest.length) {
        if (rest[i] === "'" && rest[i + 1] === "'") {
          arg += "'";
          i += 2;
        } else if (rest[i] === "'") {
          i++;
          break;
        } else arg += rest[i++];
      }
    } else if (rest[i] === '"') {
      // Bezeichner in "…" bleiben mit Anführungszeichen erhalten
      const end = rest.indexOf('"', i + 1);
      arg = rest.slice(i, end < 0 ? rest.length : end + 1);
      i = end < 0 ? rest.length : end + 1;
    } else {
      while (i < rest.length && !/\s/.test(rest[i])) arg += rest[i++];
    }
    args.push(arg);
  }
  return { cmd, args };
}

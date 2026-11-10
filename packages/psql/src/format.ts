/**
 * Ausgabeformate von psql: aligned (Standard), unaligned (-A) und expanded (\x).
 */
import stringWidth from "string-width";

export interface Column {
  name: string;
  /** Rechtsbündig (Zahlen)? */
  numeric?: boolean;
}

export interface PrintOptions {
  format: "aligned" | "unaligned";
  expanded: boolean;
  tuplesOnly: boolean;
  nullDisplay: string;
  fieldSep: string;
  title?: string;
  /** Zusätzliche Zeilen unter der Tabelle (z. B. Indexes bei \d). */
  footers?: string[];
  /** Zeilenanzahl "(n rows)" anzeigen. */
  showRowCount?: boolean;
}

/** OIDs numerischer Typen (rechtsbündig wie in psql). */
const NUMERIC_TYPES = new Set([20, 21, 23, 26, 28, 29, 700, 701, 790, 1700]);

export function isNumericType(oid: number): boolean {
  return NUMERIC_TYPES.has(oid);
}

const width = (s: string) => stringWidth(s);

function padRight(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - width(s)));
}

function padLeft(s: string, w: number): string {
  return " ".repeat(Math.max(0, w - width(s))) + s;
}

function center(s: string, w: number): string {
  const total = Math.max(0, w - width(s));
  const left = Math.floor(total / 2);
  return " ".repeat(left) + s + " ".repeat(total - left);
}

function rowCount(n: number): string {
  return `(${n} ${n === 1 ? "row" : "rows"})`;
}

/** Formatiert eine Ergebnistabelle; Rückgabe mit "\n" als Zeilentrenner. */
export function formatTable(columns: Column[], rows: (string | null)[][], opts: PrintOptions): string {
  const cell = (v: string | null) => (v === null ? opts.nullDisplay : v);
  const lines: string[] = [];

  if (opts.format === "unaligned") {
    if (opts.expanded) {
      rows.forEach((row, r) => {
        if (r > 0) lines.push("");
        columns.forEach((c, i) => lines.push(`${c.name}${opts.fieldSep}${cell(row[i])}`));
      });
    } else {
      if (!opts.tuplesOnly) lines.push(columns.map((c) => c.name).join(opts.fieldSep));
      for (const row of rows) lines.push(row.map(cell).join(opts.fieldSep));
    }
    if (!opts.tuplesOnly && opts.showRowCount !== false && !opts.expanded) lines.push(rowCount(rows.length));
    return lines.join("\n") + "\n";
  }

  if (opts.expanded) {
    if (rows.length === 0) {
      if (!opts.tuplesOnly) lines.push("(0 rows)");
      return lines.join("\n") + "\n";
    }
    const nameW = Math.max(...columns.map((c) => width(c.name)));
    const valueW = Math.max(
      1,
      ...rows.flatMap((row) => row.map((v) => Math.max(...cell(v).split("\n").map(width)))),
    );
    if (opts.title && !opts.tuplesOnly) lines.push(center(opts.title, nameW + valueW + 3).trimEnd());
    rows.forEach((row, r) => {
      if (!opts.tuplesOnly) {
        const head = `-[ RECORD ${r + 1} ]`;
        lines.push(head + "-".repeat(Math.max(0, nameW + 1 - head.length)) + "+" + "-".repeat(valueW + 1));
      } else if (r > 0) lines.push("");
      columns.forEach((c, i) => {
        const parts = cell(row[i]).split("\n");
        parts.forEach((p, k) => {
          const name = k === 0 ? padRight(c.name, nameW) : " ".repeat(nameW);
          const more = k < parts.length - 1 ? "+" : "";
          lines.push(`${name} | ${p}${more}`.trimEnd() + (more && !p ? "" : ""));
        });
      });
    });
    return lines.join("\n") + "\n";
  }

  // aligned
  const cells = rows.map((row) => row.map((v) => cell(v).split("\n")));
  const widths = columns.map((c, i) =>
    Math.max(width(c.name), ...cells.map((r) => Math.max(...r[i].map(width)))),
  );
  const totalWidth = widths.reduce((a, w) => a + w + 3, -1);
  if (opts.title && !opts.tuplesOnly) lines.push(center(opts.title, totalWidth).trimEnd());
  if (!opts.tuplesOnly) {
    lines.push(columns.map((c, i) => " " + center(c.name, widths[i]) + " ").join("|").trimEnd());
    lines.push(widths.map((w) => "-".repeat(w + 2)).join("+"));
  }
  for (const row of cells) {
    const height = Math.max(1, ...row.map((parts) => parts.length));
    for (let k = 0; k < height; k++) {
      let line = "";
      row.forEach((parts, i) => {
        const text = parts[k] ?? "";
        const padded = columns[i].numeric ? padLeft(text, widths[i]) : padRight(text, widths[i]);
        // "+" am Ende einer Zelle, die in der nächsten Zeile weitergeht
        const cont = k < parts.length - 1 ? "+" : " ";
        line += (i > 0 ? "|" : "") + " " + padded + cont;
      });
      lines.push(line.trimEnd());
    }
  }
  if (!opts.tuplesOnly && opts.showRowCount !== false) lines.push(rowCount(rows.length));
  for (const f of opts.footers ?? []) lines.push(f);
  return lines.join("\n") + "\n";
}

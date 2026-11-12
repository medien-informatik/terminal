/**
 * Ausgabe von Werten wie mongosh (das intern util.inspect von Node.js nutzt):
 * kurze Objekte einzeilig, sonst eingerückt; lange Zahlen-/String-Arrays in
 * Spalten; ObjectId('…') und ISODate('…') für BSON-Typen.
 *
 * Der Algorithmus folgt formatValue/reduceToSingleString/groupArrayElements
 * aus lib/internal/util/inspect.js (breakLength 80, compact 3).
 */
import { ObjectId } from "./bson.js";

/** Objekte mit dieser Methode bestimmen ihre Ausgabe selbst (z. B. Database → "test"). */
export const inspectSymbol = Symbol.for("mongosh.inspect");

const BREAK_LENGTH = 80;
const COMPACT = 3;
const MAX_DEPTH = 6;
const MAX_ARRAY_LENGTH = 100;

const STYLE = {
  number: "33",
  boolean: "33",
  undefined: "90",
  null: "1",
  string: "32",
  date: "35",
  regexp: "31",
  special: "36",
} as const;

interface Ctx {
  colors: boolean;
  indentationLvl: number;
  currentDepth: number;
  seen: unknown[];
}

const ANSI = /\x1b\[[0-9;]*m/g;
const plainLength = (s: string) => s.replace(ANSI, "").length;

function stylize(ctx: Ctx, text: string, style: keyof typeof STYLE): string {
  return ctx.colors ? `\x1b[${STYLE[style]}m${text}\x1b[0m` : text;
}

const ESCAPES: Record<string, string> = { "\n": "\\n", "\t": "\\t", "\r": "\\r", "\b": "\\b", "\f": "\\f", "\v": "\\v", "\\": "\\\\" };

/** String-Literal wie Node.js: '…', bei enthaltenem ' ohne " dann "…". */
export function quoteString(s: string): string {
  let quote = "'";
  if (s.includes("'")) {
    if (!s.includes('"')) quote = '"';
    else if (!s.includes("`") && !s.includes("${")) quote = "`";
  }
  let out = "";
  for (const ch of s) {
    if (ch === quote) out += "\\" + ch;
    else if (ESCAPES[ch]) out += ESCAPES[ch];
    else if (ch < " " || ch === "\x7f") out += "\\x" + ch.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase();
    else out += ch;
  }
  return quote + out + quote;
}

const KEY_IDENT = /^[a-zA-Z_][a-zA-Z_0-9]*$/;

function formatKey(key: string): string {
  return KEY_IDENT.test(key) ? key : quoteString(key);
}

function formatNumber(ctx: Ctx, n: number): string {
  return stylize(ctx, Object.is(n, -0) ? "-0" : String(n), "number");
}

function formatPrimitive(ctx: Ctx, v: unknown): string | null {
  switch (typeof v) {
    case "string":
      return stylize(ctx, quoteString(v), "string");
    case "number":
      return formatNumber(ctx, v);
    case "bigint":
      return stylize(ctx, `${v}n`, "number");
    case "boolean":
      return stylize(ctx, String(v), "boolean");
    case "undefined":
      return stylize(ctx, "undefined", "undefined");
    case "symbol":
      return stylize(ctx, v.toString(), "string");
  }
  if (v === null) return stylize(ctx, "null", "null");
  return null;
}

function formatValue(ctx: Ctx, value: unknown, recurseTimes: number): string {
  const prim = formatPrimitive(ctx, value);
  if (prim !== null) return prim;

  if (typeof value === "function") {
    const name = value.name ? `: ${value.name}` : " (anonymous)";
    return stylize(ctx, `[${/^class\s/.test(Function.prototype.toString.call(value)) ? "class" : "Function"}${name}]`, "special");
  }

  const obj = value as Record<string | symbol, unknown>;
  const custom = obj[inspectSymbol];
  if (typeof custom === "function") {
    const r = custom.call(obj);
    return typeof r === "string" ? r : formatValue(ctx, r, recurseTimes);
  }
  if (value instanceof ObjectId) return `ObjectId(${stylize(ctx, quoteString(value.toHexString()), "string")})`;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? stylize(ctx, "Invalid Date", "date")
      : stylize(ctx, `ISODate(${quoteString(value.toISOString())})`, "date");
  }
  if (value instanceof RegExp) return stylize(ctx, String(value), "regexp");
  if (value instanceof Error) return `${value.name}: ${value.message}`;

  if (ctx.seen.includes(value)) return stylize(ctx, "[Circular]", "special");

  const isArray = Array.isArray(value);
  if (recurseTimes > MAX_DEPTH) return stylize(ctx, isArray ? "[Array]" : "[Object]", "special");

  const proto = Object.getPrototypeOf(value);
  const ctorName = proto && proto !== Object.prototype && proto !== Array.prototype ? proto.constructor?.name : "";
  const prefix = !isArray && ctorName && ctorName !== "Object" ? `${ctorName} ` : !proto && !isArray ? "[Object: null prototype] " : "";

  const keys = Object.keys(value as object);
  if (isArray) {
    if ((value as unknown[]).length === 0 && keys.length === 0) return "[]";
  } else if (keys.length === 0) {
    return `${prefix}{}`;
  }

  ctx.seen.push(value);
  ctx.currentDepth = recurseTimes;
  const output: string[] = [];
  let extrasArray = false;
  if (isArray) {
    extrasArray = true;
    const arr = value as unknown[];
    const shown = Math.min(arr.length, MAX_ARRAY_LENGTH);
    for (let i = 0; i < shown; i++) {
      ctx.indentationLvl += 2;
      output.push(i in arr ? formatValue(ctx, arr[i], recurseTimes + 1) : stylize(ctx, "<1 empty item>", "undefined"));
      ctx.indentationLvl -= 2;
    }
    if (arr.length > shown) {
      const rest = arr.length - shown;
      output.push(`... ${rest} more item${rest > 1 ? "s" : ""}`);
    }
    for (const k of keys) {
      if (/^(0|[1-9][0-9]*)$/.test(k) && Number(k) < arr.length) continue;
      ctx.indentationLvl += 2;
      output.push(`${formatKey(k)}: ${formatValue(ctx, obj[k], recurseTimes + 1)}`);
      ctx.indentationLvl -= 2;
    }
  } else {
    for (const k of keys) {
      ctx.indentationLvl += 2;
      output.push(`${formatKey(k)}: ${formatValue(ctx, obj[k], recurseTimes + 1)}`);
      ctx.indentationLvl -= 2;
    }
  }
  ctx.seen.pop();

  const braces: [string, string] = isArray ? ["[", "]"] : [`${prefix}{`, "}"];
  return reduceToSingleString(ctx, output, braces, extrasArray, recurseTimes, isArray ? (value as unknown[]) : undefined);
}

function isBelowBreakLength(output: string[], start: number): boolean {
  let total = output.length + start;
  if (total + output.length > BREAK_LENGTH) return false;
  for (const o of output) {
    total += plainLength(o);
    if (total > BREAK_LENGTH) return false;
  }
  return true;
}

function reduceToSingleString(
  ctx: Ctx,
  output: string[],
  braces: [string, string],
  extrasArray: boolean,
  recurseTimes: number,
  value: unknown[] | undefined,
): string {
  const entries = output.length;
  if (extrasArray && entries > 6) output = groupArrayElements(ctx, output, value);
  if (ctx.currentDepth - recurseTimes < COMPACT && entries === output.length) {
    const start = output.length + ctx.indentationLvl + braces[0].length + 10;
    if (isBelowBreakLength(output, start)) {
      const joined = output.join(", ");
      if (!joined.includes("\n")) return `${braces[0]} ${joined} ${braces[1]}`;
    }
  }
  const indentation = `\n${" ".repeat(ctx.indentationLvl)}`;
  return `${braces[0]}${indentation}  ${output.join(`,${indentation}  `)}${indentation}${braces[1]}`;
}

function groupArrayElements(ctx: Ctx, output: string[], value: unknown[] | undefined): string[] {
  let totalLength = 0;
  let maxLength = 0;
  let outputLength = output.length;
  if (value && value.length > MAX_ARRAY_LENGTH) outputLength--; // "... n more items" nicht mitzählen
  const separatorSpace = 2;
  const dataLen: number[] = [];
  for (let i = 0; i < outputLength; i++) {
    if (output[i].includes("\n")) return output;
    const len = plainLength(output[i]);
    dataLen[i] = len;
    totalLength += len + separatorSpace;
    if (maxLength < len) maxLength = len;
  }
  const actualMax = maxLength + separatorSpace;
  if (actualMax * 3 + ctx.indentationLvl < BREAK_LENGTH && (totalLength / actualMax > 5 || maxLength <= 6)) {
    const averageBias = Math.sqrt(actualMax - totalLength / output.length);
    const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
    const columns = Math.min(
      Math.round(Math.sqrt(2.5 * biasedMax * outputLength) / biasedMax),
      Math.floor((BREAK_LENGTH - ctx.indentationLvl) / actualMax),
      COMPACT * 4,
      15,
    );
    if (columns <= 1) return output;
    const maxLineLength: number[] = [];
    for (let i = 0; i < columns; i++) {
      let lineLength = 0;
      for (let j = i; j < outputLength; j += columns) if (dataLen[j] > lineLength) lineLength = dataLen[j];
      maxLineLength.push(lineLength + separatorSpace);
    }
    let padStart = true;
    if (value) {
      for (let i = 0; i < outputLength; i++) {
        if (typeof value[i] !== "number" && typeof value[i] !== "bigint") {
          padStart = false;
          break;
        }
      }
    }
    const tmp: string[] = [];
    for (let i = 0; i < outputLength; i += columns) {
      const max = Math.min(i + columns, outputLength);
      let str = "";
      let j = i;
      for (; j < max - 1; j++) {
        const padding = maxLineLength[j - i] + output[j].length - dataLen[j];
        str += padStart ? `${output[j]}, `.padStart(padding) : `${output[j]}, `.padEnd(padding);
      }
      if (padStart) {
        const padding = maxLineLength[j - i] + output[j].length - dataLen[j] - separatorSpace;
        str += output[j].padStart(padding);
      } else {
        str += output[j];
      }
      tmp.push(str);
    }
    if (outputLength < output.length) tmp.push(output[outputLength]);
    return tmp;
  }
  return output;
}

/** Formatiert einen Wert wie mongosh. Strings auf oberster Ebene erscheinen ohne Anführungszeichen. */
export function inspect(value: unknown, options: { colors?: boolean; topLevelStringsRaw?: boolean } = {}): string {
  if (options.topLevelStringsRaw !== false && typeof value === "string") return value;
  const ctx: Ctx = { colors: options.colors ?? false, indentationLvl: 0, currentDepth: 0, seen: [] };
  return formatValue(ctx, value, 0);
}

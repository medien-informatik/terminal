/**
 * BSON-ähnliche Typen für die Simulation: ObjectId, Hilfskonstruktoren wie in
 * mongosh (ISODate, NumberInt, …) und tiefes Kopieren von Dokumenten.
 *
 * mingo vergleicht Objekte eigener Klassen über toString() – deshalb genügt
 * für ObjectId ein Hex-String als Inhalt.
 */

const PROCESS_UNIQUE = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, "0")).join("");
let counter = crypto.getRandomValues(new Uint32Array(1))[0] & 0xffffff;

export class ObjectId {
  readonly #hex: string;

  constructor(id?: string | number | ObjectId) {
    if (id instanceof ObjectId) {
      this.#hex = id.toHexString();
    } else if (typeof id === "string") {
      if (!/^[0-9a-fA-F]{24}$/.test(id)) {
        throw new BSONError("input must be a 24 character hex string, 12 byte Uint8Array, or an integer");
      }
      this.#hex = id.toLowerCase();
    } else {
      const seconds = typeof id === "number" ? id : Math.floor(Date.now() / 1000);
      counter = (counter + 1) & 0xffffff;
      this.#hex =
        (seconds >>> 0).toString(16).padStart(8, "0") + PROCESS_UNIQUE + counter.toString(16).padStart(6, "0");
    }
  }

  static isValid(id: unknown): boolean {
    return id instanceof ObjectId || (typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id));
  }

  static createFromTime(seconds: number): ObjectId {
    return new ObjectId(Math.floor(seconds).toString(16).padStart(8, "0") + "0000000000000000");
  }

  toHexString(): string {
    return this.#hex;
  }

  toString(): string {
    return this.#hex;
  }

  toJSON(): string {
    return this.#hex;
  }

  equals(other: unknown): boolean {
    return other instanceof ObjectId ? other.#hex === this.#hex : typeof other === "string" && other.toLowerCase() === this.#hex;
  }

  getTimestamp(): Date {
    return new Date(parseInt(this.#hex.slice(0, 8), 16) * 1000);
  }

  get [Symbol.toStringTag](): string {
    return "ObjectId";
  }
}

export class BSONError extends Error {
  override name = "BSONError";
}

/** Kopiert einen Wert tief (ObjectId und Date bleiben erhalten). */
export function cloneValue<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof ObjectId) return v; // unveränderlich
  if (v instanceof Date) return new Date(v.getTime()) as T;
  if (v instanceof RegExp) return new RegExp(v.source, v.flags) as T;
  if (Array.isArray(v)) return v.map(cloneValue) as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (val !== undefined && typeof val !== "function") out[k] = cloneValue(val);
  }
  return out as T;
}

/** Wie ISODate() in mongosh. */
export function ISODate(input?: string | number | Date): Date {
  if (input === undefined) return new Date();
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new BSONError(`${JSON.stringify(input)} is not a valid ISODate`);
  return d;
}

/** Zahlen-Konstruktoren: In der Simulation einfache JS-Zahlen. */
export const NumberInt = (v: unknown = 0): number => Math.trunc(Number(v)) | 0;
export const NumberLong = (v: unknown = 0): number => Math.trunc(Number(v));
export const NumberDecimal = (v: unknown = 0): number => Number(v);
export const Double = (v: unknown = 0): number => Number(v);
export const Int32 = NumberInt;
export const Long = NumberLong;
export const Decimal128 = NumberDecimal;

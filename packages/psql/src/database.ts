/**
 * PGlite-Anbindung über das Postgres-Wire-Protokoll (Simple Query).
 *
 * So erhält psql dieselben Informationen wie ein echter Client: Werte als
 * Text, exakte Command-Tags (INSERT 0 1, …), NOTICEs, Fehler mit Position
 * und den Transaktionsstatus für den Prompt.
 */
import type { PGlite } from "@electric-sql/pglite";

export interface ResultSet {
  fields: { name: string; typeId: number }[];
  rows: (string | null)[][];
  /** Command-Tag, z. B. "SELECT 3" oder "INSERT 0 1". */
  tag?: string;
}

export interface PgMessage {
  severity: string;
  message: string;
  detail?: string;
  hint?: string;
  position?: number;
  where?: string;
  code?: string;
}

/** Eintrag in der Reihenfolge, in der der Server ihn geschickt hat. */
export type Outcome =
  | { kind: "result"; result: ResultSet }
  | { kind: "notice"; notice: PgMessage }
  | { kind: "error"; error: PgMessage };

export interface QueryResponse {
  items: Outcome[];
  /** I = idle, T = in Transaktion, E = fehlgeschlagene Transaktion */
  txStatus: string;
}

interface RawMessage {
  name: string;
  fields?: unknown[];
  text?: string;
  status?: string;
  message?: string;
  severity?: string;
  detail?: string;
  hint?: string;
  position?: string;
  where?: string;
  code?: string;
}

function toPgMessage(m: RawMessage): PgMessage {
  return {
    severity: m.severity ?? "ERROR",
    message: m.message ?? "",
    detail: m.detail,
    hint: m.hint,
    position: m.position ? parseInt(m.position, 10) : undefined,
    where: m.where,
    code: m.code,
  };
}

function queryMessage(sql: string): Uint8Array {
  const body = new TextEncoder().encode(sql);
  const msg = new Uint8Array(1 + 4 + body.length + 1);
  msg[0] = 0x51; // 'Q'
  new DataView(msg.buffer).setInt32(1, 4 + body.length + 1);
  msg.set(body, 5);
  msg[5 + body.length] = 0;
  return msg;
}

export class Database {
  private instance: Promise<PGlite> | null = null;
  txStatus = "I";

  /** Startet PGlite (einmalig). */
  get(): Promise<PGlite> {
    this.instance ??= (async () => {
      const { PGlite } = await import("@electric-sql/pglite");
      return PGlite.create();
    })().catch((err) => {
      this.instance = null;
      throw err;
    });
    return this.instance;
  }

  get started(): boolean {
    return this.instance !== null;
  }

  /** Führt SQL über das Simple-Query-Protokoll aus. */
  async query(sql: string): Promise<QueryResponse> {
    const db = await this.get();
    const { messages } = await db.execProtocol(queryMessage(sql), { throwOnError: false });
    const items: Outcome[] = [];
    let current: ResultSet | null = null;
    for (const raw of messages as unknown as RawMessage[]) {
      switch (raw.name) {
        case "rowDescription":
          current = {
            fields: (raw.fields as { name: string; dataTypeID: number }[]).map((f) => ({
              name: f.name,
              typeId: f.dataTypeID,
            })),
            rows: [],
          };
          items.push({ kind: "result", result: current });
          break;
        case "dataRow":
          current?.rows.push(raw.fields as (string | null)[]);
          break;
        case "commandComplete":
          if (current && current.tag === undefined) current.tag = raw.text;
          else items.push({ kind: "result", result: { fields: [], rows: [], tag: raw.text } });
          current = null;
          break;
        case "notice":
          items.push({ kind: "notice", notice: toPgMessage(raw) });
          break;
        case "error":
          items.push({ kind: "error", error: toPgMessage(raw) });
          current = null;
          break;
        case "readyForQuery":
          this.txStatus = raw.status ?? "I";
          break;
      }
    }
    return { items, txStatus: this.txStatus };
  }

  /** Bequeme Abfrage für Katalog-Abfragen (\d usw.). */
  async rows(sql: string): Promise<ResultSet> {
    const res = await this.query(sql);
    const err = res.items.find((i) => i.kind === "error");
    if (err && err.kind === "error") throw new Error(err.error.message);
    const result = res.items.find((i) => i.kind === "result" && i.result.fields.length);
    return result && result.kind === "result" ? result.result : { fields: [], rows: [] };
  }
}

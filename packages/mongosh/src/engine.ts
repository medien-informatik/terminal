/**
 * In-Memory-„Server“ mit der Shell-API von mongosh (db, Collections, Cursor).
 * Abfragen, Updates und Aggregationen übernimmt mingo.
 */
import { aggregate, find, update as mingoUpdate, updateMany as mingoUpdateMany, updateOne as mingoUpdateOne } from "mingo";
import { cloneValue, ObjectId } from "./bson.js";
import { inspect, inspectSymbol } from "./inspect.js";

export type Doc = Record<string, unknown>;

export interface IndexInfo {
  v: 2;
  key: Record<string, 1 | -1 | string>;
  name: string;
  unique?: boolean;
}

interface CollectionData {
  docs: Doc[];
  indexes: IndexInfo[];
}

/** Fehler, wie sie der Server melden würde (Ausgabe: "MongoServerError: …"). */
export class MongoServerError extends Error {
  override name = "MongoServerError";
  constructor(
    message: string,
    readonly code?: number,
    readonly codeName?: string,
  ) {
    super(message);
  }
}

export class MongoInvalidArgumentError extends Error {
  override name = "MongoInvalidArgumentError";
}

export class MongoBulkWriteError extends Error {
  override name = "MongoBulkWriteError";
}

export class MongoshInvalidInputError extends Error {
  override name = "MongoshInvalidInputError";
}

/** Text, der unverändert ausgegeben wird (z. B. für "show dbs"). */
export class ShellText {
  constructor(readonly text: string) {}
  [inspectSymbol](): string {
    return this.text;
  }
}

const isPlainObject = (v: unknown): v is Doc =>
  v !== null && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function getPath(doc: unknown, path: string): unknown {
  let cur = doc;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Doc)[part];
  }
  return cur;
}

/** Fehler aus mingo als Serverfehler ausgeben. */
function engine<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error && !(err instanceof MongoServerError) && !(err instanceof MongoInvalidArgumentError)) {
      throw new MongoServerError(err.message);
    }
    throw err;
  }
}

function requireObject(v: unknown, what: string): Doc {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new MongoInvalidArgumentError(`${what} must be an object`);
  return v as Doc;
}

const isOperatorDoc = (u: Doc) => Object.keys(u).length > 0 && Object.keys(u).every((k) => k.startsWith("$"));

/** Stellt _id an den Anfang (und erzeugt es bei Bedarf), wie der Server beim Einfügen. */
function withId(doc: Doc): Doc {
  const { _id, ...rest } = doc;
  return { _id: _id === undefined ? new ObjectId() : _id, ...rest };
}

/** _id steht in Ergebnissen wie beim Server vorne (mingo hängt es bei Projektionen hinten an). */
function idFirst<T>(doc: T): T {
  if (!isPlainObject(doc) || !("_id" in doc) || Object.keys(doc)[0] === "_id") return doc;
  const { _id, ...rest } = doc;
  return { _id, ...rest } as T;
}

/** Byte-Größe grob schätzen (für "show dbs" und stats()). */
function approxSize(docs: Doc[]): number {
  let n = 0;
  for (const d of docs) n += JSON.stringify(d)?.length ?? 0;
  return n;
}

export class Server {
  readonly dbs = new Map<string, Map<string, CollectionData>>();

  collections(db: string): Map<string, CollectionData> | undefined {
    return this.dbs.get(db);
  }

  get(db: string, name: string): CollectionData | undefined {
    return this.dbs.get(db)?.get(name);
  }

  getOrCreate(db: string, name: string): CollectionData {
    validateCollectionName(name);
    let colls = this.dbs.get(db);
    if (!colls) this.dbs.set(db, (colls = new Map()));
    let c = colls.get(name);
    if (!c) colls.set(name, (c = { docs: [], indexes: [{ v: 2, key: { _id: 1 }, name: "_id_" }] }));
    return c;
  }

  drop(db: string, name: string): boolean {
    const colls = this.dbs.get(db);
    const ok = colls?.delete(name) ?? false;
    if (colls && colls.size === 0) this.dbs.delete(db);
    return ok;
  }

  /** "show dbs": Name und Größe. */
  listDatabases(): { name: string; sizeOnDisk: number }[] {
    const list = [
      { name: "admin", sizeOnDisk: 40960 },
      { name: "config", sizeOnDisk: 61440 },
      { name: "local", sizeOnDisk: 40960 },
    ];
    for (const [name, colls] of this.dbs) {
      if (colls.size === 0) continue;
      let size = 0;
      for (const c of colls.values()) size += 8192 * (1 + c.indexes.length) + Math.ceil(approxSize(c.docs) / 4096) * 4096;
      list.push({ name, sizeOnDisk: size });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }
}

function validateCollectionName(name: string): void {
  if (typeof name !== "string" || !name || name.includes("$") || name.includes("\0") || name.startsWith(".") || name.endsWith(".")) {
    throw new MongoServerError(`Invalid collection name: ${String(name)}`, 73, "InvalidNamespace");
  }
}

export function validateDbName(name: string): void {
  if (typeof name !== "string" || !name || /[/\\. "$*<>:|?]/.test(name) || name.length > 63) {
    throw new MongoInvalidArgumentError(`Invalid database name: ${String(name)}`);
  }
}

export function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(2)} ${units[i]}`;
}

/* ------------------------------------------------------------------------ */
/* Cursor                                                                    */
/* ------------------------------------------------------------------------ */

type Mapper = (doc: unknown) => unknown;

export abstract class AbstractCursor {
  protected buffer: unknown[] | null = null;
  protected pos = 0;
  protected mappers: Mapper[] = [];

  protected abstract run(): unknown[];

  protected ensureNotStarted(): void {
    if (this.buffer) throw new MongoshInvalidInputError("Cursor is already initialized and cannot be modified");
  }

  protected fill(): unknown[] {
    if (!this.buffer) {
      let docs = this.run().map((d) => idFirst(cloneValue(d)));
      for (const m of this.mappers) docs = docs.map(m);
      this.buffer = docs;
    }
    return this.buffer;
  }

  map(fn: Mapper): this {
    this.ensureNotStarted();
    if (typeof fn !== "function") throw new MongoInvalidArgumentError("map() requires a function");
    this.mappers.push(fn);
    return this;
  }

  hasNext(): boolean {
    return this.pos < this.fill().length;
  }

  next(): unknown {
    const buf = this.fill();
    return this.pos < buf.length ? buf[this.pos++] : null;
  }

  tryNext(): unknown {
    return this.next();
  }

  toArray(): unknown[] {
    const buf = this.fill();
    const rest = buf.slice(this.pos);
    this.pos = buf.length;
    return rest;
  }

  forEach(fn: (doc: unknown) => unknown): void {
    if (typeof fn !== "function") throw new MongoInvalidArgumentError("forEach() requires a function");
    while (this.hasNext()) if (fn(this.next()) === false) break;
  }

  itcount(): number {
    return this.toArray().length;
  }

  isExhausted(): boolean {
    return this.buffer !== null && this.pos >= this.buffer.length;
  }

  objsLeftInBatch(): number {
    return this.fill().length - this.pos;
  }

  /** Nächste Ausgabeseite (für die REPL und "it"). */
  nextBatch(size: number): { docs: unknown[]; more: boolean } {
    const buf = this.fill();
    const docs = buf.slice(this.pos, this.pos + size);
    this.pos += docs.length;
    return { docs, more: this.pos < buf.length };
  }

  close(): void {
    this.buffer = [];
    this.pos = 0;
  }

  // Wirkungslose Optionen (in der Simulation ohne Bedeutung)
  pretty(): this {
    return this;
  }
  batchSize(_n: number): this {
    return this;
  }
  maxTimeMS(_n: number): this {
    return this;
  }
  comment(_c: string): this {
    return this;
  }
  allowDiskUse(_b?: boolean): this {
    return this;
  }
  noCursorTimeout(): this {
    return this;
  }

  [Symbol.iterator](): Iterator<unknown> {
    return {
      next: () => (this.hasNext() ? { value: this.next(), done: false } : { value: undefined, done: true }),
    };
  }
}

export class FindCursor extends AbstractCursor {
  private _sort: Doc | null = null;
  private _skip = 0;
  private _limit = 0;
  private _collation: Doc | undefined;

  constructor(
    private readonly source: () => Doc[],
    private readonly filter: Doc,
    private _projection: Doc | undefined,
    private readonly ns: string,
  ) {
    super();
  }

  protected run(): unknown[] {
    return engine(() => {
      const opts = this._collation ? { collation: this._collation as never } : {};
      let c = find(this.source(), this.filter, this._projection && Object.keys(this._projection).length ? this._projection : undefined, opts);
      if (this._sort) c = c.sort(this._sort as never);
      if (this._skip) c = c.skip(this._skip);
      if (this._limit) c = c.limit(Math.abs(this._limit));
      return c.all();
    });
  }

  sort(spec: Doc | string): this {
    this.ensureNotStarted();
    if (typeof spec === "string") spec = { [spec]: 1 };
    this._sort = requireObject(spec, "sort");
    return this;
  }

  skip(n: number): this {
    this.ensureNotStarted();
    if (typeof n !== "number" || n < 0) throw new MongoInvalidArgumentError("skip requires a non-negative number");
    this._skip = n;
    return this;
  }

  limit(n: number): this {
    this.ensureNotStarted();
    if (typeof n !== "number") throw new MongoInvalidArgumentError("limit requires a number");
    this._limit = n;
    return this;
  }

  project(p: Doc): this {
    this.ensureNotStarted();
    this._projection = requireObject(p, "projection");
    return this;
  }

  projection(p: Doc): this {
    return this.project(p);
  }

  collation(c: Doc): this {
    this.ensureNotStarted();
    this._collation = c;
    return this;
  }

  hint(_h: unknown): this {
    return this;
  }

  min(_m: unknown): this {
    return this;
  }

  max(_m: unknown): this {
    return this;
  }

  /** Wie cursor.count() in mongosh: ignoriert skip/limit, außer applySkipLimit ist true. */
  count(applySkipLimit = false): number {
    return engine(() => {
      let c = find(this.source(), this.filter);
      if (applySkipLimit && this._skip) c = c.skip(this._skip);
      if (applySkipLimit && this._limit) c = c.limit(Math.abs(this._limit));
      return c.all().length;
    });
  }

  size(): number {
    return this.count(true);
  }

  explain(_verbosity?: string): Doc {
    return {
      explainVersion: "1",
      queryPlanner: {
        namespace: this.ns,
        parsedQuery: this.filter,
        winningPlan: { stage: "COLLSCAN", filter: this.filter, direction: "forward" },
        rejectedPlans: [],
      },
      ok: 1,
    };
  }

  [inspectSymbol](): string {
    return `FindCursor(${this.ns})`;
  }
}

export class AggregationCursor extends AbstractCursor {
  constructor(
    private readonly runner: () => unknown[],
    private readonly ns: string,
  ) {
    super();
  }

  protected run(): unknown[] {
    return this.runner();
  }

  explain(): Doc {
    return { explainVersion: "1", stages: [], ok: 1, note: "Simulation (mingo): keine Ausführungspläne" };
  }

  [inspectSymbol](): string {
    return `AggregationCursor(${this.ns})`;
  }
}

/* ------------------------------------------------------------------------ */
/* Collection                                                                */
/* ------------------------------------------------------------------------ */

interface UpdateOptions {
  upsert?: boolean;
  arrayFilters?: Doc[];
  sort?: Doc;
  collation?: Doc;
}

const NO_SUBCOLLECTION = new Set(["then", "toJSON", "constructor", "inspect", "valueOf", "toString", "prototype", "length", "name"]);

function proxify<T extends object>(target: T, sub: (name: string) => unknown): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol" || prop in t || prop.startsWith("_") || NO_SUBCOLLECTION.has(prop)) {
        const v = Reflect.get(t, prop, receiver);
        return typeof v === "function" ? v.bind(t) : v;
      }
      return sub(prop);
    },
  });
}

export class Collection {
  constructor(
    private readonly server: Server,
    private readonly _db: Database,
    private readonly _name: string,
  ) {}

  static create(server: Server, db: Database, name: string): Collection {
    validateCollectionName(name);
    const c = new Collection(server, db, name);
    return proxify(c, (sub) => Collection.create(server, db, `${name}.${sub}`));
  }

  private get dbName(): string {
    return this._db.getName();
  }

  private data(): CollectionData | undefined {
    return this.server.get(this.dbName, this._name);
  }

  private docs(): Doc[] {
    return this.data()?.docs ?? [];
  }

  private writable(): CollectionData {
    return this.server.getOrCreate(this.dbName, this._name);
  }

  getName(): string {
    return this._name;
  }

  getFullName(): string {
    return `${this.dbName}.${this._name}`;
  }

  getDB(): Database {
    return this._db;
  }

  [inspectSymbol](): string {
    return this.getFullName();
  }

  /** Prüft eindeutige Indexe; wirft E11000 wie der Server. */
  private checkUnique(data: CollectionData): void {
    for (const idx of data.indexes) {
      if (idx.name !== "_id_" && !idx.unique) continue;
      const fields = Object.keys(idx.key);
      const seen = new Set<string>();
      for (const doc of data.docs) {
        const values = fields.map((f) => getPath(doc, f) ?? null);
        const k = inspect(values, { topLevelStringsRaw: false });
        if (seen.has(k)) {
          const dup = inspect(Object.fromEntries(fields.map((f, i) => [f, values[i]])), { topLevelStringsRaw: false });
          throw new MongoServerError(
            `E11000 duplicate key error collection: ${this.getFullName()} index: ${idx.name} dup key: ${dup}`,
            11000,
            "DuplicateKey",
          );
        }
        seen.add(k);
      }
    }
  }

  /** Führt eine Änderung aus und stellt bei Fehlern den alten Stand wieder her. */
  private transaction<T>(fn: (data: CollectionData) => T): T {
    const existed = !!this.data();
    const data = this.writable();
    const before = data.docs.map((d) => cloneValue(d));
    try {
      const r = fn(data);
      this.checkUnique(data);
      return r;
    } catch (err) {
      data.docs.splice(0, data.docs.length, ...before);
      if (!existed && data.docs.length === 0) this.server.drop(this.dbName, this._name);
      throw err;
    }
  }

  /* ---------- Einfügen ---------- */

  insertOne(doc: Doc, _options?: Doc): Doc {
    if (!isPlainObject(doc)) throw new MongoInvalidArgumentError("Argument \"doc\" must be an object");
    if (doc._id === undefined) doc._id = new ObjectId();
    const stored = withId(cloneValue(doc));
    this.transaction((data) => data.docs.push(stored));
    return { acknowledged: true, insertedId: stored._id };
  }

  insertMany(docs: Doc[], options: { ordered?: boolean } = {}): Doc {
    if (!Array.isArray(docs)) throw new MongoInvalidArgumentError('Argument "docs" must be an array of documents');
    const ids: Record<string, unknown> = {};
    const errors: string[] = [];
    const data = this.writable();
    docs.forEach((doc, i) => {
      if (errors.length && options.ordered !== false) return;
      if (!isPlainObject(doc)) throw new MongoInvalidArgumentError("Argument \"docs\" must be an array of documents");
      if (doc._id === undefined) doc._id = new ObjectId();
      const stored = withId(cloneValue(doc));
      data.docs.push(stored);
      try {
        this.checkUnique(data);
        ids[String(i)] = stored._id;
      } catch (err) {
        data.docs.pop();
        errors.push((err as Error).message);
      }
    });
    if (data.docs.length === 0) this.server.drop(this.dbName, this._name);
    if (errors.length) {
      const inserted = Object.keys(ids).length;
      throw new MongoBulkWriteError(`${errors[0]}\nResult: ${inspect({ insertedCount: inserted, insertedIds: ids }, { topLevelStringsRaw: false })}`);
    }
    return { acknowledged: true, insertedIds: ids };
  }

  /** Veraltet, aber in Übungen häufig. */
  insert(docOrDocs: Doc | Doc[]): Doc {
    console.warn("DeprecationWarning: Collection.insert() is deprecated. Use insertOne, insertMany, or bulkWrite.");
    if (Array.isArray(docOrDocs)) return this.insertMany(docOrDocs);
    return this.insertOne(docOrDocs);
  }

  /* ---------- Lesen ---------- */

  find(filter?: Doc, projection?: Doc, options: { sort?: Doc; skip?: number; limit?: number; projection?: Doc } = {}): FindCursor {
    const f = requireObject(filter, "filter");
    const cursor = new FindCursor(() => this.docs(), f, requireObject(projection ?? options.projection, "projection"), this.getFullName());
    if (options.sort) cursor.sort(options.sort);
    if (options.skip) cursor.skip(options.skip);
    if (options.limit) cursor.limit(options.limit);
    return cursor;
  }

  findOne(filter?: Doc, projection?: Doc, options: { sort?: Doc; skip?: number } = {}): unknown {
    if (filter !== undefined && filter !== null && (typeof filter !== "object" || filter instanceof ObjectId)) filter = { _id: filter };
    const c = this.find(filter, projection, { ...options, limit: 1 });
    return c.hasNext() ? c.next() : null;
  }

  countDocuments(filter?: Doc, options: { skip?: number; limit?: number } = {}): number {
    const c = this.find(filter, undefined, options);
    return c.size();
  }

  estimatedDocumentCount(): number {
    return this.docs().length;
  }

  count(filter?: Doc): number {
    console.warn("DeprecationWarning: Collection.count() is deprecated. Use countDocuments or estimatedDocumentCount.");
    return this.countDocuments(filter);
  }

  distinct(field: string, filter?: Doc): unknown[] {
    if (typeof field !== "string") throw new MongoInvalidArgumentError("distinct requires a field name");
    const f = requireObject(filter, "filter");
    return engine(() =>
      aggregate(this.docs(), [
        { $match: f },
        { $unwind: { path: `$${field}`, preserveNullAndEmptyArrays: true } },
        { $match: { [field]: { $exists: true } } },
        { $group: { _id: `$${field}` } },
        { $sort: { _id: 1 } },
      ]).map((d) => cloneValue(d._id)),
    );
  }

  aggregate(pipeline: Doc[] | Doc, ...more: Doc[]): AggregationCursor {
    // mongosh erlaubt auch aggregate(stage1, stage2, …)
    const stages = Array.isArray(pipeline) ? pipeline : [pipeline, ...more.filter((s) => isPlainObject(s))];
    for (const s of stages) {
      if (!isPlainObject(s) || Object.keys(s).length !== 1) {
        throw new MongoServerError("A pipeline stage specification object must contain exactly one field.", 40323, "Location40323");
      }
    }
    const dbName = this.dbName;
    const server = this.server;
    return new AggregationCursor(
      () =>
        engine(() => {
          const created: string[] = [];
          const targets = new Set<string>();
          for (const s of stages) {
            const t = (s.$out ?? (s.$merge as Doc | undefined)?.into ?? s.$merge) as unknown;
            if (typeof t === "string") targets.add(t);
            else if (isPlainObject(t) && typeof t.coll === "string") targets.add(t.coll);
          }
          const resolver = (name: string) => {
            if (!server.get(dbName, name)) created.push(name);
            return server.getOrCreate(dbName, name).docs as never[];
          };
          try {
            const result = aggregate(cloneValue(this.docs()), cloneValue(stages), { collectionResolver: resolver });
            for (const t of targets) {
              const data = server.get(dbName, t);
              if (data) data.docs.forEach((d, i) => (data.docs[i] = withId(d)));
            }
            return result;
          } finally {
            for (const name of created) {
              if (!targets.has(name) && server.get(dbName, name)?.docs.length === 0) server.drop(dbName, name);
            }
          }
        }),
      this.getFullName(),
    );
  }

  /* ---------- Ändern ---------- */

  private splitUpdate(upd: Doc | Doc[], replacement: boolean): { modifier: Doc | Doc[]; setOnInsert: Doc } {
    if (replacement) {
      if (!isPlainObject(upd)) throw new MongoInvalidArgumentError("Replacement document must be an object");
      if (Object.keys(upd).some((k) => k.startsWith("$"))) {
        throw new MongoInvalidArgumentError("Replacement document must not contain atomic operators");
      }
      return { modifier: upd, setOnInsert: {} };
    }
    if (Array.isArray(upd)) return { modifier: cloneValue(upd), setOnInsert: {} };
    if (!isPlainObject(upd) || !isOperatorDoc(upd)) {
      throw new MongoInvalidArgumentError("Update document requires atomic operators");
    }
    const { $setOnInsert, ...rest } = cloneValue(upd);
    return { modifier: rest, setOnInsert: (($setOnInsert as Doc) ?? {}) };
  }

  /** Dokument für ein Upsert aus den Gleichheitsbedingungen des Filters. */
  private upsertBase(filter: Doc): Doc {
    const base: Doc = {};
    const add = (f: Doc) => {
      for (const [k, v] of Object.entries(f)) {
        if (k === "$and" && Array.isArray(v)) v.forEach((x) => isPlainObject(x) && add(x));
        if (k.startsWith("$")) continue;
        let value = v;
        if (isPlainObject(v) && Object.keys(v).some((x) => x.startsWith("$"))) {
          if ("$eq" in v) value = v.$eq;
          else continue;
        }
        if (k.includes(".")) mingoUpdate(base, { $set: { [k]: cloneValue(value) } }, undefined, undefined, { cloneMode: "none" });
        else base[k] = cloneValue(value);
      }
    };
    add(filter);
    return base;
  }

  private doUpdate(filter: Doc | undefined, upd: Doc | Doc[], options: UpdateOptions, many: boolean, replacement: boolean): Doc {
    const f = requireObject(filter, "filter");
    const { modifier, setOnInsert } = this.splitUpdate(upd, replacement);
    return this.transaction((data) => {
      let matched = 0;
      let modified = 0;
      if (replacement) {
        const idx = this.firstMatchIndex(data.docs, f, options.sort);
        if (idx >= 0) {
          matched = 1;
          const old = data.docs[idx];
          const repl = modifier as Doc;
          if (repl._id !== undefined && inspect(repl._id) !== inspect(old._id)) {
            throw new MongoServerError(
              "After applying the update, the (immutable) field '_id' was found to have been altered to _id: " + inspect(repl._id, { topLevelStringsRaw: false }),
              66,
              "ImmutableField",
            );
          }
          const next = { _id: old._id, ...cloneValue(repl) };
          if (inspect(next) !== inspect(old)) modified = 1;
          data.docs[idx] = next;
        }
      } else if (Object.keys(modifier).length || Array.isArray(modifier)) {
        const ids = data.docs.map((d) => inspect(d._id, { topLevelStringsRaw: false }));
        const cfg = { arrayFilters: options.arrayFilters, sort: options.sort as never, cloneMode: "none" as const };
        const r = engine(() =>
          many ? mingoUpdateMany(data.docs, f, modifier as never, cfg) : mingoUpdateOne(data.docs, f, modifier as never, cfg),
        );
        matched = r.matchedCount;
        modified = r.modifiedCount;
        data.docs.forEach((d, i) => {
          if (inspect(d._id, { topLevelStringsRaw: false }) !== ids[i]) {
            throw new MongoServerError("Performing an update on the path '_id' would modify the immutable field '_id'", 66, "ImmutableField");
          }
        });
      } else {
        // nur $setOnInsert: Treffer zählen
        matched = engine(() => find(data.docs, f).all().length);
        if (!many) matched = Math.min(matched, 1);
      }

      let upsertedId: unknown = null;
      if (matched === 0 && options.upsert) {
        let doc: Doc;
        if (replacement) {
          doc = { ...this.upsertBase(f), ...cloneValue(modifier as Doc) };
        } else {
          doc = this.upsertBase(f);
          if (Array.isArray(modifier)) {
            const arr = [doc];
            engine(() => mingoUpdateOne(arr, {}, modifier as never, { cloneMode: "none" }));
            doc = arr[0];
          } else if (Object.keys(modifier).length) {
            engine(() => mingoUpdate(doc, modifier as never, options.arrayFilters, undefined, { cloneMode: "none" }));
          }
          if (Object.keys(setOnInsert).length) {
            engine(() => mingoUpdate(doc, { $set: setOnInsert }, undefined, undefined, { cloneMode: "none" }));
          }
        }
        doc = withId(doc);
        data.docs.push(doc);
        upsertedId = doc._id;
      }
      return {
        acknowledged: true,
        insertedId: upsertedId,
        matchedCount: matched,
        modifiedCount: modified,
        upsertedCount: upsertedId === null ? 0 : 1,
      };
    });
  }

  private firstMatchIndex(docs: Doc[], filter: Doc, sort?: Doc): number {
    return engine(() => {
      let c = find(docs, filter);
      if (sort) c = c.sort(sort as never);
      const first = c.limit(1).all()[0];
      return first ? docs.indexOf(first as Doc) : -1;
    });
  }

  updateOne(filter: Doc, upd: Doc | Doc[], options: UpdateOptions = {}): Doc {
    return this.doUpdate(filter, upd, options, false, false);
  }

  updateMany(filter: Doc, upd: Doc | Doc[], options: UpdateOptions = {}): Doc {
    return this.doUpdate(filter, upd, options, true, false);
  }

  replaceOne(filter: Doc, replacement: Doc, options: UpdateOptions = {}): Doc {
    return this.doUpdate(filter, replacement, options, false, true);
  }

  update(filter: Doc, upd: Doc, options: UpdateOptions & { multi?: boolean } = {}): Doc {
    console.warn("DeprecationWarning: Collection.update() is deprecated. Use updateOne, updateMany, or bulkWrite.");
    return options.multi ? this.updateMany(filter, upd, options) : this.updateOne(filter, upd, options);
  }

  /* ---------- Löschen ---------- */

  deleteOne(filter?: Doc): Doc {
    const f = requireObject(filter, "filter");
    return this.transaction((data) => {
      const idx = this.firstMatchIndex(data.docs, f);
      if (idx >= 0) data.docs.splice(idx, 1);
      return { acknowledged: true, deletedCount: idx >= 0 ? 1 : 0 };
    });
  }

  deleteMany(filter?: Doc): Doc {
    if (filter === undefined) throw new MongoInvalidArgumentError("deleteMany requires a filter; use {} to delete all documents");
    const f = requireObject(filter, "filter");
    const data = this.data();
    if (!data) return { acknowledged: true, deletedCount: 0 };
    const hits = new Set(engine(() => find(data.docs, f).all()));
    const keep = data.docs.filter((d) => !hits.has(d));
    const deleted = data.docs.length - keep.length;
    data.docs.splice(0, data.docs.length, ...keep);
    return { acknowledged: true, deletedCount: deleted };
  }

  remove(filter: Doc, justOne?: boolean | { justOne?: boolean }): Doc {
    console.warn("DeprecationWarning: Collection.remove() is deprecated. Use deleteOne, deleteMany, findOneAndDelete, or bulkWrite.");
    const one = typeof justOne === "object" ? justOne.justOne : justOne;
    return one ? this.deleteOne(filter) : this.deleteMany(filter ?? {});
  }

  /* ---------- findOneAnd… ---------- */

  private findAndModify(
    filter: Doc | undefined,
    options: { sort?: Doc; projection?: Doc; returnDocument?: "before" | "after"; returnNewDocument?: boolean; upsert?: boolean },
    action: (id: unknown) => Doc | null,
  ): unknown {
    const f = requireObject(filter, "filter");
    const after = options.returnDocument === "after" || options.returnNewDocument === true;
    const idx = this.firstMatchIndex(this.docs(), f, options.sort);
    const before = idx >= 0 ? cloneValue(this.docs()[idx]) : null;
    const res = action(before ? before._id : undefined);
    let out: unknown = before;
    if (after) {
      const id = before ? before._id : (res?.insertedId ?? null);
      out = id === null || id === undefined ? null : this.findOne({ _id: id });
    }
    if (out && options.projection) {
      out = engine(() => idFirst(find([out as Doc], {}, options.projection).all()[0] ?? null));
    }
    return out ?? null;
  }

  findOneAndUpdate(filter: Doc, upd: Doc | Doc[], options: Doc = {}): unknown {
    return this.findAndModify(filter, options, (id) =>
      id === undefined && !options.upsert ? null : this.updateOne(id === undefined ? requireObject(filter, "filter") : { _id: id }, upd, options),
    );
  }

  findOneAndReplace(filter: Doc, replacement: Doc, options: Doc = {}): unknown {
    return this.findAndModify(filter, options, (id) =>
      id === undefined && !options.upsert ? null : this.replaceOne(id === undefined ? requireObject(filter, "filter") : { _id: id }, replacement, options),
    );
  }

  findOneAndDelete(filter: Doc, options: Doc = {}): unknown {
    return this.findAndModify(filter, { ...options, returnDocument: "before" }, (id) => (id === undefined ? null : this.deleteOne({ _id: id })));
  }

  /* ---------- Bulk ---------- */

  bulkWrite(ops: Doc[], _options?: Doc): Doc {
    if (!Array.isArray(ops)) throw new MongoInvalidArgumentError("bulkWrite requires an array of operations");
    const r = {
      acknowledged: true,
      insertedCount: 0,
      insertedIds: {} as Record<string, unknown>,
      matchedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      upsertedCount: 0,
      upsertedIds: {} as Record<string, unknown>,
    };
    ops.forEach((op, i) => {
      const [kind, spec] = Object.entries(op)[0] ?? [];
      const s = (spec ?? {}) as Doc;
      let res: Doc;
      switch (kind) {
        case "insertOne":
          res = this.insertOne(s.document as Doc);
          r.insertedCount++;
          r.insertedIds[i] = res.insertedId;
          return;
        case "updateOne":
        case "updateMany":
        case "replaceOne":
          res =
            kind === "replaceOne"
              ? this.replaceOne(s.filter as Doc, s.replacement as Doc, s as UpdateOptions)
              : this[kind](s.filter as Doc, s.update as Doc, s as UpdateOptions);
          r.matchedCount += res.matchedCount as number;
          r.modifiedCount += res.modifiedCount as number;
          if (res.upsertedCount) {
            r.upsertedCount++;
            r.upsertedIds[i] = res.insertedId;
          }
          return;
        case "deleteOne":
        case "deleteMany":
          res = this[kind](s.filter as Doc);
          r.deletedCount += res.deletedCount as number;
          return;
        default:
          throw new MongoInvalidArgumentError(`Invalid bulkWrite operation: ${String(kind)}`);
      }
    });
    return r;
  }

  /* ---------- Indexe & Verwaltung ---------- */

  createIndex(keys: Doc, options: { unique?: boolean; name?: string } = {}): string {
    const k = requireObject(keys, "index keys") as IndexInfo["key"];
    if (!Object.keys(k).length) throw new MongoServerError("Index keys cannot be empty.", 67, "CannotCreateIndex");
    const name = options.name ?? Object.entries(k).map(([f, d]) => `${f}_${d}`).join("_");
    return this.transaction((data) => {
      const existing = data.indexes.find((i) => i.name === name);
      if (existing) return name;
      const idx: IndexInfo = { v: 2, key: k, name };
      if (options.unique) idx.unique = true;
      data.indexes.push(idx);
      try {
        this.checkUnique(data);
      } catch (err) {
        data.indexes.pop();
        throw err;
      }
      return name;
    });
  }

  createIndexes(list: Doc[], options: { unique?: boolean } = {}): string[] {
    return list.map((k) => this.createIndex(k, options));
  }

  ensureIndex(keys: Doc, options?: { unique?: boolean; name?: string }): string {
    return this.createIndex(keys, options);
  }

  getIndexes(): IndexInfo[] {
    return cloneValue(this.data()?.indexes ?? []);
  }

  getIndexKeys(): Doc[] {
    return this.getIndexes().map((i) => i.key);
  }

  dropIndex(index: string | Doc): Doc {
    const data = this.data();
    if (!data) throw new MongoServerError(`ns not found ${this.getFullName()}`, 26, "NamespaceNotFound");
    const pos =
      typeof index === "string"
        ? data.indexes.findIndex((i) => i.name === index)
        : data.indexes.findIndex((i) => inspect(i.key) === inspect(index));
    if (pos < 0) throw new MongoServerError(`index not found with name [${typeof index === "string" ? index : inspect(index)}]`, 27, "IndexNotFound");
    if (data.indexes[pos].name === "_id_") throw new MongoServerError("cannot drop _id index", 72, "InvalidOptions");
    data.indexes.splice(pos, 1);
    return { nIndexesWas: data.indexes.length + 1, ok: 1 };
  }

  dropIndexes(): Doc {
    const data = this.data();
    if (!data) throw new MongoServerError(`ns not found ${this.getFullName()}`, 26, "NamespaceNotFound");
    const was = data.indexes.length;
    data.indexes = data.indexes.filter((i) => i.name === "_id_");
    return { nIndexesWas: was, msg: "non-_id indexes dropped for collection", ok: 1 };
  }

  drop(): boolean {
    this.server.drop(this.dbName, this._name);
    return true;
  }

  renameCollection(newName: string, dropTarget = false): Doc {
    validateCollectionName(newName);
    const colls = this.server.collections(this.dbName);
    const data = colls?.get(this._name);
    if (!colls || !data) throw new MongoServerError("source namespace does not exist", 26, "NamespaceNotFound");
    if (colls.has(newName) && !dropTarget) throw new MongoServerError("target namespace exists", 48, "NamespaceExists");
    colls.delete(this._name);
    colls.set(newName, data);
    return { ok: 1 };
  }

  exists(): Doc | null {
    return this.data() ? { name: this._name, type: "collection", options: {}, info: { readOnly: false } } : null;
  }

  stats(): Doc {
    const data = this.data();
    const docs = data?.docs ?? [];
    const size = approxSize(docs);
    return {
      ns: this.getFullName(),
      count: docs.length,
      size,
      avgObjSize: docs.length ? Math.round(size / docs.length) : 0,
      nindexes: data?.indexes.length ?? 0,
      indexNames: data?.indexes.map((i) => i.name) ?? [],
      ok: 1,
    };
  }

  dataSize(): number {
    return approxSize(this.docs());
  }

  help(): ShellText {
    return new ShellText(COLLECTION_HELP);
  }
}

/* ------------------------------------------------------------------------ */
/* Database                                                                  */
/* ------------------------------------------------------------------------ */

export class Database {
  private readonly _cache = new Map<string, Collection>();

  constructor(
    private readonly _server: Server,
    private readonly _name: string,
    private readonly _sibling: (name: string) => Database,
  ) {}

  static create(server: Server, name: string, sibling: (name: string) => Database): Database {
    validateDbName(name);
    const db = new Database(server, name, sibling);
    return proxify(db, (coll) => db.getCollection(coll));
  }

  getName(): string {
    return this._name;
  }

  [inspectSymbol](): string {
    return this._name;
  }

  toString(): string {
    return this._name;
  }

  getCollection(name: string): Collection {
    if (typeof name !== "string") throw new MongoInvalidArgumentError("Collection name must be a string");
    let c = this._cache.get(name);
    if (!c) this._cache.set(name, (c = Collection.create(this._server, this._self(), name)));
    return c;
  }

  /** Die Proxy-Instanz zu diesem Objekt (für getDB()). */
  private _self(): Database {
    return this._sibling(this._name);
  }

  getCollectionNames(): string[] {
    return [...(this._server.collections(this._name)?.keys() ?? [])].sort();
  }

  getCollectionInfos(filter: Doc = {}): Doc[] {
    const infos = this.getCollectionNames().map((name) => ({ name, type: "collection", options: {}, info: { readOnly: false } }));
    return engine(() => find(infos, filter).all()) as Doc[];
  }

  createCollection(name: string, _options?: Doc): Doc {
    if (this._server.get(this._name, name)) {
      throw new MongoServerError(`Collection ${this._name}.${name} already exists.`, 48, "NamespaceExists");
    }
    this._server.getOrCreate(this._name, name);
    return { ok: 1 };
  }

  dropDatabase(): Doc {
    this._server.dbs.delete(this._name);
    return { ok: 1, dropped: this._name };
  }

  getSiblingDB(name: string): Database {
    return this._sibling(name);
  }

  getMongo(): ShellText {
    return new ShellText("mongodb://127.0.0.1:27017/?directConnection=true (Simulation)");
  }

  version(): string {
    return MONGODB_VERSION;
  }

  stats(): Doc {
    const colls = [...(this._server.collections(this._name)?.values() ?? [])];
    const objects = colls.reduce((n, c) => n + c.docs.length, 0);
    const dataSize = colls.reduce((n, c) => n + approxSize(c.docs), 0);
    return {
      db: this._name,
      collections: colls.length,
      views: 0,
      objects,
      avgObjSize: objects ? dataSize / objects : 0,
      dataSize,
      indexes: colls.reduce((n, c) => n + c.indexes.length, 0),
      ok: 1,
    };
  }

  runCommand(cmd: Doc | string): Doc {
    const c = typeof cmd === "string" ? { [cmd]: 1 } : requireObject(cmd, "command");
    const name = Object.keys(c)[0];
    switch (name) {
      case "ping":
        return { ok: 1 };
      case "buildInfo":
      case "buildinfo":
        return { version: MONGODB_VERSION, gitVersion: "simulation", modules: [], ok: 1 };
      case "dbStats":
        return this.stats();
      case "listCollections":
        return { cursor: { id: 0, ns: `${this._name}.$cmd.listCollections`, firstBatch: this.getCollectionInfos() }, ok: 1 };
      case "hello":
      case "isMaster":
        return { isWritablePrimary: true, maxBsonObjectSize: 16777216, ok: 1 };
      case "count":
        return { n: this.getCollection(String(c.count)).countDocuments((c.query as Doc) ?? {}), ok: 1 };
      case "drop":
        this.getCollection(String(c.drop)).drop();
        return { ok: 1 };
      case "create":
        return this.createCollection(String(c.create));
      case "listDatabases":
        return { databases: this._server.listDatabases().map((d) => ({ ...d, empty: false })), ok: 1 };
      default:
        throw new MongoServerError(`no such command: '${name}'`, 59, "CommandNotFound");
    }
  }

  adminCommand(cmd: Doc | string): Doc {
    return this._sibling("admin").runCommand(cmd);
  }

  help(): ShellText {
    return new ShellText(DATABASE_HELP);
  }
}

export const MONGODB_VERSION = "8.0.0";

const DATABASE_HELP = `
  Database Class:

    getMongo                                   Returns the current database connection
    getName                                    Returns the name of the DB
    getCollectionNames                         Returns an array containing the names of all collections in the current database.
    getCollectionInfos                         Returns an array of documents with collection information
    getCollection                              Returns a collection object
    getSiblingDB                               Returns another database without modifying the db variable in the shell environment.
    createCollection                           Create new collection
    dropDatabase                               Removes the current database
    runCommand                                 Runs an arbitrary command on the database.
    adminCommand                               Runs an arbitrary command against the admin database.
    stats                                      Returns statistics about the database.
    version                                    Returns the version of the server
`;

const COLLECTION_HELP = `
  Collection Class:

    aggregate                                  Calculates aggregate values for the data in a collection or a view.
    bulkWrite                                  Performs multiple write operations with controls for order of execution.
    countDocuments                             Returns the count of documents that match the query for a collection or view.
    estimatedDocumentCount                     Returns the count of all documents in a collection or view.
    distinct                                   Finds the distinct values for a specified field across a single collection or view.
    find                                       Selects documents in a collection or view.
    findOne                                    Selects one document.
    findOneAndDelete                           Deletes a single document and returns it.
    findOneAndReplace                          Replaces a single document and returns the original (or the new one).
    findOneAndUpdate                           Updates a single document and returns the original (or the new one).
    insertOne                                  Inserts a document into a collection.
    insertMany                                 Inserts multiple documents into a collection.
    updateOne                                  Updates a single document within the collection based on the filter.
    updateMany                                 Updates all documents that match the specified filter for a collection.
    replaceOne                                 Replaces a single document within the collection based on the filter.
    deleteOne                                  Removes a single document from a collection.
    deleteMany                                 Removes all documents that match the filter from a collection.
    createIndex                                Creates one index on a collection (unique: true is enforced)
    getIndexes                                 Returns an array that holds a list of documents that describe the existing indexes.
    dropIndex                                  Drops or removes the specified index from a collection.
    drop                                       Removes a collection from the database.
    renameCollection                           Renames a collection.
    stats                                      Returns statistics about the collection.
`;

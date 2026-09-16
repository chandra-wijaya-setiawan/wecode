import { DatabaseSync } from "node:sqlite";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { queries, table } from "./db.js";
import { currentDatabase } from "./home.js";

const MIGRATIONS = fileURLToPath(new URL("../sql/migrations", import.meta.url));

/** The one row that says which migration the file has reached. Unexported: `index.ts`
 *  re-exports this module wholesale. */
const schemaVersion = table<{ version: number }>("schema_version", ["version"]);

/** SQLite's own catalogue, as much of it as this module asks about. Reading it is how a
 *  file with no schema at all is told from one whose version row is simply missing —
 *  selecting from a table that is not there is an error, not an empty result. */
const master = table<{ type: string; name: string }>("sqlite_master", ["type", "name"]);

export class StoreError extends Error {}

/** Every file in sql/migrations, in name order. The number in the filename is the version
 *  it brings the database to, so adding one is a file rather than an edit.
 *
 *  Two files may not share a number. A database records the version it reached, and this
 *  loop skips anything at or below it: a second file numbered like one already applied is
 *  never run against a database that existed before it was written, however new it looks.
 *  The chore table went missing from every live workspace exactly that way, so the
 *  collision is refused here rather than found later in the field. */
function migrations(): readonly { version: number; path: string }[] {
  const all = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ version: Number.parseInt(f, 10), path: join(MIGRATIONS, f), file: f }));

  const seen = new Map<number, string>();
  for (const m of all) {
    const first = seen.get(m.version);
    if (first !== undefined) {
      throw new StoreError(
        `two migrations are numbered ${m.version}: ${first} and ${m.file}. A database ` +
          `already at ${m.version} would never run the second one. Renumber it to the ` +
          `next free version.`,
      );
    }
    seen.set(m.version, m.file);
  }
  return all;
}

export const SCHEMA_VERSION = migrations().reduce((n, m) => Math.max(n, m.version), 0);

/** The database is newer than this build. Not merely a refusal: the doctor reports it, and
 *  the numbers are on the error so it can say which build to run. */
export class SchemaAheadError extends StoreError {
  constructor(
    readonly found: number,
    readonly understood: number,
    readonly path = "",
  ) {
    super(
      `${where(path)} is at schema ${found} and this build understands ${understood}. ` +
        `Upgrade wecode rather than running an older copy against it.`,
    );
  }
}

/** Which database a refusal is about. A person runs wecode against several workspaces —
 *  the incident was `wecode board` in one project reporting on another workspace's file —
 *  so a refusal that says only "the database" names nothing the person can go and fix. */
const where = (path: string): string => (path === "" ? "the database" : `the database ${path}`);

/** The database is older than this build and the caller said not to upgrade it. Migrating is
 *  a decision: { migrate: false } is how a caller asks to be told rather than upgraded. */
export class SchemaBehindError extends StoreError {
  constructor(
    readonly found: number,
    readonly understood: number,
    readonly path = "",
  ) {
    super(
      `${where(path)} is at schema ${found} and this build understands ${understood}. ` +
        `Migrating is a decision: run the upgrade, or open with { migrate: true }.`,
    );
  }
}

/** The database cannot be written, and the caller asked for something that would write it.
 *
 *  The refusal wecode owes the person instead of SQLite's `attempt to write a readonly
 *  database`: it names the workspace, says a read was turned into a write, and says the
 *  upgrade is theirs to run. */
export class ReadOnlyDatabaseError extends StoreError {
  constructor(
    readonly path: string,
    readonly found: number,
    readonly understood: number,
  ) {
    super(
      `${where(path)} cannot be written by this process, and opening it would upgrade it ` +
        `from schema ${found} to ${understood}. A command that only reads must open it ` +
        `read-only; run the upgrade yourself against a workspace you can write.`,
    );
  }
}

/** The database is not there, and a read-only open cannot create one. */
export class MissingDatabaseError extends StoreError {
  constructor(readonly path: string) {
    super(
      `${where(path)} does not exist, and a read-only open creates nothing — a question ` +
        `may not bring a workspace into being. Initialise that workspace first.`,
    );
  }
}

/** A test reached for the operator's own workspace. */
export class LiveDatabaseError extends StoreError {}

/** The operator's wecode directory, as it is without any redirection. A test that opens
 *  anything under here is talking to the workspace the person is working in — WECODE_HOME
 *  is how a test gets a home of its own. */
const LIVE_HOME = join(homedir(), ".wecode");

const underTest = (): boolean =>
  process.env["VITEST"] !== undefined || process.env["NODE_ENV"] === "test";

/** Every temp directory open() has made in this process and not yet removed. */
const madeUnderTest = new Set<string>();
let sweepRegistered = false;

/** Removes every temp database directory this process made. Registered on process exit,
 *  and exported so a test can prove the sweep rather than wait for its own exit. */
export function sweepTempDatabases(): void {
  for (const dir of madeUnderTest) rmSync(dir, { recursive: true, force: true });
  madeUnderTest.clear();
}

/** A database of a test run's own, under the system temp directory.
 *
 *  The directory is registered so the run removes it: without that every open() with no
 *  path left a `wecode-db-*` tree behind, and a suite that opens hundreds of databases
 *  filled /tmp. Exit is the right moment — the database is open for as long as the process
 *  that asked for it lives, so nothing earlier can be sure it is finished with. */
function tempDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "wecode-db-"));
  madeUnderTest.add(dir);
  if (!sweepRegistered) {
    sweepRegistered = true;
    process.on("exit", sweepTempDatabases);
  }
  return join(dir, "wecode.db");
}

const isLive = (path: string): boolean =>
  path === LIVE_HOME || path.startsWith(LIVE_HOME + sep);

/** How long a writer waits for another writer's lock before giving up.
 *
 *  Without this SQLite returns SQLITE_BUSY the instant a lock is held, and the two writers
 *  here are the runner's tick and whatever cli command the operator just ran: both take
 *  milliseconds, and neither has any reason to fail because the other was mid-write. Five
 *  seconds is far longer than any transaction this ledger holds — the longest is `plan`
 *  writing a whole story tree — so ordinary contention never surfaces at all. It is also
 *  short enough that a genuine deadlock, or a process that took a write lock and wandered
 *  off, still reports `database is locked` while a person is watching rather than hanging
 *  the tick forever. */
const BUSY_TIMEOUT_MS = 5000;

export interface OpenOptions {
  /** Upgrade an older database to this build's schema. Defaults to true. Pass false to be
   *  told — SchemaBehindError — instead of upgraded, which is how the doctor and any caller
   *  that must not write to a database it is only inspecting opens one. */
  readonly migrate?: boolean;
  /** Stop at this version rather than the newest. How a test builds a database that is
   *  honestly older than the build, instead of one with its version lied down. */
  readonly to?: number;
  /** Open for questions only. The connection cannot write, so nothing this call does can
   *  change the file: no schema is created and no migration runs, whatever `migrate` says.
   *  A command that only reads the record opens this way. */
  readonly readOnly?: boolean;
}

export type SchemaState = "absent" | "current" | "behind" | "ahead";

export interface Diagnosis {
  readonly path: string;
  readonly state: SchemaState;
  /** 0 when the file has no schema_version yet. */
  readonly found: number;
  readonly understood: number;
}

/** What a database is, without changing it. The doctor's read: it reports a database that
 *  is ahead or behind instead of throwing, so a person is told what to act on. */
export function diagnose(path: string = currentDatabase()): Diagnosis {
  if (!existsSync(path)) return { path, state: "absent", found: 0, understood: SCHEMA_VERSION };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const found = version(db);
    const state: SchemaState =
      found === null || found === 0
        ? "absent"
        : found > SCHEMA_VERSION
          ? "ahead"
          : found < SCHEMA_VERSION
            ? "behind"
            : "current";
    return { path, state, found: found ?? 0, understood: SCHEMA_VERSION };
  } finally {
    db.close();
  }
}

/** The only thing that speaks to SQLite.
 *
 *  A client built against an older core must refuse a newer database rather than warn:
 *  every client embeds its own copy of the rules, so a mismatch means the rules disagree.
 *
 *  With no path, a test run gets a database of its own under the system temp directory and
 *  everything else gets the current workspace. The default is temporary on purpose: the
 *  suite reaching the operator's workspace once left the installed CLI unable to land. */
export function open(path?: string, options: OpenOptions = {}): DatabaseSync {
  const target = path ?? (underTest() ? tempDatabase() : currentDatabase());

  if (underTest() && isLive(resolve(target))) {
    throw new LiveDatabaseError(
      `a test opened ${resolve(target)}, the operator's own workspace — the path ` +
        `currentDatabase() resolves to. Tests open a temporary database: call open() with ` +
        `no path, or point WECODE_HOME at a temp directory.`,
    );
  }

  const asked = options.readOnly === true;
  if (asked && !existsSync(target)) throw new MissingDatabaseError(target);

  const db = new DatabaseSync(target, asked ? { readOnly: true } : {});
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

  const found = version(db) ?? 0;

  if (found > SCHEMA_VERSION) {
    db.close();
    throw new SchemaAheadError(found, SCHEMA_VERSION, target);
  }

  // A file with no schema at all is this call's to create; an older one is upgraded unless
  // the caller said to be told instead. A read-only open never migrates: the questions it
  // answers are the ones this build's schema and the file's have in common.
  const wanted = options.to ?? SCHEMA_VERSION;
  const behind = found < wanted;
  if (asked) {
    if (behind) {
      db.close();
      throw new SchemaBehindError(found, SCHEMA_VERSION, target);
    }
    return db;
  }

  if (behind && options.migrate === false) {
    db.close();
    throw new SchemaBehindError(found, SCHEMA_VERSION, target);
  }

  // Migrating a file this process cannot write is where SQLite's own sentence used to reach
  // the person: refused here, in wecode's words, before the first statement runs.
  if (behind && existsSync(target) && !writable(target)) {
    db.close();
    throw new ReadOnlyDatabaseError(target, found, SCHEMA_VERSION);
  }

  try {
    for (const m of migrations()) {
      if (m.version <= found || m.version > wanted) continue;
      db.exec(readFileSync(m.path, "utf8"));
      // The migration's own text is a file, and DDL has no spelling in the typed layer; the
      // stamp that records it does, and goes through it — one row, replaced, never appended.
      queries(db).deleteFrom(schemaVersion).run();
      queries(db).insertInto(schemaVersion, { version: m.version }).run();
    }
  } catch (err) {
    db.close();
    if (readOnlyFailure(err)) throw new ReadOnlyDatabaseError(target, found, SCHEMA_VERSION);
    throw err;
  }

  return db;
}

const writable = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** SQLite refused the write because the file, or the directory holding its journal, is not
 *  ours to write. The permission bits can say otherwise — a read-only mount, or a writable
 *  file in a directory we cannot add the -wal to — so the failure itself is checked too. */
const readOnlyFailure = (err: unknown): boolean =>
  err instanceof Error && /readonly|read-only|attempt to write/i.test(err.message);

function version(db: DatabaseSync): number | null {
  const q = queries(db);
  const present = q
    .selectFrom(master)
    .select(["name"])
    .where("type", "=", "table")
    .where("name", "=", schemaVersion.name)
    .get();
  if (present === null) return null;
  return q.selectFrom(schemaVersion).select(["version"]).get()?.version ?? null;
}

export function now(): string {
  return new Date().toISOString();
}

/** How deep in nested transact() calls each database is. Only the outermost one opens and
 *  closes a real transaction; the rest are savepoints inside it. */
const depth = new WeakMap<DatabaseSync, number>();

/** Everything in one transaction, or nothing.
 *
 *  Nestable, because atomicity is a property of the whole operation and not of its innermost
 *  step. `wecode plan` creates a tree and then starts every row in it, and every one of those
 *  starts is an Engine.apply that transacts in its own right: without nesting, either the
 *  starting happens outside the creation's transaction — which is the half-started story #171
 *  left behind when the second half died — or the inner BEGIN refuses. An inner body that
 *  throws rolls back to its savepoint and rethrows, so the outer one still rolls the lot
 *  back unless it chooses to swallow it. */
export function transact<T>(db: DatabaseSync, body: () => T): T {
  const level = depth.get(db) ?? 0;
  const name = `wecode_${level}`;
  db.exec(level === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
  depth.set(db, level + 1);
  try {
    const out = body();
    db.exec(level === 0 ? "COMMIT" : `RELEASE ${name}`);
    return out;
  } catch (err) {
    db.exec(level === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}`);
    if (level > 0) db.exec(`RELEASE ${name}`);
    throw err;
  } finally {
    depth.set(db, level);
  }
}

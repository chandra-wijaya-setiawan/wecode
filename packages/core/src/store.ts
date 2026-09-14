import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { currentDatabase } from "./home.js";

const MIGRATIONS = fileURLToPath(new URL("../sql/migrations", import.meta.url));

/** Every file in sql/migrations, in name order. The number in the filename is the version
 *  it brings the database to, so adding one is a file rather than an edit. */
function migrations(): readonly { version: number; path: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ version: Number.parseInt(f, 10), path: join(MIGRATIONS, f) }));
}

export const SCHEMA_VERSION = migrations().reduce((n, m) => Math.max(n, m.version), 0);

export class StoreError extends Error {}

/** The database is newer than this build. Not merely a refusal: the doctor reports it, and
 *  the numbers are on the error so it can say which build to run. */
export class SchemaAheadError extends StoreError {
  constructor(
    readonly found: number,
    readonly understood: number,
  ) {
    super(
      `the database is at schema ${found} and this build understands ${understood}. ` +
        `Upgrade wecode rather than running an older copy against it.`,
    );
  }
}

/** The database is older than this build and the caller said not to upgrade it. Migrating is
 *  a decision: { migrate: false } is how a caller asks to be told rather than upgraded. */
export class SchemaBehindError extends StoreError {
  constructor(
    readonly found: number,
    readonly understood: number,
  ) {
    super(
      `the database is at schema ${found} and this build understands ${understood}. ` +
        `Migrating is a decision: run the upgrade, or open with { migrate: true }.`,
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

const isLive = (path: string): boolean =>
  path === LIVE_HOME || path.startsWith(LIVE_HOME + sep);

export interface OpenOptions {
  /** Upgrade an older database to this build's schema. Defaults to true. Pass false to be
   *  told — SchemaBehindError — instead of upgraded, which is how the doctor and any caller
   *  that must not write to a database it is only inspecting opens one. */
  readonly migrate?: boolean;
  /** Stop at this version rather than the newest. How a test builds a database that is
   *  honestly older than the build, instead of one with its version lied down. */
  readonly to?: number;
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
  const target = path ?? (underTest() ? join(mkdtempSync(join(tmpdir(), "wecode-db-")), "wecode.db") : currentDatabase());

  if (underTest() && isLive(resolve(target))) {
    throw new LiveDatabaseError(
      `a test opened ${resolve(target)}, the operator's own workspace — the path ` +
        `currentDatabase() resolves to. Tests open a temporary database: call open() with ` +
        `no path, or point WECODE_HOME at a temp directory.`,
    );
  }

  const db = new DatabaseSync(target);
  db.exec("PRAGMA foreign_keys = ON");

  const found = version(db) ?? 0;

  if (found > SCHEMA_VERSION) {
    db.close();
    throw new SchemaAheadError(found, SCHEMA_VERSION);
  }

  // A file with no schema at all is this call's to create; an older one is upgraded unless
  // the caller said to be told instead.
  const wanted = options.to ?? SCHEMA_VERSION;
  const mayMigrate = options.migrate ?? true;
  if (found < wanted && !mayMigrate) {
    db.close();
    throw new SchemaBehindError(found, SCHEMA_VERSION);
  }

  for (const m of migrations()) {
    if (m.version <= found || m.version > wanted) continue;
    db.exec(readFileSync(m.path, "utf8"));
    db.exec("DELETE FROM schema_version");
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
  }

  return db;
}

function version(db: DatabaseSync): number | null {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get();
  if (table === undefined) return null;
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  return row?.version ?? null;
}

export function now(): string {
  return new Date().toISOString();
}

/** Everything in one transaction, or nothing. */
export function transact<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = body();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

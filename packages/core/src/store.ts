import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCHEMA = fileURLToPath(new URL("../sql/schema.sql", import.meta.url));

export const SCHEMA_VERSION = 1;

export class StoreError extends Error {}

/** The only thing that speaks to SQLite.
 *
 *  A client built against an older core must refuse a newer database rather than warn:
 *  every client embeds its own copy of the rules, so a mismatch means the rules disagree. */
export function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");

  const found = version(db);
  if (found === null) {
    db.exec(readFileSync(SCHEMA, "utf8"));
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    return db;
  }
  if (found > SCHEMA_VERSION) {
    db.close();
    throw new StoreError(
      `the database is at schema ${found} and this build understands ${SCHEMA_VERSION}. ` +
        `Upgrade wecode rather than running an older copy against it.`,
    );
  }
  if (found < SCHEMA_VERSION) {
    db.close();
    throw new StoreError(`the database is at schema ${found}; migration to ${SCHEMA_VERSION} is not implemented`);
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

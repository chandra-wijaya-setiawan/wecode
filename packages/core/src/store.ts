import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** The only thing that speaks to SQLite.
 *
 *  A client built against an older core must refuse a newer database rather than warn:
 *  every client embeds its own copy of the rules, so a mismatch means the rules disagree. */
export function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");

  const found = version(db) ?? 0;

  if (found > SCHEMA_VERSION) {
    db.close();
    throw new StoreError(
      `the database is at schema ${found} and this build understands ${SCHEMA_VERSION}. ` +
        `Upgrade wecode rather than running an older copy against it.`,
    );
  }

  for (const m of migrations()) {
    if (m.version <= found) continue;
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

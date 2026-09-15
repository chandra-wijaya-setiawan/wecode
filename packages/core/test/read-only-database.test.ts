import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diagnose,
  MissingDatabaseError,
  open,
  ReadOnlyDatabaseError,
  SCHEMA_VERSION,
  SchemaBehindError,
  StoreError,
} from "../src/index.js";
import { tmp } from "./tmpdir.js";

/** The incident, reduced to its parts: a workspace database that is honestly older than
 *  this build, and a process that cannot write it. `wecode board` — a read — met both and
 *  answered with SQLite's `attempt to write a readonly database` after having already
 *  migrated a different workspace from 7 to 13. */
const older = (): string => {
  const path = join(tmp("wecode-readonly-"), "wecode.db");
  open(path, { to: SCHEMA_VERSION - 1 }).close();
  expect(diagnose(path).state).toBe("behind");
  return path;
};

/** Older, and not this process's to write. */
const unwritable = (): string => {
  const path = older();
  chmodSync(path, 0o444);
  return path;
};

/** At this build's schema, and not this process's to write: the case a read must answer. */
const current = (): string => {
  const path = join(tmp("wecode-readonly-"), "wecode.db");
  open(path).close();
  chmodSync(path, 0o444);
  return path;
};

describe("a read opens for questions and migrates nothing", () => {
  it("answers from a database it is not allowed to change", () => {
    const db = open(current(), { readOnly: true });
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: SCHEMA_VERSION,
    });
    db.close();
  });

  it("refuses to write through a read-only connection at all", () => {
    const path = current();
    const db = open(path, { readOnly: true });
    expect(() => db.exec("DELETE FROM schema_version")).toThrow();
    db.close();
    expect(diagnose(path).found).toBe(SCHEMA_VERSION);
  });

  it("migrates nothing even when the caller also asked to migrate", () => {
    const path = older();
    expect(() => open(path, { readOnly: true, migrate: true })).toThrow(SchemaBehindError);
    expect(diagnose(path).found).toBe(SCHEMA_VERSION - 1);
  });

  it("says which database is behind rather than upgrading it", () => {
    const path = older();
    let thrown: unknown;
    try {
      open(path, { readOnly: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SchemaBehindError);
    expect((thrown as Error).message).toContain(path);
  });

  it("creates nothing when there is no database to read, and names the path", () => {
    const path = join(tmp("wecode-readonly-"), "wecode.db");
    let thrown: unknown;
    try {
      open(path, { readOnly: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MissingDatabaseError);
    expect((thrown as Error).message).toContain(path);
    expect(existsSync(path)).toBe(false);
  });
});

describe("a database this process cannot write is refused in wecode's own words", () => {
  it("does not answer with SQLite's sentence", () => {
    let thrown: unknown;
    try {
      open(unwritable());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ReadOnlyDatabaseError);
    expect(thrown).toBeInstanceOf(StoreError);
    expect((thrown as Error).message).not.toMatch(/attempt to write a readonly database/);
  });

  it("names the workspace it is about, so the person knows which one to fix", () => {
    const path = unwritable();
    let thrown: unknown;
    try {
      open(path);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toContain(path);
    expect(thrown).toMatchObject({ path, found: SCHEMA_VERSION - 1, understood: SCHEMA_VERSION });
  });

  it("says the upgrade is the person's to run", () => {
    expect(() => open(unwritable())).toThrow(/read-only|upgrade/i);
  });

  it("leaves the schema exactly where it found it", () => {
    const path = unwritable();
    expect(() => open(path)).toThrow(ReadOnlyDatabaseError);
    expect(diagnose(path).found).toBe(SCHEMA_VERSION - 1);
  });

  it("still opens it read-only for questions, once it is at this build's schema", () => {
    const path = join(tmp("wecode-readonly-"), "wecode.db");
    open(path).close();
    chmodSync(path, 0o444);
    const db = open(path, { readOnly: true });
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: SCHEMA_VERSION,
    });
    db.close();
  });
});

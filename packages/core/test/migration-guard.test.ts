import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diagnose,
  LiveDatabaseError,
  open,
  SCHEMA_VERSION,
  SchemaAheadError,
  SchemaBehindError,
} from "../src/index.js";
import { tmp } from "./tmpdir.js";

/** The path the incident reached: the operator's own workspace database, which is what
 *  currentDatabase() resolves to whenever WECODE_DB and WECODE_HOME are unset. Named, never
 *  created — touching it is the thing under test. */
const live = join(homedir(), ".wecode", "workspaces", "default", "wecode.db");

const fresh = (): string => join(tmp("wecode-guard-"), "wecode.db");

describe("a test may not open the operator's workspace", () => {
  it("refuses the live path, and says which path and why", () => {
    let thrown: unknown;
    try {
      open(live);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LiveDatabaseError);
    expect((thrown as Error).message).toContain(live);
    expect((thrown as Error).message).toMatch(/operator's own workspace/);
    expect((thrown as Error).message).toMatch(/temporary database/);
  });

  it("refuses every database under the operator's wecode home, not just the default one", () => {
    const other = join(homedir(), ".wecode", "workspaces", "acme", "wecode.db");
    expect(() => open(other)).toThrow(/operator's own workspace/);
  });

  it("leaves no file behind when it refuses", () => {
    const path = join(homedir(), ".wecode", "workspaces", "not-a-real-workspace", "wecode.db");
    expect(() => open(path)).toThrow(/operator's own workspace/);
    expect(existsSync(path)).toBe(false);
  });

  it("opens a temporary database when a test asks for no path at all", () => {
    const db = open();
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: SCHEMA_VERSION,
    });
    db.close();
  });
});

describe("a temporary database still migrates normally", () => {
  it("creates the whole schema on a new file", () => {
    const path = fresh();
    const db = open(path);
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: SCHEMA_VERSION,
    });
    expect(db.prepare("SELECT count(*) AS n FROM task").get()).toEqual({ n: 0 });
    db.close();
    expect(diagnose(path).state).toBe("current");
  });

  it("reopens one already at this schema without complaint", () => {
    const path = fresh();
    open(path).close();
    const db = open(path);
    expect(db.prepare("SELECT count(*) AS n FROM story").get()).toEqual({ n: 0 });
    db.close();
  });

  it("brings an older one forward, keeping the rows that were already in it", () => {
    const path = fresh();
    const old = open(path, { to: SCHEMA_VERSION - 1 });
    old.prepare("INSERT INTO workspace (slug,name,path,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run("acme", "acme", "/acme", "2026-09-14T00:00:00.000Z", "2026-09-14T00:00:00.000Z");
    old.close();

    const db = open(path);
    expect(db.prepare("SELECT slug FROM workspace").get()).toEqual({ slug: "acme" });
    db.close();
    expect(diagnose(path).state).toBe("current");
  });
});

describe("migrating is a decision, not a side effect", () => {
  /** Honestly one version behind: migrated as far as the build before this one, not a
   *  current schema with its version written down. */
  const older = (): string => {
    const path = fresh();
    open(path, { to: SCHEMA_VERSION - 1 }).close();
    expect(diagnose(path).state).toBe("behind");
    return path;
  };

  it("reports an older database rather than upgrading it, when asked not to upgrade", () => {
    const path = older();
    expect(() => open(path, { migrate: false })).toThrow(SchemaBehindError);
    expect(diagnose(path).found).toBe(SCHEMA_VERSION - 1);
  });

  it("carries both numbers, so the doctor can name the upgrade to run", () => {
    let thrown: unknown;
    try {
      open(older(), { migrate: false });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ found: SCHEMA_VERSION - 1, understood: SCHEMA_VERSION });
  });

  it("upgrades it when the caller decides to", () => {
    const path = older();
    open(path, { migrate: true }).close();
    expect(diagnose(path).state).toBe("current");
  });

  it("reports it as behind before anyone opens it, so the decision can be made first", () => {
    expect(diagnose(older())).toMatchObject({
      state: "behind",
      found: SCHEMA_VERSION - 1,
      understood: SCHEMA_VERSION,
    });
  });
});

describe("a newer database is something to act on", () => {
  const ahead = (): string => {
    const path = fresh();
    const db = open(path);
    db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION + 1);
    db.close();
    return path;
  };

  it("refuses to open, carrying both numbers so the doctor can name the build", () => {
    const path = ahead();
    let thrown: unknown;
    try {
      open(path);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SchemaAheadError);
    expect(thrown).toMatchObject({ found: SCHEMA_VERSION + 1, understood: SCHEMA_VERSION });
  });

  it("is reported rather than thrown when the doctor asks", () => {
    expect(diagnose(ahead())).toMatchObject({
      state: "ahead",
      found: SCHEMA_VERSION + 1,
      understood: SCHEMA_VERSION,
    });
  });

  it("reports a database that does not exist as absent, without creating it", () => {
    const path = fresh();
    expect(diagnose(path).state).toBe("absent");
    expect(existsSync(path)).toBe(false);
  });
});

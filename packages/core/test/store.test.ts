import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { open, SCHEMA_VERSION, StoreError } from "../src/index.js";

const fresh = () => join(mkdtempSync(join(tmpdir(), "wecode-")), "wecode.db");

describe("the store", () => {
  it("creates the schema on a new file", () => {
    const db = open(fresh());
    const row = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    expect(row.version).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("reopens an existing one", () => {
    const path = fresh();
    open(path).close();
    const db = open(path);
    expect(db.prepare("SELECT count(*) AS n FROM task").get()).toEqual({ n: 0 });
    db.close();
  });

  it("refuses a database newer than this build, rather than warning", () => {
    const path = fresh();
    const db = open(path);
    db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION + 1);
    db.close();
    expect(() => open(path)).toThrow(StoreError);
  });

  it("enforces foreign keys", () => {
    const db = open(fresh());
    expect(() =>
      db
        .prepare("INSERT INTO project (slug, workspace_id, name, repo, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
        .run("x", 999, "x", "/x", "planned", "t", "t"),
    ).toThrow();
    db.close();
  });
});

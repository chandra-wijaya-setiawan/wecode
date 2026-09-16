import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Dialect, excluded, queries, table } from "../src/db.js";
import { readLease, recordBuildDrift, releaseLease, renewLease, runnerLease, takeLease } from "../src/index.js";
import type { RunnerLeaseRow } from "../src/index.js";
import { freshDb } from "./helpers.js";

const EVERY = 15_000;
const T0 = "2026-09-14T10:00:00.000Z";

let db: DatabaseSync;
let q: Dialect;

beforeEach(() => {
  db = freshDb();
  q = queries(db);
});

describe("the typed query layer", () => {
  it("compiles a select to the columns asked for and the values bound", () => {
    expect(q.selectFrom(runnerLease).select(["holder", "heartbeat"]).where("id", "=", 1).compile()).toEqual({
      sql: 'SELECT "holder", "heartbeat" FROM "runner_lease" WHERE "id" = ?',
      params: [1],
    });
  });

  it("selects every declared column when none are named", () => {
    expect(q.selectFrom(runnerLease).compile().sql).toBe(
      'SELECT "id", "holder", "interval_ms", "taken_at", "heartbeat", "build_sha", "build_behind" FROM "runner_lease"',
    );
  });

  it("ands every where clause together, in the order they were added", () => {
    expect(q.selectFrom(runnerLease).select(["holder"]).where("id", "=", 1).where("holder", "!=", "a").compile()).toEqual({
      sql: 'SELECT "holder" FROM "runner_lease" WHERE "id" = ? AND "holder" != ?',
      params: [1, "a"],
    });
  });

  it("spells a null comparison as IS NULL, because = NULL is never true", () => {
    expect(q.selectFrom(runnerLease).select(["holder"]).where("build_sha", "=", null).compile()).toEqual({
      sql: 'SELECT "holder" FROM "runner_lease" WHERE "build_sha" IS NULL',
      params: [],
    });
    expect(q.selectFrom(runnerLease).select(["holder"]).where("build_sha", "!=", null).compile().sql).toContain(
      '"build_sha" IS NOT NULL',
    );
  });

  it("refuses an ordering comparison against null rather than compiling one that matches nothing", () => {
    expect(() => q.selectFrom(runnerLease).select(["holder"]).where("build_behind", ">", null).compile()).toThrow(
      /never true/,
    );
  });

  it("binds every inserted value as a parameter, and names the excluded row in an upsert", () => {
    const compiled = q
      .insertInto(runnerLease, {
        id: 1,
        holder: "a",
        interval_ms: EVERY,
        taken_at: T0,
        heartbeat: T0,
        build_sha: null,
        build_behind: null,
      })
      .onConflict(["id"], { holder: excluded<RunnerLeaseRow>("holder"), build_behind: null })
      .compile();
    expect(compiled.sql).toBe(
      'INSERT INTO "runner_lease" ("id", "holder", "interval_ms", "taken_at", "heartbeat", "build_sha", "build_behind") ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT ("id") DO UPDATE SET "holder" = excluded."holder", "build_behind" = ?',
    );
    expect(compiled.params).toEqual([1, "a", EVERY, T0, T0, null, null, null]);
  });

  it("compiles an update with its assignments bound before its conditions", () => {
    expect(q.update(runnerLease).set({ heartbeat: T0 }).where("id", "=", 1).where("holder", "=", "a").compile()).toEqual({
      sql: 'UPDATE "runner_lease" SET "heartbeat" = ? WHERE "id" = ? AND "holder" = ?',
      params: [T0, 1, "a"],
    });
  });

  it("refuses an update that sets nothing", () => {
    expect(() => q.update(runnerLease).where("id", "=", 1).compile()).toThrow(/sets nothing/);
  });

  it("compiles a delete", () => {
    expect(q.deleteFrom(runnerLease).where("holder", "=", "a").compile()).toEqual({
      sql: 'DELETE FROM "runner_lease" WHERE "holder" = ?',
      params: ["a"],
    });
  });

  it("quotes an identifier, so a column named like a keyword is still a column", () => {
    const odd = table<{ from: string }>("order", ["from"]);
    expect(q.selectFrom(odd).compile().sql).toBe('SELECT "from" FROM "order"');
  });

  it("reports how many rows a write touched, which is how a guarded write says it missed", () => {
    takeLease(db, "a", EVERY, T0);
    expect(q.update(runnerLease).set({ heartbeat: T0 }).where("holder", "=", "a").run()).toEqual({ changes: 1 });
    expect(q.update(runnerLease).set({ heartbeat: T0 }).where("holder", "=", "b").run()).toEqual({ changes: 0 });
    expect(q.deleteFrom(runnerLease).where("holder", "=", "b").run()).toEqual({ changes: 0 });
  });

  it("reads back what it wrote, and answers null for a row that is not there", () => {
    expect(q.selectFrom(runnerLease).where("id", "=", 1).get()).toBeNull();
    q.insertInto(runnerLease, {
      id: 1,
      holder: "a",
      interval_ms: EVERY,
      taken_at: T0,
      heartbeat: T0,
      build_sha: "abc1234",
      build_behind: 2,
    }).run();
    expect(q.selectFrom(runnerLease).where("id", "=", 1).get()).toEqual({
      id: 1,
      holder: "a",
      interval_ms: EVERY,
      taken_at: T0,
      heartbeat: T0,
      build_sha: "abc1234",
      build_behind: 2,
    });
    expect(q.selectFrom(runnerLease).select(["holder"]).all()).toEqual([{ holder: "a" }]);
    expect(q.selectFrom(runnerLease).select(["holder"]).where("holder", "=", "b").get()).toBeNull();
  });

  it("hands the same dialect back for the same database", () => {
    expect(queries(db)).toBe(q);
    expect(queries(freshDb())).not.toBe(q);
  });
});

describe("the declared runner_lease table", () => {
  it("names exactly the columns the migrations built, so the two cannot drift apart", () => {
    const actual = (db.prepare("PRAGMA table_info(runner_lease)").all() as { name: string }[]).map((c) => c.name);
    expect([...runnerLease.columns].sort()).toEqual([...actual].sort());
  });
});

describe("the lease, ported onto the typed layer", () => {
  it("takes, renews and releases through the layer, and refuses a live holder", () => {
    expect(takeLease(db, "a", EVERY, T0).ok).toBe(true);
    expect(readLease(db)).toEqual({ holder: "a", intervalMs: EVERY, takenAt: T0, heartbeat: T0 });
    expect(renewLease(db, "b", T0)).toBe(false);
    expect(renewLease(db, "a", "2026-09-14T10:00:15.000Z")).toBe(true);
    expect(readLease(db)?.heartbeat).toBe("2026-09-14T10:00:15.000Z");
    releaseLease(db, "a");
    expect(readLease(db)).toBeNull();
  });

  it("carries the build sha, and drops the drift when a new holder takes over", () => {
    takeLease(db, "a", EVERY, T0, "abc1234");
    recordBuildDrift(db, "a", 7);
    expect(readLease(db)).toMatchObject({ buildSha: "abc1234", buildBehind: 7 });

    // Stale by three intervals and more, so b may take it.
    takeLease(db, "b", EVERY, "2026-09-14T10:02:00.000Z", "def5678");
    const held = readLease(db);
    expect(held).toMatchObject({ holder: "b", buildSha: "def5678" });
    expect(held).not.toHaveProperty("buildBehind");
  });

  it("ignores drift recorded by a runner that does not hold the lease", () => {
    takeLease(db, "a", EVERY, T0, "abc1234");
    recordBuildDrift(db, "b", 99);
    expect(readLease(db)).not.toHaveProperty("buildBehind");
  });
});

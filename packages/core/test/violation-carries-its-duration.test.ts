import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  doctorRun,
  reportWrites,
  UNREASONED,
  violationDuration,
  violationKey,
  type OpenViolation,
  type ReportWrite,
  type Remediation,
  type Violation,
} from "../src/index.js";
import { freshDb } from "./helpers.js";

/** Migration 014's tables are proven against the migrated database rather than against the
 *  file: `doctor_violation` existed before 014 as the runner's own `CREATE TABLE IF NOT
 *  EXISTS`, so what matters is the shape a migrated record ends up with, not the shape one
 *  statement in one file asks for. */
let db: DatabaseSync;

beforeEach(() => {
  db = freshDb();
});

const columnsOf = (table: string): readonly string[] =>
  (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((r) => r.name);

/** The writes `reportWrites` describes, applied. This is the caller's half — the half with
 *  the handle — and it lives in the test because the runner's pass is the next slice: what
 *  is being proven is that the description is enough to keep the report, and a second
 *  implementation of it would prove only itself. */
const apply = (writes: readonly ReportWrite[]): void => {
  for (const w of writes) {
    if (w.op === "open") {
      db.prepare(
        `INSERT INTO doctor_violation
           (invariant, entity, entity_id, slug, detail, found_at, kind, heal, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        w.row.invariant,
        w.row.entity,
        w.row.id,
        w.row.slug,
        w.row.detail,
        w.row.found_at,
        w.row.kind,
        w.row.heal,
        w.row.first_seen,
        w.row.last_seen,
      );
    } else if (w.op === "seen") {
      db.prepare("UPDATE doctor_violation SET last_seen = ? WHERE rowid = ?").run(w.last_seen, w.rowid);
    } else {
      db.prepare("UPDATE doctor_violation SET cleared_at = ? WHERE rowid = ?").run(w.cleared_at, w.rowid);
    }
  }
};

interface Row {
  rowid: number;
  invariant: string;
  entity: string;
  entity_id: number | null;
  slug: string;
  detail: string;
  kind: string | null;
  heal: string | null;
  first_seen: string | null;
  last_seen: string | null;
  cleared_at: string | null;
}

const rows = (): Row[] =>
  db
    .prepare(
      `SELECT rowid, invariant, entity, entity_id, slug, detail, kind, heal, first_seen, last_seen, cleared_at
         FROM doctor_violation ORDER BY rowid`,
    )
    .all() as unknown as Row[];

/** The open rows, in the shape a pass is handed them. */
const open = (): readonly OpenViolation[] =>
  rows()
    .filter((r) => r.cleared_at === null)
    .map(({ rowid, invariant, entity, entity_id, slug }) => ({ rowid, invariant, entity, entity_id, slug }));

const drift = (overrides: Partial<Violation> = {}): Violation => ({
  invariant: "delivered_story_has_landed",
  entity: "story",
  id: 7,
  slug: "password-reset",
  detail: "delivered with no landed_sha",
  ...overrides,
});

const T1 = "2026-09-16T00:00:00.000Z";
const T2 = "2026-09-16T00:00:30.000Z";
const T3 = "2026-09-17T00:00:00.000Z";

const everythingRan = (): boolean => true;

describe("migration 014, on the migrated record", () => {
  it("gives doctor_violation a kind, a heal, a first_seen, a last_seen and a cleared_at", () => {
    expect(columnsOf("doctor_violation")).toEqual([
      "invariant",
      "entity",
      "entity_id",
      "slug",
      "detail",
      "found_at",
      "kind",
      "heal",
      "first_seen",
      "last_seen",
      "cleared_at",
    ]);
  });

  /** The runner's own insert names the first six columns and is outside this slice. A pass
   *  that has not been taught the new ones must still be able to write a row. */
  it("leaves every added column nullable, so the runner's six-column insert still works", () => {
    db.prepare(
      `INSERT INTO doctor_violation (invariant, entity, entity_id, slug, detail, found_at)
       VALUES ('role_with_ready_work_has_a_worker', 'role', NULL, 'engineer', 'nobody fills it', ?)`,
    ).run(T1);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ kind: null, heal: null, first_seen: null, last_seen: null, cleared_at: null });
  });

  it("records one row per pass, with its duration and what it looked at", () => {
    expect(columnsOf("doctor_run")).toEqual(["at", "duration_ms", "checks_run", "checks_failed"]);
  });

  /** The name is the collision this slice had to route around: `doctor_pass` is the runner's
   *  table for one row per check within a pass, and taking it here would silence its
   *  `CREATE TABLE IF NOT EXISTS`. */
  it("leaves doctor_pass to the runner rather than taking the name", () => {
    expect(columnsOf("doctor_pass")).toEqual([]);
  });

  /** Two open rows claiming one finding is the duplicate `last_seen` exists to avoid, and
   *  the schema refuses it rather than trusting every writer to. */
  it("refuses a second open row for a finding that is already open", () => {
    apply(reportWrites([], [drift()], T1, everythingRan));

    expect(() => apply(reportWrites([], [drift({ detail: "said differently" })], T2, everythingRan))).toThrow();
    expect(rows()).toHaveLength(1);
  });

  /** SQLite counts NULLs as distinct in a unique index, so a finding with no id at all — a
   *  role or the schema version — is exactly where the constraint would quietly not apply. */
  it("refuses it for a finding with no entity_id either", () => {
    const roleDrift = drift({ invariant: "role_with_ready_work_has_a_worker", entity: "role", id: null, slug: "engineer" });
    apply(reportWrites([], [roleDrift], T1, everythingRan));

    expect(() => apply(reportWrites([], [roleDrift], T2, everythingRan))).toThrow();
    expect(rows()).toHaveLength(1);
  });

  it("still allows a second row once the first has been cleared", () => {
    apply(reportWrites([], [drift()], T1, everythingRan));
    apply(reportWrites(open(), [], T2, everythingRan));
    apply(reportWrites(open(), [drift()], T3, everythingRan));

    expect(rows().map((r) => [r.first_seen, r.cleared_at])).toEqual([
      [T1, T2],
      [T3, null],
    ]);
  });
});

describe("a violation found again", () => {
  it("updates last_seen rather than inserting a second row", () => {
    apply(reportWrites([], [drift()], T1, everythingRan));
    const writes = reportWrites(open(), [drift()], T2, everythingRan);
    apply(writes);

    expect(writes).toEqual([{ op: "seen", rowid: 1, last_seen: T2 }]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ first_seen: T1, last_seen: T2, cleared_at: null });
  });

  /** The duration is the point of the two columns: a drift found ten seconds ago and one
   *  that has stood a day are the same row without it. */
  it("carries how long it has been standing, and zero when this pass found it first", () => {
    apply(reportWrites([], [drift()], T1, everythingRan));
    expect(violationDuration(rows()[0] as { first_seen: string; last_seen: string })).toBe(0);

    apply(reportWrites(open(), [drift()], T2, everythingRan));
    expect(violationDuration(rows()[0] as { first_seen: string; last_seen: string })).toBe(30_000);

    apply(reportWrites(open(), [drift()], T3, everythingRan));
    expect(violationDuration(rows()[0] as { first_seen: string; last_seen: string })).toBe(86_400_000);
  });

  /** `detail` is not part of the identity: an accusation that now names a different sha is
   *  the same drift still standing, and a new row for it would reset its duration. */
  it("is the same violation when only its detail has changed", () => {
    apply(reportWrites([], [drift()], T1, everythingRan));
    apply(reportWrites(open(), [drift({ detail: "delivered with no landed_sha — it never reached the base" })], T2, everythingRan));

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ first_seen: T1, last_seen: T2 });
  });

  it("is a different violation when the same sentence names another entity", () => {
    apply(reportWrites([], [drift()], T1, everythingRan));
    apply(reportWrites(open(), [drift(), drift({ id: 8, slug: "session-timeout" })], T2, everythingRan));

    expect(rows().map((r) => [r.slug, r.first_seen])).toEqual([
      ["password-reset", T1],
      ["session-timeout", T2],
    ]);
  });

  it("tells a role finding from a schema finding, though neither has an id", () => {
    expect(violationKey("i", "role", null, "engineer")).not.toBe(violationKey("i", "schema_version", null, "engineer"));
    expect(violationKey("i", "story", 7, "s")).toBe(violationKey("i", "story", 7, "s"));
  });
});

describe("a violation a pass no longer finds", () => {
  it("has cleared_at set by that pass, and is never deleted", () => {
    apply(reportWrites([], [drift()], T1, everythingRan));
    const writes = reportWrites(open(), [], T2, everythingRan);
    apply(writes);

    expect(writes).toEqual([{ op: "clear", rowid: 1, cleared_at: T2 }]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ first_seen: T1, last_seen: T1, cleared_at: T2 });
  });

  it("is cleared once and not re-cleared by every pass after it", () => {
    apply(reportWrites([], [drift()], T1, everythingRan));
    apply(reportWrites(open(), [], T2, everythingRan));

    expect(reportWrites(open(), [], T3, everythingRan)).toEqual([]);
    expect(rows()[0]?.cleared_at).toBe(T2);
  });

  /** A check that could not run has learned nothing, so clearing its violations would
   *  record a heal nobody performed. */
  it("is left standing when the check that would have found it did not run", () => {
    apply(reportWrites([], [drift()], T1, everythingRan));

    expect(reportWrites(open(), [], T2, () => false)).toEqual([]);
    expect(rows()[0]).toMatchObject({ last_seen: T1, cleared_at: null });
  });

  it("clears only the checks that ran, and leaves the others alone", () => {
    const other = drift({ invariant: "ready_task_has_a_ready_task_test", entity: "task", id: 9, slug: "send-mail" });
    apply(reportWrites([], [drift(), other], T1, everythingRan));

    apply(reportWrites(open(), [], T2, (i) => i === "delivered_story_has_landed"));

    expect(rows().map((r) => [r.invariant, r.cleared_at])).toEqual([
      ["delivered_story_has_landed", T2],
      ["ready_task_has_a_ready_task_test", null],
    ]);
  });
});

describe("the fix a violation is opened with", () => {
  const remedy = (i: string): Remediation =>
    i === "delivered_story_has_landed" ? { kind: "safe", heal: "land" } : UNREASONED;

  it("is written on the row the pass opens", () => {
    apply(reportWrites([], [drift()], T1, everythingRan, remedy));

    expect(rows()[0]).toMatchObject({ kind: "safe", heal: "land" });
  });

  it("is major with no heal for a check nobody has reasoned about", () => {
    apply(reportWrites([], [drift({ invariant: "the_moon_is_where_we_left_it" })], T1, everythingRan, remedy));

    expect(rows()[0]).toMatchObject({ kind: "major", heal: null });
    expect(UNREASONED).toEqual({ kind: "major", heal: null });
  });

  it("defaults to major when the caller offers no table of remedies at all", () => {
    apply(reportWrites([], [drift()], T1, everythingRan));

    expect(rows()[0]).toMatchObject({ kind: "major", heal: null });
  });
});

describe("one row per pass, whatever it found", () => {
  const run = (r: ReturnType<typeof doctorRun>): void => {
    db.prepare("INSERT INTO doctor_run (at, duration_ms, checks_run, checks_failed) VALUES (?, ?, ?, ?)").run(
      r.at,
      r.duration_ms,
      r.checks_run,
      r.checks_failed,
    );
  };
  const runs = (): { at: string; duration_ms: number; checks_run: number; checks_failed: number }[] =>
    db.prepare("SELECT at, duration_ms, checks_run, checks_failed FROM doctor_run ORDER BY rowid").all() as never;

  const clean = [
    { invariant: "delivered_story_has_landed", ran: true, found: 0 },
    { invariant: "ready_task_has_a_ready_task_test", ran: true, found: 0 },
  ];

  it("writes a row for a pass that found nothing", () => {
    run(doctorRun(clean, T1, 12));

    expect(runs()).toEqual([{ at: T1, duration_ms: 12, checks_run: 2, checks_failed: 0 }]);
  });

  it("writes a row for a pass that found something, and counts the checks that found it", () => {
    run(doctorRun([{ ...clean[0]!, found: 3 }, clean[1]!], T1, 40));

    expect(runs()).toEqual([{ at: T1, duration_ms: 40, checks_run: 2, checks_failed: 1 }]);
  });

  /** The distinction the table exists for: nothing found out of two checks run is a healthy
   *  record, and nothing found out of none is a record nobody looked at. */
  it("tells a pass that ran everything and found nothing from one that ran nothing", () => {
    run(doctorRun(clean, T1, 12));
    run(doctorRun(clean.map((c) => ({ ...c, ran: false })), T2, 1));

    expect(runs().map((r) => r.checks_run)).toEqual([2, 0]);
    expect(runs().map((r) => r.checks_failed)).toEqual([0, 0]);
  });

  it("counts no check that did not run, however much it would have found", () => {
    expect(doctorRun([{ invariant: "i", ran: false, found: 9 }], T1, 5)).toEqual({
      at: T1,
      duration_ms: 5,
      checks_run: 0,
      checks_failed: 0,
    });
  });

  it("appends, so the passes before the last one are still there", () => {
    run(doctorRun(clean, T1, 12));
    run(doctorRun(clean, T2, 13));
    run(doctorRun(clean, T3, 14));

    expect(runs().map((r) => r.at)).toEqual([T1, T2, T3]);
  });

  it("carries a duration the caller measured, and reads no clock of its own", () => {
    const before = doctorRun(clean, T1, 1234);
    const after = doctorRun(clean, T1, 1234);

    expect(before).toEqual(after);
    expect(before.duration_ms).toBe(1234);
  });
});

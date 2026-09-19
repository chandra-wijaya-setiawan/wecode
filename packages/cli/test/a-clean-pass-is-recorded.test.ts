import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { run } from "../src/run.js";
import { checksOf } from "../src/doctor.js";
import { TREE_INVARIANTS } from "../src/unimported.js";
import { recordRed, seed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";

/** `doctor_violation` answers "what is broken". Nothing answered "did anybody look, and how
 *  hard": an empty report after a pass that ran every check is a healthy record, an empty
 *  report after a pass that ran nothing is a record nobody has examined, and as zero rows
 *  the two read the same. So every pass appends one row to `doctor_run` saying when it ran,
 *  how long it took, and how many checks it got answers out of.
 *
 *  And nothing else. The row is a fact about the doctor, not about the work — the ledger,
 *  which is what happened to the work, stays exactly as the pass found it. */

let db: DatabaseSync;
let ids: ReturnType<typeof seed>;

beforeEach(() => {
  const path = join(tmp("wecode-doctor-run-"), "wecode.db");
  process.env["WECODE_DB"] = path;
  db = open(path);
  ids = seed(db);
  recordRed(db, ids.acceptance);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

interface RunRow {
  at: string;
  duration_ms: number;
  checks_run: number;
  checks_failed: number;
}

const passes = (): RunRow[] =>
  db.prepare("SELECT at, duration_ms, checks_run, checks_failed FROM doctor_run ORDER BY rowid").all() as
    unknown as RunRow[];

/** The seed names no repository on disk, so the one git-answered check cannot be made. A
 *  check that could not run is neither clean nor broken and is not counted — which is the
 *  whole reason the row carries a count rather than a tick. */
const ANSWERABLE = checksOf().filter((c) => !c.world).length;

const ledgerLines = (): number =>
  (db.prepare("SELECT count(*) AS n FROM ledger").get() as { n: number }).n;

describe("a clean pass is recorded", () => {
  it("writes one row for a pass that found nothing", () => {
    expect(run(["doctor"])).toBe(0);

    const rows = passes();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.checks_failed).toBe(0);
    // Nothing found out of every check run is a healthy record; nothing found out of none
    // is a record nobody looked at, and the counts are the only thing that tells them apart.
    expect(rows[0]?.checks_run).toBe(ANSWERABLE);
    expect(ANSWERABLE).toBeGreaterThan(0);
  });

  it("counts the checks that broke, not the entities that broke them", () => {
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(ids.story);
    db.prepare("UPDATE acceptance_test SET red_at_base_sha = NULL WHERE id = ?").run(ids.acceptance);

    expect(run(["doctor"])).not.toBe(0);

    const rows = passes();
    expect(rows).toHaveLength(1);
    // Two checks broke — the delivered story's open children, and the ready acceptance_test
    // nobody watched fail — across three accused entities. It is checks that are counted.
    expect(rows[0]?.checks_failed).toBe(2);
    expect(rows[0]?.checks_run).toBe(ANSWERABLE);
  });

  it("does not count the tree half, nor the check it had no repository to ask", () => {
    expect(run(["doctor"])).toBe(0);

    // A check that could not be made is neither clean nor broken, so it is not run.
    expect(TREE_INVARIANTS.length).toBeGreaterThan(0);
    expect(passes()[0]?.checks_run).toBe(ANSWERABLE);
    expect(ANSWERABLE).toBeLessThan(checksOf().length + TREE_INVARIANTS.length);
  });

  it("dates the row and measures it", () => {
    const before = new Date().toISOString();
    expect(run(["doctor"])).toBe(0);
    const after = new Date().toISOString();

    const row = passes()[0] as RunRow;
    expect(row.at >= before && row.at <= after).toBe(true);
    expect(Number.isInteger(row.duration_ms)).toBe(true);
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("appends, so the passes before the last one are still there", () => {
    expect(run(["doctor"])).toBe(0);
    expect(run(["doctor"])).toBe(0);
    expect(run(["doctor"])).toBe(0);

    expect(passes()).toHaveLength(3);
  });

  it("leaves the ledger alone", () => {
    const before = ledgerLines();
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(ids.story);

    expect(run(["doctor"])).not.toBe(0);

    expect(ledgerLines()).toBe(before);
    expect(passes()).toHaveLength(1);
  });

  it("records the pass a heal made too, and still writes no ledger line of its own", () => {
    const before = ledgerLines();

    expect(run(["doctor", "--heal"])).toBe(0);

    expect(passes()).toHaveLength(1);
    expect(ledgerLines()).toBe(before);
  });
});

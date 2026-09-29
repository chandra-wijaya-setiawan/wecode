import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { BUCKETS, throughput } from "../src/board.js";
import { freshDb, seed } from "./helpers.js";

/** The pulse line of `packages/tui/config/design.yaml` draws one project's throughput as a
 *  sparkline of ten blocks beside a rate in passes per hour. Ten blocks and a per-hour rate
 *  is a series of ten one-hour buckets, and this is the derivation of it from the ledger.
 *
 *  A pass is the only unit of progress the ledger timestamps: `last_run_at` on a test row
 *  that reached `passed`. Both kinds count — an acceptance test and a task test are both a
 *  thing that was red and is now green — and the walk up places each under its project the
 *  same way every board group is placed.
 *
 *  What it must not do is guess. A run stamped in the future, a timestamp nothing can
 *  parse, and a run older than the window are all no evidence of a pass in any bucket. */

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-20T12:00:00.000Z");

const at = (hoursAgo: number): string => new Date(NOW - hoursAgo * HOUR).toISOString();

/** A second project, with its own release/epic/story/requirement/criteria, under the same
 *  workspace. Slugs are unique per workspace, so every one of them is numbered. */
function secondProject(db: DatabaseSync, ws: number, n: number): { project: number; criteria: number } {
  const T = "2026-09-13T00:00:00.000Z";
  const ins = (sql: string, ...args: (string | number)[]): number => {
    db.prepare(sql).run(...args);
    return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  };
  const project = ins("INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", `p${n}`, ws, `project ${n}`, "/repo", "in_progress", T, T);
  const release = ins("INSERT INTO release (slug,project_id,version,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", `r${n}`, project, "1.0", "in_progress", T, T);
  const epic = ins("INSERT INTO epic (slug,release_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", `e${n}`, release, `epic ${n}`, "in_progress", T, T);
  const story = ins("INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", `s${n}`, epic, `story ${n}`, "in_progress", T, T);
  const requirement = ins("INSERT INTO requirement (slug,story_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", `q${n}`, story, `requirement ${n}`, "in_progress", T, T);
  const criteria = ins("INSERT INTO acceptance_criteria (slug,requirement_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", `c${n}`, requirement, `criteria ${n}`, "in_progress", T, T);
  return { project, criteria };
}

/** An acceptance test under a criteria, in the state and with the run time given. */
function acceptance(db: DatabaseSync, criteria: number, slug: string, state: string, ranAt: string | null): void {
  const T = "2026-09-13T00:00:00.000Z";
  db.prepare(
    "INSERT INTO acceptance_test (slug,parent_id,statement,kind,artefact,state,last_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(slug, criteria, slug, "script", "bash t.sh", state, ranAt, T, T);
}

/** A task test under the seeded task. */
function taskTest(db: DatabaseSync, task: number, slug: string, state: string, ranAt: string | null): void {
  const T = "2026-09-13T00:00:00.000Z";
  db.prepare(
    "INSERT INTO task_test (slug,parent_id,statement,kind,artefact,state,last_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(slug, task, slug, "script", "vitest run", state, ranAt, T, T);
}

describe("a project has a throughput series", () => {
  it("is ten buckets, one per hour, oldest first", () => {
    const db = freshDb();
    const tree = seed(db);

    const series = throughput(db, NOW);

    expect(BUCKETS).toBe(10);
    expect(series.get(tree.project)).toHaveLength(10);
  });

  it("counts a pass into the bucket of the hour it ran in", () => {
    const db = freshDb();
    const tree = seed(db);
    acceptance(db, tree.criteria, "in-this-hour", "passed", at(0.5));
    acceptance(db, tree.criteria, "three-hours-back", "passed", at(3.5));

    const series = throughput(db, NOW);

    // Oldest bucket first, so the newest hour is the last block and three hours back is
    // four from the end.
    expect(series.get(tree.project)).toEqual([0, 0, 0, 0, 0, 0, 1, 0, 0, 1]);
  });

  it("counts an acceptance test and a task test alike", () => {
    const db = freshDb();
    const tree = seed(db);
    acceptance(db, tree.criteria, "green", "passed", at(0.5));
    taskTest(db, tree.task, "unit-green", "passed", at(0.5));

    expect(throughput(db, NOW).get(tree.project)?.[9]).toBe(2);
  });

  it("counts only what passed", () => {
    const db = freshDb();
    const tree = seed(db);
    acceptance(db, tree.criteria, "red", "failed", at(0.5));
    acceptance(db, tree.criteria, "waiting", "ready", at(0.5));
    acceptance(db, tree.criteria, "gone", "dropped", at(0.5));
    taskTest(db, tree.task, "unit-red", "failed", at(0.5));

    expect(throughput(db, NOW).get(tree.project)).toEqual(Array<number>(10).fill(0));
  });

  it("gives every project its own series, and never another project's passes", () => {
    const db = freshDb();
    const tree = seed(db);
    const other = secondProject(db, tree.ws, 2);
    acceptance(db, tree.criteria, "mine", "passed", at(0.5));
    acceptance(db, other.criteria, "theirs", "passed", at(2.5));

    const series = throughput(db, NOW);

    expect(series.get(tree.project)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(series.get(other.project)).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
  });

  it("gives a project nothing has passed under a series of zeroes rather than no series", () => {
    const db = freshDb();
    const tree = seed(db);
    const quiet = secondProject(db, tree.ws, 3);

    const series = throughput(db, NOW);

    expect(series.has(quiet.project)).toBe(true);
    expect(series.get(quiet.project)).toEqual(Array<number>(10).fill(0));
  });

  it("drops a pass older than the window, and one stamped in the future", () => {
    const db = freshDb();
    const tree = seed(db);
    acceptance(db, tree.criteria, "last-week", "passed", at(200));
    acceptance(db, tree.criteria, "just-off-the-end", "passed", at(10.5));
    acceptance(db, tree.criteria, "not-yet", "passed", at(-3));

    expect(throughput(db, NOW).get(tree.project)).toEqual(Array<number>(10).fill(0));
  });

  it("keeps the oldest bucket, one hour wide like the rest", () => {
    const db = freshDb();
    const tree = seed(db);
    acceptance(db, tree.criteria, "edge", "passed", at(9.5));

    expect(throughput(db, NOW).get(tree.project)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("counts nothing for a run it cannot read, and never throws on one", () => {
    const db = freshDb();
    const tree = seed(db);
    acceptance(db, tree.criteria, "never-ran", "passed", null);
    acceptance(db, tree.criteria, "gibberish", "passed", "not a date");

    expect(throughput(db, NOW).get(tree.project)).toEqual(Array<number>(10).fill(0));
  });

  it("reads a bare timestamp as UTC, the way every other date on the board is read", () => {
    const db = freshDb();
    const tree = seed(db);
    acceptance(db, tree.criteria, "bare", "passed", at(0.5).replace("Z", ""));

    expect(throughput(db, NOW).get(tree.project)?.[9]).toBe(1);
  });
});

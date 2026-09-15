import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { board, Engine, Maker, readyCandidates, recordRefusal } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

/** The queue's one promise, said as SQL over the record rather than over the board: a task
 *  in `ready` that nothing open is attempting is work the allocator could dispatch. The
 *  board is complete exactly when it shows all of these and the record is the only judge of
 *  which they are. */
const dispatchable = (db: DatabaseSync): number[] =>
  (
    db
      .prepare(
        `SELECT t.id AS id FROM task t
          WHERE t.state = 'ready'
            AND NOT EXISTS (SELECT 1 FROM assignment a
                             WHERE a.objective_type = 'task' AND a.objective_id = t.id
                               AND a.phase IN ('pending','running','waiting'))
          ORDER BY t.id`,
      )
      .all() as unknown as { id: number }[]
  ).map((r) => r.id);

const setState = (db: DatabaseSync, table: string, id: number, state: string): void => {
  db.prepare(`UPDATE ${table} SET state = ? WHERE id = ?`).run(state, id);
};

/** The board's queue, both as the workspace sees it and as the repository you are standing
 *  in sees it. `wecode board` narrows to one project by default, so a task that only the
 *  unfiltered board can show is still a task missing from the board somebody reads. */
const queued = (db: DatabaseSync, project: number): { all: number[]; mine: number[] } => ({
  all: board(db).queued.map((r) => r.id),
  mine: board(db, project).queued.map((r) => r.id),
});

const T = "2026-09-13T00:00:00.000Z";

const ins = (db: DatabaseSync, sql: string, ...args: (string | number)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

/** A second project in the same workspace, down to one ready task. Two projects is where a
 *  narrowed board can go wrong in both directions: showing another project's work, or
 *  losing its own. */
function secondProject(db: DatabaseSync, ws: number): { project: number; task: number } {
  const project = ins(db, "INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", "billing", ws, "billing", "/billing", "in_progress", T, T);
  const release = ins(db, "INSERT INTO release (slug,project_id,version,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "v1", project, "1.0", "in_progress", T, T);
  const epic = ins(db, "INSERT INTO epic (slug,release_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "invoices", release, "invoices", "in_progress", T, T);
  const story = ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "vat", epic, "vat", "in_progress", T, T);
  const requirement = ins(db, "INSERT INTO requirement (slug,story_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "vat-line", story, "vat is a line", "in_progress", T, T);
  const criteria = ins(db, "INSERT INTO acceptance_criteria (slug,requirement_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "shown", requirement, "vat is shown", "in_progress", T, T);
  const acceptance = ins(db, "INSERT INTO acceptance_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", "vat-shown", criteria, "vat is shown", "script", "bash test/vat.sh", "ready", T, T);
  const task = ins(db, "INSERT INTO task (slug,acceptance_test_id,title,scope,role,budget,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", "total-vat", acceptance, "total the vat", JSON.stringify({ write: ["src/vat/**"], tools: ["bash"] }), "engineer", JSON.stringify({ tokens: 1000, seconds: 60 }), "ready", T, T);
  return { project, task };
}

const openAssignment = (db: DatabaseSync, task: number, phase: "pending" | "running" | "waiting" | "succeeded" | "failed"): number => {
  const make = new Maker(db);
  const worker = make.worker(`claude-${task}-${phase}`, "engineer", "agent");
  const a = make.assignment({
    objective_type: "task",
    objective_id: task,
    worker_id: worker,
    scope: { write: ["src/**"], tools: ["bash"] },
    budget: { tokens: 1, seconds: 1 },
    worktree: "/tmp/wt",
  });
  const engine = new Engine(db);
  if (phase === "pending") return a;
  if (phase === "failed") {
    engine.apply("assignment", a, "fail", "runner");
    return a;
  }
  engine.apply("assignment", a, "start", "runner");
  if (phase === "waiting") engine.apply("assignment", a, "ask", "runner");
  if (phase === "succeeded") engine.apply("assignment", a, "finish", "runner");
  return a;
};

/** A ready task, in a tree that is otherwise untouched. */
const ready = (db: DatabaseSync) => {
  const tree = seed(db);
  new Engine(db).apply("task", tree.task, "start", "chief");
  return tree;
};

const ANCESTORS = [
  ["project", "project"],
  ["release", "release"],
  ["epic", "epic"],
  ["story", "story"],
  ["requirement", "requirement"],
  ["acceptance_criteria", "criteria"],
  ["acceptance_test", "acceptance"],
] as const;

// Every state any of those seven can hold, whatever the machine would let it reach from
// where it is: the board reads the record, and a record can be left in any of them by a
// cascade, a drop, or a hand-edit.
const STATES = ["planned", "in_progress", "ready", "done", "delivered", "failed", "dropped"];

describe("the queue is complete", () => {
  it("shows the ready unassigned task the record says is dispatchable", () => {
    const db = freshDb();
    const tree = ready(db);
    expect(dispatchable(db)).toEqual([tree.task]);
    expect(queued(db, tree.project)).toEqual({ all: [tree.task], mine: [tree.task] });
  });

  for (const [table, key] of ANCESTORS) {
    for (const state of STATES) {
      it(`shows it when its ${table} is ${state}`, () => {
        const db = freshDb();
        const tree = ready(db);
        setState(db, table, tree[key], state);

        expect(dispatchable(db)).toEqual([tree.task]);
        expect(queued(db, tree.project)).toEqual({ all: [tree.task], mine: [tree.task] });
      });
    }
  }

  it("shows it when every one of its parents is dropped at once", () => {
    const db = freshDb();
    const tree = ready(db);
    for (const [table, key] of ANCESTORS) setState(db, table, tree[key], "dropped");

    expect(dispatchable(db)).toEqual([tree.task]);
    expect(queued(db, tree.project)).toEqual({ all: [tree.task], mine: [tree.task] });
  });

  it("shows it when every one of its parents is delivered at once", () => {
    const db = freshDb();
    const tree = ready(db);
    for (const [table, key] of ANCESTORS) setState(db, table, tree[key], "delivered");

    expect(dispatchable(db)).toEqual([tree.task]);
    expect(queued(db, tree.project)).toEqual({ all: [tree.task], mine: [tree.task] });
  });

  // A settled attempt is not an attempt. The only thing that keeps a ready task out of the
  // queue is something open on it right now.
  for (const phase of ["succeeded", "failed"] as const) {
    it(`shows it again once its only assignment has ${phase}`, () => {
      const db = freshDb();
      const tree = ready(db);
      openAssignment(db, tree.task, phase);

      expect(dispatchable(db)).toEqual([tree.task]);
      expect(queued(db, tree.project)).toEqual({ all: [tree.task], mine: [tree.task] });
    });
  }

  for (const phase of ["pending", "running", "waiting"] as const) {
    it(`hides it while an assignment is ${phase}`, () => {
      const db = freshDb();
      const tree = ready(db);
      openAssignment(db, tree.task, phase);

      expect(dispatchable(db)).toEqual([]);
      expect(queued(db, tree.project)).toEqual({ all: [], mine: [] });
    });
  }

  // Stale is an extra thing to say about a queued task, not a box it moves into: a task
  // refused the same way all morning is still work waiting for a slot.
  it("keeps it in the queue after the refusals that make it stale", () => {
    const db = freshDb();
    const tree = ready(db);
    for (let i = 0; i < 4; i++) recordRefusal(db, "no worker free for role engineer", tree.task);

    expect(board(db).stale.map((r) => r.id)).toEqual([tree.task]);
    expect(queued(db, tree.project)).toEqual({ all: [tree.task], mine: [tree.task] });
  });

  it("narrows to the project you are standing in without losing its work", () => {
    const db = freshDb();
    const tree = ready(db);
    const other = secondProject(db, tree.ws);

    expect(dispatchable(db)).toEqual([tree.task, other.task].sort((a, b) => a - b));
    expect(board(db).queued.map((r) => r.id).sort((a, b) => a - b)).toEqual([tree.task, other.task].sort((a, b) => a - b));
    expect(board(db, tree.project).queued.map((r) => r.id)).toEqual([tree.task]);
    expect(board(db, other.project).queued.map((r) => r.id)).toEqual([other.task]);
  });

  // The board and the allocator hold their own copy of "ready and nothing open is
  // attempting it". This is the check between the two copies: what the runner would take
  // next is what the operator is looking at.
  it("shows exactly what the allocator would consider", () => {
    const db = freshDb();
    const tree = ready(db);
    const other = secondProject(db, tree.ws);
    openAssignment(db, other.task, "running");

    expect(board(db).queued.map((r) => r.id)).toEqual(readyCandidates(db).map((c) => c.id));
  });

  // A task nobody can place is the one a narrowed board loses silently: the walk up to a
  // project is five subqueries, and NULL = :project is NULL. It belongs on every board
  // rather than on none, because the allocator never walks up and will dispatch it.
  it("keeps a task whose walk up to a project is broken on the narrowed board", () => {
    const db = freshDb();
    const tree = ready(db);
    // Only a hand-edit or a half-restored backup gets here; the FKs forbid it in flight.
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("UPDATE task SET acceptance_test_id = 9999 WHERE id = ?").run(tree.task);
    db.exec("PRAGMA foreign_keys = ON");

    expect(readyCandidates(db).map((c) => c.id)).toEqual([tree.task]);
    expect(queued(db, tree.project)).toEqual({ all: [tree.task], mine: [tree.task] });
  });

  // The queue's row has to be readable, not merely present: a NULL detail is a row the
  // cockpit cannot draw, which is the same absence by another route.
  it("gives every queued row a state and a detail", () => {
    const db = freshDb();
    const tree = ready(db);
    for (const row of board(db, tree.project).queued) {
      expect(row.what).toBeTypeOf("string");
      expect(row.state).toBe("ready");
      expect(row.detail).toBeTypeOf("string");
    }
  });
});

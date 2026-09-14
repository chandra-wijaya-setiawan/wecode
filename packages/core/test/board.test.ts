import { describe, expect, it } from "vitest";
import { board, Engine, Maker, openAssignments, recordRefusal } from "../src/index.js";
import { freshDb, recordRed, seed } from "./helpers.js";

describe("the board", () => {
  it("shows a ready task in the queue until something is attempting it", () => {
    const db = freshDb();
    const tree = seed(db);
    new Engine(db).apply("task", tree.task, "start", "chief");

    expect(board(db).queued.map((r) => r.id)).toEqual([tree.task]);

    const worker = new Maker(db).worker("claude-1", "engineer", "agent");
    new Maker(db).assignment({
      objective_type: "task",
      objective_id: tree.task,
      worker_id: worker,
      scope: { write: ["src/**"], tools: ["bash"] },
      budget: { tokens: 1, seconds: 1 },
      worktree: "/tmp/wt",
    });

    expect(board(db).queued).toEqual([]);
  });

  it("counts a waiting assignment against the budget", () => {
    const db = freshDb();
    const tree = seed(db);
    const make = new Maker(db);
    const worker = make.worker("claude-1", "engineer", "agent");
    const a = make.assignment({
      objective_type: "task",
      objective_id: tree.task,
      worker_id: worker,
      scope: { write: [], tools: [] },
      budget: { tokens: 1, seconds: 1 },
      worktree: "/tmp/wt",
    });
    const engine = new Engine(db);
    engine.apply("assignment", a, "start", "runner");
    engine.apply("assignment", a, "ask", "runner");

    expect(openAssignments(db)).toBe(1);
    expect(board(db).needs_human.map((r) => r.id)).toEqual([a]);
  });

  it("frees the slot when the attempt ends", () => {
    const db = freshDb();
    const tree = seed(db);
    const make = new Maker(db);
    const worker = make.worker("claude-1", "engineer", "agent");
    const a = make.assignment({
      objective_type: "task",
      objective_id: tree.task,
      worker_id: worker,
      scope: { write: [], tools: [] },
      budget: { tokens: 1, seconds: 1 },
      worktree: "/tmp/wt",
    });
    const engine = new Engine(db);
    engine.apply("assignment", a, "start", "runner");
    engine.apply("assignment", a, "fail", "runner");
    expect(openAssignments(db)).toBe(0);
  });
});

describe("the unproven box", () => {
  it("lists a ready acceptance_test nobody has watched fail, and drops it once somebody has", () => {
    const db = freshDb();
    const tree = seed(db);

    // Rows here are acceptance_tests — which is the entity the cockpit has to descend into
    // when a line in this box is opened.
    const before = board(db).unproven;
    expect(before.map((r) => r.id)).toEqual([tree.acceptance]);
    expect(before[0]?.detail).toBe("no red run recorded");

    recordRed(db, tree.acceptance);
    expect(board(db).unproven).toEqual([]);
  });
});

describe("staleness comes from what the allocator recorded", () => {
  it("shows a task only once the same reason has survived a few passes", () => {
    const db = freshDb();
    const tree = seed(db);
    new Engine(db).apply("task", tree.task, "start", "chief");

    recordRefusal(db, "its write scope overlaps an assignment already open", tree.task);
    recordRefusal(db, "its write scope overlaps an assignment already open", tree.task);
    expect(board(db).stale).toEqual([]);

    recordRefusal(db, "its write scope overlaps an assignment already open", tree.task);
    const stale = board(db).stale;
    expect(stale).toHaveLength(1);
    expect(stale[0]?.detail).toContain("overlaps");
    expect(stale[0]?.detail).toContain("3 passes");
  });

  it("starts the clock again when the reason changes", () => {
    const db = freshDb();
    const tree = seed(db);
    new Engine(db).apply("task", tree.task, "start", "chief");

    for (let i = 0; i < 3; i++) recordRefusal(db, "no worker free for role engineer", tree.task);
    recordRefusal(db, "waiting for a slot", tree.task);

    expect(board(db).stale).toEqual([]);
    const row = db.prepare("SELECT passes FROM refusal WHERE task_id = ?").get(tree.task) as { passes: number };
    expect(row.passes).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { board, Engine, Maker, openAssignments } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

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

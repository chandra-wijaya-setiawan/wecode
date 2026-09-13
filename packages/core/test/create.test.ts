import { describe, expect, it } from "vitest";
import { Engine, Maker } from "../src/index.js";
import { freshDb, stateOf } from "./helpers.js";

describe("rows start where their machine says", () => {
  it("builds a tree, each node in its initial state", () => {
    const db = freshDb();
    const make = new Maker(db);
    const ws = make.workspace("acme", "/acme");
    const project = make.project(ws, "storefront", "/repo");
    const release = make.release(project, "1.0");
    const epic = make.epic(release, "account recovery");
    const story = make.story(epic, "password reset");

    expect(stateOf(db, "project", project)).toBe("planned");
    expect(stateOf(db, "release", release)).toBe("planned");
    expect(stateOf(db, "epic", epic)).toBe("planned");
    expect(stateOf(db, "story", story)).toBe("planned");
  });

  it("an assignment starts pending, with nothing spent", () => {
    const db = freshDb();
    const make = new Maker(db);
    const worker = make.worker("claude-1", "engineer", "agent");
    const id = make.assignment({
      objective_type: "task",
      objective_id: 1,
      worker_id: worker,
      scope: { write: ["src/**"], tools: ["bash"] },
      budget: { tokens: 100, seconds: 10 },
      worktree: "/tmp/wt",
    });
    const row = db.prepare("SELECT phase, spent FROM assignment WHERE id = ?").get(id) as {
      phase: string;
      spent: string;
    };
    expect(row.phase).toBe("pending");
    expect(JSON.parse(row.spent)).toEqual({ tokens: 0, seconds: 0 });
    expect(new Engine(db).may("assignment", id, "start").ok).toBe(true);
  });

  it("a task with no scope cannot start, and says which command fixes it", () => {
    const db = freshDb();
    const make = new Maker(db);
    const ws = make.workspace("acme", "/acme");
    const p = make.project(ws, "s", "/r");
    const rel = make.release(p, "1.0");
    const e = make.epic(rel, "e");
    const s = make.story(e, "s");
    const req = make.requirement(s, "r");
    const c = make.criteria(req, "c");
    const at = make.acceptanceTest(c, "a", "script", "bash x.sh");
    const t = make.task(at, "do the thing");
    const r = new Engine(db).apply("task", t, "start", "chief");
    expect(!r.ok && r.why).toContain("wecode task scope");
  });
});

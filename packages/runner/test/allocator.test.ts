import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open, openAssignments, type Scope } from "@wecode/core";
import { allocate, collides, DEFAULT_BUDGET } from "../src/index.js";

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let worker: number;
let criteria: number;

const place = () => ({ worker_id: worker, worktree: "/tmp/wt" });

/** A ready task, with its own acceptance_test so two tasks never share one. */
function readyTask(title: string, scope: Scope): number {
  const at = make.acceptanceTest(criteria, `${title} proof`, "script", "bash x.sh");
  const t = make.task(at, title, { scope, role: "engineer" });
  make.taskTest(t, `${title} unit`, "script", "vitest run");
  const tests = db.prepare("SELECT id FROM task_test WHERE parent_id = ?").all(t) as unknown as { id: number }[];
  for (const tt of tests) engine.apply("task_test", tt.id, "deliver", "chief");
  engine.apply("task", t, "start", "chief");
  return t;
}

beforeEach(() => {
  db = open(join(mkdtempSync(join(tmpdir(), "wecode-alloc-")), "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);
  const ws = make.workspace("acme", "/acme");
  const p = make.project(ws, "s", "/r");
  const rel = make.release(p, "1.0.0");
  const e = make.epic(rel, "e");
  const s = make.story(e, "s");
  const req = make.requirement(s, "r");
  criteria = make.criteria(req, "c");
  worker = make.worker("claude-1", "engineer", "agent");
});

describe("collision", () => {
  it("sees an overlap when either reaches into the other", () => {
    expect(collides(["src/**"], ["src/mail/**"])).toBe(true);
    expect(collides(["src/mail/**"], ["src/ui/**"])).toBe(false);
  });
});

describe("a pass", () => {
  it("creates one assignment, not one per slot", () => {
    readyTask("a", { write: ["src/a/**"], tools: ["bash"] });
    readyTask("b", { write: ["src/b/**"], tools: ["bash"] });
    const r = allocate(db, DEFAULT_BUDGET, place);
    expect(r.created).not.toBeNull();
    expect(openAssignments(db)).toBe(1);
  });

  it("stops at the ceiling and says how full it is", () => {
    readyTask("a", { write: ["src/a/**"], tools: [] });
    readyTask("b", { write: ["src/b/**"], tools: [] });
    readyTask("c", { write: ["src/c/**"], tools: [] });
    readyTask("d", { write: ["src/d/**"], tools: [] });
    for (let i = 0; i < 3; i++) allocate(db, DEFAULT_BUDGET, place);
    const r = allocate(db, DEFAULT_BUDGET, place);
    expect(r.created).toBeNull();
    expect(r.refused[0]?.why).toContain("3 of 3");
  });

  it("refuses a task whose scope overlaps one already open, and records why", () => {
    readyTask("a", { write: ["src/mail/**"], tools: [] });
    readyTask("b", { write: ["src/**"], tools: [] });
    allocate(db, DEFAULT_BUDGET, place);
    const r = allocate(db, DEFAULT_BUDGET, place);
    expect(r.created).toBeNull();
    expect(r.refused.map((x) => x.why).join()).toContain("overlaps");
  });

  it("puts a first attempt ahead of a retry", () => {
    const retried = readyTask("retried", { write: ["src/a/**"], tools: [] });
    db.prepare("UPDATE task SET attempts = 2 WHERE id = ?").run(retried);
    const fresh = readyTask("fresh", { write: ["src/b/**"], tools: [] });

    const r = allocate(db, DEFAULT_BUDGET, place);
    const row = db.prepare("SELECT objective_id FROM assignment WHERE id = ?").get(r.created) as {
      objective_id: number;
    };
    expect(row.objective_id).toBe(fresh);
  });

  it("honours a per-role ceiling", () => {
    readyTask("a", { write: ["src/a/**"], tools: [] });
    readyTask("b", { write: ["src/b/**"], tools: [] });
    const config = { ...DEFAULT_BUDGET, max_open_per_role: { engineer: 1 } };
    allocate(db, config, place);
    const r = allocate(db, config, place);
    expect(r.created).toBeNull();
    expect(r.refused.map((x) => x.why).join()).toContain("engineer is at 1");
  });

  it("records that no worker was free rather than silently doing nothing", () => {
    readyTask("a", { write: ["src/a/**"], tools: [] });
    const r = allocate(db, DEFAULT_BUDGET, () => null);
    expect(r.created).toBeNull();
    expect(r.refused[0]?.why).toContain("no worker free");
  });
});

import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open, openAssignments, type Scope } from "@wecode/core";
import { allocate, collides, DEFAULT_BUDGET, type Candidate } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let worker: number;
let criteria: number;

const place = async () => ({ worker_id: worker, worktree: "/tmp/wt" });

/** A `place` that records who it was asked about, so a test can prove the allocator only
 *  ever asks about the candidate it chose. */
function asking(
  answer: (c: Candidate) => { worker_id: number; worktree: string } | { why: string } = () => ({
    worker_id: worker,
    worktree: "/tmp/wt",
  }),
) {
  const asked: number[] = [];
  return { asked, place: async (c: Candidate) => (asked.push(c.id), answer(c)) };
}

/** A ready task, with its own acceptance_test so two tasks never share one. */
function readyTask(title: string, scope: Scope): number {
  const at = make.acceptanceTest(criteria, `${title} proof`, "script", "bash x.sh");
  const t = make.task(at, title, { scope, role: "engineer" });
  make.taskTest(t, `${title} unit`, "script", "vitest run");
  const tests = db.prepare("SELECT id FROM task_test WHERE parent_id = ?").all(t) as unknown as { id: number }[];
  for (const tt of tests) engine.apply("task_test", tt.id, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", t, "start", "chief");
  return t;
}

beforeEach(() => {
  db = open(join(tmp("wecode-alloc-"), "wecode.db"));
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
  it("creates one assignment, not one per slot", async () => {
    readyTask("a", { write: ["src/a/**"], tools: ["bash"] });
    readyTask("b", { write: ["src/b/**"], tools: ["bash"] });
    const r = await allocate(db, DEFAULT_BUDGET, place);
    expect(r.created).not.toBeNull();
    expect(openAssignments(db)).toBe(1);
  });

  it("stops at the ceiling and says how full it is", async () => {
    readyTask("a", { write: ["src/a/**"], tools: [] });
    readyTask("b", { write: ["src/b/**"], tools: [] });
    readyTask("c", { write: ["src/c/**"], tools: [] });
    readyTask("d", { write: ["src/d/**"], tools: [] });
    for (let i = 0; i < 3; i++) await allocate(db, DEFAULT_BUDGET, place);
    const r = await allocate(db, DEFAULT_BUDGET, place);
    expect(r.created).toBeNull();
    expect(r.refused[0]?.why).toContain("3 of 3");
  });

  it("refuses a task whose scope overlaps one already open, and records why", async () => {
    readyTask("a", { write: ["src/mail/**"], tools: [] });
    readyTask("b", { write: ["src/**"], tools: [] });
    await allocate(db, DEFAULT_BUDGET, place);
    const r = await allocate(db, DEFAULT_BUDGET, place);
    expect(r.created).toBeNull();
    expect(r.refused.map((x) => x.why).join()).toContain("overlaps");
  });

  it("puts a first attempt ahead of a retry", async () => {
    const retried = readyTask("retried", { write: ["src/a/**"], tools: [] });
    db.prepare("UPDATE task SET attempts = 2 WHERE id = ?").run(retried);
    const fresh = readyTask("fresh", { write: ["src/b/**"], tools: [] });

    const r = await allocate(db, DEFAULT_BUDGET, place);
    const row = db.prepare("SELECT objective_id FROM assignment WHERE id = ?").get(r.created) as {
      objective_id: number;
    };
    expect(row.objective_id).toBe(fresh);
  });

  it("honours a per-role ceiling", async () => {
    readyTask("a", { write: ["src/a/**"], tools: [] });
    readyTask("b", { write: ["src/b/**"], tools: [] });
    const config = { ...DEFAULT_BUDGET, max_open_per_role: { engineer: 1 } };
    await allocate(db, config, place);
    const r = await allocate(db, config, place);
    expect(r.created).toBeNull();
    expect(r.refused.map((x) => x.why).join()).toContain("engineer is at 1");
  });

  it("records that no worker was free rather than silently doing nothing", async () => {
    const a = readyTask("a", { write: ["src/a/**"], tools: [] });
    const r = await allocate(db, DEFAULT_BUDGET, async () => ({ why: "no worker free for role engineer" }));
    expect(r.created).toBeNull();
    expect(r.refused[0]).toEqual({ id: a, why: "no worker free for role engineer" });
  });
});

describe("one thing chooses", () => {
  it("asks for a placement only for the candidate it chose", async () => {
    const retried = readyTask("retried", { write: ["src/a/**"], tools: [] });
    db.prepare("UPDATE task SET attempts = 1 WHERE id = ?").run(retried);
    const fresh = readyTask("fresh", { write: ["src/b/**"], tools: [] });

    const { asked, place: p } = asking();
    const r = await allocate(db, DEFAULT_BUDGET, p);

    // The live deadlock: the lowest id was prepared, fresh_first chose the other.
    expect(asked).toEqual([fresh]);
    expect(retried).toBeLessThan(fresh);
    const row = db.prepare("SELECT objective_id FROM assignment WHERE id = ?").get(r.created) as {
      objective_id: number;
    };
    expect(row.objective_id).toBe(fresh);
  });

  it("never asks about a candidate its own filters ruled out", async () => {
    readyTask("open", { write: ["src/**"], tools: [] });
    await allocate(db, DEFAULT_BUDGET, place);
    const blocked = readyTask("blocked", { write: ["src/mail/**"], tools: [] });

    const { asked, place: p } = asking();
    const r = await allocate(db, DEFAULT_BUDGET, p);
    expect(asked).toEqual([]);
    expect(r.refused.find((x) => x.id === blocked)?.why).toContain("overlaps");
  });

  it("blames the candidate it could not place, never a different one", async () => {
    const retried = readyTask("retried", { write: ["src/a/**"], tools: [] });
    db.prepare("UPDATE task SET attempts = 1 WHERE id = ?").run(retried);
    const fresh = readyTask("fresh", { write: ["src/b/**"], tools: [] });

    const r = await allocate(db, DEFAULT_BUDGET, async (c) =>
      c.id === fresh ? { why: "no worker free for role engineer" } : { worker_id: worker, worktree: "/tmp/wt" },
    );

    // the reason is recorded against fresh, the task that actually could not be placed
    expect(r.refused).toContainEqual({ id: fresh, why: "no worker free for role engineer" });
    expect(r.refused.some((x) => x.id === retried)).toBe(false);
    // and the pass does not stall behind it: the next in order still runs
    const row = db.prepare("SELECT objective_id FROM assignment WHERE id = ?").get(r.created) as {
      objective_id: number;
    };
    expect(row.objective_id).toBe(retried);
  });
});

import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open, openAssignments, type Scope } from "@wecode/core";
import { DEFAULT_BUDGET, fill, type Candidate } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let workers: number[];
let criteria: number;

/** Enough headroom that the seats, not the ceiling, are what a tick runs out of. */
const roomy = { ...DEFAULT_BUDGET, max_open: 10 };

/** A `place` with a fixed number of seats: once they are all taken it says so, the way the
 *  daemon's own `freeWorker` does. */
function seats(n: number) {
  const taken: number[] = [];
  return async (c: Candidate) => {
    const worker = workers[taken.length];
    if (worker === undefined) return { why: `no worker free for role ${c.role}` };
    taken.push(c.id);
    return { worker_id: worker, worktree: `/tmp/wt-${c.id}` };
  };
}

/** A ready task, with its own acceptance_test so two tasks never share one. */
function readyTask(title: string, write: readonly string[]): number {
  const scope: Scope = { write: [...write], tools: [] };
  const at = make.acceptanceTest(criteria, `${title} proof`, "script", "bash x.sh");
  const t = make.task(at, title, { scope, role: "engineer" });
  make.taskTest(t, `${title} unit`, "script", "vitest run");
  const tests = db.prepare("SELECT id FROM task_test WHERE parent_id = ?").all(t) as unknown as {
    id: number;
  }[];
  for (const tt of tests) engine.apply("task_test", tt.id, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", t, "start", "chief");
  return t;
}

beforeEach(() => {
  db = open(join(tmp("wecode-fill-"), "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);
  const ws = make.workspace("acme", "/acme");
  const p = make.project(ws, "s", "/r");
  const e = make.epic(make.release(p, "1.0.0"), "e");
  criteria = make.criteria(make.requirement(make.story(e, "s"), "r"), "c");
  workers = ["claude-1", "claude-2", "claude-3"].map((n) => make.worker(n, "engineer", "agent"));
});

describe("a tick fills the seats", () => {
  it("starts one assignment per free seat, not one per tick", async () => {
    for (const n of ["a", "b", "c", "d", "e"]) readyTask(n, [`src/${n}/**`]);

    const r = await fill(db, roomy, seats(3));

    expect(r.created).toHaveLength(3);
    expect(openAssignments(db)).toBe(3);
    expect(new Set(r.created).size).toBe(3);
  });

  it("says the seats ran out, and leaves the queue ready", async () => {
    for (const n of ["a", "b", "c", "d", "e"]) readyTask(n, [`src/${n}/**`]);

    const r = await fill(db, roomy, seats(3));

    expect(r.refused.map((x) => x.why).join()).toContain("no worker free");
    expect(r.refused).toHaveLength(2);
  });

  it("stops at the open limit even when seats are still free", async () => {
    for (const n of ["a", "b", "c"]) readyTask(n, [`src/${n}/**`]);

    const r = await fill(db, DEFAULT_BUDGET, seats(3));

    expect(r.created).toHaveLength(DEFAULT_BUDGET.max_open);
    expect(r.refused[0]?.why).toContain(`${DEFAULT_BUDGET.max_open} of ${DEFAULT_BUDGET.max_open}`);
  });

  it("stops when the queue runs out, with seats to spare", async () => {
    readyTask("a", ["src/a/**"]);

    const r = await fill(db, roomy, seats(3));

    expect(r.created).toHaveLength(1);
    expect(r.refused).toEqual([]);
  });

  it("checks each allocation against the ones the same tick just made", async () => {
    readyTask("mail", ["src/mail/**"]);
    readyTask("all", ["src/**"]);

    const r = await fill(db, roomy, seats(3));

    expect(r.created).toHaveLength(1);
    expect(r.refused.map((x) => x.why).join()).toContain("overlaps");
  });

  it("starts nothing when there is nothing ready", async () => {
    const r = await fill(db, roomy, seats(3));

    expect(r.created).toEqual([]);
    expect(openAssignments(db)).toBe(0);
  });
});
